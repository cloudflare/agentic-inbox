import SwiftUI

struct ConversationsListView: View {
    @Environment(AppModel.self) private var app
    let onOpen: (AgentConversation) -> Void

    var body: some View {
        List {
            Section {
                Button {
                    Task {
                        if let created = await app.createConversation() {
                            onOpen(created)
                        }
                    }
                } label: {
                    Label("New chat", systemImage: "plus")
                        .font(.system(size: 16, weight: .medium))
                }
            }

            Section("Conversations") {
                ForEach(app.conversations) { conversation in
                    Button {
                        onOpen(conversation)
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(conversation.title)
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundStyle(AppTheme.ink)
                            if let preview = conversation.lastMessagePreview, !preview.isEmpty {
                                Text(preview)
                                    .font(.system(size: 13))
                                    .foregroundStyle(AppTheme.muted)
                                    .lineLimit(2)
                            } else {
                                Text(conversation.updatedAt.prefix(16))
                                    .font(.system(size: 13))
                                    .foregroundStyle(AppTheme.muted)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(AppTheme.background)
        .safeAreaInset(edge: .bottom) { Color.clear.frame(height: 76) }
        .task { await app.refreshConversations() }
    }
}

struct ChatSheetView: View {
    @Environment(AuthStore.self) private var auth
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    var seedPrompt: String?
    var initialConversationId: String?

    @StateObject private var chat = AgentChatClient()
    @State private var draft = ""
    @State private var activeConversationId: String?
    @State private var showPicker = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                conversationHeader
                Divider()
                messagesList
                inputBar
            }
            .background(AppTheme.background)
            .navigationTitle("Ask AI")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Close") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("New chat") {
                            Task { await startNewChat() }
                        }
                        Button("Clear this chat", role: .destructive) {
                            chat.clearHistory()
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
            .sheet(isPresented: $showPicker) {
                NavigationStack {
                    List(app.conversations) { conversation in
                        Button(conversation.title) {
                            Task { await openConversation(conversation.id) }
                            showPicker = false
                        }
                    }
                    .navigationTitle("Chats")
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("Done") { showPicker = false }
                        }
                    }
                }
                .presentationDetents([.medium])
            }
            .task {
                if let initialConversationId {
                    await openConversation(initialConversationId)
                } else {
                    await ensureConversation()
                }
                if let seedPrompt, !seedPrompt.isEmpty {
                    draft = seedPrompt
                }
            }
        }
    }

    private var conversationHeader: some View {
        Button { showPicker = true } label: {
            HStack {
                Text(currentTitle)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(AppTheme.ink)
                Image(systemName: "chevron.down")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(AppTheme.muted)
                Spacer()
                Circle()
                    .fill(chat.isConnected ? Color.green.opacity(0.8) : Color.orange.opacity(0.8))
                    .frame(width: 8, height: 8)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .buttonStyle(.plain)
    }

    private var messagesList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    ForEach(chat.messages) { message in
                        ChatBubble(message: message)
                            .id(message.id)
                    }
                    if let status = chat.statusText {
                        Text(status)
                            .font(.footnote)
                            .foregroundStyle(AppTheme.muted)
                            .padding(.horizontal, 16)
                    }
                }
                .padding(16)
            }
            .onChange(of: chat.messages.count) { _, _ in
                if let last = chat.messages.last?.id {
                    withAnimation { proxy.scrollTo(last, anchor: .bottom) }
                }
            }
        }
    }

    private var inputBar: some View {
        HStack(spacing: 10) {
            TextField("Ask about your inbox…", text: $draft, axis: .vertical)
                .lineLimit(1...5)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(AppTheme.surface)
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))

            Button {
                let text = draft
                draft = ""
                chat.sendUserMessage(text)
            } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 32))
                    .foregroundStyle(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? AppTheme.muted : AppTheme.accent)
            }
            .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || chat.isStreaming)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(AppTheme.background)
    }

    private var currentTitle: String {
        app.conversations.first(where: { $0.id == activeConversationId })?.title ?? "New chat"
    }

    private func ensureConversation() async {
        await app.refreshConversations()
        if let existing = app.conversations.first(where: { $0.id != "auto" }) {
            await openConversation(existing.id)
        } else if let created = await app.createConversation(title: "New chat") {
            await openConversation(created.id)
        }
    }

    private func startNewChat() async {
        if let created = await app.createConversation(title: "New chat") {
            await openConversation(created.id)
        }
    }

    private func openConversation(_ id: String) async {
        guard let mailboxId = app.selectedMailboxId else { return }
        activeConversationId = id
        chat.connect(mailboxId: mailboxId, conversationId: id, authToken: auth.token)
    }
}

private struct ChatBubble: View {
    let message: ChatMessage

    var body: some View {
        HStack {
            if message.role == "user" { Spacer(minLength: 40) }
            Text(message.text)
                .font(.system(size: 15))
                .foregroundStyle(message.role == "user" ? Color.white : AppTheme.ink)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(message.role == "user" ? AppTheme.pillActive : AppTheme.surface)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            if message.role != "user" { Spacer(minLength: 40) }
        }
    }
}
