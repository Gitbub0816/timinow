import SwiftUI
import TimiNowApp
import TimiNowCore

@main struct AppMain: App, TimiNowApplication {
    // Registers TimiPushDelegate (Darwin/Sources/PushDelegate.swift) as this
    // app's UIApplicationDelegate — the only way to receive
    // didRegisterForRemoteNotificationsWithDeviceToken and a notification tap,
    // neither of which SwiftUI's App protocol exposes on its own.
    @UIApplicationDelegateAdaptor(TimiPushDelegate.self) var pushDelegate

    init() {
        // Darwin-only wiring for the CarPlay scene (CarPlaySceneDelegate is
        // instantiated separately by the OS from Info.plist's
        // UIApplicationSceneManifest, so it needs its own path to the same
        // live AppStore — see Darwin/Sources/CarPlayBridge.swift).
        CarPlayPhoneBridge.shared.start(observing: AppStore.shared)
    }
}
