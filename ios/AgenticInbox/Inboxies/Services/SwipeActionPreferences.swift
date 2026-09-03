import Foundation
import SwiftUI

/// Configurable quick actions for email list swipes (normal folders only).
enum SwipeQuickAction: String, CaseIterable, Identifiable, Codable {
    case delete
    case archive
    case star
    case toggleRead
    case reply

    var id: String { rawValue }

    var title: String {
        switch self {
        case .delete: return "Delete"
        case .archive: return "Archive"
        case .star: return "Star"
        case .toggleRead: return "Mark Read/Unread"
        case .reply: return "Reply"
        }
    }

    var systemImage: String {
        switch self {
        case .delete: return "trash"
        case .archive: return "archivebox"
        case .star: return "star"
        case .toggleRead: return "envelope.open"
        case .reply: return "arrowshape.turn.up.left"
        }
    }

    var swipeTint: Color {
        switch self {
        case .delete: return .red
        case .archive: return Color(red: 0.55, green: 0.35, blue: 0.85)
        case .star: return .orange
        case .toggleRead: return .blue
        case .reply: return AppTheme.accent
        }
    }

    func label(for email: Email) -> String {
        switch self {
        case .star:
            return email.starred ? "Unstar" : "Star"
        case .toggleRead:
            return email.read ? "Unread" : "Read"
        default:
            return title
        }
    }

    func systemImage(for email: Email) -> String {
        switch self {
        case .star:
            return email.starred ? "star.fill" : "star"
        case .toggleRead:
            return email.read ? "envelope.badge" : "envelope.open"
        default:
            return systemImage
        }
    }
}

/// Resolved swipe layout for a list row.
struct EmailSwipeLayout {
    var trailingActions: [SwipeQuickAction]
    var trailingAllowsFullSwipe: Bool
    var leadingActions: [SwipeQuickAction]
    var leadingAllowsFullSwipe: Bool
    var showsMore: Bool

    static func resolve(
        for email: Email,
        fallbackFolderId: String?,
        preferences: SwipeActionPreferences
    ) -> EmailSwipeLayout {
        switch EmailFolderContext.kind(for: email, fallbackFolderId: fallbackFolderId) {
        case .archive:
            return EmailSwipeLayout(
                trailingActions: [.delete],
                trailingAllowsFullSwipe: true,
                leadingActions: [],
                leadingAllowsFullSwipe: false,
                showsMore: true
            )
        case .trash:
            return EmailSwipeLayout(
                trailingActions: [.delete],
                trailingAllowsFullSwipe: true,
                leadingActions: [.archive],
                leadingAllowsFullSwipe: true,
                showsMore: true
            )
        case .draft:
            return EmailSwipeLayout(
                trailingActions: [.delete],
                trailingAllowsFullSwipe: true,
                leadingActions: [],
                leadingAllowsFullSwipe: false,
                showsMore: true
            )
        case .inbox, .sent, .other:
            return EmailSwipeLayout(
                trailingActions: preferences.leftActions,
                trailingAllowsFullSwipe: !preferences.leftActions.isEmpty,
                leadingActions: preferences.rightActions,
                leadingAllowsFullSwipe: !preferences.rightActions.isEmpty,
                showsMore: true
            )
        }
    }
}

enum EmailFolderContext {
    enum Kind {
        case inbox
        case sent
        case archive
        case trash
        case draft
        case other
    }

    static func kind(for email: Email, fallbackFolderId: String?) -> Kind {
        let folderId = normalizedFolderId(email.folderId) ?? normalizedFolderId(fallbackFolderId)
        switch folderId {
        case "inbox": return .inbox
        case "sent": return .sent
        case "archive": return .archive
        case "trash": return .trash
        case "draft", "drafts": return .draft
        default:
            if email.isDraft { return .draft }
            return .other
        }
    }

    static func normalizedFolderId(_ id: String?) -> String? {
        guard let id, !id.isEmpty else { return nil }
        return id.lowercased()
    }
}

/// UserDefaults-backed swipe preferences for normal folders.
/// Left = trailing edge (swipe left), right = leading edge (swipe right).
struct SwipeActionPreferences: Equatable {
    static let maxActionsPerEdge = 3

    private static let leftActionsKey = "swipeLeftActions"
    private static let rightActionsKey = "swipeRightActions"
    /// Legacy single-action keys (migrated on first read).
    private static let legacyLeftKey = "swipeLeftAction"
    private static let legacyRightKey = "swipeRightAction"

    var leftActions: [SwipeQuickAction]
    var rightActions: [SwipeQuickAction]

    static var current: SwipeActionPreferences {
        SwipeActionPreferences()
    }

    init(
        leftActions: [SwipeQuickAction] = [.delete],
        rightActions: [SwipeQuickAction] = [.archive]
    ) {
        self.leftActions = Self.normalized(leftActions, fallback: [.delete])
        self.rightActions = Self.normalized(rightActions, fallback: [.archive])
    }

    init() {
        let defaults = UserDefaults.standard
        if defaults.data(forKey: Self.leftActionsKey) != nil {
            leftActions = Self.normalized(Self.loadActions(forKey: Self.leftActionsKey) ?? [], fallback: [])
        } else if let legacy = defaults.string(forKey: Self.legacyLeftKey),
                  let action = SwipeQuickAction(rawValue: legacy) {
            leftActions = [action]
        } else {
            leftActions = [.delete]
        }

        if defaults.data(forKey: Self.rightActionsKey) != nil {
            rightActions = Self.normalized(Self.loadActions(forKey: Self.rightActionsKey) ?? [], fallback: [])
        } else if let legacy = defaults.string(forKey: Self.legacyRightKey),
                  let action = SwipeQuickAction(rawValue: legacy) {
            rightActions = [action]
        } else {
            rightActions = [.archive]
        }
    }

    func save() {
        Self.persist(leftActions, forKey: Self.leftActionsKey)
        Self.persist(rightActions, forKey: Self.rightActionsKey)
        let defaults = UserDefaults.standard
        defaults.removeObject(forKey: Self.legacyLeftKey)
        defaults.removeObject(forKey: Self.legacyRightKey)
    }

    mutating func setLeftActions(_ actions: [SwipeQuickAction]) {
        leftActions = Self.normalized(actions, fallback: [])
        save()
    }

    mutating func setRightActions(_ actions: [SwipeQuickAction]) {
        rightActions = Self.normalized(actions, fallback: [])
        save()
    }

    private static func normalized(
        _ actions: [SwipeQuickAction],
        fallback: [SwipeQuickAction]
    ) -> [SwipeQuickAction] {
        var seen = Set<SwipeQuickAction>()
        var result: [SwipeQuickAction] = []
        for action in actions {
            guard !seen.contains(action) else { continue }
            seen.insert(action)
            result.append(action)
            if result.count >= maxActionsPerEdge { break }
        }
        if result.isEmpty, !fallback.isEmpty {
            return fallback
        }
        return result
    }

    private static func loadActions(forKey key: String) -> [SwipeQuickAction]? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode([SwipeQuickAction].self, from: data)
    }

    private static func persist(_ actions: [SwipeQuickAction], forKey key: String) {
        if let data = try? JSONEncoder().encode(actions) {
            UserDefaults.standard.set(data, forKey: key)
        }
    }
}

/// Which actions are valid for a given message (options sheet + detail toolbar).
struct EmailActionAvailability {
    let email: Email

    var showsArchive: Bool {
        !isInArchive && !email.isDraft
    }

    var showsDelete: Bool { true }

    var showsReplyActions: Bool {
        !email.isDraft
    }

    private var isInArchive: Bool {
        EmailFolderContext.kind(for: email, fallbackFolderId: nil) == .archive
    }
}
