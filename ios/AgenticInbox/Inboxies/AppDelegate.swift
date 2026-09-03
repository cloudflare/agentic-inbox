import UIKit
import UserNotifications

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    // MARK: - APNs Registration Callbacks

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Task { @MainActor in
            PushNotificationManager.shared.handleTokenReceived(data: deviceToken)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        Task { @MainActor in
            PushNotificationManager.shared.handleRegistrationError(error)
        }
    }

    // MARK: - Background Push Notification & Content-Available Wake-up

    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        // Extract mailboxId and folder from push payload
        let mailboxId = userInfo["mailboxId"] as? String
        let folderId = userInfo["folderId"] as? String ?? "inbox"

        guard let mailboxId, !mailboxId.isEmpty else {
            completionHandler(.noData)
            return
        }

        Task {
            do {
                let emails = try await MailboxSyncService.shared.syncFolder(
                    mailboxId: mailboxId,
                    folderId: folderId
                )
                completionHandler(emails.isEmpty ? .noData : .newData)
            } catch {
                completionHandler(.failed)
            }
        }
    }

    // MARK: - Foreground Presentation

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // Present banner, sound, and badge even when app is foregrounded
        completionHandler([.banner, .sound, .badge])
    }

    // MARK: - Notification Tap Handling

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        completionHandler()
    }
}
