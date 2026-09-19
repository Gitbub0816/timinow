import Foundation
import Observation
import TimiNowCore

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

// MARK: - The groups themselves

public enum DuoContent {
    /// Built from the store so the fold UI shows real pets and real offers,
    /// but written as data rather than as screens — the wheel only ever sees
    /// groups and actions, whatever is behind them.
    public static func groups(for store: AppStore) -> [DuoGroup] {
        var groups: [DuoGroup] = [menu()]

        let pets = store.pets
        if pets.count > 1 {
            groups.append(DuoGroup(
                id: "pet", label: "Which pet is this for", kind: .choice,
                actions: pets.map { pet in
                    DuoAction(id: pet.id, label: pet.name, symbol: pet.species.icon,
                              detail: pet.species.title)
                }))
        }

        groups.append(DuoGroup(
            id: "species", label: "Select your pet\u{2019}s species", kind: .choice,
            actions: PetSpecies.allCases.map { species in
                DuoAction(id: species.rawValue, label: species.title, symbol: species.icon)
            }))

        groups.append(DuoGroup(
            id: "urgency", label: "How urgent is it", kind: .choice,
            actions: [
                DuoAction(id: "emergency", label: "Emergency", symbol: "exclamationmark.triangle.fill",
                          detail: "Now, whatever it costs"),
                DuoAction(id: "urgent", label: "Urgent", symbol: "clock.fill",
                          detail: "Today if at all possible"),
                DuoAction(id: "soon", label: "Soon", symbol: "calendar",
                          detail: "In the next day or two")
            ]))

        // "Select a clinic" is deliberately absent here for now. Live offers
        // hang off the current search rather than off the store directly, and
        // wiring the wheel to them is a real piece of work — the wheel is
        // ready for it (a ten-item group is what the sweep was sized for; see
        // DuoContent.sample) but guessing at the accessor would ship a fold UI
        // that compiles and shows nothing.

        groups.append(DuoGroup(
            id: "start", label: "Ready when you are", kind: .single,
            actions: [DuoAction(id: "start", label: "Ask the clinics now",
                                symbol: "paperplane.fill",
                                detail: "Up to five answer at once")]))

        return groups
    }

    /// The menu is a group like any other — it is only drawn differently.
    public static func menu() -> DuoGroup {
        DuoGroup(id: "menu", label: "Menu", kind: .menu, actions: [
            DuoAction(id: "find", label: "Find care", symbol: "magnifyingglass"),
            DuoAction(id: "pets", label: "My pets", symbol: "pawprint.fill"),
            DuoAction(id: "activity", label: "Activity", symbol: "clock.fill"),
            DuoAction(id: "fund", label: "Paw It Forward", symbol: "heart.fill"),
            DuoAction(id: "settings", label: "Settings", symbol: "gearshape.fill")
        ])
    }

    /// Used by the preview and by a build with no data yet, so the fold UI is
    /// never an empty room.
    public static func sample() -> [DuoGroup] {
        [
            menu(),
            DuoGroup(id: "species", label: "Select your pet\u{2019}s species", kind: .choice,
                     actions: [
                        DuoAction(id: "dog", label: "Dog", symbol: "pawprint.fill"),
                        DuoAction(id: "cat", label: "Cat", symbol: "cat.fill"),
                        DuoAction(id: "rabbit", label: "Rabbit", symbol: "hare.fill"),
                        DuoAction(id: "bird", label: "Bird", symbol: "bird.fill"),
                        DuoAction(id: "reptile", label: "Reptile", symbol: "lizard.fill"),
                        DuoAction(id: "other", label: "Other", symbol: "pawprint.circle.fill")
                     ]),
            DuoGroup(id: "urgency", label: "How urgent is it", kind: .choice,
                     actions: [
                        DuoAction(id: "emergency", label: "Emergency", symbol: "exclamationmark.triangle.fill",
                                  detail: "Now, whatever it costs"),
                        DuoAction(id: "urgent", label: "Urgent", symbol: "clock.fill",
                                  detail: "Today if at all possible")
                     ]),
            DuoGroup(id: "start", label: "Ready when you are", kind: .single,
                     actions: [DuoAction(id: "start", label: "Ask the clinics now",
                                         symbol: "paperplane.fill",
                                         detail: "Up to five answer at once")])
        ]
    }
}
