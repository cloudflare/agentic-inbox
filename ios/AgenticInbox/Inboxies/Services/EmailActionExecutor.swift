import Foundation

extension AppModel {
    /// Runs a configured swipe quick action on a list row.
    func performSwipeAction(_ action: SwipeQuickAction, on email: Email) async {
        switch action {
        case .delete:
            await deleteEmail(email, fromList: true)
        case .archive:
            await archiveEmail(email, fromList: true)
        case .star:
            await toggleStar(on: email)
        case .toggleRead:
            await toggleRead(on: email)
        case .reply:
            await startCompose(mode: .reply, original: email)
        }
    }

    func deleteEmail(_ email: Email, fromList: Bool = false) async {
        guard let mailboxId = selectedMailboxId else { return }

        // 1. Instant local optimistic delete (<1ms)
        DatabaseService.shared.deleteEmail(id: email.id)
        DatabaseService.shared.enqueueMutation(mailboxId: mailboxId, emailId: email.id, actionType: "delete", payload: [:])
        OutboxQueueWorker.shared.trigger()

        if selectedEmail?.id == email.id {
            selectedEmail = nil
            threadEmails = []
        }
        emails.removeAll { $0.id == email.id }
        if email.isUnread {
            adjustFolderUnread(for: email, wasUnread: true, isUnread: false)
        }
    }

    func archiveEmail(_ email: Email, fromList: Bool = false) async {
        guard let mailboxId = selectedMailboxId else { return }
        let previousFolderId = archiveRestoreFolder(for: email)

        // 1. Instant local optimistic move (<1ms)
        DatabaseService.shared.moveEmail(id: email.id, toFolderId: "archive")
        DatabaseService.shared.enqueueMutation(mailboxId: mailboxId, emailId: email.id, actionType: "move", payload: ["folderId": "archive"])
        OutboxQueueWorker.shared.trigger()

        if selectedEmail?.id == email.id {
            selectedEmail = nil
            threadEmails = []
        }
        emails.removeAll { $0.id == email.id }
        if email.isUnread {
            adjustFolderUnread(for: email, wasUnread: true, isUnread: false)
        }
        presentArchiveUndo(
            ArchiveUndoOffer(
                emailId: email.id,
                mailboxId: mailboxId,
                previousFolderId: previousFolderId
            )
        )
    }

    func moveEmail(_ email: Email, to folderId: String, fromList: Bool = false) async {
        guard let mailboxId = selectedMailboxId else { return }

        // 1. Instant local optimistic move (<1ms)
        DatabaseService.shared.moveEmail(id: email.id, toFolderId: folderId)
        DatabaseService.shared.enqueueMutation(mailboxId: mailboxId, emailId: email.id, actionType: "move", payload: ["folderId": folderId])
        OutboxQueueWorker.shared.trigger()

        if selectedEmail?.id == email.id {
            selectedEmail = nil
            threadEmails = []
        }
        emails.removeAll { $0.id == email.id }
        if email.isUnread {
            adjustFolderUnread(for: email, wasUnread: true, isUnread: false)
        }
    }

    func deleteCurrentEmail() async {
        guard let email = selectedEmail ?? threadEmails.last else { return }
        await deleteEmail(email)
    }

    func archiveCurrentEmail() async {
        guard let email = selectedEmail ?? threadEmails.last else { return }
        await archiveEmail(email)
    }

    func moveCurrentEmail(to folderId: String) async {
        guard let email = selectedEmail ?? threadEmails.last else { return }
        await moveEmail(email, to: folderId)
    }

    func deleteEmails(_ emailIDs: Set<String>) async {
        guard let mailboxId = selectedMailboxId, !emailIDs.isEmpty else { return }
        for id in emailIDs {
            DatabaseService.shared.deleteEmail(id: id)
            DatabaseService.shared.enqueueMutation(mailboxId: mailboxId, emailId: id, actionType: "delete", payload: [:])
            if selectedEmail?.id == id {
                selectedEmail = nil
                threadEmails = []
            }
            emails.removeAll { $0.id == id }
        }
        OutboxQueueWorker.shared.trigger()
    }

    func archiveEmails(_ emailIDs: Set<String>) async {
        guard let mailboxId = selectedMailboxId, !emailIDs.isEmpty else { return }
        for id in emailIDs {
            DatabaseService.shared.moveEmail(id: id, toFolderId: "archive")
            DatabaseService.shared.enqueueMutation(mailboxId: mailboxId, emailId: id, actionType: "move", payload: ["folderId": "archive"])
            if selectedEmail?.id == id {
                selectedEmail = nil
                threadEmails = []
            }
            emails.removeAll { $0.id == id }
        }
        OutboxQueueWorker.shared.trigger()
    }

    func markEmailsRead(_ emailIDs: Set<String>, read: Bool) async {
        guard let mailboxId = selectedMailboxId, !emailIDs.isEmpty else { return }
        for id in emailIDs {
            if let updated = try? await APIClient.shared.updateEmail(mailboxId: mailboxId, id: id, read: read) {
                applyEmailUpdate(updated)
            }
        }
    }

    func starEmails(_ emailIDs: Set<String>, starred: Bool) async {
        guard let mailboxId = selectedMailboxId, !emailIDs.isEmpty else { return }
        for id in emailIDs {
            if let updated = try? await APIClient.shared.updateEmail(mailboxId: mailboxId, id: id, starred: starred) {
                applyEmailUpdate(updated)
            }
        }
    }

    func moveEmails(_ emailIDs: Set<String>, to folderId: String) async {
        guard let mailboxId = selectedMailboxId, !emailIDs.isEmpty else { return }
        for id in emailIDs {
            try? await APIClient.shared.moveEmail(mailboxId: mailboxId, id: id, folderId: folderId)
            if selectedEmail?.id == id {
                selectedEmail = nil
                threadEmails = []
            }
            emails.removeAll { $0.id == id }
        }
    }

    func updateMailboxSettings(_ transform: (inout MailboxSettings) -> Void) async -> Bool {
        guard let mailboxId = selectedMailboxId else { return false }
        var settings = selectedMailbox?.settings ?? MailboxSettings()
        transform(&settings)
        do {
            let updated = try await APIClient.shared.updateMailbox(mailboxId: mailboxId, settings: settings)
            if let idx = mailboxes.firstIndex(where: { $0.id == mailboxId }) {
                mailboxes[idx] = updated
            }
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }
}
