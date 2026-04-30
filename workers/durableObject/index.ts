// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { eq, and, or, asc, desc, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as schema from "../db/schema";
import { Folders } from "../../shared/folders";
import type { Env } from "../types";
import { applyMigrations, mailboxMigrations } from "./migrations";
import { attachmentObjectKey } from "../lib/attachments";

/**
 * SQL expression to normalize email subjects by stripping common
 * reply/forward prefixes (Re:, Fwd:, FW:, AW:, WG:, Réf:, SV:).
 * Used for conversation grouping. Hardcoded to the `subject` column.
 */
const NORMALIZED_SUBJECT_SQL = `LOWER(TRIM(
	REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
		LOWER(subject),
		'aw: ', ''), 'wg: ', ''), 'réf: ', ''), 'sv: ', ''),
		're: ', ''), 'fwd: ', ''), 'fw: ', '')
))`;

const ALLOWED_SORT_COLUMNS = [
	"id",
	"subject",
	"sender",
	"recipient",
	"date",
	"read",
	"starred",
] as const;

type SortColumn = (typeof ALLOWED_SORT_COLUMNS)[number];

/**
 * Map SortColumn string names to Drizzle column references for safe
 * ORDER BY construction (no string interpolation into SQL).
 */
const SORT_COLUMN_MAP = {
	id: schema.emails.id,
	subject: schema.emails.subject,
	sender: schema.emails.sender,
	recipient: schema.emails.recipient,
	date: schema.emails.date,
	read: schema.emails.read,
	starred: schema.emails.starred,
} satisfies Record<SortColumn, typeof schema.emails[keyof typeof schema.emails]>;

interface SearchFilterOptions {
	query: string;
	folder?: string;
	from?: string;
	to?: string;
	subject?: string;
	date_start?: string;
	date_end?: string;
	is_read?: boolean;
	is_starred?: boolean;
	has_attachment?: boolean;
}

interface GetEmailsOptions {
	folder?: string;
	thread_id?: string;
	page?: number;
	limit?: number;
	sortColumn?: SortColumn;
	sortDirection?: "ASC" | "DESC";
}

interface EmailData {
	id: string;
	subject: string;
	sender: string;
	recipient: string;
	cc?: string | null;
	bcc?: string | null;
	date: string;
	body: string;
	read?: boolean;
	starred?: boolean;
	in_reply_to?: string | null;
	email_references?: string | null;
	thread_id?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
}

interface AttachmentData {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string | null;
	disposition?: string | null;
}

export class MailboxDO extends DurableObject<Env> {
	declare __DURABLE_OBJECT_BRAND: never;
	db: ReturnType<typeof drizzle>;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.db = drizzle(this.ctx.storage, { schema });
		applyMigrations(this.ctx.storage.sql, mailboxMigrations, this.ctx.storage);
	}

	// ── Realtime event stream (WebSocket, hibernation API) ─────────
	//
	// Foreground "new mail" notifications. Clients open a WebSocket via
	// `GET /api/v1/mailboxes/:id/events` (see workers/index.ts) and the
	// inbound email handler calls `notifyNewEmail` after the sync security
	// verdict so quarantined mail doesn't surface as a desktop notification.

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade") !== "websocket") {
			return new Response("Expected WebSocket upgrade", { status: 426 });
		}
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
		this.ctx.acceptWebSocket(server);
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(_ws: WebSocket, _msg: ArrayBuffer | string) {
		// Server-push only; ignore anything the client sends.
	}

	async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean) {
		try { ws.close(code, "closing"); } catch { /* already closed */ }
	}

	async webSocketError(_ws: WebSocket, _err: unknown) {
		// Hibernation API requires the handler; nothing to do.
	}

	async notifyNewEmail(emailId: string, folderId: string) {
		const payload = JSON.stringify({ type: "new-email", id: emailId, folder: folderId });
		for (const ws of this.ctx.getWebSockets()) {
			try { ws.send(payload); } catch { /* dead socket — hibernation will GC */ }
		}
	}

	// ── Email CRUD (Drizzle) ───────────────────────────────────────

	async getEmails(options: GetEmailsOptions = {}) {
		const {
			folder,
			thread_id,
			page = 1,
			limit: rawLimit = 25,
			sortColumn: rawSortColumn = "date",
			sortDirection = "DESC",
		} = options;

		// Cap pagination limit to prevent unbounded queries
		const limit = Math.min(Math.max(rawLimit, 1), 100);

		const sortColumn: SortColumn = ALLOWED_SORT_COLUMNS.includes(
			rawSortColumn as SortColumn,
		)
			? rawSortColumn
			: "date";

		const offset = (page - 1) * limit;

		const conditions: SQL[] = [];
		if (folder) {
			conditions.push(
				sql`${schema.emails.folder_id} = (SELECT id FROM folders WHERE name = ${folder} OR id = ${folder} LIMIT 1)`,
			);
		}
		if (thread_id) {
			conditions.push(eq(schema.emails.thread_id, thread_id));
		}

		const orderCol = SORT_COLUMN_MAP[sortColumn];
		const orderDir = sortDirection === "ASC" ? asc(orderCol) : desc(orderCol);

		const result = this.db
			.select({
				id: schema.emails.id,
				subject: schema.emails.subject,
				sender: schema.emails.sender,
				recipient: schema.emails.recipient,
				cc: schema.emails.cc,
				bcc: schema.emails.bcc,
				date: schema.emails.date,
				read: schema.emails.read,
				starred: schema.emails.starred,
				in_reply_to: schema.emails.in_reply_to,
				email_references: schema.emails.email_references,
				thread_id: schema.emails.thread_id,
				folder_id: schema.emails.folder_id,
				security_verdict: schema.emails.security_verdict,
				security_score: schema.emails.security_score,
				security_explanation: schema.emails.security_explanation,
				snippet: sql<string>`SUBSTR(${schema.emails.body}, 1, 300)`,
			})
			.from(schema.emails)
			.where(conditions.length > 0 ? and(...conditions) : undefined)
			.orderBy(orderDir)
			.limit(limit)
			.offset(offset)
			.all();

		return result.map((email) => ({
			...email,
			read: !!email.read,
			starred: !!email.starred,
		}));
	}

	/**
	 * Count total emails matching the given filters (for pagination).
	 */
	async countEmails(options: { folder?: string; thread_id?: string } = {}) {
		const { folder, thread_id } = options;
		const conditions: string[] = [];
		const params: (string | number)[] = [];

		if (folder) {
			conditions.push(
				"folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)",
			);
			params.push(folder);
		}

		if (thread_id) {
			conditions.push(`thread_id = ?${params.length + 1}`);
			params.push(thread_id);
		}

		const where =
			conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const row = [
			...this.ctx.storage.sql.exec(
				`SELECT COUNT(*) as total FROM emails ${where}`,
				...params,
			),
		][0] as { total: number } | undefined;

		return row?.total ?? 0;
	}

	// ── Threaded queries (raw SQL — too complex for Drizzle's builder) ──

	async getThreadedEmails(options: GetEmailsOptions = {}) {
		const {
			folder,
			page = 1,
			limit: rawLimit = 25,
		} = options;
		const limit = Math.min(Math.max(rawLimit, 1), 100);

		if (!folder) {
			// Fallback to regular getEmails if no folder specified
			return this.getEmails(options);
		}

		const offset = (page - 1) * limit;

		// Thread grouping strategy:
		// For DRAFT folder: group by in_reply_to (the email being replied to).
		//   This ensures reply-drafts to different emails stay separate, even if
		//   they share a thread_id or subject. New drafts (no in_reply_to) each
		//   get their own group via their unique id.
		// For other folders:
		//   1. Primary: group by thread_id (from email threading headers)
		//   2. Fallback: group by normalized subject (strips Re:/Fwd:/FW: prefixes)
		//      for legacy emails that lack threading headers (thread_id IS NULL).
		const isDraftFolder = folder === Folders.DRAFT;

		if (isDraftFolder) {
			const result = this.ctx.storage.sql.exec(
				`WITH
				folder_emails AS (
					SELECT *,
						COALESCE(in_reply_to, id) as draft_group_key
					FROM emails
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				),
				draft_stats AS (
					SELECT
						draft_group_key,
						COUNT(*) as thread_count,
						SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as thread_unread_count,
						GROUP_CONCAT(DISTINCT sender) as participants
					FROM folder_emails
					GROUP BY draft_group_key
				),
				latest_per_group AS (
					SELECT
						fe.*,
						ROW_NUMBER() OVER (
							PARTITION BY fe.draft_group_key
							ORDER BY fe.date DESC
						) as rn
					FROM folder_emails fe
				)
				SELECT
					lp.id, lp.subject, lp.sender, lp.recipient, lp.date,
					lp.read, lp.starred, lp.thread_id, lp.folder_id,
					lp.in_reply_to, lp.email_references,
					SUBSTR(lp.body, 1, 300) as snippet,
					ds.thread_count, ds.thread_unread_count, ds.participants
				FROM latest_per_group lp
				JOIN draft_stats ds ON lp.draft_group_key = ds.draft_group_key
				WHERE lp.rn = 1
				ORDER BY lp.date DESC
				LIMIT ?2 OFFSET ?3`,
				folder, limit, offset
			);

			const rows = [...result];
			return rows.map((row: any) => ({
				...row,
				read: !!row.read,
				starred: !!row.starred,
				thread_count: row.thread_count || 1,
				thread_unread_count: row.thread_unread_count || 0,
				participants: row.participants || row.sender,
			}));
		}

		// Non-draft folders: full threading logic
		const result = this.ctx.storage.sql.exec(
			`WITH
			folder_emails AS (
				SELECT *,
					COALESCE(thread_id, id) as raw_thread_id,
					${NORMALIZED_SUBJECT_SQL} as normalized_subject
				FROM emails
				WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
			),
			thread_to_conversation AS (
				SELECT
					raw_thread_id,
					normalized_subject,
					CASE
						WHEN thread_id IS NOT NULL THEN raw_thread_id
						ELSE MIN(raw_thread_id) OVER (PARTITION BY normalized_subject)
					END as conversation_id
				FROM folder_emails
				GROUP BY raw_thread_id, normalized_subject, thread_id
			),
			all_emails_with_conversation AS (
				SELECT
					e.*,
					COALESCE(tc.conversation_id, COALESCE(e.thread_id, e.id)) as conversation_id
				FROM emails e
				LEFT JOIN thread_to_conversation tc
					ON COALESCE(e.thread_id, e.id) = tc.raw_thread_id
			),
			conversation_stats AS (
				SELECT
					conversation_id,
					COUNT(*) as thread_count,
					SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as thread_unread_count,
					SUM(CASE WHEN read = 1 THEN 1 ELSE 0 END) as thread_read_count,
					GROUP_CONCAT(DISTINCT sender) as participants,
					SUM(CASE WHEN folder_id = (SELECT id FROM folders WHERE name = 'draft' LIMIT 1) THEN 1 ELSE 0 END) as has_draft
				FROM all_emails_with_conversation
				WHERE conversation_id IN (
					SELECT DISTINCT conversation_id FROM all_emails_with_conversation
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				)
				GROUP BY conversation_id
			),
			latest_message_per_conversation AS (
				SELECT
					conversation_id,
					folder_id,
					ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY date DESC) as rn
				FROM all_emails_with_conversation
			),
			latest_in_folder AS (
				SELECT
					fe.*,
					COALESCE(tc.conversation_id, fe.raw_thread_id) as conversation_id,
					ROW_NUMBER() OVER (
						PARTITION BY COALESCE(tc.conversation_id, fe.raw_thread_id)
						ORDER BY fe.date DESC
					) as rn
				FROM folder_emails fe
				LEFT JOIN thread_to_conversation tc
					ON fe.raw_thread_id = tc.raw_thread_id
			)
			SELECT
				lif.id, lif.subject, lif.sender, lif.recipient, lif.date,
				lif.read, lif.starred, lif.thread_id, lif.folder_id,
				lif.in_reply_to, lif.email_references,
				SUBSTR(lif.body, 1, 300) as snippet,
				cs.thread_count, cs.thread_unread_count, cs.participants,
				CASE WHEN lmc.folder_id != (SELECT id FROM folders WHERE name = 'sent' LIMIT 1)
					AND lmc.folder_id != (SELECT id FROM folders WHERE name = 'draft' LIMIT 1)
					AND cs.thread_read_count > 0
					THEN 1 ELSE 0 END as needs_reply,
				CASE WHEN cs.has_draft > 0 THEN 1 ELSE 0 END as has_draft
			FROM latest_in_folder lif
			JOIN conversation_stats cs ON lif.conversation_id = cs.conversation_id
			LEFT JOIN latest_message_per_conversation lmc
				ON lmc.conversation_id = lif.conversation_id AND lmc.rn = 1
			WHERE lif.rn = 1
			ORDER BY lif.date DESC
			LIMIT ?2 OFFSET ?3`,
			folder, limit, offset
		);

		const rows = [...result];
		return rows.map((row: any) => ({
			...row,
			read: !!row.read,
			starred: !!row.starred,
			thread_count: row.thread_count || 1,
			thread_unread_count: row.thread_unread_count || 0,
			participants: row.participants || row.sender,
			needs_reply: !!row.needs_reply,
			has_draft: !!row.has_draft,
		}));
	}

	/**
	 * Count threaded conversations in a folder (for pagination).
	 * Returns the number of conversation groups, not individual emails.
	 */
	async countThreadedEmails(folder: string) {
		const isDraftFolder = folder === Folders.DRAFT;

		if (isDraftFolder) {
			const row = [
				...this.ctx.storage.sql.exec(
					`SELECT COUNT(DISTINCT COALESCE(in_reply_to, id)) as total
					 FROM emails
					 WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)`,
					folder,
				),
			][0] as { total: number } | undefined;
			return row?.total ?? 0;
		}

		const row = [
			...this.ctx.storage.sql.exec(
				`WITH
				folder_emails AS (
					SELECT
						COALESCE(thread_id, id) as raw_thread_id,
						thread_id,
					${NORMALIZED_SUBJECT_SQL} as normalized_subject
					FROM emails
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				),
				thread_to_conversation AS (
					SELECT
						raw_thread_id,
						CASE
							WHEN thread_id IS NOT NULL THEN raw_thread_id
							WHEN normalized_subject != '' THEN MIN(raw_thread_id) OVER (PARTITION BY normalized_subject)
							ELSE raw_thread_id
						END as conversation_id
					FROM folder_emails
					GROUP BY raw_thread_id, normalized_subject, thread_id
				)
				SELECT COUNT(DISTINCT conversation_id) as total
				FROM thread_to_conversation`,
				folder,
			),
		][0] as { total: number } | undefined;
		return row?.total ?? 0;
	}

	// ── Single email operations (Drizzle) ──────────────────────────

	async getEmail(id: string) {
		const email = this.db
			.select()
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		if (!email) return null;

		const emailAttachments = this.db
			.select()
			.from(schema.attachments)
			.where(eq(schema.attachments.email_id, id))
			.all();

		return {
			...email,
			read: !!email.read,
			starred: !!email.starred,
			attachments: emailAttachments,
		};
	}

	/**
	 * Fetch all emails in a thread with full bodies and attachments in
	 * two queries (one for emails, one for attachments) instead of
	 * N+1 individual getEmail calls.
	 */
	async getThreadEmails(threadId: string) {
		const emailRows = [
			...this.ctx.storage.sql.exec(
				`SELECT * FROM emails WHERE thread_id = ?1 ORDER BY date ASC`,
				threadId,
			),
		] as any[];

		if (emailRows.length === 0) return [];

		const emailIds = emailRows.map((e) => e.id as string);

		// Batch-fetch all attachments for the thread in a single query
		const placeholders = emailIds.map((_, i) => `?${i + 1}`).join(",");
		const attachmentRows = [
			...this.ctx.storage.sql.exec(
				`SELECT * FROM attachments WHERE email_id IN (${placeholders})`,
				...emailIds,
			),
		] as any[];

		// Group attachments by email_id
		const attachmentsByEmail = new Map<string, any[]>();
		for (const att of attachmentRows) {
			const list = attachmentsByEmail.get(att.email_id) || [];
			list.push(att);
			attachmentsByEmail.set(att.email_id, list);
		}

		return emailRows.map((email) => ({
			...email,
			read: !!email.read,
			starred: !!email.starred,
			attachments: attachmentsByEmail.get(email.id) || [],
		}));
	}

	async updateEmail(
		id: string,
		{ read, starred }: { read?: boolean; starred?: boolean },
	) {
		const data: { read?: number; starred?: number } = {};
		if (read !== undefined) {
			data.read = read ? 1 : 0;
		}
		if (starred !== undefined) {
			data.starred = starred ? 1 : 0;
		}

		if (Object.keys(data).length === 0) {
			return this.getEmail(id);
		}

		this.db
			.update(schema.emails)
			.set(data)
			.where(eq(schema.emails.id, id))
			.run();

		return this.getEmail(id);
	}

	async markThreadRead(threadId: string) {
		this.ctx.storage.sql.exec(
			`UPDATE emails SET read = 1 WHERE thread_id = ? AND read = 0`,
			threadId,
		);
		return { threadId, markedRead: true };
	}

	async deleteEmail(id: string) {
		const email = this.db
			.select({ id: schema.emails.id })
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		if (!email) return null;

		const emailAttachments = this.db
			.select({
				id: schema.attachments.id,
				filename: schema.attachments.filename,
			})
			.from(schema.attachments)
			.where(eq(schema.attachments.email_id, id))
			.all();

		this.db
			.delete(schema.emails)
			.where(eq(schema.emails.id, id))
			.run();

		return emailAttachments;
	}

	async getAttachment(id: string) {
		return (
			this.db
				.select()
				.from(schema.attachments)
				.where(eq(schema.attachments.id, id))
				.get() ?? null
		);
	}

	// ── Folders (Drizzle) ──────────────────────────────────────────

	async getFolders() {
		const result = this.db
			.select({
				id: schema.folders.id,
				name: schema.folders.name,
				unreadCount: sql<number>`COALESCE(SUM(CASE WHEN ${schema.emails.read} = 0 THEN 1 ELSE 0 END), 0)`.mapWith(Number),
			})
			.from(schema.folders)
			.leftJoin(schema.emails, eq(schema.emails.folder_id, schema.folders.id))
			.groupBy(schema.folders.id, schema.folders.name)
			.all();
		return result;
	}

	async createFolder(id: string, name: string, is_deletable: number = 1) {
		try {
			const result = this.db
				.insert(schema.folders)
				.values({ id, name, is_deletable })
				.returning({ id: schema.folders.id, name: schema.folders.name })
				.get();
			return { ...result, unreadCount: 0 };
		} catch (e: unknown) {
			if (e instanceof Error && e.message.includes("UNIQUE constraint failed")) {
				return null;
			}
			throw e;
		}
	}

	async updateFolder(id: string, name: string) {
		const result = this.db
			.update(schema.folders)
			.set({ name })
			.where(eq(schema.folders.id, id))
			.returning({ id: schema.folders.id, name: schema.folders.name })
			.get();
		return result;
	}

	async deleteFolder(id: string) {
		const folder = this.db
			.select({ is_deletable: schema.folders.is_deletable })
			.from(schema.folders)
			.where(eq(schema.folders.id, id))
			.get();

		if (!folder || folder.is_deletable === 0) {
			return false;
		}

		this.db
			.delete(schema.folders)
			.where(eq(schema.folders.id, id))
			.run();

		return true;
	}

	async moveEmail(id: string, folderId: string) {
		const folder = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(eq(schema.folders.id, folderId))
			.get();

		if (!folder) return false;

		this.db
			.update(schema.emails)
			.set({ folder_id: folderId })
			.where(eq(schema.emails.id, id))
			.run();

		return true;
	}

	// ── Search (raw SQL — dynamic condition builder) ───────────────

	/**
	 * Build WHERE conditions and params for search queries.
	 * Shared between searchEmails and countSearchResults.
	 */
	#buildSearchConditions(
		options: SearchFilterOptions,
		tableAlias = "",
	): { conditions: string[]; params: (string | number)[] } {
		const { query, folder, from, to, subject, date_start, date_end, is_read, is_starred, has_attachment } = options;
		const prefix = tableAlias ? `${tableAlias}.` : "";
		const conditions: string[] = [];
		const params: (string | number)[] = [];
		let paramIdx = 0;

		const addParam = (value: string | number) => {
			paramIdx++;
			params.push(value);
			return `?${paramIdx}`;
		};

		if (query) {
			const p1 = addParam(`%${query}%`);
			const p2 = addParam(`%${query}%`);
			const p3 = addParam(`%${query}%`);
			const p4 = addParam(`%${query}%`);
			conditions.push(`(${prefix}subject LIKE ${p1} OR ${prefix}body LIKE ${p2} OR ${prefix}sender LIKE ${p3} OR ${prefix}recipient LIKE ${p4} OR ${prefix}cc LIKE ${p4} OR ${prefix}bcc LIKE ${p4})`);
		}
		if (folder) {
			const p = addParam(folder);
			conditions.push(`${prefix}folder_id = (SELECT id FROM folders WHERE name = ${p} OR id = ${p} LIMIT 1)`);
		}
		if (from) { const p = addParam(`%${from}%`); conditions.push(`${prefix}sender LIKE ${p}`); }
		if (to) { const p = addParam(`%${to}%`); conditions.push(`(${prefix}recipient LIKE ${p} OR ${prefix}cc LIKE ${p} OR ${prefix}bcc LIKE ${p})`); }
		if (subject) { const p = addParam(`%${subject}%`); conditions.push(`${prefix}subject LIKE ${p}`); }
		if (date_start) { const p = addParam(date_start); conditions.push(`${prefix}date >= ${p}`); }
		if (date_end) { const p = addParam(date_end); conditions.push(`${prefix}date <= ${p}`); }
		if (is_read !== undefined) { const p = addParam(is_read ? 1 : 0); conditions.push(`${prefix}read = ${p}`); }
		if (is_starred !== undefined) { const p = addParam(is_starred ? 1 : 0); conditions.push(`${prefix}starred = ${p}`); }
		if (has_attachment) { conditions.push(`${prefix}id IN (SELECT DISTINCT email_id FROM attachments)`); }

		return { conditions, params };
	}

	async searchEmails(options: SearchFilterOptions & { page?: number; limit?: number }) {
		const { page = 1, limit: rawLimit = 25 } = options;
		const limit = Math.min(Math.max(rawLimit, 1), 100);
		const { conditions, params } = this.#buildSearchConditions(options, "e");

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const offset = (page - 1) * limit;

		const query = `
			SELECT e.id, e.subject, e.sender, e.recipient, e.cc, e.bcc, e.date,
				e.read, e.starred, e.in_reply_to, e.email_references,
				e.thread_id, e.folder_id,
				SUBSTR(e.body, 1, 300) as snippet,
				f.name as folder_name
			FROM emails e
			LEFT JOIN folders f ON e.folder_id = f.id
			${where}
			ORDER BY e.date DESC LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`;
		params.push(limit, offset);

		const result = this.ctx.storage.sql.exec(query, ...params);
		return [...result].map((row: any) => ({
			...row,
			read: !!row.read,
			starred: !!row.starred,
		}));
	}

	/**
	 * Count total search results matching the given filters (for pagination).
	 */
	async countSearchResults(options: SearchFilterOptions) {
		const { conditions, params } = this.#buildSearchConditions(options);

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const query = `SELECT COUNT(*) as total FROM emails ${where}`;

		const row = [...this.ctx.storage.sql.exec(query, ...params)][0] as
			| { total: number }
			| undefined;
		return row?.total ?? 0;
	}

	// ── Threading helpers (raw SQL) ────────────────────────────────

	async findThreadBySubject(subject: string, senderAddress?: string): Promise<string | null> {
		const normalized = subject
			.replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "")
			.trim()
			.toLowerCase();

		if (!normalized) return null;

		const result = this.ctx.storage.sql.exec(
			`SELECT thread_id, subject,
			        GROUP_CONCAT(DISTINCT LOWER(sender)) as senders,
			        GROUP_CONCAT(DISTINCT LOWER(recipient)) as recipients
			 FROM emails
			 WHERE thread_id IS NOT NULL
			   AND thread_id != id
			   AND date >= datetime('now', '-7 days')
			 GROUP BY thread_id
			 ORDER BY MAX(date) DESC
			 LIMIT 50`,
		);

		const normalizedSender = senderAddress?.toLowerCase().trim();

		for (const row of result) {
			const rowSubject = String((row as any).subject || "")
				.replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "")
				.trim()
				.toLowerCase();
			if (rowSubject !== normalized) continue;

			if (normalizedSender) {
				const threadSenders = String((row as any).senders || "");
				const threadRecipients = String((row as any).recipients || "");
				const allParticipants = `${threadSenders},${threadRecipients}`;
				if (!allParticipants.includes(normalizedSender)) {
					continue;
				}
			}

			return String((row as any).thread_id);
		}
		return null;
	}

	// ── Rate limiting (raw SQL) ────────────────────────────────────

	/**
	 * Check if the mailbox has exceeded the send rate limit.
	 * Limits: 20 emails per hour, 100 per day per mailbox.
	 * Returns null if under limit, or an error message string if exceeded.
	 */
	async checkSendRateLimit(): Promise<string | null> {
		const hourRow = [...this.ctx.storage.sql.exec(
			`SELECT COUNT(*) as cnt FROM emails
			 WHERE folder_id = ?1
			   AND date >= datetime('now', '-1 hour')`,
			Folders.SENT,
		)][0] as { cnt: number } | undefined;

		if ((hourRow?.cnt ?? 0) >= 20) {
			return "Rate limit exceeded: max 20 emails per hour per mailbox";
		}

		const dayRow = [...this.ctx.storage.sql.exec(
			`SELECT COUNT(*) as cnt FROM emails
			 WHERE folder_id = ?1
			   AND date >= datetime('now', '-1 day')`,
			Folders.SENT,
		)][0] as { cnt: number } | undefined;

		if ((dayRow?.cnt ?? 0) >= 100) {
			return "Rate limit exceeded: max 100 emails per day per mailbox";
		}

		return null;
	}

	// ── Email creation (Drizzle) ───────────────────────────────────

	async createEmail(
		folder: string,
		email: EmailData,
		attachments: AttachmentData[],
	) {
		// Resolve folder name or ID to the actual folder ID.
		const folderRow = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(or(eq(schema.folders.id, folder), eq(schema.folders.name, folder)))
			.limit(1)
			.get();

		if (!folderRow) {
			throw new Error(
				`createEmail: folder "${folder}" not found. ` +
					"Ensure the folder exists before inserting an email.",
			);
		}

		const folderId = folderRow.id;
		const isSent = folderId === Folders.SENT;

		// Sent emails are always read — the sender obviously knows what they wrote.
		// This prevents sent replies from inflating thread_unread_count.
		this.db
			.insert(schema.emails)
			.values({
				id: email.id,
				folder_id: folderId,
				subject: email.subject,
				sender: email.sender,
				recipient: email.recipient,
				cc: email.cc ?? null,
				bcc: email.bcc ?? null,
				date: email.date,
				read: isSent ? 1 : (email.read ? 1 : 0),
				starred: email.starred ? 1 : 0,
				body: email.body,
				in_reply_to: email.in_reply_to ?? null,
				email_references: email.email_references ?? null,
				thread_id: email.thread_id ?? null,
				message_id: email.message_id ?? null,
				raw_headers: email.raw_headers ?? null,
			})
			.run();

		if (attachments.length > 0) {
			this.db.insert(schema.attachments).values(attachments).run();
		}
	}

	// ── Security pipeline persistence ──────────────────────────────

	async persistSecurityVerdict(
		emailId: string,
		data: { verdict_json: string; score: number; explanation: string },
	) {
		this.db
			.update(schema.emails)
			.set({
				security_verdict: data.verdict_json,
				security_score: data.score,
				security_explanation: data.explanation,
			})
			.where(eq(schema.emails.id, emailId))
			.run();
	}

	async insertUrls(
		emailId: string,
		urls: Array<{
			url: string;
			display_text: string | null;
			is_homograph: number;
			is_shortener: number;
		}>,
	) {
		if (urls.length === 0) return;
		this.db
			.insert(schema.urls)
			.values(
				urls.map((u) => ({
					id: crypto.randomUUID(),
					email_id: emailId,
					url: u.url,
					display_text: u.display_text,
					is_homograph: u.is_homograph,
					is_shortener: u.is_shortener,
				})),
			)
			.run();
	}

	/** Read all URL rows for a message — used by the async deep-scan stage. */
	async getUrlsForEmail(emailId: string) {
		return this.db
			.select()
			.from(schema.urls)
			.where(eq(schema.urls.email_id, emailId))
			.all();
	}

	async updateUrlScan(
		urlId: string,
		data: {
			resolved_url?: string | null;
			page_title?: string | null;
			fetch_status?: string;
			verdict?: string | null;
		},
	) {
		this.db
			.update(schema.urls)
			.set(data)
			.where(eq(schema.urls.id, urlId))
			.run();
	}

	async getAttachmentsForEmail(emailId: string) {
		return this.db
			.select()
			.from(schema.attachments)
			.where(eq(schema.attachments.email_id, emailId))
			.all();
	}

	async updateAttachmentScan(
		attachmentId: string,
		data: { scan_status: string; scan_verdict?: string | null },
	) {
		this.db
			.update(schema.attachments)
			.set(data)
			.where(eq(schema.attachments.id, attachmentId))
			.run();
	}

	/**
	 * Enumerate every attachment's R2 object key (`attachments/{email_id}/{id}/{filename}`)
	 * so the mailbox-delete flow can reap R2 blobs before wiping this DO.
	 *
	 * Key construction happens HERE rather than at the caller so the caller
	 * can't mishandle the `filename` field. Filenames are already sanitized
	 * at receive time (`workers/index.ts` strips path separators and control
	 * characters before ever storing to R2), so this mirrors that format.
	 *
	 * v1 returns everything in a single array. A long-lived mailbox can
	 * hold thousands of attachments — still fine here because SQLite-in-DO
	 * is local and the caller batches deletes downstream. If a mailbox
	 * ever reaches hundreds of thousands of rows, add cursor-based paging.
	 */
	async listAllAttachmentKeys(): Promise<string[]> {
		const rows = this.db
			.select({
				id: schema.attachments.id,
				email_id: schema.attachments.email_id,
				filename: schema.attachments.filename,
			})
			.from(schema.attachments)
			.all();
		return rows.map((r) => attachmentObjectKey(r.email_id, r.id, r.filename));
	}

	/**
	 * Wipe ALL state for this mailbox DO. Used by the mailbox-delete flow.
	 *
	 * `ctx.storage.deleteAll()` clears SQLite *and* any KV-style storage
	 * under this DO. The next inbound method call reconstructs the DO:
	 * the constructor re-runs migrations on the empty DB, leaving a fresh
	 * mailbox identical to one that never existed.
	 *
	 * Callers MUST have already drained external storage (R2 blobs) before
	 * calling this, because the attachment table is the only place those
	 * keys are enumerated.
	 */
	async reset(): Promise<void> {
		await this.ctx.storage.deleteAll();
	}

	async updateDeepScanStatus(emailId: string, status: string) {
		this.db
			.update(schema.emails)
			.set({ deep_scan_status: status })
			.where(eq(schema.emails.id, emailId))
			.run();
	}

	/**
	 * Read the currently-stored verdict blob so a deep-scan can layer its
	 * findings onto the synchronous verdict without losing the earlier
	 * signals. Returns the verdict JSON and the numeric score as stored.
	 */
	async getStoredVerdict(emailId: string) {
		const row = this.db
			.select({
				verdict: schema.emails.security_verdict,
				score: schema.emails.security_score,
				explanation: schema.emails.security_explanation,
			})
			.from(schema.emails)
			.where(eq(schema.emails.id, emailId))
			.get();
		return row ?? null;
	}

	async getSenderReputation(sender: string) {
		const row = this.db
			.select()
			.from(schema.senderReputation)
			.where(eq(schema.senderReputation.sender, sender))
			.get();
		if (!row) return null;
		return {
			sender: row.sender,
			first_seen: row.first_seen,
			last_seen: row.last_seen,
			message_count: row.message_count,
			avg_score: row.avg_score,
			flagged: row.flagged === 1,
		};
	}

	async upsertSenderReputation(sender: string, newScore: number) {
		const now = new Date().toISOString();
		// Rolling average, capped so an old sender can still be retrained.
		const existing = this.db
			.select()
			.from(schema.senderReputation)
			.where(eq(schema.senderReputation.sender, sender))
			.get();
		if (!existing) {
			this.db
				.insert(schema.senderReputation)
				.values({
					sender,
					first_seen: now,
					last_seen: now,
					message_count: 1,
					avg_score: newScore,
					flagged: 0,
				})
				.run();
			return;
		}
		const cappedCount = Math.min(existing.message_count, 1000);
		const newAvg = (existing.avg_score * cappedCount + newScore) / (cappedCount + 1);
		this.db
			.update(schema.senderReputation)
			.set({
				last_seen: now,
				message_count: cappedCount + 1,
				avg_score: newAvg,
			})
			.where(eq(schema.senderReputation.sender, sender))
			.run();
	}

	async flagSender(sender: string, flagged: boolean) {
		this.db
			.update(schema.senderReputation)
			.set({ flagged: flagged ? 1 : 0 })
			.where(eq(schema.senderReputation.sender, sender))
			.run();
	}

	// ── Threat intel feed state ────────────────────────────────────

	async getIntelFeedState(feedId: string) {
		return this.db
			.select()
			.from(schema.intelFeedState)
			.where(eq(schema.intelFeedState.feed_id, feedId))
			.get() ?? null;
	}

	async upsertIntelFeedState(
		feedId: string,
		data: {
			url: string;
			last_fetched_at: string;
			etag: string | null;
			entry_count: number;
			bloom_kv_key: string;
		},
	) {
		const existing = this.db
			.select()
			.from(schema.intelFeedState)
			.where(eq(schema.intelFeedState.feed_id, feedId))
			.get();
		if (!existing) {
			this.db
				.insert(schema.intelFeedState)
				.values({ feed_id: feedId, ...data })
				.run();
		} else {
			this.db
				.update(schema.intelFeedState)
				.set(data)
				.where(eq(schema.intelFeedState.feed_id, feedId))
				.run();
		}
	}

	// ── DMARC ──────────────────────────────────────────────────────

	async insertDmarcReport(
		report: {
			id: string;
			received_at: string;
			org_name: string | null;
			report_id: string | null;
			domain: string;
			date_range_begin: string | null;
			date_range_end: string | null;
			policy_p: string | null;
			raw_r2_key: string | null;
		},
		records: Array<{
			id: string;
			source_ip: string;
			count: number;
			disposition: string | null;
			dkim_result: string | null;
			spf_result: string | null;
			header_from: string | null;
		}>,
	) {
		this.db.insert(schema.dmarcReports).values(report).run();
		if (records.length > 0) {
			this.db
				.insert(schema.dmarcRecords)
				.values(records.map((r) => ({ ...r, report_id: report.id })))
				.run();
		}
	}

	async listDmarcReports(options: { domain?: string; limit?: number; offset?: number } = {}) {
		const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
		const offset = Math.max(options.offset ?? 0, 0);
		const conditions: SQL[] = [];
		if (options.domain) conditions.push(eq(schema.dmarcReports.domain, options.domain));
		return this.db
			.select()
			.from(schema.dmarcReports)
			.where(conditions.length > 0 ? and(...conditions) : undefined)
			.orderBy(desc(schema.dmarcReports.received_at))
			.limit(limit)
			.offset(offset)
			.all();
	}

	async getDmarcRecords(reportId: string) {
		return this.db
			.select()
			.from(schema.dmarcRecords)
			.where(eq(schema.dmarcRecords.report_id, reportId))
			.all();
	}

	// ── Cases (TheHive-lite) ───────────────────────────────────────

	async createCase(input: {
		title: string;
		notes?: string;
		emailId?: string;
		observables?: Array<{ kind: string; value: string }>;
	}) {
		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		this.db
			.insert(schema.cases)
			.values({
				id,
				created_at: now,
				updated_at: now,
				status: "open",
				title: input.title.slice(0, 500),
				notes: input.notes ?? null,
				shared_to_hub: 0,
				hub_event_uuid: null,
			})
			.run();
		if (input.emailId) {
			this.db.insert(schema.caseEmails).values({ case_id: id, email_id: input.emailId }).run();
		}
		if (input.observables && input.observables.length > 0) {
			this.db
				.insert(schema.caseObservables)
				.values(input.observables.map((o) => ({
					id: crypto.randomUUID(),
					case_id: id,
					kind: o.kind,
					value: o.value,
				})))
				.run();
		}
		return { id };
	}

	async listCases(options: { status?: string; limit?: number; offset?: number } = {}) {
		const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
		const offset = Math.max(options.offset ?? 0, 0);
		const conditions: SQL[] = [];
		if (options.status) conditions.push(eq(schema.cases.status, options.status));
		return this.db
			.select()
			.from(schema.cases)
			.where(conditions.length > 0 ? and(...conditions) : undefined)
			.orderBy(desc(schema.cases.updated_at))
			.limit(limit)
			.offset(offset)
			.all();
	}

	async getCase(id: string) {
		const row = this.db
			.select()
			.from(schema.cases)
			.where(eq(schema.cases.id, id))
			.get();
		if (!row) return null;
		const emails = this.db
			.select()
			.from(schema.caseEmails)
			.where(eq(schema.caseEmails.case_id, id))
			.all();
		const observables = this.db
			.select()
			.from(schema.caseObservables)
			.where(eq(schema.caseObservables.case_id, id))
			.all();
		return { ...row, emails, observables };
	}

	async updateCase(
		id: string,
		changes: {
			status?: string;
			notes?: string;
			shared_to_hub?: boolean;
			hub_event_uuid?: string | null;
		},
	) {
		const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
		if (changes.status !== undefined) patch.status = changes.status;
		if (changes.notes !== undefined) patch.notes = changes.notes;
		if (changes.shared_to_hub !== undefined) patch.shared_to_hub = changes.shared_to_hub ? 1 : 0;
		if (changes.hub_event_uuid !== undefined) patch.hub_event_uuid = changes.hub_event_uuid;
		this.db
			.update(schema.cases)
			.set(patch)
			.where(eq(schema.cases.id, id))
			.run();
	}

	async deleteCase(id: string) {
		this.db.delete(schema.cases).where(eq(schema.cases.id, id)).run();
	}

	async addCaseObservable(caseId: string, kind: string, value: string) {
		const id = crypto.randomUUID();
		this.db
			.insert(schema.caseObservables)
			.values({ id, case_id: caseId, kind, value })
			.run();
		return { id };
	}

	async getDmarcSummary(domain: string) {
		// Aggregate per-source-IP over the last 90 days. Raw SQL for the
		// multi-column GROUP BY + derived rates.
		const rows = [
			...this.ctx.storage.sql.exec(
				`SELECT
				   r.source_ip as source_ip,
				   SUM(r.count) as total_count,
				   SUM(CASE WHEN r.dkim_result = 'pass' AND r.spf_result = 'pass' THEN r.count ELSE 0 END) as pass_count,
				   SUM(CASE WHEN r.disposition = 'quarantine' THEN r.count ELSE 0 END) as quarantine_count,
				   SUM(CASE WHEN r.disposition = 'reject' THEN r.count ELSE 0 END) as reject_count,
				   MIN(rep.received_at) as first_seen,
				   MAX(rep.received_at) as last_seen
				 FROM dmarc_records r
				 JOIN dmarc_reports rep ON rep.id = r.report_id
				 WHERE rep.domain = ?1
				 GROUP BY r.source_ip
				 ORDER BY total_count DESC
				 LIMIT 200`,
				domain,
			),
		] as Array<{
			source_ip: string;
			total_count: number;
			pass_count: number;
			quarantine_count: number;
			reject_count: number;
			first_seen: string;
			last_seen: string;
		}>;
		return rows;
	}

	/**
	 * Aggregate the operations dashboard payload in one round-trip from the
	 * UI. Each card lives in its own indexed query — see
	 * `migrations.ts/11_dashboard_indexes` for the supporting indexes.
	 *
	 * Pipeline-success is derived from `emails.deep_scan_status` because we
	 * don't yet log per-run latency; tracked as a follow-up. Hub
	 * "contributions" is the local proxy `cases.shared_to_hub`; real
	 * cross-org corroboration would require a hub-side query and is also
	 * tracked separately.
	 */
	async getDashboardSummary(opts: { now?: string } = {}) {
		const nowIso = opts.now ?? new Date().toISOString();
		const dayAgoIso = new Date(
			new Date(nowIso).getTime() - 24 * 60 * 60 * 1000,
		).toISOString();

		const threatsBlocked = (
			this.db
				.select({ count: sql<number>`COUNT(*)` })
				.from(schema.cases)
				.where(
					and(
						eq(schema.cases.status, "closed-tp"),
						sql`${schema.cases.updated_at} >= ${dayAgoIso}`,
					),
				)
				.get() ?? { count: 0 }
		).count;

		const openCases = (
			this.db
				.select({ count: sql<number>`COUNT(*)` })
				.from(schema.cases)
				.where(eq(schema.cases.status, "open"))
				.get() ?? { count: 0 }
		).count;

		const hubContributions = (
			this.db
				.select({ count: sql<number>`COUNT(*)` })
				.from(schema.cases)
				.where(
					and(
						eq(schema.cases.shared_to_hub, 1),
						sql`${schema.cases.updated_at} >= ${dayAgoIso}`,
					),
				)
				.get() ?? { count: 0 }
		).count;

		const scanStatusRows = this.db
			.select({
				status: schema.emails.deep_scan_status,
				count: sql<number>`COUNT(*)`,
			})
			.from(schema.emails)
			.where(sql`${schema.emails.date} >= ${dayAgoIso}`)
			.groupBy(schema.emails.deep_scan_status)
			.all();
		const completed = scanStatusRows.find((r) => r.status === "completed")?.count ?? 0;
		const failed = scanStatusRows.find((r) => r.status === "failed")?.count ?? 0;

		const verdictRows = this.db
			.select({
				date: schema.emails.date,
				security_verdict: schema.emails.security_verdict,
			})
			.from(schema.emails)
			.where(sql`${schema.emails.date} >= ${dayAgoIso}`)
			.all();

		const recentCases = this.db
			.select({
				id: schema.cases.id,
				title: schema.cases.title,
				status: schema.cases.status,
				updated_at: schema.cases.updated_at,
			})
			.from(schema.cases)
			.orderBy(desc(schema.cases.updated_at))
			.limit(5)
			.all();

		return {
			now: nowIso,
			threatsBlocked,
			openCases,
			hubContributions,
			pipelineScan: { completed, failed },
			verdictRows,
			recentCases,
		};
	}
}
