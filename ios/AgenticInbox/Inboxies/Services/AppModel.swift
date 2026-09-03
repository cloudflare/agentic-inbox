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

    var toast: AppToast?
    private var toastDismissTask: Task<Void, Never>?

    /// Observable swipe prefs so list rows refresh when settings change.
    var swipePreferences = SwipeActionPreferences.current
    /// Preview hosts skip UserDefaults so Canvas cannot overwrite real swipe prefs.
    var persistsPreferences = true

    var selectedMailbox: Mailbox? {
        mailboxes.first { $0.id == selectedMailboxId }
    }

    func updateSwipePreferences(_ transform: (inout SwipeActionPreferences) -> Void) {
        var prefs = swipePreferences
        transform(&prefs)
        prefs.leftActions = Array(prefs.leftActions.prefix(SwipeActionPreferences.maxActionsPerEdge))
        prefs.rightActions = Array(prefs.rightActions.prefix(SwipeActionPreferences.maxActionsPerEdge))
        if persistsPreferences {
            prefs.save()
        }
        swipePreferences = prefs
    }

    func unreadCount(forFolderId folderId: String) -> Int {
        folders.first(where: { $0.id == folderId })?.unreadCount ?? 0
    }

    func adjustFolderUnread(folderId: String, delta: Int) {
        guard delta != 0,
              let index = folders.firstIndex(where: { $0.id == folderId }) else { return }
        let current = folders[index]
        let next = max(0, current.unreadCount + delta)
        guard next != current.unreadCount else { return }
        folders[index] = Folder(id: current.id, name: current.name, unreadCount: next)
    }

    private func adjustFolderUnread(for email: Email, wasUnread: Bool, isUnread: Bool) {
        guard wasUnread != isUnread else { return }
        let folderId = email.folderId ?? {
            if case let .folder(id) = selectedTab { return id }
            return nil
        }()
        guard let folderId else { return }
        adjustFolderUnread(folderId: folderId, delta: isUnread ? 1 : -1)
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
                adjustFolderUnread(for: email, wasUnread: true, isUnread: false)
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
        form.onDraftSaved = { [weak self] draftId, threadId, originalEmailId, subject, body in
            self?.markThreadHasDraft(
                draftId: draftId,
                threadId: threadId,
                originalEmailId: originalEmailId,
                draftSubject: subject,
                draftBody: body,
                hasDraft: true
            )
        }
        form.onDraftDeleted = { [weak self] draftId, threadId, originalEmailId in
            self?.markThreadHasDraft(
                draftId: draftId,
                threadId: threadId,
                originalEmailId: originalEmailId,
                draftSubject: nil,
                draftBody: nil,
                hasDraft: false
            )
        }
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

    func markThreadHasDraft(
        draftId: String,
        threadId: String?,
        originalEmailId: String?,
        draftSubject: String? = nil,
        draftBody: String? = nil,
        hasDraft: Bool
    ) {
        // 1. Update emails in the current tab list (e.g. Inbox)
        for i in emails.indices {
            let e = emails[i]
            let matchesThread = threadId != nil && !threadId!.isEmpty && (e.threadId == threadId || e.id == threadId)
            let matchesOriginal = originalEmailId != nil && !originalEmailId!.isEmpty && (e.id == originalEmailId || e.threadId == originalEmailId)
            if matchesThread || matchesOriginal {
                let wasDraft = emails[i].hasDraft == true
                if hasDraft && !wasDraft {
                    emails[i].threadCount = (emails[i].threadCount ?? 1) + 1
                } else if !hasDraft && wasDraft {
                    emails[i].threadCount = max(1, (emails[i].threadCount ?? 2) - 1)
                }
                emails[i].hasDraft = hasDraft
            }
        }

        // 2. Update selectedEmail if open
        if let selected = selectedEmail {
            let matchesThread = threadId != nil && !threadId!.isEmpty && (selected.threadId == threadId || selected.id == threadId)
            let matchesOriginal = originalEmailId != nil && !originalEmailId!.isEmpty && (selected.id == originalEmailId || selected.threadId == originalEmailId)
            if matchesThread || matchesOriginal {
                let wasDraft = selectedEmail?.hasDraft == true
                if hasDraft && !wasDraft {
                    selectedEmail?.threadCount = (selectedEmail?.threadCount ?? 1) + 1
                } else if !hasDraft && wasDraft {
                    selectedEmail?.threadCount = max(1, (selectedEmail?.threadCount ?? 2) - 1)
                }
                selectedEmail?.hasDraft = hasDraft
            }
        }

        // 3. Update thread messages if active
        for i in threadEmails.indices {
            let e = threadEmails[i]
            let matchesThread = threadId != nil && !threadId!.isEmpty && (e.threadId == threadId || e.id == threadId)
            let matchesOriginal = originalEmailId != nil && !originalEmailId!.isEmpty && (e.id == originalEmailId || e.threadId == originalEmailId)
            if matchesThread || matchesOriginal {
                let wasDraft = threadEmails[i].hasDraft == true
                if hasDraft && !wasDraft {
                    threadEmails[i].threadCount = (threadEmails[i].threadCount ?? 1) + 1
                } else if !hasDraft && wasDraft {
                    threadEmails[i].threadCount = max(1, (threadEmails[i].threadCount ?? 2) - 1)
                }
                threadEmails[i].hasDraft = hasDraft
            }
        }

        // Keep threadEmails in sync if viewing this thread
        if hasDraft {
            if let idx = threadEmails.firstIndex(where: { $0.id == draftId }) {
                if let draftSubject { threadEmails[idx].subject = draftSubject }
                if let draftBody { threadEmails[idx].body = draftBody }
            } else if let threadId, threadEmails.contains(where: { $0.threadId == threadId || $0.id == threadId }) {
                let draftEmail = Email(
                    id: draftId,
                    threadId: threadId,
                    folderId: "draft",
                    subject: draftSubject ?? "",
                    sender: selectedMailbox?.email ?? "",
                    senderName: selectedMailbox?.name,
                    recipient: "",
                    date: ISO8601DateFormatter().string(from: Date()),
                    read: true,
                    starred: false,
                    body: draftBody,
                    inReplyTo: originalEmailId
                )
                threadEmails.append(draftEmail)
            }
        } else {
            threadEmails.removeAll { $0.id == draftId }
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

    func presentArchiveUndo(_ offer: ArchiveUndoOffer) {
        archiveUndoDismissTask?.cancel()
        archiveUndo = offer
        archiveUndoDismissTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard !Task.isCancelled, archiveUndo?.id == offer.id else { return }
            archiveUndo = nil
            archiveUndoDismissTask = nil
        }
    }

    func showToast(_ message: String, isError: Bool = false) {
        toastDismissTask?.cancel()
        toast = AppToast(message: message, isError: isError)
        toastDismissTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(2.5))
            guard !Task.isCancelled else { return }
            toast = nil
            toastDismissTask = nil
        }
    }

    func archiveRestoreFolder(for email: Email) -> String {
        if let folderId = email.folderId, !folderId.isEmpty, folderId != "archive" {
            return folderId
        }
        if case let .folder(folderId) = selectedTab, folderId != "archive" {
            return folderId
        }
        return "inbox"
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

    func applyEmailUpdate(_ updated: Email) {
        let previous = emails.first(where: { $0.id == updated.id })
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
        if let previous {
            adjustFolderUnread(for: previous, wasUnread: !previous.read, isUnread: !updated.read)
        }
    }

    func minimizeCompose() {
        composeSession?.minimize()
        if let form = composeSession?.form, !form.isEmpty && form.hasUnsavedChanges {
            Task { @MainActor in
                await form.saveDraft(explicit: false)
            }
        }
    }

    func expandCompose() {
        composeSession?.expand()
    }

    func closeCompose() {
        composeSession?.form.cancelAutoSave()
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

struct AppToast: Identifiable, Equatable {
    let id = UUID()
    let message: String
    var isError: Bool = false
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
