import Foundation

enum APIError: LocalizedError {
    case invalidURL
    case http(Int, String)
    case decoding(Error)
    case notJSON(String)
    case cloudflareAccess
    case transport(Error)

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "Invalid API URL"
        case .http(_, let body) where !body.isEmpty:
            return body
        case .http(let code, _):
            return "HTTP \(code)"
        case .decoding(let err): return "Decode error: \(err.localizedDescription)"
        case .notJSON(let preview):
            return "API returned HTML instead of JSON. \(preview)"
        case .cloudflareAccess:
            return "Cloudflare Access is blocking the API. Add a Bypass policy for inboxies.email/api/* (and /agents/* for chat) in Zero Trust, or the Worker never sees Sign in with Apple."
        case .transport(let err): return err.localizedDescription
        }
    }
}

/// Thin fetch wrapper — think `app/services/api.ts`.
final class APIClient: @unchecked Sendable {
    static let shared = APIClient()

    private let session: URLSession
    private let decoder: JSONDecoder
    private let redirectGuard = SameHostRedirectGuard()

    /// Injected by AuthStore / AppModel when the session token changes.
    var authTokenProvider: @Sendable () -> String? = { nil }

    private init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.httpShouldSetCookies = false
        session = URLSession(configuration: config, delegate: redirectGuard, delegateQueue: nil)
        decoder = JSONDecoder()
    }

    func request<T: Decodable>(
        path: String,
        method: String = "GET",
        query: [String: String] = [:],
        body: [String: Any]? = nil,
        authed: Bool = true
    ) async throws -> T {
        let (data, http) = try await perform(
            path: path,
            method: method,
            query: query,
            body: body,
            authed: authed
        )
        if http.statusCode == 204 {
            if T.self == EmptyResponse.self {
                return EmptyResponse() as! T
            }
        }
        if isCloudflareAccessChallenge(http, data: data) {
            throw APIError.cloudflareAccess
        }
        let contentType = http.value(forHTTPHeaderField: "Content-Type")?.lowercased() ?? ""
        if !contentType.contains("json") {
            let preview = String(data: data, encoding: .utf8).map { String($0.prefix(160)) } ?? ""
            throw APIError.notJSON(preview)
        }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding(error)
        }
    }

    func requestData(
        path: String,
        method: String = "GET",
        query: [String: String] = [:],
        authed: Bool = true
    ) async throws -> (Data, HTTPURLResponse) {
        try await perform(path: path, method: method, query: query, body: nil, authed: authed)
    }

    private func perform(
        path: String,
        method: String,
        query: [String: String],
        body: [String: Any]?,
        authed: Bool
    ) async throws -> (Data, HTTPURLResponse) {
        guard var components = URLComponents(url: AppConfig.apiBaseURL, resolvingAgainstBaseURL: false),
              components.host != nil else {
            throw APIError.invalidURL
        }
        let cleanPath = path.hasPrefix("/") ? path : "/\(path)"
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
            if isCloudflareAccessChallenge(http, data: data) {
                throw APIError.cloudflareAccess
            }
            guard (200..<300).contains(http.statusCode) else {
                throw APIError.http(http.statusCode, httpErrorMessage(from: data))
            }
            return (data, http)
        } catch let error as APIError {
            throw error
        } catch {
            throw APIError.transport(error)
        }
    }

    func listMailboxes() async throws -> [Mailbox] {
        try await request(path: "/api/v1/mailboxes")
    }

    func getMailbox(mailboxId: String) async throws -> Mailbox {
        try await request(path: "/api/v1/mailboxes/\(mailboxId.urlPathEncoded)")
    }

    func updateMailbox(mailboxId: String, settings: MailboxSettings) async throws -> Mailbox {
        let settingsData = try JSONEncoder().encode(settings)
        let settingsObject = try JSONSerialization.jsonObject(with: settingsData) as? [String: Any] ?? [:]
        return try await request(
            path: "/api/v1/mailboxes/\(mailboxId.urlPathEncoded)",
            method: "PUT",
            body: ["settings": settingsObject]
        )
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
        try await updateEmail(mailboxId: mailboxId, id: id, read: true)
    }

    func updateEmail(
        mailboxId: String,
        id: String,
        read: Bool? = nil,
        starred: Bool? = nil
    ) async throws -> Email {
        var body: [String: Any] = [:]
        if let read { body["read"] = read }
        if let starred { body["starred"] = starred }
        return try await request(
            path: "/api/v1/mailboxes/\(mailboxId.urlPathEncoded)/emails/\(id.urlPathEncoded)",
            method: "PUT",
            body: body
        )
    }

    func moveEmail(mailboxId: String, id: String, folderId: String) async throws {
        let _: EmptyResponse = try await request(
            path: "/api/v1/mailboxes/\(mailboxId.urlPathEncoded)/emails/\(id.urlPathEncoded)/move",
            method: "POST",
            body: ["folderId": folderId]
        )
    }

    func deleteEmail(mailboxId: String, id: String) async throws {
        let _: EmptyResponse = try await request(
            path: "/api/v1/mailboxes/\(mailboxId.urlPathEncoded)/emails/\(id.urlPathEncoded)",
            method: "DELETE"
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

    func sendEmail(mailboxId: String, payload: [String: Any]) async throws -> SendEmailResponse {
        try await request(
            path: "/api/v1/mailboxes/\(mailboxId.urlPathEncoded)/emails",
            method: "POST",
            body: payload
        )
    }

    func replyToEmail(mailboxId: String, emailId: String, payload: [String: Any]) async throws -> SendEmailResponse {
        try await request(
            path: "/api/v1/mailboxes/\(mailboxId.urlPathEncoded)/emails/\(emailId.urlPathEncoded)/reply",
            method: "POST",
            body: payload
        )
    }

    func forwardEmail(mailboxId: String, emailId: String, payload: [String: Any]) async throws -> SendEmailResponse {
        try await request(
            path: "/api/v1/mailboxes/\(mailboxId.urlPathEncoded)/emails/\(emailId.urlPathEncoded)/forward",
            method: "POST",
            body: payload
        )
    }

    func saveDraft(mailboxId: String, draft: [String: Any]) async throws -> DraftSaveResponse {
        try await request(
            path: "/api/v1/mailboxes/\(mailboxId.urlPathEncoded)/drafts",
            method: "POST",
            body: draft
        )
    }

    func getAttachment(mailboxId: String, emailId: String, attachmentId: String) async throws -> Data {
        let (data, _) = try await requestData(
            path: "/api/v1/mailboxes/\(mailboxId.urlPathEncoded)/emails/\(emailId.urlPathEncoded)/attachments/\(attachmentId.urlPathEncoded)"
        )
        return data
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

    func registerDeviceToken(mailboxId: String, token: String) async throws {
        let _: EmptyResponse = try await request(
            path: "/api/v1/mailboxes/\(mailboxId.urlPathEncoded)/device-token",
            method: "POST",
            body: ["token": token, "platform": "ios"]
        )
    }

    func unregisterDeviceToken(mailboxId: String, token: String) async throws {
        let _: EmptyResponse = try await request(
            path: "/api/v1/mailboxes/\(mailboxId.urlPathEncoded)/device-token/\(token.urlPathEncoded)",
            method: "DELETE"
        )
    }
}

struct EmptyResponse: Decodable {}

/// Do not follow Cloudflare Access's 302 to the login HTML page — that body is
/// not JSON and surfaces as a confusing decode error.
private final class SameHostRedirectGuard: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest
    ) async -> URLRequest? {
        guard let fromHost = task.originalRequest?.url?.host,
              let toHost = request.url?.host,
              fromHost.caseInsensitiveCompare(toHost) == .orderedSame else {
            return nil
        }
        return request
    }
}

private func httpErrorMessage(from data: Data) -> String {
    if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       let error = obj["error"] as? String, !error.isEmpty {
        return error
    }
    return String(data: data, encoding: .utf8) ?? ""
}

private func isCloudflareAccessChallenge(_ http: HTTPURLResponse, data: Data) -> Bool {
    if let auth = http.value(forHTTPHeaderField: "WWW-Authenticate")?.lowercased(),
       auth.contains("cloudflare-access") {
        return true
    }
    if let location = http.value(forHTTPHeaderField: "Location")?.lowercased(),
       location.contains("cloudflareaccess.com") || location.contains("cdn-cgi/access/login") {
        return true
    }
    let preview = String(data: data, encoding: .utf8)?.prefix(400).lowercased() ?? ""
    return preview.contains("cloudflareaccess.com") || preview.contains("cloudflare access")
}

extension String {
    var urlPathEncoded: String {
        addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? self
    }
}
