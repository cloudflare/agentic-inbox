import SwiftUI

/// Email rows styled like Notion search results:
/// icon · bold title · "in Folder" · 2-line snippet.
struct EmailListView: View {
    let emails: [Email]
    var highlightQuery: String = ""
    let onSelect: (Email) -> Void

    var body: some View {
        if emails.isEmpty {
            ContentUnavailableView(
                "No emails",
                systemImage: "tray",
                description: Text("This folder is empty.")
            )
        } else {
            List {
                ForEach(emails) { email in
                    Button { onSelect(email) } label: {
                        EmailRowView(email: email, highlightQuery: highlightQuery)
                    }
                    .buttonStyle(.plain)
                    .listRowInsets(EdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16))
                    .listRowSeparatorTint(AppTheme.line)
                    .listRowBackground(AppTheme.background)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(AppTheme.background)
            .safeAreaInset(edge: .bottom) {
                Color.clear.frame(height: 76)
            }
        }
    }
}

struct EmailRowView: View {
    let email: Email
    var highlightQuery: String = ""
    var folderLabel: String?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(AppTheme.pillFill)
                    .frame(width: 28, height: 28)
                Image(systemName: "doc.plaintext")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(AppTheme.muted)
            }

            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text(email.subject.isEmpty ? "(no subject)" : email.subject)
                        .font(.system(size: 16, weight: email.isUnread ? .semibold : .medium))
                        .foregroundStyle(AppTheme.ink)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    Text(Self.formatDate(email.date))
                        .font(.system(size: 13))
                        .foregroundStyle(AppTheme.muted)
                }

                HStack(spacing: 6) {
                    Text("in \(folderLabel ?? folderDisplayName)")
                        .font(.system(size: 13))
                        .foregroundStyle(AppTheme.muted)
                    if email.isUnread {
                        Text("Unread")
                            .font(.system(size: 11, weight: .medium))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 2)
                            .background(AppTheme.pillFill)
                            .clipShape(Capsule())
                            .foregroundStyle(AppTheme.muted)
                    }
                    if (email.threadCount ?? 1) > 1 {
                        Text("\(email.threadCount!)")
                            .font(.system(size: 11, weight: .medium))
                            .padding(.horizontal, 7)
                            .padding(.vertical, 2)
                            .background(AppTheme.pillFill)
                            .clipShape(Capsule())
                            .foregroundStyle(AppTheme.muted)
                    }
                }

                highlightedSnippet
                    .font(.system(size: 14))
                    .foregroundStyle(AppTheme.muted)
                    .lineLimit(2)
            }
        }
    }

    private var folderDisplayName: String {
        if let folderName = email.folderName, !folderName.isEmpty {
            return folderName.capitalized
        }
        if let folderId = email.folderId {
            return HomeTab.folder(folderId).title
        }
        return "Mailbox"
    }

    private var snippetSource: String {
        let sender = email.displaySender
        let snip = (email.snippet ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if snip.isEmpty { return sender }
        return "\(sender) — \(snip)"
    }

    @ViewBuilder
    private var highlightedSnippet: some View {
        let query = highlightQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        if query.isEmpty {
            Text(snippetSource)
        } else {
            Text(Self.attributed(snippetSource, highlight: query))
        }
    }

    private static func formatDate(_ iso: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = formatter.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let date else { return "" }
        let out = DateFormatter()
        out.dateStyle = .short
        out.timeStyle = .none
        return out.string(from: date)
    }

    private static func attributed(_ text: String, highlight: String) -> AttributedString {
        var result = AttributedString(text)
        let lower = text.lowercased()
        let needle = highlight.lowercased()
        var searchStart = lower.startIndex
        while let range = lower.range(of: needle, range: searchStart..<lower.endIndex) {
            if let start = AttributedString.Index(range.lowerBound, within: result),
               let end = AttributedString.Index(range.upperBound, within: result) {
                result[start..<end].font = .system(size: 14, weight: .bold)
                result[start..<end].foregroundColor = AppTheme.ink
            }
            searchStart = range.upperBound
        }
        return result
    }
}
