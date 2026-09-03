// Inboxies — native iOS MVP client for the Cloudflare Agentic Inbox backend.
// Mentally map: SwiftUI View ≈ React component, @Observable ≈ Zustand/context, async/await ≈ fetch.

import SwiftUI

@main
struct InboxiesApp: App {
    @State private var authStore = AuthStore()
    @State private var appModel = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(authStore)
                .environment(appModel)
                .preferredColorScheme(.light)
        }
    }
}
