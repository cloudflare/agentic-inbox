import Foundation

struct Mailbox: Identifiable, Codable, Hashable {
    let id: String
    let email: String
    let name: String
}

struct Folder: Identifiable, Codable, Hashable {
    let id: String
    let name: String
    let unreadCount: Int
}

struct Email: Identifiable, Codable, Hashable {
    let id: String
    var threadId: String?
    var folderId: String?
    var subject: String
    var sender: String
    var recipient: String
    var date: String
    var read: Bool
    var starred: Bool
    var body: String?
    var snippet: String?
    var threadCount: Int?
    var threadUnreadCount: Int?
    var participants: String?
    var folderName: String?
    var hasDraft: Bool?
    var needsReply: Bool?

    enum CodingKeys: String, CodingKey {
        case id, subject, sender, recipient, date, read, starred, body, snippet, participants
        case threadId = "thread_id"
        case folderId = "folder_id"
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
}

struct EmailListResponse: Codable {
    let emails: [Email]
    let totalCount: Int
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
