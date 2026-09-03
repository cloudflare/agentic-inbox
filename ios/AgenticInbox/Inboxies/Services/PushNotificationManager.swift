import Foundation
import UIKit
import UserNotifications
import Observation

/// Coordinates Apple Push Notification registration, device token persistence,
/// and synchronization with the Cloudflare backend for the active mailbox.
@Observable
@MainActor
final class PushNotificationManager {
    static let shared = PushNotificationManager()

    private let tokenStorageKey = "apns_device_token_hex"
    private(set) var deviceToken: String?
    private(set) var isRegistered = false
    private var activeMailboxId: String?

    init() {
        self.deviceToken = UserDefaults.standard.string(forKey: tokenStorageKey)
    }

    func requestPermissionAndRegister(mailboxId: String) {
        self.activeMailboxId = mailboxId

        // If we already have a token, sync it immediately
        if let token = deviceToken {
            syncTokenWithServer(mailboxId: mailboxId, token: token)
        }

        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
            Task { @MainActor in
                print("[PushManager] Notification permission status: \(granted), error: \(String(describing: error))")
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    func handleTokenReceived(data: Data) {
        let hexString = data.map { String(format: "%02.2hhx", $0) }.joined()
        print("[PushManager] Received APNs device token: \(hexString)")
        self.deviceToken = hexString
        self.isRegistered = true
        UserDefaults.standard.set(hexString, forKey: tokenStorageKey)

        if let mailboxId = activeMailboxId {
            syncTokenWithServer(mailboxId: mailboxId, token: hexString)
        }
    }

    func handleRegistrationError(_ error: Error) {
        print("[PushManager] Failed to register for remote notifications: \(error.localizedDescription)")
        self.isRegistered = false
    }

    func syncTokenWithServer(mailboxId: String, token: String) {
        Task {
            do {
                print("[PushManager] Registering device token with server for mailbox \(mailboxId)...")
                try await APIClient.shared.registerDeviceToken(mailboxId: mailboxId, token: token)
                print("[PushManager] ✓ Device token successfully registered with Cloudflare Worker!")
            } catch {
                print("[PushManager] ✗ Failed to register device token with server: \(error)")
            }
        }
    }

    func unregisterToken(mailboxId: String) {
        guard let token = deviceToken else { return }
        Task {
            try? await APIClient.shared.unregisterDeviceToken(mailboxId: mailboxId, token: token)
        }
    }
}
