import SwiftUI
import UIKit

/// System sheet compose chrome matching Ask AI / email detail, Notion-styled fields.
struct ComposeSheetView: View {
    @Environment(AppModel.self) private var app
    var session: ComposeSession

    @State private var showCloseActions = false
    @State private var showFromPicker = false
    @State private var recipientFocus: Field?
    @FocusState private var focusedField: Field?

    private enum Field: Hashable {
        case to, cc, bcc, subject, body
    }

    private var form: ComposeFormModel { session.form }

    private var fromDisplayName: String {
        if let name = form.fromName, !name.isEmpty { return name }
        return form.fromEmail
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        titleRow
                        fromRow
                        toRow
                        if form.showCcBcc {
                            ccRow
                            bccRow
                        }
                        subjectRow
                        divider
                        bodyEditor
                            .frame(minHeight: 280)
                    }
                }
                if let error = form.errorMessage {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 8)
                }
            }
            .background(AppTheme.background)
            .navigationBarTitleDisplayMode(.inline)
            .onChange(of: focusedField) { _, new in
                if new == .subject || new == .body {
                    recipientFocus = nil
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        Task { handleClose() }
                    } label: {
                        Image (systemName: "xmark")
                            .symbolRenderingMode(.hierarchical)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await send() }
                    } label: {
                        Image(systemName: "arrow.up")
                            .symbolRenderingMode(.hierarchical)
                    }
                    .disabled(!canSend || form.isSending)
                    .accessibilityLabel("Send")
                }
            }
            .confirmationDialog("Draft", isPresented: $showCloseActions, titleVisibility: .visible) {
                Button("Delete Draft", role: .destructive) {
                    Task { await deleteAndClose() }
                }
                Button("Save Draft") {
                    Task {
                        if await form.saveDraft() {
                            app.minimizeCompose()
                        }
                    }
                }
                Button("Minimize") { app.minimizeCompose() }
                Button("Cancel", role: .cancel) {}
            }
            .confirmationDialog("From", isPresented: $showFromPicker, titleVisibility: .visible) {
                ForEach(app.mailboxes) { mailbox in
                    Button(mailbox.email) {
                        form.selectFrom(mailbox: mailbox)
                    }
                }
                Button("Cancel", role: .cancel) {}
            }
        }
    }

    private var titleRow: some View {
        Text(form.displayTitle)
            .font(.system(size: AppTheme.FontSize.largeTitle, weight: .bold))
            .foregroundStyle(AppTheme.ink)
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 12)
    }

    private var fromRow: some View {
        Button {
            if app.mailboxes.count > 1 {
                showFromPicker = true
            }
        } label: {
            HStack(spacing: 4) {
                Text("From \(fromDisplayName)")
                    .foregroundStyle(AppTheme.muted)
                    .lineLimit(1)
                    .font(.system(size: AppTheme.FontSize.sender, weight: .medium))
                if app.mailboxes.count > 1 {
                    Image(systemName: "chevron.down")
                        .font(.system(size: AppTheme.FontSize.chevron, weight: .semibold))
                        .foregroundStyle(AppTheme.muted)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(app.mailboxes.count <= 1)
    }

    private var toRow: some View {
        recipientRow(label: "To:", field: .to, showsOverflowMenu: true)
    }

    private var ccRow: some View {
        recipientRow(label: "Cc", field: .cc)
    }

    private var bccRow: some View {
        recipientRow(label: "Bcc", field: .bcc)
    }

    private var subjectRow: some View {
        TextField("Subject", text: Binding(
            get: { form.subject },
            set: { form.subject = $0 }
        ))
        .focused($focusedField, equals: .subject)
        .font(.system(size: AppTheme.FontSize.inlineTitle, weight: .medium))
        .foregroundStyle(AppTheme.ink)
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private var bodyEditor: some View {
        TextEditor(text: Binding(
            get: { form.body },
            set: { form.body = $0 }
        ))
        .focused($focusedField, equals: .body)
        .font(.system(size: AppTheme.FontSize.body))
        .foregroundStyle(AppTheme.ink)
        .scrollContentBackground(.hidden)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private var divider: some View {
        Rectangle()
            .fill(AppTheme.line)
            .frame(height: 1)
            .padding(.leading, 16)
    }

    private func recipientRow(label: String, field: Field, showsOverflowMenu: Bool = false) -> some View {
        let isActive = recipientFocus == field
        let labeledField = HStack(alignment: .top, spacing: 8) {
            Text(label)
                .font(.system(size: AppTheme.FontSize.meta, weight: .medium))
                .foregroundStyle(AppTheme.muted)
                .frame(minWidth: 28, alignment: .leading)
                .frame(height: CollapsedTokenMetrics.lineHeight)
            tokenField(for: field)
        }
        .frame(maxWidth: .infinity, alignment: .leading)

        return HStack(alignment: .top, spacing: 8) {
            if isActive {
                labeledField
            } else {
                labeledField
                    .contentShape(Rectangle())
                    .onTapGesture { activateRecipient(field) }
            }

            if showsOverflowMenu {
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        form.showCcBcc.toggle()
                    }
                    if form.showCcBcc {
                        activateRecipient(.cc)
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: AppTheme.FontSize.sender, weight: .semibold))
                        .foregroundStyle(AppTheme.muted)
                        .frame(width: 28, height: 18)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(form.showCcBcc ? "Hide Cc and Bcc" : "Show Cc and Bcc")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    @ViewBuilder
    private func tokenField(for field: Field) -> some View {
        switch field {
        case .to:
            tokenField(
                tokens: form.toTokens,
                draft: Binding(get: { form.toDraft }, set: { form.toDraft = $0 }),
                focus: .to,
                placeholder: "Add an email",
                onCommit: { form.commitPendingTokens() },
                onRemove: { form.removeTo($0) }
            )
        case .cc:
            tokenField(
                tokens: form.ccTokens,
                draft: Binding(get: { form.ccDraft }, set: { form.ccDraft = $0 }),
                focus: .cc,
                placeholder: "Add an email",
                onCommit: { form.commitPendingTokens() },
                onRemove: { form.removeCc($0) }
            )
        case .bcc:
            tokenField(
                tokens: form.bccTokens,
                draft: Binding(get: { form.bccDraft }, set: { form.bccDraft = $0 }),
                focus: .bcc,
                placeholder: "Add an email",
                onCommit: { form.commitPendingTokens() },
                onRemove: { form.removeBcc($0) }
            )
        case .subject, .body:
            EmptyView()
        }
    }

    private func activateRecipient(_ field: Field) {
        focusedField = nil
        recipientFocus = field
    }

    private func tokenField(
        tokens: [MailAddress],
        draft: Binding<String>,
        focus: Field,
        placeholder: String,
        onCommit: @escaping () -> Void,
        onRemove: @escaping (MailAddress) -> Void
    ) -> some View {
        RecipientTokenEditor(
            tokens: tokens,
            draft: draft,
            isFocused: recipientFocus == focus,
            placeholder: placeholder,
            onCommit: onCommit,
            onRemove: onRemove,
            onFocusChange: { focused in
                if focused {
                    activateRecipient(focus)
                } else if recipientFocus == focus {
                    recipientFocus = nil
                }
            }
        )
        .onChange(of: draft.wrappedValue) { _, newValue in
            if Self.shouldCommitToken(newValue) {
                onCommit()
            }
        }
    }

    private var canSend: Bool {
        !form.toTokens.isEmpty || !form.toDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private static func shouldCommitToken(_ text: String) -> Bool {
        let hasDelimiter = text.contains { $0 == "," || $0 == ";" }
        let hasSpacedEmail = text.contains { $0 == " " } && text.contains { $0 == "@" }
        return hasDelimiter || hasSpacedEmail
    }

    private func handleClose() {
        form.commitPendingTokens()
        if form.isEmpty {
            app.closeCompose()
        } else {
            showCloseActions = true
        }
    }

    private func send() async {
        if await form.send() {
            app.closeCompose()
            await app.loadEmailsForCurrentTab()
        }
    }

    private func deleteAndClose() async {
        if let draftId = form.draftId {
            try? await APIClient.shared.deleteEmail(mailboxId: form.fromMailboxId, id: draftId)
            await app.loadEmailsForCurrentTab()
        }
        app.closeCompose()
    }
}

/// Wrapping recipient chips plus a field that highlights the last token before deleting it.
private struct RecipientTokenEditor: View {
    let tokens: [MailAddress]
    @Binding var draft: String
    var isFocused: Bool
    var placeholder: String
    var onCommit: () -> Void
    var onRemove: (MailAddress) -> Void
    var onFocusChange: (Bool) -> Void

    @State private var pendingRemovalID: String?

    var body: some View {
        Group {
            if isFocused {
                expandedEditor
            } else {
                CollapsedTokenSummary(tokens: tokens, placeholder: placeholder)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(collapsedAccessibilityLabel)
                    .accessibilityHint("Edits recipients")
                    .accessibilityAddTraits(.isButton)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onChange(of: draft) { _, _ in
            guard pendingRemovalID != nil else { return }
            pendingRemovalID = nil
        }
        .onChange(of: isFocused) { _, focused in
            if focused {
                pendingRemovalID = nil
            } else {
                pendingRemovalID = nil
                onCommit()
            }
        }
        .onChange(of: tokens.map(\.id)) { _, ids in
            if let pendingRemovalID, !ids.contains(pendingRemovalID) {
                self.pendingRemovalID = nil
            }
        }
    }

    private var collapsedAccessibilityLabel: String {
        if tokens.isEmpty { return placeholder }
        let names = tokens.map(\.tokenLabel)
        if names.count <= 3 { return names.joined(separator: ", ") }
        return "\(names.prefix(3).joined(separator: ", ")) and \(names.count - 3) others"
    }

    private var expandedEditor: some View {
        FlowLayout(spacing: 6) {
            ForEach(tokens) { token in
                RecipientTokenPill(
                    token: token,
                    isPendingRemoval: token.id == pendingRemovalID,
                    onRemove: {
                        pendingRemovalID = nil
                        onRemove(token)
                    }
                )
            }
            BackspaceTextField(
                text: $draft,
                placeholder: tokens.isEmpty ? placeholder : "",
                isFocused: isFocused,
                onSubmit: onCommit,
                onDeleteBackwardWhenEmpty: handleDeleteWhenEmpty,
                onBeganEditing: { onFocusChange(true) }
            )
        }
        .frame(maxWidth: .infinity, minHeight: CollapsedTokenMetrics.lineHeight, alignment: .leading)
    }

    private func handleDeleteWhenEmpty() {
        guard let last = tokens.last else { return }
        if pendingRemovalID == last.id {
            pendingRemovalID = nil
            onRemove(last)
        } else {
            withAnimation(.easeInOut(duration: 0.12)) {
                pendingRemovalID = last.id
            }
        }
    }
}

private enum CollapsedTokenMetrics {
    static let spacing: CGFloat = 6
    static let minPillWidth: CGFloat = 56
    static let pillHorizontalPadding: CGFloat = 16
    static let pillFont = UIFont.systemFont(ofSize: AppTheme.FontSize.meta, weight: .medium)

    static var lineHeight: CGFloat {
        ceil(pillFont.lineHeight) + 8
    }

    static func overflowLabel(hidden: Int) -> String {
        "+ \(hidden) others"
    }

    static func textWidth(_ string: String) -> CGFloat {
        ceil((string as NSString).size(withAttributes: [.font: pillFont]).width)
    }

    static func naturalPillWidth(label: String) -> CGFloat {
        textWidth(label) + pillHorizontalPadding
    }

    static func overflowWidth(hidden: Int) -> CGFloat {
        guard hidden > 0 else { return 0 }
        return textWidth(overflowLabel(hidden: hidden)) + spacing
    }

    static func layout(
        tokens: [MailAddress],
        width: CGFloat
    ) -> (visible: [MailAddress], hidden: Int, widths: [CGFloat]) {
        guard !tokens.isEmpty else { return ([], 0, []) }
        let width = max(width, minPillWidth)

        for hidden in 0..<tokens.count {
            let visible = Array(tokens.prefix(tokens.count - hidden))
            var remaining = width - overflowWidth(hidden: hidden)
            var widths: [CGFloat] = []
            var fits = true

            for (index, token) in visible.enumerated() {
                let natural = naturalPillWidth(label: token.tokenLabel)
                let isLast = index == visible.count - 1
                if natural <= remaining {
                    widths.append(natural)
                    remaining -= natural + spacing
                } else if isLast, remaining >= minPillWidth {
                    widths.append(remaining)
                    remaining = 0
                } else {
                    fits = false
                    break
                }
            }

            if fits {
                return (visible, hidden, widths)
            }
        }

        let hidden = tokens.count - 1
        let firstWidth = max(minPillWidth, width - overflowWidth(hidden: hidden))
        return (Array(tokens.prefix(1)), hidden, [firstWidth])
    }
}

private struct CollapsedTokenSummary: View {
    let tokens: [MailAddress]
    var placeholder: String
    @State private var width: CGFloat = 0

    var body: some View {
        HStack(alignment: .center, spacing: CollapsedTokenMetrics.spacing) {
            if tokens.isEmpty {
                Text(placeholder)
                    .font(.system(size: AppTheme.FontSize.meta, weight: .medium))
                    .foregroundStyle(AppTheme.muted)
                    .lineLimit(1)
            } else {
                let plan = CollapsedTokenMetrics.layout(tokens: tokens, width: width)
                ForEach(Array(plan.visible.enumerated()), id: \.element.id) { index, token in
                    RecipientTokenPill(
                        token: token,
                        isPendingRemoval: false,
                        showsRemove: false,
                        maxWidth: plan.widths[index],
                        onRemove: {}
                    )
                }
                if plan.hidden > 0 {
                    Text(CollapsedTokenMetrics.overflowLabel(hidden: plan.hidden))
                        .font(.system(size: AppTheme.FontSize.meta, weight: .medium))
                        .foregroundStyle(AppTheme.muted)
                        .lineLimit(1)
                        .fixedSize()
                }
            }
        }
        .frame(maxWidth: .infinity, minHeight: CollapsedTokenMetrics.lineHeight, alignment: .leading)
        .contentShape(Rectangle())
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.size.width
        } action: { newWidth in
            guard abs(width - newWidth) > 0.5 else { return }
            width = newWidth
        }
    }
}

private struct RecipientTokenPill: View {
    let token: MailAddress
    var isPendingRemoval: Bool
    var showsRemove: Bool = true
    var maxWidth: CGFloat? = nil
    var onRemove: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            Text(token.tokenLabel)
                .font(.system(size: AppTheme.FontSize.meta, weight: .medium))
                .lineLimit(1)
                .truncationMode(.tail)
            if showsRemove {
                Button(action: onRemove) {
                    Image(systemName: "xmark")
                        .font(.system(size: AppTheme.FontSize.chevron, weight: .semibold))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Remove \(token.tokenLabel)")
            }
        }
        .padding(.leading, 8)
        .padding(.trailing, showsRemove ? 6 : 8)
        .padding(.vertical, 4)
        .frame(maxWidth: maxWidth, alignment: .leading)
        .background(isPendingRemoval ? AppTheme.pillActive : AppTheme.pillFill)
        .clipShape(Capsule())
        .foregroundStyle(isPendingRemoval ? AppTheme.ink : AppTheme.muted)
        .fixedSize(horizontal: maxWidth == nil, vertical: true)
        .accessibilityAddTraits(isPendingRemoval ? .isSelected : [])
        .accessibilityValue(token.email)
        .accessibilityHint(showsRemove ? (isPendingRemoval ? "Delete again to remove" : "Double tap the close button to remove") : "")
    }
}

/// Email field that reports backspace when empty so tokens can be selected, then removed.
private struct BackspaceTextField: UIViewRepresentable {
    @Binding var text: String
    var placeholder: String
    var isFocused: Bool
    var onSubmit: () -> Void
    var onDeleteBackwardWhenEmpty: () -> Void
    var onBeganEditing: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> TokenUITextField {
        let field = TokenUITextField()
        field.delegate = context.coordinator
        field.borderStyle = .none
        field.backgroundColor = .clear
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.spellCheckingType = .no
        field.keyboardType = .emailAddress
        field.returnKeyType = .next
        field.tintColor = UIColor(AppTheme.ink)
        field.textColor = UIColor(AppTheme.ink)
        field.font = UIFont.systemFont(ofSize: AppTheme.FontSize.recipient)
        field.setContentHuggingPriority(.required, for: .horizontal)
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        field.addTarget(context.coordinator, action: #selector(Coordinator.editingChanged), for: .editingChanged)
        context.coordinator.text = $text
        context.coordinator.onSubmit = onSubmit
        context.coordinator.onDeleteBackwardWhenEmpty = onDeleteBackwardWhenEmpty
        context.coordinator.onBeganEditing = onBeganEditing
        field.onDeleteBackwardWhenEmpty = { [weak coordinator = context.coordinator] in
            coordinator?.onDeleteBackwardWhenEmpty()
        }
        return field
    }

    func updateUIView(_ uiView: TokenUITextField, context: Context) {
        context.coordinator.text = $text
        context.coordinator.onSubmit = onSubmit
        context.coordinator.onDeleteBackwardWhenEmpty = onDeleteBackwardWhenEmpty
        context.coordinator.onBeganEditing = onBeganEditing
        uiView.onDeleteBackwardWhenEmpty = { [weak coordinator = context.coordinator] in
            coordinator?.onDeleteBackwardWhenEmpty()
        }

        if uiView.isFirstResponder {
            // Don't push SwiftUI's lagged string back into a live field (wipes the
            // latest character). Only apply SwiftUI changes that clear after commit.
            if text.isEmpty, !(uiView.text ?? "").isEmpty {
                uiView.text = ""
            }
        } else if uiView.text != text {
            uiView.text = text
        }
        if uiView.placeholder != placeholder {
            uiView.attributedPlaceholder = NSAttributedString(
                string: placeholder,
                attributes: [
                    .foregroundColor: UIColor(AppTheme.muted),
                    .font: UIFont.systemFont(ofSize: AppTheme.FontSize.recipient),
                ]
            )
        }

        // Only resign after SwiftUI has acknowledged this field was focused and then
        // moved focus elsewhere. Resigning whenever `isFocused` is false drops the
        // keyboard on the first keystroke (FocusState lags the UIKit first responder).
        if isFocused {
            context.coordinator.swiftUIOwnsFocus = true
            if !uiView.isFirstResponder {
                DispatchQueue.main.async {
                    guard context.coordinator.swiftUIOwnsFocus else { return }
                    uiView.becomeFirstResponder()
                }
            }
        } else if context.coordinator.swiftUIOwnsFocus {
            context.coordinator.swiftUIOwnsFocus = false
            if uiView.isFirstResponder {
                uiView.resignFirstResponder()
            }
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: TokenUITextField, context: Context) -> CGSize? {
        uiView.intrinsicContentSize
    }

    final class Coordinator: NSObject, UITextFieldDelegate {
        var text: Binding<String> = .constant("")
        var onSubmit: () -> Void = {}
        var onDeleteBackwardWhenEmpty: () -> Void = {}
        var onBeganEditing: () -> Void = {}
        var swiftUIOwnsFocus = false

        @objc func editingChanged(_ textField: UITextField) {
            let value = textField.text ?? ""
            if text.wrappedValue != value {
                text.wrappedValue = value
            }
        }

        func textFieldDidBeginEditing(_ textField: UITextField) {
            onBeganEditing()
        }

        func textFieldShouldReturn(_ textField: UITextField) -> Bool {
            onSubmit()
            return true
        }
    }
}

private final class TokenUITextField: UITextField {
    var onDeleteBackwardWhenEmpty: (() -> Void)?

    /// Keep a stable size so FlowLayout does not relayout (and steal focus) per keystroke.
    override var intrinsicContentSize: CGSize {
        CGSize(width: 128, height: CollapsedTokenMetrics.lineHeight)
    }

    override func deleteBackward() {
        if (text ?? "").isEmpty {
            onDeleteBackwardWhenEmpty?()
            return
        }
        super.deleteBackward()
    }
}
