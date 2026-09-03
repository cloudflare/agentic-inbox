import SwiftUI
import UIKit

struct EmailDetailView: View {
    @Environment(AppModel.self) private var app

    @State private var showActionsSheet = false
    @State private var expandedMessageIDs: Set<String> = []
    @State private var expandedRecipientIDs: Set<String> = []
    @State private var personSearch: PersonSearch?
    @Namespace private var actionsNamespace

    private var email: Email? {
        app.selectedEmail
    }

    private var source: Email? {
        app.actionSourceEmail ?? email
    }

    private var actionAvailability: EmailActionAvailability? {
        guard let source else { return nil }
        return EmailActionAvailability(email: source)
    }

    private var subjectText: String {
        let subject = email?.subject ?? ""
        return subject.isEmpty ? "(no subject)" : subject
    }

    private var detailTags: [String] {
        guard let email else { return [] }
        var tags: [String] = []
        if let name = email.folderName, !name.isEmpty {
            tags.append(name.capitalized)
        } else if let folderId = email.folderId, !folderId.isEmpty {
            tags.append(HomeTab.folder(folderId).title)
        }
        if email.starred { tags.append("Starred") }
        if email.isUnread { tags.append("Unread") }
        if email.needsReply == true { tags.append("Needs reply") }
        if email.hasDraft == true { tags.append("Has draft") }
        let messageCount = max(app.threadEmails.count, email.threadCount ?? 1)
        if messageCount > 1 {
            tags.append("\(messageCount) messages")
        }
        return tags
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    tagsRow
                        .padding(.horizontal, 16)
                        .padding(.top, 8)
                        .padding(.bottom, 12)

                    if app.isEmailDetailLoading && app.threadEmails.isEmpty {
                        detailSkeleton
                    } else {
                        messagesList
                    }
                }
            }
            .id(email?.id)
            .background(AppTheme.background)
            .background(DetailNavigationTitleFont())
            .navigationTitle(subjectText)
            .navigationBarTitleDisplayMode(.large)
            .toolbarBackground(.ultraThinMaterial, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        app.selectedEmail = nil
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .accessibilityLabel("Close")
                }

                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button {
                        Task { await app.openAdjacentEmail(offset: -1) }
                    } label: {
                        Image(systemName: "chevron.up")
                    }
                    .disabled(!app.canOpenPreviousEmail)
                    .accessibilityLabel("Previous email")

                    Button {
                        Task { await app.openAdjacentEmail(offset: 1) }
                    } label: {
                        Image(systemName: "chevron.down")
                    }
                    .disabled(!app.canOpenNextEmail)
                    .accessibilityLabel("Next email")
                }

                ToolbarItemGroup(placement: .bottomBar) {
                    Menu {
                        Button("Delete Message", role: .destructive) {
                            Task { await app.deleteCurrentEmail() }
                        }
                    } label: {
                        Image(systemName: "trash")
                    }
                    .accessibilityLabel("Delete")
                    .disabled(email == nil)

                    if actionAvailability?.showsArchive == true {
                        Button {
                            Task { await app.archiveCurrentEmail() }
                        } label: {
                            Image(systemName: "archivebox")
                        }
                        .accessibilityLabel("Archive")
                        .disabled(email == nil)
                    }

                    if actionAvailability?.showsReplyActions == true {
                        Button {
                            guard let source else { return }
                            Task {
                                await app.startCompose(mode: .reply, original: source)
                            }
                        } label: {
                            Image(systemName: "arrowshape.turn.up.left")
                        }
                        .accessibilityLabel("Reply")
                        .disabled(source == nil)
                    }

                    if #unavailable(iOS 26.0) {
                        Spacer(minLength: 0)
                        moreButton
                    }
                }

                if #available(iOS 26.0, *) {
                    ToolbarSpacer(.flexible, placement: .bottomBar)
                    ToolbarItem(placement: .bottomBar) {
                        moreButton
                    }
                }
            }
            .sheet(isPresented: $showActionsSheet) {
                actionsSheetContent
            }
            .sheet(item: $personSearch) { search in
                SearchView(initialQuery: search.query)
            }
            .onChange(of: email?.id) { _, _ in
                expandedMessageIDs = []
                expandedRecipientIDs = []
            }
            .onChange(of: app.isEmailDetailLoading) { _, loading in
                if !loading {
                    seedExpandedMessages()
                }
            }
        }
    }

    private var tagsRow: some View {
        Group {
            if app.isEmailDetailLoading && detailTags.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(0..<3, id: \.self) { _ in
                            tagChip("Folder")
                        }
                    }
                }
                .redacted(reason: .placeholder)
                .skeletonPulse(true)
            } else if !detailTags.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(detailTags, id: \.self) { tag in
                            tagChip(tag)
                        }
                    }
                }
            }
        }
    }

    private func tagChip(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 12, weight: .medium))
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(AppTheme.pillFill)
            .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
            .foregroundStyle(AppTheme.muted)
    }

    private func seedExpandedMessages() {
        guard let latest = app.threadEmails.last(where: { !$0.isDraft }) else {
            expandedMessageIDs = []
            return
        }
        expandedMessageIDs = [latest.id]
    }

    private func toggleRecipients(_ id: String) {
        withAnimation(.easeInOut(duration: 0.2)) {
            if expandedRecipientIDs.contains(id) {
                expandedRecipientIDs.remove(id)
            } else {
                expandedRecipientIDs.insert(id)
            }
        }
    }

    private func toggleMessage(_ id: String) {
        withAnimation(.easeInOut(duration: 0.2)) {
            if expandedMessageIDs.contains(id) {
                expandedMessageIDs.remove(id)
            } else {
                expandedMessageIDs.insert(id)
            }
        }
    }

    @ViewBuilder
    private var messagesList: some View {
        let messages = app.threadEmails
        ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
            VStack(alignment: .leading, spacing: 0) {
                if index > 0 {
                    Rectangle()
                        .fill(AppTheme.line)
                        .frame(height: 1)
                        .frame(maxWidth: .infinity)
                }

                messageBlock(message)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 16)
            }
        }
        .onAppear(perform: seedExpandedMessages)
    }

    @ViewBuilder
    private func messageBlock(_ message: Email) -> some View {
        if message.isDraft {
            DraftMessageRow(
                message: message,
                onOpen: {
                    Task { await app.openDraft(message) }
                },
                onDelete: {
                    Task { await app.deleteThreadDraft(message) }
                }
            )
        } else {
            let selfAddress = app.selectedMailbox?.email
            let isExpanded = expandedMessageIDs.contains(message.id)
            VStack(alignment: .leading, spacing: 0) {
                MessagePeopleHeader(
                    message: message,
                    selfAddress: selfAddress,
                    formattedDate: Self.formatDate(message.date),
                    isRecipientsExpanded: expandedRecipientIDs.contains(message.id),
                    isBodyExpanded: isExpanded,
                    onToggleRecipients: { toggleRecipients(message.id) },
                    onToggleBody: { toggleMessage(message.id) },
                    onSearch: { query in
                        personSearch = PersonSearch(query: query)
                    }
                )

                if isExpanded {
                    VStack(alignment: .leading, spacing: 0) {
                        EmailBodyView(
                            htmlOrText: message.body ?? message.snippet ?? "",
                            mailboxId: app.selectedMailboxId,
                            emailId: message.id,
                            attachments: message.attachments ?? []
                        )
                            .padding(.top, 20)

                        AttachmentListView(email: message)
                            .padding(.top, 20)
                    }
                    .transition(.opacity.combined(with: .offset(y: 6)))
                }
            }
        }
    }

    /// Matches web `formatDetailDate`: "Tue, Apr 15, 3:42 PM".
    /// Includes the year when the message is from a different calendar year.
    private static func formatDate(_ iso: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = formatter.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let date else { return iso }

        let out = DateFormatter()
        let calendar = Calendar.current
        if calendar.component(.year, from: date) == calendar.component(.year, from: Date()) {
            out.setLocalizedDateFormatFromTemplate("EEEMMMdjm")
        } else {
            out.setLocalizedDateFormatFromTemplate("EEEMMMdyyyyjm")
        }
        return out.string(from: date)
    }

    private var detailSkeleton: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(0..<2, id: \.self) { index in
                VStack(alignment: .leading, spacing: 0) {
                    if index > 0 {
                        Rectangle()
                            .fill(AppTheme.line)
                            .frame(height: 1)
                            .frame(maxWidth: .infinity)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text("Sender Name")
                                .font(.system(size: 15, weight: .semibold))
                            Spacer()
                            Text("Mar 15, 2026")
                                .font(.system(size: 13))
                        }
                        Text("To Recipients")
                            .font(.system(size: 13))
                        Text(String(repeating: "Body preview line for skeleton loading state. ", count: 4))
                            .font(.system(size: 15))
                            .lineLimit(6)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 16)
                }
            }
        }
        .redacted(reason: .placeholder)
        .skeletonPulse(true)
        .foregroundStyle(AppTheme.ink)
        .accessibilityLabel("Loading email")
    }

    @ViewBuilder
    private var moreButton: some View {
        let button = Button {
            showActionsSheet = true
        } label: {
            Image(systemName: "ellipsis")
        }
        .accessibilityLabel("More")
        .disabled(email == nil)

        if #available(iOS 18.0, *) {
            button
                .matchedTransitionSource(id: "email-actions", in: actionsNamespace)
        } else {
            button
        }
    }

    @ViewBuilder
    private var actionsSheetContent: some View {
        if let sheetEmail = email ?? source {
            let sheet = EmailActionsSheet(email: sheetEmail)

            if #available(iOS 18.0, *) {
                sheet
                    .navigationTransition(.zoom(sourceID: "email-actions", in: actionsNamespace))
            } else {
                sheet
            }
        }
    }
}

private struct PersonSearch: Identifiable {
    let id = UUID()
    let query: String
}

/// Compact thread row for a saved draft: stays in timeline order, opens compose.
private struct DraftMessageRow: View {
    let message: Email
    var onOpen: () -> Void
    var onDelete: () -> Void

    @State private var showDeleteConfirm = false

    private var preview: String {
        message.previewText
    }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Button(action: onOpen) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .center, spacing: 6) {
                        Text("Draft")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(AppTheme.deepDarkRed)
                            .lineLimit(1)
                        if message.hasFileAttachment {
                            Image(systemName: "paperclip")
                                .font(.system(size: 10, weight: .medium))
                                .foregroundStyle(AppTheme.muted)
                                .accessibilityLabel("Has attachment")
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if !preview.isEmpty {
                        Text(preview)
                            .font(.system(size: 11))
                            .foregroundStyle(AppTheme.muted)
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Draft")
            .accessibilityValue(preview)
            .accessibilityHint("Opens draft in compose")

            Button {
                showDeleteConfirm = true
            } label: {
                Image(systemName: "trash")
                    .font(.system(size: 14))
                    .foregroundStyle(AppTheme.muted)
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Delete draft")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .confirmationDialog(
            "Draft",
            isPresented: $showDeleteConfirm,
            titleVisibility: .visible
        ) {
            Button("Delete Draft", role: .destructive, action: onDelete)
            Button("Cancel", role: .cancel) {}
        }
    }
}

private struct MessagePeopleHeader: View {
    let message: Email
    let selfAddress: String?
    let formattedDate: String
    let isRecipientsExpanded: Bool
    let isBodyExpanded: Bool
    var onToggleRecipients: () -> Void
    var onToggleBody: () -> Void
    var onSearch: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: isRecipientsExpanded ? 8 : 2) {
            if isRecipientsExpanded {
                expandedFromRow
                detailRow(label: "To", addresses: message.toAddresses)
                detailRow(label: "Cc", addresses: message.ccAddresses)
                detailRow(label: "Bcc", addresses: message.bccAddresses)
            } else {
                collapsedTopRow
                collapsedRecipientsButton
            }
        }
    }

    private var collapsedTopRow: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Button(action: senderOrToAction) {
                Text(message.fromAddress.label(selfAddress: selfAddress))
                    .font(.system(size: AppTheme.FontSize.sender, weight: .semibold))
                    .foregroundStyle(AppTheme.ink)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isBodyExpanded ? "Show recipient details" : "Show message")
            dateAndToggle
        }
    }

    private var recipientSummary: String {
        message.recipientSummary(selfAddress: selfAddress)
    }

    private func senderOrToAction() {
        if isBodyExpanded {
            onToggleRecipients()
        } else {
            onToggleBody()
        }
    }

    @ViewBuilder
    private var collapsedRecipientsButton: some View {
        let summary = recipientSummary
        if !summary.isEmpty {
            Button(action: senderOrToAction) {
                Text("To \(summary)")
                    .font(.system(size: AppTheme.FontSize.recipient))
                    .foregroundStyle(AppTheme.muted)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isBodyExpanded ? "Show recipient details" : "Show message")
        }
    }

    private var expandedFromRow: some View {
        HStack(alignment: .center, spacing: 8) {
            Text("From")
                .font(.system(size: AppTheme.FontSize.recipient, weight: .medium))
                .foregroundStyle(AppTheme.muted)
                .frame(width: 32, alignment: .leading)
            PersonAddressMenu(
                address: message.fromAddress,
                selfAddress: selfAddress,
                onSearch: onSearch
            )
            Spacer(minLength: 8)
            dateAndToggle
        }
    }

    private var dateAndToggle: some View {
        HStack(alignment: .center, spacing: 4) {
            if message.hasFileAttachment {
                Image(systemName: "paperclip")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(AppTheme.muted)
                    .accessibilityLabel("Has attachment")
            }
            Button(action: onToggleRecipients) {
                HStack(spacing: 4) {
                    Text(formattedDate)
                        .font(.system(size: AppTheme.FontSize.meta))
                        .foregroundStyle(AppTheme.muted)
                        .lineLimit(1)
                    Image(systemName: isRecipientsExpanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: AppTheme.FontSize.chevron, weight: .semibold))
                        .foregroundStyle(AppTheme.muted)
                        .frame(width: 16, height: 16)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isRecipientsExpanded ? "Hide recipient details" : "Show recipient details")
        }
        .layoutPriority(1)
    }

    @ViewBuilder
    private func detailRow(label: String, addresses: [MailAddress]) -> some View {
        if !addresses.isEmpty {
            HStack(alignment: .top, spacing: 8) {
                Text(label)
                    .font(.system(size: AppTheme.FontSize.meta, weight: .medium))
                    .foregroundStyle(AppTheme.muted)
                    .frame(width: 32, alignment: .leading)
                    .padding(.top, 4)
                    .allowsHitTesting(false)
                FlowLayout(spacing: 6) {
                    ForEach(uniqueAddresses(addresses)) { address in
                        PersonAddressMenu(address: address, selfAddress: selfAddress, onSearch: onSearch)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func uniqueAddresses(_ addresses: [MailAddress]) -> [MailAddress] {
        var seen = Set<String>()
        return addresses.filter { seen.insert($0.id).inserted }
    }
}

private struct PersonAddressMenu: View {
    let address: MailAddress
    let selfAddress: String?
    var onSearch: (String) -> Void

    var body: some View {
        Menu {
            Button {} label: {
                Text(address.resolvedName)
                Text(address.email)
            }
            .disabled(true)

            Divider()

            Button {
                UIPasteboard.general.string = address.email
            } label: {
                Label("Copy Address", systemImage: "doc.on.doc")
            }
            Button {
                onSearch(address.searchQuery)
            } label: {
                Label("Search Name", systemImage: "magnifyingglass")
            }
        } label: {
            HStack(spacing: 4) {
                Text(address.label(selfAddress: selfAddress))
                    .font(.system(size: AppTheme.FontSize.meta, weight: .medium))
                    .lineLimit(1)
                Image(systemName: "chevron.right")
                    .font(.system(size: AppTheme.FontSize.chevron, weight: .semibold))
            }
            .padding(.leading, 8)
            .padding(.trailing, 6)
            .padding(.vertical, 4)
            .background(AppTheme.pillFill)
            .clipShape(Capsule())
            .foregroundStyle(AppTheme.muted)
        }
        .menuIndicator(.hidden)
        .buttonStyle(.plain)
        .accessibilityLabel(address.label(selfAddress: selfAddress))
        .accessibilityHint("Show contact actions")
    }
}
