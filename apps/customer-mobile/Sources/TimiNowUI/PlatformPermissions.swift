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

    /// Escalates to "Always" so arrival status can update itself while the
    /// app is backgrounded on the drive over. Only meaningful after
    /// `requestLocation()` (or this itself) has already secured
    /// when-in-use — iOS will not show the Always upgrade prompt otherwise.
    static func requestAlwaysLocation() async -> Bool { await LocationPermissionAgent.shared.requestAlways() }

    /// Starts hands-off arrival tracking: leaving the customer's current
    /// location fires `onLeftOrigin`, arriving at the clinic fires
    /// `onArrivedAtClinic`. Best-effort automation layered on top of the
    /// manual status buttons, which stay the fallback if this never fires
    /// (permission denied, monitoring unavailable, app force-quit).
    static func startArrivalTracking(
        originLatitude: Double, originLongitude: Double,
        clinicLatitude: Double, clinicLongitude: Double,
        onLeftOrigin: @escaping () -> Void,
        onArrivedAtClinic: @escaping () -> Void
    ) {
        LocationPermissionAgent.shared.startMonitoring(
            originLatitude: originLatitude, originLongitude: originLongitude,
            clinicLatitude: clinicLatitude, clinicLongitude: clinicLongitude,
            onLeftOrigin: onLeftOrigin, onArrivedAtClinic: onArrivedAtClinic
        )
    }

    static func stopArrivalTracking() { LocationPermissionAgent.shared.stopMonitoring() }
}

@MainActor private final class LocationPermissionAgent: NSObject, CLLocationManagerDelegate {
    static let shared = LocationPermissionAgent()
    private let manager = CLLocationManager()
    private var continuation: CheckedContinuation<Bool, Never>?
    private var locationContinuation: CheckedContinuation<(Double, Double)?, Never>?
    private var alwaysContinuation: CheckedContinuation<Bool, Never>?
    private var originRegion: CLCircularRegion?
    private var clinicRegion: CLCircularRegion?
    private var onLeftOrigin: (() -> Void)?
    private var onArrivedAtClinic: (() -> Void)?

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

    func requestAlways() async -> Bool {
        if manager.authorizationStatus == .authorizedAlways { return true }
        if manager.authorizationStatus != .authorizedWhenInUse {
            guard await request() else { return false }
        }
        if manager.authorizationStatus == .authorizedAlways { return true }
        return await withCheckedContinuation { value in alwaysContinuation = value; manager.requestAlwaysAuthorization() }
    }

    /// Two 150m geofences: one around where the customer is now (fires on
    /// exit — "they left"), one around the clinic (fires on entry —
    /// "they arrived"). Radius is clamped to what the device actually
    /// supports, since `maximumRegionMonitoringDistance` varies by hardware.
    func startMonitoring(
        originLatitude: Double, originLongitude: Double,
        clinicLatitude: Double, clinicLongitude: Double,
        onLeftOrigin: @escaping () -> Void,
        onArrivedAtClinic: @escaping () -> Void
    ) {
        stopMonitoring()
        guard CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self) else { return }
        self.onLeftOrigin = onLeftOrigin
        self.onArrivedAtClinic = onArrivedAtClinic
        let radius = min(150, manager.maximumRegionMonitoringDistance)

        let origin = CLCircularRegion(center: CLLocationCoordinate2D(latitude: originLatitude, longitude: originLongitude), radius: radius, identifier: "timi-origin")
        origin.notifyOnEntry = false
        origin.notifyOnExit = true
        originRegion = origin
        manager.startMonitoring(for: origin)

        let clinic = CLCircularRegion(center: CLLocationCoordinate2D(latitude: clinicLatitude, longitude: clinicLongitude), radius: radius, identifier: "timi-clinic")
        clinic.notifyOnEntry = true
        clinic.notifyOnExit = false
        clinicRegion = clinic
        manager.startMonitoring(for: clinic)
    }

    func stopMonitoring() {
        if let originRegion { manager.stopMonitoring(for: originRegion) }
        if let clinicRegion { manager.stopMonitoring(for: clinicRegion) }
        originRegion = nil; clinicRegion = nil
        onLeftOrigin = nil; onArrivedAtClinic = nil
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard manager.authorizationStatus != .notDetermined else { return }
        let granted = manager.authorizationStatus == .authorizedWhenInUse || manager.authorizationStatus == .authorizedAlways
        if let continuation { self.continuation = nil; continuation.resume(returning: granted) }
        if let alwaysContinuation { self.alwaysContinuation = nil; alwaysContinuation.resume(returning: manager.authorizationStatus == .authorizedAlways) }
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

    func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) {
        guard region.identifier == "timi-origin" else { return }
        let callback = onLeftOrigin
        manager.stopMonitoring(for: region)
        originRegion = nil
        callback?()
    }

    func locationManager(_ manager: CLLocationManager, didEnterRegion region: CLRegion) {
        guard region.identifier == "timi-clinic" else { return }
        let callback = onArrivedAtClinic
        stopMonitoring()
        callback?()
    }

    // Geofencing is best-effort automation on top of the manual status
    // buttons — a region that fails to register just leaves the manual
    // fallback as the only path, which is not an error worth surfacing.
    func locationManager(_ manager: CLLocationManager, monitoringDidFailFor region: CLRegion?, withError error: Error) {}
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
    static func requestAlwaysLocation() async -> Bool { true }
    static func startArrivalTracking(
        originLatitude: Double, originLongitude: Double,
        clinicLatitude: Double, clinicLongitude: Double,
        onLeftOrigin: @escaping () -> Void,
        onArrivedAtClinic: @escaping () -> Void
    ) {}
    static func stopArrivalTracking() {}
}
#endif
