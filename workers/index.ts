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
	listMailboxes,
} from "./lib/email-helpers";
import { SendEmailRequestSchema } from "./lib/schemas";
import { handleReplyEmail, handleForwardEmail } from "./routes/reply-forward";
import { Folders } from "../shared/folders";
import type { Env } from "./types";
import { requireMailbox, type MailboxContext } from "./lib/mailbox";
import { restoreAttachments } from "./lib/restore-attachments";
import { OutgoingAttachmentsSchema } from "./lib/outgoing-attachments";

type AppContext = Context<MailboxContext>;

// -- Request body schemas (kept for validation) ---------------------

const CreateMailboxBody = z.object({
	email: z.string().email(),
	name: z.string().min(1),
	settings: z.record(z.any()).optional(), // unvalidated — agentSystemPrompt goes straight to AI
});

const DraftBody = z.object({
	attachments: OutgoingAttachmentsSchema.optional(),
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

function parseList(value: string | string[] | undefined): string[] {
	if (!value) return [];
	if (Array.isArray(value)) return value.map((item) => item.trim()).filter(Boolean);

	const trimmed = value.trim();
	if (!trimmed) return [];

	try {
		const parsed = JSON.parse(trimmed);
		if (Array.isArray(parsed)) {
			return parsed.map((item) => String(item).trim()).filter(Boolean);
		}
	} catch {
		// Fall through to comma-separated parsing.
	}

	return trimmed.split(",").map((item) => item.trim()).filter(Boolean);
}

function hasValidApiKey(c: { req: { header(name: string): string | undefined }; env: Env }): boolean {
	const apiKey = c.req.header("X-API-Key");
	return Boolean(apiKey && apiKey === c.env.STALWART_ACCOUNT_PASSWORD);
}

async function getImportMessageId(rawEmail: ArrayBuffer, messageId?: string): Promise<string> {
	if (messageId) {
		const match = messageId.match(/<([^>]+)>/);
		return match ? match[1] : messageId.trim().split(/\s+/)[0];
	}

	const digest = await crypto.subtle.digest("SHA-256", rawEmail);
	return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

const CHATWOOT_INBOX_MAP: Record<string, string> = {
	"support@team.easyrentbali.com": "support",
	"reservation@team.easyrentbali.com": "reservation",
	"billing@team.easyrentbali.com": "billing",
	"partners@team.easyrentbali.com": "partners",
	"test-rsvbook@team.easyrentbali.com": "reservation",
	"accounting@easyrentbali.com": "accounting",
	"cs@easyrentbali.com": "cs",
	"director@easyrentbali.com": "director",
	"fin.acct@easyrentbali.com": "fin-acct",
	"finance@easyrentbali.com": "finance",
	"gm@easyrentbali.com": "gm",
	"info@easyrentbali.com": "info",
	"jagoan@easyrentbali.com": "jagoan",
	"job_career@easyrentbali.com": "job-career",
	"manager@easyrentbali.com": "manager",
	"marketing@easyrentbali.com": "marketing",
	"reservation@easyrentbali.com": "reservation-erb",
	"support@easyrentbali.com": "support-erb",
	"tester@easyrentbali.com": "tester",
};

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

// -- Setup: Auto-create mailboxes from EMAIL_ADDRESSES --------------------

app.post("/api/v1/setup", async (c) => {
	if (!hasValidApiKey(c)) return c.json({ error: "Unauthorized" }, 401);

	const allowedAddresses = parseList(c.env.EMAIL_ADDRESSES);
	if (allowedAddresses.length === 0) {
		return c.json({ error: "No EMAIL_ADDRESSES configured" }, 400);
	}

	const results: { email: string; status: string; error?: string }[] = [];

	for (const email of allowedAddresses) {
		const emailLower = email.toLowerCase();
		const key = `mailboxes/${emailLower}.json`;

		try {
			// Check if mailbox already exists
			if (await c.env.BUCKET.head(key)) {
				results.push({ email: emailLower, status: "exists" });
				continue;
			}

			// Extract name from email (e.g., "accounting" from "accounting@easyrentbali.com")
			const name = emailLower.split("@")[0]
				.replace(/[._-]/g, " ")
				.replace(/\b\w/g, (l) => l.toUpperCase());

			// Create mailbox settings
			const settings = {
				fromName: name,
				forwarding: { enabled: false, email: "" },
				signature: { enabled: false, text: "" },
				autoReply: { enabled: false, subject: "", message: "" },
			};

			// Save mailbox config
			await c.env.BUCKET.put(key, JSON.stringify(settings));

			// Initialize the Durable Object
			const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(emailLower));
			await stub.getFolders();

			results.push({ email: emailLower, status: "created" });
		} catch (e: any) {
			results.push({ email: emailLower, status: "error", error: e.message });
		}
	}

	return c.json({
		success: true,
		total: allowedAddresses.length,
		created: results.filter((r) => r.status === "created").length,
		existing: results.filter((r) => r.status === "exists").length,
		errors: results.filter((r) => r.status === "error").length,
		results,
	});
});

// -- Config ---------------------------------------------------------

app.get("/api/v1/config", (c) => {
	const domains = parseList(c.env.DOMAINS);
	const emailAddresses = parseList(c.env.EMAIL_ADDRESSES);
	return c.json({ domains, emailAddresses });
});

// -- Import: Bulk .eml import via raw MIME POST ----------------------------

app.post("/api/v1/import", async (c) => {
	if (!hasValidApiKey(c)) return c.json({ error: "Unauthorized" }, 401);

	const contentType = c.req.header("content-type") || "";
	if (!contentType.includes("message/rfc822") && !contentType.includes("application/octet-stream")) {
		return c.json({ error: "Content-Type must be message/rfc822 or application/octet-stream" }, 400);
	}

	const rawEmail = await c.req.arrayBuffer();
	if (rawEmail.byteLength === 0) return c.json({ error: "Empty body" }, 400);
	if (rawEmail.byteLength > MAX_EMAIL_SIZE) return c.json({ error: `Email too large: ${rawEmail.byteLength} bytes` }, 413);

	const parsedEmail = await new PostalMime().parse(rawEmail);

	const extractMsgId = (s: string) => { const m = s.match(/<([^>]+)>/); return m ? m[1] : s.trim().split(/\s+/)[0]; };
	const originalMessageId = await getImportMessageId(rawEmail, parsedEmail.messageId);

	// Resolve mailbox — prefer explicit override, then To address.
	const allowedAddresses = parseList(c.env.EMAIL_ADDRESSES).map((a) => a.toLowerCase());
	const allRecipients = parsedEmail.to?.map((t) => t.address?.toLowerCase()).filter(Boolean) as string[] || [];
	const requestedMailbox = c.req.header("X-Mailbox-Id")?.trim().toLowerCase();
	let mailboxId = requestedMailbox;
	if (mailboxId && !allowedAddresses.includes(mailboxId)) {
		return c.json({ error: "X-Mailbox-Id is not configured", mailbox: mailboxId }, 422);
	}
	if (allowedAddresses.length > 0) {
		mailboxId ??= allRecipients.find((addr) => allowedAddresses.includes(addr));
		if (!mailboxId) {
			return c.json({ error: "No recipient matches EMAIL_ADDRESSES", recipients: allRecipients }, 422);
		}
	} else {
		mailboxId = allRecipients[0];
	}
	if (!mailboxId) return c.json({ error: "No valid recipient address" }, 400);

	// Ensure mailbox exists
	if (!(await c.env.BUCKET.head(`mailboxes/${mailboxId}.json`))) {
		return c.json({ error: `Mailbox ${mailboxId} does not exist` }, 404);
	}

	const messageId = crypto.randomUUID();
	const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(mailboxId));
	const existingEmail = await stub.findEmailByMessageId(originalMessageId);
	if (existingEmail) {
		return c.json({
			success: true,
			duplicate: true,
			message_id: existingEmail.id,
			original_message_id: originalMessageId,
			mailbox: mailboxId,
		});
	}

	// Store attachments
	const attachmentData: StoredAttachment[] = [];
	if (parsedEmail.attachments) {
		for (const att of parsedEmail.attachments) {
			const attId = crypto.randomUUID();
			const filename = (att.filename || "untitled").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
			await c.env.BUCKET.put(`attachments/${messageId}/${attId}/${filename}`, att.content);
			attachmentData.push({
				id: attId, email_id: messageId, filename, mimetype: att.mimeType,
				size: typeof att.content === "string" ? att.content.length : att.content.byteLength,
				content_id: att.contentId || null, disposition: att.disposition || "attachment",
			});
		}
	}

	// Thread detection
	const inReplyTo = parsedEmail.inReplyTo ? extractMsgId(parsedEmail.inReplyTo) : null;
	const emailReferences = parsedEmail.references ? parsedEmail.references.split(/\s+/).filter(Boolean).map(extractMsgId) : [];
	let threadId = emailReferences[0] || inReplyTo || messageId;

	if (!inReplyTo && emailReferences.length === 0) {
		const subjectThread = await (stub as any).findThreadBySubject(parsedEmail.subject || "", parsedEmail.from?.address || undefined);
		if (subjectThread) threadId = subjectThread;
	}

	// Use the email's own Date header for imported emails (not receive time)
	const emailDate = parsedEmail.date ? new Date(parsedEmail.date).toISOString() : new Date().toISOString();

	// Create email in inbox
	await stub.createEmail(Folders.INBOX, {
		id: messageId, subject: parsedEmail.subject || "",
		sender: (parsedEmail.from?.address || "").toLowerCase(),
		recipient: allRecipients.join(", ") || mailboxId,
		cc: (parsedEmail.cc || []).map((e) => e.address?.toLowerCase()).filter(Boolean).join(", ") || null,
		bcc: (parsedEmail.bcc || []).map((e) => e.address?.toLowerCase()).filter(Boolean).join(", ") || null,
		date: emailDate,
		body: parsedEmail.html || parsedEmail.text || "",
		in_reply_to: inReplyTo,
		email_references: emailReferences.length > 0 ? JSON.stringify(emailReferences) : null,
		thread_id: threadId, message_id: originalMessageId,
		raw_headers: JSON.stringify(parsedEmail.headers),
	}, attachmentData);

	// === FAN-OUT: Same as receiveEmail ===

	const primaryTo = parsedEmail.to?.[0]?.address?.toLowerCase() || mailboxId || "";
	const chatwootInbox = CHATWOOT_INBOX_MAP[primaryTo];

	const skipChatwoot = c.req.header("X-Skip-Chatwoot") != null;
	let chatwootConversationId: number | undefined;
	if (!skipChatwoot && chatwootInbox && c.env.CHATWOOT_RELAY_URL) {
		try {
			const relayBody = allRecipients.includes(mailboxId)
				? rawEmail
				: new Blob([`Delivered-To: ${mailboxId}\r\nX-Original-To: ${mailboxId}\r\n`, rawEmail]);
			const relayResponse = await fetch(c.env.CHATWOOT_RELAY_URL, {
				method: "POST",
				headers: {
					"Content-Type": "message/rfc822",
					Authorization: `Basic ${btoa(`actionmailbox:${c.env.CHATWOOT_INGRESS_PASSWORD}`)}`,
				},
				body: relayBody,
			});
			if (relayResponse.ok) {
				const relayData = await relayResponse.json() as any;
				chatwootConversationId = relayData?.id;
			} else {
				console.error("Chatwoot relay failed:", relayResponse.status);
			}
		} catch (e) {
			console.error("Chatwoot relay error:", e);
		}
	}

	// 2. R2 cold storage
	try {
		const r2Key = `archive/${mailboxId}/${new Date().toISOString().slice(0, 10)}/${messageId}.eml`;
		await c.env.BUCKET.put(r2Key, rawEmail);
	} catch (e) {
		console.error("R2 archive error:", e);
	}

	return c.json({
		success: true,
		message_id: messageId,
		original_message_id: originalMessageId,
		mailbox: mailboxId,
		subject: parsedEmail.subject || "",
		from: parsedEmail.from?.address || "",
		date: emailDate,
		chatwoot_conversation_id: chatwootConversationId || null,
		stalwart_email_id: null,
		is_ota: false,
	}, 201);
});

// Archive raw MIME to R2 cold storage. Used by the bulk importer for oversized
// emails that exceed MAX_EMAIL_SIZE on /import.
app.post("/api/v1/archive", async (c) => {
	if (!hasValidApiKey(c)) return c.json({ error: "Unauthorized" }, 401);
	const mailboxId = c.req.header("X-Mailbox-Id")?.trim().toLowerCase();
	if (!mailboxId) return c.json({ error: "X-Mailbox-Id required" }, 400);
	const raw = await c.req.arrayBuffer();
	if (raw.byteLength === 0) return c.json({ error: "Empty body" }, 400);
	const messageId = crypto.randomUUID();
	const r2Key = `archive/${mailboxId}/${new Date().toISOString().slice(0, 10)}/${messageId}.eml`;
	await c.env.BUCKET.put(r2Key, raw);
	return c.json({ success: true, r2_key: r2Key }, 201);
});

// Metadata-only inbox insert (no raw body). Used by the bulk importer for
// oversized emails: the full MIME goes to R2 via /archive, headers+body here.
app.post("/api/v1/import-reference", async (c) => {
	if (!hasValidApiKey(c)) return c.json({ error: "Unauthorized" }, 401);
	const ref = await c.req.json() as Record<string, any>;
	const allowedAddresses = parseList(c.env.EMAIL_ADDRESSES).map((a) => a.toLowerCase());
	const mailboxId = (c.req.header("X-Mailbox-Id")?.trim().toLowerCase()) || (ref.mailbox || "").toLowerCase();
	if (!mailboxId) return c.json({ error: "No mailbox" }, 400);
	if (allowedAddresses.length > 0 && !allowedAddresses.includes(mailboxId)) {
		return c.json({ error: "Mailbox not configured", mailbox: mailboxId }, 422);
	}
	if (!(await c.env.BUCKET.head(`mailboxes/${mailboxId}.json`))) {
		return c.json({ error: `Mailbox ${mailboxId} does not exist` }, 404);
	}

	const originalMessageId = ref.message_id || ref.sha256;
	const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(mailboxId));
	const existingEmail = await stub.findEmailByMessageId(originalMessageId);
	if (existingEmail) {
		return c.json({ success: true, duplicate: true, message_id: existingEmail.id, mailbox: mailboxId });
	}

	const messageId = crypto.randomUUID();
	const refList = ref.references ? String(ref.references).split(/\s+/).filter(Boolean) : [];
	const threadId = refList[0] || ref.in_reply_to || messageId;
	const emailDate = ref.date ? new Date(ref.date).toISOString() : new Date().toISOString();

	await stub.createEmail(Folders.INBOX, {
		id: messageId,
		subject: ref.subject || "",
		sender: (ref.sender || "").toLowerCase(),
		recipient: ref.recipient || mailboxId,
		cc: ref.cc || null,
		bcc: ref.bcc || null,
		date: emailDate,
		body: ref.body || "",
		in_reply_to: ref.in_reply_to || null,
		email_references: refList.length > 0 ? JSON.stringify(refList) : null,
		thread_id: threadId,
		message_id: originalMessageId,
		raw_headers: ref.raw_headers ? JSON.stringify(ref.raw_headers) : null,
	}, []);

	return c.json({ success: true, message_id: messageId, original_message_id: originalMessageId, mailbox: mailboxId }, 201);
});

// -- Mailboxes ------------------------------------------------------

app.get("/api/v1/mailboxes", async (c) => {
	const allMailboxes = await listMailboxes(c.env.BUCKET);
	return c.json(allMailboxes.map((m) => ({ ...m, name: m.id })));
});

app.post("/api/v1/mailboxes", async (c) => {
	const { name, settings, email: rawEmail } = CreateMailboxBody.parse(await c.req.json());
	const email = rawEmail.toLowerCase();
	const allowedAddresses = parseList(c.env.EMAIL_ADDRESSES);
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
	await c.env.BUCKET.delete(key); // TODO: also delete DO data and R2 attachment blobs
	return c.body(null, 204);
});

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
	const { to, cc, bcc, subject, body, in_reply_to, thread_id, draft_id, attachments } = DraftBody.parse(await c.req.json());
	const stub = c.var.mailboxStub;
	if (draft_id) {
		const existing = await stub.getEmail(draft_id);
		const folders = await stub.getFolders();
		const draftFolder = folders.find((folder) => folder.name === Folders.DRAFT);
		if (!existing || existing.folder_id !== draftFolder?.id) return c.json({ error: "Draft not found" }, 404);
	}
	const messageId = crypto.randomUUID();
	const now = new Date().toISOString();
	const attachmentData = await storeAttachments(c.env.BUCKET, messageId, attachments);
	await stub.createEmail(Folders.DRAFT, {
		id: messageId, subject: subject || "", sender: mailboxId.toLowerCase(),
		recipient: (to || "").toLowerCase(), cc: cc?.toLowerCase() || null, bcc: bcc?.toLowerCase() || null,
		date: now, body, in_reply_to: in_reply_to || null, email_references: null,
		thread_id: thread_id || in_reply_to || messageId,
	}, attachmentData);
	if (draft_id) await stub.deleteEmail(draft_id);
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
	if (attachments.length > 0) await c.env.BUCKET.delete(attachments.map((att: any) => `attachments/${id}/${att.id}/${att.filename}`));
	return c.body(null, 204);
});

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/move", async (c: AppContext) => {
	const { folderId } = (await c.req.json()) as { folderId: string };
	const success = await c.var.mailboxStub.moveEmail(c.req.param("id")!, folderId);
	return success ? c.json({ status: "moved" }) : c.json({ error: "Folder not found" }, 400);
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

app.post("/api/v1/mailboxes/:mailboxId/emails/:emailId/restore-attachments", async (c: AppContext) => {
	if (!hasValidApiKey(c)) return c.json({ error: "Unauthorized" }, 401);
	const input = z.object({ sourceMailbox: z.string().email(), sourceId: z.string().uuid() }).safeParse(await c.req.json());
	if (!input.success) return c.json({ error: "Invalid source identity" }, 400);
	const { sourceMailbox, sourceId } = input.data;
	if (!(await c.env.BUCKET.head(`mailboxes/${sourceMailbox}.json`))) return c.json({ error: "Source mailbox not found" }, 404);
	try {
		return c.json(await restoreAttachments(c.env, decodeURIComponent(c.req.param("mailboxId")!), c.req.param("emailId")!, sourceMailbox, sourceId));
	} catch {
		return c.json({ error: "Attachments could not be restored from matching source" }, 409);
	}
});

app.get("/api/v1/mailboxes/:mailboxId/emails/:emailId/attachments/:attachmentId", async (c: AppContext) => {
	const emailId = c.req.param("emailId")!;
	const attachmentId = c.req.param("attachmentId")!;
	const attachment = await c.var.mailboxStub.getAttachment(attachmentId);
	if (!attachment || attachment.email_id !== emailId) return c.json({ error: "Attachment not found" }, 404);
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

async function receiveEmail(event: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
	const rawEmail = await streamToArrayBuffer(event.raw, event.rawSize);
	const parsedEmail = await new PostalMime().parse(rawEmail);

	const allowedAddresses = parseList(env.EMAIL_ADDRESSES).map((a) => a.toLowerCase());
	const allRecipients = (parsedEmail.to || []).map((t) => t.address?.toLowerCase()).filter(Boolean) as string[];
	const ccRecipients = (parsedEmail.cc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];
	const bccRecipients = (parsedEmail.bcc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];

	// Cloudflare invokes this handler for each envelope recipient, including CC/BCC.
	const mailboxId = event.to?.trim().toLowerCase();
	if (!mailboxId || (allowedAddresses.length > 0 && !allowedAddresses.includes(mailboxId))) {
		throw new Error("Incoming envelope recipient is not configured");
	}

	const messageId = crypto.randomUUID();
	if (!(await env.BUCKET.head(`mailboxes/${mailboxId}.json`))) {
		throw new Error(`Incoming mailbox does not exist: ${mailboxId}`);
	}

	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
	const originalMessageId = await getImportMessageId(rawEmail.buffer, parsedEmail.messageId);
	if (await stub.findEmailByMessageId(originalMessageId)) return;

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

	const stored = await stub.createInboundEmail({
		id: messageId, subject: parsedEmail.subject || "",
		sender: (parsedEmail.from?.address || "").toLowerCase(), recipient: allRecipients.join(", "),
		cc: ccRecipients.join(", ") || null, bcc: bccRecipients.join(", ") || null,
		date: new Date().toISOString(), // uses receive time, not the email's Date header
		body: parsedEmail.html || parsedEmail.text || "",
		in_reply_to: inReplyTo, email_references: emailReferences.length > 0 ? JSON.stringify(emailReferences) : null,
		thread_id: threadId, message_id: originalMessageId, raw_headers: JSON.stringify(parsedEmail.headers),
	}, attachmentData);
	if (!stored.created) return;

	// Preserve the original MIME, attachments, and sender authentication on the Gmail copy.
	const gmailDestination = ({
		"reservation@easyrentbali.com": "reservation.easyrentbali@gmail.com",
		"marketing@easyrentbali.com": "marketing.easyrentbali@gmail.com",
	} as Record<string, string>)[mailboxId];
	if (gmailDestination) {
		try {
			await event.forward(gmailDestination);
		} catch (error) {
			console.error("Gmail fan-out failed:", mailboxId, (error as Error).message);
		}
	}

	// === EASYRENT CUSTOM ROUTING ===

	const primaryTo = mailboxId;
	const chatwootInbox = CHATWOOT_INBOX_MAP[primaryTo];

	if (chatwootInbox && env.CHATWOOT_RELAY_URL) {
		try {
			const relayResponse = await fetch(env.CHATWOOT_RELAY_URL, {
				method: "POST",
				headers: {
					"Content-Type": "message/rfc822",
					Authorization: `Basic ${btoa(`actionmailbox:${env.CHATWOOT_INGRESS_PASSWORD}`)}`,
				},
				body: rawEmail,
			});
			if (!relayResponse.ok) {
				console.error("Chatwoot relay failed:", relayResponse.status, await relayResponse.text());
			}
		} catch (relayError) {
			console.error("Chatwoot relay error:", relayError);
		}
	}

	// 2. Import raw MIME to Stalwart via JMAP (backup mailbox)
	if (env.STALWART_JMAP_URL && env.STALWART_ACCOUNT_EMAIL && env.STALWART_ACCOUNT_PASSWORD) {
		try {
			const authHeader = `Basic ${btoa(`${env.STALWART_ACCOUNT_EMAIL}:${env.STALWART_ACCOUNT_PASSWORD}`)}`;

			// Step 1: Get JMAP session via /jmap/session endpoint
			const sessionRes = await fetch(`${env.STALWART_JMAP_URL}/session`, {
				method: "GET",
				headers: { "Authorization": authHeader },
			});

			if (!sessionRes.ok) {
				console.error("Stalwart JMAP session failed:", sessionRes.status);
			} else {
				const sessionData = await sessionRes.json() as any;
				// Always use the Zeabur URL since mx.easyrentbali.com has no SSL
				const apiUrl = env.STALWART_JMAP_URL;
				const accountId = sessionData?.primaryAccounts?.["urn:ietf:params:jmap:mail"];

				if (!accountId) {
					console.error("Stalwart JMAP: no accountId in session");
				} else {
				// Step 2: Upload raw email as blob
					const blobName = `email-${Date.now()}.eml`;
					const uploadUrl = apiUrl.replace(/\/jmap\/?$/, `/jmap/upload/${accountId}/`);
					const rawEmailStr = new TextDecoder().decode(rawEmail);
					const uploadRes = await fetch(uploadUrl, {
						method: "POST",
						headers: {
							"Content-Type": "message/rfc822",
							"Authorization": authHeader,
						},
						body: rawEmailStr,
					});

					if (!uploadRes.ok) {
						console.error("Stalwart blob upload failed:", uploadRes.status);
					} else {
						const uploadData = await uploadRes.json() as any;
						const blobId = uploadData.blobId;

						// Step 3: Import email via JMAP
						const importRes = await fetch(apiUrl, {
							method: "POST",
							headers: {
								"Content-Type": "application/json",
								"Authorization": authHeader,
							},
							body: JSON.stringify({
								using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
								methodCalls: [
									["Email/import", {
										accountId,
										emails: {
											"e0": {
												blobId,
												mailboxIds: { "a": true },
											},
										},
									}, "c1"],
								],
							}),
						});

						if (!importRes.ok) {
							console.error("Stalwart JMAP import failed:", importRes.status);
						} else {
							const importData = await importRes.json() as any;
							const created = importData?.methodResponses?.[0]?.[1]?.created;
							const notCreated = importData?.methodResponses?.[0]?.[1]?.notCreated;
							if (created && Object.keys(created).length > 0) {
								console.log("Stalwart JMAP import OK:", Object.keys(created).length, "email(s)");
							} else {
								console.error("Stalwart JMAP import result:", JSON.stringify(importData?.methodResponses?.[0]?.[1]));
							}
						}
					}
				}
			}
		} catch (stalwartError) {
			console.error("Stalwart JMAP error:", stalwartError);
		}
	}

	// 3. POST to reservation-agent for queue updates (OTA emails only).
	// Gate on the OTA sender ALLOWLIST (exact from-address) — far fewer false
	// positives/negatives than keyword matching. Kept in sync with
	// apps/erp/src/lib/ota-sources.ts + reservation-agent/src/inbox-sweep.ts.
	const fromAddr = (parsedEmail.from?.address || "").toLowerCase();
	const OTA_SENDERS = [
		"reservationsdept@cartrawler.com",
		"noreply@cartrawler.com",
		"xczc_tzzy@trip.com",
		"support@qbookingsolutions.com",
		"admin@email.yesaway.com",
		"booking@zuzuche.com",
		"confirmations@bookinggroup.com",
		"reservations@economycarrentals.com",
		"joanna@economycarrentals.com",
		"mail@localrent.com",
		"support@driveo.asia",
	];
	const isOTA = OTA_SENDERS.some((addr) => fromAddr.includes(addr));

	if (isOTA && env.RESERVATION_AGENT_URL) {
		try {
			await fetch(env.RESERVATION_AGENT_URL, {
				method: "POST",
				headers: {
					"Content-Type": "message/rfc822",
					"X-Email-Id": messageId,
					"X-From": fromAddr,
					"X-Subject": parsedEmail.subject || "",
				},
				body: rawEmail,
			});
		} catch (agentError) {
			console.error("Reservation agent relay error:", agentError);
		}
	}

	// Automatic agent drafts are intentionally disabled. Agents can still be opened
	// manually from the mailbox header when a reply suggestion is wanted.
}

export { app, receiveEmail };
