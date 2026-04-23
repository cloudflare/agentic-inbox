// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Idempotent schema setup for MailboxDO.
 *
 * Previous iterations used a migration runner (workers-qb, then a hand-rolled
 * equivalent) with a tracking table. That added complexity and broke during
 * the DO transfer from `email-explorer-with-agents` → `agentic-inbox` because
 * the two workers disagreed on which tracking table to look at.
 *
 * This function just declares the FINAL schema using `CREATE TABLE IF NOT EXISTS`
 * + `CREATE INDEX IF NOT EXISTS`. It's safe to run on every DO instantiation:
 * - Fresh DOs get all tables + indexes + seed folders.
 * - Existing DOs (whether migrated step-by-step via workers-qb or transferred
 *   from the legacy worker) already have the tables with real data, so every
 *   statement is a no-op.
 *
 * If the schema needs to evolve in the future, add the change here with a
 * guard (`CREATE INDEX IF NOT EXISTS`, or a runtime column check for new
 * columns since SQLite lacks `ADD COLUMN IF NOT EXISTS`).
 */
export function applyMigrations(
	sql: SqlStorage,
	_unused?: unknown,
	storage?: DurableObjectStorage,
): void {
	const run = () => {
		// Core tables
		sql.exec(`CREATE TABLE IF NOT EXISTS folders (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL UNIQUE,
			is_deletable INTEGER NOT NULL DEFAULT 1
		)`);

		sql.exec(`CREATE TABLE IF NOT EXISTS emails (
			id TEXT PRIMARY KEY,
			folder_id TEXT NOT NULL,
			subject TEXT,
			sender TEXT,
			recipient TEXT,
			date TEXT,
			read INTEGER DEFAULT 0,
			starred INTEGER DEFAULT 0,
			body TEXT,
			in_reply_to TEXT,
			email_references TEXT,
			thread_id TEXT,
			message_id TEXT,
			raw_headers TEXT,
			cc TEXT,
			bcc TEXT,
			FOREIGN KEY(folder_id) REFERENCES folders(id) ON DELETE CASCADE
		)`);

		sql.exec(`CREATE TABLE IF NOT EXISTS attachments (
			id TEXT PRIMARY KEY,
			email_id TEXT NOT NULL,
			filename TEXT NOT NULL,
			mimetype TEXT NOT NULL,
			size INTEGER NOT NULL,
			content_id TEXT,
			disposition TEXT,
			FOREIGN KEY(email_id) REFERENCES emails(id) ON DELETE CASCADE
		)`);

		// Seed default folders. INSERT OR IGNORE makes this idempotent on
		// the `name` UNIQUE constraint: existing rows are left untouched.
		sql.exec(
			`INSERT OR IGNORE INTO folders (id, name, is_deletable) VALUES
				('inbox',   'Inbox',   0),
				('sent',    'Sent',    0),
				('trash',   'Trash',   0),
				('archive', 'Archive', 0),
				('spam',    'Spam',    0),
				('draft',   'Drafts',  0)`,
		);

		// Indexes
		sql.exec(`CREATE INDEX IF NOT EXISTS idx_emails_thread_id    ON emails(thread_id)`);
		sql.exec(`CREATE INDEX IF NOT EXISTS idx_emails_in_reply_to  ON emails(in_reply_to)`);
		sql.exec(`CREATE INDEX IF NOT EXISTS idx_emails_folder_id    ON emails(folder_id)`);
		sql.exec(`CREATE INDEX IF NOT EXISTS idx_emails_date         ON emails(date)`);
		sql.exec(`CREATE INDEX IF NOT EXISTS idx_emails_folder_date  ON emails(folder_id, date DESC)`);
	};

	try {
		if (storage) {
			storage.transactionSync(run);
		} else {
			run();
		}
	} catch (e) {
		console.error(
			"[mailbox-schema] Failed to ensure schema:",
			(e as Error).message,
			(e as Error).stack,
		);
		throw e;
	}
}

interface DurableObjectStorage {
	transactionSync: <T>(closure: () => T) => T;
}

/**
 * Kept as an empty export for backward compatibility with existing imports.
 * The old `Migration[]` array is no longer needed -- `applyMigrations` now
 * encodes the final schema directly and ignores any passed-in list.
 */
export interface Migration {
	name: string;
	sql: string;
}

export const mailboxMigrations: Migration[] = [];
