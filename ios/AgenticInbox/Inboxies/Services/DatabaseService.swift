import Foundation
import SQLite3

/// High-performance local storage engine for Inboxies powered by SQLite in WAL mode.
/// Provides sub-millisecond reads, atomic batch upserts, thread-safe background writes,
/// and built-in FTS5 full-text search.
final class DatabaseService: @unchecked Sendable {
    static let shared = DatabaseService()

    private var db: OpaquePointer?
    private let queue = DispatchQueue(label: "co.inboxies.database", qos: .userInitiated)

    init(inMemory: Bool = false) {
        openDatabase(inMemory: inMemory)
        configurePragmas()
        runMigrations()
    }

    deinit {
        if let db {
            sqlite3_close_v2(db)
        }
    }

    // MARK: - Setup & Migrations

    private func openDatabase(inMemory: Bool) {
        let path: String
        if inMemory {
            path = ":memory:"
        } else {
            let fileManager = FileManager.default
            guard let appSupport = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
                fatalError("Cannot access Application Support directory")
            }
            let dir = appSupport.appendingPathComponent("Inboxies", isDirectory: true)
            try? fileManager.createDirectory(at: dir, withIntermediateDirectories: true)
            path = dir.appendingPathComponent("mailboxes.sqlite").path
        }

        var dbPointer: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        if sqlite3_open_v2(path, &dbPointer, flags, nil) == SQLITE_OK {
            self.db = dbPointer
        } else {
            let errMsg = dbPointer != nil ? String(cString: sqlite3_errmsg(dbPointer)) : "Unknown error"
            fatalError("Failed to open SQLite database at \(path): \(errMsg)")
        }
    }

    private func configurePragmas() {
        exec("PRAGMA journal_mode = WAL;")
        exec("PRAGMA synchronous = NORMAL;")
        exec("PRAGMA foreign_keys = ON;")
        exec("PRAGMA cache_size = -16000;") // ~16MB memory cache
    }

    private func runMigrations() {
        // Migration tracking table
        exec("""
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL
        );
        """)

        let currentVersion = getVersion()

        if currentVersion < 1 {
            let migration1 = """
            CREATE TABLE IF NOT EXISTS mailboxes (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL,
                name TEXT NOT NULL,
                settings_json TEXT,
                last_synced_at TEXT
            );

            CREATE TABLE IF NOT EXISTS folders (
                id TEXT NOT NULL,
                mailbox_id TEXT NOT NULL,
                name TEXT NOT NULL,
                unread_count INTEGER DEFAULT 0,
                PRIMARY KEY (mailbox_id, id),
                FOREIGN KEY(mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS emails (
                id TEXT PRIMARY KEY,
                mailbox_id TEXT NOT NULL,
                thread_id TEXT,
                folder_id TEXT NOT NULL,
                subject TEXT NOT NULL,
                sender TEXT NOT NULL,
                sender_name TEXT,
                recipient TEXT NOT NULL,
                cc TEXT,
                bcc TEXT,
                date TEXT NOT NULL,
                read INTEGER NOT NULL DEFAULT 0,
                starred INTEGER NOT NULL DEFAULT 0,
                body TEXT,
                snippet TEXT,
                in_reply_to TEXT,
                message_id TEXT,
                raw_headers TEXT,
                thread_count INTEGER DEFAULT 1,
                thread_unread_count INTEGER DEFAULT 0,
                participants TEXT,
                folder_name TEXT,
                has_draft INTEGER DEFAULT 0,
                needs_reply INTEGER DEFAULT 0,
                has_attachment INTEGER DEFAULT 0,
                attachments_json TEXT,
                updated_at TEXT NOT NULL,
                is_dirty INTEGER DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_emails_list ON emails(mailbox_id, folder_id, date DESC);
            CREATE INDEX IF NOT EXISTS idx_emails_thread ON emails(mailbox_id, thread_id);
            CREATE INDEX IF NOT EXISTS idx_emails_flags ON emails(mailbox_id, folder_id, read, starred);
            CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date DESC);

            CREATE TABLE IF NOT EXISTS outbox_mutations (
                id TEXT PRIMARY KEY,
                mailbox_id TEXT NOT NULL,
                email_id TEXT NOT NULL,
                action_type TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                retry_count INTEGER DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'pending'
            );

            CREATE TABLE IF NOT EXISTS sync_state (
                mailbox_id TEXT NOT NULL,
                folder_id TEXT NOT NULL,
                last_synced_date TEXT,
                cursor TEXT,
                PRIMARY KEY (mailbox_id, folder_id)
            );
            """
            execTransaction(migration1)

            // FTS5 Virtual Table for offline full-text search
            exec("""
            CREATE VIRTUAL TABLE IF NOT EXISTS emails_fts USING fts5(
                id UNINDEXED,
                subject,
                sender,
                sender_name,
                snippet,
                body,
                content='emails',
                content_rowid='rowid'
            );

            -- Triggers to keep FTS5 synchronized with emails table
            CREATE TRIGGER IF NOT EXISTS emails_ai AFTER INSERT ON emails BEGIN
                INSERT INTO emails_fts(rowid, id, subject, sender, sender_name, snippet, body)
                VALUES (new.rowid, new.id, new.subject, new.sender, new.sender_name, new.snippet, new.body);
            END;

            CREATE TRIGGER IF NOT EXISTS emails_ad AFTER DELETE ON emails BEGIN
                INSERT INTO emails_fts(emails_fts, rowid, id, subject, sender, sender_name, snippet, body)
                VALUES('delete', old.rowid, old.id, old.subject, old.sender, old.sender_name, old.snippet, old.body);
            END;

            CREATE TRIGGER IF NOT EXISTS emails_au AFTER UPDATE ON emails BEGIN
                INSERT INTO emails_fts(emails_fts, rowid, id, subject, sender, sender_name, snippet, body)
                VALUES('delete', old.rowid, old.id, old.subject, old.sender, old.sender_name, old.snippet, old.body);
                INSERT INTO emails_fts(rowid, id, subject, sender, sender_name, snippet, body)
                VALUES (new.rowid, new.id, new.subject, new.sender, new.sender_name, new.snippet, new.body);
            END;
            """)

            setVersion(1)
        }
    }

    private func getVersion() -> Int {
        var version = 0
        var statement: OpaquePointer?
        if sqlite3_prepare_v2(db, "SELECT MAX(version) FROM schema_migrations;", -1, &statement, nil) == SQLITE_OK {
            if sqlite3_step(statement) == SQLITE_ROW {
                version = Int(sqlite3_column_int(statement, 0))
            }
        }
        sqlite3_finalize(statement)
        return version
    }

    private func setVersion(_ v: Int) {
        let now = ISO8601DateFormatter().string(from: Date())
        var statement: OpaquePointer?
        if sqlite3_prepare_v2(db, "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?);", -1, &statement, nil) == SQLITE_OK {
            sqlite3_bind_int(statement, 1, Int32(v))
            sqlite3_bind_text(statement, 2, (now as NSString).utf8String, -1, nil)
            sqlite3_step(statement)
        }
        sqlite3_finalize(statement)
    }

    // MARK: - Core Execution Helpers

    @discardableResult
    func exec(_ sql: String) -> Bool {
        return queue.sync {
            sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK
        }
    }

    func execTransaction(_ sql: String) {
        queue.sync {
            sqlite3_exec(db, "BEGIN TRANSACTION;", nil, nil, nil)
            sqlite3_exec(db, sql, nil, nil, nil)
            sqlite3_exec(db, "COMMIT;", nil, nil, nil)
        }
    }

    // MARK: - Mailbox Operations

    func upsertMailboxes(_ mailboxes: [Mailbox]) {
        queue.sync {
            sqlite3_exec(db, "BEGIN TRANSACTION;", nil, nil, nil)
            let sql = """
            INSERT INTO mailboxes (id, email, name, settings_json, last_synced_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                email = excluded.email,
                name = excluded.name,
                settings_json = COALESCE(excluded.settings_json, settings_json),
                last_synced_at = excluded.last_synced_at;
            """
            var stmt: OpaquePointer?
            if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
                let now = ISO8601DateFormatter().string(from: Date())
                for m in mailboxes {
                    sqlite3_reset(stmt)
                    sqlite3_bind_text(stmt, 1, (m.id as NSString).utf8String, -1, nil)
                    sqlite3_bind_text(stmt, 2, (m.email as NSString).utf8String, -1, nil)
                    sqlite3_bind_text(stmt, 3, (m.name as NSString).utf8String, -1, nil)
                    if let settings = m.settings, let data = try? JSONEncoder().encode(settings), let str = String(data: data, encoding: .utf8) {
                        sqlite3_bind_text(stmt, 4, (str as NSString).utf8String, -1, nil)
                    } else {
                        sqlite3_bind_null(stmt, 4)
                    }
                    sqlite3_bind_text(stmt, 5, (now as NSString).utf8String, -1, nil)
                    sqlite3_step(stmt)
                }
            }
            sqlite3_finalize(stmt)
            sqlite3_exec(db, "COMMIT;", nil, nil, nil)
        }
    }

    func getMailboxes() -> [Mailbox] {
        return queue.sync {
            var result: [Mailbox] = []
            var stmt: OpaquePointer?
            let sql = "SELECT id, email, name, settings_json FROM mailboxes ORDER BY email ASC;"
            if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
                while sqlite3_step(stmt) == SQLITE_ROW {
                    let id = String(cString: sqlite3_column_text(stmt, 0))
                    let email = String(cString: sqlite3_column_text(stmt, 1))
                    let name = String(cString: sqlite3_column_text(stmt, 2))
                    var settings: MailboxSettings? = nil
                    if let raw = sqlite3_column_text(stmt, 3) {
                        let str = String(cString: raw)
                        if let data = str.data(using: .utf8) {
                            settings = try? JSONDecoder().decode(MailboxSettings.self, from: data)
                        }
                    }
                    result.append(Mailbox(id: id, email: email, name: name, settings: settings))
                }
            }
            sqlite3_finalize(stmt)
            return result
        }
    }

    func getMailbox(id: String) -> Mailbox? {
        return queue.sync {
            var stmt: OpaquePointer?
            let sql = "SELECT id, email, name, settings_json FROM mailboxes WHERE id = ? LIMIT 1;"
            var result: Mailbox? = nil
            if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
                sqlite3_bind_text(stmt, 1, (id as NSString).utf8String, -1, nil)
                if sqlite3_step(stmt) == SQLITE_ROW {
                    let id = String(cString: sqlite3_column_text(stmt, 0))
                    let email = String(cString: sqlite3_column_text(stmt, 1))
                    let name = String(cString: sqlite3_column_text(stmt, 2))
                    var settings: MailboxSettings? = nil
                    if let raw = sqlite3_column_text(stmt, 3) {
                        let str = String(cString: raw)
                        if let data = str.data(using: .utf8) {
                            settings = try? JSONDecoder().decode(MailboxSettings.self, from: data)
                        }
                    }
                    result = Mailbox(id: id, email: email, name: name, settings: settings)
                }
            }
            sqlite3_finalize(stmt)
            return result
        }
    }

    // MARK: - Folder Operations

    func upsertFolders(mailboxId: String, folders: [Folder]) {
        queue.sync {
            sqlite3_exec(db, "BEGIN TRANSACTION;", nil, nil, nil)
            let sql = """
            INSERT INTO folders (id, mailbox_id, name, unread_count)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(mailbox_id, id) DO UPDATE SET
                name = excluded.name,
                unread_count = excluded.unread_count;
            """
            var stmt: OpaquePointer?
            if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
                for f in folders {
                    sqlite3_reset(stmt)
                    sqlite3_bind_text(stmt, 1, (f.id as NSString).utf8String, -1, nil)
                    sqlite3_bind_text(stmt, 2, (mailboxId as NSString).utf8String, -1, nil)
                    sqlite3_bind_text(stmt, 3, (f.name as NSString).utf8String, -1, nil)
                    sqlite3_bind_int(stmt, 4, Int32(f.unreadCount))
                    sqlite3_step(stmt)
                }
            }
            sqlite3_finalize(stmt)
            sqlite3_exec(db, "COMMIT;", nil, nil, nil)
        }
    }

    func getFolders(mailboxId: String) -> [Folder] {
        return queue.sync {
            var result: [Folder] = []
            var stmt: OpaquePointer?
            let sql = "SELECT id, name, unread_count FROM folders WHERE mailbox_id = ? ORDER BY id ASC;"
            if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
                sqlite3_bind_text(stmt, 1, (mailboxId as NSString).utf8String, -1, nil)
                while sqlite3_step(stmt) == SQLITE_ROW {
                    let id = String(cString: sqlite3_column_text(stmt, 0))
                    let name = String(cString: sqlite3_column_text(stmt, 1))
                    let count = Int(sqlite3_column_int(stmt, 2))
                    result.append(Folder(id: id, name: name, unreadCount: count))
                }
            }
            sqlite3_finalize(stmt)
            return result
        }
    }

    func updateFolderUnread(mailboxId: String, folderId: String, delta: Int) {
        queue.sync {
            var stmt: OpaquePointer?
            let sql = "UPDATE folders SET unread_count = MAX(0, unread_count + ?) WHERE mailbox_id = ? AND id = ?;"
            if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
                sqlite3_bind_int(stmt, 1, Int32(delta))
                sqlite3_bind_text(stmt, 2, (mailboxId as NSString).utf8String, -1, nil)
                sqlite3_bind_text(stmt, 3, (folderId as NSString).utf8String, -1, nil)
                sqlite3_step(stmt)
            }
            sqlite3_finalize(stmt)
        }
    }

    // MARK: - Email Operations (Atomic Batch Upsert)

    func upsertEmails(mailboxId: String, emails: [Email], defaultFolder: String? = nil) {
        guard !emails.isEmpty else { return }
        queue.sync {
            sqlite3_exec(db, "BEGIN TRANSACTION;", nil, nil, nil)
            let sql = """
            INSERT INTO emails (
                id, mailbox_id, thread_id, folder_id, subject, sender, sender_name,
                recipient, cc, bcc, date, read, starred, body, snippet, in_reply_to,
                message_id, raw_headers, thread_count, thread_unread_count, participants,
                folder_name, has_draft, needs_reply, has_attachment, attachments_json, updated_at
            ) VALUES (
                ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?
            )
            ON CONFLICT(id) DO UPDATE SET
                mailbox_id = excluded.mailbox_id,
                thread_id = COALESCE(excluded.thread_id, emails.thread_id),
                folder_id = excluded.folder_id,
                subject = excluded.subject,
                sender = excluded.sender,
                sender_name = COALESCE(excluded.sender_name, emails.sender_name),
                recipient = excluded.recipient,
                cc = COALESCE(excluded.cc, emails.cc),
                bcc = COALESCE(excluded.bcc, emails.bcc),
                date = excluded.date,
                read = excluded.read,
                starred = excluded.starred,
                body = COALESCE(excluded.body, emails.body),
                snippet = COALESCE(excluded.snippet, emails.snippet),
                in_reply_to = COALESCE(excluded.in_reply_to, emails.in_reply_to),
                message_id = COALESCE(excluded.message_id, emails.message_id),
                raw_headers = COALESCE(excluded.raw_headers, emails.raw_headers),
                thread_count = COALESCE(excluded.thread_count, emails.thread_count),
                thread_unread_count = COALESCE(excluded.thread_unread_count, emails.thread_unread_count),
                participants = COALESCE(excluded.participants, emails.participants),
                folder_name = COALESCE(excluded.folder_name, emails.folder_name),
                has_draft = COALESCE(excluded.has_draft, emails.has_draft),
                needs_reply = COALESCE(excluded.needs_reply, emails.needs_reply),
                has_attachment = COALESCE(excluded.has_attachment, emails.has_attachment),
                attachments_json = COALESCE(excluded.attachments_json, emails.attachments_json),
                updated_at = excluded.updated_at;
            """
            var stmt: OpaquePointer?
            if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
                let now = ISO8601DateFormatter().string(from: Date())
                for e in emails {
                    let folder = e.folderId ?? defaultFolder ?? "inbox"
                    sqlite3_reset(stmt)

                    bindString(stmt, 1, e.id)
                    bindString(stmt, 2, mailboxId)
                    bindOptionalString(stmt, 3, e.threadId)
                    bindString(stmt, 4, folder)
                    bindString(stmt, 5, e.subject)
                    bindString(stmt, 6, e.sender)
                    bindOptionalString(stmt, 7, e.senderName)
                    bindString(stmt, 8, e.recipient)
                    bindOptionalString(stmt, 9, e.cc)
                    bindOptionalString(stmt, 10, e.bcc)
                    bindString(stmt, 11, e.date)
                    sqlite3_bind_int(stmt, 12, e.read ? 1 : 0)
                    sqlite3_bind_int(stmt, 13, e.starred ? 1 : 0)
                    bindOptionalString(stmt, 14, e.body)
                    bindOptionalString(stmt, 15, e.snippet)
                    bindOptionalString(stmt, 16, e.inReplyTo)
                    bindOptionalString(stmt, 17, e.messageId)
                    bindOptionalString(stmt, 18, e.rawHeaders)
                    bindOptionalInt(stmt, 19, e.threadCount)
                    bindOptionalInt(stmt, 20, e.threadUnreadCount)
                    bindOptionalString(stmt, 21, e.participants)
                    bindOptionalString(stmt, 22, e.folderName)
                    bindOptionalBool(stmt, 23, e.hasDraft)
                    bindOptionalBool(stmt, 24, e.needsReply)
                    bindOptionalBool(stmt, 25, e.hasAttachment)

                    if let atts = e.attachments, let data = try? JSONEncoder().encode(atts), let str = String(data: data, encoding: .utf8) {
                        bindString(stmt, 26, str)
                    } else {
                        sqlite3_bind_null(stmt, 26)
                    }

                    bindString(stmt, 27, now)

                    sqlite3_step(stmt)
                }
            }
            sqlite3_finalize(stmt)
            sqlite3_exec(db, "COMMIT;", nil, nil, nil)
        }
    }

    func getEmails(mailboxId: String, folderId: String, limit: Int = 50, offset: Int = 0) -> [Email] {
        return queue.sync {
            var result: [Email] = []
            var stmt: OpaquePointer?
            let sql = """
            SELECT
                id, thread_id, folder_id, subject, sender, sender_name,
                recipient, cc, bcc, date, read, starred, body, snippet,
                in_reply_to, message_id, raw_headers, thread_count,
                thread_unread_count, participants, folder_name, has_draft,
                needs_reply, has_attachment, attachments_json
            FROM emails
            WHERE mailbox_id = ? AND folder_id = ?
            ORDER BY date DESC
            LIMIT ? OFFSET ?;
            """
            if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
                sqlite3_bind_text(stmt, 1, (mailboxId as NSString).utf8String, -1, nil)
                sqlite3_bind_text(stmt, 2, (folderId as NSString).utf8String, -1, nil)
                sqlite3_bind_int(stmt, 3, Int32(limit))
                sqlite3_bind_int(stmt, 4, Int32(offset))

                while sqlite3_step(stmt) == SQLITE_ROW {
                    if let email = parseEmailRow(stmt) {
                        result.append(email)
                    }
                }
            }
            sqlite3_finalize(stmt)
            return result
        }
    }

    func getEmail(id: String) -> Email? {
        return queue.sync {
            var stmt: OpaquePointer?
            let sql = """
            SELECT
                id, thread_id, folder_id, subject, sender, sender_name,
                recipient, cc, bcc, date, read, starred, body, snippet,
                in_reply_to, message_id, raw_headers, thread_count,
                thread_unread_count, participants, folder_name, has_draft,
                needs_reply, has_attachment, attachments_json
            FROM emails
            WHERE id = ?
            LIMIT 1;
            """
            var result: Email? = nil
            if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
                sqlite3_bind_text(stmt, 1, (id as NSString).utf8String, -1, nil)
                if sqlite3_step(stmt) == SQLITE_ROW {
                    result = parseEmailRow(stmt)
                }
            }
            sqlite3_finalize(stmt)
            return result
        }
    }

    func getThreadEmails(mailboxId: String, threadId: String) -> [Email] {
        return queue.sync {
            var result: [Email] = []
            var stmt: OpaquePointer?
            let sql = """
            SELECT
                id, thread_id, folder_id, subject, sender, sender_name,
                recipient, cc, bcc, date, read, starred, body, snippet,
                in_reply_to, message_id, raw_headers, thread_count,
                thread_unread_count, participants, folder_name, has_draft,
                needs_reply, has_attachment, attachments_json
            FROM emails
            WHERE mailbox_id = ? AND (thread_id = ? OR id = ?)
            ORDER BY date ASC;
            """
            if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
                sqlite3_bind_text(stmt, 1, (mailboxId as NSString).utf8String, -1, nil)
                sqlite3_bind_text(stmt, 2, (threadId as NSString).utf8String, -1, nil)
                sqlite3_bind_text(stmt, 3, (threadId as NSString).utf8String, -1, nil)

                while sqlite3_step(stmt) == SQLITE_ROW {
                    if let email = parseEmailRow(stmt) {
                        result.append(email)
                    }
                }
            }
            sqlite3_finalize(stmt)
            return result
        }
    }

    func updateEmailFlags(id: String, read: Bool? = nil, starred: Bool? = nil) {
        queue.sync {
            var clauses: [String] = []
            if read != nil { clauses.append("read = ?") }
            if starred != nil { clauses.append("starred = ?") }
            guard !clauses.isEmpty else { return }

            let sql = "UPDATE emails SET \(clauses.joined(separator: ", ")) WHERE id = ?;"
            var stmt: OpaquePointer?
            if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
                var idx: Int32 = 1
                if let read {
                    sqlite3_bind_int(stmt, idx, read ? 1 : 0)
                    idx += 1
                }
                if let starred {
                    sqlite3_bind_int(stmt, idx, starred ? 1 : 0)
                    idx += 1
                }
                sqlite3_bind_text(stmt, idx, (id as NSString).utf8String, -1, nil)
                sqlite3_step(stmt)
            }
            sqlite3_finalize(stmt)
        }
    }

    func moveEmail(id: String, toFolderId: String) {
        queue.sync {
            var stmt: OpaquePointer?
            let sql = "UPDATE emails SET folder_id = ? WHERE id = ?;"
            if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
                sqlite3_bind_text(stmt, 1, (toFolderId as NSString).utf8String, -1, nil)
                sqlite3_bind_text(stmt, 2, (id as NSString).utf8String, -1, nil)
                sqlite3_step(stmt)
            }
            sqlite3_finalize(stmt)
        }
    }

    func deleteEmail(id: String) {
        queue.sync {
            var stmt: OpaquePointer?
            let sql = "DELETE FROM emails WHERE id = ?;"
            if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
                sqlite3_bind_text(stmt, 1, (id as NSString).utf8String, -1, nil)
                sqlite3_step(stmt)
            }
            sqlite3_finalize(stmt)
        }
    }

    func pruneRemovedEmails(
        mailboxId: String,
        folderId: String,
        currentServerIDs: Set<String>,
        oldestDate: String? = nil,
        isFullPage: Bool = false
    ) {
        guard !currentServerIDs.isEmpty else { return }
        queue.sync {
            var stmt: OpaquePointer?
            let sql = (isFullPage && oldestDate != nil)
                ? "SELECT id FROM emails WHERE mailbox_id = ? AND folder_id = ? AND date >= ?;"
                : "SELECT id FROM emails WHERE mailbox_id = ? AND folder_id = ?;"

            var localIDs: [String] = []
            if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
                sqlite3_bind_text(stmt, 1, (mailboxId as NSString).utf8String, -1, nil)
                sqlite3_bind_text(stmt, 2, (folderId as NSString).utf8String, -1, nil)
                if isFullPage, let oldestDate {
                    sqlite3_bind_text(stmt, 3, (oldestDate as NSString).utf8String, -1, nil)
                }
                while sqlite3_step(stmt) == SQLITE_ROW {
                    localIDs.append(String(cString: sqlite3_column_text(stmt, 0)))
                }
            }
            sqlite3_finalize(stmt)

            let toDelete = localIDs.filter { !currentServerIDs.contains($0) }
            if !toDelete.isEmpty {
                sqlite3_exec(db, "BEGIN TRANSACTION;", nil, nil, nil)
                var delStmt: OpaquePointer?
                if sqlite3_prepare_v2(db, "DELETE FROM emails WHERE id = ?;", -1, &delStmt, nil) == SQLITE_OK {
                    for id in toDelete {
                        sqlite3_reset(delStmt)
                        sqlite3_bind_text(delStmt, 1, (id as NSString).utf8String, -1, nil)
                        sqlite3_step(delStmt)
                    }
                }
                sqlite3_finalize(delStmt)
                sqlite3_exec(db, "COMMIT;", nil, nil, nil)
            }
        }
    }

    // MARK: - Full-Text Search (FTS5)

    func searchEmails(mailboxId: String, query: String, limit: Int = 30) -> [Email] {
        let cleanQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanQuery.isEmpty else { return [] }

        return queue.sync {
            var result: [Email] = []
            var stmt: OpaquePointer?
            // Sanitize query for FTS5 (escape double quotes, append prefix match *)
            let sanitized = cleanQuery.replacingOccurrences(of: "\"", with: "\"\"")
            let ftsQuery = "\"\(sanitized)\"*"

            let sql = """
            SELECT
                e.id, e.thread_id, e.folder_id, e.subject, e.sender, e.sender_name,
                e.recipient, e.cc, e.bcc, e.date, e.read, e.starred, e.body, e.snippet,
                e.in_reply_to, e.message_id, e.raw_headers, e.thread_count,
                e.thread_unread_count, e.participants, e.folder_name, e.has_draft,
                e.needs_reply, e.has_attachment, e.attachments_json
            FROM emails e
            JOIN emails_fts fts ON fts.id = e.id
            WHERE e.mailbox_id = ? AND emails_fts MATCH ?
            ORDER BY bm25(emails_fts), e.date DESC
            LIMIT ?;
            """
            if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
                sqlite3_bind_text(stmt, 1, (mailboxId as NSString).utf8String, -1, nil)
                sqlite3_bind_text(stmt, 2, (ftsQuery as NSString).utf8String, -1, nil)
                sqlite3_bind_int(stmt, 3, Int32(limit))

                while sqlite3_step(stmt) == SQLITE_ROW {
                    if let email = parseEmailRow(stmt) {
                        result.append(email)
                    }
                }
            }
            sqlite3_finalize(stmt)
            return result
        }
    }

    // MARK: - Outbox Mutations (Offline Queue)

    func enqueueMutation(id: String = UUID().uuidString, mailboxId: String, emailId: String, actionType: String, payload: [String: Any]) {
        queue.sync {
            let data = try? JSONSerialization.data(withJSONObject: payload)
            let payloadStr = data.flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
            let now = ISO8601DateFormatter().string(from: Date())

            var stmt: OpaquePointer?
            let sql = """
            INSERT INTO outbox_mutations (id, mailbox_id, email_id, action_type, payload_json, created_at, status)
            VALUES (?, ?, ?, ?, ?, ?, 'pending');
            """
            if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
                sqlite3_bind_text(stmt, 1, (id as NSString).utf8String, -1, nil)
                sqlite3_bind_text(stmt, 2, (mailboxId as NSString).utf8String, -1, nil)
                sqlite3_bind_text(stmt, 3, (emailId as NSString).utf8String, -1, nil)
                sqlite3_bind_text(stmt, 4, (actionType as NSString).utf8String, -1, nil)
                sqlite3_bind_text(stmt, 5, (payloadStr as NSString).utf8String, -1, nil)
                sqlite3_bind_text(stmt, 6, (now as NSString).utf8String, -1, nil)
                sqlite3_step(stmt)
            }
            sqlite3_finalize(stmt)
        }
    }

    func getPendingMutations() -> [(id: String, mailboxId: String, emailId: String, actionType: String, payload: [String: Any])] {
        return queue.sync {
            var result: [(id: String, mailboxId: String, emailId: String, actionType: String, payload: [String: Any])] = []
            var stmt: OpaquePointer?
            let sql = "SELECT id, mailbox_id, email_id, action_type, payload_json FROM outbox_mutations WHERE status = 'pending' ORDER BY created_at ASC;"
            if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
                while sqlite3_step(stmt) == SQLITE_ROW {
                    let id = String(cString: sqlite3_column_text(stmt, 0))
                    let mailboxId = String(cString: sqlite3_column_text(stmt, 1))
                    let emailId = String(cString: sqlite3_column_text(stmt, 2))
                    let actionType = String(cString: sqlite3_column_text(stmt, 3))
                    let payloadStr = String(cString: sqlite3_column_text(stmt, 4))
                    let payload = (payloadStr.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }) ?? [:]
                    result.append((id: id, mailboxId: mailboxId, emailId: emailId, actionType: actionType, payload: payload))
                }
            }
            sqlite3_finalize(stmt)
            return result
        }
    }

    func markMutationCompleted(id: String) {
        queue.sync {
            var stmt: OpaquePointer?
            let sql = "DELETE FROM outbox_mutations WHERE id = ?;"
            if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
                sqlite3_bind_text(stmt, 1, (id as NSString).utf8String, -1, nil)
                sqlite3_step(stmt)
            }
            sqlite3_finalize(stmt)
        }
    }

    func incrementMutationRetry(id: String) {
        queue.sync {
            var stmt: OpaquePointer?
            let sql = "UPDATE outbox_mutations SET retry_count = retry_count + 1 WHERE id = ?;"
            if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
                sqlite3_bind_text(stmt, 1, (id as NSString).utf8String, -1, nil)
                sqlite3_step(stmt)
            }
            sqlite3_finalize(stmt)
        }
    }

    // MARK: - Row Parser & Column Helpers

    private func parseEmailRow(_ stmt: OpaquePointer?) -> Email? {
        guard let stmt else { return nil }
        let id = String(cString: sqlite3_column_text(stmt, 0))
        let threadId = columnOptionalString(stmt, 1)
        let folderId = columnOptionalString(stmt, 2)
        let subject = String(cString: sqlite3_column_text(stmt, 3))
        let sender = String(cString: sqlite3_column_text(stmt, 4))
        let senderName = columnOptionalString(stmt, 5)
        let recipient = String(cString: sqlite3_column_text(stmt, 6))
        let cc = columnOptionalString(stmt, 7)
        let bcc = columnOptionalString(stmt, 8)
        let date = String(cString: sqlite3_column_text(stmt, 9))
        let read = sqlite3_column_int(stmt, 10) != 0
        let starred = sqlite3_column_int(stmt, 11) != 0
        let body = columnOptionalString(stmt, 12)
        let snippet = columnOptionalString(stmt, 13)
        let inReplyTo = columnOptionalString(stmt, 14)
        let messageId = columnOptionalString(stmt, 15)
        let rawHeaders = columnOptionalString(stmt, 16)
        let threadCount = columnOptionalInt(stmt, 17)
        let threadUnreadCount = columnOptionalInt(stmt, 18)
        let participants = columnOptionalString(stmt, 19)
        let folderName = columnOptionalString(stmt, 20)
        let hasDraft = columnOptionalBool(stmt, 21)
        let needsReply = columnOptionalBool(stmt, 22)
        let hasAttachment = columnOptionalBool(stmt, 23)

        var attachments: [Attachment]? = nil
        if let attStr = columnOptionalString(stmt, 24), let data = attStr.data(using: .utf8) {
            attachments = try? JSONDecoder().decode([Attachment].self, from: data)
        }

        return Email(
            id: id,
            threadId: threadId,
            folderId: folderId,
            subject: subject,
            sender: sender,
            senderName: senderName,
            recipient: recipient,
            cc: cc,
            bcc: bcc,
            date: date,
            read: read,
            starred: starred,
            body: body,
            snippet: snippet,
            inReplyTo: inReplyTo,
            messageId: messageId,
            rawHeaders: rawHeaders,
            threadCount: threadCount,
            threadUnreadCount: threadUnreadCount,
            participants: participants,
            folderName: folderName,
            hasDraft: hasDraft,
            needsReply: needsReply,
            hasAttachment: hasAttachment,
            attachments: attachments
        )
    }

    private func bindString(_ stmt: OpaquePointer?, _ index: Int32, _ val: String) {
        sqlite3_bind_text(stmt, index, (val as NSString).utf8String, -1, nil)
    }

    private func bindOptionalString(_ stmt: OpaquePointer?, _ index: Int32, _ val: String?) {
        if let val {
            sqlite3_bind_text(stmt, index, (val as NSString).utf8String, -1, nil)
        } else {
            sqlite3_bind_null(stmt, index)
        }
    }

    private func bindOptionalInt(_ stmt: OpaquePointer?, _ index: Int32, _ val: Int?) {
        if let val {
            sqlite3_bind_int(stmt, index, Int32(val))
        } else {
            sqlite3_bind_null(stmt, index)
        }
    }

    private func bindOptionalBool(_ stmt: OpaquePointer?, _ index: Int32, _ val: Bool?) {
        if let val {
            sqlite3_bind_int(stmt, index, val ? 1 : 0)
        } else {
            sqlite3_bind_null(stmt, index)
        }
    }

    private func columnOptionalString(_ stmt: OpaquePointer?, _ index: Int32) -> String? {
        guard let raw = sqlite3_column_text(stmt, index) else { return nil }
        return String(cString: raw)
    }

    private func columnOptionalInt(_ stmt: OpaquePointer?, _ index: Int32) -> Int? {
        if sqlite3_column_type(stmt, index) == SQLITE_NULL { return nil }
        return Int(sqlite3_column_int(stmt, index))
    }

    private func columnOptionalBool(_ stmt: OpaquePointer?, _ index: Int32) -> Bool? {
        if sqlite3_column_type(stmt, index) == SQLITE_NULL { return nil }
        return sqlite3_column_int(stmt, index) != 0
    }
}
