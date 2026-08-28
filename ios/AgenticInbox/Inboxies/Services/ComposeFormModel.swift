import Foundation
import Observation

/// App-owned compose session so minimize docks instead of destroying the draft.
@Observable
@MainActor
final class ComposeSession {
    var presentation: ComposePresentation
    let form: ComposeFormModel

    init(form: ComposeFormModel, presentation: ComposePresentation = .expanded) {
        self.form = form
        self.presentation = presentation
    }

    var dockTitle: String { form.displayTitle }
    var isExpanded: Bool { presentation == ComposePresentation.expanded }
    var isMinimized: Bool { presentation == ComposePresentation.minimized }

    func expand() { presentation = ComposePresentation.expanded }
    func minimize() { presentation = ComposePresentation.minimized }
}

@Observable
@MainActor
final class ComposeFormModel {
    let mode: ComposeMode
    var fromMailboxId: String
    var fromEmail: String
    var fromName: String?

    var toTokens: [MailAddress] = []
    var ccTokens: [MailAddress] = []
    var bccTokens: [MailAddress] = []
    var toDraft = ""
    var ccDraft = ""
    var bccDraft = ""
    var showCcBcc = false
    var subject = ""
    var body = ""

    var originalEmailId: String?
    var threadId: String?
    var draftId: String?

    var isSending = false
    var isSavingDraft = false
    var errorMessage: String?

    private let initialSnapshot: String

    init(
        mode: ComposeMode,
        mailbox: Mailbox,
        original: Email? = nil,
        draft: Email? = nil
    ) {
        self.mode = mode
        let mailboxId = mailbox.id
        let mailboxEmail = mailbox.email
        let mailboxFromName = mailbox.settings?.fromName ?? (mailbox.name != mailbox.email ? mailbox.name : nil)
        self.fromMailboxId = mailboxId
        self.fromEmail = mailboxEmail
        self.fromName = mailboxFromName

        let signature = ComposeHTML.signatureLine(fromName: mailboxFromName)

        var nextTo: [MailAddress] = []
        var nextCc: [MailAddress] = []
        var nextBcc: [MailAddress] = []
        var nextShowCcBcc = false
        var nextSubject = ""
        var nextBody = ""
        var nextOriginalId: String?
        var nextThreadId: String?
        var nextDraftId: String?

        if let draft {
            nextDraftId = draft.id
            nextOriginalId = draft.inReplyTo
            nextThreadId = draft.threadId
            nextTo = MailAddress.parseList(draft.recipient)
            nextCc = MailAddress.parseList(draft.cc)
            nextBcc = MailAddress.parseList(draft.bcc)
            nextShowCcBcc = !nextCc.isEmpty || !nextBcc.isEmpty
            nextSubject = draft.subject
            nextBody = ComposeHTML.htmlToEditableText(draft.body ?? "")
        } else if let original {
            nextOriginalId = original.id
            nextThreadId = original.threadId ?? original.id
            switch mode {
            case .reply:
                nextTo = [original.fromAddress]
                nextSubject = ComposeHTML.prefixedSubject(original.subject, prefix: "Re")
                nextBody = ComposeHTML.replyBody(original: original, signature: signature)
            case .replyAll:
                let fields = ComposeHTML.replyAllFields(original: original, selfAddress: mailboxEmail)
                nextTo = fields.to
                nextCc = fields.cc
                nextShowCcBcc = !fields.cc.isEmpty
                nextSubject = ComposeHTML.prefixedSubject(original.subject, prefix: "Re")
                nextBody = ComposeHTML.replyBody(original: original, signature: signature)
            case .forward:
                nextSubject = ComposeHTML.prefixedSubject(original.subject, prefix: "Fwd")
                nextBody = ComposeHTML.forwardBody(original: original, signature: signature)
            case .new, .editDraft:
                nextBody = signature.isEmpty ? "" : "\n\n\(signature)"
            }
        } else {
            nextBody = signature.isEmpty ? "" : "\n\n\(signature)"
        }

        self.toTokens = nextTo
        self.ccTokens = nextCc
        self.bccTokens = nextBcc
        self.showCcBcc = nextShowCcBcc
        self.subject = nextSubject
        self.body = nextBody
        self.originalEmailId = nextOriginalId
        self.threadId = nextThreadId
        self.draftId = nextDraftId
        self.initialSnapshot = Self.snapshot(
            to: nextTo, cc: nextCc, bcc: nextBcc,
            subject: nextSubject, body: nextBody, from: mailboxEmail
        )
    }

    var title: String {
        switch mode {
        case .new: return "New Message"
        case .reply: return "Reply"
        case .replyAll: return "Reply All"
        case .forward: return "Forward"
        case .editDraft: return "Edit Draft"
        }
    }

    /// Nav / dock title: subject when set, otherwise mode title.
    var displayTitle: String {
        let trimmed = subject.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return trimmed }
        return title
    }

    var isEmpty: Bool {
        toTokens.isEmpty && ccTokens.isEmpty && bccTokens.isEmpty
            && toDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && subject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var isDirty: Bool {
        let current = Self.snapshot(
            to: toTokens, cc: ccTokens, bcc: bccTokens,
            subject: subject, body: body, from: fromEmail
        )
        return current != initialSnapshot || draftId != nil && !isEmpty
    }

    func commitPendingTokens() {
        commit(&toDraft, into: &toTokens)
        commit(&ccDraft, into: &ccTokens)
        commit(&bccDraft, into: &bccTokens)
    }

    func removeTo(_ token: MailAddress) { toTokens.removeAll { $0.id == token.id } }
    func removeCc(_ token: MailAddress) { ccTokens.removeAll { $0.id == token.id } }
    func removeBcc(_ token: MailAddress) { bccTokens.removeAll { $0.id == token.id } }

    func selectFrom(mailbox: Mailbox) {
        fromMailboxId = mailbox.id
        fromEmail = mailbox.email
        fromName = mailbox.settings?.fromName ?? (mailbox.name != mailbox.email ? mailbox.name : nil)
    }

    @discardableResult
    func saveDraft() async -> Bool {
        commitPendingTokens()
        isSavingDraft = true
        errorMessage = nil
        defer { isSavingDraft = false }
        do {
            var payload: [String: Any] = [
                "body": ComposeHTML.textToHTML(body),
            ]
            if !toTokens.isEmpty { payload["to"] = toTokens.map(\.email).joined(separator: ", ") }
            if !ccTokens.isEmpty { payload["cc"] = ccTokens.map(\.email).joined(separator: ", ") }
            if !bccTokens.isEmpty { payload["bcc"] = bccTokens.map(\.email).joined(separator: ", ") }
            if !subject.isEmpty { payload["subject"] = subject }
            if let originalEmailId { payload["in_reply_to"] = originalEmailId }
            if let threadId { payload["thread_id"] = threadId }
            if let draftId { payload["draft_id"] = draftId }

            let saved = try await APIClient.shared.saveDraft(mailboxId: fromMailboxId, draft: payload)
            draftId = saved.id
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    @discardableResult
    func send() async -> Bool {
        commitPendingTokens()
        guard !toTokens.isEmpty else {
            errorMessage = "Add at least one recipient."
            return false
        }
        isSending = true
        errorMessage = nil
        defer { isSending = false }

        let html = ComposeHTML.textToHTML(body)
        let text = body
        var payload: [String: Any] = [
            "subject": subject,
            "html": html,
            "text": text,
        ]
        let toEmails = toTokens.map(\.email)
        payload["to"] = toEmails.count == 1 ? toEmails[0] as Any : toEmails as Any
        if !ccTokens.isEmpty {
            let ccEmails = ccTokens.map(\.email)
            payload["cc"] = ccEmails.count == 1 ? ccEmails[0] as Any : ccEmails as Any
        }
        if !bccTokens.isEmpty {
            let bccEmails = bccTokens.map(\.email)
            payload["bcc"] = bccEmails.count == 1 ? bccEmails[0] as Any : bccEmails as Any
        }
        if let fromName, !fromName.isEmpty {
            payload["from"] = ["email": fromEmail, "name": fromName]
        } else {
            payload["from"] = fromEmail
        }

        do {
            switch mode {
            case .reply, .replyAll:
                guard let originalEmailId else {
                    errorMessage = "Missing original email for reply."
                    return false
                }
                _ = try await APIClient.shared.replyToEmail(
                    mailboxId: fromMailboxId,
                    emailId: originalEmailId,
                    payload: payload
                )
            case .forward:
                guard let originalEmailId else {
                    errorMessage = "Missing original email for forward."
                    return false
                }
                _ = try await APIClient.shared.forwardEmail(
                    mailboxId: fromMailboxId,
                    emailId: originalEmailId,
                    payload: payload
                )
            case .new, .editDraft:
                _ = try await APIClient.shared.sendEmail(mailboxId: fromMailboxId, payload: payload)
            }

            if let draftId {
                try? await APIClient.shared.deleteEmail(mailboxId: fromMailboxId, id: draftId)
            }
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    private func commit(_ draft: inout String, into tokens: inout [MailAddress]) {
        let parts = MailAddress.parseList(draft)
        for part in parts where !tokens.contains(where: { $0.id == part.id }) {
            tokens.append(part)
        }
        draft = ""
    }

    private static func snapshot(
        to: [MailAddress], cc: [MailAddress], bcc: [MailAddress],
        subject: String, body: String, from: String
    ) -> String {
        [
            to.map(\.email).joined(separator: ","),
            cc.map(\.email).joined(separator: ","),
            bcc.map(\.email).joined(separator: ","),
            subject,
            body,
            from,
        ]
            .joined(separator: "|")
    }
}

enum ComposeHTML {
    static func splitAddresses(_ raw: String?) -> [String] {
        guard let raw, !raw.isEmpty else { return [] }
        return raw
            .split(whereSeparator: { $0 == "," || $0 == ";" || $0 == "\n" })
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    static func prefixedSubject(_ subject: String, prefix: String) -> String {
        let expected = "\(prefix): "
        return subject.hasPrefix(expected) ? subject : expected + subject
    }

    static func signatureLine(fromName: String?) -> String {
        guard let fromName, !fromName.isEmpty else { return "" }
        return fromName
    }

    static func stripHTML(_ html: String) -> String {
        html
            .replacingOccurrences(of: "<br>", with: "\n", options: .caseInsensitive)
            .replacingOccurrences(of: "<br/>", with: "\n", options: .caseInsensitive)
            .replacingOccurrences(of: "<br />", with: "\n", options: .caseInsensitive)
            .replacingOccurrences(of: "</p>", with: "\n\n", options: .caseInsensitive)
            .replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
            .replacingOccurrences(of: "&nbsp;", with: " ")
            .replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func htmlToEditableText(_ html: String) -> String {
        stripHTML(html)
    }

    static func escapeHTML(_ text: String) -> String {
        text
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
    }

    static func textToHTML(_ text: String) -> String {
        let escaped = escapeHTML(text)
        let withBreaks = escaped.replacingOccurrences(of: "\n", with: "<br>")
        return "<p>\(withBreaks)</p>"
    }

    static func replyBody(original: Email, signature: String) -> String {
        let quoted = stripHTML(original.body ?? "")
        let header = "On \(formatDate(original.date)), \(original.formattedFrom) wrote:"
        var parts: [String] = [""]
        if !signature.isEmpty { parts.append(signature) }
        parts.append("")
        parts.append(header)
        parts.append(contentsOf: quoted.split(separator: "\n", omittingEmptySubsequences: false).map { "> \($0)" })
        return parts.joined(separator: "\n")
    }

    static func forwardBody(original: Email, signature: String) -> String {
        var parts: [String] = [""]
        if !signature.isEmpty { parts.append(signature) }
        parts.append("")
        parts.append("---------- Forwarded message ----------")
        parts.append("From: \(original.formattedFrom)")
        parts.append("Date: \(formatDate(original.date))")
        parts.append("Subject: \(original.subject)")
        parts.append("To: \(original.recipient)")
        parts.append("")
        parts.append(stripHTML(original.body ?? ""))
        return parts.joined(separator: "\n")
    }

    static func replyAllFields(original: Email, selfAddress: String) -> (to: [MailAddress], cc: [MailAddress]) {
        let selfLower = selfAddress.lowercased()
        var to: [MailAddress] = []
        var toSeen = Set<String>()

        func appendUnique(_ address: MailAddress, into list: inout [MailAddress], seen: inout Set<String>) {
            let email = address.email.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !email.isEmpty else { return }
            let normalized = email.lowercased()
            guard normalized != selfLower, !seen.contains(normalized) else { return }
            seen.insert(normalized)
            list.append(address)
        }

        appendUnique(original.fromAddress, into: &to, seen: &toSeen)
        for recipient in original.toAddresses {
            appendUnique(recipient, into: &to, seen: &toSeen)
        }

        var cc: [MailAddress] = []
        var ccSeen = Set<String>()
        for recipient in original.ccAddresses {
            let normalized = recipient.email.lowercased()
            if normalized == selfLower || toSeen.contains(normalized) || ccSeen.contains(normalized) {
                continue
            }
            ccSeen.insert(normalized)
            cc.append(recipient)
        }
        return (to, cc)
    }

    private static func formatDate(_ iso: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = formatter.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let date else { return iso }
        let out = DateFormatter()
        out.dateStyle = .medium
        out.timeStyle = .short
        return out.string(from: date)
    }
}
