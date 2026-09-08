import Foundation

#if os(iOS) && !SKIP
import CoreLocation
import UIKit
import UserNotifications

@MainActor enum PlatformPermissions {
    /// Prompts for permission and, once granted, asks iOS for the device
    /// token that makes a real push possible.
    ///
    /// `registerForRemoteNotifications()` alone does nothing without this —
    /// requesting a token before authorization is granted either never
    /// completes or hands back a token the OS will not actually deliver
    /// anything to. The token itself arrives later, asynchronously, in
    /// `PushDelegate.application(_:didRegisterForRemoteNotificationsWithDeviceToken:)`
    /// (Darwin/Sources/PushDelegate.swift) — a plain Xcode-target file, since
    /// `UIApplicationDelegateAdaptor` needs a concrete `UIApplicationDelegate`
    /// that Skip's Android build never compiles.
    static func requestNotifications() async -> Bool {
        let granted: Bool
        do { granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) }
        catch { granted = false }
        if granted { UIApplication.shared.registerForRemoteNotifications() }
        return granted
    }

    /// Re-asks for a device token with no prompt, for a launch where
    /// permission was already granted in an earlier session. The Settings
    /// toggle this file backs (`store.notificationsEnabled`) is not
    /// persisted — it always starts this launch reading `false` — but a
    /// previous grant survives at the OS level, and without this an app that
    /// was never relaunched with the toggle flipped again would silently stop
    /// registering a token (and therefore stop receiving first-offer pushes)
    /// after every cold start. Silent by design: `requestAuthorization` does
    /// not re-prompt once a person has already answered, so this differs from
    /// `requestNotifications()` only in not reading (or trusting) its return
    /// value as a fresh answer.
    static func reregisterIfAlreadyAuthorized() async -> Bool {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        guard settings.authorizationStatus == .authorized else { return false }
        UIApplication.shared.registerForRemoteNotifications()
        return true
    }

    static func notify(title: String, body: String) async {
        let content = UNMutableNotificationContent(); content.title = title; content.body = body; content.sound = .default
        try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }

    static func requestLocation() async -> Bool { await LocationPermissionAgent.shared.request() }
    static func currentLocation() async -> (Double, Double)? { await LocationPermissionAgent.shared.currentLocation() }
}

@MainActor private final class LocationPermissionAgent: NSObject, CLLocationManagerDelegate {
    static let shared = LocationPermissionAgent()
    private let manager = CLLocationManager()
    private var continuation: CheckedContinuation<Bool, Never>?
    private var locationContinuation: CheckedContinuation<(Double, Double)?, Never>?

    override private init() { super.init(); manager.delegate = self }

    func request() async -> Bool {
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse: return true
        case .denied, .restricted: return false
        case .notDetermined:
            return await withCheckedContinuation { value in continuation = value; manager.requestWhenInUseAuthorization() }
        @unknown default: return false
        }
    }

    func currentLocation() async -> (Double, Double)? {
        guard manager.authorizationStatus == .authorizedWhenInUse || manager.authorizationStatus == .authorizedAlways else { return nil }
        return await withCheckedContinuation { value in locationContinuation = value; manager.requestLocation() }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard manager.authorizationStatus != .notDetermined, let continuation else { return }
        self.continuation = nil
        continuation.resume(returning: manager.authorizationStatus == .authorizedWhenInUse || manager.authorizationStatus == .authorizedAlways)
    }


    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let continuation = locationContinuation else { return }
        locationContinuation = nil
        let coordinate = locations.last?.coordinate
        continuation.resume(returning: coordinate.map { ($0.latitude, $0.longitude) })
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        locationContinuation?.resume(returning: nil); locationContinuation = nil
    }
}
#else
@MainActor enum PlatformPermissions {
    static func requestNotifications() async -> Bool { true }
    // No APNs on Android/Skip and no macOS host build path for this file's
    // `#if os(iOS) && !SKIP` counterpart — nothing to re-register here.
    static func reregisterIfAlreadyAuthorized() async -> Bool { false }
    static func notify(title: String, body: String) async { }
    static func requestLocation() async -> Bool { true }
    static func currentLocation() async -> (Double, Double)? { nil }
}
#endif
