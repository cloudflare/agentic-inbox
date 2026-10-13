import Foundation

struct Mailbox: Identifiable, Codable, Hashable {
    let id: String
    let email: String
    let name: String
    var settings: MailboxSettings?
    var canManage: Bool?
}

struct MailboxSettings: Codable, Hashable {
    var fromName: String?
    var agentSystemPrompt: String?
    var forwarding: ForwardingSettings?
    var signature: SignatureSettings?
    var autoReply: AutoReplySettings?
    var filters: [InboxFilterRule]?
    var acl: MailboxAcl?
}

struct MailboxAcl: Codable, Hashable {
    var owners: [String]?
    var members: [String]?
}

struct AccountSummary: Codable, Identifiable, Hashable {
    var id: String
    var email: String
    var name: String?
}

struct MeResponse: Codable {
    var email: String?
    var sub: String?
    var linkedEmails: [String]?
    var keys: [String]
    var isAdmin: Bool?
    var administeredDomains: [String]?
    var mailDomain: String?
    var domains: [String]?
}

struct LinkedIdentity: Codable, Identifiable, Hashable {
    var type: String
    var key: String
    var label: String
    var current: Bool

    var id: String { key }
}

struct IdentitiesResponse: Codable {
    var accountId: String
    var identities: [LinkedIdentity]
    var keys: [String]?
    var linkedEmails: [String]?
}

struct IdentityLinkCodeResponse: Codable {
    var code: String
    var emails: [String]?
    var principals: [String]?
    var accountId: String?
    var expiresAt: String
}

struct RedeemIdentityLinkResponse: Codable {
    var ok: Bool
    var accountId: String?
    var linkedEmails: [String]?
    var keys: [String]?
    var isAdmin: Bool
    var identities: [LinkedIdentity]?
}

struct AttachIdentityResponse: Codable {
    var ok: Bool
    var provider: String?
    var accountId: String?
    var userId: String?
    var linkedEmails: [String]?
    var keys: [String]?
    var isAdmin: Bool
    var identities: [LinkedIdentity]?
}

struct ChangePasswordResponse: Codable {
    var ok: Bool
    var userId: String?
    var accountId: String?
    var identities: [LinkedIdentity]?
}

struct AppConfigResponse: Codable {
    var mailDomain: String
    var domains: [String]
    var emailAddresses: [String]?
    var googleClientId: String?
    var appleSignInConfigured: Bool?
}

struct InboxFilterRule: Codable, Hashable, Identifiable {
    var id: String
    var enabled: Bool?
    var name: String?
    var from: String?
    var list: String?
    var subject: String?
    var folderId: String?
    var skipAutoDraft: Bool?
    var forwardTo: String?
}

struct SenderPreference: Codable, Hashable, Identifiable {
    var address: String
    var folderId: String
    var displayName: String?
    var source: String?
    var updatedAt: String?

    var id: String { address }
}

struct SenderPreferencesResponse: Codable {
    var preferences: [SenderPreference]
}

struct UpsertSenderPreferenceResponse: Codable {
    var preference: SenderPreference
    var refiledCount: Int
}

struct ForwardingSettings: Codable, Hashable {
    var enabled: Bool?
    var email: String?
}

struct SignatureSettings: Codable, Hashable {
    var enabled: Bool?
    var text: String?
    var html: String?
}

struct AutoReplySettings: Codable, Hashable {
    var enabled: Bool?
    var subject: String?
    var message: String?
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

    /// Query used when searching mail for this person (`from:` operator).
    var searchQuery: String {
        "from:\(email)"
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

struct EmailAuth: Codable, Hashable {
    var spf: String?
    var dkim: String?
    var dmarc: String?
    var dkimDomain: String?
    var spfMailfrom: String?
    var headerFrom: String?
    var envelopeFrom: String?
    var aligned: Bool?
    var spoofed: Bool?
    var source: String?

    var isSpoofed: Bool { spoofed == true }
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
    var replyLater: Bool = false
    var replyLaterAt: String? = nil
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
    var auth: EmailAuth? = nil
    var providerMessageId: String? = nil
    var deliveryStatus: String? = nil
    var deliveryError: String? = nil
    /// Inbox New vs Seen (`new` | `seen`); derived from read state when absent.
    var listSection: String? = nil
    var aliasId: String? = nil

    enum CodingKeys: String, CodingKey {
        case id, subject, sender, recipient, cc, bcc, date, read, starred, body, snippet, participants, attachments, auth
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
        case providerMessageId = "provider_message_id"
        case deliveryStatus = "delivery_status"
        case deliveryError = "delivery_error"
        case listSection = "list_section"
        case replyLater = "reply_later"
        case replyLaterAt = "reply_later_at"
        case aliasId = "alias_id"
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
        if let threadUnreadCount, threadUnreadCount > 0 { return true }
        return !read
    }

    /// Resolved New vs Seen membership for inbox list IA.
    var resolvedListSection: String {
        if let listSection, listSection == "new" || listSection == "seen" {
            return listSection
        }
        return isUnread ? "new" : "seen"
    }

    var isDraft: Bool {
        folderId == "draft" || folderName?.lowercased() == "drafts" || folderName?.lowercased() == "draft"
    }

    var isSpoofed: Bool { auth?.isSpoofed == true }

    var isDeliveryFailure: Bool { DeliveryStatusHelpers.isFailure(deliveryStatus) }

    var deliveryStatusLabel: String? {
        guard isDeliveryFailure else { return nil }
        return DeliveryStatusHelpers.label(for: deliveryStatus)
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

    var parsedDate: Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = formatter.date(from: date) { return d }
        let fallback = ISO8601DateFormatter()
        return fallback.date(from: date)
    }
}

enum EmailDateFilter: String, CaseIterable, Equatable, Hashable {
    case any = "Any time"
    case today = "Today"
    case lastThreeDays = "Last 3 days"
    case thisWeek = "This week"
}

struct EmailFilterState: Equatable {
    var unreadOnly: Bool = false
    var starredOnly: Bool = false
    var replyLaterOnly: Bool = false
    var toMeOnly: Bool = false
    var ccOrBccMeOnly: Bool = false
    var withAttachmentsOnly: Bool = false
    var dateFilter: EmailDateFilter = .any
    var needsReplyOnly: Bool = false

    var isActive: Bool {
        unreadOnly || starredOnly || replyLaterOnly || toMeOnly || ccOrBccMeOnly ||
        withAttachmentsOnly || dateFilter != .any || needsReplyOnly
    }

    var activeCount: Int {
        var count = 0
        if unreadOnly { count += 1 }
        if starredOnly { count += 1 }
        if replyLaterOnly { count += 1 }
        if toMeOnly { count += 1 }
        if ccOrBccMeOnly { count += 1 }
        if withAttachmentsOnly { count += 1 }
        if dateFilter != .any { count += 1 }
        if needsReplyOnly { count += 1 }
        return count
    }

    mutating func reset() {
        unreadOnly = false
        starredOnly = false
        replyLaterOnly = false
        toMeOnly = false
        ccOrBccMeOnly = false
        withAttachmentsOnly = false
        dateFilter = .any
        needsReplyOnly = false
    }

    func matches(_ email: Email, userEmail: String, calendar: Calendar = .current, now: Date = Date()) -> Bool {
        if unreadOnly && !email.isUnread {
            return false
        }
        if starredOnly && !email.starred {
            return false
        }
        if replyLaterOnly && !email.replyLater {
            return false
        }
        if withAttachmentsOnly && !email.hasFileAttachment {
            return false
        }
        if needsReplyOnly && email.needsReply != true {
            return false
        }

        let normalizedUser = userEmail.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if !normalizedUser.isEmpty {
            if toMeOnly {
                let inTo = email.toAddresses.contains { $0.email.lowercased() == normalizedUser }
                let inRecip = email.recipient.lowercased().contains(normalizedUser)
                if !inTo && !inRecip {
                    return false
                }
            }
            if ccOrBccMeOnly {
                let inCc = email.ccAddresses.contains { $0.email.lowercased() == normalizedUser }
                let inBcc = email.bccAddresses.contains { $0.email.lowercased() == normalizedUser }
                let inCcRaw = email.cc?.lowercased().contains(normalizedUser) ?? false
                let inBccRaw = email.bcc?.lowercased().contains(normalizedUser) ?? false
                if !inCc && !inBcc && !inCcRaw && !inBccRaw {
                    return false
                }
            }
        }

        if dateFilter != .any {
            guard let date = email.parsedDate else { return false }
            switch dateFilter {
            case .any:
                break
            case .today:
                if !calendar.isDateInToday(date) { return false }
            case .lastThreeDays:
                let threeDaysAgo = calendar.date(byAdding: .day, value: -3, to: now) ?? now
                let start = calendar.startOfDay(for: threeDaysAgo)
                if date < start { return false }
            case .thisWeek:
                if !calendar.isDate(date, equalTo: now, toGranularity: .weekOfYear) { return false }
            }
        }

        return true
    }

    func filter(_ list: [Email], userEmail: String) -> [Email] {
        guard isActive else { return list }
        let cal = Calendar.current
        let now = Date()
        return list.filter { matches($0, userEmail: userEmail, calendar: cal, now: now) }
    }
}

struct EmailListResponse: Codable {
    let emails: [Email]
    let totalCount: Int
    let newCount: Int?
    let seenCount: Int?
}

struct RecentRecipient: Codable, Hashable, Identifiable {
    let email: String
    let name: String?
    let lastEmailedAt: String?

    var id: String { email.lowercased() }

    var asMailAddress: MailAddress {
        MailAddress(name: name, email: email)
    }
}

struct RecentRecipientsResponse: Codable {
    let recipients: [RecentRecipient]
}

struct InboxDigest: Codable, Hashable {
    var greetingName: String
    var unreadCount: Int
    var todos: [InboxDigestTodo]
    var topics: [InboxDigestTopic]

    enum CodingKeys: String, CodingKey {
        case greetingName = "greeting_name"
        case unreadCount = "unread_count"
        case todos, topics
    }
}

struct InboxDigestTodo: Identifiable, Codable, Hashable {
    let id: String
    var emailId: String
    var threadId: String?
    var title: String
    var summary: String
    var date: String

    enum CodingKeys: String, CodingKey {
        case id, title, summary, date
        case emailId = "email_id"
        case threadId = "thread_id"
    }
}

struct InboxDigestTopic: Identifiable, Codable, Hashable {
    let id: String
    var title: String
    var emoji: String
    var caughtUp: Bool
    var remainingSummary: String?
    var items: [InboxDigestTopicItem]

    enum CodingKeys: String, CodingKey {
        case id, title, emoji, items
        case caughtUp = "caught_up"
        case remainingSummary = "remaining_summary"
    }
}

struct InboxDigestTopicItem: Identifiable, Codable, Hashable {
    var emailId: String
    var threadId: String?
    var subject: String
    var summary: String
    var date: String
    var unread: Bool
    var attachmentCount: Int

    var id: String { emailId }

    enum CodingKeys: String, CodingKey {
        case subject, summary, date, unread
        case emailId = "email_id"
        case threadId = "thread_id"
        case attachmentCount = "attachment_count"
    }
}

struct DigestStatusResponse: Codable {
    let status: String
    var count: Int?
}

struct SendEmailResponse: Codable {
    let id: String
    let status: String
}

struct DraftSaveResponse: Codable {
    let id: String?
    let draftId: String?
    let status: String?
    let subject: String?
    let recipient: String?
    let date: String?

    var resolvedId: String {
        id ?? draftId ?? ""
    }

    enum CodingKeys: String, CodingKey {
        case id
        case draftId = "draft_id"
        case status
        case subject
        case recipient
        case date
    }
}

struct AgentConversation: Identifiable, Codable, Hashable {
    let id: String
    var title: String
    var createdAt: String
    var updatedAt: String
    var lastMessagePreview: String?
}

/// Visible screen inside the AI chat sheet. Lives on `AppModel` so SwiftUI
/// remounting the sheet cannot mint a second conversation id.
enum ChatSession: Equatable {
    case dismissed
    case list
    case conversation(String)

    var conversationId: String? {
        if case .conversation(let id) = self { return id }
        return nil
    }

    static func newConversationId() -> String {
        UUID().uuidString.lowercased()
    }
}

struct ConversationDateGroup: Identifiable {
    let id: String
    let title: String
    let conversations: [AgentConversation]
}

extension AgentConversation {
    var parsedUpdatedAt: Date {
        if let d = AgentConversationDateHelpers.parseDate(updatedAt) { return d }
        if let d = AgentConversationDateHelpers.parseDate(createdAt) { return d }
        return .distantPast
    }
}

enum AgentConversationDateHelpers {
    private static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let isoStandard: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private static let sqlFormat: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        f.timeZone = TimeZone(secondsFromGMT: 0)
        return f
    }()

    static func parseDate(_ string: String) -> Date? {
        if let d = isoFractional.date(from: string) { return d }
        if let d = isoStandard.date(from: string) { return d }
        return sqlFormat.date(from: string)
    }

    static func groupConversationsByDate(_ conversations: [AgentConversation]) -> [ConversationDateGroup] {
        let calendar = Calendar.current
        let now = Date()
        let startOfToday = calendar.startOfDay(for: now)
        let sevenDaysAgo = calendar.date(byAdding: .day, value: -7, to: startOfToday) ?? .distantPast
        let thirtyDaysAgo = calendar.date(byAdding: .day, value: -30, to: startOfToday) ?? .distantPast

        let sorted = conversations.sorted { $0.parsedUpdatedAt > $1.parsedUpdatedAt }

        var todayList: [AgentConversation] = []
        var yesterdayList: [AgentConversation] = []
        var prev7DaysList: [AgentConversation] = []
        var prev30DaysList: [AgentConversation] = []
        var monthGroups: [Int: (title: String, conversations: [AgentConversation])] = [:]

        let currentYear = calendar.component(.year, from: now)

        for conv in sorted {
            let date = conv.parsedUpdatedAt
            if calendar.isDateInToday(date) {
                todayList.append(conv)
            } else if calendar.isDateInYesterday(date) {
                yesterdayList.append(conv)
            } else if date >= sevenDaysAgo {
                prev7DaysList.append(conv)
            } else if date >= thirtyDaysAgo {
                prev30DaysList.append(conv)
            } else {
                let year = calendar.component(.year, from: date)
                let month = calendar.component(.month, from: date)
                let sortKey = year * 100 + month

                let monthFormatter = DateFormatter()
                if year == currentYear {
                    monthFormatter.dateFormat = "MMMM"
                } else {
                    monthFormatter.dateFormat = "MMMM yyyy"
                }
                let title = monthFormatter.string(from: date)

                if monthGroups[sortKey] == nil {
                    monthGroups[sortKey] = (title: title, conversations: [conv])
                } else {
                    monthGroups[sortKey]?.conversations.append(conv)
                }
            }
        }

        var groups: [ConversationDateGroup] = []

        if !todayList.isEmpty {
            groups.append(ConversationDateGroup(id: "today", title: "Today", conversations: todayList))
        }
        if !yesterdayList.isEmpty {
            groups.append(ConversationDateGroup(id: "yesterday", title: "Yesterday", conversations: yesterdayList))
        }
        if !prev7DaysList.isEmpty {
            groups.append(ConversationDateGroup(id: "prev7Days", title: "Previous 7 Days", conversations: prev7DaysList))
        }
        if !prev30DaysList.isEmpty {
            groups.append(ConversationDateGroup(id: "prev30Days", title: "Previous 30 Days", conversations: prev30DaysList))
        }

        let sortedMonthKeys = monthGroups.keys.sorted(by: >)
        for key in sortedMonthKeys {
            if let group = monthGroups[key] {
                groups.append(ConversationDateGroup(id: "month-\(key)", title: group.title, conversations: group.conversations))
            }
        }

        return groups
    }
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
    var reasoning: String? = nil
    var reasoningDuration: TimeInterval? = nil
    var isToolAction: Bool = false
    var toolName: String? = nil
    var isError: Bool = false
    var timestamp: Date = Date()

    var reasoningDurationString: String? {
        guard let duration = reasoningDuration else { return nil }
        let secs = max(1, Int(round(duration)))
        return "\(secs)s"
    }
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

struct InvitePublic: Codable {
    var mailboxId: String
    var role: String
    var inviteeEmail: String
    var inviteeName: String?
    var expiresAt: String
    var status: String
}

struct InviteAcceptResponse: Codable {
    var mailboxId: String
    var userId: String
    var token: String
    var expiresAt: String
}

struct PasswordLoginResponse: Codable {
    var token: String
    var expiresAt: String
    var email: String?
    var sub: String?
    var keys: [String]?
}

struct ForgotPasswordResponse: Codable {
    var ok: Bool
    var message: String?
    var devResetCode: String?
    var devResetToken: String?
}

struct InviteCreateResponse: Codable {
    var token: String
    var inviteUrl: String
    var emailSent: Bool
    var emailError: String?
    var mailboxId: String
    var inviteeEmail: String
    var role: String
    var expiresAt: String
}

struct AdminMailboxRow: Codable, Identifiable {
    var id: String
    var email: String
    var name: String
    var acl: MailboxAcl?
    var claimed: Bool?
    var fromName: String?
}

struct AdminCreateMailboxInvite: Codable {
    var token: String?
    var inviteUrl: String?
    var emailSent: Bool?
    var emailError: String?
    var inviteeEmail: String?
    var role: String?
}

struct AdminCreateMailboxResponse: Codable {
    var id: String?
    var email: String?
    var name: String?
    var invite: AdminCreateMailboxInvite?
}

struct AdminDomainInfo: Codable, Identifiable, Hashable {
    var id: String { domain }
    var domain: String
    var zoneId: String
    var status: String
    var nameservers: [String]
    var createdAt: String?
    var updatedAt: String?
}

struct AdminDomainsResponse: Codable {
    var domains: [AdminDomainInfo]
}

struct EmailHealthItem: Codable, Identifiable, Hashable {
    var id: String { type + name }
    var name: String
    var type: String
    var status: String
    var expectedValue: String
    var currentValue: String?
    var message: String
}

struct EmailHealthAudit: Codable, Hashable {
    var overallStatus: String
    var zoneStatus: String
    var nameservers: [String]
    var items: [EmailHealthItem]
    var issues: [String]
}

struct DomainHealthResponse: Codable {
    var domain: String
    var zoneId: String
    var zoneStatus: String
    var nameservers: [String]
    var audit: EmailHealthAudit
}

struct FixEmailDnsResponse: Codable {
    var success: Bool
    var audit: EmailHealthAudit?
}

struct CloudflareDnsRecord: Codable, Identifiable, Hashable {
    var id: String
    var zone_id: String
    var zone_name: String
    var name: String
    var type: String
    var content: String
    var proxiable: Bool
    var proxied: Bool
    var ttl: Int
    var priority: Int?
    var comment: String?
}

struct DnsRecordsListResponse: Codable {
    var records: [CloudflareDnsRecord]
}

struct DnsRecordMutationResponse: Codable {
    var record: CloudflareDnsRecord
}

struct OnboardingPersonalResponse: Codable {
    var token: String
    var expiresAt: String
    var mailbox: OnboardingMailboxInfo
}

struct OnboardingMailboxInfo: Codable {
    var id: String
    var email: String
    var name: String
}

struct OnboardingDomainResponse: Codable {
    var token: String
    var expiresAt: String
    var mailbox: OnboardingMailboxInfo
    var domain: OnboardingDomainInfo
    var audit: EmailHealthAudit?
}

struct OnboardingDomainInfo: Codable {
    var domain: String
    var zoneId: String
    var status: String
    var nameservers: [String]
}

struct DomainPricingLineItem: Codable, Hashable {
    var name: String
    var description: String
    var amountUsd: Double
}

struct DomainPricingBreakdown: Codable, Hashable {
    var domainWholesaleUsd: Double
    var platformFeeUsd: Double
    var totalAnnualUsd: Double
    var currency: String
    var interval: String
    var lineItems: [DomainPricingLineItem]?
}

struct DomainAvailabilityResponse: Codable, Hashable {
    var domain: String
    var available: Bool
    var registered: Bool
    var wholesalePriceUsd: Double
    var retailPriceUsd: Double
    var currency: String
    var tldSupported: Bool
    var alreadyInInboxies: Bool?
    var message: String?
    var pricing: DomainPricingBreakdown?
}

struct CheckoutStatusResponse: Codable {
    var status: String
    var domain: String?
}

struct DomainCheckoutResponse: Codable {
    var checkoutUrl: String
    var sessionId: String
    var domain: String
    var priceUsd: Double
    var mock: Bool?
    var pricing: DomainPricingBreakdown?
}

struct DomainAliasItem: Codable, Hashable, Identifiable {
    var id: String { aliasLocal }
    var aliasLocal: String
    var aliasEmail: String
    var targetMailboxId: String
    var createdAt: String
}

struct DomainAliasesResponse: Codable {
    var domain: String
    var aliases: [DomainAliasItem]
}

struct ExportJobProgress: Codable, Hashable {
    var processedCount: Int
    var totalCount: Int
    var percent: Int
}

struct ExportJob: Codable, Identifiable, Hashable {
    var id: String
    var domain: String?
    var mailboxId: String?
    var status: String
    var progress: ExportJobProgress?
    var totalEmails: Int?
    var fileSizeBytes: Int64?
    var downloadUrl: String?
    var expiresAt: String?
    var createdAt: String?
    var error: String?
}

struct DecommissionLastExport: Codable, Hashable {
    var id: String
    var createdAt: String
    var downloadUrl: String?
    var totalEmails: Int
}

struct DecommissionPreflightResponse: Codable {
    var domain: String
    var status: String
    var activeMailboxCount: Int
    var activeMailboxes: [String]
    var hasRecentExport: Bool
    var lastExport: DecommissionLastExport?
    var isRegistrarDomain: Bool
    var transferLocked: Bool
}

struct DecommissionResponse: Codable {
    var success: Bool
    var domain: String
    var status: String
    var eppCode: String?
    var message: String
}

struct DomainEppCodeResponse: Codable {
    var domain: String
    var eppCode: String
}

struct DomainTransferLockResponse: Codable {
    var success: Bool
    var domain: String
    var locked: Bool
}

struct AdminDomainConnectResponse: Codable {
    var domain: AdminDomainInfo
    var audit: EmailHealthAudit?
}

struct MaskedAlias: Identifiable, Codable, Hashable {
    let id: String
    var mailboxId: String?
    let aliasEmail: String
    var label: String?
    var notes: String?
    var isActive: Bool
    var pausedAction: String
    var expiresAt: String?
    var forwardedCount: Int?
    var createdAt: String?
    var updatedAt: String?

    var active: Bool {
        isActive
    }

    enum CodingKeys: String, CodingKey {
        case id, label, notes
        case mailboxId = "mailbox_id"
        case aliasEmail = "alias_email"
        case isActive = "is_active"
        case pausedAction = "paused_action"
        case expiresAt = "expires_at"
        case forwardedCount = "forwarded_count"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    init(
        id: String,
        mailboxId: String? = nil,
        aliasEmail: String,
        label: String? = nil,
        notes: String? = nil,
        isActive: Bool = true,
        pausedAction: String = "drop",
        expiresAt: String? = nil,
        forwardedCount: Int? = 0,
        createdAt: String? = nil,
        updatedAt: String? = nil
    ) {
        self.id = id
        self.mailboxId = mailboxId
        self.aliasEmail = aliasEmail
        self.label = label
        self.notes = notes
        self.isActive = isActive
        self.pausedAction = pausedAction
        self.expiresAt = expiresAt
        self.forwardedCount = forwardedCount
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        mailboxId = try container.decodeIfPresent(String.self, forKey: .mailboxId)
        aliasEmail = try container.decode(String.self, forKey: .aliasEmail)
        label = try container.decodeIfPresent(String.self, forKey: .label)
        notes = try container.decodeIfPresent(String.self, forKey: .notes)
        if let boolVal = try? container.decode(Bool.self, forKey: .isActive) {
            isActive = boolVal
        } else if let intVal = try? container.decode(Int.self, forKey: .isActive) {
            isActive = intVal != 0
        } else {
            isActive = true
        }
        pausedAction = try container.decodeIfPresent(String.self, forKey: .pausedAction) ?? "drop"
        expiresAt = try container.decodeIfPresent(String.self, forKey: .expiresAt)
        forwardedCount = try container.decodeIfPresent(Int.self, forKey: .forwardedCount) ?? 0
        createdAt = try container.decodeIfPresent(String.self, forKey: .createdAt)
        updatedAt = try container.decodeIfPresent(String.self, forKey: .updatedAt)
    }
}

struct AliasesResponse: Codable {
    var aliases: [MaskedAlias]
}

struct CreateAliasResponse: Codable {
    var alias: MaskedAlias
}


