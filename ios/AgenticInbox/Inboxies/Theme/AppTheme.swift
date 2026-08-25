import SwiftUI

/// Notion-inspired light palette. CSS variables → SwiftUI Color constants.
enum AppTheme {
    static let background = Color(red: 0.98, green: 0.98, blue: 0.985)
    static let surface = Color.white
    static let ink = Color(red: 0.12, green: 0.12, blue: 0.14)
    static let muted = Color(red: 0.45, green: 0.45, blue: 0.48)
    static let line = Color(red: 0.90, green: 0.90, blue: 0.92)
    static let pillFill = Color(red: 0.93, green: 0.93, blue: 0.94)
    static let pillActive = Color(red: 0.22, green: 0.22, blue: 0.24)
    static let accent = Color(red: 0.15, green: 0.35, blue: 0.85)
    static let unread = Color(red: 0.15, green: 0.35, blue: 0.85)
}
