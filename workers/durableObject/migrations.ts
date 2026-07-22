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
		name: "9_add_memory_files",
		sql: txn(`
            CREATE TABLE memory_files (
                id TEXT PRIMARY KEY,
                title TEXT,
                tags TEXT,
                content TEXT,
                r2_key TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE INDEX idx_memory_files_created_at ON memory_files(created_at);
        `),
	},
	{
		name: "10_add_memory_file_status",
		sql: txn(`
            ALTER TABLE memory_files ADD COLUMN status TEXT NOT NULL DEFAULT 'ready';
            ALTER TABLE memory_files ADD COLUMN source_type TEXT NOT NULL DEFAULT 'text';
            ALTER TABLE memory_files ADD COLUMN error_message TEXT;
        `),
	},
	{
		name: "11_add_memory_file_metrics",
		sql: txn(`
            ALTER TABLE memory_files ADD COLUMN word_count INTEGER;
            ALTER TABLE memory_files ADD COLUMN token_count INTEGER;
            ALTER TABLE memory_files ADD COLUMN summary TEXT;
        `),
	},
	{
		name: "12_add_templates",
		sql: txn(`
            CREATE TABLE templates (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                body TEXT NOT NULL,
                tags TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE INDEX idx_templates_created_at ON templates(created_at);
        `),
	},
	{
		name: "13_add_rosters",
		sql: txn(`
            CREATE TABLE rosters (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE students (
                id TEXT PRIMARY KEY,
                roster_id TEXT NOT NULL,
                name TEXT,
                email TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY(roster_id) REFERENCES rosters(id) ON DELETE CASCADE
            );

            CREATE INDEX idx_students_roster_id ON students(roster_id);
            CREATE INDEX idx_students_email ON students(email);
        `),
	},
	{
		name: "14_add_memory_provenance_and_chunks",
		sql: txn(`
            ALTER TABLE memory_files ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'manual';
            ALTER TABLE memory_files ADD COLUMN source_uri TEXT;
            ALTER TABLE memory_files ADD COLUMN external_id TEXT;
            ALTER TABLE memory_files ADD COLUMN parent_id TEXT;
            ALTER TABLE memory_files ADD COLUMN checksum TEXT;
            ALTER TABLE memory_files ADD COLUMN draft_eligible INTEGER NOT NULL DEFAULT 1;
            ALTER TABLE memory_files ADD COLUMN last_indexed_at TEXT;

            CREATE INDEX idx_memory_files_external_id ON memory_files(external_id);
            CREATE INDEX idx_memory_files_parent_id ON memory_files(parent_id);

            CREATE TABLE memory_chunks (
                id TEXT PRIMARY KEY,
                memory_file_id TEXT NOT NULL,
                heading TEXT,
                content TEXT NOT NULL,
                start_offset INTEGER NOT NULL,
                end_offset INTEGER NOT NULL,
                token_count INTEGER,
                created_at TEXT NOT NULL,
                FOREIGN KEY(memory_file_id) REFERENCES memory_files(id) ON DELETE CASCADE
            );
            CREATE INDEX idx_memory_chunks_file_id ON memory_chunks(memory_file_id);

            CREATE TABLE memory_facts (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                value TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'suggested',
                confidence INTEGER,
                source_chunk_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(source_chunk_id) REFERENCES memory_chunks(id) ON DELETE SET NULL
            );
            CREATE INDEX idx_memory_facts_status ON memory_facts(status);
		`),
	},
	{
		name: "15_add_productivity_entities",
		sql: txn(`
			CREATE TABLE connected_accounts (
				id TEXT PRIMARY KEY,
				provider TEXT NOT NULL,
				provider_account_id TEXT NOT NULL,
				email TEXT,
				display_name TEXT,
				token_ciphertext TEXT,
				status TEXT NOT NULL DEFAULT 'connected',
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				updated_at TEXT NOT NULL DEFAULT (datetime('now')),
				UNIQUE(provider, provider_account_id)
			);
			CREATE TABLE productivity_items (
				id TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				provider TEXT NOT NULL,
				provider_id TEXT,
				title TEXT NOT NULL,
				body TEXT,
				start_at TEXT,
				end_at TEXT,
				due_at TEXT,
				status TEXT NOT NULL DEFAULT 'open',
				source_email_id TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				updated_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
			CREATE INDEX idx_productivity_kind_status ON productivity_items(kind, status);
			CREATE TABLE extractions (
				id TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				title TEXT NOT NULL,
				due_at TEXT,
				confidence REAL NOT NULL,
				source_email_id TEXT NOT NULL,
				source_thread_id TEXT,
				status TEXT NOT NULL DEFAULT 'suggested',
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
			CREATE INDEX idx_extractions_status ON extractions(status);
		`),
	},
	{
		name: "16_add_graph_subscriptions",
		sql: txn(`
			CREATE TABLE graph_subscriptions (
				id TEXT PRIMARY KEY,
				provider TEXT NOT NULL,
				resource TEXT NOT NULL,
				expiration_at TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				updated_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
			CREATE INDEX idx_graph_subscription_expiration ON graph_subscriptions(expiration_at);
		`),
	},
	{
		name: "17_extend_productivity_items_for_provider_sync",
		sql: txn(`
			ALTER TABLE productivity_items ADD COLUMN account_id TEXT;
			ALTER TABLE productivity_items ADD COLUMN payload_json TEXT;
			CREATE INDEX idx_productivity_provider_id ON productivity_items(provider, provider_id);
			CREATE INDEX idx_productivity_account_id ON productivity_items(account_id);
		`),
	},
	{
		name: "18_add_topics",
		sql: txn(`
			CREATE TABLE topics (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				content TEXT NOT NULL DEFAULT '',
				selected_email_ids TEXT NOT NULL DEFAULT '[]',
				status TEXT NOT NULL DEFAULT 'created',
				job_id TEXT,
				mode TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				updated_at TEXT NOT NULL DEFAULT (datetime('now'))
			);
			CREATE INDEX idx_topics_status_created ON topics(status, created_at DESC);
		`),
	},
];
