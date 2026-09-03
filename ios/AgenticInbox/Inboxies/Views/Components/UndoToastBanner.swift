import SwiftUI

/// Mail-style bottom toast with an Undo action.
struct UndoToastBanner: View {
    let message: String
    var onUndo: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Text(message)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(AppTheme.ink)
                .lineLimit(1)

            Spacer(minLength: 8)

            Button("Undo", action: onUndo)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(AppTheme.accent)
                .buttonStyle(.plain)
                .accessibilityHint("Reverses the last archive")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(AppTheme.line.opacity(0.7), lineWidth: 0.5)
        }
        .shadow(color: .black.opacity(0.12), radius: 16, y: 6)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isStaticText)
    }
}
