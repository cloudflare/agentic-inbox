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
        do {
            try await APIClient.shared.deleteEmail(mailboxId: mailboxId, id: email.id)
            if selectedEmail?.id == email.id {
                selectedEmail = nil
                threadEmails = []
            }
            emails.removeAll { $0.id == email.id }
            if !fromList {
                await loadEmailsForCurrentTab(showLoading: false)
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func archiveEmail(_ email: Email, fromList: Bool = false) async {
        guard let mailboxId = selectedMailboxId else { return }
        let previousFolderId = archiveRestoreFolder(for: email)
        do {
            try await APIClient.shared.moveEmail(
                mailboxId: mailboxId,
                id: email.id,
                folderId: "archive"
            )
            if selectedEmail?.id == email.id {
                selectedEmail = nil
                threadEmails = []
            }
            emails.removeAll { $0.id == email.id }
            if !fromList {
                await loadEmailsForCurrentTab(showLoading: false)
            }
            presentArchiveUndo(
                ArchiveUndoOffer(
                    emailId: email.id,
                    mailboxId: mailboxId,
                    previousFolderId: previousFolderId
                )
            )
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func moveEmail(_ email: Email, to folderId: String, fromList: Bool = false) async {
        guard let mailboxId = selectedMailboxId else { return }
        do {
            try await APIClient.shared.moveEmail(mailboxId: mailboxId, id: email.id, folderId: folderId)
            if selectedEmail?.id == email.id {
                selectedEmail = nil
                threadEmails = []
            }
            emails.removeAll { $0.id == email.id }
            if !fromList {
                await loadEmailsForCurrentTab(showLoading: false)
            }
        } catch {
            errorMessage = error.localizedDescription
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
            try? await APIClient.shared.deleteEmail(mailboxId: mailboxId, id: id)
            if selectedEmail?.id == id {
                selectedEmail = nil
                threadEmails = []
            }
            emails.removeAll { $0.id == id }
        }
    }

    func archiveEmails(_ emailIDs: Set<String>) async {
        guard let mailboxId = selectedMailboxId, !emailIDs.isEmpty else { return }
        for id in emailIDs {
            try? await APIClient.shared.moveEmail(mailboxId: mailboxId, id: id, folderId: "archive")
            if selectedEmail?.id == id {
                selectedEmail = nil
                threadEmails = []
            }
            emails.removeAll { $0.id == id }
        }
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
