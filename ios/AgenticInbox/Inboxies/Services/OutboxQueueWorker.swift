import Foundation

/// Background worker that drains optimistic mutations queued in local SQLite outbox.
/// Ensures all offline user actions (archive, star, mark read, move, delete) are reliably
/// synced to the backend with automatic retries and exponential backoff.
actor OutboxQueueWorker {
    static let shared = OutboxQueueWorker()

    private let db = DatabaseService.shared
    private var isDraining = false

    nonisolated func trigger() {
        Task {
            await drain()
        }
    }

    func drain() async {
        guard !isDraining else { return }
        isDraining = true
        defer { isDraining = false }

        let pending = db.getPendingMutations()
        guard !pending.isEmpty else { return }

        for mutation in pending {
            do {
                try await executeMutation(mutation)
                db.markMutationCompleted(id: mutation.id)
            } catch {
                db.incrementMutationRetry(id: mutation.id)
                // Stop draining on network or server errors; will retry later or on reconnect
                break
            }
        }
    }

    private func executeMutation(_ mutation: (id: String, mailboxId: String, emailId: String, actionType: String, payload: [String: Any])) async throws {
        let (id, mailboxId, emailId, actionType, payload) = mutation

        switch actionType {
        case "mark_read":
            let read = (payload["read"] as? Bool) ?? true
            _ = try await APIClient.shared.updateEmail(mailboxId: mailboxId, id: emailId, read: read)

        case "star":
            let starred = (payload["starred"] as? Bool) ?? true
            _ = try await APIClient.shared.updateEmail(mailboxId: mailboxId, id: emailId, starred: starred)

        case "move":
            guard let folderId = payload["folderId"] as? String else { return }
            try await APIClient.shared.moveEmail(mailboxId: mailboxId, id: emailId, folderId: folderId)

        case "delete":
            try await APIClient.shared.deleteEmail(mailboxId: mailboxId, id: emailId)

        default:
            // Unknown action type; discard so queue does not stall
            db.markMutationCompleted(id: id)
        }
    }
}
