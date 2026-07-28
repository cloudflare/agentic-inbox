// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Mailbox middleware + provisioning helpers.
 *
 * `requireMailbox` resolves the MailboxDO stub for a `:mailboxId` route param,
 * and enforces live Personal ownership or Shared membership before resolving
 * the mailbox Durable Object. An active administrator is member-equivalent on
 * every active mailbox; actions still record the acting user.
 */
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import type { MailboxDO } from "../durableObject";
import type { Env } from "../types";
import type { SessionClaims } from "./auth";
import { systemPromptFor } from "./prompts.ts";
import { resolveBrand } from "../routes/brand.ts";
import { mailboxAccess } from "./mailbox-access.ts";
import { hasExactLiveMailboxAccess } from "./live-mailbox-authorization.ts";
import { replaceWithPrivateResponse } from "./response-privacy.ts";
import { normalizeMailAddress } from "./mail-address.ts";

export type MailboxContext = {
	Bindings: Env;
	Variables: {
		mailboxStub: DurableObjectStub<MailboxDO>;
		authorizedMailboxId: string;
		mailboxReadAuthorizationFinalized?: boolean;
		session?: SessionClaims;
	};
};

/** Re-check the live content grant after asynchronous mailbox work and before disclosure. */
export async function hasLiveMailboxContentAccess(
	c: Context<MailboxContext>,
): Promise<boolean> {
	const mailboxId = c.get("authorizedMailboxId");
	const session = c.get("session");
	if (!mailboxId || !session) return false;
	return hasExactLiveMailboxAccess(
		c.env,
		mailboxId,
		session.sub,
		session.sessionVersion,
	);
}

/** Tell the mailbox middleware that this route owns the terminal disclosure check. */
export function markMailboxReadAuthorizationFinalized(
	c: Context<MailboxContext>,
): void {
	c.set("mailboxReadAuthorizationFinalized", true);
}

function isReadMethod(method: string): boolean {
	return method === "GET" || method === "HEAD";
}

function replaceWithForbidden(c: Context<MailboxContext>): void {
	replaceWithPrivateResponse(c, c.json({ error: "Forbidden" }, 403));
}

/** Settings-only routes authorize themselves and must never resolve a mailbox DO. */
export function bypassMailboxContentAuthorization(method: string, pathname: string): boolean {
	const parts = pathname.split("/").filter(Boolean);
	return (
		isReadMethod(method) &&
		parts.length === 5 &&
		parts[0] === "api" && parts[1] === "v1" && parts[2] === "mailboxes" &&
		parts[4] === "settings"
	) || (
		method === "PATCH" &&
		parts.length === 6 &&
		parts[0] === "api" && parts[1] === "v1" && parts[2] === "mailboxes" &&
		parts[4] === "settings" && parts[5] === "signature"
	);
}

export const requireMailbox = createMiddleware<MailboxContext>(async (c, next) => {
	const rawId = c.req.param("mailboxId");
	if (!rawId) return c.json({ error: "Mailbox ID required" }, 400);
	// Hono has already decoded route parameters. Normalize once and preserve this
	// exact authorized identity for all downstream storage and Durable Object keys.
	const mailboxId = normalizeMailAddress(rawId);
	if (!mailboxId) return c.json({ error: "Invalid Mailbox ID" }, 400);
	c.set("authorizedMailboxId", mailboxId);
	if (bypassMailboxContentAuthorization(c.req.method, new URL(c.req.url).pathname)) {
		await next();
		return;
	}

	const session = c.get("session");
	if (!session) return c.json({ error: "Unauthorized" }, 401);
	const pathParts = new URL(c.req.url).pathname.split("/").filter(Boolean);
	const isMailboxManagementRequest =
		pathParts.length === 4 &&
		pathParts[0] === "api" &&
		pathParts[1] === "v1" &&
		pathParts[2] === "mailboxes";
	const access = mailboxAccess(c.env);
	if (isMailboxManagementRequest && c.req.method === "DELETE") {
		try {
			await access.requireMailboxAdministrator(session.sub);
		} catch {
			return c.json({ error: "Forbidden" }, 403);
		}
	} else if (
		isMailboxManagementRequest &&
		c.req.method === "PUT" &&
		!(await access.canManageMailboxSettings(session.sub, mailboxId))
	) {
		return c.json({ error: "Forbidden" }, 403);
	} else if (!(await hasLiveMailboxContentAccess(c))) {
		return c.json({ error: "Forbidden" }, 403);
	}

	// Verify mailbox exists
	const key = `mailboxes/${mailboxId}.json`;
	const obj = await c.env.BUCKET.head(key);
	if (!obj) {
		return c.json({ error: "Not found" }, 404);
	}

	// Instantiate DO stub
	const ns = c.env.MAILBOX;
	const id = ns.idFromName(mailboxId);
	const stub = ns.get(id);

	c.set("mailboxStub", stub);

	await next();
	if (
		isReadMethod(c.req.method) &&
		!c.get("mailboxReadAuthorizationFinalized")
	) {
		let hasAccess: boolean;
		try {
			hasAccess = await hasLiveMailboxContentAccess(c);
		} catch (error) {
			console.error("[mailbox] live authorization check failed", {
				operation: "mailbox_authorization_check",
				phase: "after_read",
				method: c.req.method,
				path: new URL(c.req.url).pathname,
				actorUserId: session.sub,
				errorName: error instanceof Error ? error.name : "UnknownError",
			});
			replaceWithPrivateResponse(
				c,
				c.json({ error: "Authorization unavailable" }, 500),
			);
			return;
		}
		if (!hasAccess) replaceWithForbidden(c);
	}
});

/**
 * Provision a mailbox: create its R2 settings doc (if missing) and initialise
 * the MailboxDO (default folders). Idempotent. Used by admin user creation and
 * the first-admin bootstrap. `settings` is merged over defaults — pass
 * `agentSystemPrompt` here to seed the active brand's AI context (D-43).
 */
export async function provisionMailbox(
	env: Env,
	email: string,
	name: string,
	settings?: Record<string, unknown>,
): Promise<void> {
	const addr = email.toLowerCase();
	const key = `mailboxes/${addr}.json`;
	if (!(await env.BUCKET.head(key))) {
		// Initialise the Durable Object before publishing the R2 settings document
		// that makes the mailbox routable to inbound catch-all delivery. If the DO
		// init fails, inbound must still reject the address as unprovisioned.
		const stub = env.MAILBOX.get(env.MAILBOX.idFromName(addr));
		await stub.getFolders();
		const defaultSettings = {
			fromName: name,
			forwarding: { enabled: false, email: "" },
			signature: { enabled: false, text: "" },
			autoReply: { enabled: false, subject: "", message: "" },
			agentSystemPrompt: systemPromptFor(resolveBrand(env.BRAND).id),
		};
		await env.BUCKET.put(key, JSON.stringify({ ...defaultSettings, ...settings }));
		return;
	}
	// Existing settings already make the mailbox routable; still touch the DO so a
	// partially initialised mailbox can self-heal when provisioning is retried.
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(addr));
	await stub.getFolders();
}
