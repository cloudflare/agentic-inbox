import Foundation
import Observation
import SwiftUI

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

enum DraftSaveStatus: Equatable {
    case idle
    case saving
    case saved(Date)
    case failed(String)
}

struct ComposeToast: Equatable {
    let message: String
    var isError: Bool = false
    let id = UUID()
}

@Observable
@MainActor
final class ComposeFormModel {
    let mode: ComposeMode
    var fromMailboxId: String
    var fromEmail: String
    var fromName: String?

    var toTokens: [MailAddress] = [] {
        didSet {
            if toTokens != oldValue { scheduleAutoSave() }
        }
    }
    var ccTokens: [MailAddress] = [] {
        didSet {
            if ccTokens != oldValue { scheduleAutoSave() }
        }
    }
    var bccTokens: [MailAddress] = [] {
        didSet {
            if bccTokens != oldValue { scheduleAutoSave() }
        }
    }
    var toDraft = ""
    var ccDraft = ""
    var bccDraft = ""
    var showCcBcc = false
    var subject = "" {
        didSet {
            if subject != oldValue { scheduleAutoSave() }
        }
    }
    var body = "" {
        didSet {
            if body != oldValue { scheduleAutoSave() }
        }
    }
    let quotedOriginal: QuotedOriginal?

    var originalEmailId: String?
    var threadId: String?
    var draftId: String?

    var isSending = false
    var isSavingDraft = false
    var saveStatus: DraftSaveStatus = .idle
    var toast: ComposeToast?
    var errorMessage: String?

    private let initialSnapshot: String
    private var lastSavedSnapshot: String
    private var autoSaveTask: Task<Void, Never>?
    private var toastDismissTask: Task<Void, Never>?
    private var consecutiveFailures = 0
    private let continuousFailureThreshold = 3

    var onDraftSaved: ((_ draftId: String, _ threadId: String?, _ originalEmailId: String?, _ subject: String?, _ body: String?) -> Void)?
    var onDraftDeleted: ((_ draftId: String, _ threadId: String?, _ originalEmailId: String?) -> Void)?

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

        let signature = ComposeHTML.signatureText(settings: mailbox.settings, fromName: mailboxFromName)

        var nextTo: [MailAddress] = []
        var nextCc: [MailAddress] = []
        var nextBcc: [MailAddress] = []
        var nextShowCcBcc = false
        var nextSubject = ""
        var nextBody = ""
        var nextQuoted: QuotedOriginal?
        var nextOriginalId: String?
        var nextThreadId: String?
        var nextDraftId: String?

        if mode == .reply || mode == .replyAll, let original {
            nextQuoted = ComposeHTML.quotedOriginal(from: original)
        }

        if let draft {
            nextDraftId = draft.id
            nextOriginalId = draft.inReplyTo
            nextThreadId = draft.threadId
            nextTo = MailAddress.parseList(draft.recipient)
            nextCc = MailAddress.parseList(draft.cc)
            nextBcc = MailAddress.parseList(draft.bcc)
            nextShowCcBcc = !nextCc.isEmpty || !nextBcc.isEmpty
            nextSubject = draft.subject
            nextBody = ComposeHTML.editableReply(
                fromDraftHTML: draft.body ?? "",
                quotedHeader: nextQuoted?.header
            )
        } else if let original {
            nextOriginalId = original.id
            nextThreadId = original.threadId ?? original.id
            switch mode {
            case .reply:
                nextTo = [original.fromAddress]
                nextSubject = ComposeHTML.prefixedSubject(original.subject, prefix: "Re")
                nextBody = ComposeHTML.replyBody(signature: signature)
            case .replyAll:
                let fields = ComposeHTML.replyAllFields(original: original, selfAddress: mailboxEmail)
                nextTo = fields.to
                nextCc = fields.cc
                nextShowCcBcc = !fields.cc.isEmpty
                nextSubject = ComposeHTML.prefixedSubject(original.subject, prefix: "Re")
                nextBody = ComposeHTML.replyBody(signature: signature)
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
        self.quotedOriginal = nextQuoted
        self.originalEmailId = nextOriginalId
        self.threadId = nextThreadId
        self.draftId = nextDraftId
        let initial = Self.snapshot(
            to: nextTo, cc: nextCc, bcc: nextBcc,
            subject: nextSubject, body: nextBody, from: mailboxEmail
        )
        self.initialSnapshot = initial
        self.lastSavedSnapshot = initial
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

    var currentSnapshot: String {
        Self.snapshot(
            to: toTokens, cc: ccTokens, bcc: bccTokens,
            subject: subject, body: body, from: fromEmail
        )
    }

    var hasUnsavedChanges: Bool {
        let hasPendingRecipients = !toDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !ccDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !bccDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return currentSnapshot != lastSavedSnapshot || hasPendingRecipients
    }

    var isDirty: Bool {
        return currentSnapshot != initialSnapshot || (draftId != nil && !isEmpty)
    }

    func scheduleAutoSave(debounceSeconds: Double = 3.0) {
        guard !isSending else { return }
        autoSaveTask?.cancel()
        autoSaveTask = Task { @MainActor in
            do {
                try await Task.sleep(for: .seconds(debounceSeconds))
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            guard !isEmpty && hasUnsavedChanges else { return }
            _ = await performSaveDraft(explicit: false)
        }
    }

    func cancelAutoSave() {
        autoSaveTask?.cancel()
        autoSaveTask = nil
    }

    func showToast(_ message: String, isError: Bool = false) {
        toastDismissTask?.cancel()
        withAnimation(.spring(response: 0.3, dampingFraction: 0.82)) {
            toast = ComposeToast(message: message, isError: isError)
        }
        toastDismissTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(2.5))
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.25)) {
                toast = nil
            }
        }
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
    func saveDraft(explicit: Bool = true) async -> Bool {
        cancelAutoSave()
        return await performSaveDraft(explicit: explicit)
    }

    @discardableResult
    private func performSaveDraft(explicit: Bool) async -> Bool {
        commitPendingTokens()

        guard !isEmpty else {
            return true
        }
        guard hasUnsavedChanges || draftId == nil else {
            if explicit {
                showToast("Draft saved")
            }
            return true
        }
        guard !isSavingDraft else {
            return false
        }

        // Preview support: simulate successful draft save in Xcode Previews / canvas mock fixtures
        if ProcessInfo.processInfo.environment["XCODE_RUNNING_FOR_PREVIEWS"] == "1" || fromMailboxId.hasPrefix("mb-") {
            try? await Task.sleep(for: .milliseconds(300))
            if draftId == nil { draftId = UUID().uuidString }
            lastSavedSnapshot = currentSnapshot
            saveStatus = .saved(Date())
            consecutiveFailures = 0
            if explicit {
                showToast("Draft saved")
            }
            if let draftId {
                onDraftSaved?(draftId, threadId, originalEmailId, subject, outgoingHTML())
            }
            return true
        }

        isSavingDraft = true
        saveStatus = .saving
        errorMessage = nil
        defer { isSavingDraft = false }
        do {
            var payload: [String: Any] = [
                "body": outgoingHTML(),
            ]
            if !toTokens.isEmpty { payload["to"] = toTokens.map(\.email).joined(separator: ", ") }
            if !ccTokens.isEmpty { payload["cc"] = ccTokens.map(\.email).joined(separator: ", ") }
            if !bccTokens.isEmpty { payload["bcc"] = bccTokens.map(\.email).joined(separator: ", ") }
            if !subject.isEmpty { payload["subject"] = subject }
            if let originalEmailId { payload["in_reply_to"] = originalEmailId }
            if let threadId { payload["thread_id"] = threadId }
            if let draftId { payload["draft_id"] = draftId }

            let saved = try await APIClient.shared.saveDraft(mailboxId: fromMailboxId, draft: payload)
            draftId = saved.resolvedId.isEmpty ? (draftId ?? saved.id) : saved.resolvedId
            lastSavedSnapshot = currentSnapshot
            saveStatus = .saved(Date())
            consecutiveFailures = 0
            if explicit {
                showToast("Draft saved")
            }
            if let draftId {
                onDraftSaved?(draftId, threadId, originalEmailId, subject, outgoingHTML())
            }
            return true
        } catch {
            print("[ComposeFormModel] saveDraft error: \(error)")
            errorMessage = error.localizedDescription
            saveStatus = .failed(error.localizedDescription)
            consecutiveFailures += 1
            if explicit || consecutiveFailures >= continuousFailureThreshold {
                showToast("Failed to save draft", isError: true)
            }
            return false
        }
    }

    @discardableResult
    func send() async -> Bool {
        cancelAutoSave()
        commitPendingTokens()
        guard !toTokens.isEmpty else {
            errorMessage = "Add at least one recipient."
            return false
        }
        isSending = true
        errorMessage = nil
        defer { isSending = false }

        let html = outgoingHTML()
        let text = outgoingPlainText()
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
                onDraftDeleted?(draftId, threadId, originalEmailId)
            }
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    private func outgoingHTML() -> String {
        var html = ComposeHTML.textToHTML(body)
        if let quotedOriginal {
            html += ComposeHTML.quotedHTML(from: quotedOriginal)
        }
        return html
    }

    private func outgoingPlainText() -> String {
        guard let quotedOriginal else { return body }
        let quotedLines = quotedOriginal.text
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { "> \($0)" }
        return ([body, "", quotedOriginal.header] + quotedLines).joined(separator: "\n")
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

struct QuotedOriginal: Equatable {
    var header: String
    var text: String
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

    /// Signature inserted into compose when mailbox signature is enabled.
    static func signatureText(settings: MailboxSettings?, fromName: String?) -> String {
        guard settings?.signature?.enabled == true else { return "" }
        if let html = settings?.signature?.html?.trimmingCharacters(in: .whitespacesAndNewlines),
           !html.isEmpty {
            return stripHTML(html)
        }
        if let text = settings?.signature?.text?.trimmingCharacters(in: .whitespacesAndNewlines),
           !text.isEmpty {
            return text
        }
        return signatureLine(fromName: fromName)
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

    static func replyBody(signature: String) -> String {
        var parts: [String] = [""]
        if !signature.isEmpty { parts.append(signature) }
        return parts.joined(separator: "\n")
    }

    static func quotedOriginal(from original: Email) -> QuotedOriginal? {
        let text = stripHTML(original.body ?? original.snippet ?? "")
        guard !text.isEmpty else { return nil }
        return QuotedOriginal(
            header: "On \(formatDate(original.date)), \(original.formattedFrom) wrote:",
            text: text
        )
    }

    static func quotedHTML(from quoted: QuotedOriginal) -> String {
        let header = escapeHTML(quoted.header)
        let bodyToQuote = escapeHTML(quoted.text).replacingOccurrences(of: "\n", with: "<br>")
        return "<br><blockquote style=\"border-left: 2px solid #ccc; margin: 0; padding-left: 1em; color: #666;\">\(header)<br><br>\(bodyToQuote)</blockquote>"
    }

    /// Pull the user's reply out of a saved draft, dropping the inlined original.
    static func editableReply(fromDraftHTML html: String, quotedHeader: String?) -> String {
        var text = htmlToEditableText(html)
        if let quotedHeader, let range = text.range(of: quotedHeader, options: .backwards) {
            text = String(text[..<range.lowerBound])
        } else if let regex = try? NSRegularExpression(
            pattern: #"^On .+ wrote:\s*$"#,
            options: .anchorsMatchLines
        ) {
            let nsRange = NSRange(text.startIndex..., in: text)
            if let match = regex.matches(in: text, range: nsRange).last,
               let range = Range(match.range, in: text) {
                text = String(text[..<range.lowerBound])
            }
        }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
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
