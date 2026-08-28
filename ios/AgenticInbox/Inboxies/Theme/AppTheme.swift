import SwiftUI

/// Notion-inspired light palette. CSS variables → SwiftUI Color constants.
enum AppTheme {
    static let background = Color(red: 0.98, green: 0.98, blue: 0.985)
    static let surface = Color.white
    static let ink = Color(red: 0.12, green: 0.12, blue: 0.14)
    static let muted = Color(red: 0.45, green: 0.45, blue: 0.48)
    static let line = Color(red: 0.90, green: 0.90, blue: 0.92)
    static let pillFill = Color(red: 0.93, green: 0.93, blue: 0.94)
    static let pillActive = Color(red: 0.86, green: 0.86, blue: 0.875)
    static let accent = Color(red: 0.15, green: 0.35, blue: 0.85)
    static let unread = Color(red: 0.22, green: 0.22, blue: 0.24)
    static let deepDarkRed = Color(red: 0.42, green: 0.08, blue: 0.10)

    /// Type sizes from EmailDetailView; compose uses the same values for analogous chrome.
    enum FontSize {
        /// Large navigation title (subject) and compose heading.
        static let largeTitle: CGFloat = 22
        /// Collapsed navigation title and compose subject field.
        static let inlineTitle: CGFloat = 14
        /// Sender name and compose From line.
        static let sender: CGFloat = 12
        /// Recipient summary, expanded From label, and compose recipient field.
        static let recipient: CGFloat = 12
        /// Dates, To/Cc/Bcc labels, address pills, and compose recipient chrome.
        static let meta: CGFloat = 12
        /// Expand/picker chevrons.
        static let chevron: CGFloat = 8
        /// HTML email body and compose editor.
        static let body: CGFloat = 13
    }
}

extension View {
    /// Gentle opacity pulse used while skeleton placeholders are on screen.
    func skeletonPulse(_ active: Bool) -> some View {
        modifier(SkeletonPulseModifier(active: active))
    }
}

private struct SkeletonPulseModifier: ViewModifier {
    var active: Bool
    @State private var dimmed = false

    func body(content: Content) -> some View {
        content
            .opacity(active && dimmed ? 0.55 : 1)
            .onAppear { startIfNeeded() }
            .onChange(of: active) { _, _ in startIfNeeded() }
    }

    private func startIfNeeded() {
        guard active else {
            dimmed = false
            return
        }
        dimmed = false
        withAnimation(.easeInOut(duration: 0.95).repeatForever(autoreverses: true)) {
            dimmed = true
        }
    }
}
