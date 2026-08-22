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
    public init() { }

    public var body: some View {
        CustomerRootView(store: store)
            .task { logger.info("Tími customer app started") }
            .task { await store.loadMapConfig() }
            .task { WatchBridge.shared.start(observing: store) }
    }
}

#if !SKIP
public protocol TimiNowApplication: App { }
public extension TimiNowApplication {
    var body: some Scene { WindowGroup { RootView() } }
}
#endif
