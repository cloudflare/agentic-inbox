import SwiftUI

/// Shared Liquid Glass styling (iOS 26+) with material fallback for earlier releases.
enum HomeChromeMetrics {
    static let actionBarHeight: CGFloat = 52
    static let tabStripHeight: CGFloat = 49
    static let chromeHorizontalPadding: CGFloat = 12
    static let chromeSpacing: CGFloat = 10
    static let chromeBottomPadding: CGFloat = 10
    static let chromeCornerRadius: CGFloat = 50
    static let tabLabelPointSize: CGFloat = 10
    static let minimizedComposeHeight: CGFloat = 58

    static func listBottomInset(hasMinimizedCompose: Bool) -> CGFloat {
        var height = tabStripHeight + chromeSpacing + actionBarHeight
        if hasMinimizedCompose {
            height += minimizedComposeHeight
        }
        return height
    }
}

extension View {
    @ViewBuilder
    func liquidGlass<S: Shape>(in shape: S) -> some View {
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
    func liquidGlassContainer(spacing: CGFloat) -> some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: spacing) { self }
        } else {
            self
        }
    }
}
