import SwiftUI

/// Notion-like search screen: floating bottom search field + result rows.
struct SearchView: View {
    var initialQuery: String = ""

    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    @State private var query: String
    @State private var results: [Email] = []
    @State private var isSearching = false
    @State private var errorMessage: String?
    @State private var showChat = false
    @FocusState private var focused: Bool

    init(initialQuery: String = "") {
        self.initialQuery = initialQuery
        _query = State(initialValue: initialQuery)
    }

    private var trimmedQuery: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var hasResults: Bool {
        !results.isEmpty
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            AppTheme.background.ignoresSafeArea()

            VStack(alignment: .leading, spacing: 0) {
                if !trimmedQuery.isEmpty {
                    askAIButton
                        .padding(.horizontal, 16)
                        .padding(.top, 12)
                        .padding(.bottom, 20)
                }

                if let errorMessage {
                    Text(errorMessage)
                        .foregroundStyle(.red)
                        .padding()
                    Spacer()
                } else if isSearching || hasResults {
                    Text("Results")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(AppTheme.muted)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 8)
                        .opacity(hasResults && !isSearching ? 1 : 0)

                    EmailListView(
                        emails: results,
                        highlightQuery: query,
                        isLoading: isSearching
                    ) { email in
                        Task {
                            await app.openEmail(email)
                            dismiss()
                        }
                    }
                } else if trimmedQuery.count >= 2 {
                    Text("No matching emails")
                        .font(.system(size: 15))
                        .foregroundStyle(AppTheme.muted)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 24)
                    Spacer()
                } else {
                    Spacer()
                }
            }
            .padding(.top, 28)
            .safeAreaInset(edge: .bottom) {
                Color.clear.frame(height: 70)
            }

            searchBar
                .padding(.horizontal, 12)
                .padding(.bottom, 10)
        }
        .onAppear { focused = initialQuery.isEmpty }
        .task(id: query) {
            await runSearch()
        }
        .sheet(isPresented: $showChat) {
            ChatSheetView(seedPrompt: trimmedQuery)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
    }

    private var askAIButton: some View {
        Button {
            showChat = true
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "sparkles")
                    .font(.system(size: 16, weight: .medium))
                Text("Ask AI “\(trimmedQuery)”")
                    .font(.system(size: 16, weight: .medium))
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .frame(height: 52)
            .background(AppTheme.surface)
            .foregroundStyle(AppTheme.ink)
            .clipShape(Capsule())
            .shadow(color: .black.opacity(0.08), radius: 10, y: 4)
        }
        .buttonStyle(.plain)
    }

    private var searchBar: some View {
        HStack(spacing: 10) {
            searchField
            cancelButton
        }
        .liquidGlassContainer(spacing: 10)
    }

    private var searchField: some View {
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
                .buttonStyle(.plain)
                .accessibilityLabel("Clear")
            }
        }
        .padding(.horizontal, 14)
        .frame(height: 52)
        .liquidGlass(in: RoundedRectangle(cornerRadius: 50, style: .continuous))
    }

    private var cancelButton: some View {
        Button {
            dismiss()
        } label: {
            Image(systemName: "xmark")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(AppTheme.ink)
                .frame(height: 52)
                .frame(width: 52)
                .frame(alignment: .center)
        }
        .buttonStyle(.plain)
        .liquidGlass(in: Capsule())
        .accessibilityLabel("Cancel")
    }

    private func runSearch() async {
        let q = trimmedQuery
        guard let mailboxId = app.selectedMailboxId else { return }
        guard q.count >= 2 else {
            results = []
            errorMessage = nil
            return
        }

        // 1. Instant local FTS5 search (0ms)
        let localMatches = DatabaseService.shared.searchEmails(mailboxId: mailboxId, query: q, limit: 30)
        if !localMatches.isEmpty {
            results = localMatches
        }

        isSearching = true
        errorMessage = nil
        defer { isSearching = false }
        do {
            try await Task.sleep(nanoseconds: 200_000_000)
            guard !Task.isCancelled else { return }
            let response = try await APIClient.shared.searchEmails(mailboxId: mailboxId, query: q)
            results = response.emails
            DatabaseService.shared.upsertEmails(mailboxId: mailboxId, emails: response.emails)
        } catch is CancellationError {
            // ignore
        } catch {
            if results.isEmpty {
                errorMessage = error.localizedDescription
            }
        }
    }
}
