import Foundation

/// Runtime configuration. Change `apiBaseURL` to your Worker URL (or localhost via Mac for simulator).
enum AppConfig {
    /// Production Worker URL, e.g. https://agentic-inbox.your-subdomain.workers.dev
    /// Simulator tip: use http://127.0.0.1:5173 when running `pnpm dev` on the same Mac.
    static var apiBaseURL: URL {
        if let override = UserDefaults.standard.string(forKey: "apiBaseURL"),
           let url = URL(string: override) {
            return url
        }
        #if DEBUG
        return URL(string: "http://127.0.0.1:5173")!
        #else
        return URL(string: "https://agentic-inbox.example.workers.dev")!
        #endif
    }

    /// Must match APPLE_CLIENT_ID / Xcode bundle identifier.
    static let bundleID = "com.cloudflare.AgenticInbox"

    static let agentPathPrefix = "/agents/email-agent"
}
