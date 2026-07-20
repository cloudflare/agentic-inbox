// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import PostalMime from "postal-mime";
import { z } from "zod";
import { sendEmail } from "./email-sender";
import { storeAttachments, type StoredAttachment } from "./lib/attachments";
import { rewriteEmailBody } from "./lib/ai-rewrite";
import { searchMemory } from "./lib/memory-search";
import { resolveSourceType, processMemoryUpload } from "./lib/memory-upload";
import { summarizeMemoryFile } from "./lib/memory-summarize";
import { countWords, estimateTokens } from "./lib/text-metrics";
import { chunkMarkdown } from "./lib/memory-chunks";
import { buildDraftContext } from "./lib/memory-context";
import { getDriveFile } from "./lib/google-drive";
import { extractMemoryFacts } from "./lib/memory-facts";
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

app.get("/api/v1/config", (c) => {
	const domainsRaw = c.env.DOMAINS || "";
	const domains = domainsRaw.split(",").map((d) => d.trim()).filter(Boolean);
	const emailAddresses = c.env.EMAIL_ADDRESSES ?? [];
	const openRouterConfigured = Boolean(c.env.OPENROUTER_API_KEY);
	return c.json({ domains, emailAddresses, openRouterConfigured });
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

// AI rewrite endpoint
app.post("/api/v1/mailboxes/:mailboxId/ai/rewrite", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { body, action, instruction } = (await c.req.json()) as {
		body: string;
		action: "polish" | "formalize" | "friendly" | "shorten" | "custom";
		instruction?: string;
	};
	if (!body || !action) return c.json({ error: "body and action are required" }, 400);
	try {
		const rewritten = await rewriteEmailBody(c.env, mailboxId, body, action, instruction);
		return c.json({ body: rewritten });
	} catch (err) {
		const message = err instanceof Error ? err.message : "AI rewrite failed";
		return c.json({ error: message }, 500);
	}
});

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
	if (attachments.length > 0) await c.env.BUCKET.delete(attachments.map((att: any) => `attachments/${id}/${att.id}/${att.filename}`));
	return c.body(null, 204);
});

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/move", async (c: AppContext) => {
	const { folderId } = (await c.req.json()) as { folderId: string };
	const success = await c.var.mailboxStub.moveEmail(c.req.param("id")!, folderId);
	return success ? c.json({ status: "moved" }) : c.json({ error: "Folder not found" }, 400);
});

// Single-segment slugs (not "/emails/bulk/move") to avoid colliding with the
// "/emails/:id/move" pattern above, where ":id" would otherwise match "bulk".
app.post("/api/v1/mailboxes/:mailboxId/emails/bulk-mark-read", async (c: AppContext) => {
	const { ids, read } = (await c.req.json()) as { ids: string[]; read: boolean };
	if (!Array.isArray(ids) || typeof read !== "boolean") {
		return c.json({ error: "ids (array) and read (boolean) are required" }, 400);
	}
	const result = await (c.var.mailboxStub as any).bulkMarkRead(ids, read);
	return c.json(result);
});

// TEMP DEBUG ROUTE — inserts a synthetic inbox email and triggers the agent's
// /onNewEmail path, mirroring receiveEmail()'s flow below. Used only to
// verify the urgent/phishing safety hooks in handleNewEmail during local
// testing. Remove before merging.
app.post("/api/v1/mailboxes/:mailboxId/_debug/simulate-inbound", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { sender, subject, text } = (await c.req.json()) as {
		sender: string;
		subject: string;
		text: string;
	};
	const stub = c.var.mailboxStub;
	const messageId = crypto.randomUUID();
	await stub.createEmail(
		Folders.INBOX,
		{
			id: messageId,
			subject,
			sender: sender.toLowerCase(),
			recipient: mailboxId,
			date: new Date().toISOString(),
			body: `<p>${text}</p>`,
			thread_id: messageId,
		},
		[],
	);
	const agentStub = c.env.EMAIL_AGENT.get(c.env.EMAIL_AGENT.idFromName(mailboxId));
	const agentResponse = await agentStub.fetch(
		new Request("https://agents/onNewEmail", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mailboxId, emailId: messageId, sender: sender.toLowerCase(), subject, threadId: messageId }),
		}),
	);
	const agentResult = await agentResponse.json();
	return c.json({ emailId: messageId, agentResult });
});

app.post("/api/v1/mailboxes/:mailboxId/emails/bulk-move", async (c: AppContext) => {
	const { ids, folderId } = (await c.req.json()) as { ids: string[]; folderId: string };
	if (!Array.isArray(ids) || !folderId) {
		return c.json({ error: "ids (array) and folderId are required" }, 400);
	}
	const result = await (c.var.mailboxStub as any).bulkMoveEmails(ids, folderId);
	if (result.error) return c.json(result, 400);
	return c.json(result);
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

// -- Memory -----------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/memory", async (c: AppContext) => {
	return c.json(await (c.var.mailboxStub as any).listMemoryFiles());
});

app.post("/api/v1/mailboxes/:mailboxId/memory", async (c: AppContext) => {
	const { title, content, tags } = (await c.req.json()) as {
		title?: string;
		content?: string;
		tags?: string;
	};
	if (!title?.trim() || !content?.trim()) {
		return c.json({ error: "title and content are required" }, 400);
	}
	const mailboxId = c.req.param("mailboxId")!;
	const id = crypto.randomUUID();
	const r2_key = `memory/${mailboxId}/${id}.md`;
	await c.env.BUCKET.put(r2_key, content, { httpMetadata: { contentType: "text/markdown" } });
	const row = await (c.var.mailboxStub as any).createMemoryFile({
		id,
		title: title.trim(),
		tags,
		content,
		r2_key,
		word_count: countWords(content),
		token_count: estimateTokens(content),
		source_kind: "manual",
	});
	await (c.var.mailboxStub as any).replaceMemoryChunks(id, chunkMarkdown(content));
	c.executionCtx.waitUntil(extractMemoryFacts(c.env, mailboxId, id).catch((error) => console.warn("Memory fact extraction failed:", error)));
	return c.json(row, 201);
});

// Static sub-paths (search, upload) must be registered before the
// parameterized /memory/:id routes below to avoid ambiguity with routers
// that resolve in registration order.
app.get("/api/v1/mailboxes/:mailboxId/memory/search", async (c: AppContext) => {
	const query = c.req.query("query") || "";
	const mailboxId = c.req.param("mailboxId")!;
	return c.json(await searchMemory(c.env, mailboxId, query));
});

app.get("/api/v1/mailboxes/:mailboxId/memory/context", async (c: AppContext) => {
	const query = c.req.query("query") || "";
	if (!query.trim()) return c.json({ error: "query is required" }, 400);
	return c.json(await buildDraftContext(c.env, c.req.param("mailboxId")!, query));
});

app.get("/api/v1/mailboxes/:mailboxId/memory/facts", async (c: AppContext) => {
	return c.json(await (c.var.mailboxStub as any).listMemoryFacts(c.req.query("status")));
});

app.post("/api/v1/mailboxes/:mailboxId/memory/facts/:id/status", async (c: AppContext) => {
	const { status } = await c.req.json<{ status?: string }>();
	if (!status || !["suggested", "confirmed", "rejected", "superseded"].includes(status)) {
		return c.json({ error: "invalid fact status" }, 400);
	}
	await (c.var.mailboxStub as any).updateMemoryFactStatus(c.req.param("id")!, status);
	return c.json({ status });
});

app.put("/api/v1/mailboxes/:mailboxId/memory/facts/:id", async (c: AppContext) => {
	const { kind, value } = await c.req.json<{ kind?: string; value?: string }>();
	if ((kind !== undefined && !kind.trim()) || (value !== undefined && !value.trim())) {
		return c.json({ error: "kind and value cannot be empty" }, 400);
	}
	await (c.var.mailboxStub as any).updateMemoryFact(c.req.param("id")!, { kind: kind?.trim(), value: value?.trim() });
	return c.json({ updated: true });
});

app.post("/api/v1/mailboxes/:mailboxId/memory/upload", async (c: AppContext) => {
	const formData = await c.req.formData();
	const file = formData.get("file");
	if (!(file instanceof File)) {
		return c.json({ error: "file is required" }, 400);
	}
	const title = ((formData.get("title") as string) || file.name).trim();
	const tags = (formData.get("tags") as string) || undefined;

	const sourceType = resolveSourceType(file.type, file.name);
	if (!sourceType) {
		return c.json({ error: "Unsupported file type" }, 400);
	}

	const mailboxId = c.req.param("mailboxId")!;
	const id = crypto.randomUUID();
	const r2_key = `memory/${mailboxId}/${id}.md`;

	const row = await (c.var.mailboxStub as any).createMemoryFile({
		id,
		title,
		tags,
		content: "",
		r2_key,
		status: "processing",
		source_type: sourceType,
		source_kind: "upload",
	});

	c.executionCtx.waitUntil(
			(async () => {
				await processMemoryUpload(c.env, mailboxId, id, r2_key, file, sourceType);
				await extractMemoryFacts(c.env, mailboxId, id);
			})().catch((e) => console.error("Memory upload processing failed:", (e as Error).message),
		),
	);

	return c.json(row, 202);
});

app.post("/api/v1/mailboxes/:mailboxId/memory/import/google-drive", async (c: AppContext) => {
	const { fileIds, parentId } = await c.req.json<{ fileIds?: string[]; parentId?: string }>();
	if (!Array.isArray(fileIds) || fileIds.length === 0 || fileIds.length > 20) {
		return c.json({ error: "fileIds must contain between 1 and 20 files" }, 400);
	}
	const mailboxId = c.req.param("mailboxId")!;
	const imported: unknown[] = [];
	const skipped: string[] = [];
	for (const fileId of fileIds) {
		try {
			const existing = await (c.var.mailboxStub as any).getMemoryFileByExternalId(`google-drive:${fileId}`);
			if (existing) {
				skipped.push(fileId);
				continue;
			}
			const { file, content, sourceType } = await getDriveFile(c.env, fileId);
			const id = crypto.randomUUID();
			const r2Key = `memory/${mailboxId}/${id}.md`;
			await c.env.BUCKET.put(r2Key, content, { httpMetadata: { contentType: "text/markdown" } });
			const row = await (c.var.mailboxStub as any).createMemoryFile({
				id,
				title: file.name,
				content,
				r2_key: r2Key,
				source_type: sourceType,
				source_kind: "google_drive",
				source_uri: file.webViewLink,
				external_id: `google-drive:${file.id}`,
				parent_id: parentId,
				word_count: countWords(content),
				token_count: estimateTokens(content),
			});
			await (c.var.mailboxStub as any).replaceMemoryChunks(id, chunkMarkdown(content));
			await extractMemoryFacts(c.env, mailboxId, id);
			imported.push(row);
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : "Google Drive import failed", imported, skipped }, 502);
		}
	}
	return c.json({ imported, skipped });
});

app.get("/api/v1/mailboxes/:mailboxId/memory/:id", async (c: AppContext) => {
	const row = await (c.var.mailboxStub as any).getMemoryFile(c.req.param("id")!);
	if (!row) return c.json({ error: "Not found" }, 404);
	return c.json(row);
});

app.put("/api/v1/mailboxes/:mailboxId/memory/:id", async (c: AppContext) => {
	const { title, tags, parent_id, draft_eligible } = (await c.req.json()) as { title?: string; tags?: string; parent_id?: string; draft_eligible?: boolean };
	const row = await (c.var.mailboxStub as any).updateMemoryFileMetadata(c.req.param("id")!, { title, tags, parent_id, draft_eligible: draft_eligible == null ? undefined : draft_eligible ? 1 : 0 });
	return row ? c.json(row) : c.json({ error: "Not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/memory/:id", async (c: AppContext) => {
	const row = await (c.var.mailboxStub as any).deleteMemoryFile(c.req.param("id")!);
	if (row === null) return c.json({ error: "Not found" }, 404);
	await c.env.BUCKET.delete(row.r2_key);
	return c.body(null, 204);
});

app.post("/api/v1/mailboxes/:mailboxId/memory/:id/summarize", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const id = c.req.param("id")!;
	const row = await (c.var.mailboxStub as any).getMemoryFile(id);
	if (!row) return c.json({ error: "Not found" }, 404);
	if (!row.content?.trim()) return c.json({ error: "No content to summarize" }, 400);
	try {
		const summary = await summarizeMemoryFile(c.env, mailboxId, row.content);
		await (c.var.mailboxStub as any).updateMemorySummary(id, summary);
		return c.json({ summary });
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : "Summarization failed" }, 500);
	}
});

// -- Templates --------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/templates", async (c: AppContext) => {
	return c.json(await (c.var.mailboxStub as any).listTemplates());
});

app.post("/api/v1/mailboxes/:mailboxId/templates", async (c: AppContext) => {
	const { title, body, tags } = (await c.req.json()) as {
		title?: string;
		body?: string;
		tags?: string;
	};
	if (!title?.trim() || !body?.trim()) {
		return c.json({ error: "title and body are required" }, 400);
	}
	const id = crypto.randomUUID();
	const row = await (c.var.mailboxStub as any).createTemplate({
		id,
		title: title.trim(),
		body: body.trim(),
		tags,
	});
	return c.json(row, 201);
});

app.put("/api/v1/mailboxes/:mailboxId/templates/:id", async (c: AppContext) => {
	const { title, body, tags } = (await c.req.json()) as {
		title?: string;
		body?: string;
		tags?: string;
	};
	const row = await (c.var.mailboxStub as any).updateTemplate(c.req.param("id")!, { title, body, tags });
	return row ? c.json(row) : c.json({ error: "Not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/templates/:id", async (c: AppContext) => {
	const row = await (c.var.mailboxStub as any).deleteTemplate(c.req.param("id")!);
	return row ? c.body(null, 204) : c.json({ error: "Not found" }, 404);
});

// -- Rosters ----------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/rosters", async (c: AppContext) => {
	return c.json(await (c.var.mailboxStub as any).listRosters());
});

app.post("/api/v1/mailboxes/:mailboxId/rosters", async (c: AppContext) => {
	const { name, students } = (await c.req.json()) as {
		name?: string;
		students?: { name?: string; email: string }[];
	};
	if (!name?.trim() || !Array.isArray(students)) {
		return c.json({ error: "name and students are required" }, 400);
	}
	const validStudents = students.filter((s) => typeof s.email === "string" && s.email.trim());
	const id = crypto.randomUUID();
	const row = await (c.var.mailboxStub as any).createRoster(id, name.trim(), validStudents);
	return c.json(row, 201);
});

app.get("/api/v1/mailboxes/:mailboxId/rosters/:id/students", async (c: AppContext) => {
	return c.json(await (c.var.mailboxStub as any).listStudents(c.req.param("id")!));
});

app.delete("/api/v1/mailboxes/:mailboxId/rosters/:id", async (c: AppContext) => {
	const row = await (c.var.mailboxStub as any).deleteRoster(c.req.param("id")!);
	return row ? c.body(null, 204) : c.json({ error: "Not found" }, 404);
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

	const agentStub = env.EMAIL_AGENT.get(env.EMAIL_AGENT.idFromName(mailboxId));
	ctx.waitUntil(agentStub.fetch(new Request("https://agents/onNewEmail", {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ mailboxId, emailId: messageId, sender: (parsedEmail.from?.address || "").toLowerCase(), subject: parsedEmail.subject || "", threadId }),
	})).catch((e) => console.error("Auto-draft trigger failed:", (e as Error).message)));
}

export { app, receiveEmail };
