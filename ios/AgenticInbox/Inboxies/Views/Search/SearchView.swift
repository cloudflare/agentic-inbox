import SwiftUI

/// Notion-like search screen: floating bottom search field + result rows.
struct SearchView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    @State private var query = ""
    @State private var results: [Email] = []
    @State private var isSearching = false
    @State private var errorMessage: String?
    @State private var showChat = false
    @FocusState private var focused: Bool

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

                if isSearching {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let errorMessage {
                    Text(errorMessage)
                        .foregroundStyle(.red)
                        .padding()
                    Spacer()
                } else if hasResults {
                    Text("Results")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(AppTheme.muted)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 8)

                    EmailListView(emails: results, highlightQuery: query) { email in
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
        .onAppear { focused = true }
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
        .searchGlassContainer(spacing: 10)
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
        .searchGlass(in: RoundedRectangle(cornerRadius: 50, style: .continuous))
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
        .searchGlass(in: Capsule())
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

private extension View {
    @ViewBuilder
    func searchGlass<S: Shape>(in shape: S) -> some View {
        if #available(iOS 26.0, *) {
            self.glassEffect(.regular.interactive(), in: shape)
        } else {
            self
                .background(.ultraThinMaterial, in: shape)
                .overlay {
                    shape.stroke(Color.white.opacity(0.45), lineWidth: 0.5)
                }
                .shadow(color: .black.opacity(0.08), radius: 12, y: 4)
        }
    }

    @ViewBuilder
    func searchGlassContainer(spacing: CGFloat) -> some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: spacing) { self }
        } else {
            self
        }
    }
}
