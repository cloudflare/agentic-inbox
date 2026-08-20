import SwiftUI

/// Notion-like search screen: floating bottom search field + result rows.
struct SearchView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    @State private var query = ""
    @State private var results: [Email] = []
    @State private var isSearching = false
    @State private var errorMessage: String?
    @FocusState private var focused: Bool

    var body: some View {
        ZStack(alignment: .bottom) {
            AppTheme.background.ignoresSafeArea()

            VStack(alignment: .leading, spacing: 0) {
                if !query.isEmpty {
                    HStack(spacing: 8) {
                        Image(systemName: "sparkles")
                            .foregroundStyle(AppTheme.muted)
                        Text("Ask AI “\(query)”")
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(AppTheme.ink)
                        Spacer()
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 16)
                    .padding(.bottom, 8)
                }

                Text("Results")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(AppTheme.muted)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)

                if isSearching {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let errorMessage {
                    Text(errorMessage)
                        .foregroundStyle(.red)
                        .padding()
                    Spacer()
                } else {
                    EmailListView(emails: results, highlightQuery: query) { email in
                        Task {
                            await app.openEmail(email)
                            dismiss()
                        }
                    }
                }
            }
            .safeAreaInset(edge: .bottom) {
                Color.clear.frame(height: 70)
            }

            searchBar
                .padding(.horizontal, 12)
                .padding(.bottom, 10)
        }
        .onAppear { focused = true }
        .task(id: query) {
            await runSearch()
        }
    }

    private var searchBar: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(AppTheme.muted)
            TextField("Search mail", text: $query)
                .focused($focused)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            if !query.isEmpty {
                Button {
                    query = ""
                    results = []
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(AppTheme.muted)
                }
            }
            Button { dismiss() } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 14, weight: .semibold))
                    .frame(width: 34, height: 34)
                    .background(AppTheme.pillFill)
                    .clipShape(Circle())
                    .foregroundStyle(AppTheme.ink)
            }
        }
        .padding(.horizontal, 14)
        .frame(height: 52)
        .background(AppTheme.surface)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .shadow(color: .black.opacity(0.1), radius: 12, y: 4)
    }

    private func runSearch() async {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let mailboxId = app.selectedMailboxId else { return }
        guard q.count >= 2 else {
            results = []
            return
        }
        isSearching = true
        errorMessage = nil
        defer { isSearching = false }
        do {
            try await Task.sleep(nanoseconds: 250_000_000)
            guard !Task.isCancelled else { return }
            let response = try await APIClient.shared.searchEmails(mailboxId: mailboxId, query: q)
            results = response.emails
        } catch is CancellationError {
            // ignore
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
