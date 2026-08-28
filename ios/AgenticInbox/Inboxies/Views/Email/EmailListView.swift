import SwiftUI

/// Email rows styled like a mail client:
/// unread dot · sender + time · bold subject · 1-line preview.
struct EmailListView: View {
    let emails: [Email]
    var highlightQuery: String = ""
    var isLoading: Bool = false
    var onRefresh: (() async -> Void)? = nil
    let onSelect: (Email) -> Void

    var body: some View {
        Group {
            if isLoading {
                skeletonList
            } else if emails.isEmpty {
                emptyList
            } else {
                emailList
            }
        }
        .animation(nil, value: isLoading)
    }

    /// Empty folders still need a scroll view so pull-to-refresh works.
    private var emptyList: some View {
        GeometryReader { proxy in
            ScrollView {
                ContentUnavailableView(
                    "No emails",
                    systemImage: "tray",
                    description: Text("This folder is empty.")
                )
                .frame(width: proxy.size.width, height: max(proxy.size.height, 1))
            }
            .scrollContentBackground(.hidden)
            .background(AppTheme.background)
            .optionalRefreshable(onRefresh)
        }
        .safeAreaInset(edge: .bottom) {
            Color.clear.frame(height: 76)
        }
    }

    private var emailList: some View {
        mailList {
            ForEach(emails) { email in
                Button { onSelect(email) } label: {
                    EmailRowView(email: email, highlightQuery: highlightQuery)
                }
                .buttonStyle(MailRowButtonStyle())
                .mailRowChrome()
            }
        }
    }

    /// Placeholder rows use the same `EmailRowView` metrics so the list does
    /// not jump when real messages replace the skeleton.
    private var skeletonList: some View {
        mailList {
            ForEach(0..<Self.skeletonCount, id: \.self) { index in
                EmailRowView(email: Self.placeholder(at: index))
                    .redacted(reason: .placeholder)
                    .mailRowChrome()
                    .allowsHitTesting(false)
            }
        }
        .skeletonPulse(true)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading emails")
    }

    private func mailList<Rows: View>(@ViewBuilder rows: () -> Rows) -> some View {
        List {
            rows()
        }
        .listStyle(.plain)
        .contentMargins(.top, 12, for: .scrollContent)
        .scrollContentBackground(.hidden)
        .background(AppTheme.background)
        .scrollDisabled(isLoading)
        .optionalRefreshable(isLoading ? nil : onRefresh)
        .safeAreaInset(edge: .bottom) {
            Color.clear.frame(height: 76)
        }
    }

    private static let skeletonCount = 9

    private static func placeholder(at index: Int) -> Email {
        let seed = placeholderSeeds[index % placeholderSeeds.count]
        return Email(
            id: "skeleton-\(index)",
            subject: seed.subject,
            sender: seed.sender,
            senderName: seed.sender,
            recipient: "",
            date: "2026-03-15T14:30:00.000Z",
            read: !seed.unread,
            starred: false,
            snippet: seed.preview
        )
    }

    private static let placeholderSeeds: [(sender: String, subject: String, preview: String, unread: Bool)] = [
        ("Jordan Hale", "Quarterly planning notes", "Can we move Thursday's sync to the morning instead?", true),
        ("Alex Rivera", "Re: Invoice for March", "Attached is the updated PDF for last month's work.", false),
        ("Sam Chen", "Design review tomorrow", "Posting the latest frames in the shared folder now.", true),
        ("Taylor Brooks", "Flight confirmation", "Your itinerary for next week's trip is ready to view.", false),
        ("Morgan Lee", "Offer details", "Sharing the revised timeline and next steps below.", true),
        ("Casey Nguyen", "Weekend photos", "A few shots from the hike if you want them for the album.", false),
        ("Riley Patel", "Contract countersigned", "We are all set on our side and can kick off Monday.", false),
        ("Jamie Ortiz", "Lunch next week?", "I am free Wednesday or Friday if either still works.", true),
        ("Drew Collins", "Project kickoff deck", "Added speaker notes and the customer quotes we discussed.", false),
    ]
}

private struct MailRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .opacity(configuration.isPressed ? 0.55 : 1)
    }
}

private extension View {
    func mailRowChrome() -> some View {
        self
            .listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)
            .listRowBackground(AppTheme.background)
    }

    @ViewBuilder
    func optionalRefreshable(_ action: (() async -> Void)?) -> some View {
        if let action {
            self.refreshable { await action() }
        } else {
            self
        }
    }
}

struct EmailRowView: View {
    let email: Email
    var highlightQuery: String = ""
    var folderLabel: String?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            unreadDot

            VStack(alignment: .leading, spacing: 3) {
                headerRow
                subjectRow
                if !previewText.isEmpty {
                    previewRow
                }
                if let tag = tagLabel {
                    tagRow(tag)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 14)
        .padding(.leading, 8)
        .padding(.trailing, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    private var unreadDot: some View {
        Circle()
            .fill(email.isUnread ? AppTheme.unread : Color.clear)
            .frame(width: 8, height: 8)
            .frame(width: 10, height: 20, alignment: .center)
            .accessibilityLabel(email.isUnread ? "Unread" : "Read")
    }

    private var headerRow: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            highlighted(email.displaySender, size: 12, weight: email.isUnread ? .semibold : .regular)
                .foregroundStyle(AppTheme.ink)
                .lineLimit(1)

            if (email.threadCount ?? 1) > 1 {
                Text("\(email.threadCount!)")
                    .font(.system(size: 10, weight: .medium))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(AppTheme.pillFill)
                    .clipShape(Capsule())
                    .foregroundStyle(AppTheme.muted)
            }

            if email.hasDraft == true {
                Text("Draft")
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(AppTheme.deepDarkRed)
            }

            Spacer(minLength: 8)

            HStack(alignment: .center, spacing: 4) {
                if email.hasFileAttachment {
                    Image(systemName: "paperclip")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(AppTheme.muted)
                        .accessibilityLabel("Has attachment")
                }

                Text(Self.formatDate(email.date))
                    .font(.system(size: 10))
                    .foregroundStyle(AppTheme.muted)
            }
        }
    }

    private var subjectRow: some View {
        highlighted(
            email.subject.isEmpty ? "(no subject)" : email.subject,
            size: 12,
            weight: email.isUnread ? .semibold : .regular
        )
        .foregroundStyle(AppTheme.ink)
        .lineLimit(1)
    }

    private var previewRow: some View {
        highlighted(previewText, size: 12, weight: .regular)
            .foregroundStyle(AppTheme.muted)
            .lineLimit(1)
    }

    private func tagRow(_ tag: String) -> some View {
        Text(tag)
            .font(.system(size: 10, weight: .medium))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(AppTheme.pillFill)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            .foregroundStyle(AppTheme.muted)
            .padding(.top, 3)
    }

    private var previewText: String {
        email.previewText
    }

    private var tagLabel: String? {
        if let folderLabel, !folderLabel.isEmpty { return folderLabel }
        let query = highlightQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return nil }
        if let folderName = email.folderName, !folderName.isEmpty {
            return folderName.capitalized
        }
        return nil
    }

    private func highlighted(_ text: String, size: CGFloat, weight: Font.Weight) -> Text {
        let query = highlightQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        if query.isEmpty {
            return Text(text).font(.system(size: size, weight: weight))
        }
        return Text(Self.attributed(text, highlight: query, size: size, weight: weight))
    }

    private static func formatDate(_ iso: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = formatter.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let date else { return "" }

        let calendar = Calendar.current
        let out = DateFormatter()
        if calendar.isDateInToday(date) {
            out.timeStyle = .short
            out.dateStyle = .none
            return out.string(from: date)
        }
        if calendar.component(.year, from: date) == calendar.component(.year, from: Date()) {
            out.setLocalizedDateFormatFromTemplate("MMMd")
        } else {
            out.setLocalizedDateFormatFromTemplate("MMMdyyyy")
        }
        return out.string(from: date)
    }

    private static func attributed(
        _ text: String,
        highlight: String,
        size: CGFloat,
        weight: Font.Weight
    ) -> AttributedString {
        var result = AttributedString(text)
        result.font = .system(size: size, weight: weight)
        let lower = text.lowercased()
        let needle = highlight.lowercased()
        var searchStart = lower.startIndex
        while let range = lower.range(of: needle, range: searchStart..<lower.endIndex) {
            if let start = AttributedString.Index(range.lowerBound, within: result),
               let end = AttributedString.Index(range.upperBound, within: result) {
                result[start..<end].font = .system(size: size, weight: .bold)
                result[start..<end].foregroundColor = AppTheme.ink
            }
            searchStart = range.upperBound
        }
        return result
    }
}
