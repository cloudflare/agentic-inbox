import SwiftUI

/// System sheet compose chrome matching Ask AI / email detail, Notion-styled fields.
struct ComposeSheetView: View {
    @Environment(AppModel.self) private var app
    var session: ComposeSession

    @State private var showCloseActions = false
    @State private var showFromPicker = false
    @FocusState private var focusedField: Field?

    private enum Field: Hashable {
        case to, cc, bcc, subject, body
    }

    private static let recipientFont = Font.system(size: 13)

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
            .font(.system(size: 26, weight: .bold))
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
                    .font(.system(size: 14, weight: .semibold))
                if app.mailboxes.count > 1 {
                    Image(systemName: "chevron.down")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(AppTheme.muted)
                }
                Spacer(minLength: 0)
            }
            .font(.system(size: 12))
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(app.mailboxes.count <= 1)
    }

    private var toRow: some View {
        recipientRow(label: "To:") {
            tokenField(
                tokens: form.toTokens,
                draft: Binding(
                    get: { form.toDraft },
                    set: { form.toDraft = $0 }
                ),
                focus: .to,
                placeholder: "Add an email",
                onCommit: { form.commitPendingTokens() },
                onRemove: { form.removeTo($0) }
            )
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    form.showCcBcc.toggle()
                }
                if form.showCcBcc {
                    focusedField = .cc
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(AppTheme.muted)
                    .frame(width: 28, height: 18)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(form.showCcBcc ? "Hide Cc and Bcc" : "Show Cc and Bcc")
        }
    }

    private var ccRow: some View {
        recipientRow(label: "Cc") {
            tokenField(
                tokens: form.ccTokens,
                draft: Binding(get: { form.ccDraft }, set: { form.ccDraft = $0 }),
                focus: .cc,
                placeholder: "Add an email",
                onCommit: { form.commitPendingTokens() },
                onRemove: { form.removeCc($0) }
            )
        }
    }

    private var bccRow: some View {
        recipientRow(label: "Bcc") {
            tokenField(
                tokens: form.bccTokens,
                draft: Binding(get: { form.bccDraft }, set: { form.bccDraft = $0 }),
                focus: .bcc,
                placeholder: "Add an email",
                onCommit: { form.commitPendingTokens() },
                onRemove: { form.removeBcc($0) }
            )
        }
    }

    private var subjectRow: some View {
        TextField("Subject", text: Binding(
            get: { form.subject },
            set: { form.subject = $0 }
        ))
        .focused($focusedField, equals: .subject)
        .font(.system(size: 14, weight: .medium))
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
        .font(.system(size: 17))
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

    private func recipientRow<Content: View>(label: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(label)
                .font(Self.recipientFont)
                .foregroundStyle(AppTheme.muted)
                .frame(minWidth: 28, alignment: .leading)
            content()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private func tokenField(
        tokens: [String],
        draft: Binding<String>,
        focus: Field,
        placeholder: String,
        onCommit: @escaping () -> Void,
        onRemove: @escaping (String) -> Void
    ) -> some View {
        FlowRecipientTokens(tokens: tokens, onRemove: onRemove) {
            TextField(placeholder, text: draft)
                .font(Self.recipientFont)
                .textFieldStyle(.plain)
                .focused($focusedField, equals: focus)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.emailAddress)
                .onSubmit(onCommit)
                .onChange(of: draft.wrappedValue) { _, newValue in
                    if Self.shouldCommitToken(newValue) {
                        onCommit()
                    }
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

/// Simple wrapping token row for recipient chips.
private struct FlowRecipientTokens<Trailing: View>: View {
    let tokens: [String]
    let onRemove: (String) -> Void
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !tokens.isEmpty {
                FlexibleTokenWrap(tokens: tokens, onRemove: onRemove)
            }
            trailing()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct FlexibleTokenWrap: View {
    let tokens: [String]
    let onRemove: (String) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(tokens, id: \.self) { token in
                    HStack(spacing: 4) {
                        Text(token)
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(AppTheme.accent)
                        Button {
                            onRemove(token)
                        } label: {
                            Image(systemName: "xmark")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundStyle(AppTheme.accent.opacity(0.7))
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(AppTheme.accent.opacity(0.12))
                    .clipShape(Capsule())
                }
            }
        }
    }
}
