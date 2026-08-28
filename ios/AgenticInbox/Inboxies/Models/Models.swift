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

    /// Content-ID without surrounding angle brackets (`<image001@local>` → `image001@local`).
    var normalizedContentId: String? {
        guard var value = contentId?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            return nil
        }
        if value.hasPrefix("<"), value.hasSuffix(">"), value.count >= 2 {
            value = String(value.dropFirst().dropLast())
        }
        return value
    }
}

/// A From/To/Cc/Bcc mailbox: optional display name plus address.
struct MailAddress: Hashable, Identifiable {
    let name: String?
    let email: String

    var id: String { email.lowercased() }

    var resolvedName: String {
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmed.isEmpty { return trimmed }
        let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
        if let at = address.firstIndex(of: "@"), at != address.startIndex {
            return String(address[..<at])
        }
        return address
    }

    func label(selfAddress: String?) -> String {
        if let selfAddress, !selfAddress.isEmpty,
           email.caseInsensitiveCompare(selfAddress) == .orderedSame {
            return "me"
        }
        return resolvedName
    }

    /// Compose token title: name when present, otherwise the email address.
    var tokenLabel: String {
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmed.isEmpty { return trimmed }
        return email
    }

    /// Query used when searching mail for this person.
    var searchQuery: String {
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmed.isEmpty { return trimmed }
        return email
    }

    static func parseList(_ raw: String?) -> [MailAddress] {
        guard let raw, !raw.isEmpty else { return [] }
        return splitList(raw).compactMap(parse)
    }

    static func parse(_ value: String) -> MailAddress? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        if let lt = trimmed.lastIndex(of: "<"),
           let gt = trimmed.lastIndex(of: ">"),
           lt < gt {
            let email = String(trimmed[trimmed.index(after: lt)..<gt])
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !email.isEmpty else { return nil }
            var name = String(trimmed[..<lt]).trimmingCharacters(in: .whitespacesAndNewlines)
            if name.hasPrefix("\""), name.hasSuffix("\""), name.count >= 2 {
                name = String(name.dropFirst().dropLast()).replacingOccurrences(of: "\\\"", with: "\"")
            }
            let resolved: String? = {
                if name.isEmpty || (name.contains("@") && !name.contains(" ")) { return nil }
                return name
            }()
            return MailAddress(name: resolved, email: email)
        }

        return MailAddress(name: nil, email: trimmed)
    }

    /// Split on commas/semicolons while keeping `"Last, First" <addr>` intact.
    static func splitList(_ raw: String) -> [String] {
        var parts: [String] = []
        var current = ""
        var angleDepth = 0
        var inQuotes = false

        for character in raw {
            if character == "\"" {
                inQuotes.toggle()
                current.append(character)
                continue
            }
            if !inQuotes {
                if character == "<" {
                    angleDepth += 1
                } else if character == ">" {
                    angleDepth = max(0, angleDepth - 1)
                } else if (character == "," || character == ";"), angleDepth == 0 {
                    let part = current.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !part.isEmpty { parts.append(part) }
                    current = ""
                    continue
                }
            }
            current.append(character)
        }

        let part = current.trimmingCharacters(in: .whitespacesAndNewlines)
        if !part.isEmpty { parts.append(part) }
        return parts
    }
}

struct Email: Identifiable, Codable, Hashable {
    let id: String
    var threadId: String?
    var folderId: String?
    var subject: String
    var sender: String
    var senderName: String? = nil
    var recipient: String
    var cc: String?
    var bcc: String?
    var date: String
    var read: Bool
    var starred: Bool
    var body: String?
    var snippet: String?
    var inReplyTo: String?
    var messageId: String?
    var rawHeaders: String?
    var threadCount: Int?
    var threadUnreadCount: Int?
    var participants: String?
    var folderName: String?
    var hasDraft: Bool?
    var needsReply: Bool?
    var hasAttachment: Bool? = nil
    var attachments: [Attachment]?

    enum CodingKeys: String, CodingKey {
        case id, subject, sender, recipient, cc, bcc, date, read, starred, body, snippet, participants, attachments
        case senderName = "sender_name"
        case threadId = "thread_id"
        case folderId = "folder_id"
        case inReplyTo = "in_reply_to"
        case messageId = "message_id"
        case rawHeaders = "raw_headers"
        case threadCount = "thread_count"
        case threadUnreadCount = "thread_unread_count"
        case folderName = "folder_name"
        case hasDraft = "has_draft"
        case needsReply = "needs_reply"
        case hasAttachment = "has_attachment"
    }

    /// Header rows for View Source, matching web `getSourceHeaders`.
    var sourceHeaders: [(key: String, value: String)] {
        if let rawHeaders, !rawHeaders.isEmpty,
           let data = rawHeaders.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) {
            if let array = json as? [[String: Any]] {
                let parsed = array.compactMap { entry -> (key: String, value: String)? in
                    let key = (entry["key"] as? String) ?? (entry["name"] as? String) ?? ""
                    let value = entry["value"].map { String(describing: $0) } ?? ""
                    guard !key.isEmpty || !value.isEmpty else { return nil }
                    return (key, value)
                }
                if !parsed.isEmpty { return parsed }
            } else if let object = json as? [String: Any] {
                return object.map { (key: $0.key, value: String(describing: $0.value)) }
                    .sorted { $0.key.localizedCaseInsensitiveCompare($1.key) == .orderedAscending }
            }
        }

        var headers: [(key: String, value: String)] = []
        if !sender.isEmpty { headers.append(("From", sender)) }
        if !recipient.isEmpty { headers.append(("To", recipient)) }
        if let cc, !cc.isEmpty { headers.append(("Cc", cc)) }
        if let bcc, !bcc.isEmpty { headers.append(("Bcc", bcc)) }
        if !subject.isEmpty { headers.append(("Subject", subject)) }
        if !date.isEmpty { headers.append(("Date", date)) }
        if let messageId, !messageId.isEmpty { headers.append(("Message-ID", messageId)) }
        if let inReplyTo, !inReplyTo.isEmpty { headers.append(("In-Reply-To", inReplyTo)) }
        if let threadId, !threadId.isEmpty { headers.append(("X-Thread-ID", threadId)) }
        return headers
    }

    var displaySender: String {
        if let participants, !participants.isEmpty {
            let separator: Character = participants.contains("\u{001f}") ? "\u{001f}" : ","
            let names = participants
                .split(separator: separator)
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
                .map { Self.displayLabel(for: $0) }
            let unique = Array(NSOrderedSet(array: names)) as? [String] ?? names
            if unique.isEmpty { return resolvedSenderName }
            if unique.count <= 3 { return unique.joined(separator: ", ") }
            return "\(unique.prefix(2).joined(separator: ", ")) +\(unique.count - 2)"
        }
        return resolvedSenderName
    }

    /// Name plus address for quoted/forward headers.
    var formattedFrom: String {
        let name = resolvedSenderName
        if name != sender, !sender.isEmpty {
            return "\(name) <\(sender)>"
        }
        return sender
    }

    var fromAddress: MailAddress {
        MailAddress(name: storedOrParsedFromName, email: sender)
    }

    var toAddresses: [MailAddress] {
        addresses(from: recipient, headerKeys: ["to"])
    }

    var ccAddresses: [MailAddress] {
        addresses(from: cc, headerKeys: ["cc"])
    }

    var bccAddresses: [MailAddress] {
        addresses(from: bcc, headerKeys: ["bcc"])
    }

    /// One-line To/Cc names for the collapsed message header.
    func recipientSummary(selfAddress: String?) -> String {
        var seen = Set<String>()
        var labels: [String] = []
        for address in toAddresses + ccAddresses {
            let key = address.email.lowercased()
            guard !key.isEmpty, seen.insert(key).inserted else { continue }
            labels.append(address.label(selfAddress: selfAddress))
        }
        return labels.joined(separator: ", ")
    }

    private var resolvedSenderName: String {
        fromAddress.resolvedName
    }

    private var storedOrParsedFromName: String? {
        if let senderName, !senderName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           senderName.contains("@") == false || senderName.contains(" ") {
            return senderName.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return Self.senderName(fromRawHeaders: rawHeaders)
    }

    private func addresses(from field: String?, headerKeys: [String]) -> [MailAddress] {
        let parsedField = MailAddress.parseList(field)
        let parsedHeaders = MailAddress.parseList(
            Self.headerValue(fromRawHeaders: rawHeaders, keys: Set(headerKeys))
        )
        let names = Dictionary(
            parsedHeaders.compactMap { address -> (String, String)? in
                guard let name = address.name, !name.isEmpty else { return nil }
                return (address.email.lowercased(), name)
            },
            uniquingKeysWith: { first, _ in first }
        )
        let source = parsedField.isEmpty ? parsedHeaders : parsedField
        return source.map { address in
            if address.name != nil { return address }
            if let name = names[address.email.lowercased()] {
                return MailAddress(name: name, email: address.email)
            }
            return address
        }
    }

    private static func headerValue(fromRawHeaders rawHeaders: String?, keys: Set<String>) -> String? {
        guard let rawHeaders, !rawHeaders.isEmpty,
              let data = rawHeaders.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) else { return nil }

        func matches(_ key: String) -> Bool {
            keys.contains(key.lowercased())
        }

        if let array = json as? [[String: Any]] {
            let values = array.compactMap { entry -> String? in
                let key = ((entry["key"] as? String) ?? (entry["name"] as? String) ?? "")
                guard matches(key) else { return nil }
                return entry["value"].map { String(describing: $0) }
            }.filter { !$0.isEmpty }
            return values.isEmpty ? nil : values.joined(separator: ", ")
        }

        if let object = json as? [String: Any] {
            let values = object.compactMap { key, value -> String? in
                guard matches(key) else { return nil }
                return String(describing: value)
            }.filter { !$0.isEmpty }
            return values.isEmpty ? nil : values.joined(separator: ", ")
        }

        return nil
    }

    private static func displayLabel(for value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.contains("@"), !trimmed.contains(" ") {
            return trimmed.split(separator: "@").first.map(String.init) ?? trimmed
        }
        return trimmed
    }

    private static func senderName(fromRawHeaders rawHeaders: String?) -> String? {
        guard let fromValue = headerValue(fromRawHeaders: rawHeaders, keys: ["from"]) else { return nil }
        return parseFromDisplayName(fromValue)
    }

    private static func parseFromDisplayName(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        if let lt = trimmed.lastIndex(of: "<"), let gt = trimmed.lastIndex(of: ">"), lt < gt {
            var name = String(trimmed[..<lt]).trimmingCharacters(in: .whitespacesAndNewlines)
            if name.hasPrefix("\""), name.hasSuffix("\""), name.count >= 2 {
                name = String(name.dropFirst().dropLast()).replacingOccurrences(of: "\\\"", with: "\"")
            }
            if name.isEmpty || (name.contains("@") && !name.contains(" ")) { return nil }
            return name
        }

        if trimmed.contains("@"), !trimmed.contains(" ") { return nil }
        return trimmed
    }

    var isUnread: Bool {
        if isDraft { return false }
        if let threadUnreadCount { return threadUnreadCount > 0 }
        return !read
    }

    var isDraft: Bool {
        folderId == "draft" || folderName?.lowercased() == "drafts" || folderName?.lowercased() == "draft"
    }

    var nonInlineAttachments: [Attachment] {
        (attachments ?? []).filter { !$0.isInline }
    }

    /// List rows use `has_attachment` (thread-wide). Detail rows use the files on this message.
    var hasFileAttachment: Bool {
        if !nonInlineAttachments.isEmpty { return true }
        return hasAttachment == true
    }

    var bodyLooksLikeHTML: Bool {
        guard let body else { return false }
        return body.range(of: #"</?[a-zA-Z][^>]*>"#, options: .regularExpression) != nil
    }

    /// Plain-text list preview. Mirrors web `getSnippetText`: snippets are
    /// a raw body prefix, so HTML (especially sent mail) must be stripped.
    var previewText: String {
        let source = (snippet?.isEmpty == false ? snippet : nil) ?? body
        return Self.snippetText(source)
    }

    static func snippetText(_ snippet: String?, maxLength: Int = 100) -> String {
        guard var text = snippet, !text.isEmpty else { return "" }

        let regex: String.CompareOptions = [.regularExpression, .caseInsensitive]
        text = text.replacingOccurrences(of: #"<style[^>]*>[\s\S]*?</style>"#, with: "", options: regex)
        text = text.replacingOccurrences(of: #"<style[^>]*>[\s\S]*"#, with: "", options: regex)
        text = text.replacingOccurrences(of: #"<[^>]*>"#, with: " ", options: .regularExpression)
        text = text.replacingOccurrences(of: #"<[^>]*$"#, with: "", options: .regularExpression)
        text = decodeHTMLEntities(text)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)

        if text.isEmpty { return "" }
        if text.count > maxLength {
            return String(text.prefix(maxLength)) + "..."
        }
        return text
    }

    private static func decodeHTMLEntities(_ text: String) -> String {
        var result = text
        if let regex = try? NSRegularExpression(pattern: #"&#(x?)([0-9a-fA-F]+);"#, options: .caseInsensitive) {
            let nsRange = NSRange(result.startIndex..<result.endIndex, in: result)
            let matches = regex.matches(in: result, range: nsRange)
            for match in matches.reversed() {
                guard let full = Range(match.range, in: result),
                      let hexFlag = Range(match.range(at: 1), in: result),
                      let valueRange = Range(match.range(at: 2), in: result) else { continue }
                let raw = String(result[valueRange])
                let parsed = result[hexFlag].isEmpty ? Int(raw) : Int(raw, radix: 16)
                guard let parsed, let code = UInt32(exactly: parsed), let scalar = UnicodeScalar(code) else { continue }
                result.replaceSubrange(full, with: String(Character(scalar)))
            }
        }
        let named = [
            "&amp;": "&",
            "&lt;": "<",
            "&gt;": ">",
            "&quot;": "\"",
            "&#39;": "'",
            "&apos;": "'",
            "&nbsp;": " ",
        ]
        for (entity, replacement) in named {
            result = result.replacingOccurrences(of: entity, with: replacement)
        }
        return result
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
