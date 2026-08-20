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
    var isLoading = false
    var errorMessage: String?
    var selectedEmail: Email?
    var threadEmails: [Email] = []

    var selectedMailbox: Mailbox? {
        mailboxes.first { $0.id == selectedMailboxId }
    }

    func bootstrap(authToken: String?) async {
        APIClient.shared.authTokenProvider = { authToken }
        await refreshMailboxes()
    }

    func refreshMailboxes() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            mailboxes = try await APIClient.shared.listMailboxes()
            if selectedMailboxId == nil {
                selectedMailboxId = mailboxes.first?.id
            }
            if let id = selectedMailboxId {
                await loadMailbox(id)
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func loadMailbox(_ id: String) async {
        selectedMailboxId = id
        do {
            async let foldersTask = APIClient.shared.listFolders(mailboxId: id)
            async let conversationsTask = APIClient.shared.listConversations(mailboxId: id)
            folders = try await foldersTask
            conversations = try await conversationsTask
            await loadEmailsForCurrentTab()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func selectTab(_ tab: HomeTab) async {
        selectedTab = tab
        selectedEmail = nil
        await loadEmailsForCurrentTab()
    }

    func loadEmailsForCurrentTab() async {
        guard let mailboxId = selectedMailboxId else { return }
        guard case let .folder(folderId) = selectedTab else {
            emails = []
            return
        }
        isLoading = true
        defer { isLoading = false }
        do {
            let response = try await APIClient.shared.listEmails(mailboxId: mailboxId, folder: folderId)
            emails = response.emails
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func openEmail(_ email: Email) async {
        guard let mailboxId = selectedMailboxId else { return }
        selectedEmail = email
        do {
            if let threadId = email.threadId, (email.threadCount ?? 1) > 1 {
                threadEmails = try await APIClient.shared.getThread(mailboxId: mailboxId, threadId: threadId)
            } else {
                let full = try await APIClient.shared.getEmail(mailboxId: mailboxId, id: email.id)
                threadEmails = [full]
            }
            if email.isUnread {
                _ = try? await APIClient.shared.markRead(mailboxId: mailboxId, id: email.id)
                if let idx = emails.firstIndex(where: { $0.id == email.id }) {
                    emails[idx].read = true
                    emails[idx].threadUnreadCount = 0
                }
            }
        } catch {
            errorMessage = error.localizedDescription
        }
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
            case "draft": return "doc"
            case "archive": return "archivebox"
            case "trash": return "trash"
            default: return "folder"
            }
        case .chats:
            return "sparkles"
        }
    }
}
