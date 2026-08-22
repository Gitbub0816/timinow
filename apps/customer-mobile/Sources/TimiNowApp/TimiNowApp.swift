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
            .task { await store.auth.start() }
            .task { await store.loadMapConfig() }
            .task { WatchBridge.shared.start(observing: store) }
    }
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
