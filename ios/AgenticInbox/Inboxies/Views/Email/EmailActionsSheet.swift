import SwiftUI

/// Medium sheet of email actions, opened from the detail ellipsis or list swipe More.
struct EmailActionsSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    let email: Email
    var onRemoveFromList: ((String) -> Void)? = nil

    @State private var selectedDetent: PresentationDetent = .medium

    private var source: Email {
        if app.selectedEmail?.id == email.id {
            return app.actionSourceEmail ?? email
        }
        return email
    }

    private var availability: EmailActionAvailability {
        EmailActionAvailability(email: source)
    }

    private var fromList: Bool {
        app.selectedEmail?.id != email.id
    }

    private var moveTargets: [Folder] {
        let current = source.folderId
        return app.folders.filter { $0.id != current }
    }

    private var previewLine: String {
        source.previewText.isEmpty ? "(no preview)" : source.previewText
    }

    var body: some View {
        NavigationStack {
            List {
                if availability.showsReplyActions {
                    Section {
                        quickActionsRow
                            .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                    }
                }

                Section {
                    actionRow(
                        source.starred ? "Unstar" : "Star",
                        systemImage: source.starred ? "star.fill" : "star"
                    ) {
                        Task { await app.toggleStar(on: source) }
                    }

                    actionRow(
                        source.read ? "Mark as Unread" : "Mark as Read",
                        systemImage: source.read ? "envelope.badge" : "envelope.open"
                    ) {
                        Task { await app.toggleRead(on: source) }
                    }

                    if !moveTargets.isEmpty {
                        NavigationLink {
                            MoveToFolderView(folders: moveTargets, onClose: dismissSheet) { folderId in
                                Task {
                                    dismiss()
                                    await app.moveEmail(source, to: folderId, fromList: fromList)
                                    if fromList { onRemoveFromList?(source.id) }
                                }
                            }
                        } label: {
                            Label("Move to Folder", systemImage: "folder")
                        }
                    }

                    NavigationLink {
                        EmailSourceView(email: source, onClose: dismissSheet)
                    } label: {
                        Label("View Source", systemImage: "chevron.left.forwardslash.chevron.right")
                    }

                    if availability.showsDelete {
                        Menu {
                            Button("Delete Message", role: .destructive) {
                                Task {
                                    dismiss()
                                    await app.deleteEmail(source, fromList: fromList)
                                    if fromList { onRemoveFromList?(source.id) }
                                }
                            }
                        } label: {
                            Label("Delete", systemImage: "trash")
                                .foregroundStyle(.red)
                        }
                    }
                }
            }
            .listSectionSpacing(.compact)
            .navigationTitle(source.displaySender)
            .navigationBarBackButtonHidden(true)
            .modifier(ActionsSheetSubtitle(subtitle: previewLine))
            .actionsSheetChrome(onClose: dismissSheet)
        }
        .tint(AppTheme.ink)
        .presentationDetents([.medium, .large], selection: $selectedDetent)
        .presentationDragIndicator(.visible)
        .presentationContentInteraction(.resizes)
        .presentationBackground(AppTheme.background)
    }

    private func dismissSheet() {
        dismiss()
    }

    private var quickActionsRow: some View {
        HStack(spacing: 8) {
            quickActionButton("Reply", systemImage: "arrowshape.turn.up.left") {
                Task {
                    dismiss()
                    await app.startCompose(mode: .reply, original: source)
                }
            }
            quickActionButton("Reply All", systemImage: "arrowshape.turn.up.left.2") {
                Task {
                    dismiss()
                    await app.startCompose(mode: .replyAll, original: source)
                }
            }
            quickActionButton("Forward", systemImage: "arrowshape.turn.up.right") {
                Task {
                    dismiss()
                    await app.startCompose(mode: .forward, original: source)
                }
            }
            if availability.showsArchive {
                quickActionButton("Archive", systemImage: "archivebox") {
                    Task {
                        dismiss()
                        await app.archiveEmail(source, fromList: fromList)
                        if fromList { onRemoveFromList?(source.id) }
                    }
                }
            }
        }
    }

    private func quickActionButton(
        _ title: String,
        systemImage: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: 8) {
                Image(systemName: systemImage)
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(AppTheme.ink)
                    .frame(width: 52, height: 52)
                    .background(AppTheme.pillFill)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                Text(title)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(AppTheme.ink)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
    }

    private func actionRow(
        _ title: String,
        systemImage: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .foregroundStyle(AppTheme.ink)
        }
    }
}

private struct MoveToFolderView: View {
    let folders: [Folder]
    var onClose: () -> Void
    var onMove: (String) -> Void

    var body: some View {
        List(folders) { folder in
            Button(folder.name) {
                onMove(folder.id)
            }
            .foregroundStyle(AppTheme.ink)
        }
        .navigationTitle("Move to")
        .actionsSheetChrome(onClose: onClose)
    }
}

private struct EmailSourceView: View {
    let email: Email
    var onClose: () -> Void

    var body: some View {
        List {
            ForEach(Array(email.sourceHeaders.enumerated()), id: \.offset) { _, header in
                VStack(alignment: .leading, spacing: 2) {
                    Text(header.key)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(AppTheme.muted)
                    Text(header.value)
                        .font(.system(size: 14, design: .monospaced))
                        .foregroundStyle(AppTheme.ink)
                        .textSelection(.enabled)
                }
                .padding(.vertical, 2)
            }
        }
        .navigationTitle("Source")
        .actionsSheetChrome(onClose: onClose)
    }
}

private struct ActionsSheetSubtitle: ViewModifier {
    var subtitle: String

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.navigationSubtitle(Text(subtitle))
        } else {
            content
        }
    }
}

private struct ActionsSheetChrome: ViewModifier {
    var onClose: () -> Void

    func body(content: Content) -> some View {
        content
            .scrollContentBackground(.hidden)
            .contentMargins(.top, 20, for: .scrollContent)
            .background(AppTheme.background)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarRole(.editor)
            .toolbarBackground(.ultraThinMaterial, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(action: onClose) {
                        Image(systemName: "xmark")
                    }
                    .accessibilityLabel("Close")
                }
            }
    }
}

private extension View {
    func actionsSheetChrome(onClose: @escaping () -> Void) -> some View {
        modifier(ActionsSheetChrome(onClose: onClose))
    }
}

#Preview("Actions sheet") {
    PreviewHost {
        EmailActionsSheet(email: PreviewSupport.emails[0])
    }
}
