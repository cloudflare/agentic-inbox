import Security
import Foundation
import Observation

/// Session store ≈ React context / Capacitor Preferences for the auth token.
@Observable
@MainActor
final class AuthStore {
    private let tokenKey = "mobileSessionToken"
    private let emailKey = "mobileUserEmail"

    var token: String?
    var userEmail: String?
    var isAuthenticated: Bool { token != nil && !(token?.isEmpty ?? true) }
    var isBusy = false
    var errorMessage: String?
    /// Preview hosts keep session in memory so Canvas cannot wipe the real Keychain.
    var persistsSession = true

    init() {
        token = KeychainStore.read(tokenKey)
        userEmail = UserDefaults.standard.string(forKey: emailKey)
    }

    func signInWithApple(identityToken: String, email: String?) async {
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        do {
            let response: AuthResponse = try await APIClient.shared.request(
                path: "/api/v1/auth/apple",
                method: "POST",
                body: ["identityToken": identityToken],
                authed: false
            )
            persist(token: response.token, email: response.user.email ?? email)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Local-dev shortcut when Apple Sign In isn't configured in the simulator.
    func signInDev(email: String = "dev@example.com") async {
        guard AppConfig.isLocalDevelopmentAPI else {
            errorMessage = "Dev login only works against a local Worker (http://127.0.0.1:5173). Use Sign in with Apple for inboxies.email."
            return
        }
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        do {
            let response: AuthResponse = try await APIClient.shared.request(
                path: "/api/v1/auth/dev",
                method: "POST",
                body: ["email": email],
                authed: false
            )
            persist(token: response.token, email: response.user.email ?? email)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func signOut() {
        token = nil
        userEmail = nil
        guard persistsSession else { return }
        KeychainStore.delete(tokenKey)
        UserDefaults.standard.removeObject(forKey: emailKey)
    }

    private func persist(token: String, email: String?) {
        self.token = token
        self.userEmail = email
        guard persistsSession else { return }
        KeychainStore.write(tokenKey, value: token)
        if let email {
            UserDefaults.standard.set(email, forKey: emailKey)
        }
    }
}

enum KeychainStore {
    static func write(_ key: String, value: String) {
        let data = Data(value.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecValueData as String: data,
        ]
        SecItemDelete(query as CFDictionary)
        SecItemAdd(query as CFDictionary, nil)
    }

    static func read(_ key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete(_ key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
