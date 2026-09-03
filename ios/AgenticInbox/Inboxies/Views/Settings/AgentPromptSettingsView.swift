import SwiftUI

/// Mailbox AI agent system prompt editor.
struct AgentPromptSettingsView: View {
    @Environment(AppModel.self) private var app

    @State private var agentPrompt = ""
    @State private var isSaving = false
    @State private var saveMessage: String?

    private var isCustomPrompt: Bool {
        !agentPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    Text(isCustomPrompt ? "Custom" : "Default")
                        .font(.system(size: 11, weight: .semibold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(AppTheme.pillFill, in: Capsule())
                        .foregroundStyle(AppTheme.muted)

                    if isCustomPrompt {
                        Button("Reset to default") {
                            agentPrompt = ""
                        }
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(AppTheme.accent)
                    }
                }

                Text("Customize how the AI agent behaves for this mailbox. Leave empty to use the built-in default prompt.")
                    .font(.system(size: 12))
                    .foregroundStyle(AppTheme.muted)

                TextEditor(text: $agentPrompt)
                    .font(.system(size: 12, design: .monospaced))
                    .frame(minHeight: 220)
                    .padding(10)
                    .scrollContentBackground(.hidden)
                    .background(AppTheme.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .stroke(AppTheme.line, lineWidth: 1)
                    )

                Text("The prompt is sent as the system message to the AI model. It controls the agent's personality, writing style, and behavior rules.")
                    .font(.system(size: 12))
                    .foregroundStyle(AppTheme.muted)
            }
            .padding(16)
        }
        .background(AppTheme.background)
        .navigationTitle("AI Prompt")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Save") {
                    Task { await save() }
                }
                .disabled(isSaving || app.selectedMailbox == nil)
                .fontWeight(.semibold)
            }
        }
        .overlay(alignment: .bottom) {
            if let saveMessage {
                Text(saveMessage)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(AppTheme.ink)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(AppTheme.pillFill, in: Capsule())
                    .padding(.bottom, 12)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .onAppear {
            agentPrompt = app.selectedMailbox?.settings?.agentSystemPrompt ?? ""
        }
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }

        let trimmed = agentPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let success = await app.updateMailboxSettings { settings in
            settings.agentSystemPrompt = trimmed.isEmpty ? nil : trimmed
        }

        withAnimation {
            saveMessage = success ? "Prompt saved" : "Failed to save"
        }
        try? await Task.sleep(nanoseconds: success ? 1_200_000_000 : 2_000_000_000)
        withAnimation { saveMessage = nil }
    }
}

#Preview("AI prompt") {
    PreviewHost {
        NavigationStack {
            AgentPromptSettingsView()
        }
    }
}
