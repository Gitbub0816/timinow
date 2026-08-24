import Foundation
import OSLog
import SwiftUI
import TimiNowCore
import TimiNowUI

private let logger = Logger(subsystem: "solutions.clearkey.timinow", category: "application")

public struct RootView: View {
    // `.shared` so the CarPlay scene (Darwin/Sources/CarPlayBridge.swift)
    // and the Watch connectivity bridge (TimiNowUI/WatchBridge.swift) — both
    // instantiated by the OS outside this view hierarchy — observe the
    // exact same live state as the phone UI.
    @State var store = AppStore.shared
    #if !SKIP
    // Cropped once, at launch. Empty means the asset failed to load, and an
    // empty set skips the splash entirely — content beats an empty square.
    @State var splashFrames = EvanderSprite.loadFrames()
    #endif
    @State var splashVisible = true
    public init() { }

    public var body: some View {
        ZStack {
            CustomerRootView(store: store)
                .task { logger.info("Tími customer app started") }
                // First, before anything that could crash again: a stage the last
                // launch entered and never left is the only evidence that survives
                // a trap inside a framework.
                .task { store.reportCrashBreadcrumb() }
                .task { store.recordAppOpen() }
                .task { await store.auth.start() }
                .task { await store.loadMapConfig() }
                .task { WatchBridge.shared.start(observing: store) }
            #if !SKIP
            if splashVisible && !splashFrames.isEmpty {
                SplashView(frames: splashFrames)
                    .transition(.opacity)
                    .zIndex(50)
            }
            #endif
        }
        #if !SKIP
        .task { await dismissSplashWhenReady() }
        #endif
    }

    #if !SKIP
    /// Holds the splash until BOTH a beat over two seconds has passed — so the
    /// loop reads as intentional rather than as a stutter — and session
    /// restore has reached a verdict. That second condition is the point: it
    /// is what stops the sign-in wall from flashing at somebody whose stored
    /// session is about to resume.
    @MainActor private func dismissSplashWhenReady() async {
        guard !splashFrames.isEmpty else {
            splashVisible = false
            return
        }
        try? await Task.sleep(for: .seconds(2.2))
        // Restore is network-bound (20-second request timeouts), so the wait
        // is capped: past ten seconds a splash stops being a welcome and the
        // sign-in wall, flash or not, is the more honest screen.
        var waited = 0.0
        while !store.auth.hasAttemptedRestore && waited < 10 {
            try? await Task.sleep(for: .milliseconds(100))
            waited += 0.1
        }
        withAnimation(.easeOut(duration: 0.45)) { splashVisible = false }
    }
    #endif
}

#if !SKIP
public protocol TimiNowApplication: App { }
public extension TimiNowApplication {
    // .light, not the system's choice. Tími's palette is a fixed light design
    // — paper, canvas, ink — with no dark counterpart, so on a phone in dark
    // mode every unstyled control took the system scheme while the backgrounds
    // stayed light: white headings on near-white, black text fields, a grey
    // tab bar. Info.plist sets UIUserInterfaceStyle to match, which also
    // covers UIKit chrome this modifier never reaches — the Mapbox navigation
    // view controller among it.
    var body: some Scene { WindowGroup { RootView().preferredColorScheme(.light) } }
}
#endif
