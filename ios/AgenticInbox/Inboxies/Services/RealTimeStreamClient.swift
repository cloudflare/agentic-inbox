import Foundation

/// Real-time event streaming and adaptive polling client for Inboxies.
/// Maintains a persistent Server-Sent Events (SSE) stream or low-latency adaptive polling
/// to deliver incoming emails to the device the exact instant they arrive on the server.
final class RealTimeStreamClient: @unchecked Sendable {
    static let shared = RealTimeStreamClient()

    private var activeTask: Task<Void, Never>?
    private var pollingTask: Task<Void, Never>?
    private var currentMailboxId: String?

    var onNewEmailReceived: (@Sendable (Email) -> Void)?
    var onSyncRequested: (@Sendable () -> Void)?

    func start(mailboxId: String) {
        guard currentMailboxId != mailboxId else { return }
        stop()
        currentMailboxId = mailboxId

        // 1. Start persistent SSE stream
        activeTask = Task { [weak self, mailboxId] in
            await self?.runEventStream(mailboxId: mailboxId)
        }

        // 2. Adaptive safety-net polling every 20 seconds while app is active
        pollingTask = Task { [weak self, mailboxId] in
            await self?.runAdaptivePolling(mailboxId: mailboxId)
        }
    }

    func stop() {
        activeTask?.cancel()
        activeTask = nil
        pollingTask?.cancel()
        pollingTask = nil
        currentMailboxId = nil
    }

    // MARK: - Server-Sent Events (SSE) Stream

    private func runEventStream(mailboxId: String) async {
        var backoffSeconds: UInt64 = 2

        while !Task.isCancelled {
            do {
                guard var components = URLComponents(url: AppConfig.apiBaseURL, resolvingAgainstBaseURL: false) else { return }
                let cleanPath = "/api/v1/mailboxes/\(mailboxId.urlPathEncoded)/events"
                let basePath = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                components.path = basePath.isEmpty ? cleanPath : "/\(basePath)\(cleanPath)"
                guard let url = components.url else { return }

                var request = URLRequest(url: url)
                request.timeoutInterval = 120
                request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                if let token = APIClient.shared.authTokenProvider() {
                    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                }

                let (asyncBytes, response) = try await URLSession.shared.bytes(for: request)
                guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                    try? await Task.sleep(nanoseconds: backoffSeconds * 1_000_000_000)
                    backoffSeconds = min(backoffSeconds * 2, 30)
                    continue
                }

                // Reset backoff on successful connection
                backoffSeconds = 2

                var eventName = "message"
                for try await line in asyncBytes.lines {
                    guard !Task.isCancelled else { break }

                    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                    if trimmed.isEmpty { continue }

                    if trimmed.hasPrefix("event:") {
                        eventName = String(trimmed.dropFirst(6)).trimmingCharacters(in: .whitespaces)
                    } else if trimmed.hasPrefix("data:") {
                        let dataStr = String(trimmed.dropFirst(5)).trimmingCharacters(in: .whitespaces)
                        handleServerEvent(event: eventName, data: dataStr, mailboxId: mailboxId)
                        eventName = "message"
                    }
                }
            } catch {
                if Task.isCancelled { break }
                try? await Task.sleep(nanoseconds: backoffSeconds * 1_000_000_000)
                backoffSeconds = min(backoffSeconds * 2, 30)
            }
        }
    }

    private func handleServerEvent(event: String, data: String, mailboxId: String) {
        guard let jsonData = data.data(using: .utf8) else { return }

        if event == "new_email" || event == "message" {
            if let email = try? JSONDecoder().decode(Email.self, from: jsonData) {
                DatabaseService.shared.upsertEmails(mailboxId: mailboxId, emails: [email], defaultFolder: email.folderId ?? "inbox")
                onNewEmailReceived?(email)
                return
            }
        }

        // Generic update notification: trigger silent re-sync
        onSyncRequested?()
    }

    // MARK: - Adaptive Foreground Polling Fallback

    private func runAdaptivePolling(mailboxId: String) async {
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 20_000_000_000) // 20s
            guard !Task.isCancelled else { break }
            onSyncRequested?()
        }
    }
}
