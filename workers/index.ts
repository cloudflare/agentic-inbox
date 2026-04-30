// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import PostalMime from "postal-mime";
import { z } from "zod";
import { sendEmail } from "./email-sender";
import { attachmentObjectKey, storeAttachments, type StoredAttachment } from "./lib/attachments";
import {
	validateSender,
	SenderValidationError,
	generateMessageId,
	buildThreadingHeaders,
	listMailboxes,
} from "./lib/email-helpers";
import { SendEmailRequestSchema } from "./lib/schemas";
import { handleReplyEmail, handleForwardEmail } from "./routes/reply-forward";
import { Folders } from "../shared/folders";
import type { Env } from "./types";
import { requireMailbox, type MailboxContext } from "./lib/mailbox";
import { getMailboxSettings } from "./lib/mailbox-settings";
import { runSecurityPipeline } from "./security";
import { runDeepScan } from "./intel/deep-scan";
import { getSecuritySettings } from "./security/settings";
import { isDmarcReport, ingestDmarcReport } from "./dmarc/ingest";
import { dmarcRoutes } from "./routes/dmarc";
import { caseRoutes } from "./routes/cases";
import { hubUiRoutes } from "./routes/hub-ui";
import {
	bucketThreatPressure,
	pipelineSuccessRate,
} from "./lib/dashboard-aggregation";

type AppContext = Context<MailboxContext>;

// -- Request body schemas (kept for validation) ---------------------

const CreateMailboxBody = z.object({
	email: z.string().email(),
	name: z.string().min(1),
	settings: z.record(z.any()).optional(), // unvalidated — agentSystemPrompt goes straight to AI
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

// -- App & middleware -----------------------------------------------

const app = new Hono<MailboxContext>();
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
app.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox);

// -- Config ---------------------------------------------------------

app.route("/api/v1/mailboxes/:mailboxId/dmarc", dmarcRoutes);
app.route("/api/v1/mailboxes/:mailboxId/cases", caseRoutes);
app.route("/api/v1/mailboxes/:mailboxId/hub", hubUiRoutes);

app.get("/api/v1/config", (c) => {
	const domainsRaw = c.env.DOMAINS || "";
	const domains = domainsRaw.split(",").map((d) => d.trim()).filter(Boolean);
	const emailAddresses = c.env.EMAIL_ADDRESSES ?? [];
	return c.json({ domains, emailAddresses });
});

// -- Mailboxes ------------------------------------------------------

app.get("/api/v1/mailboxes", async (c) => {
	const allMailboxes = await listMailboxes(c.env.BUCKET);
	return c.json(allMailboxes.map((m) => ({ ...m, name: m.id })));
});

app.post("/api/v1/mailboxes", async (c) => {
	const { name, settings, email: rawEmail } = CreateMailboxBody.parse(await c.req.json());
	const email = rawEmail.toLowerCase();
	const allowedAddresses = (c.env.EMAIL_ADDRESSES ?? []) as string[];
	if (allowedAddresses.length > 0 && !allowedAddresses.map((a) => a.toLowerCase()).includes(email)) {
		return c.json({ error: "Mailbox creation is restricted to configured EMAIL_ADDRESSES" }, 403);
	}
	const key = `mailboxes/${email}.json`;
	if (await c.env.BUCKET.head(key)) return c.json({ error: "Mailbox already exists" }, 409);
	const defaultSettings = { fromName: name, forwarding: { enabled: false, email: "" }, signature: { enabled: false, text: "" }, autoReply: { enabled: false, subject: "", message: "" } };
	const finalSettings = { ...defaultSettings, ...settings };
	await c.env.BUCKET.put(key, JSON.stringify(finalSettings));
	const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(email));
	await stub.getFolders();
	return c.json({ id: email, email, name, settings: finalSettings }, 201);
});

app.get("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const obj = await c.env.BUCKET.get(`mailboxes/${mailboxId}.json`);
	if (!obj) return c.json({ error: "Not found" }, 404);
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings: await obj.json() });
});

app.get("/api/v1/mailboxes/:mailboxId/dashboard", async (c: AppContext) => {
	const raw = await c.var.mailboxStub.getDashboardSummary();
	const threatPressure = bucketThreatPressure(raw.verdictRows);
	const pipelineSuccess = pipelineSuccessRate(raw.pipelineScan);
	return c.json({
		now: raw.now,
		threatsBlocked: raw.threatsBlocked,
		openCases: raw.openCases,
		hubContributions: raw.hubContributions,
		pipelineSuccess,
		threatPressure,
		recentCases: raw.recentCases,
	});
});

// Realtime event stream. Browsers can't set custom headers on `new
// WebSocket()`, so auth piggybacks on the `cf-access-jwt-assertion` header
// the CF Access edge injects on all origin requests (including Upgrade)
// when the user's session is valid. The `*` middleware in workers/app.ts
// validates that header before this route is reached.
app.get("/api/v1/mailboxes/:mailboxId/events", async (c) => {
	if (c.req.header("Upgrade") !== "websocket") {
		return c.text("Expected WebSocket upgrade", 426);
	}
	return c.var.mailboxStub.fetch(c.req.raw);
});

app.put("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { settings } = (await c.req.json()) as { settings: Record<string, unknown> };
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await c.env.BUCKET.head(key))) return c.json({ error: "Not found" }, 404);
	await c.env.BUCKET.put(key, JSON.stringify(settings));
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings });
});

app.delete("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await c.env.BUCKET.head(key))) return c.json({ error: "Not found" }, 404);

	// Settings-first delete. Removing the settings JSON makes the mailbox
	// invisible to every list/get endpoint immediately, and a DELETE retry
	// after partial failure is now idempotent: the next `head()` returns
	// null and we 404 cleanly. The heavier reap (R2 attachments + DO wipe)
	// runs in the background via waitUntil — orphaned rows/blobs are a
	// cleanup cost, never a correctness bug.
	await c.env.BUCKET.delete(key);
	c.executionCtx.waitUntil(reapMailbox(c.env, mailboxId));
	return c.body(null, 204);
});

/** Upper bound on R2 delete batch size. The Workers R2 binding accepts up
 *  to 1000 keys per call, but each call still consumes subrequest budget —
 *  100 keeps us well inside both the per-request subrequest cap and
 *  `reapMailbox`'s overall budget on mailboxes with long history. */
const R2_DELETE_BATCH = 100;

/**
 * Best-effort cleanup for a deleted mailbox. Every step is isolated in its
 * own try/catch so a partial failure (e.g. the DO being unreachable for a
 * few seconds) never cancels the remaining steps. None of these errors
 * propagate to the user — the settings JSON was already removed so the
 * mailbox is effectively gone from the product's point of view.
 */
async function reapMailbox(env: Env, mailboxId: string): Promise<void> {
	const mbStub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
	const agentStub = env.EMAIL_AGENT.get(env.EMAIL_AGENT.idFromName(mailboxId));

	// 1. Enumerate attachment keys BEFORE the DO wipe. After deleteAll(),
	//    the attachments table is the only place these keys live, so we
	//    must list them first or accept orphans in R2 forever.
	let keys: string[] = [];
	try {
		keys = await (mbStub as any).listAllAttachmentKeys();
	} catch (e) {
		console.error(`reapMailbox(${mailboxId}): listAllAttachmentKeys failed:`, (e as Error).message);
	}

	// 2. Batched R2 deletes. Each batch is its own try/catch so one failed
	//    chunk doesn't abandon the rest — the alternative is leaving the
	//    bulk of the blobs stranded because the first batch tripped a
	//    transient error.
	for (let i = 0; i < keys.length; i += R2_DELETE_BATCH) {
		try {
			await env.BUCKET.delete(keys.slice(i, i + R2_DELETE_BATCH));
		} catch (e) {
			console.error(`reapMailbox(${mailboxId}): R2 batch delete failed at offset ${i}:`, (e as Error).message);
		}
	}

	// 3. Wipe both DOs. Safe to do after the R2 reap because neither
	//    bucket read nor bucket delete depended on DO state at this point.
	await (mbStub as any).reset().catch(
		(e: Error) => console.error(`reapMailbox(${mailboxId}): mailbox DO reset failed:`, e.message),
	);
	await (agentStub as any).reset().catch(
		(e: Error) => console.error(`reapMailbox(${mailboxId}): agent DO reset failed:`, e.message),
	);
}

// -- Emails ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
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

app.post("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
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

app.post("/api/v1/mailboxes/:mailboxId/drafts", async (c: AppContext) => {
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

app.get("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const email = await c.var.mailboxStub.getEmail(c.req.param("id")!);
	if (!email) return c.json({ error: "Email not found" }, 404);
	return new Response(JSON.stringify(email), {
		headers: { "Content-Type": "application/json" },
	});
});

app.put("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const { read, starred } = (await c.req.json()) as { read?: boolean; starred?: boolean };
	const email = await c.var.mailboxStub.updateEmail(c.req.param("id")!, { read, starred });
	return email ? c.json(email) : c.json({ error: "Email not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const id = c.req.param("id")!;
	const attachments = await c.var.mailboxStub.deleteEmail(id);
	if (attachments === null) return c.json({ error: "Not found" }, 404);
	if (attachments.length > 0) await c.env.BUCKET.delete(attachments.map((att: any) => attachmentObjectKey(id, att.id, att.filename)));
	return c.body(null, 204);
});

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/move", async (c: AppContext) => {
	const { folderId } = (await c.req.json()) as { folderId: string };
	const emailId = c.req.param("id")!;
	const mailboxId = c.req.param("mailboxId")!;

	// Snapshot the email's pre-move state so the "treat_as_verified" hook
	// below can decide based on the *folder transition*, not just the
	// destination. This keeps the sender-reputation bump idempotent: moving
	// out of and back into a verified folder does not double-count.
	const before = await c.var.mailboxStub.getEmail(emailId);

	const success = await c.var.mailboxStub.moveEmail(emailId, folderId);
	if (!success) return c.json({ error: "Folder not found" }, 400);

	// Per-folder `treat_as_verified` hook. When the user moves a message
	// INTO a verified folder from a non-verified folder, bump the sender's
	// reputation with a favourable score (0). Best-effort — never fail the
	// move because of a reputation write.
	if (before?.sender) {
		try {
			const settings = await getSecuritySettings(c.env, mailboxId);
			const destPolicy = settings.folder_policies?.[folderId];
			const srcPolicy = before.folder_id ? settings.folder_policies?.[before.folder_id] : undefined;
			if (destPolicy?.treat_as_verified && !srcPolicy?.treat_as_verified) {
				await c.var.mailboxStub.upsertSenderReputation(before.sender, 0);
			}
		} catch (e) {
			console.error("treat_as_verified reputation bump failed:", (e as Error).message);
		}
	}

	return c.json({ status: "moved" });
});

// -- Threads --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/threads/:threadId", async (c: AppContext) => {
	return c.json(await (c.var.mailboxStub as any).getThreadEmails(c.req.param("threadId")!));
});

app.post("/api/v1/mailboxes/:mailboxId/threads/:threadId/read", async (c: AppContext) => {
	await c.var.mailboxStub.markThreadRead(c.req.param("threadId")!);
	return c.json({ status: "marked_read" });
});

// -- Reply / Forward ------------------------------------------------

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/reply", handleReplyEmail);
app.post("/api/v1/mailboxes/:mailboxId/emails/:id/forward", handleForwardEmail);

// -- Folders --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => c.json(await c.var.mailboxStub.getFolders()));

app.post("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const slug = slugify(name);
	if (!slug) return c.json({ error: "Folder name must contain alphanumeric characters" }, 400);
	const f = await c.var.mailboxStub.createFolder(slug, name);
	return f ? c.json(f, 201) : c.json({ error: "Folder with this name already exists" }, 409);
});

app.put("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const f = await c.var.mailboxStub.updateFolder(c.req.param("id")!, name);
	return f ? c.json(f) : c.json({ error: "Folder not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const ok = await c.var.mailboxStub.deleteFolder(c.req.param("id")!);
	return ok ? c.body(null, 204) : c.json({ error: "Folder not found or cannot be deleted" }, 400);
});

// -- Search ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/search", async (c: AppContext) => {
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

app.get("/api/v1/mailboxes/:mailboxId/emails/:emailId/attachments/:attachmentId", async (c: AppContext) => {
	const emailId = c.req.param("emailId")!;
	const attachmentId = c.req.param("attachmentId")!;
	const attachment = await c.var.mailboxStub.getAttachment(attachmentId);
	if (!attachment) return c.json({ error: "Attachment not found" }, 404);
	const obj = await c.env.BUCKET.get(attachmentObjectKey(emailId, attachmentId, attachment.filename));
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

async function receiveEmail(event: { raw: ReadableStream; rawSize: number }, env: Env, ctx: ExecutionContext) {
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
	if (!(await env.BUCKET.head(`mailboxes/${mailboxId}.json`))) { console.log(`Ignoring email for ${mailboxId}: mailbox does not exist`); return; }

	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));

	const attachmentData: StoredAttachment[] = [];
	if (parsedEmail.attachments) {
		for (const att of parsedEmail.attachments) {
			const attId = crypto.randomUUID();
			const filename = (att.filename || "untitled").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
			await env.BUCKET.put(attachmentObjectKey(messageId, attId, filename), att.content);
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

	// DMARC aggregate reports arrive as email. Detect and divert to the
	// dashboard rather than running the content classifier against what is
	// obviously automated machine mail. See workers/dmarc/ingest.ts.
	if (isDmarcReport(parsedEmail)) {
		try {
			const result = await ingestDmarcReport(env, mailboxId, messageId, parsedEmail);
			if (result.ingested) {
				await stub.moveEmail(messageId, Folders.ARCHIVE);
				return;
			}
		} catch (e) {
			console.error("dmarc ingest failed:", (e as Error).message);
		}
	}

	// Security pipeline (opt-in per mailbox via settings.security.enabled).
	// Runs synchronously so quarantine decisions are made before the agent
	// auto-draft fires. See workers/security/index.ts.
	let securityVerdict: Awaited<ReturnType<typeof runSecurityPipeline>>["verdict"] = null;
	try {
		const result = await runSecurityPipeline({
			env,
			mailboxId,
			messageId,
			// `receiveEmail` always lands inbound mail in INBOX today. If a
			// future filter-rule engine routes mail into other folders on
			// receive, this destination folder must be passed through so the
			// folder-bypass triage tier can honour per-folder policy.
			targetFolder: Folders.INBOX,
			parsedEmail: {
				subject: parsedEmail.subject,
				from: parsedEmail.from,
				html: parsedEmail.html,
				text: parsedEmail.text,
				headers: parsedEmail.headers,
				attachments: parsedEmail.attachments?.map((a) => ({
					filename: a.filename ?? null,
					mimeType: a.mimeType ?? null,
				})),
			},
		});
		securityVerdict = result.verdict;
		if (securityVerdict?.action === "quarantine" || securityVerdict?.action === "block") {
			await stub.moveEmail(messageId, Folders.QUARANTINE);
		}
	} catch (e) {
		console.error("Security pipeline failed:", (e as Error).message);
	}

	// Foreground notification fanout. Pass the *final* folder so connected
	// clients can suppress desktop notifications for mail that was
	// quarantined/blocked by the sync verdict — surfacing a notification for
	// a phishing email that just vanished into Quarantine is worse than
	// silence. Deep-scan can still tighten the verdict later, but that
	// happens out-of-band and does not retract the notification.
	const finalFolder =
		securityVerdict?.action === "quarantine" || securityVerdict?.action === "block"
			? Folders.QUARANTINE
			: Folders.INBOX;
	try {
		await stub.notifyNewEmail(messageId, finalFolder);
	} catch (e) {
		console.error("notifyNewEmail failed:", (e as Error).message);
	}

	// Async deep-scan. Runs AFTER the sync pipeline decision and only ever
	// tightens the verdict (never downgrades). Enqueued via ctx.waitUntil
	// so it doesn't block email receipt; failures are logged but don't
	// propagate. Gated on the same `security.enabled` flag as the sync path.
	if (securityVerdict) {
		try {
			const settings = await getSecuritySettings(env, mailboxId);
			ctx.waitUntil(
				runDeepScan({ env, mailboxId, emailId: messageId, thresholds: settings.thresholds })
					.then(
						(r) => {
							if (r.added_score > 0) {
								console.log(
									`deep-scan ${messageId}: +${r.added_score} → ${r.final_action} (${r.reasons.slice(0, 3).join("; ")})`,
								);
							}
						},
						(e) => console.error("deep-scan failed:", (e as Error).message),
					),
			);
		} catch (e) {
			console.error("deep-scan enqueue failed:", (e as Error).message);
		}
	}

	// Auto-draft dispatch is gated on per-mailbox settings. The security
	// pipeline above always runs; only the agent's onNewEmail fetch is
	// skipped when the operator has disabled auto-draft for this mailbox.
	const mailboxSettings = await getMailboxSettings(env, mailboxId);
	if (!mailboxSettings.autoDraft.enabled) {
		return;
	}

	const agentStub = env.EMAIL_AGENT.get(env.EMAIL_AGENT.idFromName(mailboxId));
	ctx.waitUntil(agentStub.fetch(new Request("https://agents/onNewEmail", {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			mailboxId,
			emailId: messageId,
			sender: (parsedEmail.from?.address || "").toLowerCase(),
			subject: parsedEmail.subject || "",
			threadId,
			securityVerdict: securityVerdict
				? { action: securityVerdict.action, score: securityVerdict.score, explanation: securityVerdict.explanation }
				: null,
		}),
	})).catch((e) => console.error("Auto-draft trigger failed:", (e as Error).message)));
}

export { app, receiveEmail };
