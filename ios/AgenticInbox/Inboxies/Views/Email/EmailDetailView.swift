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

                    ForEach(app.threadEmails) { message in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(message.displaySender)
                                    .font(.system(size: 15, weight: .semibold))
                                Spacer()
                                Text(message.date.prefix(10))
                                    .font(.system(size: 13))
                                    .foregroundStyle(AppTheme.muted)
                            }
                            Text(message.sender)
                                .font(.system(size: 13))
                                .foregroundStyle(AppTheme.muted)

                            Divider()

                            Text(stripHTML(message.body ?? message.snippet ?? ""))
                                .font(.system(size: 16))
                                .foregroundStyle(AppTheme.ink)
                                .textSelection(.enabled)
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

    private func stripHTML(_ html: String) -> String {
        html
            .replacingOccurrences(of: "<br>", with: "\n", options: .caseInsensitive)
            .replacingOccurrences(of: "<br/>", with: "\n", options: .caseInsensitive)
            .replacingOccurrences(of: "<br />", with: "\n", options: .caseInsensitive)
            .replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
            .replacingOccurrences(of: "&nbsp;", with: " ")
            .replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
