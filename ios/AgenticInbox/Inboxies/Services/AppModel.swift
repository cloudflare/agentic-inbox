import Foundation
import Observation

/// App-wide state ≈ Zustand `useUIStore` + React Query cache for the active mailbox.
@Observable
@MainActor
final class AppModel {
    var mailboxes: [Mailbox] = []
    var selectedMailboxId: String?
    var folders: [Folder] = []
    var selectedTab: HomeTab = .inbox
    var emails: [Email] = []
    var conversations: [AgentConversation] = []
    /// True until the first mailbox identity is available (top bar skeleton).
    var isMailboxLoading = true
    /// True while the current folder's email list is fetching.
    var isLoading = true
    /// True while the open email's body/thread is fetching.
    var isEmailDetailLoading = false
    var errorMessage: String?
    var selectedEmail: Email?
    var threadEmails: [Email] = []
    var composeSession: ComposeSession?
    /// Transient archive undo affordance (Mail-style toast + system UndoManager).
    var archiveUndo: ArchiveUndoOffer?
    private var archiveUndoDismissTask: Task<Void, Never>?

    var selectedMailbox: Mailbox? {
        mailboxes.first { $0.id == selectedMailboxId }
    }

    func bootstrap(authToken: String?) async {
        let token = authToken
        APIClient.shared.authTokenProvider = { token }
        await refreshMailboxes()
    }

    func refreshMailboxes() async {
        isMailboxLoading = selectedMailbox == nil
        isLoading = true
        errorMessage = nil
        do {
            mailboxes = try await APIClient.shared.listMailboxes()
            if selectedMailboxId == nil {
                selectedMailboxId = mailboxes.first?.id
            }
            isMailboxLoading = selectedMailbox == nil
            if let id = selectedMailboxId {
                await loadMailbox(id)
            } else {
                isMailboxLoading = false
                isLoading = false
            }
        } catch {
            errorMessage = error.localizedDescription
            isMailboxLoading = false
            isLoading = false
        }
    }

    func loadMailbox(_ id: String) async {
        selectedMailboxId = id
        isMailboxLoading = selectedMailbox == nil
        isLoading = true
        do {
            if let detailed = try? await APIClient.shared.getMailbox(mailboxId: id),
               let idx = mailboxes.firstIndex(where: { $0.id == detailed.id }) {
                mailboxes[idx] = detailed
            }
            isMailboxLoading = false
            async let foldersTask = APIClient.shared.listFolders(mailboxId: id)
            async let conversationsTask = APIClient.shared.listConversations(mailboxId: id)
            folders = try await foldersTask
            conversations = try await conversationsTask
            await loadEmailsForCurrentTab()
        } catch {
            errorMessage = error.localizedDescription
            isMailboxLoading = false
            isLoading = false
        }
    }

    func selectTab(_ tab: HomeTab) async {
        selectedTab = tab
        selectedEmail = nil
        if case .folder = tab {
            isLoading = true
        }
        await loadEmailsForCurrentTab()
    }

    func loadEmailsForCurrentTab(showLoading: Bool = true) async {
        guard let mailboxId = selectedMailboxId else {
            isLoading = false
            return
        }
        guard case let .folder(folderId) = selectedTab else {
            emails = []
            isLoading = false
            return
        }
        if showLoading {
            isLoading = true
        }
        defer { isLoading = false }
        do {
            let response = try await APIClient.shared.listEmails(mailboxId: mailboxId, folder: folderId)
            emails = response.emails
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Reloads the visible tab without swapping in the list skeleton.
    func refreshCurrentTab() async {
        switch selectedTab {
        case .folder:
            await loadEmailsForCurrentTab(showLoading: false)
        case .chats:
            await refreshConversations()
        }
    }

    func openEmail(_ email: Email) async {
        // Drafts open in compose, not read-only detail
        if email.isDraft || (selectedTab == .folder("draft")) {
            await openDraft(email)
            return
        }

        guard let mailboxId = selectedMailboxId else { return }
        selectedEmail = email
        threadEmails = []
        isEmailDetailLoading = true
        defer { isEmailDetailLoading = false }
        do {
            let shouldLoadThread = email.hasDraft == true || (email.threadCount ?? 1) > 1
            if let threadId = email.threadId, shouldLoadThread {
                threadEmails = try await APIClient.shared.getThread(mailboxId: mailboxId, threadId: threadId)
            } else {
                let full = try await APIClient.shared.getEmail(mailboxId: mailboxId, id: email.id)
                threadEmails = [full]
                // Keep list-row metadata (folder, flags) while adopting fetched body fields.
                selectedEmail = mergeListMetadata(email, with: full)
            }
            if email.isUnread {
                _ = try? await APIClient.shared.markRead(mailboxId: mailboxId, id: email.id)
                if let idx = emails.firstIndex(where: { $0.id == email.id }) {
                    emails[idx].read = true
                    emails[idx].threadUnreadCount = 0
                }
                selectedEmail?.read = true
                selectedEmail?.threadUnreadCount = 0
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Readable (non-draft) emails in the current list, in display order.
    var navigableEmails: [Email] {
        emails.filter { !$0.isDraft }
    }

    var canOpenPreviousEmail: Bool {
        guard let current = selectedEmail,
              let idx = navigableEmails.firstIndex(where: { $0.id == current.id }) else { return false }
        return idx > 0
    }

    var canOpenNextEmail: Bool {
        guard let current = selectedEmail,
              let idx = navigableEmails.firstIndex(where: { $0.id == current.id }) else { return false }
        return idx < navigableEmails.count - 1
    }

    func openAdjacentEmail(offset: Int) async {
        guard let current = selectedEmail,
              let idx = navigableEmails.firstIndex(where: { $0.id == current.id }) else { return }
        let next = idx + offset
        guard navigableEmails.indices.contains(next) else { return }
        await openEmail(navigableEmails[next])
    }

    private func mergeListMetadata(_ listRow: Email, with full: Email) -> Email {
        var merged = full
        if merged.folderId == nil { merged.folderId = listRow.folderId }
        if merged.folderName == nil { merged.folderName = listRow.folderName }
        if merged.threadCount == nil { merged.threadCount = listRow.threadCount }
        if merged.needsReply == nil { merged.needsReply = listRow.needsReply }
        if merged.hasDraft == nil { merged.hasDraft = listRow.hasDraft }
        return merged
    }

    func startCompose(
        mode: ComposeMode,
        original: Email? = nil,
        draft: Email? = nil
    ) async {
        guard let mailbox = selectedMailbox else {
            errorMessage = "No mailbox selected."
            return
        }

        var enrichedOriginal = original
        var enrichedDraft = draft
        if let original, original.body == nil || original.cc == nil {
            enrichedOriginal = try? await APIClient.shared.getEmail(mailboxId: mailbox.id, id: original.id)
        }
        if let draft, draft.body == nil {
            enrichedDraft = try? await APIClient.shared.getEmail(mailboxId: mailbox.id, id: draft.id)
        }

        let form = ComposeFormModel(
            mode: mode,
            mailbox: mailbox,
            original: enrichedOriginal ?? original,
            draft: enrichedDraft ?? draft
        )
        composeSession = ComposeSession(form: form, presentation: .expanded)
        selectedEmail = nil
    }

    /// Open a saved draft in compose. Reply-drafts keep reply send semantics.
    func openDraft(_ draft: Email) async {
        let original: Email? = {
            guard let inReplyTo = draft.inReplyTo, !inReplyTo.isEmpty else { return nil }
            return threadEmails.first { $0.id == inReplyTo || $0.messageId == inReplyTo }
        }()
        let mode: ComposeMode = original != nil || (draft.inReplyTo?.isEmpty == false) ? .reply : .editDraft
        await startCompose(mode: mode, original: original, draft: draft)
    }

    /// Prefer the latest non-draft thread message for reply/forward actions.
    var actionSourceEmail: Email? {
        threadEmails.last(where: { !$0.isDraft }) ?? selectedEmail
    }

    /// Discard a draft in the open thread without closing the conversation.
    func deleteThreadDraft(_ draft: Email) async {
        guard draft.isDraft, let mailboxId = selectedMailboxId else { return }
        do {
            try await APIClient.shared.deleteEmail(mailboxId: mailboxId, id: draft.id)
            threadEmails.removeAll { $0.id == draft.id }
            emails.removeAll { $0.id == draft.id }

            if selectedEmail?.id == draft.id || threadEmails.isEmpty {
                selectedEmail = nil
                threadEmails = []
                await loadEmailsForCurrentTab()
                return
            }

            let stillHasDraft = threadEmails.contains(where: \.isDraft)
            selectedEmail?.hasDraft = stillHasDraft
            if let selectedId = selectedEmail?.id,
               let idx = emails.firstIndex(where: { $0.id == selectedId }) {
                emails[idx].hasDraft = stillHasDraft
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func deleteCurrentEmail() async {
        guard let mailboxId = selectedMailboxId,
              let email = selectedEmail ?? threadEmails.last else { return }
        do {
            try await APIClient.shared.deleteEmail(mailboxId: mailboxId, id: email.id)
            selectedEmail = nil
            threadEmails = []
            await loadEmailsForCurrentTab()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func archiveCurrentEmail() async {
        guard let mailboxId = selectedMailboxId,
              let email = selectedEmail ?? threadEmails.last else { return }

        let previousFolderId = archiveRestoreFolder(for: email)
        do {
            try await APIClient.shared.moveEmail(
                mailboxId: mailboxId,
                id: email.id,
                folderId: "archive"
            )
            selectedEmail = nil
            threadEmails = []
            await loadEmailsForCurrentTab()
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

    func undoArchive(_ offer: ArchiveUndoOffer) async {
        guard archiveUndo?.id == offer.id else { return }
        clearArchiveUndo()
        do {
            try await APIClient.shared.moveEmail(
                mailboxId: offer.mailboxId,
                id: offer.emailId,
                folderId: offer.previousFolderId
            )
            await loadEmailsForCurrentTab()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func clearArchiveUndo() {
        archiveUndoDismissTask?.cancel()
        archiveUndoDismissTask = nil
        archiveUndo = nil
    }

    private func presentArchiveUndo(_ offer: ArchiveUndoOffer) {
        archiveUndoDismissTask?.cancel()
        archiveUndo = offer
        archiveUndoDismissTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard !Task.isCancelled, archiveUndo?.id == offer.id else { return }
            archiveUndo = nil
            archiveUndoDismissTask = nil
        }
    }

    private func archiveRestoreFolder(for email: Email) -> String {
        if let folderId = email.folderId, !folderId.isEmpty, folderId != "archive" {
            return folderId
        }
        if case let .folder(folderId) = selectedTab, folderId != "archive" {
            return folderId
        }
        return "inbox"
    }

    func moveCurrentEmail(to folderId: String) async {
        guard let mailboxId = selectedMailboxId,
              let email = selectedEmail ?? threadEmails.last else { return }
        do {
            try await APIClient.shared.moveEmail(mailboxId: mailboxId, id: email.id, folderId: folderId)
            selectedEmail = nil
            threadEmails = []
            await loadEmailsForCurrentTab()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func toggleStar(on email: Email? = nil) async {
        guard let mailboxId = selectedMailboxId else { return }
        let target = email ?? selectedEmail ?? threadEmails.last
        guard let target else { return }
        let next = !target.starred
        do {
            let updated = try await APIClient.shared.updateEmail(
                mailboxId: mailboxId,
                id: target.id,
                starred: next
            )
            applyEmailUpdate(updated)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func toggleRead(on email: Email? = nil) async {
        guard let mailboxId = selectedMailboxId else { return }
        let target = email ?? selectedEmail ?? threadEmails.last
        guard let target else { return }
        let next = !target.read
        do {
            let updated = try await APIClient.shared.updateEmail(
                mailboxId: mailboxId,
                id: target.id,
                read: next
            )
            applyEmailUpdate(updated)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func applyEmailUpdate(_ updated: Email) {
        if selectedEmail?.id == updated.id {
            selectedEmail = updated
        }
        if let idx = threadEmails.firstIndex(where: { $0.id == updated.id }) {
            threadEmails[idx] = updated
        }
        if let idx = emails.firstIndex(where: { $0.id == updated.id }) {
            emails[idx].read = updated.read
            emails[idx].starred = updated.starred
            if updated.read {
                emails[idx].threadUnreadCount = 0
            }
        }
    }

    func minimizeCompose() {
        composeSession?.minimize()
    }

    func expandCompose() {
        composeSession?.expand()
    }

    func closeCompose() {
        composeSession = nil
    }

    func createConversation(title: String? = nil) async -> AgentConversation? {
        guard let mailboxId = selectedMailboxId else { return nil }
        do {
            let created = try await APIClient.shared.createConversation(mailboxId: mailboxId, title: title)
            conversations.insert(created, at: 0)
            return created
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func refreshConversations() async {
        guard let mailboxId = selectedMailboxId else { return }
        do {
            conversations = try await APIClient.shared.listConversations(mailboxId: mailboxId)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

struct ArchiveUndoOffer: Identifiable, Equatable {
    let id = UUID()
    let emailId: String
    let mailboxId: String
    let previousFolderId: String
}

enum HomeTab: Hashable {
    case folder(String)
    case chats

    static var inbox: HomeTab { .folder("inbox") }

    var title: String {
        switch self {
        case .folder(let id):
            switch id {
            case "inbox": return "Inbox"
            case "sent": return "Sent"
            case "draft": return "Drafts"
            case "archive": return "Archive"
            case "trash": return "Trash"
            default: return id.capitalized
            }
        case .chats:
            return "AI"
        }
    }

    var systemImage: String {
        switch self {
        case .folder(let id):
            switch id {
            case "inbox": return "tray"
            case "sent": return "paperplane"
            case "draft": return "pencil.and.scribble"
            case "archive": return "archivebox"
            case "trash": return "trash"
            default: return "folder"
            }
        case .chats:
            return "sparkles"
        }
    }
}
