import SwiftUI

/// Mailbox settings sheet: profile, preferences, and account actions.
struct SettingsSheetView: View {
    @Environment(AppModel.self) private var app
    @Environment(AuthStore.self) private var auth
    @Environment(\.dismiss) private var dismiss

    @State private var editNameDraft = ""
    @State private var showEditName = false
    @State private var showDisconnectConfirm = false
    @State private var signatureEnabled = false

    private var mailbox: Mailbox? {
        app.selectedMailbox
    }

    private var displayName: String {
        if let fromName = mailbox?.settings?.fromName, !fromName.isEmpty {
            return fromName
        }
        if let name = mailbox?.name, !name.isEmpty, name != mailbox?.email {
            return name
        }
        if let local = mailbox?.email.split(separator: "@").first, !local.isEmpty {
            return String(local)
        }
        return mailbox?.name ?? "Mailbox"
    }

    private var emailAddress: String {
        mailbox?.email ?? auth.userEmail ?? ""
    }

    private var initials: String {
        AvatarInitials.from(displayName.isEmpty ? emailAddress : displayName)
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    profileHeader
                        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 16, trailing: 16))
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                }

                Section {
                    NavigationLink {
                        SwipeSettingsView()
                    } label: {
                        settingsLabel("Swipe settings", systemImage: "arrow.left.arrow.right")
                    }

                    NavigationLink {
                        AgentPromptSettingsView()
                    } label: {
                        settingsLabel("AI prompt", systemImage: "sparkles")
                    }

                    NavigationLink {
                        SettingsComingSoonView(title: "Notifications")
                    } label: {
                        settingsLabel("Notifications", systemImage: "bell")
                    }

                    Toggle(isOn: signatureBinding) {
                        Label {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Default signature")
                                    .foregroundStyle(AppTheme.ink)
                                Text("Include a signature in emails.")
                                    .font(.system(size: 12))
                                    .foregroundStyle(AppTheme.muted)
                            }
                        } icon: {
                            Image(systemName: "pencil")
                                .foregroundStyle(AppTheme.ink)
                        }
                    }
                    .tint(AppTheme.accent)
                } header: {
                    Text("Preferences")
                }
                .listRowSeparator(.hidden)

                Section {
                    NavigationLink {
                        SettingsComingSoonView(title: "Theme")
                    } label: {
                        settingsLabel("Theme", systemImage: "circle.lefthalf.filled")
                    }
                } header: {
                    Text("Display")
                }

                Section {
                    NavigationLink {
                        SettingsComingSoonView(title: "Support & feedback")
                    } label: {
                        settingsLabel("Support & feedback", systemImage: "questionmark.circle")
                    }
                } header: {
                    Text("Support")
                }

                Section {
                    Button("Disconnect address", role: .destructive) {
                        showDisconnectConfirm = true
                    }
                    .frame(maxWidth: .infinity)
                    .font(.system(size: 16, weight: .medium))
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(AppTheme.background)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(AppTheme.ink)
                            .frame(width: 32, height: 32)
                            .background(AppTheme.pillFill, in: Circle())
                    }
                    .accessibilityLabel("Close")
                }
            }
            .alert("Edit name", isPresented: $showEditName) {
                TextField("Display name", text: $editNameDraft)
                Button("Cancel", role: .cancel) {}
                Button("Save") {
                    Task { await saveDisplayName() }
                }
            } message: {
                Text("This name appears when you send email.")
            }
            .confirmationDialog(
                "Disconnect this address?",
                isPresented: $showDisconnectConfirm,
                titleVisibility: .visible
            ) {
                Button("Disconnect address", role: .destructive) {
                    dismiss()
                    auth.signOut()
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("You'll need to sign in again to use Inboxies.")
            }
            .onAppear {
                signatureEnabled = mailbox?.settings?.signature?.enabled == true
            }
            .onChange(of: app.selectedMailboxId) { _, _ in
                signatureEnabled = mailbox?.settings?.signature?.enabled == true
            }
        }
    }

    private var profileHeader: some View {
        VStack(spacing: 10) {
            Text(initials)
                .font(.system(size: initials.count > 1 ? 28 : 34, weight: .semibold))
                .foregroundStyle(AppTheme.ink)
                .frame(width: 88, height: 88)
                .background(AppTheme.pillFill, in: Circle())

            VStack(spacing: 4) {
                Text(displayName)
                    .font(.system(size: 22, weight: .bold))
                    .foregroundStyle(AppTheme.ink)
                    .multilineTextAlignment(.center)

                Text(emailAddress)
                    .font(.system(size: 14))
                    .foregroundStyle(AppTheme.muted)
                    .multilineTextAlignment(.center)
            }

            Button {
                editNameDraft = mailbox?.settings?.fromName
                    ?? (mailbox?.name != mailbox?.email ? (mailbox?.name ?? "") : "")
                showEditName = true
            } label: {
                Text("Edit")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(AppTheme.accent)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .background(AppTheme.pillFill, in: Capsule())
            }
            .buttonStyle(.plain)
            .padding(.top, 2)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 8)
    }

    private var signatureBinding: Binding<Bool> {
        Binding(
            get: { signatureEnabled },
            set: { newValue in
                signatureEnabled = newValue
                Task { await saveSignatureEnabled(newValue) }
            }
        )
    }

    private func settingsLabel(_ title: String, systemImage: String) -> some View {
        Label {
            Text(title)
                .foregroundStyle(AppTheme.ink)
        } icon: {
            Image(systemName: systemImage)
                .foregroundStyle(AppTheme.ink)
        }
    }

    private func saveDisplayName() async {
        let trimmed = editNameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        _ = await app.updateMailboxSettings { settings in
            settings.fromName = trimmed
        }
    }

    private func saveSignatureEnabled(_ enabled: Bool) async {
        let success = await app.updateMailboxSettings { settings in
            var signature = settings.signature ?? SignatureSettings()
            signature.enabled = enabled
            if signature.text == nil, signature.html == nil, enabled {
                let name = settings.fromName
                    ?? (mailbox?.name != mailbox?.email ? mailbox?.name : nil)
                signature.text = name
            }
            settings.signature = signature
        }
        if !success {
            signatureEnabled = mailbox?.settings?.signature?.enabled == true
        }
    }
}

/// Placeholder destination for settings rows that are not implemented yet.
struct SettingsComingSoonView: View {
    let title: String

    var body: some View {
        ContentUnavailableView(
            title,
            systemImage: "wrench.and.screwdriver",
            description: Text("Coming soon.")
        )
        .background(AppTheme.background)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    }
}

enum AvatarInitials {
    /// Two letters for a two-character name or first + last; otherwise the first letter.
    static func from(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "A" }

        let source = trimmed.contains("@")
            ? String(trimmed.split(separator: "@").first ?? Substring(trimmed))
            : trimmed
        let parts = source
            .split { $0.isWhitespace || $0 == "." || $0 == "_" }
            .map(String.init)
            .filter { !$0.isEmpty }

        if parts.count >= 2 {
            return String(parts[0].prefix(1) + parts[parts.count - 1].prefix(1)).uppercased()
        }

        let word = parts.first ?? source
        if word.count <= 2 {
            return word.uppercased()
        }
        return String(word.prefix(1)).uppercased()
    }
}

#Preview("Settings") {
    PreviewHost {
        SettingsSheetView()
    }
}
