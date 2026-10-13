// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Domain Admin HTTP routes + invite accept / password login.
 */

import type { Context, Hono } from "hono";
import { z } from "zod";
import { sendEmail } from "../email-sender";
import {
	appendAdminAudit,
	canCreateMailbox,
	isDomainAdmin,
	parseMailboxCreatePolicy,
	principalIsDomainAdmin,
	requireDomainAdmin,
	resolveAdminAllowlist,
} from "../lib/domain-admin";
import {
	getDomainMetadata,
	isPrincipalAdminForDomain,
	listDomainsForPrincipal,
} from "../lib/domain-registry";
import {
	createInviteRecord,
	inviteAcceptUrl,
	inviteIsActive,
	listInviteTokensForMailbox,
	loadInvite,
	publicInvitePayload,
	saveInvite,
} from "../lib/invites";
import {
	canManageAcl,
	aclFromOwnerKeys,
	loadMailboxSettingsRaw,
	mailboxAccessPayload,
	parseAcl,
	principalKeys,
	validateAclWrite,
	type RequestPrincipal,
} from "../lib/mailbox-acl";
import {
	attachIdpToSessionAccount,
	attachPasswordToSessionAccount,
	ensurePrincipalAccount,
	IdentityAlreadyLinkedError,
	IdentityNotOwnedError,
	listAllIdentityAccounts,
	listIdentitiesForPrincipal,
	mintIdentityLinkCode,
	passwordUserForSessionAccount,
	redeemIdentityLinkCode,
	resolveAclPrincipalsToAccounts,
	updatePasswordHashForSessionAccount,
} from "../lib/identity-links";
import { verifyAppleIdentityToken } from "../lib/apple-auth";
import { verifyGoogleIdentityToken } from "../lib/google-auth";
import type { MailboxContext } from "../lib/mailbox";
import {
	allowedMailboxSet,
	canonicalMailboxId,
	mailboxMetadataKey,
} from "../lib/mailbox-routing";
import { resolveMailDomain } from "../lib/mail-domain";
import { listMailboxes, getMailboxStub } from "../lib/email-helpers";
import {
	clearPasswordSessionCookieHeader,
	hashPassword,
	issuePasswordSessionToken,
	passwordSessionCookieHeader,
	validatePasswordStrength,
	verifyPassword,
} from "../lib/password-auth";
import {
	findUserIdByLoginEmail,
	loadPlatformUser,
	principalFromPlatformUser,
	savePlatformUser,
	type PlatformUser,
} from "../lib/platform-users";
import {
	createPasswordReset,
	verifyPasswordReset,
	consumePasswordReset,
	type PasswordResetRecord,
} from "../lib/password-reset";
import { agentInstanceName } from "../../shared/agent-conversations";
import { seedWelcomeEmailsForMailbox } from "../lib/welcome-emails";
import { isDevRuntime } from "../lib/dev-runtime";
import type { Env } from "../types";

type App = Hono<MailboxContext>;
type C = Context<MailboxContext>;

const CreateAdminMailboxBody = z.object({
	email: z.string().email(),
	name: z.string().min(1).max(200).optional(),
	assignTo: z
		.union([
			z.literal("self"),
			z.object({
				inviteEmail: z.string().email(),
				inviteeName: z.string().max(200).optional(),
				role: z.enum(["owner", "member"]).optional(),
			}),
		])
		.optional()
		.default("self"),
});

const AssignBody = z.object({
	assignTo: z.union([
		z.literal("self"),
		z.object({
			inviteEmail: z.string().email(),
			inviteeName: z.string().max(200).optional(),
			role: z.enum(["owner", "member"]).optional(),
		}),
	]),
});

const InviteBody = z.object({
	mailboxId: z.string().email(),
	inviteEmail: z.string().email(),
	inviteeName: z.string().max(200).optional(),
	role: z.enum(["owner", "member"]).optional(),
});

const AcceptInviteBody = z.object({
	password: z.string().min(10).max(200),
	displayName: z.string().max(200).optional(),
});

const PasswordLoginBody = z.object({
	email: z.string().email(),
	password: z.string().min(1).max(200),
});

const ForgotPasswordBody = z.object({
	email: z.string().email(),
});

const ResetPasswordBody = z.object({
	token: z.string().optional(),
	/** Account email used for `/password/forgot`; required with `code`. */
	email: z.string().max(320).optional(),
	code: z.string().optional(),
	newPassword: z.string().min(1).max(200),
});

const TransferAclBody = z.object({
	owners: z.array(z.string()).min(1),
	members: z.array(z.string()).optional(),
});

function defaultSettings(name: string) {
	return {
		fromName: name,
		forwarding: { enabled: false, email: "" },
		signature: { enabled: false, text: "" },
		autoReply: { enabled: false, subject: "", message: "" },
		screener: { enabled: true },
	};
}

function appBaseUrl(c: C): string {
	if (c.env.APP_BASE_URL?.trim()) return c.env.APP_BASE_URL.trim().replace(/\/$/, "");
	return new URL(c.req.url).origin;
}

function inviteFromAddress(c: C): string {
	if (c.env.INVITE_FROM_EMAIL?.trim()) return c.env.INVITE_FROM_EMAIL.trim();
	return `noreply@${resolveMailDomain(c.env)}`;
}

/**
 * Per-IP throttle on 6-digit reset code guesses (Workers Rate Limiting).
 * Fails open when the binding is absent or errors: the per-code attempt cap
 * in `verifyPasswordReset` still applies.
 */
async function passwordResetCodeRateLimited(c: C): Promise<boolean> {
	const limiter = c.env.PASSWORD_RESET_LIMITER;
	if (!limiter) return false;
	const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
	try {
		const { success } = await limiter.limit({ key: `password-reset-code:${ip}` });
		return !success;
	} catch (e) {
		console.error("[PasswordReset] Rate limiter failed:", (e as Error).message || e);
		return false;
	}
}

async function trySendInviteEmail(
	c: C,
	invite: {
		token: string;
		mailboxId: string;
		inviteeEmail: string;
		inviteeName?: string;
	},
): Promise<{ sent: boolean; inviteUrl: string; error?: string }> {
	const inviteUrl = inviteAcceptUrl(appBaseUrl(c), invite.token);
	const from = inviteFromAddress(c);
	const name = invite.inviteeName ? ` ${invite.inviteeName}` : "";
	const text = `You've been invited to ${invite.mailboxId} on Inboxies.\n\nOpen this link to set your password and get started:\n${inviteUrl}\n`;
	const html = `<p>Hi${name},</p><p>You've been invited to <strong>${invite.mailboxId}</strong> on Inboxies.</p><p><a href="${inviteUrl}">Accept invite and set your password</a></p><p>Or copy this link:<br/>${inviteUrl}</p>`;
	try {
		if (!c.env.EMAIL) {
			return { sent: false, inviteUrl, error: "EMAIL binding unavailable" };
		}
		await sendEmail(c.env.EMAIL, {
			to: invite.inviteeEmail,
			from: { email: from, name: "Inboxies" },
			subject: `You're invited to ${invite.mailboxId}`,
			text,
			html,
		});
		return { sent: true, inviteUrl };
	} catch (e) {
		return {
			sent: false,
			inviteUrl,
			error: (e as Error).message || "Failed to send invite email",
		};
	}
}

async function createPendingInvite(
	c: C,
	principal: RequestPrincipal,
	opts: {
		mailboxId: string;
		inviteEmail: string;
		inviteeName?: string;
		role?: "owner" | "member";
	},
) {
	const record = createInviteRecord({
		mailboxId: opts.mailboxId,
		inviteeEmail: opts.inviteEmail,
		inviteeName: opts.inviteeName,
		role: opts.role ?? "owner",
		createdByKeys: principalKeys(principal),
	});
	if ("error" in record) return { ok: false as const, error: record.error };
	await saveInvite(c.env.BUCKET, record);
	const delivery = await trySendInviteEmail(c, record);
	await appendAdminAudit(c.env.BUCKET, {
		actorKeys: principalKeys(principal),
		action: "invite.create",
		mailboxId: record.mailboxId,
		detail: {
			inviteeEmail: record.inviteeEmail,
			role: record.role,
			sent: delivery.sent,
		},
	});
	return {
		ok: true as const,
		invite: record,
		inviteUrl: delivery.inviteUrl,
		emailSent: delivery.sent,
		emailError: delivery.error,
	};
}

function adminMailboxRow(
	mailboxId: string,
	settings: Record<string, unknown>,
) {
	const acl = parseAcl(settings);
	return {
		id: mailboxId,
		email: mailboxId,
		name:
			typeof settings.fromName === "string" && settings.fromName
				? settings.fromName
				: mailboxId,
		acl,
		claimed: acl.owners.length > 0,
		fromName:
			typeof settings.fromName === "string" ? settings.fromName : null,
	};
}

async function canAdministerMailboxDomain(
	env: Env,
	principal: RequestPrincipal | null | undefined,
	domainOrMailboxId: string,
): Promise<boolean> {
	if (!principal) return false;
	if (await requireDomainAdmin(env, principal)) return true;
	const domain = domainOrMailboxId.includes("@")
		? domainOrMailboxId.split("@")[1]?.toLowerCase()
		: domainOrMailboxId.toLowerCase();
	if (!domain) return false;
	const meta = await getDomainMetadata(env.BUCKET, domain);
	if (!meta) return false;
	return isPrincipalAdminForDomain(meta, principal, false);
}

export function registerAdminAndInviteRoutes(app: App) {
	// ── Admin mailboxes ───────────────────────────────────────────

	app.get("/api/v1/admin/mailboxes", async (c) => {
		const principal = c.get("principal");
		if (!principal) return c.json({ error: "Forbidden" }, 403);
		const isSuper = await requireDomainAdmin(c.env, principal);
		const administeredDomains = await listDomainsForPrincipal(
			c.env.BUCKET,
			principal,
			isSuper,
		);
		if (!isSuper && administeredDomains.length === 0) {
			return c.json({ error: "Forbidden" }, 403);
		}
		const all = await listMailboxes(c.env.BUCKET);
		const allowedDomainSet = isSuper
			? null
			: new Set(administeredDomains.map((d) => d.domain.toLowerCase()));

		const filtered = allowedDomainSet
			? all.filter((m) => {
					const parts = m.id.split("@");
					const dom = parts[1]?.toLowerCase();
					return dom && allowedDomainSet.has(dom);
				})
			: all;

		const rows = await Promise.all(
			filtered.map(async (m) => {
				const settings =
					(await loadMailboxSettingsRaw(c.env.BUCKET, m.id)) ?? {};
				return adminMailboxRow(m.id, settings);
			}),
		);
		rows.sort((a, b) => a.id.localeCompare(b.id));
		return c.json(rows);
	});

	app.post("/api/v1/admin/mailboxes", async (c) => {
		const principal = c.get("principal");
		if (!principal) {
			return c.json({ error: "Forbidden" }, 403);
		}
		const body = CreateAdminMailboxBody.parse(await c.req.json());
		const email = canonicalMailboxId(body.email);
		if (!email) return c.json({ error: "Invalid mailbox email address" }, 400);

		const isAuthorized = await canAdministerMailboxDomain(c.env, principal, email);
		if (!isAuthorized) {
			return c.json({ error: "Forbidden" }, 403);
		}

		const domain = email.split("@")[1]?.toLowerCase();
		const meta = domain ? await getDomainMetadata(c.env.BUCKET, domain) : null;
		if (!meta) {
			const allowed = allowedMailboxSet((c.env.EMAIL_ADDRESSES ?? []) as string[]);
			if (allowed.size > 0 && !allowed.has(email)) {
				return c.json(
					{ error: "Mailbox creation is restricted to configured EMAIL_ADDRESSES" },
					403,
				);
			}
		}
		const key = mailboxMetadataKey(email);
		if (await c.env.BUCKET.head(key)) {
			return c.json({ error: "Mailbox already exists" }, 409);
		}
		const name = body.name || email.split("@")[0] || email;
		const assignTo = body.assignTo ?? "self";
		const ensured = await ensurePrincipalAccount(c.env.BUCKET, principal);
		const acl = aclFromOwnerKeys(ensured.ownerKeys);
		const settings = { ...defaultSettings(name), acl };
		await c.env.BUCKET.put(key, JSON.stringify(settings));
		const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(email));
		await stub.reviveMailbox();
		await stub.getFolders();
		await seedWelcomeEmailsForMailbox(c.env, email, name);

		let inviteResult: Awaited<ReturnType<typeof createPendingInvite>> | null =
			null;
		if (assignTo !== "self") {
			inviteResult = await createPendingInvite(c, principal, {
				mailboxId: email,
				inviteEmail: assignTo.inviteEmail,
				inviteeName: assignTo.inviteeName,
				role: assignTo.role ?? "owner",
			});
			if (!inviteResult.ok) {
				return c.json({ error: inviteResult.error }, 400);
			}
		}

		await appendAdminAudit(c.env.BUCKET, {
			actorKeys: principalKeys(principal),
			action: "mailbox.create",
			mailboxId: email,
			detail: { assignTo: assignTo === "self" ? "self" : "invite" },
		});

		return c.json(
			{
				...mailboxAccessPayload(email, settings, ensured.principal),
				name,
				invite:
					inviteResult && inviteResult.ok
						? {
								token: inviteResult.invite.token,
								inviteUrl: inviteResult.inviteUrl,
								emailSent: inviteResult.emailSent,
								emailError: inviteResult.emailError ?? null,
								inviteeEmail: inviteResult.invite.inviteeEmail,
								role: inviteResult.invite.role,
							}
						: null,
			},
			201,
		);
	});

	app.post("/api/v1/admin/mailboxes/:mailboxId/assign", async (c) => {
		const principal = c.get("principal");
		const mailboxId = canonicalMailboxId(c.req.param("mailboxId"));
		if (!mailboxId) return c.json({ error: "Invalid mailbox email address" }, 400);
		if (!principal || !(await canAdministerMailboxDomain(c.env, principal, mailboxId))) {
			return c.json({ error: "Forbidden" }, 403);
		}
		const settings = await loadMailboxSettingsRaw(c.env.BUCKET, mailboxId);
		if (settings === null) return c.json({ error: "Not found" }, 404);
		const body = AssignBody.parse(await c.req.json());

		if (body.assignTo === "self") {
			const ensured = await ensurePrincipalAccount(c.env.BUCKET, principal);
			const acl = aclFromOwnerKeys(ensured.ownerKeys);
			const next = { ...settings, acl };
			await c.env.BUCKET.put(mailboxMetadataKey(mailboxId), JSON.stringify(next));
			await appendAdminAudit(c.env.BUCKET, {
				actorKeys: principalKeys(principal),
				action: "mailbox.assign_self",
				mailboxId,
			});
			return c.json(mailboxAccessPayload(mailboxId, next, ensured.principal));
		}

		const inviteResult = await createPendingInvite(c, principal, {
			mailboxId,
			inviteEmail: body.assignTo.inviteEmail,
			inviteeName: body.assignTo.inviteeName,
			role: body.assignTo.role ?? "owner",
		});
		if (!inviteResult.ok) return c.json({ error: inviteResult.error }, 400);
		return c.json({
			mailboxId,
			invite: {
				token: inviteResult.invite.token,
				inviteUrl: inviteResult.inviteUrl,
				emailSent: inviteResult.emailSent,
				emailError: inviteResult.emailError ?? null,
				inviteeEmail: inviteResult.invite.inviteeEmail,
				role: inviteResult.invite.role,
				expiresAt: inviteResult.invite.expiresAt,
			},
		});
	});

	app.put("/api/v1/admin/mailboxes/:mailboxId/acl", async (c) => {
		const principal = c.get("principal");
		const mailboxId = canonicalMailboxId(c.req.param("mailboxId"));
		if (!mailboxId) return c.json({ error: "Invalid mailbox email address" }, 400);
		if (!principal || !(await canAdministerMailboxDomain(c.env, principal, mailboxId))) {
			return c.json({ error: "Forbidden" }, 403);
		}
		const settings = await loadMailboxSettingsRaw(c.env.BUCKET, mailboxId);
		if (settings === null) return c.json({ error: "Not found" }, 404);
		const body = TransferAclBody.parse(await c.req.json());
		const validated = validateAclWrite({
			owners: body.owners,
			members: body.members ?? [],
		});
		if (!validated.ok) return c.json({ error: validated.error }, 400);
		const resolved = await resolveAclPrincipalsToAccounts(
			c.env.BUCKET,
			validated.acl,
		);
		const next = { ...settings, acl: resolved };
		await c.env.BUCKET.put(mailboxMetadataKey(mailboxId), JSON.stringify(next));
		await appendAdminAudit(c.env.BUCKET, {
			actorKeys: principalKeys(principal),
			action: "mailbox.transfer_acl",
			mailboxId,
			detail: { owners: resolved.owners, members: resolved.members },
		});
		return c.json(mailboxAccessPayload(mailboxId, next, principal));
	});

	app.delete("/api/v1/admin/mailboxes/:mailboxId", async (c) => {
		const principal = c.get("principal");
		const mailboxId = canonicalMailboxId(c.req.param("mailboxId"));
		if (!mailboxId) return c.json({ error: "Invalid mailbox email address" }, 400);
		if (!principal || !(await canAdministerMailboxDomain(c.env, principal, mailboxId))) {
			return c.json({ error: "Forbidden" }, 403);
		}
		const settings = await loadMailboxSettingsRaw(c.env.BUCKET, mailboxId);
		if (settings === null) return c.json({ error: "Not found" }, 404);

		const stub = getMailboxStub(c.env, mailboxId);
		const { conversationIds } = await stub.purgeMailbox(mailboxId);
		const agentNames = new Set<string>([
			mailboxId,
			...conversationIds.map((id) => agentInstanceName(mailboxId, id)),
		]);
		for (const name of agentNames) {
			try {
				const agentStub = c.env.EMAIL_AGENT.get(
					c.env.EMAIL_AGENT.idFromName(name),
				);
				const purgable = agentStub as {
					purge?: () => Promise<unknown>;
					fetch: (input: RequestInfo, init?: RequestInit) => Promise<Response>;
				};
				if (typeof purgable.purge === "function") {
					await purgable.purge();
				} else {
					await purgable.fetch(
						new Request("https://agents/purge", { method: "POST" }),
					);
				}
			} catch (e) {
				console.error(
					`EmailAgent purge failed for ${name}:`,
					(e as Error).message,
				);
			}
		}
		await appendAdminAudit(c.env.BUCKET, {
			actorKeys: principalKeys(principal),
			action: "mailbox.delete",
			mailboxId,
		});
		return c.body(null, 204);
	});

	app.post("/api/v1/admin/invites", async (c) => {
		const principal = c.get("principal");
		const body = InviteBody.parse(await c.req.json());
		const mailboxId = canonicalMailboxId(body.mailboxId);
		if (!mailboxId) return c.json({ error: "Invalid mailbox email address" }, 400);
		if (!principal || !(await canAdministerMailboxDomain(c.env, principal, mailboxId))) {
			return c.json({ error: "Forbidden" }, 403);
		}
		const settings = await loadMailboxSettingsRaw(c.env.BUCKET, mailboxId);
		if (settings === null) return c.json({ error: "Not found" }, 404);
		const inviteResult = await createPendingInvite(c, principal, {
			mailboxId,
			inviteEmail: body.inviteEmail,
			inviteeName: body.inviteeName,
			role: body.role ?? "owner",
		});
		if (!inviteResult.ok) return c.json({ error: inviteResult.error }, 400);
		return c.json(
			{
				token: inviteResult.invite.token,
				inviteUrl: inviteResult.inviteUrl,
				emailSent: inviteResult.emailSent,
				emailError: inviteResult.emailError ?? null,
				mailboxId,
				inviteeEmail: inviteResult.invite.inviteeEmail,
				role: inviteResult.invite.role,
				expiresAt: inviteResult.invite.expiresAt,
			},
			201,
		);
	});

	app.get("/api/v1/admin/mailboxes/:mailboxId/invites", async (c) => {
		const principal = c.get("principal");
		const mailboxId = canonicalMailboxId(c.req.param("mailboxId"));
		if (!mailboxId) return c.json({ error: "Invalid mailbox email address" }, 400);
		if (!principal || !(await canAdministerMailboxDomain(c.env, principal, mailboxId))) {
			return c.json({ error: "Forbidden" }, 403);
		}
		const tokens = await listInviteTokensForMailbox(c.env.BUCKET, mailboxId);
		const invites = [];
		for (const token of tokens) {
			const invite = await loadInvite(c.env.BUCKET, token);
			if (!invite) continue;
			invites.push({
				...publicInvitePayload(invite),
				token: invite.token,
				createdAt: invite.createdAt,
			});
		}
		return c.json(invites);
	});

	app.post("/api/v1/admin/invites/:token/revoke", async (c) => {
		const principal = c.get("principal");
		if (!principal) return c.json({ error: "Forbidden" }, 403);
		const invite = await loadInvite(c.env.BUCKET, c.req.param("token"));
		if (!invite) return c.json({ error: "Not found" }, 404);
		if (!(await canAdministerMailboxDomain(c.env, principal, invite.mailboxId))) {
			return c.json({ error: "Forbidden" }, 403);
		}
		if (invite.status !== "pending") {
			return c.json({ error: `Invite is ${invite.status}` }, 400);
		}
		const next = { ...invite, status: "revoked" as const };
		await saveInvite(c.env.BUCKET, next);
		await appendAdminAudit(c.env.BUCKET, {
			actorKeys: principalKeys(principal),
			action: "invite.revoke",
			mailboxId: invite.mailboxId,
			detail: { token: invite.token },
		});
		return c.json(publicInvitePayload(next));
	});

	app.post("/api/v1/admin/invites/:token/resend", async (c) => {
		const principal = c.get("principal");
		if (!principal) return c.json({ error: "Forbidden" }, 403);
		const invite = await loadInvite(c.env.BUCKET, c.req.param("token"));
		if (!invite) return c.json({ error: "Not found" }, 404);
		if (!(await canAdministerMailboxDomain(c.env, principal, invite.mailboxId))) {
			return c.json({ error: "Forbidden" }, 403);
		}
		if (!inviteIsActive(invite)) {
			return c.json({ error: "Invite is not active" }, 400);
		}
		const delivery = await trySendInviteEmail(c, invite);
		return c.json({
			...publicInvitePayload(invite),
			token: invite.token,
			inviteUrl: delivery.inviteUrl,
			emailSent: delivery.sent,
			emailError: delivery.error ?? null,
		});
	});

	// Owner/member sharing invite (Phase 3) — creates pending invite + email
	app.post("/api/v1/mailboxes/:mailboxId/invites", async (c) => {
		const principal = c.get("principal");
		if (!principal) return c.json({ error: "Forbidden" }, 403);
		const mailboxId = canonicalMailboxId(c.req.param("mailboxId"));
		if (!mailboxId) return c.json({ error: "Invalid mailbox email address" }, 400);
		const settings = await loadMailboxSettingsRaw(c.env.BUCKET, mailboxId);
		if (settings === null) return c.json({ error: "Not found" }, 404);
		const admin = await isDomainAdmin(c.env, principal);
		if (!admin && !canManageAcl(settings, principal)) {
			return c.json({ error: "Forbidden" }, 403);
		}
		const body = z
			.object({
				inviteEmail: z.string().email(),
				inviteeName: z.string().max(200).optional(),
				role: z.enum(["owner", "member"]).optional(),
			})
			.parse(await c.req.json());
		const inviteResult = await createPendingInvite(c, principal, {
			mailboxId,
			inviteEmail: body.inviteEmail,
			inviteeName: body.inviteeName,
			role: body.role ?? "member",
		});
		if (!inviteResult.ok) return c.json({ error: inviteResult.error }, 400);
		return c.json(
			{
				token: inviteResult.invite.token,
				inviteUrl: inviteResult.inviteUrl,
				emailSent: inviteResult.emailSent,
				emailError: inviteResult.emailError ?? null,
				mailboxId,
				inviteeEmail: inviteResult.invite.inviteeEmail,
				role: inviteResult.invite.role,
				expiresAt: inviteResult.invite.expiresAt,
			},
			201,
		);
	});

	// ── Public invite + password auth ─────────────────────────────

	app.get("/api/v1/invites/:token", async (c) => {
		const invite = await loadInvite(c.env.BUCKET, c.req.param("token"));
		if (!invite) return c.json({ error: "Invite not found" }, 404);
		const payload = publicInvitePayload(invite);
		if (payload.status !== "pending") {
			return c.json({ error: `Invite is ${payload.status}`, invite: payload }, 410);
		}
		return c.json(payload);
	});

	app.post("/api/v1/invites/:token/accept", async (c) => {
		const token = c.req.param("token");
		const invite = await loadInvite(c.env.BUCKET, token);
		if (!invite) return c.json({ error: "Invite not found" }, 404);
		if (!inviteIsActive(invite)) {
			return c.json({ error: "Invite is not active" }, 410);
		}
		const body = AcceptInviteBody.parse(await c.req.json());
		const strength = validatePasswordStrength(body.password);
		if (strength) return c.json({ error: strength }, 400);

		const settings = await loadMailboxSettingsRaw(c.env.BUCKET, invite.mailboxId);
		if (settings === null) return c.json({ error: "Mailbox not found" }, 404);

		const mobileSecret =
			c.env.MOBILE_JWT_SECRET ||
			(isDevRuntime() ? "dev-mobile-jwt-secret-change-me" : "");
		if (!mobileSecret) {
			return c.json(
				{ error: "Password auth is not configured. Set MOBILE_JWT_SECRET." },
				500,
			);
		}

		// Only the first owner may claim mailbox-address password login.
		// Members (and later owners) sign in with contact email to avoid
		// overwriting platform/identity/logins/by-mailbox/{mailbox}.
		const claimMailboxLogin = invite.role === "owner";
		if (claimMailboxLogin) {
			const existingLogin = await findUserIdByLoginEmail(
				c.env.BUCKET,
				invite.mailboxId,
			);
			if (existingLogin) {
				return c.json(
					{
						error:
							"This mailbox already has a password login. Sign in with that account, or ask an admin to reset access.",
					},
					409,
				);
			}
		}

		const userId = crypto.randomUUID();
		const passwordHash = await hashPassword(body.password);
		const now = new Date().toISOString();

		// Claim the invite before writing user/ACL so concurrent accepts lose.
		const stillPending = await loadInvite(c.env.BUCKET, token);
		if (!stillPending || !inviteIsActive(stillPending)) {
			return c.json({ error: "Invite is not active" }, 410);
		}
		const accepted = {
			...stillPending,
			status: "accepted" as const,
			acceptedAt: now,
			acceptedUserId: userId,
		};
		await saveInvite(c.env.BUCKET, accepted);

		const user: PlatformUser = {
			id: userId,
			contactEmail: invite.inviteeEmail,
			mailboxEmail: claimMailboxLogin ? invite.mailboxId : undefined,
			passwordHash,
			linkedSubs: [],
			createdAt: now,
			updatedAt: now,
		};
		await savePlatformUser(c.env.BUCKET, user);

		const sessionPrincipal = principalFromPlatformUser(user);
		const ensured = await ensurePrincipalAccount(c.env.BUCKET, sessionPrincipal, {
			// The invitee email is unverified (the inviter sees the token), so it
			// is contact info only: never an identity key.
			extraPrincipals: [
				`user:${user.id}`,
				...(user.mailboxEmail
					? [`email:${canonicalMailboxId(user.mailboxEmail) ?? user.mailboxEmail}`]
					: []),
			],
		});
		const userKeys = [`account:${ensured.account.id}`];
		const acl = parseAcl(settings);
		if (invite.role === "owner") {
			acl.owners = [...new Set([...acl.owners, ...userKeys])];
			acl.members = acl.members.filter((k) => !userKeys.includes(k));
		} else {
			const ownerSet = new Set(acl.owners);
			for (const k of userKeys) {
				if (!ownerSet.has(k) && !acl.members.includes(k)) acl.members.push(k);
			}
		}
		if (body.displayName?.trim()) {
			settings.fromName = body.displayName.trim();
		}
		const next = { ...settings, acl };
		await c.env.BUCKET.put(
			mailboxMetadataKey(invite.mailboxId),
			JSON.stringify(next),
		);

		const sessionEmail = claimMailboxLogin ? invite.mailboxId : undefined;
		const session = await issuePasswordSessionToken(mobileSecret, {
			userId,
			email: sessionEmail,
		});
		const principal = ensured.principal;
		c.header(
			"Set-Cookie",
			passwordSessionCookieHeader(session.token, {
				secure: !isDevRuntime(),
			}),
		);
		return c.json({
			mailboxId: invite.mailboxId,
			userId,
			accountId: ensured.account.id,
			token: session.token,
			expiresAt: session.expiresAt,
			principal: {
				email: principal.email ?? null,
				sub: principal.sub ?? null,
				keys: principalKeys(principal),
			},
		});
	});

	app.post("/api/v1/auth/password", async (c) => {
		const body = PasswordLoginBody.parse(await c.req.json());
		const mobileSecret =
			c.env.MOBILE_JWT_SECRET ||
			(isDevRuntime() ? "dev-mobile-jwt-secret-change-me" : "");
		if (!mobileSecret) {
			return c.json(
				{ error: "Password auth is not configured. Set MOBILE_JWT_SECRET." },
				500,
			);
		}
		const login = canonicalMailboxId(body.email) ?? body.email.toLowerCase();
		const userId = await findUserIdByLoginEmail(c.env.BUCKET, login);
		if (!userId) return c.json({ error: "Invalid email or password" }, 401);
		const user = await loadPlatformUser(c.env.BUCKET, userId);
		if (!user) return c.json({ error: "Invalid email or password" }, 401);
		const ok = await verifyPassword(body.password, user.passwordHash);
		if (!ok) return c.json({ error: "Invalid email or password" }, 401);
		const session = await issuePasswordSessionToken(mobileSecret, {
			userId: user.id,
			email: user.mailboxEmail,
		});
		c.header(
			"Set-Cookie",
			passwordSessionCookieHeader(session.token, {
				secure: !isDevRuntime(),
			}),
		);
		const principal = principalFromPlatformUser(user);
		return c.json({
			token: session.token,
			expiresAt: session.expiresAt,
			email: principal.email ?? null,
			sub: principal.sub ?? null,
			keys: principalKeys(principal),
		});
	});

	app.post("/api/v1/auth/password/logout", async (c) => {
		c.header(
			"Set-Cookie",
			clearPasswordSessionCookieHeader(!isDevRuntime()),
		);
		return c.json({ ok: true });
	});

	app.post("/api/v1/auth/password/forgot", async (c) => {
		const parsed = ForgotPasswordBody.safeParse(await c.req.json().catch(() => ({})));
		if (!parsed.success) {
			return c.json({ error: "Please enter a valid email address" }, 400);
		}
		const inputEmail = parsed.data.email.trim();
		const login = canonicalMailboxId(inputEmail) ?? inputEmail.toLowerCase();
		const userId = await findUserIdByLoginEmail(c.env.BUCKET, login);

		let devResetCode: string | undefined;
		let devResetToken: string | undefined;

		if (userId) {
			const user = await loadPlatformUser(c.env.BUCKET, userId);
			if (user) {
				const reset = await createPasswordReset(c.env.BUCKET, user.id, inputEmail);
				if (!reset) {
					// Same response as success so the cap doesn't reveal the account.
					console.warn(`[PasswordReset] Issuance cap reached for user ${user.id}`);
					return c.json({
						ok: true,
						message: "If an account exists with this email, reset instructions have been sent.",
					});
				}
				devResetCode = reset.code;
				devResetToken = reset.token;

				const resetUrl = `${appBaseUrl(c)}/reset-password?token=${reset.token}`;
				const text = `Hi,\n\nWe received a request to reset your password on Inboxies.\n\nYour 6-digit reset code is:\n${reset.code}\n\nOr click this link to reset your password:\n${resetUrl}\n\nThis code and link will expire in 1 hour. If you didn't request this reset, you can safely ignore this email.\n`;
				const html = `<p>Hi,</p><p>We received a request to reset your password on Inboxies.</p><p>Your 6-digit reset code is:</p><p style="font-size: 26px; font-weight: bold; letter-spacing: 4px; margin: 16px 0; color: #1e293b;">${reset.code}</p><p><a href="${resetUrl}">Reset your password</a></p><p>Or copy this link:<br/>${resetUrl}</p><p style="color: #64748b; font-size: 13px;">This code and link will expire in 1 hour. If you didn't request a password reset, you can safely ignore this email.</p>`;

				// Deliver to all associated emails (personal recovery email and mailbox email)
				const targetEmails = Array.from(
					new Set(
						[user.contactEmail, user.mailboxEmail, inputEmail]
							.map((e) => e?.trim())
							.filter((e): e is string => Boolean(e) && e.includes("@")),
					),
				);

				if (c.env.EMAIL) {
					for (const dest of targetEmails) {
						try {
							await sendEmail(c.env.EMAIL, {
								to: dest,
								from: { email: inviteFromAddress(c), name: "Inboxies" },
								subject: "Reset your Inboxies password",
								text,
								html,
							});
							console.log(`[PasswordReset] Email sent successfully to ${dest}`);
						} catch (e) {
							console.error(
								`[PasswordReset] Failed to send reset email to ${dest}:`,
								(e as Error).message || e,
							);
						}
					}
				} else {
					console.log(
						`[Dev] Password reset for ${targetEmails.join(", ")}: Code=${reset.code} Token=${reset.token}`,
					);
				}
			}
		} else {
			console.warn(`[PasswordReset] No account found in R2 for login: ${login}`);
		}

		const isDev = isDevRuntime() || !c.env.EMAIL;
		return c.json({
			ok: true,
			message: "If an account exists with this email, reset instructions have been sent.",
			...(isDev && devResetCode ? { devResetCode, devResetToken } : {}),
		});
	});

	app.post("/api/v1/auth/password/reset", async (c) => {
		const parsed = ResetPasswordBody.safeParse(await c.req.json().catch(() => ({})));
		if (!parsed.success) {
			return c.json(
				{ error: "Invalid request. Provide token, or email and code, and newPassword." },
				400,
			);
		}
		const { newPassword } = parsed.data;
		const token = parsed.data.token?.trim() ?? "";
		const code = parsed.data.code?.trim() ?? "";
		const email = parsed.data.email?.trim() ?? "";
		if (!token && !code) {
			return c.json({ error: "Reset token or 6-digit code is required." }, 400);
		}
		if (!token && !email) {
			return c.json({ error: "Email is required with the 6-digit code." }, 400);
		}

		const strengthErr = validatePasswordStrength(newPassword);
		if (strengthErr) {
			return c.json({ error: strengthErr }, 400);
		}

		let resetRecord: PasswordResetRecord | null = null;
		if (token) {
			resetRecord = await verifyPasswordReset(c.env.BUCKET, { token });
		} else {
			if (await passwordResetCodeRateLimited(c)) {
				return c.json({ error: "Too many attempts. Wait a minute and try again." }, 429);
			}
			const login = canonicalMailboxId(email) ?? email.toLowerCase();
			const userId = await findUserIdByLoginEmail(c.env.BUCKET, login);
			if (userId) {
				resetRecord = await verifyPasswordReset(c.env.BUCKET, { userId, code });
			}
		}
		if (!resetRecord) {
			return c.json({ error: "Invalid or expired reset code or link." }, 400);
		}

		const user = await loadPlatformUser(c.env.BUCKET, resetRecord.userId);
		if (!user) {
			return c.json({ error: "User account not found." }, 404);
		}

		const mobileSecret =
			c.env.MOBILE_JWT_SECRET ||
			(isDevRuntime() ? "dev-mobile-jwt-secret-change-me" : "");
		if (!mobileSecret) {
			return c.json({ error: "Password auth is not configured. Set MOBILE_JWT_SECRET." }, 500);
		}

		const newHash = await hashPassword(newPassword);
		user.passwordHash = newHash;
		user.updatedAt = new Date().toISOString();
		await savePlatformUser(c.env.BUCKET, user);

		await consumePasswordReset(c.env.BUCKET, resetRecord);

		const session = await issuePasswordSessionToken(mobileSecret, {
			userId: user.id,
			email: user.mailboxEmail,
		});
		c.header(
			"Set-Cookie",
			passwordSessionCookieHeader(session.token, {
				secure: !isDevRuntime(),
			}),
		);
		const principal = principalFromPlatformUser(user);
		return c.json({
			ok: true,
			token: session.token,
			expiresAt: session.expiresAt,
			email: principal.email ?? null,
			sub: principal.sub ?? null,
			keys: principalKeys(principal),
		});
	});

	/**
	 * List linked sign-in methods for the current identity account.
	 */
	app.get("/api/v1/me/identities", async (c) => {
		const principal = c.get("principal");
		if (!principal || principalKeys(principal).length === 0) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		const { accountId, identities } = await listIdentitiesForPrincipal(
			c.env.BUCKET,
			principal,
		);
		return c.json({
			accountId,
			identities,
			keys: principalKeys(principal),
			linkedEmails: principal.linkedEmails ?? [],
		});
	});

	/**
	 * List all known user accounts for sharing/member autocompletion (not mailboxes).
	 */
	app.get("/api/v1/accounts", async (c) => {
		const principal = c.get("principal");
		if (!principal || principalKeys(principal).length === 0) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		const accounts = await listAllIdentityAccounts(c.env.BUCKET);
		const mbs = await listMailboxes(c.env.BUCKET);
		const mailboxEmails = new Set(mbs.map((m) => m.email.toLowerCase()));
		const userAccounts = accounts.filter(
			(acc) => !mailboxEmails.has(acc.email.toLowerCase()),
		);
		return c.json(userAccounts);
	});

	/**
	 * In-session Connect IdP / Add password: attach a freshly verified
	 * Apple/Google identity token (or a new password) to the durable account
	 * for this authenticated session. Primary linking UX; link codes remain
	 * for cross-device / when IdP cannot run on this surface.
	 */
	app.post("/api/v1/me/identities/attach", async (c) => {
		const principal = c.get("principal");
		if (!principal || principalKeys(principal).length === 0) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		const body = z
			.discriminatedUnion("provider", [
				z.object({
					provider: z.literal("apple"),
					identityToken: z.string().min(1),
				}),
				z.object({
					provider: z.literal("google"),
					idToken: z.string().min(1),
				}),
				z.object({
					provider: z.literal("password"),
					password: z.string().min(1),
					loginEmail: z.string().email().optional(),
				}),
			])
			.safeParse(await c.req.json());
		if (!body.success) {
			return c.json(
				{
					error:
						"Invalid body. Use provider apple|google|password with the matching token/password fields.",
				},
				400,
			);
		}

		try {
			if (body.data.provider === "apple") {
				const appleClientId = c.env.APPLE_CLIENT_ID;
				if (!appleClientId) {
					return c.json(
						{
							error:
								"Apple Sign In is not configured. Set APPLE_CLIENT_ID.",
						},
						503,
					);
				}
				const claims = await verifyAppleIdentityToken(
					body.data.identityToken,
					appleClientId,
				);
				const result = await attachIdpToSessionAccount(
					c.env.BUCKET,
					principal,
					{
						sub: claims.sub,
						provider: "apple",
						emails: claims.email ? [claims.email] : [],
					},
				);
				c.set("principal", result.expanded);
				const admin = await isDomainAdmin(c.env, result.expanded);
				return c.json({
					ok: true,
					provider: "apple",
					accountId: result.account.id,
					linkedEmails: result.linkedEmails,
					keys: principalKeys(result.expanded),
					isAdmin: admin,
					identities: (
						await listIdentitiesForPrincipal(c.env.BUCKET, result.expanded)
					).identities,
				});
			}

			if (body.data.provider === "google") {
				const googleClientId = c.env.GOOGLE_CLIENT_ID;
				if (!googleClientId) {
					return c.json(
						{
							error:
								"Google Sign In is not configured. Set GOOGLE_CLIENT_ID.",
						},
						503,
					);
				}
				const claims = await verifyGoogleIdentityToken(
					body.data.idToken,
					googleClientId,
				);
				const result = await attachIdpToSessionAccount(
					c.env.BUCKET,
					principal,
					{
						sub: claims.sub,
						provider: "google",
						emails: claims.email ? [claims.email] : [],
					},
				);
				c.set("principal", result.expanded);
				const admin = await isDomainAdmin(c.env, result.expanded);
				return c.json({
					ok: true,
					provider: "google",
					accountId: result.account.id,
					linkedEmails: result.linkedEmails,
					keys: principalKeys(result.expanded),
					isAdmin: admin,
					identities: (
						await listIdentitiesForPrincipal(c.env.BUCKET, result.expanded)
					).identities,
				});
			}

			const strength = validatePasswordStrength(body.data.password);
			if (strength) return c.json({ error: strength }, 400);
			const passwordHash = await hashPassword(body.data.password);
			const result = await attachPasswordToSessionAccount(
				c.env.BUCKET,
				principal,
				{
					passwordHash,
					loginEmail: body.data.loginEmail,
				},
			);
			c.set("principal", result.expanded);
			const admin = await isDomainAdmin(c.env, result.expanded);
			return c.json({
				ok: true,
				provider: "password",
				accountId: result.account.id,
				userId: result.userId,
				linkedEmails: result.linkedEmails,
				keys: principalKeys(result.expanded),
				isAdmin: admin,
				identities: (
					await listIdentitiesForPrincipal(c.env.BUCKET, result.expanded)
				).identities,
			});
		} catch (err) {
			if (err instanceof IdentityAlreadyLinkedError) {
				return c.json({ error: err.message }, 409);
			}
			if (err instanceof IdentityNotOwnedError) {
				return c.json({ error: err.message }, 403);
			}
			const message =
				err instanceof Error ? err.message : "Could not attach identity";
			if (message === "Unauthorized") {
				return c.json({ error: message }, 401);
			}
			if (
				message.includes("already has a password") ||
				message.includes("loginEmail is required") ||
				message.includes("already has a password login")
			) {
				return c.json({ error: message }, 409);
			}
			// Token verify failures from jose / our helpers
			if (
				message.includes("identity token") ||
				message.includes("JWT") ||
				message.includes("claim") ||
				message.includes("audience") ||
				message.toLowerCase().includes("invalid")
			) {
				return c.json({ error: "Invalid identity token" }, 401);
			}
			console.error("attach identity failed:", message);
			return c.json({ error: message }, 400);
		}
	});

	/**
	 * Change password for the password sign-in method on this account.
	 * Works from any authenticated session (Access / Apple / Google / password)
	 * as long as the account already has a password. Requires the current
	 * password — not a password-session-only path.
	 */
	app.post("/api/v1/me/identities/password", async (c) => {
		const principal = c.get("principal");
		if (!principal || principalKeys(principal).length === 0) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		const body = z
			.object({
				currentPassword: z.string().min(1).max(200),
				newPassword: z.string().min(1).max(200),
			})
			.safeParse(await c.req.json());
		if (!body.success) {
			return c.json(
				{
					error:
						"Invalid body. Provide currentPassword and newPassword.",
				},
				400,
			);
		}

		const strength = validatePasswordStrength(body.data.newPassword);
		if (strength) return c.json({ error: strength }, 400);
		if (body.data.currentPassword === body.data.newPassword) {
			return c.json(
				{ error: "New password must be different from the current password" },
				400,
			);
		}

		try {
			const user = await passwordUserForSessionAccount(
				c.env.BUCKET,
				principal,
			);
			if (!user) {
				return c.json(
					{ error: "This account has no password sign-in method" },
					404,
				);
			}
			const currentOk = await verifyPassword(
				body.data.currentPassword,
				user.passwordHash,
			);
			if (!currentOk) {
				return c.json({ error: "Current password is incorrect" }, 401);
			}
			const passwordHash = await hashPassword(body.data.newPassword);
			const result = await updatePasswordHashForSessionAccount(
				c.env.BUCKET,
				principal,
				passwordHash,
			);
			await appendAdminAudit(c.env.BUCKET, {
				actorKeys: principalKeys(principal),
				action: "identity.password.change",
				detail: { userId: result.userId, accountId: result.account.id },
			});
			return c.json({
				ok: true,
				userId: result.userId,
				accountId: result.account.id,
				identities: (
					await listIdentitiesForPrincipal(c.env.BUCKET, principal)
				).identities,
			});
		} catch (err) {
			const message =
				err instanceof Error ? err.message : "Could not change password";
			if (message === "Unauthorized") {
				return c.json({ error: message }, 401);
			}
			if (message.includes("no password sign-in method")) {
				return c.json({ error: message }, 404);
			}
			console.error("change password failed:", message);
			return c.json({ error: message }, 400);
		}
	});

	/**
	 * Any authenticated session: mint a short-lived code so another sign-in
	 * method (Apple / Google / Access / password) can join this account.
	 * Domain Admins also stamp DOMAIN_ADMINS emails onto the code.
	 * Secondary / cross-device fallback — prefer POST /me/identities/attach.
	 */
	app.post("/api/v1/me/identity-link-codes", async (c) => {
		const principal = c.get("principal");
		if (!principal || principalKeys(principal).length === 0) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		try {
			const record = await mintIdentityLinkCode(c.env, principal);
			await appendAdminAudit(c.env.BUCKET, {
				actorKeys: principalKeys(principal),
				action: "identity_link_code.create",
				detail: {
					emails: record.emails,
					accountId: record.accountId,
					principals: record.principals,
				},
			});
			return c.json({
				code: record.code,
				emails: record.emails,
				principals: record.principals ?? [],
				accountId: record.accountId,
				expiresAt: record.expiresAt,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : "Could not create link code";
			return c.json({ error: message }, 400);
		}
	});

	/**
	 * Authenticated session (Apple/Google/Access/password): redeem a link code
	 * minted by another method on the same person → durable account union.
	 * After redeem, /me and GET /mailboxes use the union of linked principals.
	 */
	app.post("/api/v1/auth/redeem-identity-link", async (c) => {
		const principal = c.get("principal");
		if (!principal || principalKeys(principal).length === 0) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		const body = z.object({ code: z.string().min(4).max(64) }).parse(await c.req.json());
		try {
			const result = await redeemIdentityLinkCode(
				c.env.BUCKET,
				principal,
				body.code,
			);
			const admin = await isDomainAdmin(c.env, result.expanded);
			c.set("principal", result.expanded);
			return c.json({
				ok: true,
				accountId: result.account.id,
				linkedEmails: result.linkedEmails,
				sub: principal.sub ?? null,
				keys: principalKeys(result.expanded),
				isAdmin: admin,
				identities: (
					await listIdentitiesForPrincipal(c.env.BUCKET, result.expanded)
				).identities,
			});
		} catch (err) {
			const message =
				err instanceof Error ? err.message : "Could not redeem link code";
			const status =
				message === "Unauthorized"
					? 401
					: message.includes("Invalid or expired")
						? 400
						: 400;
			return c.json({ error: message }, status);
		}
	});
}

/** Shared helpers for create-policy checks from index.ts */
export async function resolveCreateGate(
	env: Env,
	principal: RequestPrincipal | undefined,
) {
	const allowlist = await resolveAdminAllowlist(env);
	const hasAdmins = allowlist.size > 0;
	const policy = parseMailboxCreatePolicy(env.MAILBOX_CREATE_POLICY, hasAdmins);
	const admin = principalIsDomainAdmin(principal, allowlist);
	return {
		policy,
		isAdmin: admin,
		allowed: canCreateMailbox(principal, { isAdmin: admin, policy }),
	};
}
