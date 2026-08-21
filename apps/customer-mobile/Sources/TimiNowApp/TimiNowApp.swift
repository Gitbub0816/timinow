import Foundation
import OSLog
import SwiftUI
import TimiNowCore
import TimiNowUI

private let logger = Logger(subsystem: "solutions.clearkey.timinow", category: "application")

public struct RootView: View {
    @State var store = AppStore()
    public init() { }

    public var body: some View {
        CustomerRootView(store: store)
            .task { logger.info("Tími customer app started") }
    }
}

#if !SKIP
public protocol TimiNowApplication: App { }
public extension TimiNowApplication {
    var body: some Scene { WindowGroup { RootView() } }
}
#endif
