import Foundation

/// Minimal Cloudflare Agents chat WebSocket client.
/// Protocol mirrors `@cloudflare/ai-chat` / `useAgentChat` (cf_agent_* message types).
@MainActor
final class AgentChatClient: NSObject, ObservableObject {
    @Published var messages: [ChatMessage] = []
    @Published var isConnected = false
    @Published var isStreaming = false
    @Published var statusText: String?

    private var webSocket: URLSessionWebSocketTask?
    private var session: URLSession?
    private var authToken: String?
    private var mailboxId: String?
    private var conversationId: String?
    private var streamingAssistantId: String?

    func connect(mailboxId: String, conversationId: String, authToken: String?) {
        disconnect()
        self.mailboxId = mailboxId
        self.conversationId = conversationId
        self.authToken = authToken

        let agentName = "\(mailboxId)::\(conversationId)"
            .addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? ""
        let base = AppConfig.apiBaseURL
        guard var components = URLComponents(url: base, resolvingAgainstBaseURL: false),
              components.host != nil else {
            statusText = "Invalid API URL"
            return
        }
        components.scheme = base.scheme == "https" ? "wss" : "ws"
        components.path = "\(AppConfig.agentPathPrefix)/\(agentName)"
        guard let url = components.url else { return }

        let config = URLSessionConfiguration.default
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        var request = URLRequest(url: url)
        if let authToken {
            request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        }
        let task = session!.webSocketTask(with: request)
        webSocket = task
        task.resume()
        isConnected = true
        listen()
    }

    func disconnect() {
        webSocket?.cancel(with: .goingAway, reason: nil)
        webSocket = nil
        session?.invalidateAndCancel()
        session = nil
        isConnected = false
        isStreaming = false
    }

    func clearHistory() {
        sendJSON(["type": "cf_agent_chat_clear"])
        messages = []
    }

    func sendUserMessage(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        let userId = UUID().uuidString
        let userMessage: [String: Any] = [
            "id": userId,
            "role": "user",
            "parts": [["type": "text", "text": trimmed]],
        ]

        // Optimistic UI
        messages.append(ChatMessage(id: userId, role: "user", text: trimmed))

        // Include full history the way useAgentChat does
        let history: [[String: Any]] = messages.map { msg in
            [
                "id": msg.id,
                "role": msg.role,
                "parts": [["type": "text", "text": msg.text]],
            ]
        }
        // Ensure the new message is present (already appended)
        _ = history

        let bodyObject: [String: Any] = ["messages": history]
        let bodyData = try! JSONSerialization.data(withJSONObject: bodyObject)
        let bodyString = String(data: bodyData, encoding: .utf8) ?? "{}"

        let requestId = UUID().uuidString
        sendJSON([
            "type": "cf_agent_use_chat_request",
            "id": requestId,
            "init": [
                "method": "POST",
                "body": bodyString,
            ],
        ])
        isStreaming = true
        statusText = "Thinking…"
        streamingAssistantId = nil
    }

    private func sendJSON(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object),
              let text = String(data: data, encoding: .utf8) else { return }
        webSocket?.send(.string(text)) { error in
            if let error {
                Task { @MainActor in
                    self.statusText = error.localizedDescription
                }
            }
        }
    }

    private func listen() {
        webSocket?.receive { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                switch result {
                case .failure(let error):
                    self.isConnected = false
                    self.statusText = error.localizedDescription
                case .success(let message):
                    self.handle(message)
                    self.listen()
                }
            }
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        guard case .string(let text) = message,
              let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else { return }

        switch type {
        case "cf_agent_chat_messages":
            if let arr = json["messages"] as? [[String: Any]] {
                messages = arr.compactMap(Self.parseMessage)
            }
        case "cf_agent_chat_clear":
            messages = []
        case "cf_agent_use_chat_response":
            let chunk = json["body"] as? String ?? ""
            let done = json["done"] as? Bool ?? false
            appendStreamChunk(chunk)
            if done {
                isStreaming = false
                statusText = nil
                streamingAssistantId = nil
            }
        default:
            break
        }
    }

    private func appendStreamChunk(_ raw: String) {
        // Stream body is often a UI message stream line (JSON). Extract text deltas when possible.
        let text = Self.extractVisibleText(from: raw)
        guard !text.isEmpty else { return }

        if let id = streamingAssistantId,
           let idx = messages.firstIndex(where: { $0.id == id }) {
            messages[idx].text += text
        } else {
            let id = UUID().uuidString
            streamingAssistantId = id
            messages.append(ChatMessage(id: id, role: "assistant", text: text))
        }
    }

    private static func parseMessage(_ dict: [String: Any]) -> ChatMessage? {
        guard let id = dict["id"] as? String,
              let role = dict["role"] as? String else { return nil }
        var text = ""
        if let parts = dict["parts"] as? [[String: Any]] {
            for part in parts {
                if let t = part["text"] as? String, part["type"] as? String == "text" {
                    text += t
                }
            }
        }
        if text.isEmpty, let content = dict["content"] as? String {
            text = content
        }
        return ChatMessage(id: id, role: role, text: text)
    }

    private static func extractVisibleText(from body: String) -> String {
        let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "" }
        // SSE-ish JSON lines from AI SDK stream
        if trimmed.hasPrefix("{"),
           let data = trimmed.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let t = obj["text"] as? String { return t }
            if let t = obj["delta"] as? String { return t }
            if let type = obj["type"] as? String, type.contains("text"),
               let t = obj["textDelta"] as? String { return t }
            // Ignore tool/meta chunks
            return ""
        }
        // Plain text fallback
        if trimmed == "0" || trimmed == "[DONE]" { return "" }
        return trimmed
    }
}

extension AgentChatClient: URLSessionWebSocketDelegate {
    nonisolated func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        Task { @MainActor in
            self.isConnected = true
        }
    }

    nonisolated func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        Task { @MainActor in
            self.isConnected = false
        }
    }
}
