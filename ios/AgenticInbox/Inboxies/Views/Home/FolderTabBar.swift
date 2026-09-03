import SwiftUI
import UIKit

/// Native `UITabBar` for folder switching, tinted to match the floating action chrome.
struct FolderTabBar: UIViewRepresentable {
    let tabs: [HomeTab]
    var selection: HomeTab
    var onSelect: (HomeTab) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> UITabBar {
        let tabBar = UITabBar()
        tabBar.delegate = context.coordinator
        tabBar.isTranslucent = false
        tabBar.tintColor = UIColor(AppTheme.ink)
        tabBar.unselectedItemTintColor = UIColor(AppTheme.muted)
        tabBar.applySurfaceAppearance()
        tabBar.items = Self.makeItems(from: tabs)
        syncSelection(on: tabBar)
        return tabBar
    }

    func updateUIView(_ tabBar: UITabBar, context: Context) {
        context.coordinator.parent = self
        tabBar.applySurfaceAppearance()
        if tabBar.items?.count != tabs.count {
            tabBar.items = Self.makeItems(from: tabs)
        }
        syncSelection(on: tabBar)
    }

    private func syncSelection(on tabBar: UITabBar) {
        guard let index = tabs.firstIndex(of: selection),
              let items = tabBar.items,
              items.indices.contains(index) else { return }
        tabBar.selectedItem = items[index]
    }

    private static func makeItems(from tabs: [HomeTab]) -> [UITabBarItem] {
        tabs.enumerated().map { index, tab in
            UITabBarItem(
                title: tab.title,
                image: UIImage(systemName: tab.systemImage, withConfiguration: UIImage.SymbolConfiguration(pointSize: 14, weight: .regular)),
                tag: index
            )
        }
    }

    final class Coordinator: NSObject, UITabBarDelegate {
        var parent: FolderTabBar

        init(parent: FolderTabBar) {
            self.parent = parent
        }

        func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
            guard parent.tabs.indices.contains(item.tag) else { return }
            let tab = parent.tabs[item.tag]
            guard parent.selection != tab else { return }
            parent.onSelect(tab)
        }
    }
}

private extension UITabBar {
    func applySurfaceAppearance() {
        let appearance = UITabBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = UIColor(AppTheme.surface)
        appearance.shadowColor = UIColor.black.withAlphaComponent(0.08)
        appearance.shadowImage = nil

        let titleFont = UIFont.systemFont(ofSize: HomeChromeMetrics.tabLabelPointSize, weight: .medium)
        let selectedTitleFont = UIFont.systemFont(ofSize: HomeChromeMetrics.tabLabelPointSize, weight: .semibold)
        let normalAttributes: [NSAttributedString.Key: Any] = [
            .foregroundColor: UIColor(AppTheme.muted),
            .font: titleFont
        ]
        let selectedAttributes: [NSAttributedString.Key: Any] = [
            .foregroundColor: UIColor(AppTheme.ink),
            .font: selectedTitleFont
        ]

        [appearance.stackedLayoutAppearance,
         appearance.inlineLayoutAppearance,
         appearance.compactInlineLayoutAppearance].forEach { layout in
            layout.normal.iconColor = UIColor(AppTheme.muted)
            layout.normal.titleTextAttributes = normalAttributes
            layout.selected.iconColor = UIColor(AppTheme.ink)
            layout.selected.titleTextAttributes = selectedAttributes
        }

        standardAppearance = appearance
        scrollEdgeAppearance = appearance
    }
}
