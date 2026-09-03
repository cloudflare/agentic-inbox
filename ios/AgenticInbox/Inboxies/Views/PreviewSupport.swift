import SwiftUI

/// Shared Canvas fixtures. `#Preview` is not invoked in device or App Store runs.
enum PreviewSupport {
    @MainActor
    static func appModel() -> AppModel {
        let app = AppModel()
        app.persistsPreferences = false
        app.mailboxes = [
            Mailbox(
                id: "mb-preview",
                email: "you@inboxies.email",
                name: "Alex Rivera",
                settings: MailboxSettings(
                    fromName: "Alex Rivera",
                    agentSystemPrompt: nil,
                    signature: SignatureSettings(enabled: true, text: "Alex")
                )
            ),
        ]
        app.selectedMailboxId = "mb-preview"
        app.folders = [
            Folder(id: "inbox", name: "Inbox", unreadCount: 3),
            Folder(id: "sent", name: "Sent", unreadCount: 0),
            Folder(id: "archive", name: "Archive", unreadCount: 0),
        ]
        app.emails = emails
        app.isLoading = false
        app.isMailboxLoading = false
        return app
    }

    @MainActor
    static func authStore() -> AuthStore {
        let store = AuthStore()
        store.persistsSession = false
        store.token = "preview-token"
        store.userEmail = "you@inboxies.email"
        return store
    }

    static let emails: [Email] = [
        Email(
            id: "preview-1",
            folderId: "inbox",
            subject: "Quarterly planning notes",
            sender: "jordan@example.com",
            senderName: "Jordan Hale",
            recipient: "you@inboxies.email",
            date: "2026-09-03T14:30:00.000Z",
            read: false,
            starred: false,
            snippet: "Can we move Thursday's sync to the morning instead?",
            threadCount: 3
        ),
        Email(
            id: "preview-2",
            folderId: "inbox",
            subject: "Re: Invoice for March",
            sender: "alex@example.com",
            senderName: "Alex Rivera",
            recipient: "you@inboxies.email",
            date: "2026-09-02T09:12:00.000Z",
            read: true,
            starred: true,
            snippet: "Attached is the updated PDF for last month's work.",
            hasAttachment: true
        ),
        Email(
            id: "preview-3",
            folderId: "inbox",
            subject: "Design review tomorrow",
            sender: "sam@example.com",
            senderName: "Sam Chen",
            recipient: "you@inboxies.email",
            date: "2026-08-28T18:04:00.000Z",
            read: false,
            starred: false,
            snippet: "Posting the latest frames in the shared folder now.",
            hasDraft: true
        ),
        Email(
            id: "preview-4",
            folderId: "inbox",
            subject: "Flight confirmation",
            sender: "taylor@example.com",
            senderName: "Taylor Brooks",
            recipient: "you@inboxies.email",
            date: "2026-03-15T11:00:00.000Z",
            read: true,
            starred: false,
            snippet: "Your itinerary for next week's trip is ready to view."
        ),
    ]
}

/// Holds preview `AppModel` / `AuthStore` so Canvas interactions don't rebuild them.
struct PreviewHost<Content: View>: View {
    @State private var app = PreviewSupport.appModel()
    @State private var auth = PreviewSupport.authStore()
    var content: () -> Content

    var body: some View {
        content()
            .environment(app)
            .environment(auth)
            .preferredColorScheme(.light)
    }
}
