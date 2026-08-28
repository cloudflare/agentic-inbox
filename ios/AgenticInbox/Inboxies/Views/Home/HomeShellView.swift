import SwiftUI

/// Main shell inspired by Notion mobile:
/// top folder pills, content list, floating bottom bar (Search / Ask AI / Compose).
struct HomeShellView: View {
    @Environment(AuthStore.self) private var auth
    @Environment(AppModel.self) private var app
    @Environment(\.undoManager) private var undoManager

    @Namespace private var tabNamespace

    @State private var showSearch = false
    @State private var showChat = false
    @State private var chatSeedPrompt: String?
    @State private var pendingConversationId: String?
    @State private var tabNavigatingForward = true
    @State private var registeredArchiveUndoID: UUID?

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
            .sheet(item: selectedEmailItem) { _ in
                EmailDetailView()
            }
            .sheet(isPresented: composeExpandedBinding) {
                expandedComposeSheet
            }
            .onChange(of: app.archiveUndo?.id) { _, newID in
                registerArchiveUndoIfNeeded(newID)
            }
            .sensoryFeedback(.success, trigger: app.archiveUndo?.id)
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
            if let offer = app.archiveUndo {
                UndoToastBanner(message: "Archived") {
                    Task { await app.undoArchive(offer) }
                }
                .padding(.horizontal, 16)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            if let session = app.composeSession, session.isMinimized {
                ComposeDockBar(session: session)
            }
            bottomBar
        }
        .padding(.bottom, 10)
        .animation(.spring(response: 0.32, dampingFraction: 0.86), value: app.archiveUndo?.id)
    }

    private func registerArchiveUndoIfNeeded(_ newID: UUID?) {
        guard let newID, let offer = app.archiveUndo, offer.id == newID else {
            if newID == nil {
                registeredArchiveUndoID = nil
            }
            return
        }
        guard registeredArchiveUndoID != newID else { return }
        registeredArchiveUndoID = newID
        undoManager?.registerUndo(withTarget: app) { model in
            Task { @MainActor in
                await model.undoArchive(offer)
            }
        }
        undoManager?.setActionName("Archive")
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
            mailboxAvatar(initials: initials)
        }
        .menuIndicator(.hidden)
        .buttonStyle(.plain)
        .accessibilityLabel("Mailbox")
        .accessibilityValue("\(mailboxName), \(mailboxTitle)")
    }

    private func mailboxAvatar(initials: String) -> some View {
        Text(initials)
            .font(.system(size: 18, weight: .semibold))
            .foregroundStyle(AppTheme.ink)
            .frame(width: 52, height: 52)
            .background(AppTheme.pillFill, in: Circle())
    }

    private var topBar: some View {
        HStack(alignment: .center, spacing: 12) {
            mailboxControl
            mailboxIdentity
        }
        .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 4)
        .skeletonPulse(app.isMailboxLoading)
        .modifier(MailboxLoadingAccessibility(isLoading: app.isMailboxLoading))
    }

    /// Same 52pt circle whether the menu is ready or still a skeleton, so the
    /// initial never pops in and shoves the title.
    @ViewBuilder
    private var mailboxControl: some View {
        ZStack {
            mailboxButton
                .opacity(app.isMailboxLoading ? 0 : 1)
                .allowsHitTesting(!app.isMailboxLoading)
                .accessibilityHidden(app.isMailboxLoading)
            if app.isMailboxLoading {
                Circle()
                    .fill(AppTheme.pillFill)
                    .frame(width: 52, height: 52)
                    .accessibilityHidden(true)
            }
        }
        .frame(width: 52, height: 52)
    }

    /// Two-line title is always laid out so the tab strip does not jump when
    /// the mailbox name/email arrive.
    private var mailboxIdentity: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(app.isMailboxLoading ? "Mailbox Name" : displayMailboxName)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(AppTheme.ink)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .truncationMode(.tail)
            Text(app.isMailboxLoading ? "name@inboxies.email" : displayMailboxTitle)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(AppTheme.muted)
                .lineLimit(1)
                .truncationMode(.middle)
                .opacity(!app.isMailboxLoading && mailboxTitle.isEmpty ? 0 : 1)
        }
        .redacted(reason: app.isMailboxLoading ? .placeholder : [])
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
                                .font(.system(size: 12, weight: .semibold))
                            if active {
                                Text(tab.title)
                                    .font(.system(size: 12, weight: .semibold))
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
                        .foregroundStyle(AppTheme.ink)
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
                EmailListView(
                    emails: app.emails,
                    isLoading: app.isLoading,
                    onRefresh: { await app.refreshCurrentTab() }
                ) { email in
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

    /// Non-empty stand-in so the subtitle line keeps its height after load.
    private var displayMailboxTitle: String {
        mailboxTitle.isEmpty ? " " : mailboxTitle
    }

    private var mailboxName: String {
        let mailbox = app.selectedMailbox
        if let fromName = mailbox?.settings?.fromName, !fromName.isEmpty {
            return fromName
        }
        if let name = mailbox?.name, !name.isEmpty, name != mailbox?.email {
            return name
        }
        if let local = mailboxTitle.split(separator: "@").first, !local.isEmpty {
            return String(local)
        }
        return mailbox?.name ?? mailboxTitle
    }

    private var displayMailboxName: String {
        mailboxName.isEmpty ? " " : mailboxName
    }

    private var initials: String {
        let source = mailboxName.isEmpty ? (mailboxTitle.isEmpty ? "A" : mailboxTitle) : mailboxName
        return String(source.prefix(1)).uppercased()
    }
}

private struct IdentifiedEmail: Identifiable {
    /// Stable id so prev/next email swaps don't dismiss and re-present the sheet.
    var id: String { "email-detail" }
    let email: Email
}

private struct MailboxLoadingAccessibility: ViewModifier {
    var isLoading: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if isLoading {
            content
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Loading mailbox")
        } else {
            content
        }
    }
}
