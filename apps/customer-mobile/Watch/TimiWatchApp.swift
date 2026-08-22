import SwiftUI

@main
struct TimiWatchApp: App {
    // Activates the WCSession the first time the app struct is created.
    private let bridge = WatchSessionBridge.shared

    var body: some Scene {
        WindowGroup {
            WatchContentView()
        }
    }
}
