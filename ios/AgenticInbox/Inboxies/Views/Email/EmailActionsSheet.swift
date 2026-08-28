import SwiftUI

/// Medium sheet of email actions, opened from the detail ellipsis.
struct EmailActionsSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    let email: Email

    private var source: Email {
        app.actionSourceEmail ?? email
    }

    private var moveTargets: [Folder] {
        let current = source.folderId
        return app.folders.filter { $0.id != current }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(source.displaySender)
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(AppTheme.ink)
                        Text(source.previewText.isEmpty ? "(no preview)" : source.previewText)
                            .font(.system(size: 14))
                            .foregroundStyle(AppTheme.muted)
                            .lineLimit(1)
                    }
                    .padding(.vertical, 4)
                    .listRowBackground(Color.clear)
                }

                Section {
                    actionRow("Reply", systemImage: "arrowshape.turn.up.left") {
                        Task {
                            dismiss()
                            await app.startCompose(mode: .reply, original: source)
                        }
                    }
                    actionRow("Reply All", systemImage: "arrowshape.turn.up.left.2") {
                        Task {
                            dismiss()
                            await app.startCompose(mode: .replyAll, original: source)
                        }
                    }
                    actionRow("Forward", systemImage: "arrowshape.turn.up.right") {
                        Task {
                            dismiss()
                            await app.startCompose(mode: .forward, original: source)
                        }
                    }
                    actionRow("Archive", systemImage: "archivebox") {
                        Task {
                            dismiss()
                            await app.archiveCurrentEmail()
                        }
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

                    NavigationLink {
                        MoveToFolderView(folders: moveTargets) { folderId in
                            Task {
                                dismiss()
                                await app.moveCurrentEmail(to: folderId)
                            }
                        }
                    } label: {
                        Label("Move to Folder", systemImage: "folder")
                    }

                    NavigationLink {
                        EmailSourceView(email: source)
                    } label: {
                        Label("View Source", systemImage: "chevron.left.forwardslash.chevron.right")
                    }

                    Menu {
                        Button("Delete Message", role: .destructive) {
                            Task {
                                dismiss()
                                await app.deleteCurrentEmail()
                            }
                        }
                    } label: {
                        Label("Delete", systemImage: "trash")
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Actions")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
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
    var onMove: (String) -> Void

    var body: some View {
        List(folders) { folder in
            Button(folder.name) {
                onMove(folder.id)
            }
            .foregroundStyle(AppTheme.ink)
        }
        .navigationTitle("Move to")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct EmailSourceView: View {
    let email: Email

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
        .navigationBarTitleDisplayMode(.inline)
    }
}
