// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import PostalMime from "postal-mime";
import { z } from "zod";
import { sendEmail } from "./email-sender";
import { storeAttachments, type StoredAttachment } from "./lib/attachments";
import {
	validateSender,
	SenderValidationError,
	generateMessageId,
	buildThreadingHeaders,
	listMailboxes as listR2Mailboxes,
} from "./lib/email-helpers";
import { SendEmailRequestSchema } from "./lib/schemas";
import { handleReplyEmail, handleForwardEmail } from "./routes/reply-forward";
import { Folders } from "../shared/folders";
import type { Env } from "./types";
import {
	getRequiredUser,
	requireActiveUser,
	requireGlobalAdmin,
	requireMailboxPermission,
	type AppContext as HonoAppContext,
} from "./lib/auth";
import { generateAiDraft } from "./lib/ai-draft";
import {
	createTemplate,
	deleteMailboxMembership,
	deleteTemplate,
	ensureAppSchemaOnce,
	getAiMailboxSettings,
	getMailboxRecord,
	getTemplate,
	listMailboxMemberships,
	listMailboxesForUser,
	listTemplates,
	listUsers,
	nowIso,
	recordAiGeneration,
	registerIdentityUser,
	resolveCurrentUser,
	updateAiMailboxSettings,
	updateTemplate,
	updateUser,
	upsertMailboxMembership,
	upsertMailboxRecord,
} from "./lib/app-db";
import { canGenerateAiDraft, getCapabilitiesForRole } from "./lib/permissions";

type AppContext = Context<HonoAppContext>;

// -- Request body schemas (kept for validation) ---------------------

const CreateMailboxBody = z.object({
	email: z.string().email(),
	name: z.string().min(1),
	settings: z.record(z.unknown()).optional(),
});

const DraftBody = z.object({
	to: z.string().optional(),
	cc: z.string().optional(),
	bcc: z.string().optional(),
	subject: z.string().optional(),
	body: z.string(),
	in_reply_to: z.string().optional(),
	thread_id: z.string().optional(),
	draft_id: z.string().optional(),
});

const UpdateUserBody = z.object({
	status: z.enum(["pending", "active", "disabled"]).optional(),
	globalRole: z.enum(["admin", "none"]).optional(),
	displayName: z.string().trim().min(1).nullable().optional(),
});

const MembershipBody = z.object({
	role: z.enum(["manager", "responder", "viewer"]),
});

const TemplateBody = z.object({
	name: z.string().trim().min(1),
	subject: z.string().optional(),
	bodyHtml: z.string().min(1),
	bodyText: z.string().nullable().optional(),
});

const AiSettingsBody = z.object({
	enabled: z.boolean(),
	model: z.string().trim().min(1).nullable().optional(),
	systemPrompt: z.string().trim().min(1).nullable().optional(),
});

const AiDraftBody = z.object({
	templateId: z.string().optional(),
});

// -- Helpers --------------------------------------------------------

function slugify(text: string) { // can return "" for non-alphanumeric input
	return text.toString().toLowerCase()
		.replace(/\s+/g, "-").replace(/[^\w-]+/g, "")
		.replace(/--+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
}

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

function defaultMailboxSettings(name: string) {
	return {
		fromName: name,
		forwarding: { enabled: false, email: "" },
		signature: { enabled: false, text: "" },
		autoReply: { enabled: false, subject: "", message: "" },
	};
}

async function syncR2MailboxesToD1(env: Env) {
	const now = nowIso();
	const mailboxes = await listR2Mailboxes(env.BUCKET);
	for (const mailbox of mailboxes) {
		const localPart = mailbox.email.split("@")[0] || mailbox.email;
		await upsertMailboxRecord(env.APP_DB, {
			email: mailbox.email,
			name: localPart,
			status: "active",
		}, now);
	}
}

// -- App & middleware -----------------------------------------------

const app = new Hono<HonoAppContext>();
app.use("/api/*", cors({
	origin: (origin) => {
		// Same-origin requests have no Origin header — allow them.
		if (!origin) return origin;
		// In development, allow localhost for Vite dev server.
		try {
			const url = new URL(origin);
			if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return origin;
		} catch { /* invalid origin */ }
		// Block all other cross-origin requests. The app is served from the
		// same origin as the API, so legitimate browser requests never send
		// an Origin header. Returning undefined omits Access-Control-Allow-Origin.
		return undefined;
	},
}));

// -- Config ---------------------------------------------------------

app.get("/api/v1/config", (c) => {
	const domainsRaw = c.env.DOMAINS || "";
	const domains = domainsRaw.split(",").map((d) => d.trim()).filter(Boolean);
	const emailAddresses = c.env.EMAIL_ADDRESSES ?? [];
	return c.json({ domains, emailAddresses });
});

// -- Current user / registration ------------------------------------

app.get("/api/v1/me", async (c) => {
	await ensureAppSchemaOnce(c.env.APP_DB);
	const identity = c.var.accessIdentity;
	if (!identity) return c.json({ error: "Missing Access identity" }, 403);
	const user = await resolveCurrentUser(c.env.APP_DB, identity, nowIso());
	return c.json({
		identity,
		user,
		registrationStatus: user?.status ?? "unregistered",
	});
});

app.post("/api/v1/register", async (c) => {
	await ensureAppSchemaOnce(c.env.APP_DB);
	const identity = c.var.accessIdentity;
	if (!identity) return c.json({ error: "Missing Access identity" }, 403);
	const user = await registerIdentityUser(c.env.APP_DB, identity, nowIso());
	return c.json({
		identity,
		user,
		registrationStatus: user.status,
	}, user.status === "pending" ? 202 : 200);
});

app.use("/api/v1/*", requireActiveUser);

// -- Admin -----------------------------------------------------------

app.get("/api/v1/admin/users", requireGlobalAdmin, async (c) => {
	return c.json(await listUsers(c.env.APP_DB));
});

app.patch("/api/v1/admin/users/:userId", requireGlobalAdmin, async (c) => {
	const user = await updateUser(
		c.env.APP_DB,
		c.req.param("userId")!,
		UpdateUserBody.parse(await c.req.json()),
		nowIso(),
	);
	return user ? c.json(user) : c.json({ error: "User not found" }, 404);
});

// -- Mailboxes ------------------------------------------------------

app.get("/api/v1/mailboxes", async (c) => {
	const user = getRequiredUser(c);
	if (user.globalRole === "admin") await syncR2MailboxesToD1(c.env);
	const allMailboxes = await listMailboxesForUser(c.env.APP_DB, user);
	return c.json(allMailboxes.map((m) => ({
		id: m.id,
		email: m.email,
		name: m.name,
		role: m.role,
		capabilities: m.capabilities,
	})));
});

app.post("/api/v1/mailboxes", requireGlobalAdmin, async (c) => {
	const { name, settings, email: rawEmail } = CreateMailboxBody.parse(await c.req.json());
	const email = rawEmail.toLowerCase();
	const key = `mailboxes/${email}.json`;
	if (await c.env.BUCKET.head(key)) return c.json({ error: "Mailbox already exists" }, 409);
	const finalSettings = { ...defaultMailboxSettings(name), ...settings };
	await c.env.BUCKET.put(key, JSON.stringify(finalSettings));
	const mailbox = await upsertMailboxRecord(c.env.APP_DB, { email, name, status: "active" }, nowIso());
	const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(email));
	await stub.getFolders();
	return c.json({
		...mailbox,
		settings: finalSettings,
		role: "admin",
		capabilities: getCapabilitiesForRole("admin"),
	}, 201);
});

app.get("/api/v1/mailboxes/:mailboxId", requireMailboxPermission("readMail"), async (c) => {
	const mailboxId = c.var.mailboxAccess.id;
	const obj = await c.env.BUCKET.get(`mailboxes/${mailboxId}.json`);
	if (!obj) return c.json({ error: "Not found" }, 404);
	return c.json({
		id: mailboxId,
		name: c.var.mailboxAccess.name,
		email: c.var.mailboxAccess.email,
		settings: await obj.json(),
		role: c.var.mailboxAccess.role,
		capabilities: c.var.mailboxAccess.capabilities,
	});
});

app.put("/api/v1/mailboxes/:mailboxId", requireMailboxPermission("manageMailbox"), async (c) => {
	const mailboxId = c.var.mailboxAccess.id;
	const { settings } = (await c.req.json()) as { settings: Record<string, unknown> };
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await c.env.BUCKET.head(key))) return c.json({ error: "Not found" }, 404);
	await c.env.BUCKET.put(key, JSON.stringify(settings));
	return c.json({
		id: mailboxId,
		name: c.var.mailboxAccess.name,
		email: c.var.mailboxAccess.email,
		settings,
		role: c.var.mailboxAccess.role,
		capabilities: c.var.mailboxAccess.capabilities,
	});
});

app.delete("/api/v1/mailboxes/:mailboxId", requireGlobalAdmin, requireMailboxPermission("manageMailbox"), async (c) => {
	const mailboxId = c.var.mailboxAccess.id;
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await c.env.BUCKET.head(key))) return c.json({ error: "Not found" }, 404);
	await upsertMailboxRecord(c.env.APP_DB, {
		email: mailboxId,
		name: c.var.mailboxAccess.name,
		status: "disabled",
	}, nowIso());
	await c.env.BUCKET.delete(key);
	return c.body(null, 204);
});

app.get("/api/v1/mailboxes/:mailboxId/memberships", requireMailboxPermission("manageMembers"), async (c) => {
	return c.json(await listMailboxMemberships(c.env.APP_DB, c.var.mailboxAccess.id));
});

app.put("/api/v1/mailboxes/:mailboxId/memberships/:userId", requireMailboxPermission("manageMembers"), async (c) => {
	const { role } = MembershipBody.parse(await c.req.json());
	const membership = await upsertMailboxMembership(
		c.env.APP_DB,
		c.var.mailboxAccess.id,
		decodeURIComponent(c.req.param("userId")!),
		role,
		nowIso(),
	);
	return membership ? c.json(membership) : c.json({ error: "User or mailbox not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/memberships/:userId", requireMailboxPermission("manageMembers"), async (c) => {
	const ok = await deleteMailboxMembership(
		c.env.APP_DB,
		c.var.mailboxAccess.id,
		decodeURIComponent(c.req.param("userId")!),
	);
	return ok ? c.body(null, 204) : c.json({ error: "Membership not found" }, 404);
});

app.get("/api/v1/mailboxes/:mailboxId/templates", requireMailboxPermission("useTemplates"), async (c) => {
	return c.json(await listTemplates(c.env.APP_DB, c.var.mailboxAccess.id));
});

app.post("/api/v1/mailboxes/:mailboxId/templates", requireMailboxPermission("manageTemplates"), async (c) => {
	const template = await createTemplate(
		c.env.APP_DB,
		c.var.mailboxAccess.id,
		c.var.currentUser.id,
		TemplateBody.parse(await c.req.json()),
		nowIso(),
	);
	return c.json(template, 201);
});

app.put("/api/v1/mailboxes/:mailboxId/templates/:templateId", requireMailboxPermission("manageTemplates"), async (c) => {
	const template = await updateTemplate(
		c.env.APP_DB,
		c.var.mailboxAccess.id,
		c.req.param("templateId")!,
		c.var.currentUser.id,
		TemplateBody.parse(await c.req.json()),
		nowIso(),
	);
	return template ? c.json(template) : c.json({ error: "Template not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/templates/:templateId", requireMailboxPermission("manageTemplates"), async (c) => {
	const ok = await deleteTemplate(c.env.APP_DB, c.var.mailboxAccess.id, c.req.param("templateId")!);
	return ok ? c.body(null, 204) : c.json({ error: "Template not found" }, 404);
});

app.get("/api/v1/mailboxes/:mailboxId/ai-settings", requireMailboxPermission("readMail"), async (c) => {
	return c.json(await getAiMailboxSettings(c.env.APP_DB, c.var.mailboxAccess.id));
});

app.put("/api/v1/mailboxes/:mailboxId/ai-settings", requireMailboxPermission("manageAi"), async (c) => {
	const settings = await updateAiMailboxSettings(
		c.env.APP_DB,
		c.var.mailboxAccess.id,
		c.var.currentUser.id,
		AiSettingsBody.parse(await c.req.json()),
		nowIso(),
	);
	return c.json(settings);
});

// -- Emails ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails", requireMailboxPermission("readMail"), async (c: AppContext) => {
	const folder = c.req.query("folder");
	const thread_id = c.req.query("thread_id");
	const threaded = boolQuery(c, "threaded");
	const page = intQuery(c, "page");
	const limit = intQuery(c, "limit");
	const sortColumn = c.req.query("sortColumn") as any;
	const sortDirection = c.req.query("sortDirection") as "ASC" | "DESC" | undefined;
	const stub = c.var.mailboxStub;

	if (threaded && folder) {
		const emails = await (stub as any).getThreadedEmails({ folder, page, limit });
		const totalCount = await (stub as any).countThreadedEmails(folder);
		return c.json({ emails, totalCount });
	}
	const emails = await stub.getEmails({ folder, thread_id, page, limit, sortColumn, sortDirection });
	if (folder) {
		const totalCount = await stub.countEmails({ folder, thread_id });
		return c.json({ emails, totalCount });
	}
	return c.json(emails);
});

app.post("/api/v1/mailboxes/:mailboxId/emails", requireMailboxPermission("sendMail"), async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const body = SendEmailRequestSchema.parse(await c.req.json());
	const { to, cc, bcc, from, subject, html, text, attachments, in_reply_to, references, thread_id } = body;

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);
	const stub = c.var.mailboxStub;
	const rateLimitError = await (stub as any).checkSendRateLimit();
	if (rateLimitError) return c.json({ error: rateLimitError }, 429);
	const attachmentData = await storeAttachments(c.env.BUCKET, messageId, attachments);

	await stub.createEmail(Folders.SENT, {
		id: messageId, subject, sender: fromEmail, recipient: toStr,
		cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
		bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null,
		date: new Date().toISOString(), body: html || text || "",
		in_reply_to: in_reply_to || null, email_references: references ? JSON.stringify(references) : null,
		thread_id: thread_id || in_reply_to || messageId, message_id: outgoingMessageId,
		raw_headers: JSON.stringify([
			{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
			{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
			...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
			...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
			{ key: "subject", value: subject }, { key: "date", value: new Date().toISOString() },
			{ key: "message-id", value: `<${outgoingMessageId}>` },
		]),
	}, attachmentData);

	c.executionCtx.waitUntil(
		sendEmail(c.env.EMAIL, {
			to, cc, bcc, from, subject, html, text,
			attachments: attachments?.map((att) => ({ content: att.content, filename: att.filename, type: att.type, disposition: att.disposition || "attachment", contentId: att.contentId })),
			...(in_reply_to ? { headers: buildThreadingHeaders(in_reply_to, references || []) } : {}),
		}).catch((e) => console.error("Deferred email delivery failed:", (e as Error).message)),
	);
	return c.json({ id: messageId, status: "sent" }, 202);
});

app.post("/api/v1/mailboxes/:mailboxId/drafts", requireMailboxPermission("sendMail"), async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { to, cc, bcc, subject, body, in_reply_to, thread_id, draft_id } = DraftBody.parse(await c.req.json());
	const stub = c.var.mailboxStub;
	if (draft_id) await stub.deleteEmail(draft_id); // not atomic — create-then-delete would be safer
	const messageId = crypto.randomUUID();
	const now = new Date().toISOString();
	await stub.createEmail(Folders.DRAFT, {
		id: messageId, subject: subject || "", sender: mailboxId.toLowerCase(),
		recipient: (to || "").toLowerCase(), cc: cc?.toLowerCase() || null, bcc: bcc?.toLowerCase() || null,
		date: now, body, in_reply_to: in_reply_to || null, email_references: null,
		thread_id: thread_id || in_reply_to || messageId,
	}, []);
	return c.json({ id: messageId, status: "draft", subject: subject || "", recipient: to || "", date: now }, 201);
});

app.get("/api/v1/mailboxes/:mailboxId/emails/:id", requireMailboxPermission("readMail"), async (c: AppContext) => {
	const email = await c.var.mailboxStub.getEmail(c.req.param("id")!);
	if (!email) return c.json({ error: "Email not found" }, 404);
	return new Response(JSON.stringify(email), {
		headers: { "Content-Type": "application/json" },
	});
});

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/ai-draft", requireMailboxPermission("sendMail"), async (c: AppContext) => {
	const { templateId } = AiDraftBody.parse(await c.req.json().catch(() => ({})));
	const settings = await getAiMailboxSettings(c.env.APP_DB, c.var.mailboxAccess.id);
	if (!canGenerateAiDraft(c.var.mailboxAccess.capabilities, settings)) {
		return c.json({ error: "AI drafting is not enabled for this mailbox or role" }, 403);
	}

	const email = await c.var.mailboxStub.getEmail(c.req.param("id")!);
	if (!email) return c.json({ error: "Email not found" }, 404);

	const template = templateId
		? await getTemplate(c.env.APP_DB, c.var.mailboxAccess.id, templateId)
		: null;
	if (templateId && !template) return c.json({ error: "Template not found" }, 404);

	const draft = await generateAiDraft(c.env, {
		email,
		mailboxEmail: c.var.mailboxAccess.email,
		template,
		settings,
	});
	await recordAiGeneration(c.env.APP_DB, {
		mailboxId: c.var.mailboxAccess.id,
		emailId: c.req.param("id")!,
		userId: c.var.currentUser.id,
		model: draft.model,
		templateId: template?.id ?? null,
	}, nowIso());
	return c.json(draft);
});

app.put("/api/v1/mailboxes/:mailboxId/emails/:id", requireMailboxPermission("mutateMail"), async (c: AppContext) => {
	const { read, starred } = (await c.req.json()) as { read?: boolean; starred?: boolean };
	const email = await c.var.mailboxStub.updateEmail(c.req.param("id")!, { read, starred });
	return email ? c.json(email) : c.json({ error: "Email not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/emails/:id", requireMailboxPermission("mutateMail"), async (c: AppContext) => {
	const id = c.req.param("id")!;
	const attachments = await c.var.mailboxStub.deleteEmail(id);
	if (attachments === null) return c.json({ error: "Not found" }, 404);
	if (attachments.length > 0) await c.env.BUCKET.delete(attachments.map((att: any) => `attachments/${id}/${att.id}/${att.filename}`));
	return c.body(null, 204);
});

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/move", requireMailboxPermission("mutateMail"), async (c: AppContext) => {
	const { folderId } = (await c.req.json()) as { folderId: string };
	const success = await c.var.mailboxStub.moveEmail(c.req.param("id")!, folderId);
	return success ? c.json({ status: "moved" }) : c.json({ error: "Folder not found" }, 400);
});

// -- Threads --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/threads/:threadId", requireMailboxPermission("readMail"), async (c: AppContext) => {
	return c.json(await (c.var.mailboxStub as any).getThreadEmails(c.req.param("threadId")!));
});

app.post("/api/v1/mailboxes/:mailboxId/threads/:threadId/read", requireMailboxPermission("mutateMail"), async (c: AppContext) => {
	await c.var.mailboxStub.markThreadRead(c.req.param("threadId")!);
	return c.json({ status: "marked_read" });
});

// -- Reply / Forward ------------------------------------------------

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/reply", requireMailboxPermission("sendMail"), handleReplyEmail);
app.post("/api/v1/mailboxes/:mailboxId/emails/:id/forward", requireMailboxPermission("sendMail"), handleForwardEmail);

// -- Folders --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/folders", requireMailboxPermission("readMail"), async (c: AppContext) => c.json(await c.var.mailboxStub.getFolders()));

app.post("/api/v1/mailboxes/:mailboxId/folders", requireMailboxPermission("manageMailbox"), async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const slug = slugify(name);
	if (!slug) return c.json({ error: "Folder name must contain alphanumeric characters" }, 400);
	const f = await c.var.mailboxStub.createFolder(slug, name);
	return f ? c.json(f, 201) : c.json({ error: "Folder with this name already exists" }, 409);
});

app.put("/api/v1/mailboxes/:mailboxId/folders/:id", requireMailboxPermission("manageMailbox"), async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const f = await c.var.mailboxStub.updateFolder(c.req.param("id")!, name);
	return f ? c.json(f) : c.json({ error: "Folder not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/folders/:id", requireMailboxPermission("manageMailbox"), async (c: AppContext) => {
	const ok = await c.var.mailboxStub.deleteFolder(c.req.param("id")!);
	return ok ? c.body(null, 204) : c.json({ error: "Folder not found or cannot be deleted" }, 400);
});

// -- Search ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/search", requireMailboxPermission("readMail"), async (c: AppContext) => {
	const searchOpts: Record<string, unknown> = {
		query: c.req.query("query") || "", folder: c.req.query("folder"), from: c.req.query("from"),
		to: c.req.query("to"), subject: c.req.query("subject"), date_start: c.req.query("date_start"),
		date_end: c.req.query("date_end"), is_read: boolQuery(c, "is_read"),
		is_starred: boolQuery(c, "is_starred"), has_attachment: boolQuery(c, "has_attachment"),
	};
	const stub = c.var.mailboxStub as any;
	const emails = await stub.searchEmails({ ...searchOpts, page: intQuery(c, "page"), limit: intQuery(c, "limit") });
	const totalCount = await stub.countSearchResults(searchOpts);
	return c.json({ emails, totalCount });
});

// -- Attachments ----------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails/:emailId/attachments/:attachmentId", requireMailboxPermission("readMail"), async (c: AppContext) => {
	const emailId = c.req.param("emailId")!;
	const attachmentId = c.req.param("attachmentId")!;
	const attachment = await c.var.mailboxStub.getAttachment(attachmentId);
	if (!attachment) return c.json({ error: "Attachment not found" }, 404);
	const obj = await c.env.BUCKET.get(`attachments/${emailId}/${attachmentId}/${attachment.filename}`);
	if (!obj) return c.json({ error: "Attachment file not found" }, 404);
	const headers = new Headers();
	headers.set("Content-Type", attachment.mimetype);
	const sanitized = attachment.filename.replace(/[\x00-\x1f"\\]/g, "_");
	headers.set("Content-Disposition", `attachment; filename="${sanitized}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
	return new Response(obj.body, { headers });
});

// -- Receive inbound email ------------------------------------------

const MAX_EMAIL_SIZE = 25 * 1024 * 1024;

async function streamToArrayBuffer(stream: ReadableStream, streamSize: number) {
	if (streamSize > MAX_EMAIL_SIZE) throw new Error(`Email too large: ${streamSize} bytes exceeds ${MAX_EMAIL_SIZE} byte limit`);
	if (streamSize <= 0) throw new Error(`Invalid stream size: ${streamSize}`);
	const result = new Uint8Array(streamSize);
	let bytesRead = 0;
	const reader = stream.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (bytesRead + value.length > streamSize) { reader.cancel(); throw new Error(`Stream exceeds declared size`); }
		result.set(value, bytesRead);
		bytesRead += value.length;
	}
	return result;
}

async function receiveEmail(event: { raw: ReadableStream; rawSize: number }, env: Env) {
	await ensureAppSchemaOnce(env.APP_DB);
	const rawEmail = await streamToArrayBuffer(event.raw, event.rawSize);
	const parsedEmail = await new PostalMime().parse(rawEmail);

	if (!parsedEmail.to?.length || !parsedEmail.to[0].address) throw new Error("received email with empty to");

	const allowedAddresses = ((env.EMAIL_ADDRESSES ?? []) as string[]).map((a) => a.toLowerCase());
	const allRecipients = parsedEmail.to.map((t) => t.address?.toLowerCase()).filter(Boolean) as string[];
	const ccRecipients = (parsedEmail.cc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];
	const bccRecipients = (parsedEmail.bcc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];

	let mailboxId: string | undefined;
	if (allowedAddresses.length > 0) {
		mailboxId = allRecipients.find((addr) => allowedAddresses.includes(addr));
		if (!mailboxId) { console.log(`Ignoring email: no recipient matches EMAIL_ADDRESSES.`); return; }
	} else { mailboxId = allRecipients[0]; }
	if (!mailboxId) throw new Error("received email with no valid recipient address");

	const messageId = crypto.randomUUID();
	const mailbox = await getMailboxRecord(env.APP_DB, mailboxId);
	if (!mailbox) { console.log(`Ignoring email for ${mailboxId}: mailbox is not active in APP_DB`); return; }
	if (!(await env.BUCKET.head(`mailboxes/${mailboxId}.json`))) { console.log(`Ignoring email for ${mailboxId}: mailbox does not exist`); return; }

	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));

	const attachmentData: StoredAttachment[] = [];
	if (parsedEmail.attachments) {
		for (const att of parsedEmail.attachments) {
			const attId = crypto.randomUUID();
			const filename = (att.filename || "untitled").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
			await env.BUCKET.put(`attachments/${messageId}/${attId}/${filename}`, att.content);
			attachmentData.push({ id: attId, email_id: messageId, filename, mimetype: att.mimeType,
				size: typeof att.content === "string" ? att.content.length : att.content.byteLength,
				content_id: att.contentId || null, disposition: att.disposition || "attachment" });
		}
	}

	const extractMsgId = (s: string) => { const m = s.match(/<([^>]+)>/); return m ? m[1] : s.trim().split(/\s+/)[0]; };
	const inReplyTo = parsedEmail.inReplyTo ? extractMsgId(parsedEmail.inReplyTo) : null;
	const emailReferences = parsedEmail.references ? parsedEmail.references.split(/\s+/).filter(Boolean).map(extractMsgId) : [];
	let threadId = emailReferences[0] || inReplyTo || messageId;

	if (!inReplyTo && emailReferences.length === 0) {
		const subjectThread = await (stub as any).findThreadBySubject(parsedEmail.subject || "", parsedEmail.from?.address || undefined);
		if (subjectThread) threadId = subjectThread;
	}

	const originalMessageId = parsedEmail.messageId ? extractMsgId(parsedEmail.messageId) : null;

	await stub.createEmail(Folders.INBOX, {
		id: messageId, subject: parsedEmail.subject || "",
		sender: (parsedEmail.from?.address || "").toLowerCase(), recipient: allRecipients.join(", "),
		cc: ccRecipients.join(", ") || null, bcc: bccRecipients.join(", ") || null,
		date: new Date().toISOString(), // uses receive time, not the email's Date header
		body: parsedEmail.html || parsedEmail.text || "",
		in_reply_to: inReplyTo, email_references: emailReferences.length > 0 ? JSON.stringify(emailReferences) : null,
		thread_id: threadId, message_id: originalMessageId, raw_headers: JSON.stringify(parsedEmail.headers),
	}, attachmentData);

}

export { app, receiveEmail };
