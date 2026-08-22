import SwiftUI
import TimiNowApp
import TimiNowCore

@main struct AppMain: App, TimiNowApplication {
    init() {
        // Darwin-only wiring for the CarPlay scene (CarPlaySceneDelegate is
        // instantiated separately by the OS from Info.plist's
        // UIApplicationSceneManifest, so it needs its own path to the same
        // live AppStore — see Darwin/Sources/CarPlayBridge.swift).
        CarPlayPhoneBridge.shared.start(observing: AppStore.shared)
    }
}
