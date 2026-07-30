// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { vapidConfig } from "./lib/push/transport";
import { handleReplyEmail, handleForwardEmail } from "./routes/reply-forward";
import { handleSendEmail } from "./routes/send-email";
import {
	handleDeleteEmail,
	handleDiscardDraft,
	handleMoveEmail,
	handleRestoreEmail,
} from "./routes/email-lifecycle";
import { handleCreateFolder, handleDeleteFolder } from "./routes/folders";
import { handleSaveDraft } from "./routes/drafts";
import { sharedMailboxAdminApp } from "./routes/shared-mailbox-admin";
import { savedViewsApp } from "./routes/saved-views";
import { snoozeRoutes } from "./routes/snooze";
import { conversationIntelligenceApp } from "./routes/conversation-intelligence";
import { conversationAnswerRoutes } from "./routes/conversation-answer";
import { replyRefinementRoutes } from "./routes/reply-refinement";
import { inboxTriageSuggestionRoutes } from "./routes/inbox-triage-suggestions";
import { conversationActivityRoutes } from "./routes/conversation-activity";
import { followUpReminderRoutes } from "./routes/follow-up-reminders";
import { searchRoutes } from "./routes/search";
import { aiSearchInterpreterRoutes } from "./routes/ai-search-interpreter";
import { recipientSuggestionRoutes } from "./routes/recipient-suggestions";
import { mailboxSignatureSettingsRoutes } from "./routes/mailbox-signature-settings";
import { aiDraftRoutes } from "./routes/ai-drafts";
import { todayBriefRoutes } from "./routes/today-brief";
import { globalTodayRoutes } from "./routes/global-today";
import { globalTodayBriefRoutes } from "./routes/global-today-brief";
import { globalSemanticSearchRoutes } from "./routes/global-semantic-search";
import { mailboxAttachmentRoutes } from "./routes/mailbox-attachments";
import { mailboxAttachmentByteRoutes } from "./routes/mailbox-attachment-bytes";
import { mailboxEmailBodyRoutes } from "./routes/mailbox-email-body.ts";
import { attachmentUploadRoutes } from "./routes/attachment-uploads";
import { mailboxChangeFeedRoutes } from "./routes/mailbox-change-feed";
import { mailPeopleRoutes } from "./routes/mail-people";
import { relationshipBriefRoutes } from "./routes/relationship-brief";
import { pushHealthRoutes } from "./routes/push-health";
import { pushSubscriptionRoutes } from "./routes/push-subscriptions";
import { mailboxMessageLocationRoutes } from "./routes/mailbox-message-location";
import { automationRuleRoutes } from "./routes/automation-rules";
import {
	handleCancelOutboundDelivery,
	handleGetOutboundDelivery,
	handleListOutboundDeliveries,
	handleRetryOutboundDelivery,
} from "./routes/outbound-deliveries";
import {
	handleArchiveConversation,
	handleSetConversationRead,
	handleTrashConversation,
} from "./routes/conversation-actions";
import {
	handleCancelBulkReservation,
	handleCreateBulkJob,
	handleGetBulkJob,
	handleRecoverBulkOperation,
	handleReserveBulkOperation,
} from "./routes/bulk-api.ts";
import { handleBatchTriage } from "./routes/batch-triage";
import {
	handleCreateLabel,
	handleDeleteLabel,
	handleListLabels,
	handleMutateLabels,
	handleUpdateLabel,
} from "./routes/labels";
import { systemPromptFor } from "./lib/prompts";
import { pwaManifestFor, resolveBrand } from "./routes/brand";
import { mailboxAccess, unregisterMailbox } from "./lib/mailbox-access";
import { actorFromSession } from "./lib/activity";
import { Folders } from "../shared/folders";
import type { Env } from "./types";
import {
	provisionMailbox,
	requireMailbox,
	type MailboxContext,
} from "./lib/mailbox";
import { privateNoStore } from "./lib/response-privacy";
import {
	isAddressInConfiguredMailDomains,
	normalizeMailAddress,
} from "./lib/mail-address";
import {
	MailboxSettingsConflictError,
	MailboxSettingsNotFoundError,
	mailboxSettingsInForce,
	mergeGeneralMailboxSettings,
	updateMailboxSettings,
} from "./lib/mailbox-settings-store";
import { requireAgentConnectionReconciliation } from "./lib/agent-connection-revocation-outbox.ts";
import { listStableLiveMailboxes } from "./lib/live-mailbox-authorization.ts";

type AppContext = Context<MailboxContext>;

// -- Request body schemas (kept for validation) ---------------------

const CreateMailboxBody = z.object({
	email: z.string().email(),
	name: z.string().min(1),
	settings: z.record(z.any()).optional(), // unvalidated — agentSystemPrompt goes straight to AI
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// -- Helpers --------------------------------------------------------

function intQuery(c: AppContext, key: string): number | undefined {
	const v = c.req.query(key);
	if (!v) return undefined;
	const n = Number(v);
	return Number.isNaN(n) ? undefined : n;
}

function boolQuery(c: AppContext, key: string): boolean | undefined {
	const v = c.req.query(key);
	if (v === undefined || v === "") return undefined;
	return v === "true" || v === "1";
}

// -- App & middleware -----------------------------------------------

const app = new Hono<MailboxContext>();
app.use(
	"/api/*",
	cors({
		origin: (origin) => {
			// Same-origin requests have no Origin header, so allow them.
			if (!origin) return origin;
			// In development, allow localhost for Vite dev server.
			try {
				const url = new URL(origin);
				if (url.hostname === "localhost" || url.hostname === "127.0.0.1")
					return origin;
			} catch {
				/* invalid origin */
			}
			// Block all other cross-origin requests. The app is served from the
			// same origin as the API, so legitimate browser requests never send
			// an Origin header. Returning undefined omits Access-Control-Allow-Origin.
			return undefined;
		},
	}),
);
app.use("/api/*", privateNoStore);
app.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox);
app.use("/api/v1/mailboxes/:mailboxId", requireMailbox);
app.route("/", mailPeopleRoutes);
app.route("/", relationshipBriefRoutes);
app.route("/", pushHealthRoutes);
app.route("/", pushSubscriptionRoutes);
app.route("/", mailboxMessageLocationRoutes);
app.route("/", automationRuleRoutes);
app.route("/", attachmentUploadRoutes);
app.route("/", mailboxEmailBodyRoutes);

// -- Config ---------------------------------------------------------

app.get("/api/v1/config", async (c) => {
	const domainsRaw = c.env.DOMAINS || "";
	const domains = domainsRaw
		.split(",")
		.map((d) => d.trim())
		.filter(Boolean);
	const session = c.get("session");
	if (!session) return c.json({ error: "Unauthorized" }, 401);
	const accessible = await listStableLiveMailboxes(
		c.env,
		session.sub,
		session.sessionVersion,
	);
	const allowed = new Set(
		((c.env.EMAIL_ADDRESSES ?? []) as string[]).map((address) =>
			address.toLowerCase(),
		),
	);
	const emailAddresses = accessible
		.map((mailbox) => mailbox.address)
		.filter((address) => allowed.size === 0 || allowed.has(address));
	// The VAPID public key drives the client's push subscribe + shows/hides the
	// enable-notifications UI. null when push isn't configured for this env.
	return c.json({
		domains,
		emailAddresses,
		vapidPublicKey: vapidConfig(c.env)?.publicKey ?? null,
	});
});

// PWA manifest, brand-parameterized (WISER-240). Public (no session): the
// browser fetches it uncredentialed. Ends in a file extension so the auth gate
// treats it as a static path.
app.get("/manifest.webmanifest", (c: AppContext) => {
	const manifest = pwaManifestFor(resolveBrand(c.env.BRAND));
	return new Response(JSON.stringify(manifest), {
		headers: {
			"Content-Type": "application/manifest+json",
			"Cache-Control": "public, max-age=3600",
		},
	});
});

// Who am I — drives the SPA header (account, admin link, sign out).
app.get("/api/v1/me", (c: AppContext) => {
	const session = c.get("session");
	if (!session) return c.json({ error: "Unauthorized" }, 401);
	return c.json({
		email: session.email,
		role: session.role,
		mailbox: session.mailbox,
	});
});

// -- Mailboxes ------------------------------------------------------

app.route("/api/v1/admin", sharedMailboxAdminApp);
app.route("/", savedViewsApp);
app.route("/", snoozeRoutes);
app.route("/", conversationIntelligenceApp);
app.route("/", conversationAnswerRoutes);
app.route("/", replyRefinementRoutes);
app.route("/", inboxTriageSuggestionRoutes);
app.route("/", conversationActivityRoutes);
app.route("/", followUpReminderRoutes);
app.route("/", searchRoutes);
app.route("/", aiSearchInterpreterRoutes);
app.route("/", recipientSuggestionRoutes);
app.route("/", mailboxSignatureSettingsRoutes);
app.route("/", aiDraftRoutes);
app.route("/", todayBriefRoutes);
app.route("/", globalTodayRoutes);
app.route("/", globalTodayBriefRoutes);
app.route("/", globalSemanticSearchRoutes);
app.route("/", mailboxAttachmentRoutes);
app.route("/", mailboxAttachmentByteRoutes);
app.route("/", mailboxChangeFeedRoutes);

app.get("/api/v1/mailboxes", async (c: AppContext) => {
	const session = c.get("session");
	if (!session) return c.json({ error: "Unauthorized" }, 401);
	const visible = await listStableLiveMailboxes(
		c.env,
		session.sub,
		session.sessionVersion,
	);
	return c.json(
		visible.map((mailbox) => ({
			id: mailbox.address,
			email: mailbox.address,
			name: mailbox.address,
			type: mailbox.type,
		})),
	);
});

app.post("/api/v1/mailboxes", async (c: AppContext) => {
	const session = c.get("session");
	if (!session || session.role !== "ADMIN") {
		return c.json({ error: "Forbidden" }, 403);
	}
	const {
		name,
		settings,
		email: rawEmail,
	} = CreateMailboxBody.parse(await c.req.json());
	const email = normalizeMailAddress(rawEmail);
	if (!email || !isAddressInConfiguredMailDomains(email, c.env.DOMAINS)) {
		return c.json({ error: "Mailbox must use a configured mail domain" }, 403);
	}
	const allowedAddresses = (c.env.EMAIL_ADDRESSES ?? []) as string[];
	if (
		allowedAddresses.length > 0 &&
		!allowedAddresses.map((a) => a.toLowerCase()).includes(email)
	) {
		return c.json(
			{ error: "Mailbox creation is restricted to configured EMAIL_ADDRESSES" },
			403,
		);
	}
	const key = `mailboxes/${email}.json`;
	if (await c.env.BUCKET.head(key))
		return c.json({ error: "Mailbox already exists" }, 409);
	const defaultSettings = {
		fromName: name,
		forwarding: { enabled: false, email: "" },
		signature: { enabled: false, text: "" },
		autoReply: { enabled: false, subject: "", message: "" },
		agentSystemPrompt: systemPromptFor(resolveBrand(c.env.BRAND).id),
	};
	const finalSettings = { ...defaultSettings, ...settings };
	const access = mailboxAccess(c.env);
	await access.requireMailboxAdministrator(session.sub);
	await access.registerSharedMailbox(session.sub, email);
	try {
		await provisionMailbox(c.env, email, name, finalSettings);
	} catch (error) {
		await unregisterMailbox(c.env, email).catch((rollbackError) =>
			console.error("[shared-mailbox-provisioning] registry rollback failed", {
				mailboxId: email,
				error:
					rollbackError instanceof Error
						? rollbackError.message
						: String(rollbackError),
			}),
		);
		throw error;
	}
	return c.json({ id: email, email, name, settings: finalSettings }, 201);
});

app.get("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.var.authorizedMailboxId;
	const obj = await c.env.BUCKET.get(`mailboxes/${mailboxId}.json`);
	if (!obj) return c.json({ error: "Not found" }, 404);
	const settings = await obj.json<Record<string, unknown>>();
	return c.json({
		id: mailboxId,
		name: mailboxId,
		email: mailboxId,
		settings: mailboxSettingsInForce(settings, resolveBrand(c.env.BRAND).id),
	});
});

app.put("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.var.authorizedMailboxId;
	const body = await c.req.json().catch(() => null);
	const requested = isRecord(body) ? body.settings : null;
	if (!isRecord(requested)) {
		return c.json(
			{ error: "Mailbox settings are invalid", code: "INVALID" },
			400,
		);
	}
	try {
		const settings = await updateMailboxSettings(
			c.env.BUCKET,
			mailboxId,
			(current) => mergeGeneralMailboxSettings(current, requested),
		);
		return c.json({
			id: mailboxId,
			name: mailboxId,
			email: mailboxId,
			settings: mailboxSettingsInForce(settings, resolveBrand(c.env.BRAND).id),
		});
	} catch (error) {
		if (error instanceof MailboxSettingsNotFoundError) {
			return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
		}
		if (error instanceof MailboxSettingsConflictError) {
			return c.json({ error: error.message, code: "SETTINGS_CONFLICT" }, 409);
		}
		return c.json(
			{
				error: "Mailbox settings are unavailable",
				code: "SETTINGS_UNAVAILABLE",
			},
			500,
		);
	}
});

app.delete("/api/v1/mailboxes/:mailboxId", async (c: AppContext) => {
	const session = c.get("session");
	if (!session) return c.json({ error: "Unauthorized" }, 401);
	const mailboxId = c.var.authorizedMailboxId;
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await c.env.BUCKET.head(key)))
		return c.json({ error: "Not found" }, 404);
	await mailboxAccess(c.env).deactivateMailbox(session.sub, mailboxId);
	await requireAgentConnectionReconciliation(c.env, {
		mailboxId,
		scope: "MAILBOX",
	});
	return c.body(null, 204);
});

// -- Emails ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const folder = c.req.query("folder");
	const thread_id = c.req.query("thread_id");
	const threaded = boolQuery(c, "threaded");
	const label_id = c.req.query("label_id");
	const page = intQuery(c, "page");
	const limit = intQuery(c, "limit");
	const sortColumn = c.req.query("sortColumn") as any;
	const sortDirection = c.req.query("sortDirection") as
		| "ASC"
		| "DESC"
		| undefined;
	const stub = c.var.mailboxStub;

	if (threaded && folder) {
		const emails = await (stub as any).getThreadedEmails({
			folder,
			label_id,
			page,
			limit,
		});
		const totalCount = await (stub as any).countThreadedEmails(
			folder,
			label_id,
		);
		return c.json({ emails, totalCount });
	}
	const emails = await stub.getEmails({
		folder,
		label_id,
		thread_id,
		page,
		limit,
		sortColumn,
		sortDirection,
	});
	if (folder) {
		const totalCount = await stub.countEmails({ folder, label_id, thread_id });
		return c.json({ emails, totalCount });
	}
	return c.json(emails);
});

app.post("/api/v1/mailboxes/:mailboxId/triage-batch", handleBatchTriage);

app.get("/api/v1/mailboxes/:mailboxId/labels", handleListLabels);
app.post("/api/v1/mailboxes/:mailboxId/labels", handleCreateLabel);
app.put("/api/v1/mailboxes/:mailboxId/labels/:labelId", handleUpdateLabel);
app.delete("/api/v1/mailboxes/:mailboxId/labels/:labelId", handleDeleteLabel);
app.post("/api/v1/mailboxes/:mailboxId/label-mutations", handleMutateLabels);

app.post("/api/v1/mailboxes/:mailboxId/emails", handleSendEmail);

app.post("/api/v1/mailboxes/:mailboxId/drafts", handleSaveDraft);

app.get("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const email = await c.var.mailboxStub.getEmail(c.req.param("id")!);
	if (!email) return c.json({ error: "Email not found" }, 404);
	return new Response(JSON.stringify(email), {
		headers: { "Content-Type": "application/json" },
	});
});

app.put("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const { read, starred } = (await c.req.json()) as {
		read?: boolean;
		starred?: boolean;
	};
	const email = await c.var.mailboxStub.updateEmail(
		c.req.param("id")!,
		{ read, starred },
		actorFromSession(c.get("session")),
	);
	return email ? c.json(email) : c.json({ error: "Email not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/emails/:id", handleDeleteEmail);
app.post("/api/v1/mailboxes/:mailboxId/emails/:id/restore", handleRestoreEmail);
app.delete("/api/v1/mailboxes/:mailboxId/drafts/:id", handleDiscardDraft);

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/move", handleMoveEmail);

// -- Threads --------------------------------------------------------

app.get(
	"/api/v1/mailboxes/:mailboxId/threads/:threadId",
	async (c: AppContext) => {
		return c.json(
			await (c.var.mailboxStub as any).getThreadEmails(
				c.req.param("threadId")!,
			),
		);
	},
);

app.post(
	"/api/v1/mailboxes/:mailboxId/threads/:threadId/read",
	async (c: AppContext) => {
		await c.var.mailboxStub.markThreadRead(
			c.req.param("threadId")!,
			actorFromSession(c.get("session")),
		);
		return c.json({ status: "marked_read" });
	},
);
app.delete(
	"/api/v1/mailboxes/:mailboxId/bulk/operations/:operationId/reservation",
	handleCancelBulkReservation,
);

app.post(
	"/api/v1/mailboxes/:mailboxId/conversations/:conversationId/read",
	handleSetConversationRead,
);
app.post(
	"/api/v1/mailboxes/:mailboxId/conversations/:conversationId/archive",
	handleArchiveConversation,
);
app.post(
	"/api/v1/mailboxes/:mailboxId/conversations/:conversationId/trash",
	handleTrashConversation,
);

// -- Reply / Forward ------------------------------------------------

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/reply", handleReplyEmail);
app.post("/api/v1/mailboxes/:mailboxId/emails/:id/forward", handleForwardEmail);

// -- Truthful Outbox ------------------------------------------------

app.get(
	"/api/v1/mailboxes/:mailboxId/outbound-deliveries",
	handleListOutboundDeliveries,
);
app.get(
	"/api/v1/mailboxes/:mailboxId/outbound-deliveries/:deliveryId",
	handleGetOutboundDelivery,
);
app.post(
	"/api/v1/mailboxes/:mailboxId/outbound-deliveries/:deliveryId/cancel",
	handleCancelOutboundDelivery,
);
app.post(
	"/api/v1/mailboxes/:mailboxId/outbound-deliveries/:deliveryId/retry",
	handleRetryOutboundDelivery,
);

// -- Bulk send (mail merge, F-06) -----------------------------------

app.post("/api/v1/mailboxes/:mailboxId/bulk", handleCreateBulkJob);
app.post(
	"/api/v1/mailboxes/:mailboxId/bulk/operations/:operationId/reserve",
	handleReserveBulkOperation,
);
app.get(
	"/api/v1/mailboxes/:mailboxId/bulk/operations/:operationId",
	handleRecoverBulkOperation,
);
app.get("/api/v1/mailboxes/:mailboxId/bulk/:jobId", handleGetBulkJob);

// -- Folders --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) =>
	c.json(await c.var.mailboxStub.getFolders()),
);

app.post("/api/v1/mailboxes/:mailboxId/folders", handleCreateFolder);

app.put("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const f = await c.var.mailboxStub.updateFolder(c.req.param("id")!, name);
	return f ? c.json(f) : c.json({ error: "Folder not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/folders/:id", handleDeleteFolder);

export { app };
