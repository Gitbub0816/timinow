import Foundation

#if os(iOS) && !SKIP
import CoreLocation
import UserNotifications

@MainActor enum PlatformPermissions {
    static func requestNotifications() async -> Bool {
        do { return try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) }
        catch { return false }
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
    static func notify(title: String, body: String) async { }
    static func requestLocation() async -> Bool { true }
    static func currentLocation() async -> (Double, Double)? { nil }
}
#endif
