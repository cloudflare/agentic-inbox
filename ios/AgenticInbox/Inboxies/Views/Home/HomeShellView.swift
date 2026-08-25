import SwiftUI

/// Main shell inspired by Notion mobile:
/// top folder pills, content list, floating bottom bar (Search / Ask AI / Compose).
struct HomeShellView: View {
    @Environment(AuthStore.self) private var auth
    @Environment(AppModel.self) private var app

    @State private var showSearch = false
    @State private var showChat = false
    @State private var chatSeedPrompt: String?
    @State private var pendingConversationId: String?
    @State private var showMailboxPicker = false

    private let folderTabs: [HomeTab] = [
        .folder("inbox"),
        .folder("sent"),
        .folder("draft"),
        .folder("archive"),
        .folder("trash"),
        .chats,
    ]

    var body: some View {
        ZStack(alignment: .bottom) {
            AppTheme.background.ignoresSafeArea()

            VStack(spacing: 0) {
                topBar
                tabStrip
                content
            }

            bottomBar
                .padding(.horizontal, 16)
                .padding(.bottom, 10)
        }
        .sheet(isPresented: $showSearch) {
            SearchView()
        }
        .sheet(isPresented: $showChat, onDismiss: {
            pendingConversationId = nil
            chatSeedPrompt = nil
        }) {
            ChatSheetView(
                seedPrompt: chatSeedPrompt,
                initialConversationId: pendingConversationId
            )
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .sheet(item: Binding(
            get: { app.selectedEmail.map { IdentifiedEmail(email: $0) } },
            set: { if $0 == nil { app.selectedEmail = nil } }
        )) { item in
            EmailDetailView(email: item.email)
        }
        .confirmationDialog("Mailbox", isPresented: $showMailboxPicker) {
            ForEach(app.mailboxes) { mailbox in
                Button(mailbox.email) {
                    Task { await app.loadMailbox(mailbox.id) }
                }
            }
            Button("Sign out", role: .destructive) { auth.signOut() }
            Button("Cancel", role: .cancel) {}
        }
    }

    private var topBar: some View {
        HStack(spacing: 12) {
            Button { showMailboxPicker = true } label: {
                ZStack {
                    Circle()
                        .fill(AppTheme.pillFill)
                        .frame(width: 36, height: 36)
                    Text(initials)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(AppTheme.ink)
                }
            }
            Spacer()
            if app.isLoading {
                ProgressView()
                    .controlSize(.small)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 4)
    }

    private var tabStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(folderTabs, id: \.self) { tab in
                    let active = app.selectedTab == tab
                    Button {
                        Task { await app.selectTab(tab) }
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: tab.systemImage)
                                .font(.system(size: 13, weight: .semibold))
                            if active {
                                Text(tab.title)
                                    .font(.system(size: 14, weight: .semibold))
                            }
                        }
                        .padding(.horizontal, active ? 14 : 11)
                        .padding(.vertical, 10)
                        .foregroundStyle(active ? Color.white : AppTheme.ink)
                        .background(active ? AppTheme.pillActive : AppTheme.pillFill)
                        .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch app.selectedTab {
        case .folder:
            EmailListView(emails: app.emails) { email in
                Task { await app.openEmail(email) }
            }
        case .chats:
            ConversationsListView { conversation in
                chatSeedPrompt = nil
                pendingConversationId = conversation.id
                showChat = true
            }
        }
    }

    private var bottomBar: some View {
        HStack(spacing: 12) {
            Button { showSearch = true } label: {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 18, weight: .medium))
                    .frame(width: 52, height: 52)
                    .background(AppTheme.surface)
                    .foregroundStyle(AppTheme.ink)
                    .clipShape(Circle())
                    .shadow(color: .black.opacity(0.08), radius: 10, y: 4)
            }

            Button {
                chatSeedPrompt = nil
                showChat = true
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "sparkles")
                    Text("Ask AI")
                        .font(.system(size: 16, weight: .medium))
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 18)
                .frame(height: 52)
                .background(AppTheme.surface)
                .foregroundStyle(AppTheme.ink)
                .clipShape(Capsule())
                .shadow(color: .black.opacity(0.08), radius: 10, y: 4)
            }

            Button {
                // Phase 2: compose / send
            } label: {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 18, weight: .medium))
                    .frame(width: 52, height: 52)
                    .background(AppTheme.surface)
                    .foregroundStyle(AppTheme.muted)
                    .clipShape(Circle())
                    .shadow(color: .black.opacity(0.08), radius: 10, y: 4)
            }
            .disabled(true)
            .opacity(0.55)
        }
    }

    private var initials: String {
        let source = app.selectedMailbox?.email ?? auth.userEmail ?? "A"
        return String(source.prefix(1)).uppercased()
    }
}

private struct IdentifiedEmail: Identifiable {
    var id: String { email.id }
    let email: Email
}
