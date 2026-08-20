import Foundation

enum APIError: LocalizedError {
    case invalidURL
    case http(Int, String)
    case decoding(Error)
    case transport(Error)

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "Invalid API URL"
        case .http(let code, let body): return "HTTP \(code): \(body)"
        case .decoding(let err): return "Decode error: \(err.localizedDescription)"
        case .transport(let err): return err.localizedDescription
        }
    }
}

/// Thin fetch wrapper — think `app/services/api.ts`.
final class APIClient: @unchecked Sendable {
    static let shared = APIClient()

    private let session: URLSession
    private let decoder: JSONDecoder

    /// Injected by AuthStore / AppModel when the session token changes.
    var authTokenProvider: @Sendable () -> String? = { nil }

    private init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        session = URLSession(configuration: config)
        decoder = JSONDecoder()
    }

    func request<T: Decodable>(
        path: String,
        method: String = "GET",
        query: [String: String] = [:],
        body: [String: Any]? = nil,
        authed: Bool = true
    ) async throws -> T {
        guard var components = URLComponents(url: AppConfig.apiBaseURL, resolvingAgainstBaseURL: false) else {
            throw APIError.invalidURL
        }
        let cleanPath = path.hasPrefix("/") ? path : "/\(path)"
        // Preserve existing base path if any (usually empty for Worker roots).
        let basePath = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        components.path = basePath.isEmpty ? cleanPath : "/\(basePath)\(cleanPath)"
        if !query.isEmpty {
            components.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        guard let url = components.url else { throw APIError.invalidURL }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if authed, let token = authTokenProvider() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }

        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw APIError.http(-1, "No HTTP response")
            }
            guard (200..<300).contains(http.statusCode) else {
                let text = String(data: data, encoding: .utf8) ?? ""
                throw APIError.http(http.statusCode, text)
            }
            if http.statusCode == 204 {
                if T.self == EmptyResponse.self {
                    return EmptyResponse() as! T
                }
            }
            do {
                return try decoder.decode(T.self, from: data)
            } catch {
                throw APIError.decoding(error)
            }
        } catch let error as APIError {
            throw error
        } catch {
            throw APIError.transport(error)
        }
    }

    func listMailboxes() async throws -> [Mailbox] {
        try await request(path: "/api/v1/mailboxes")
    }

    func listFolders(mailboxId: String) async throws -> [Folder] {
        try await request(path: "/api/v1/mailboxes/\(mailboxId.urlPathEncoded)/folders")
    }

    func listEmails(mailboxId: String, folder: String, page: Int = 1) async throws -> EmailListResponse {
        try await request(
            path: "/api/v1/mailboxes/\(mailboxId.urlPathEncoded)/emails",
            query: [
                "folder": folder,
                "threaded": "true",
                "page": String(page),
                "limit": "25",
            ]
        )
    }

    func getEmail(mailboxId: String, id: String) async throws -> Email {
        try await request(path: "/api/v1/mailboxes/\(mailboxId.urlPathEncoded)/emails/\(id.urlPathEncoded)")
    }

    func getThread(mailboxId: String, threadId: String) async throws -> [Email] {
        try await request(path: "/api/v1/mailboxes/\(mailboxId.urlPathEncoded)/threads/\(threadId.urlPathEncoded)")
    }

    func markRead(mailboxId: String, id: String) async throws -> Email {
        try await request(
            path: "/api/v1/mailboxes/\(mailboxId.urlPathEncoded)/emails/\(id.urlPathEncoded)",
            method: "PUT",
            body: ["read": true]
        )
    }

    func searchEmails(mailboxId: String, query: String, page: Int = 1) async throws -> EmailListResponse {
        try await request(
            path: "/api/v1/mailboxes/\(mailboxId.urlPathEncoded)/search",
            query: [
                "query": query,
                "page": String(page),
                "limit": "25",
            ]
        )
    }

    func listConversations(mailboxId: String) async throws -> [AgentConversation] {
        try await request(path: "/api/v1/mailboxes/\(mailboxId.urlPathEncoded)/agent/conversations")
    }

    func createConversation(mailboxId: String, title: String? = nil) async throws -> AgentConversation {
        var body: [String: Any] = [:]
        if let title { body["title"] = title }
        return try await request(
            path: "/api/v1/mailboxes/\(mailboxId.urlPathEncoded)/agent/conversations",
            method: "POST",
            body: body
        )
    }

    func deleteConversation(mailboxId: String, id: String) async throws {
        let _: EmptyResponse = try await request(
            path: "/api/v1/mailboxes/\(mailboxId.urlPathEncoded)/agent/conversations/\(id.urlPathEncoded)",
            method: "DELETE"
        )
    }
}

struct EmptyResponse: Decodable {}

extension String {
    var urlPathEncoded: String {
        addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? self
    }
}
