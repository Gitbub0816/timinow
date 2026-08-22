import Foundation
import Observation
import WatchConnectivity
import WatchKit

// Deliberately does NOT depend on the TimiNowCore Swift package (see
// docs/NAVIGATION.md): watchOS is a separate, self-contained Xcode target,
// so this file defines its own small Decodable mirrors of just the fields
// the Watch UI needs. Their property names match TimiNowCore's real model
// property names exactly, so `JSONDecoder` reads the same JSON the phone's
// `WatchBridge` (Sources/TimiNowUI/WatchBridge.swift) encodes straight off
// `AppStore` — extra fields the Watch doesn't care about are ignored.

struct WatchPet: Codable { var name: String }
struct WatchLocation: Codable { var name: String; var address: String? }
struct WatchIntake: Codable { var status: String; var clinicNote: String?; var location: WatchLocation? }
struct WatchOffer: Codable { var location: WatchLocation? }
struct WatchSearch: Codable { var status: String; var offers: [WatchOffer]? }
struct WatchStep: Codable { var instruction: String; var maneuver: String }
struct WatchRoute: Codable { var expectedTravelSeconds: Double }

/// Mirrors `CareSearch`/`CareIntake` and the current navigation step from
/// the phone over `WCSession`, and relays milestone button taps back
/// through the same message channel the phone's `WatchBridge` listens on.
@Observable
final class WatchSessionBridge: NSObject, WCSessionDelegate {
    static let shared = WatchSessionBridge()

    var petName = "your pet"
    var searchStatus: String?
    var clinicName: String?
    var clinicAddress: String?
    var clinicNote: String?
    var intakeStatus: String?
    var nextInstruction: String?
    var etaMinutes: Int?
    private var lastOfferCount = 0
    private var hasSeenAcceptedIntake = false

    private override init() {
        super.init()
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    /// Sends an "arrived" / "triaged" / "seen" milestone tap to the phone,
    /// which writes it through `AppStore.record(_:)` — the same Worker API
    /// call the phone's own tracker buttons use.
    func sendMilestone(_ milestone: String) {
        guard WCSession.default.activationState == .activated else { return }
        WCSession.default.sendMessage(["milestone": milestone], replyHandler: nil, errorHandler: nil)
    }

    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) { }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        Task { @MainActor in self.apply(applicationContext) }
    }

    @MainActor private func apply(_ context: [String: Any]) {
        let decoder = JSONDecoder()
        var newOfferCount = lastOfferCount
        var justAccepted = false

        if let data = context["pet"] as? Data, let pet = try? decoder.decode(WatchPet.self, from: data) {
            petName = pet.name
        }
        if let data = context["search"] as? Data, let search = try? decoder.decode(WatchSearch.self, from: data) {
            searchStatus = search.status
            newOfferCount = search.offers?.count ?? 0
        }
        if let data = context["intake"] as? Data, let intake = try? decoder.decode(WatchIntake.self, from: data) {
            if !hasSeenAcceptedIntake { justAccepted = true; hasSeenAcceptedIntake = true }
            intakeStatus = intake.status
            clinicNote = intake.clinicNote
            clinicName = intake.location?.name
            clinicAddress = intake.location?.address
        } else {
            // Intake cleared (e.g. `resetCareFlow()` on the phone) — allow
            // the next accepted intake to trigger haptic feedback again.
            hasSeenAcceptedIntake = false
            intakeStatus = nil
            clinicName = nil
            clinicAddress = nil
            clinicNote = nil
        }
        if let data = context["step"] as? Data, let step = try? decoder.decode(WatchStep.self, from: data) {
            nextInstruction = step.instruction
        }
        if let data = context["route"] as? Data, let route = try? decoder.decode(WatchRoute.self, from: data) {
            etaMinutes = Int((route.expectedTravelSeconds / 60).rounded())
        }

        // Haptic feedback when a new offer arrives, or the clinic accepts.
        if newOfferCount > lastOfferCount && lastOfferCount > 0 { WKInterfaceDevice.current().play(.notification) }
        if justAccepted { WKInterfaceDevice.current().play(.notification) }
        lastOfferCount = newOfferCount
    }
}
