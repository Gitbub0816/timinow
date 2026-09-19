import Foundation
import Observation
import TimiNowCore
// Required for @Observable to drive the Android UI, and the same conditional
// pair every other file in this target carries.
#if os(Android)
import SkipFuseUI
#else
import SwiftUI
#endif

/// The fold UI's whole navigation model.
///
/// Everything the unfolded app can do is one of a small number of **groups**,
/// and every group is a short list of **actions**. There is no hierarchy, no
/// back stack and no tab bar: at any moment you are in one group, one action
/// in it has focus, and pressing the hub takes that action.
///
/// That is the reimagining. A phone app navigates by moving the screen; this
/// one navigates by moving focus, because the hand cannot move but the thumb
/// can turn. Swiping changes which question is being asked; the wheel changes
/// the answer; the hub commits it.
public struct DuoAction: Identifiable, Hashable, Sendable {
    public let id: String
    public var label: String
    public var symbol: String
    /// A second line shown on the focused card — a distance, a wait, a price.
    public var detail: String

    public init(id: String, label: String, symbol: String, detail: String = "") {
        self.id = id; self.label = label; self.symbol = symbol; self.detail = detail
    }
}

public struct DuoGroup: Identifiable, Hashable, Sendable {
    public enum Kind: String, Sendable {
        /// Rendered as the vertical bar down the near edge.
        case menu
        /// One question with a list of answers.
        case choice
        /// A single action — the wheel has nothing to turn, so it says so.
        case single
    }

    public let id: String
    /// Shown above the wheel. Always a sentence a person would say out loud:
    /// "Select your pet's species", not "Species".
    public var label: String
    public var kind: Kind
    public var actions: [DuoAction]

    public init(id: String, label: String, kind: Kind, actions: [DuoAction]) {
        self.id = id; self.label = label; self.kind = kind; self.actions = actions
    }
}

@Observable
public final class DuoNavigator {
    public var groups: [DuoGroup]
    public var groupIndex: Int = 0
    /// Focus within the current group. Focus is not selection — the hub
    /// commits, so a thumb drifting across the arc can never book anything.
    public var focusIndex: Int = 0
    /// What the hub last committed, per group, so the stage can show the
    /// answers already given without a separate model.
    public var chosen: [String: String] = [:]
    /// Set for a moment after a commit so the stage can acknowledge it.
    public var justCommitted: String?

    public init(groups: [DuoGroup]) {
        self.groups = groups
    }

    public var group: DuoGroup {
        groups.isEmpty ? DuoGroup(id: "empty", label: "Nothing to do", kind: .single, actions: [])
                       : groups[min(groupIndex, groups.count - 1)]
    }

    public var focused: DuoAction? {
        let actions = group.actions
        guard !actions.isEmpty else { return nil }
        return actions[min(focusIndex, actions.count - 1)]
    }

    public var canTurn: Bool { group.actions.count > 1 }

    /// Move between groups. Deliberately clamped rather than wrapped: a list
    /// that wraps gives no sense of where its ends are, and the ends here are
    /// meaningful — the menu is always the first group.
    public func moveGroup(_ delta: Int) {
        let next = max(0, min(groups.count - 1, groupIndex + delta))
        guard next != groupIndex else { return }
        groupIndex = next
        focusIndex = restoredFocus(for: groups[next])
    }

    public func focus(_ index: Int) {
        let count = group.actions.count
        guard count > 0 else { return }
        focusIndex = max(0, min(count - 1, index))
    }

    public func turn(_ delta: Int) { focus(focusIndex + delta) }

    /// Commit the focused action. Returns it so the caller can act.
    @discardableResult
    public func commit() -> DuoAction? {
        guard let action = focused else { return nil }
        chosen[group.id] = action.id
        justCommitted = action.id
        return action
    }

    /// Coming back to a group puts focus on the answer already given, not
    /// back at the top — re-answering a question should start from the
    /// current answer.
    private func restoredFocus(for group: DuoGroup) -> Int {
        guard let chosenID = chosen[group.id],
              let index = group.actions.firstIndex(where: { $0.id == chosenID }) else { return 0 }
        return index
    }

    public func chosenLabel(_ groupID: String) -> String? {
        guard let id = chosen[groupID],
              let group = groups.first(where: { $0.id == groupID }),
              let action = group.actions.first(where: { $0.id == id }) else { return nil }
        return action.label
    }
}

// MARK: - Sections

/// What the menu switches between.
///
/// A section is not a screen — it decides which *questions* the wheel asks.
/// The stage never changes shape, so moving between sections costs no
/// relearning: it is still one question, one focused answer, one hub.
public enum DuoSection: String, CaseIterable, Sendable {
    case find, pets, activity, fund, settings

    public var title: String {
        switch self {
        case .find: return "Find care"
        case .pets: return "My pets"
        case .activity: return "Activity"
        case .fund: return "Paw It Forward"
        case .settings: return "Settings"
        }
    }

    public var symbol: String {
        switch self {
        case .find: return "magnifyingglass"
        case .pets: return "pawprint.fill"
        case .activity: return "clock.fill"
        case .fund: return "heart.fill"
        case .settings: return "gearshape.fill"
        }
    }
}

// MARK: - The groups themselves

public enum DuoContent {

    /// The menu is a group like any other — it is only drawn differently.
    public static func menu() -> DuoGroup {
        DuoGroup(id: "menu", label: "Menu", kind: .menu,
                 actions: DuoSection.allCases.map {
                     DuoAction(id: $0.rawValue, label: $0.title, symbol: $0.symbol)
                 })
    }

    /// Every question the wheel can ask, for one section.
    ///
    /// Built from the store rather than hand-listed, so a pet added anywhere
    /// or an offer arriving from the network turns up here without this file
    /// knowing how either happened.
    @MainActor
    public static func groups(for store: AppStore,
                              section: DuoSection,
                              handedness: String) -> [DuoGroup] {
        var groups: [DuoGroup] = [menu()]
        switch section {
        case .find:     groups += findGroups(store)
        case .pets:     groups += petGroups(store)
        case .activity: groups += activityGroups(store)
        case .fund:     groups += fundGroups()
        case .settings: groups += settingsGroups(handedness)
        }
        return groups
    }

    // MARK: Find care

    @MainActor
    static func findGroups(_ store: AppStore) -> [DuoGroup] {
        var groups: [DuoGroup] = []

        if store.pets.count > 1 {
            groups.append(DuoGroup(
                id: "pet", label: "Which pet is this for", kind: .choice,
                actions: store.pets.map {
                    DuoAction(id: $0.id, label: $0.name, symbol: $0.species.icon,
                              detail: $0.species.title)
                }))
        }

        groups.append(DuoGroup(
            id: "species", label: "Select your pet\u{2019}s species", kind: .choice,
            actions: PetSpecies.allCases.map {
                DuoAction(id: $0.rawValue, label: $0.title, symbol: $0.icon)
            }))

        groups.append(DuoGroup(
            id: "urgency", label: "How urgent is it", kind: .choice,
            actions: [
                DuoAction(id: "emergency", label: "Emergency", symbol: "exclamationmark.triangle.fill",
                          detail: "Now, whatever it costs"),
                DuoAction(id: "urgent", label: "Urgent", symbol: "clock.fill",
                          detail: "Today if at all possible"),
                DuoAction(id: "same_day", label: "Later today", symbol: "calendar",
                          detail: "It can wait a few hours")
            ]))

        // Live offers. Clinic identities stay masked until one is selected —
        // the same rule the phone UI keeps, for the same reason: a directory
        // of who is available is not ours to publish before there is a booking
        // behind it. So this shows the temporary alias and the facts that
        // survive masking, never a business name.
        let offers = store.currentSearch?.offers ?? []
        if !offers.isEmpty {
            groups.append(DuoGroup(
                id: "clinic", label: "Select a clinic", kind: .choice,
                actions: offers.map { offer in
                    DuoAction(id: offer.id,
                              label: maskedName(offer),
                              symbol: offer.responseType == "emergency_intake"
                                      ? "cross.case.fill" : "building.2.fill",
                              detail: maskedDetail(offer))
                }))
        }

        let searching = ["collecting", "offers_ready"].contains(store.currentSearch?.status ?? "")
        groups.append(DuoGroup(
            id: "start", label: searching ? "Clinics are answering" : "Ready when you are",
            kind: .single,
            actions: [DuoAction(
                id: searching ? "refresh" : "start",
                label: searching ? "Check for new answers" : "Ask the clinics now",
                symbol: searching ? "arrow.clockwise" : "paperplane.fill",
                detail: searching ? "\(offers.count) so far" : "Up to five answer at once")]))

        return groups
    }

    /// Mirrors OfferCard.clinic in OfferAndTrackerViews — the same masking
    /// rule, deliberately not shared, because the phone card needs a whole
    /// ClinicLocation and the wheel needs one line of text.
    static func maskedName(_ offer: CareOffer) -> String {
        if let location = offer.location { return location.name }
        if let masked = offer.maskedCard { return masked.alias?.displayName ?? "New clinic match" }
        return "Veterinary clinic"
    }

    static func maskedDetail(_ offer: CareOffer) -> String {
        var parts: [String] = []
        let miles = offer.location?.distanceMiles ?? offer.maskedCard?.timinow?.distanceMiles
        if let miles { parts.append(String(format: "%.1f mi", miles)) }
        if let low = offer.waitMin {
            parts.append(offer.waitMax.map { "\(low)\u{2013}\($0) min wait" } ?? "\(low) min wait")
        }
        return parts.joined(separator: " \u{00B7} ")
    }

    // MARK: Other sections

    @MainActor
    static func petGroups(_ store: AppStore) -> [DuoGroup] {
        guard !store.pets.isEmpty else {
            return [DuoGroup(id: "pets", label: "No pets yet", kind: .single,
                             actions: [DuoAction(id: "add", label: "Add your first pet",
                                                 symbol: "plus", detail: "Takes about a minute")])]
        }
        return [DuoGroup(id: "pets", label: "Your pets", kind: .choice,
                         actions: store.pets.map {
                             DuoAction(id: $0.id, label: $0.name, symbol: $0.species.icon,
                                       detail: $0.breed.isEmpty ? $0.species.title
                                                                : "\($0.species.title) \u{00B7} \($0.breed)")
                         })]
    }

    @MainActor
    static func activityGroups(_ store: AppStore) -> [DuoGroup] {
        guard !store.history.isEmpty else {
            return [DuoGroup(id: "activity", label: "Nothing here yet", kind: .single,
                             actions: [DuoAction(id: "none", label: "No visits recorded",
                                                 symbol: "clock",
                                                 detail: "Visits appear here once a clinic has seen your pet")])]
        }
        return [DuoGroup(id: "activity", label: "Recent visits", kind: .choice,
                         actions: store.history.map {
                             DuoAction(id: $0.id, label: $0.clinicName, symbol: "clock.fill",
                                       detail: "\($0.petName) \u{00B7} \($0.status)")
                         })]
    }

    static func fundGroups() -> [DuoGroup] {
        [DuoGroup(id: "fund", label: "Paw It Forward", kind: .single,
                  actions: [DuoAction(id: "about", label: "What the fund covers",
                                      symbol: "heart.fill",
                                      detail: "T\u{ED}mi\u{2019}s own access fee, for verified hardship. It does not pay veterinary bills.")])]
    }

    static func settingsGroups(_ handedness: String) -> [DuoGroup] {
        [DuoGroup(id: "hand", label: "Which hand holds the phone", kind: .choice,
                  actions: [
                    DuoAction(id: "right", label: "Right", symbol: "hand.point.right.fill",
                              detail: handedness == "right" ? "Currently in use" : "Wheel on the right"),
                    DuoAction(id: "left", label: "Left", symbol: "hand.point.left.fill",
                              detail: handedness == "left" ? "Currently in use" : "Wheel on the left")
                  ])]
    }

    /// Used before there is any data, so the fold UI is never an empty room.
    public static func sample() -> [DuoGroup] {
        [
            menu(),
            DuoGroup(id: "species", label: "Select your pet\u{2019}s species", kind: .choice,
                     actions: PetSpecies.allCases.map {
                         DuoAction(id: $0.rawValue, label: $0.title, symbol: $0.icon)
                     }),
            DuoGroup(id: "start", label: "Ready when you are", kind: .single,
                     actions: [DuoAction(id: "start", label: "Ask the clinics now",
                                         symbol: "paperplane.fill",
                                         detail: "Up to five answer at once")])
        ]
    }
}
