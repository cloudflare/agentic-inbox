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
import { refreshMicrosoftToken, renewGraphSubscription } from "../lib/microsoft-graph";
import { decryptToken, encryptToken } from "../lib/token-crypto";

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

interface ProductivityItemData {
	id?: string;
	kind: string;
	provider: string;
	providerId?: string | null;
	accountId?: string | null;
	title: string;
	body?: string | null;
	startAt?: string | null;
	endAt?: string | null;
	dueAt?: string | null;
	status?: string;
	sourceEmailId?: string | null;
	payloadJson?: string | null;
}

export class MailboxDO extends DurableObject<Env> {
	declare __DURABLE_OBJECT_BRAND: never;
	db: ReturnType<typeof drizzle>;
	private readonly runtimeEnv: Env;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.runtimeEnv = env;
		this.db = drizzle(this.ctx.storage, { schema });
		applyMigrations(this.ctx.storage.sql, mailboxMigrations, this.ctx.storage);
	}

	async alarm() {
		const accountRef = (await this.listConnectedAccounts()).find((candidate: any) => candidate.provider === "microsoft") as { id?: string } | undefined;
		const account = accountRef?.id ? await this.getConnectedAccount(accountRef.id) : undefined;
		const subscriptions = await this.listGraphSubscriptions();
		if (!account?.tokenCiphertext || subscriptions.length === 0) return;
		try {
			let token = JSON.parse(await decryptToken(this.runtimeEnv.TOKEN_ENCRYPTION_KEY, account.tokenCiphertext)) as { access_token?: string; refresh_token?: string; expires_at?: number };
			if ((!token.access_token || (token.expires_at && token.expires_at <= Date.now())) && token.refresh_token) {
				const refreshed = await refreshMicrosoftToken(this.runtimeEnv, token.refresh_token);
				await this.updateConnectedAccountToken(account.id, await encryptToken(this.runtimeEnv.TOKEN_ENCRYPTION_KEY, refreshed));
				token = refreshed as typeof token;
			}
			if (!token.access_token) return;
			for (const subscription of subscriptions) {
				const renewed = await renewGraphSubscription(token.access_token, String(subscription.id));
				await this.upsertGraphSubscription({ id: renewed.id, provider: "microsoft", resource: String(subscription.resource), expirationAt: renewed.expirationDateTime });
			}
		} catch (error) {
			console.error("Graph subscription renewal failed", error);
		} finally {
			this.ctx.storage.setAlarm(Date.now() + 45 * 60 * 1000);
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

	async bulkMarkRead(ids: string[], read: boolean) {
		if (ids.length === 0) return { updated: 0 };
		const placeholders = ids.map((_, i) => `?${i + 2}`).join(",");
		this.ctx.storage.sql.exec(
			`UPDATE emails SET read = ?1 WHERE id IN (${placeholders})`,
			read ? 1 : 0,
			...ids,
		);
		return { updated: ids.length };
	}

	async bulkMoveEmails(ids: string[], folderId: string) {
		const folder = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(eq(schema.folders.id, folderId))
			.get();

		if (!folder) return { moved: 0, error: "Folder not found" };
		if (ids.length === 0) return { moved: 0 };

		const placeholders = ids.map((_, i) => `?${i + 2}`).join(",");
		this.ctx.storage.sql.exec(
			`UPDATE emails SET folder_id = ?1 WHERE id IN (${placeholders})`,
			folderId,
			...ids,
		);
		return { moved: ids.length };
	}

	// ── Memory files ─────────────────────────────────────────────

	async createMemoryFile(params: {
		id: string;
		title: string;
		tags?: string;
		content: string;
		r2_key: string;
		status?: string;
		source_type?: string;
		word_count?: number;
		token_count?: number;
		source_kind?: string;
		source_uri?: string;
		external_id?: string;
		parent_id?: string;
		checksum?: string;
		draft_eligible?: number;
	}) {
		const now = new Date().toISOString();
		return this.db
			.insert(schema.memoryFiles)
			.values({
				...params,
				status: params.status ?? "ready",
				source_type: params.source_type ?? "text",
				created_at: now,
				updated_at: now,
			})
			.returning()
			.get();
	}

	async listMemoryFiles() {
		return this.db
			.select({
				id: schema.memoryFiles.id,
				title: schema.memoryFiles.title,
				tags: schema.memoryFiles.tags,
				status: schema.memoryFiles.status,
				source_type: schema.memoryFiles.source_type,
				error_message: schema.memoryFiles.error_message,
				word_count: schema.memoryFiles.word_count,
				token_count: schema.memoryFiles.token_count,
				summary: schema.memoryFiles.summary,
				source_kind: schema.memoryFiles.source_kind,
				source_uri: schema.memoryFiles.source_uri,
				external_id: schema.memoryFiles.external_id,
				parent_id: schema.memoryFiles.parent_id,
				draft_eligible: schema.memoryFiles.draft_eligible,
				last_indexed_at: schema.memoryFiles.last_indexed_at,
				created_at: schema.memoryFiles.created_at,
				updated_at: schema.memoryFiles.updated_at,
			})
			.from(schema.memoryFiles)
			.orderBy(desc(schema.memoryFiles.created_at))
			.all();
	}

	async getMemoryFile(id: string) {
		return (
			this.db
				.select()
				.from(schema.memoryFiles)
				.where(eq(schema.memoryFiles.id, id))
				.get() ?? null
		);
	}

	async getMemoryFileByExternalId(externalId: string) {
		return this.db.select().from(schema.memoryFiles).where(eq(schema.memoryFiles.external_id, externalId)).get() ?? null;
	}

	async updateMemoryFileStatus(
		id: string,
		status: string,
		params?: {
			content?: string;
			error_message?: string;
			word_count?: number;
			token_count?: number;
		},
	) {
		return this.db
			.update(schema.memoryFiles)
			.set({
				status,
				...(params?.content !== undefined ? { content: params.content } : {}),
				...(params?.word_count !== undefined ? { word_count: params.word_count } : {}),
				...(params?.token_count !== undefined ? { token_count: params.token_count } : {}),
				error_message: params?.error_message ?? null,
				updated_at: new Date().toISOString(),
			})
			.where(eq(schema.memoryFiles.id, id))
			.run();
	}

	async updateMemoryFileMetadata(id: string, params: { title?: string; tags?: string; parent_id?: string; draft_eligible?: number }) {
		const row = this.db
			.select({ id: schema.memoryFiles.id })
			.from(schema.memoryFiles)
			.where(eq(schema.memoryFiles.id, id))
			.get();
		if (!row) return null;

		this.db
			.update(schema.memoryFiles)
			.set({
				...(params.title !== undefined ? { title: params.title } : {}),
				...(params.tags !== undefined ? { tags: params.tags } : {}),
				...(params.parent_id !== undefined ? { parent_id: params.parent_id || null } : {}),
				...(params.draft_eligible !== undefined ? { draft_eligible: params.draft_eligible } : {}),
				updated_at: new Date().toISOString(),
			})
			.where(eq(schema.memoryFiles.id, id))
			.run();

		return this.db.select().from(schema.memoryFiles).where(eq(schema.memoryFiles.id, id)).get();
	}

	async updateMemorySummary(id: string, summary: string) {
		return this.db
			.update(schema.memoryFiles)
			.set({ summary, updated_at: new Date().toISOString() })
			.where(eq(schema.memoryFiles.id, id))
			.run();
	}

	async deleteMemoryFile(id: string) {
		const row = this.db
			.select({ r2_key: schema.memoryFiles.r2_key })
			.from(schema.memoryFiles)
			.where(eq(schema.memoryFiles.id, id))
			.get();

		if (!row) return null;

		this.db
			.delete(schema.memoryFiles)
			.where(eq(schema.memoryFiles.id, id))
			.run();

		return row;
	}

	async replaceMemoryChunks(fileId: string, chunks: Array<{
		id: string;
		heading?: string | null;
		content: string;
		start_offset: number;
		end_offset: number;
		token_count?: number;
	}>) {
		this.db.delete(schema.memoryChunks).where(eq(schema.memoryChunks.memory_file_id, fileId)).run();
		if (chunks.length === 0) return;
		const createdAt = new Date().toISOString();
		this.db.insert(schema.memoryChunks).values(chunks.map((chunk) => ({
			...chunk,
			memory_file_id: fileId,
			heading: chunk.heading ?? null,
			created_at: createdAt,
		}))).run();
		this.db.update(schema.memoryFiles)
			.set({ last_indexed_at: createdAt, updated_at: createdAt })
			.where(eq(schema.memoryFiles.id, fileId))
			.run();
	}

	async listMemoryFacts(status?: string) {
		const rows = this.db.select().from(schema.memoryFacts);
		return status ? rows.where(eq(schema.memoryFacts.status, status)).all() : rows.all();
	}

	async getFirstMemoryChunkId(fileId: string) {
		return this.db.select({ id: schema.memoryChunks.id })
			.from(schema.memoryChunks)
			.where(eq(schema.memoryChunks.memory_file_id, fileId))
			.orderBy(asc(schema.memoryChunks.start_offset))
			.get()?.id ?? null;
	}

	async createMemoryFact(params: {
		id: string;
		kind: string;
		value: string;
		confidence?: number;
		source_chunk_id?: string;
	}) {
		const now = new Date().toISOString();
		return this.db.insert(schema.memoryFacts).values({
			...params,
			status: "suggested",
			created_at: now,
			updated_at: now,
		}).returning().get();
	}

	async updateMemoryFactStatus(id: string, status: "suggested" | "confirmed" | "rejected" | "superseded") {
		return this.db.update(schema.memoryFacts)
			.set({ status, updated_at: new Date().toISOString() })
			.where(eq(schema.memoryFacts.id, id))
			.run();
	}

	async updateMemoryFact(id: string, params: { kind?: string; value?: string }) {
		return this.db.update(schema.memoryFacts)
			.set({
				...(params.kind !== undefined ? { kind: params.kind } : {}),
				...(params.value !== undefined ? { value: params.value } : {}),
				updated_at: new Date().toISOString(),
			})
			.where(eq(schema.memoryFacts.id, id))
			.run();
	}

	async searchMemoryKeyword(query: string, limit = 10) {
		const like = `%${query}%`;
		return [
			...this.ctx.storage.sql.exec(
				`SELECT mf.id, mf.title, mf.tags,
				 COALESCE(SUBSTR(mc.content, MAX(1, INSTR(LOWER(mc.content), LOWER(?1)) - 100), 500),
				 SUBSTR(mf.content, MAX(1, INSTR(LOWER(mf.content), LOWER(?1)) - 100), 500)) as snippet,
				 COALESCE(mc.heading, '') as heading, COALESCE(mc.start_offset, 0) as start_offset,
				 mf.source_kind, mf.source_uri, mf.draft_eligible, mf.created_at
				 FROM memory_files mf LEFT JOIN memory_chunks mc ON mc.memory_file_id = mf.id
				 WHERE mf.status = 'ready' AND mf.draft_eligible = 1 AND
				 (mf.title LIKE ?2 OR mf.tags LIKE ?2 OR mf.content LIKE ?2 OR mc.content LIKE ?2)
				 ORDER BY mf.created_at DESC LIMIT ?3`,
				query,
				like,
				limit,
			),
		];
	}

	async getMemoryFileIds(ids: string[]) {
		if (ids.length === 0) return [];
		const placeholders = ids.map((_, i) => `?${i + 1}`).join(",");
		return [
			...this.ctx.storage.sql.exec(
				`SELECT id, title, tags, SUBSTR(content, 1, 500) as snippet,
				 source_kind, source_uri, draft_eligible FROM memory_files
				 WHERE id IN (${placeholders}) AND status = 'ready' AND draft_eligible = 1`,
				...ids,
			),
		];
	}

	// ── Canned response templates ───────────────────────────────

	async createTemplate(params: { id: string; title: string; body: string; tags?: string }) {
		const now = new Date().toISOString();
		return this.db
			.insert(schema.templates)
			.values({ ...params, created_at: now, updated_at: now })
			.returning()
			.get();
	}

	async listTemplates() {
		return this.db
			.select()
			.from(schema.templates)
			.orderBy(desc(schema.templates.created_at))
			.all();
	}

	async updateTemplate(id: string, params: { title?: string; body?: string; tags?: string }) {
		const row = this.db
			.select({ id: schema.templates.id })
			.from(schema.templates)
			.where(eq(schema.templates.id, id))
			.get();
		if (!row) return null;

		this.db
			.update(schema.templates)
			.set({
				...(params.title !== undefined ? { title: params.title } : {}),
				...(params.body !== undefined ? { body: params.body } : {}),
				...(params.tags !== undefined ? { tags: params.tags } : {}),
				updated_at: new Date().toISOString(),
			})
			.where(eq(schema.templates.id, id))
			.run();

		return this.db.select().from(schema.templates).where(eq(schema.templates.id, id)).get();
	}

	async deleteTemplate(id: string) {
		const row = this.db
			.select({ id: schema.templates.id })
			.from(schema.templates)
			.where(eq(schema.templates.id, id))
			.get();
		if (!row) return null;

		this.db.delete(schema.templates).where(eq(schema.templates.id, id)).run();
		return row;
	}

	// ── Rosters / students ───────────────────────────────────────

	async createRoster(id: string, name: string, students: { name?: string; email: string }[]) {
		const now = new Date().toISOString();
		this.db.insert(schema.rosters).values({ id, name, created_at: now }).run();
		if (students.length > 0) {
			this.db
				.insert(schema.students)
				.values(
					students.map((s) => ({
						id: crypto.randomUUID(),
						roster_id: id,
						name: s.name ?? null,
						email: s.email.toLowerCase(),
						created_at: now,
					})),
				)
				.run();
		}
		return { id, name, studentCount: students.length };
	}

	async listRosters() {
		return [
			...this.ctx.storage.sql.exec(
				`SELECT r.id, r.name, r.created_at,
				 (SELECT COUNT(*) FROM students WHERE students.roster_id = r.id) as studentCount
				 FROM rosters r ORDER BY r.created_at DESC`,
			),
		];
	}

	async listStudents(rosterId: string) {
		return this.db
			.select()
			.from(schema.students)
			.where(eq(schema.students.roster_id, rosterId))
			.all();
	}

	async deleteRoster(id: string) {
		const row = this.db
			.select({ id: schema.rosters.id })
			.from(schema.rosters)
			.where(eq(schema.rosters.id, id))
			.get();
		if (!row) return null;

		this.db.delete(schema.rosters).where(eq(schema.rosters.id, id)).run();
		return row;
	}

	async matchSender(email: string) {
		const row = this.db
			.select({
				studentName: schema.students.name,
				rosterId: schema.students.roster_id,
				rosterName: schema.rosters.name,
			})
			.from(schema.students)
			.innerJoin(schema.rosters, eq(schema.students.roster_id, schema.rosters.id))
			.where(eq(schema.students.email, email.toLowerCase()))
			.get();
		return row ?? null;
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

	// ── Unified productivity state (raw SQL) ───────────────────────

	async upsertConnectedAccount(account: {
		id: string; provider: string; providerAccountId: string; email?: string;
		displayName?: string; tokenCiphertext?: string;
	}) {
		this.ctx.storage.sql.exec(
			`INSERT INTO connected_accounts (id, provider, provider_account_id, email, display_name, token_ciphertext)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(provider, provider_account_id) DO UPDATE SET
			 email = excluded.email, display_name = excluded.display_name,
			 token_ciphertext = COALESCE(excluded.token_ciphertext, connected_accounts.token_ciphertext),
			 status = 'connected', updated_at = datetime('now')`,
			account.id, account.provider, account.providerAccountId, account.email ?? null,
			account.displayName ?? null, account.tokenCiphertext ?? null,
		);
	}

	async updateConnectedAccountToken(id: string, tokenCiphertext: string) {
		this.ctx.storage.sql.exec(`UPDATE connected_accounts SET token_ciphertext = ?, status = 'connected', updated_at = datetime('now') WHERE id = ?`, tokenCiphertext, id);
	}

	async createTopic(topic: { id: string; title: string; content: string; selectedEmailIds: string[] }) {
		this.ctx.storage.sql.exec(`INSERT INTO topics (id, title, content, selected_email_ids) VALUES (?, ?, ?, ?)`, topic.id, topic.title, topic.content, JSON.stringify(topic.selectedEmailIds));
	}

	async updateTopicStatus(id: string, update: { status: string; jobId?: string; mode?: string }) {
		this.ctx.storage.sql.exec(`UPDATE topics SET status = ?, job_id = COALESCE(?, job_id), mode = COALESCE(?, mode), updated_at = datetime('now') WHERE id = ?`, update.status, update.jobId ?? null, update.mode ?? null, id);
	}

	async listTopics() {
		return [...this.ctx.storage.sql.exec(`SELECT id, title, content, selected_email_ids as selectedEmailIds, status, job_id as jobId, mode, created_at as createdAt, updated_at as updatedAt FROM topics ORDER BY created_at DESC LIMIT 100`)].map((row: any) => ({ ...row, selectedEmailIds: JSON.parse(String(row.selectedEmailIds || "[]")) }));
	}

	async listConnectedAccounts() {
		return [...this.ctx.storage.sql.exec(
			`SELECT id, provider, provider_account_id as providerAccountId, email, display_name as displayName, status, created_at as createdAt, updated_at as updatedAt
			 FROM connected_accounts ORDER BY created_at DESC`,
		)];
	}

	async getConnectedAccount(id: string) {
		return [...this.ctx.storage.sql.exec(
			`SELECT id, provider, provider_account_id as providerAccountId, email, display_name as displayName, token_ciphertext as tokenCiphertext, status FROM connected_accounts WHERE id = ? LIMIT 1`, id,
		)][0] as { id: string; provider: string; providerAccountId: string; email: string | null; displayName: string | null; tokenCiphertext: string; status: string } | undefined;
	}

	async upsertSyncedEmail(email: {
		id: string; subject: string; sender: string; recipient: string; date: string;
		body: string; read: boolean; threadId: string | null;
	}) {
		this.ctx.storage.sql.exec(
			`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, read, starred, body, thread_id, message_id)
			 VALUES (?, 'inbox', ?, ?, ?, ?, ?, 0, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET subject = excluded.subject, sender = excluded.sender,
			 recipient = excluded.recipient, date = excluded.date, read = excluded.read,
			 body = excluded.body, thread_id = excluded.thread_id, message_id = excluded.message_id`,
			email.id, email.subject, email.sender, email.recipient, email.date, email.read ? 1 : 0,
			email.body, email.threadId, email.id,
		);
	}

	async createExtraction(extraction: {
		id: string; kind: string; title: string; dueAt?: string | null;
		confidence: number; sourceEmailId: string; sourceThreadId?: string | null;
	}) {
		this.ctx.storage.sql.exec(
			`INSERT OR IGNORE INTO extractions (id, kind, title, due_at, confidence, source_email_id, source_thread_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			extraction.id, extraction.kind, extraction.title, extraction.dueAt ?? null,
			extraction.confidence, extraction.sourceEmailId, extraction.sourceThreadId ?? null,
		);
	}

	async listExtractions(status?: string) {
		const query = status
			? `SELECT id, kind, title, due_at as dueAt, confidence, source_email_id as sourceEmailId, source_thread_id as sourceThreadId, status, created_at as createdAt FROM extractions WHERE status = ? ORDER BY created_at DESC`
			: `SELECT id, kind, title, due_at as dueAt, confidence, source_email_id as sourceEmailId, source_thread_id as sourceThreadId, status, created_at as createdAt FROM extractions ORDER BY created_at DESC`;
		return status ? [...this.ctx.storage.sql.exec(query, status)] : [...this.ctx.storage.sql.exec(query)];
	}

	async commitExtraction(id: string, kind: string, title: string, dueAt?: string | null) {
		this.ctx.storage.sql.exec(
			`UPDATE extractions SET status = 'committed' WHERE id = ?`, id,
		);
		const itemId = `productivity:${id}`;
		this.ctx.storage.sql.exec(
			`INSERT OR REPLACE INTO productivity_items (id, kind, provider, title, due_at, status, source_email_id, updated_at)
			 SELECT ?, ?, 'pending', ?, due_at, 'open', source_email_id, datetime('now') FROM extractions WHERE id = ?`,
			itemId, kind, title, id,
		);
		return { id: itemId, kind, title, dueAt: dueAt ?? null, status: "open" };
	}

	async listProductivityItems() {
		return [...this.ctx.storage.sql.exec(
			`SELECT id, kind, provider, provider_id as providerId, account_id as accountId, title, body, start_at as startAt, end_at as endAt, due_at as dueAt, status, source_email_id as sourceEmailId, payload_json as payloadJson, created_at as createdAt, updated_at as updatedAt
			 FROM productivity_items WHERE status != 'done' ORDER BY COALESCE(due_at, start_at, created_at) ASC LIMIT 100`,
		)];
	}

	async upsertGraphSubscription(subscription: { id: string; provider: string; resource: string; expirationAt: string }) {
		this.ctx.storage.sql.exec(
			`INSERT OR REPLACE INTO graph_subscriptions (id, provider, resource, expiration_at, updated_at)
			 VALUES (?, ?, ?, ?, datetime('now'))`, subscription.id, subscription.provider, subscription.resource, subscription.expirationAt,
		);
		this.ctx.storage.setAlarm(Math.min(Date.parse(subscription.expirationAt) - 10 * 60 * 1000, Date.now() + 45 * 60 * 1000));
	}

	async listGraphSubscriptions() {
		return [...this.ctx.storage.sql.exec(
			`SELECT id, provider, resource, expiration_at as expirationAt, created_at as createdAt, updated_at as updatedAt FROM graph_subscriptions ORDER BY expiration_at ASC`,
		)];
	}

	async getProductivityItemByProvider(provider: string, providerId: string) {
		return [...this.ctx.storage.sql.exec(
			`SELECT id, kind, provider, provider_id as providerId, account_id as accountId, title, body, start_at as startAt, end_at as endAt, due_at as dueAt, status, source_email_id as sourceEmailId, payload_json as payloadJson, created_at as createdAt, updated_at as updatedAt
			 FROM productivity_items WHERE provider = ? AND provider_id = ? LIMIT 1`,
			provider,
			providerId,
		)][0] as Record<string, unknown> | undefined;
	}

	async listProviderProductivityItems(options: {
		provider: string;
		kind?: string;
		accountId?: string;
		status?: string;
		limit?: number;
	}) {
		const conditions = ["provider = ?"];
		const params: Array<string | number> = [options.provider];

		if (options.kind) {
			conditions.push(`kind = ?${params.length + 1}`);
			params.push(options.kind);
		}
		if (options.accountId) {
			conditions.push(`account_id = ?${params.length + 1}`);
			params.push(options.accountId);
		}
		if (options.status) {
			conditions.push(`status = ?${params.length + 1}`);
			params.push(options.status);
		}

		const limit = Math.min(Math.max(options.limit ?? 100, 1), 250);
		params.push(limit);

		return [...this.ctx.storage.sql.exec(
			`SELECT id, kind, provider, provider_id as providerId, account_id as accountId, title, body, start_at as startAt, end_at as endAt, due_at as dueAt, status, source_email_id as sourceEmailId, payload_json as payloadJson, created_at as createdAt, updated_at as updatedAt
			 FROM productivity_items
			 WHERE ${conditions.join(" AND ")}
			 ORDER BY COALESCE(due_at, start_at, updated_at, created_at) ASC
			 LIMIT ?${params.length}`,
			...params,
		)];
	}

	async upsertProviderItem(item: ProductivityItemData) {
		const id = item.id ?? (
			item.providerId
				? `${item.provider}:${item.kind}:${item.providerId}`
				: crypto.randomUUID()
		);
		this.ctx.storage.sql.exec(
			`INSERT INTO productivity_items (
				id, kind, provider, provider_id, account_id, title, body,
				start_at, end_at, due_at, status, source_email_id, payload_json, updated_at
			)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
			 ON CONFLICT(id) DO UPDATE SET
				kind = excluded.kind,
				provider = excluded.provider,
				provider_id = excluded.provider_id,
				account_id = excluded.account_id,
				title = excluded.title,
				body = excluded.body,
				start_at = excluded.start_at,
				end_at = excluded.end_at,
				due_at = excluded.due_at,
				status = excluded.status,
				source_email_id = excluded.source_email_id,
				payload_json = excluded.payload_json,
				updated_at = datetime('now')`,
			id,
			item.kind,
			item.provider,
			item.providerId ?? null,
			item.accountId ?? null,
			item.title,
			item.body ?? null,
			item.startAt ?? null,
			item.endAt ?? null,
			item.dueAt ?? null,
			item.status ?? "open",
			item.sourceEmailId ?? null,
			item.payloadJson ?? null,
		);
		return { ...item, id };
	}

	async upsertProviderItems(items: ProductivityItemData[]) {
		if (items.length === 0) return [];
		return this.ctx.storage.transactionSync(
			() => items.map((item) => this.upsertProviderItem(item)),
		);
	}
}
