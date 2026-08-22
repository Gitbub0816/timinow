import Foundation
import Observation
import TimiNowCore

// Apple-only guarded: WatchConnectivity has no Android/Skip equivalent.
// The fallback below keeps the same public surface so call sites (e.g.
// TimiNowApp.swift) never need their own `#if`.

#if os(iOS) && !SKIP
import WatchConnectivity

/// Mirrors `CareSearch`/`CareIntake` and the current navigation step to the
/// paired Watch app over `WCSession`, and relays milestone button taps
/// (arrived / triaged / seen) sent back from the Watch through the same
/// `AppStore.record(_:)` path the phone UI uses.
///
/// Uses the `withObservationTracking` idiom to react to `AppStore`'s
/// `@Observable` state from outside a SwiftUI view body: each call
/// re-subscribes itself in the `onChange` handler, so every subsequent
/// state change keeps triggering a push.
@MainActor
public final class WatchBridge: NSObject, WCSessionDelegate {
    public static let shared = WatchBridge()
    private var store: AppStore?

    public func start(observing store: AppStore) {
        self.store = store
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
        observe()
    }

    private func observe() {
        withObservationTracking {
            _ = store?.currentSearch
            _ = store?.currentIntake
            _ = store?.currentNavigationStep
            _ = store?.currentRouteSummary
            _ = store?.selectedPet
        } onChange: { [weak self] in
            Task { @MainActor in
                self?.push()
                self?.observe()
            }
        }
    }

    private func push() {
        guard WCSession.default.activationState == .activated, let store else { return }
        var payload: [String: Any] = [:]
        if let data = try? JSONEncoder().encode(store.currentSearch) { payload["search"] = data }
        if let data = try? JSONEncoder().encode(store.currentIntake) { payload["intake"] = data }
        if let data = try? JSONEncoder().encode(store.currentNavigationStep) { payload["step"] = data }
        if let data = try? JSONEncoder().encode(store.currentRouteSummary) { payload["route"] = data }
        if let data = try? JSONEncoder().encode(store.selectedPet) { payload["pet"] = data }
        try? WCSession.default.updateApplicationContext(payload)
    }

    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        Task { @MainActor in self.push() }
    }
    nonisolated func sessionDidBecomeInactive(_ session: WCSession) { }
    nonisolated func sessionDidDeactivate(_ session: WCSession) { session.activate() }

    /// The Watch app relays "arrived" / "triaged" / "seen" milestone
    /// button taps here as `{"milestone": "..."}` messages, so they write
    /// through the same `AppStore.record(_:)` path (and the same Worker
    /// API call) as the phone's own tracker buttons.
    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        guard let milestone = message["milestone"] as? String else {
            replyHandler(["ok": false])
            return
        }
        Task { @MainActor in
            await self.store?.record(milestone)
            replyHandler(["ok": true])
        }
    }
}
#else
@MainActor
public final class WatchBridge {
    public static let shared = WatchBridge()
    public func start(observing store: AppStore) { }
}
#endif
