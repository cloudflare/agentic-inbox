import SwiftUI

struct EmailDetailView: View {
    @Environment(AppModel.self) private var app
    let email: Email

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text(email.subject.isEmpty ? "(no subject)" : email.subject)
                        .font(.system(size: 24, weight: .semibold))
                        .foregroundStyle(AppTheme.ink)

                    actionBar

                    ForEach(app.threadEmails) { message in
                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                Text(message.displaySender)
                                    .font(.system(size: 15, weight: .semibold))
                                Spacer()
                                Text(message.date.prefix(16))
                                    .font(.system(size: 13))
                                    .foregroundStyle(AppTheme.muted)
                            }
                            Text(message.sender)
                                .font(.system(size: 13))
                                .foregroundStyle(AppTheme.muted)

                            if let cc = message.cc, !cc.isEmpty {
                                Text("Cc: \(cc)")
                                    .font(.system(size: 13))
                                    .foregroundStyle(AppTheme.muted)
                            }

                            Divider().overlay(AppTheme.line)

                            EmailBodyView(htmlOrText: message.body ?? message.snippet ?? "")

                            AttachmentListView(email: message)
                        }
                        .padding(16)
                        .background(AppTheme.surface)
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }
                }
                .padding(16)
            }
            .background(AppTheme.background)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { app.selectedEmail = nil }
                }
            }
        }
    }

    private var actionBar: some View {
        HStack(spacing: 10) {
            actionButton("Reply", systemImage: "arrowshape.turn.up.left") {
                Task {
                    let source = app.threadEmails.last ?? email
                    await app.startCompose(mode: .reply, original: source)
                }
            }
            actionButton("Reply All", systemImage: "arrowshape.turn.up.left.2") {
                Task {
                    let source = app.threadEmails.last ?? email
                    await app.startCompose(mode: .replyAll, original: source)
                }
            }
            actionButton("Forward", systemImage: "arrowshape.turn.up.right") {
                Task {
                    let source = app.threadEmails.last ?? email
                    await app.startCompose(mode: .forward, original: source)
                }
            }
            Spacer()
        }
    }

    private func actionButton(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(.system(size: 13, weight: .medium))
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(AppTheme.pillFill)
                .foregroundStyle(AppTheme.ink)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}
