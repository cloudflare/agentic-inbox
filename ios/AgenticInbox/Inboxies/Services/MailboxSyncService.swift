import Foundation
import Network

/// Background actor-based synchronization and prefetching service for Inboxies.
/// Performs silent delta syncs, manages stale-while-revalidate caches, and
/// proactively downloads email bodies in the background so opening them is instantaneous.
actor MailboxSyncService {
    static let shared = MailboxSyncService()

    private let db = DatabaseService.shared
    private let pathMonitor = NWPathMonitor()
    private let monitorQueue = DispatchQueue(label: "co.inboxies.networkmonitor")
    private(set) var isOnline = true

    /// Tracks active background prefetch tasks to prevent duplicate downloads.
    private var inFlightPrefetches: Set<String> = []
    private var inFlightSyncFolders: Set<String> = []

    init() {
        startNetworkMonitoring()
    }

    private func startNetworkMonitoring() {
        pathMonitor.pathUpdateHandler = { [weak self] path in
            let available = path.status == .satisfied
            Task { [weak self] in
                await self?.updateOnlineStatus(available)
            }
        }
        pathMonitor.start(queue: monitorQueue)
    }

    private func updateOnlineStatus(_ online: Bool) {
        let wasOffline = !self.isOnline && online
        self.isOnline = online
        if wasOffline {
            // When regaining connectivity, trigger outbox flush
            Task {
                await OutboxQueueWorker.shared.drain()
            }
        }
    }

    // MARK: - Synchronize Mailbox Metadata & Folders

    func syncMailbox(mailboxId: String) async throws -> [Folder] {
        guard isOnline else {
            return db.getFolders(mailboxId: mailboxId)
        }

        async let foldersTask = APIClient.shared.listFolders(mailboxId: mailboxId)
        async let mailboxTask = APIClient.shared.getMailbox(mailboxId: mailboxId)

        do {
            let folders = try await foldersTask
            db.upsertFolders(mailboxId: mailboxId, folders: folders)

            if let mailbox = try? await mailboxTask {
                db.upsertMailboxes([mailbox])
            }

            return folders
        } catch {
            // Return cached folders on network error
            let cached = db.getFolders(mailboxId: mailboxId)
            if !cached.isEmpty { return cached }
            throw error
        }
    }

    // MARK: - Synchronize Folder Emails

    func syncFolder(
        mailboxId: String,
        folderId: String,
        page: Int = 1
    ) async throws -> [Email] {
        let syncKey = "\(mailboxId):\(folderId)"
        guard !inFlightSyncFolders.contains(syncKey) else {
            return db.getEmails(mailboxId: mailboxId, folderId: folderId, limit: 50)
        }

        inFlightSyncFolders.insert(syncKey)
        defer { inFlightSyncFolders.remove(syncKey) }

        guard isOnline else {
            return db.getEmails(mailboxId: mailboxId, folderId: folderId, limit: 50)
        }

        let response = try await APIClient.shared.listEmails(
            mailboxId: mailboxId,
            folder: folderId,
            page: page
        )

        // Atomic batch upsert into SQLite
        db.upsertEmails(mailboxId: mailboxId, emails: response.emails, defaultFolder: folderId)

        // Prune server-deleted emails on page 1 within the fetched date window
        if page == 1 {
            let serverIDs = Set(response.emails.map(\.id))
            let oldestDate = response.emails.last?.date
            let isFullPage = response.emails.count >= 25
            db.pruneRemovedEmails(
                mailboxId: mailboxId,
                folderId: folderId,
                currentServerIDs: serverIDs,
                oldestDate: oldestDate,
                isFullPage: isFullPage
            )
        }

        // Proactively prefetch bodies for top 15 emails in the background
        Task { [weak self] in
            await self?.prefetchEmailBodies(mailboxId: mailboxId, emails: Array(response.emails.prefix(15)))
        }

        return db.getEmails(mailboxId: mailboxId, folderId: folderId, limit: 50)
    }

    // MARK: - Proactive Background Body Prefetching

    func prefetchEmailBodies(mailboxId: String, emails: [Email]) async {
        guard isOnline else { return }

        for email in emails {
            // Skip if full body is already stored in local database
            if let cached = db.getEmail(id: email.id), cached.body != nil && !(cached.body?.isEmpty ?? true) {
                continue
            }

            // Skip if currently being downloaded
            guard !inFlightPrefetches.contains(email.id) else { continue }
            inFlightPrefetches.insert(email.id)

            do {
                let shouldLoadThread = email.hasDraft == true || (email.threadCount ?? 1) > 1
                if let threadId = email.threadId, shouldLoadThread {
                    let threadMessages = try await APIClient.shared.getThread(mailboxId: mailboxId, threadId: threadId)
                    db.upsertEmails(mailboxId: mailboxId, emails: threadMessages, defaultFolder: email.folderId)
                } else {
                    let full = try await APIClient.shared.getEmail(mailboxId: mailboxId, id: email.id)
                    db.upsertEmails(mailboxId: mailboxId, emails: [full], defaultFolder: email.folderId)
                }
            } catch {
                // Silently ignore prefetch failures; user will fetch on-demand if needed
            }

            inFlightPrefetches.remove(email.id)
        }
    }

    func prefetchSingleEmail(mailboxId: String, emailId: String, threadId: String?) async {
        guard isOnline, !inFlightPrefetches.contains(emailId) else { return }
        inFlightPrefetches.insert(emailId)
        defer { inFlightPrefetches.remove(emailId) }

        do {
            if let threadId, !threadId.isEmpty {
                let thread = try await APIClient.shared.getThread(mailboxId: mailboxId, threadId: threadId)
                db.upsertEmails(mailboxId: mailboxId, emails: thread)
            } else {
                let full = try await APIClient.shared.getEmail(mailboxId: mailboxId, id: emailId)
                db.upsertEmails(mailboxId: mailboxId, emails: [full])
            }
        } catch {
            // Prefetch error tolerated
        }
    }
}
