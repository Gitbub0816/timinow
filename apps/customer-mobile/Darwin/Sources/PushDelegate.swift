import Foundation
import OSLog
import TimiNowCore
import UIKit
import UserNotifications

// Plain Xcode-target file, the same category as CarPlayBridge.swift and for
// the same reason: `UIApplicationDelegateAdaptor` needs a concrete
// `UIApplicationDelegate` type, and `UIApplicationDelegate`/`UIKit` do not
// exist for Skip's Android build. Neither TimiNowUI nor TimiNowApp may
// import UIKit directly, so the delegate lives here and reaches the shared
// app state through TimiNowCore's public surface only — see
// `AppStore.registerPushToken`/`AppStore.openSearchFromPush`.
//
// Registration itself — requesting authorization and calling
// `UIApplication.shared.registerForRemoteNotifications()` — happens in
// TimiNowUI's `PlatformPermissions` (the Settings "Offer notifications"
// toggle, plus a silent re-registration on every launch for a permission
// already granted). This delegate only receives what the OS hands back once
// that call has been made: the device token, or a tap on a notification that
// arrived.
private let logger = Logger(subsystem: "solutions.clearkey.timinow", category: "push")

final class TimiPushDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // Must be set before any push can be shown while foregrounded, or
        // tapped — both callbacks below are UNUserNotificationCenterDelegate
        // methods, not UIApplicationDelegate ones.
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    /// APNs handed back a token. Hex-encode it — src/push.js expects the same
    /// lowercase-hex form `xcrun` and every APNs sample show, not the raw
    /// `Data`'s Swift description — and hand it to the Worker.
    ///
    /// Called every time registration succeeds, not only the first: a token
    /// can rotate (reinstall, restore from backup, APNs simply reissuing one),
    /// and `AppStore.registerPushToken`/`POST /api/push/register-device` are
    /// both idempotent upserts, so re-sending an unchanged token costs one
    /// cheap request and re-sending a changed one is the only way the Worker
    /// ever learns of the change.
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02.2hhx", $0) }.joined()
        Task { @MainActor in
            await AppStore.shared.registerPushToken(token)
        }
    }

    /// No network, Simulator with no push entitlement provisioned, or the
    /// entitlement/profile mismatched. Nothing a customer can act on and
    /// nothing that should block anything else in the app — logged locally
    /// only, matching src/push.js's own "never throws" posture on the server
    /// side of this same feature.
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        logger.warning("APNs registration failed: \(error.localizedDescription, privacy: .public)")
    }

    /// A push arriving while the app is in the foreground. Shown as an
    /// ordinary banner rather than suppressed — the default UNUserNotification
    /// behavior with no delegate at all is to show nothing while foregrounded,
    /// which for this feature would mean the one moment a customer is looking
    /// at the app is the one moment "a clinic answered" fails to visibly
    /// appear.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound, .badge])
    }

    /// A tap on the notification, backgrounded or from a cold start. Deep-links
    /// straight back into the search the push was about — see `searchId` in
    /// `sendPushForFirstOffer` (src/push.js), the same id the web SMS link
    /// (src/search-links.js) carries for the browser equivalent of this
    /// moment.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let searchId = response.notification.request.content.userInfo["searchId"] as? String
        if let searchId, !searchId.isEmpty {
            Task { @MainActor in
                await AppStore.shared.openSearchFromPush(searchId: searchId)
            }
        }
        completionHandler()
    }
}
