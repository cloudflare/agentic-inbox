import Foundation

struct Mailbox: Identifiable, Codable, Hashable {
    let id: String
    let email: String
    let name: String
    var settings: MailboxSettings?
}

struct MailboxSettings: Codable, Hashable {
    var fromName: String?
}

struct Folder: Identifiable, Codable, Hashable {
    let id: String
    let name: String
    let unreadCount: Int
}

struct Attachment: Identifiable, Codable, Hashable {
    let id: String
    var filename: String
    var mimetype: String
    var size: Int
    var contentId: String?
    var disposition: String?

    enum CodingKeys: String, CodingKey {
        case id, filename, mimetype, size, disposition
        case contentId = "content_id"
    }

    var isInline: Bool {
        (disposition ?? "").lowercased() == "inline"
    }
}

struct Email: Identifiable, Codable, Hashable {
    let id: String
    var threadId: String?
    var folderId: String?
    var subject: String
    var sender: String
    var recipient: String
    var cc: String?
    var bcc: String?
    var date: String
    var read: Bool
    var starred: Bool
    var body: String?
    var snippet: String?
    var inReplyTo: String?
    var threadCount: Int?
    var threadUnreadCount: Int?
    var participants: String?
    var folderName: String?
    var hasDraft: Bool?
    var needsReply: Bool?
    var attachments: [Attachment]?

    enum CodingKeys: String, CodingKey {
        case id, subject, sender, recipient, cc, bcc, date, read, starred, body, snippet, participants, attachments
        case threadId = "thread_id"
        case folderId = "folder_id"
        case inReplyTo = "in_reply_to"
        case threadCount = "thread_count"
        case threadUnreadCount = "thread_unread_count"
        case folderName = "folder_name"
        case hasDraft = "has_draft"
        case needsReply = "needs_reply"
    }

    var displaySender: String {
        if let participants, !participants.isEmpty {
            let names = participants
                .split(separator: ",")
                .map { $0.trimmingCharacters(in: .whitespaces).split(separator: "@").first.map(String.init) ?? String($0) }
            let unique = Array(NSOrderedSet(array: names)) as? [String] ?? names
            if unique.count <= 3 { return unique.joined(separator: ", ") }
            return "\(unique.prefix(2).joined(separator: ", ")) +\(unique.count - 2)"
        }
        return sender.split(separator: "@").first.map(String.init) ?? sender
    }

    var isUnread: Bool {
        if let threadUnreadCount { return threadUnreadCount > 0 }
        return !read
    }

    var isDraft: Bool {
        folderId == "draft" || folderName?.lowercased() == "drafts" || folderName?.lowercased() == "draft"
    }

    var nonInlineAttachments: [Attachment] {
        (attachments ?? []).filter { !$0.isInline }
    }

    var bodyLooksLikeHTML: Bool {
        guard let body else { return false }
        return body.range(of: #"</?[a-zA-Z][^>]*>"#, options: .regularExpression) != nil
    }
}

struct EmailListResponse: Codable {
    let emails: [Email]
    let totalCount: Int
}

struct SendEmailResponse: Codable {
    let id: String
    let status: String
}

struct DraftSaveResponse: Codable {
    let id: String
    let status: String
    let subject: String?
    let recipient: String?
    let date: String?
}

struct AgentConversation: Identifiable, Codable, Hashable {
    let id: String
    var title: String
    var createdAt: String
    var updatedAt: String
    var lastMessagePreview: String?
}

struct AuthResponse: Codable {
    let token: String
    let expiresAt: String
    let user: AuthUser
}

struct AuthUser: Codable {
    let id: String
    let email: String?
}

struct ChatMessage: Identifiable, Hashable {
    let id: String
    let role: String
    var text: String
}

enum ComposeMode: String, Hashable {
    case new
    case reply
    case replyAll
    case forward
    case editDraft
}

enum ComposePresentation: Hashable {
    case expanded
    case minimized
}
