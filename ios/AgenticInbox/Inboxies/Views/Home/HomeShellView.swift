import SwiftUI

/// Main shell: native large-title toolbar, content list, floating action bar, native folder tab bar.
struct HomeShellView: View {
    @Environment(AuthStore.self) private var auth
    @Environment(AppModel.self) private var app
    @Environment(\.undoManager) private var undoManager

    @State private var showSearch = false
    @State private var showChat = false
    @State private var chatSeedPrompt: String?
    @State private var pendingConversationId: String?
    @State private var tabNavigatingForward = true
    @State private var registeredArchiveUndoID: UUID?
    @State private var showSettings = false
    @State private var isSelectMode = false
    @State private var selectedEmailIDs: Set<String> = []
    @State private var filterState = EmailFilterState()

    private let folderTabs: [HomeTab] = [
//        .chats,
        .folder("inbox"),
        .folder("sent"),
        .folder("draft"),
        .folder("archive"),
        .folder("trash")
    ]

    private var tabSpring: Animation {
        .spring(duration: 0.42, bounce: 0.18)
    }

    private var hasMinimizedCompose: Bool {
        app.composeSession?.isMinimized == true
    }

    private var listBottomInset: CGFloat {
        HomeChromeMetrics.listBottomInset(hasMinimizedCompose: hasMinimizedCompose)
    }

    var body: some View {
        shell
            .animation(.spring(response: 0.32, dampingFraction: 0.88), value: isComposeExpanded)
            .animation(.spring(response: 0.32, dampingFraction: 0.86), value: hasMinimizedCompose)
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
            .sheet(isPresented: $showSettings) {
                SettingsSheetView()
                    .presentationDetents([.large])
                    .presentationDragIndicator(.visible)
            }
            .onChange(of: app.archiveUndo?.id) { _, newID in
                registerArchiveUndoIfNeeded(newID)
            }
            .sensoryFeedback(.success, trigger: app.archiveUndo?.id)
    }

    private var shell: some View {
        NavigationStack {
            tabContent
                .background(AppTheme.background)
                .navigationTitle(navigationTitleText)
                .navigationBarTitleDisplayMode(.large)
                .toolbarRole(.editor)
                .modifier(HomeNavigationSubtitle(subtitle: navigationSubtitleText))
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        mailboxControl
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        trailingToolbarItems
                    }
                }
                .toolbarBackground(.ultraThinMaterial, for: .navigationBar)
        }
        .tint(AppTheme.ink)
        .animation(tabSpring, value: app.selectedTab)
        .background(AppTheme.background.ignoresSafeArea())
        .overlay(alignment: .bottom) {
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
        VStack(spacing: 0) {
            VStack(spacing: HomeChromeMetrics.chromeSpacing) {
                if let offer = app.archiveUndo {
                    UndoToastBanner(message: "Archived") {
                        Task { await app.undoArchive(offer) }
                    }
                    .padding(.horizontal, HomeChromeMetrics.chromeHorizontalPadding)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }

                if let toast = app.toast {
                    HStack(spacing: 8) {
                        Image(systemName: toast.isError ? "exclamationmark.circle.fill" : "checkmark.circle.fill")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(toast.isError ? .red : AppTheme.ink)

                        Text(toast.message)
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(AppTheme.ink)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.regularMaterial, in: Capsule())
                    .overlay {
                        Capsule()
                            .strokeBorder(AppTheme.line.opacity(0.6), lineWidth: 0.5)
                    }
                    .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
                    .padding(.horizontal, HomeChromeMetrics.chromeHorizontalPadding)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }

                if isSelectMode {
                    selectionActionBar
                        .padding(.horizontal, 16)
                        .padding(.bottom, 20)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                } else {
                    bottomBar
                        .padding(.horizontal, 24)
                        .padding(.bottom, 20)
                    tabStrip
                }
            }

            if let session = app.composeSession, session.isMinimized, !isSelectMode {
                ComposeDockBar(session: session)
                    .ignoresSafeArea(edges: .bottom)
            }
        }
        .animation(.spring(response: 0.32, dampingFraction: 0.86), value: app.archiveUndo?.id)
        .animation(.spring(response: 0.32, dampingFraction: 0.86), value: app.toast?.id)
        .animation(tabSpring, value: app.selectedTab)
        .animation(.spring(response: 0.32, dampingFraction: 0.86), value: isSelectMode)
        .padding(.bottom, -12)
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

    /// Pull-down menu from the avatar, no popover arrow.
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
            Button("Settings", systemImage: "gearshape") {
                showSettings = true
            }
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
            .font(.system(size: initials.count > 1 ? 13 : 15, weight: .semibold))
            .foregroundStyle(AppTheme.ink)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .frame(width: Self.mailboxAvatarSize, height: Self.mailboxAvatarSize)
            .background(AppTheme.pillFill, in: Circle())
    }

    private var navigationTitleText: String {
        app.selectedTab.title
    }

    private var filteredEmails: [Email] {
        filterState.filter(app.emails, userEmail: mailboxTitle)
    }

    private var navigationSubtitleText: String {
        guard case .folder = app.selectedTab else { return "" }
        if isSelectMode {
            return selectedEmailIDs.isEmpty ? "Select emails" : "\(selectedEmailIDs.count) selected"
        }
        if filterState.isActive {
            return "\(filteredEmails.count) filtered · \(filterState.activeCount) active"
        }
        return activeFolderUnreadLabel
    }

    private var activeFolderUnreadCount: Int {
        guard case let .folder(folderId) = app.selectedTab else { return 0 }
        return app.unreadCount(forFolderId: folderId)
    }

    private var activeFolderUnreadLabel: String {
        let count = activeFolderUnreadCount
        if count == 0 { return "No unread" }
        if count == 1 { return "1 unread" }
        return "\(count) unread"
    }

    /// Same circle whether the menu is ready or still a skeleton.
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
                    .frame(width: Self.mailboxAvatarSize, height: Self.mailboxAvatarSize)
                    .accessibilityHidden(true)
            }
        }
        .frame(width: Self.mailboxAvatarSize, height: Self.mailboxAvatarSize)
        .skeletonPulse(app.isMailboxLoading)
        .modifier(MailboxLoadingAccessibility(isLoading: app.isMailboxLoading))
    }

    private var tabStrip: some View {
        FolderTabBar(
            tabs: folderTabs,
            selection: app.selectedTab,
            onSelect: selectTab
        )
        .frame(height: HomeChromeMetrics.tabStripHeight)
    }

    @ViewBuilder
    private var tabContent: some View {
        Group {
            switch app.selectedTab {
            case .folder:
                EmailListView(
                    emails: filteredEmails,
                    isLoading: app.isLoading,
                    fallbackFolderId: currentFolderId,
                    bottomInset: listBottomInset,
                    onRefresh: { await app.refreshCurrentTab() },
                    isSelectMode: isSelectMode,
                    selectedEmailIDs: $selectedEmailIDs,
                    isFiltered: filterState.isActive,
                    onClearFilters: {
                        withAnimation {
                            filterState.reset()
                        }
                    },
                    filterChipsBar: filterState.isActive ? AnyView(activeFilterChipsBar) : nil
                ) { email in
                    Task { await app.openEmail(email) }
                }
            case .chats:
                ConversationsListView(bottomInset: listBottomInset) { conversation in
                    chatSeedPrompt = nil
                    pendingConversationId = conversation.id
                    showChat = true
                }
            }
        }
        .id(app.selectedTab)
        .contentShape(Rectangle())
        .gesture(tabSwipeGesture)
        .transition(
            .asymmetric(
                insertion: .offset(x: tabNavigatingForward ? 28 : -28).combined(with: .opacity),
                removal: .offset(x: tabNavigatingForward ? -18 : 18).combined(with: .opacity)
            )
        )
    }

    private var currentFolderId: String? {
        if case let .folder(folderId) = app.selectedTab {
            return folderId
        }
        return nil
    }

    private func selectTab(_ tab: HomeTab) {
        guard app.selectedTab != tab else { return }
        if isSelectMode {
            isSelectMode = false
            selectedEmailIDs.removeAll()
        }
        let current = folderTabs.firstIndex(of: app.selectedTab) ?? 0
        let next = folderTabs.firstIndex(of: tab) ?? 0
        tabNavigatingForward = next > current
        Task { await app.selectTab(tab) }
    }

    private func selectAdjacentTab(forward: Bool) {
        guard let current = folderTabs.firstIndex(of: app.selectedTab) else { return }
        let next = forward ? current + 1 : current - 1
        guard folderTabs.indices.contains(next) else { return }
        selectTab(folderTabs[next])
    }

    private var tabSwipeGesture: some Gesture {
        DragGesture(minimumDistance: 24)
            .onEnded { value in
                let threshold: CGFloat = 40
                if value.translation.width < -threshold {
                    selectAdjacentTab(forward: true)
                } else if value.translation.width > threshold {
                    selectAdjacentTab(forward: false)
                }
            }
    }

    private var bottomBar: some View {
        HStack(spacing: 10) {
            Button { showSearch = true } label: {
                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(AppTheme.muted)
                    Text("Search mail")
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(AppTheme.muted)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 14)
                .frame(height: HomeChromeMetrics.actionBarHeight)
                .frame(maxWidth: .infinity, alignment: .leading)
                .liquidGlass(in: RoundedRectangle(cornerRadius: HomeChromeMetrics.chromeCornerRadius, style: .continuous))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Search")

            Button {
                chatSeedPrompt = nil
                showChat = true
            } label: {
                Image(systemName: "sparkles")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(AppTheme.ink)
                    .frame(width: HomeChromeMetrics.actionBarHeight, height: HomeChromeMetrics.actionBarHeight)
                    .liquidGlass(in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Ask AI")

            Button {
                Task { await app.startCompose(mode: .new) }
            } label: {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(AppTheme.ink)
                    .frame(width: HomeChromeMetrics.actionBarHeight, height: HomeChromeMetrics.actionBarHeight)
                    .liquidGlass(in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Compose")
        }
        .liquidGlassContainer(spacing: 10)
    }

    private var mailboxTitle: String {
        app.selectedMailbox?.email ?? auth.userEmail ?? ""
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

    private var initials: String {
        let source = mailboxName.isEmpty ? (mailboxTitle.isEmpty ? "A" : mailboxTitle) : mailboxName
        return AvatarInitials.from(source)
    }

    private static let mailboxAvatarSize: CGFloat = 38

    @ViewBuilder
    private var trailingToolbarItems: some View {
        if case .folder = app.selectedTab {
            HStack(spacing: 8) {
                selectButton
                filterButton
            }
        }
    }

    private var selectButton: some View {
        Button {
            withAnimation(.spring(response: 0.28, dampingFraction: 0.82)) {
                isSelectMode.toggle()
                if !isSelectMode {
                    selectedEmailIDs.removeAll()
                }
            }
        } label: {
            if isSelectMode {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(AppTheme.ink)
                    .frame(width: 36, height: 36)
                    .contentShape(Rectangle())
            } else {
                Text("Select")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(AppTheme.ink)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .contentShape(Rectangle())
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isSelectMode ? "Cancel selection" : "Select emails")
    }

    private var filterButton: some View {
        Menu {
            filterMenu
        } label: {
            ZStack(alignment: .topTrailing) {
                Image(systemName: filterState.isActive ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(filterState.isActive ? AppTheme.accent : AppTheme.ink)
                    .frame(width: 36, height: 36)

                if filterState.isActive {
                    Circle()
                        .fill(AppTheme.accent)
                        .frame(width: 8, height: 8)
                        .offset(x: 1, y: -1)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Filter menu")
        .accessibilityValue(filterState.isActive ? "\(filterState.activeCount) active" : "None")
    }

    @ViewBuilder
    private var filterMenu: some View {
        Section("Status") {
            Toggle(isOn: $filterState.unreadOnly) {
                Label("Unread", systemImage: "envelope.badge")
            }

            Toggle(isOn: $filterState.starredOnly) {
                Label("Starred", systemImage: "star")
            }
        }

        Section("Recipients") {
            Toggle(isOn: $filterState.toMeOnly) {
                Label("To me", systemImage: "person")
            }

            Toggle(isOn: $filterState.ccOrBccMeOnly) {
                Label("Cc / Bcc me", systemImage: "person.2")
            }
        }

        Section("Attachments") {
            Toggle(isOn: $filterState.withAttachmentsOnly) {
                Label("With attachments", systemImage: "paperclip")
            }
        }

        Section("Date") {
            Toggle(
                isOn: Binding(
                    get: { filterState.dateFilter == .today },
                    set: { filterState.dateFilter = $0 ? .today : .any }
                )
            ) {
                Label("Only today", systemImage: "calendar")
            }

            Toggle(
                isOn: Binding(
                    get: { filterState.dateFilter == .lastThreeDays },
                    set: { filterState.dateFilter = $0 ? .lastThreeDays : .any }
                )
            ) {
                Label("Last three days", systemImage: "calendar.badge.clock")
            }

            Toggle(
                isOn: Binding(
                    get: { filterState.dateFilter == .thisWeek },
                    set: { filterState.dateFilter = $0 ? .thisWeek : .any }
                )
            ) {
                Label("This week", systemImage: "calendar.day.timeline.left")
            }
        }

        Section("More") {
            Toggle(isOn: $filterState.needsReplyOnly) {
                Label("Needs reply", systemImage: "arrowshape.turn.up.left")
            }
        }

        if filterState.isActive {
            Divider()
            Button(role: .destructive) {
                withAnimation {
                    filterState.reset()
                }
            } label: {
                Label("Clear all filters", systemImage: "xmark.circle")
            }
        }
    }

    @ViewBuilder
    private var activeFilterChipsBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                if filterState.unreadOnly {
                    filterChip(title: "Unread") { filterState.unreadOnly = false }
                }
                if filterState.starredOnly {
                    filterChip(title: "Starred") { filterState.starredOnly = false }
                }
                if filterState.toMeOnly {
                    filterChip(title: "To me") { filterState.toMeOnly = false }
                }
                if filterState.ccOrBccMeOnly {
                    filterChip(title: "Cc/Bcc me") { filterState.ccOrBccMeOnly = false }
                }
                if filterState.withAttachmentsOnly {
                    filterChip(title: "Attachments") { filterState.withAttachmentsOnly = false }
                }
                if filterState.dateFilter != .any {
                    filterChip(title: filterState.dateFilter.rawValue) { filterState.dateFilter = .any }
                }
                if filterState.needsReplyOnly {
                    filterChip(title: "Needs reply") { filterState.needsReplyOnly = false }
                }

                Button {
                    withAnimation {
                        filterState.reset()
                    }
                } label: {
                    Text("Clear all")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(AppTheme.muted)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 4)
        }
    }

    private func filterChip(title: String, onRemove: @escaping () -> Void) -> some View {
        Button {
            withAnimation {
                onRemove()
            }
        } label: {
            HStack(spacing: 4) {
                Text(title)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(AppTheme.ink)
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(AppTheme.muted)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(AppTheme.pillActive, in: Capsule())
        }
        .buttonStyle(.plain)
    }

    private var areAllVisibleSelected: Bool {
        let list = filteredEmails
        return !list.isEmpty && list.allSatisfy { selectedEmailIDs.contains($0.id) }
    }

    private var areSelectedMostlyUnread: Bool {
        let selected = app.emails.filter { selectedEmailIDs.contains($0.id) }
        guard !selected.isEmpty else { return true }
        let unreadCount = selected.filter(\.isUnread).count
        return unreadCount >= max(1, selected.count - unreadCount)
    }

    private var areSelectedMostlyStarred: Bool {
        let selected = app.emails.filter { selectedEmailIDs.contains($0.id) }
        guard !selected.isEmpty else { return false }
        let starredCount = selected.filter(\.starred).count
        return starredCount >= max(1, selected.count - starredCount)
    }

    private func toggleSelectAll() {
        if areAllVisibleSelected {
            selectedEmailIDs.removeAll()
        } else {
            selectedEmailIDs = Set(filteredEmails.map(\.id))
        }
    }

    private var selectionActionBar: some View {
        HStack(spacing: 0) {
            Button {
                toggleSelectAll()
            } label: {
                Text(areAllVisibleSelected ? "Deselect All" : "Select All")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(AppTheme.ink)
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(AppTheme.pillFill, in: Capsule())
            }
            .buttonStyle(.plain)

            Spacer(minLength: 8)

            Text("\(selectedEmailIDs.count)")
                .font(.system(size: 14, weight: .bold, design: .rounded))
                .foregroundStyle(selectedEmailIDs.isEmpty ? AppTheme.muted : AppTheme.ink)
                .frame(minWidth: 26, minHeight: 26)
                .padding(.horizontal, 6)
                .background(AppTheme.pillFill, in: Capsule())
                .accessibilityLabel("\(selectedEmailIDs.count) selected")

            Spacer(minLength: 8)

            HStack(spacing: 8) {
                // Read/Unread
                Button {
                    let targetRead = areSelectedMostlyUnread
                    let ids = selectedEmailIDs
                    Task { await app.markEmailsRead(ids, read: targetRead) }
                } label: {
                    Image(systemName: areSelectedMostlyUnread ? "envelope.open" : "envelope.badge")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(AppTheme.ink)
                        .frame(width: 38, height: 38)
                        .background(AppTheme.pillFill, in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(selectedEmailIDs.isEmpty)
                .accessibilityLabel("Mark as read or unread")

                // Star/Unstar
                Button {
                    let targetStarred = !areSelectedMostlyStarred
                    let ids = selectedEmailIDs
                    Task { await app.starEmails(ids, starred: targetStarred) }
                } label: {
                    Image(systemName: areSelectedMostlyStarred ? "star.slash" : "star")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(AppTheme.ink)
                        .frame(width: 38, height: 38)
                        .background(AppTheme.pillFill, in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(selectedEmailIDs.isEmpty)
                .accessibilityLabel("Star or unstar")

                // Archive
                Button {
                    let ids = selectedEmailIDs
                    Task {
                        await app.archiveEmails(ids)
                        selectedEmailIDs.removeAll()
                    }
                } label: {
                    Image(systemName: "archivebox")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(AppTheme.ink)
                        .frame(width: 38, height: 38)
                        .background(AppTheme.pillFill, in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(selectedEmailIDs.isEmpty)
                .accessibilityLabel("Archive")

                // Delete
                Button {
                    let ids = selectedEmailIDs
                    Task {
                        await app.deleteEmails(ids)
                        selectedEmailIDs.removeAll()
                    }
                } label: {
                    Image(systemName: "trash")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(Color.red)
                        .frame(width: 38, height: 38)
                        .background(AppTheme.pillFill, in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(selectedEmailIDs.isEmpty)
                .accessibilityLabel("Delete")
            }
            .opacity(selectedEmailIDs.isEmpty ? 0.35 : 1)
        }
        .padding(.horizontal, 14)
        .frame(height: 58)
        .liquidGlass(in: RoundedRectangle(cornerRadius: HomeChromeMetrics.chromeCornerRadius, style: .continuous))
    }
}

private struct IdentifiedEmail: Identifiable {
    /// Stable id so prev/next email swaps don't dismiss and re-present the sheet.
    var id: String { "email-detail" }
    let email: Email
}

private struct HomeNavigationSubtitle: ViewModifier {
    var subtitle: String

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            if !subtitle.isEmpty {
                content.navigationSubtitle(Text(subtitle))
            } else {
                content
            }
        } else {
            content
        }
    }
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
