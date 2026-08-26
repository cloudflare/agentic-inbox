import SwiftUI

/// Main shell inspired by Notion mobile:
/// top folder pills, content list, floating bottom bar (Search / Ask AI / Compose).
struct HomeShellView: View {
    @Environment(AuthStore.self) private var auth
    @Environment(AppModel.self) private var app

    @Namespace private var tabNamespace

    @State private var showSearch = false
    @State private var showChat = false
    @State private var chatSeedPrompt: String?
    @State private var pendingConversationId: String?
    @State private var tabNavigatingForward = true

    private let folderTabs: [HomeTab] = [
        .chats,
        .folder("inbox"),
        .folder("sent"),
        .folder("draft"),
        .folder("archive"),
        .folder("trash")
    ]

    private var tabSpring: Animation {
        .spring(duration: 0.42, bounce: 0.18)
    }

    var body: some View {
        shell
            .animation(.spring(response: 0.32, dampingFraction: 0.88), value: isComposeExpanded)
            .sheet(isPresented: $showSearch) {
                SearchView()
            }
            .sheet(isPresented: $showChat, onDismiss: dismissChat) {
                chatSheet
            }
            .sheet(item: selectedEmailItem) { item in
                EmailDetailView(email: item.email)
            }
            .sheet(isPresented: composeExpandedBinding) {
                expandedComposeSheet
            }
    }

    private var shell: some View {
        ZStack(alignment: .bottom) {
            AppTheme.background.ignoresSafeArea()

            VStack(spacing: 0) {
                topBar
                tabStrip
                ZStack {
                    tabContent
                }
                .clipped()
                .animation(tabSpring, value: app.selectedTab)
            }

            composeChrome
        }
    }

    private var isComposeExpanded: Bool {
        app.composeSession?.isExpanded == true
    }

    /// Swipe-to-dismiss minimizes (docks) instead of discarding the draft.
    private var composeExpandedBinding: Binding<Bool> {
        Binding(
            get: { isComposeExpanded },
            set: { isPresented in
                if !isPresented {
                    app.minimizeCompose()
                }
            }
        )
    }

    private var chatSheet: some View {
        ChatSheetView(
            seedPrompt: chatSeedPrompt,
            initialConversationId: pendingConversationId
        )
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }

    @ViewBuilder
    private var expandedComposeSheet: some View {
        if let session = app.composeSession {
            ComposeSheetView(session: session)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
    }

    @ViewBuilder
    private var composeChrome: some View {
        VStack(spacing: 10) {
            if let session = app.composeSession, session.isMinimized {
                ComposeDockBar(session: session)
            }
            bottomBar
        }
        .padding(.bottom, 10)
    }

    private var selectedEmailItem: Binding<IdentifiedEmail?> {
        Binding(
            get: {
                guard let email = app.selectedEmail else { return nil }
                return IdentifiedEmail(email: email)
            },
            set: { newValue in
                if newValue == nil {
                    app.selectedEmail = nil
                }
            }
        )
    }

    private func dismissChat() {
        pendingConversationId = nil
        chatSeedPrompt = nil
    }

    /// Notion-style workspace control: pull-down menu from the avatar, no popover arrow.
    private var mailboxButton: some View {
        Menu {
            ForEach(app.mailboxes) { mailbox in
                Button {
                    Task { await app.loadMailbox(mailbox.id) }
                } label: {
                    if mailbox.id == app.selectedMailboxId {
                        Label(mailbox.email, systemImage: "checkmark")
                    } else {
                        Text(mailbox.email)
                    }
                }
            }
            Divider()
            Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                auth.signOut()
            }
        } label: {
            Text(initials)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(AppTheme.ink)
                .frame(width: 40, height: 40)
                .background(AppTheme.pillFill, in: Circle())
        }
        .menuIndicator(.hidden)
        .buttonStyle(.plain)
        .accessibilityLabel("Mailbox")
        .accessibilityValue(mailboxTitle)
    }

    private var topBar: some View {
        HStack() {
            mailboxButton

            if app.isLoading {
                ProgressView()
                    .controlSize(.small)
            }

            if !mailboxTitle.isEmpty {
                Text(mailboxTitle)
                    .font(.system(size: 24, weight: .medium))
                    .foregroundStyle(AppTheme.ink)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .truncationMode(.middle)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 4)
    }

    private var tabStrip: some View {
        GeometryReader { geo in
            let spacing: CGFloat = 6
            let horizontalPadding: CGFloat = 16
            let tabCount = folderTabs.count
            let available = max(
                0,
                geo.size.width - horizontalPadding * 2 - spacing * CGFloat(max(tabCount - 1, 0))
            )
            let inactiveCount = max(tabCount - 1, 1)
            let inactiveFloor: CGFloat = 40
            let activeMin: CGFloat = 88
            // Equal icon-only inactive shares; leftover goes to the active tab.
            let idealInactive = (available - activeMin) / CGFloat(inactiveCount)
            let inactiveWidth = idealInactive >= inactiveFloor
                ? idealInactive
                : available / CGFloat(tabCount)
            let activeWidth = available - inactiveWidth * CGFloat(inactiveCount)

            HStack(spacing: spacing) {
                ForEach(folderTabs, id: \.self) { tab in
                    let active = app.selectedTab == tab
                    Button {
                        selectTab(tab)
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: tab.systemImage)
                                .font(.system(size: 13, weight: .semibold))
                            if active {
                                Text(tab.title)
                                    .font(.system(size: 14, weight: .semibold))
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.8)
                                    .transition(
                                        .opacity
                                            .combined(with: .scale(scale: 0.82, anchor: .leading))
                                    )
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .foregroundStyle(active ? Color.white : AppTheme.ink)
                        .background {
                            Capsule()
                                .fill(AppTheme.pillFill)
                            if active {
                                Capsule()
                                    .fill(AppTheme.pillActive)
                                    .matchedGeometryEffect(id: "activeFolderTab", in: tabNamespace)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .frame(width: active ? activeWidth : inactiveWidth)
                }
            }
            .animation(tabSpring, value: app.selectedTab)
            .padding(.horizontal, horizontalPadding)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
        }
        .frame(height: 52)
    }

    @ViewBuilder
    private var tabContent: some View {
        Group {
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
        .id(app.selectedTab)
        .transition(
            .asymmetric(
                insertion: .offset(x: tabNavigatingForward ? 28 : -28).combined(with: .opacity),
                removal: .offset(x: tabNavigatingForward ? -18 : 18).combined(with: .opacity)
            )
        )
    }

    private func selectTab(_ tab: HomeTab) {
        guard app.selectedTab != tab else { return }
        let current = folderTabs.firstIndex(of: app.selectedTab) ?? 0
        let next = folderTabs.firstIndex(of: tab) ?? 0
        tabNavigatingForward = next > current
        Task { await app.selectTab(tab) }
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
                Task { await app.startCompose(mode: .new) }
            } label: {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 18, weight: .medium))
                    .frame(width: 52, height: 52)
                    .background(AppTheme.surface)
                    .foregroundStyle(AppTheme.ink)
                    .clipShape(Circle())
                    .shadow(color: .black.opacity(0.08), radius: 10, y: 4)
            }
        }
        .padding(.horizontal, 16)
    }

    private var mailboxTitle: String {
        app.selectedMailbox?.email ?? auth.userEmail ?? ""
    }

    private var initials: String {
        let source = mailboxTitle.isEmpty ? "A" : mailboxTitle
        return String(source.prefix(1)).uppercased()
    }
}

private struct IdentifiedEmail: Identifiable {
    var id: String { email.id }
    let email: Email
}
