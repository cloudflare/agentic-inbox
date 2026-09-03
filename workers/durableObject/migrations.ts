// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Migration {
	name: string;
	sql: string;
}

/**
 * Minimal migration runner that replaces workers-qb's DOQB.migrations().apply().
 *
 * Uses the `d1_migrations` tracking table for backward compatibility with
 * existing deployments that were managed by workers-qb. New deployments
 * create the same table so the schema is consistent either way.
 */
export function applyMigrations(
	sql: SqlStorage,
	migrations: Migration[],
	storage?: DurableObjectStorage,
): void {
	sql.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL UNIQUE,
		applied_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`);

	for (const migration of migrations) {
		const applied = [
			...sql.exec(
				`SELECT 1 FROM d1_migrations WHERE name = ?`,
				migration.name,
			),
		];
		if (applied.length > 0) continue;

		// Strip any existing BEGIN/COMMIT wrapper from the migration SQL.
		// Cloudflare's DO runtime forbids SQL-level transactions -- must use
		// the JS storage.transactionSync() API instead.
		let migrationSql = migration.sql.trim();
		migrationSql = migrationSql.replace(/^\s*BEGIN\s+TRANSACTION\s*;?\s*/i, "");
		migrationSql = migrationSql.replace(/\s*COMMIT\s*;?\s*$/i, "");

		const escapedName = migration.name.replace(/'/g, "''");
		const run = () => {
			sql.exec(migrationSql);
			sql.exec(
				`INSERT INTO d1_migrations (name) VALUES ('${escapedName}')`,
			);
		};

		if (storage) {
			// Preferred: atomic transaction via the DO JS API
			storage.transactionSync(run);
		} else {
			// Fallback: run without explicit transaction (each exec is auto-committed)
			run();
		}
	}
}

interface DurableObjectStorage {
	transactionSync: <T>(closure: () => T) => T;
}

/**
 * Wrap SQL in a transaction so multi-statement migrations are atomic.
 *
 * Without this, a migration like `1_initial_setup` (CREATE + INSERT +
 * CREATE + CREATE) could fail mid-way and leave the database in an
 * inconsistent state that the runner considers "applied" but is
 * actually broken.  SQLite transactions guarantee all-or-nothing.
 *
 * Single-statement migrations don't strictly need it but wrapping
 * uniformly costs nothing and avoids accidental omissions.
 */
function txn(sql: string): string {
	const trimmed = sql.trim();
	// Don't double-wrap if someone already added BEGIN/COMMIT
	if (/^\s*BEGIN\b/i.test(trimmed)) return trimmed;
	return `BEGIN TRANSACTION;\n${trimmed}\nCOMMIT;`;
}

export const mailboxMigrations: Migration[] = [
	{
		name: "1_initial_setup",
		sql: txn(`
            CREATE TABLE folders (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                is_deletable INTEGER NOT NULL DEFAULT 1
            );

            INSERT INTO folders (id, name, is_deletable) VALUES
                ('inbox', 'Inbox', 0),
                ('sent', 'Sent', 0),
                ('trash', 'Trash', 0),
                ('archive', 'Archive', 0),
                ('spam', 'Spam', 0);

            CREATE TABLE emails (
                id TEXT PRIMARY KEY,
                folder_id TEXT NOT NULL,
                subject TEXT,
                sender TEXT,
                recipient TEXT,
                date TEXT,
                read INTEGER DEFAULT 0,
                starred INTEGER DEFAULT 0,
                body TEXT,
                FOREIGN KEY(folder_id) REFERENCES folders(id) ON DELETE CASCADE
            );

            CREATE TABLE attachments (
                id TEXT PRIMARY KEY,
                email_id TEXT NOT NULL,
                filename TEXT NOT NULL,
                mimetype TEXT NOT NULL,
                size INTEGER NOT NULL,
                content_id TEXT,
                disposition TEXT,
                FOREIGN KEY(email_id) REFERENCES emails(id) ON DELETE CASCADE
            );
        `),
	},
	{
		name: "2_add_email_threading",
		sql: txn(`
            ALTER TABLE emails ADD COLUMN in_reply_to TEXT;
            ALTER TABLE emails ADD COLUMN email_references TEXT;
            ALTER TABLE emails ADD COLUMN thread_id TEXT;

            CREATE INDEX idx_emails_thread_id ON emails(thread_id);
            CREATE INDEX idx_emails_in_reply_to ON emails(in_reply_to);
        `),
	},
	{
		name: "3_add_draft_folder",
		sql: txn(`INSERT INTO folders (id, name, is_deletable) VALUES ('draft', 'Drafts', 0);`),
	},
	{
		name: "4_add_message_id",
		sql: txn(`ALTER TABLE emails ADD COLUMN message_id TEXT;`),
	},
	{
		name: "5_add_raw_headers",
		sql: txn(`ALTER TABLE emails ADD COLUMN raw_headers TEXT;`),
	},
	{
		name: "6_mark_sent_emails_as_read",
		sql: txn(`UPDATE emails SET read = 1 WHERE folder_id = 'sent' AND read = 0;`),
	},
	{
		name: "7_add_cc_bcc",
		sql: txn(`
            ALTER TABLE emails ADD COLUMN cc TEXT;
            ALTER TABLE emails ADD COLUMN bcc TEXT;
        `),
	},
	{
		// No txn() wrapper: Cloudflare's DO runtime requires state.storage.transactionSync()
		// instead of SQL-level BEGIN TRANSACTION. These are idempotent CREATE INDEX IF NOT EXISTS
		// statements so they're safe to run without a transaction.
		name: "8_add_folder_date_indexes",
		sql: `
            CREATE INDEX IF NOT EXISTS idx_emails_folder_id ON emails(folder_id);
            CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date);
            CREATE INDEX IF NOT EXISTS idx_emails_folder_date ON emails(folder_id, date DESC);
        `,
	},
	{
		name: "9_add_agent_conversations",
		sql: txn(`
            CREATE TABLE agent_conversations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_message_preview TEXT
            );

			CREATE INDEX IF NOT EXISTS idx_agent_conversations_updated
                ON agent_conversations(updated_at DESC);
        `),
	},
	{
		name: "10_add_sender_name",
		sql: txn(`ALTER TABLE emails ADD COLUMN sender_name TEXT;`),
	},
	{
		name: "11_mark_draft_emails_as_read",
		sql: txn(`UPDATE emails SET read = 1 WHERE folder_id = 'draft' AND read = 0;`),
	},
	{
		name: "12_add_device_tokens",
		sql: txn(`
            CREATE TABLE IF NOT EXISTS device_tokens (
                token TEXT PRIMARY KEY,
                platform TEXT NOT NULL DEFAULT 'ios',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
        `),
	},
	{
		name: "13_fix_thread_ids_and_index_message_id",
		sql: txn(`
            CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id);

            -- Fix child emails whose in_reply_to matches an existing email's message_id or id
            UPDATE emails
            SET thread_id = (
                SELECT parent.thread_id
                FROM emails parent
                WHERE (parent.message_id = emails.in_reply_to OR parent.id = emails.in_reply_to)
                  AND parent.id != emails.id
                ORDER BY parent.date ASC
                LIMIT 1
            )
            WHERE in_reply_to IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM emails parent
                WHERE (parent.message_id = emails.in_reply_to OR parent.id = emails.in_reply_to)
                  AND parent.id != emails.id
                  AND parent.thread_id IS NOT NULL
                  AND parent.thread_id != emails.thread_id
              );

            -- Fix emails whose thread_id was set directly to a parent email's RFC message_id
            UPDATE emails
            SET thread_id = (
                SELECT target.thread_id
                FROM emails target
                WHERE target.message_id = emails.thread_id
                  AND target.id != emails.id
                ORDER BY target.date ASC
                LIMIT 1
            )
            WHERE thread_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM emails target
                WHERE target.message_id = emails.thread_id
                  AND target.id != emails.id
                  AND target.thread_id IS NOT NULL
                  AND target.thread_id != emails.thread_id
              );

            -- Second pass for chained replies (A -> B -> C)
            UPDATE emails
            SET thread_id = (
                SELECT parent.thread_id
                FROM emails parent
                WHERE (parent.message_id = emails.in_reply_to OR parent.id = emails.in_reply_to)
                  AND parent.id != emails.id
                ORDER BY parent.date ASC
                LIMIT 1
            )
            WHERE in_reply_to IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM emails parent
                WHERE (parent.message_id = emails.in_reply_to OR parent.id = emails.in_reply_to)
                  AND parent.id != emails.id
                  AND parent.thread_id IS NOT NULL
                  AND parent.thread_id != emails.thread_id
              );
        `),
	},
];

