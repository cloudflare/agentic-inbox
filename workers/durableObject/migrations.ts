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
		name: "9_add_quarantine_folder",
		sql: txn(`INSERT INTO folders (id, name, is_deletable) VALUES ('quarantine', 'Quarantine', 0);`),
	},
	{
		// Security pipeline, threat intel, DMARC analytics, and case workflow
		// all land together so a fresh deploy ends up with the full schema after
		// one migration pass. Columns added via ALTER TABLE in this same
		// migration — each statement is idempotent-safe because migrations only
		// run once per name (see d1_migrations table).
		name: "10_security_intel_dmarc_cases",
		sql: `
            ALTER TABLE emails ADD COLUMN security_verdict TEXT;
            ALTER TABLE emails ADD COLUMN security_score INTEGER;
            ALTER TABLE emails ADD COLUMN security_explanation TEXT;
            ALTER TABLE emails ADD COLUMN deep_scan_status TEXT DEFAULT 'pending';

            ALTER TABLE attachments ADD COLUMN scan_status TEXT DEFAULT 'pending';
            ALTER TABLE attachments ADD COLUMN scan_verdict TEXT;

            CREATE TABLE IF NOT EXISTS urls (
                id TEXT PRIMARY KEY,
                email_id TEXT NOT NULL,
                url TEXT NOT NULL,
                display_text TEXT,
                is_homograph INTEGER NOT NULL DEFAULT 0,
                is_shortener INTEGER NOT NULL DEFAULT 0,
                resolved_url TEXT,
                page_title TEXT,
                fetch_status TEXT DEFAULT 'pending',
                verdict TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY(email_id) REFERENCES emails(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_urls_email_id ON urls(email_id);

            CREATE TABLE IF NOT EXISTS sender_reputation (
                sender TEXT PRIMARY KEY,
                first_seen TEXT NOT NULL,
                last_seen TEXT NOT NULL,
                message_count INTEGER NOT NULL DEFAULT 1,
                avg_score REAL NOT NULL DEFAULT 50.0,
                flagged INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS intel_feed_state (
                feed_id TEXT PRIMARY KEY,
                url TEXT NOT NULL,
                last_fetched_at TEXT,
                etag TEXT,
                entry_count INTEGER,
                bloom_kv_key TEXT
            );

            CREATE TABLE IF NOT EXISTS dmarc_reports (
                id TEXT PRIMARY KEY,
                received_at TEXT NOT NULL,
                org_name TEXT,
                report_id TEXT,
                domain TEXT NOT NULL,
                date_range_begin TEXT,
                date_range_end TEXT,
                policy_p TEXT,
                raw_r2_key TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_dmarc_reports_domain ON dmarc_reports(domain);
            CREATE INDEX IF NOT EXISTS idx_dmarc_reports_received_at ON dmarc_reports(received_at);

            CREATE TABLE IF NOT EXISTS dmarc_records (
                id TEXT PRIMARY KEY,
                report_id TEXT NOT NULL,
                source_ip TEXT NOT NULL,
                count INTEGER NOT NULL,
                disposition TEXT,
                dkim_result TEXT,
                spf_result TEXT,
                header_from TEXT,
                FOREIGN KEY(report_id) REFERENCES dmarc_reports(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_dmarc_records_source_ip ON dmarc_records(source_ip);
            CREATE INDEX IF NOT EXISTS idx_dmarc_records_report_id ON dmarc_records(report_id);

            CREATE TABLE IF NOT EXISTS dmarc_sources (
                source_ip TEXT PRIMARY KEY,
                label TEXT,
                legitimate INTEGER NOT NULL DEFAULT 0,
                notes TEXT
            );

            CREATE TABLE IF NOT EXISTS cases (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                status TEXT NOT NULL DEFAULT 'open',
                title TEXT NOT NULL,
                notes TEXT,
                shared_to_hub INTEGER NOT NULL DEFAULT 0,
                hub_event_uuid TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);

            CREATE TABLE IF NOT EXISTS case_emails (
                case_id TEXT NOT NULL,
                email_id TEXT NOT NULL,
                PRIMARY KEY (case_id, email_id),
                FOREIGN KEY(case_id) REFERENCES cases(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS case_observables (
                id TEXT PRIMARY KEY,
                case_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                value TEXT NOT NULL,
                FOREIGN KEY(case_id) REFERENCES cases(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_case_observables_case_id ON case_observables(case_id);
        `,
	},
	{
		// Speeds up the dashboard aggregation queries that scan recent cases
		// (`updated_at >= now-24h`) and order recent activity by `updated_at`.
		// `idx_cases_status` is already in place from migration 10.
		name: "11_dashboard_indexes",
		sql: `
            CREATE INDEX IF NOT EXISTS idx_cases_updated_at ON cases(updated_at);
        `,
	},
];
