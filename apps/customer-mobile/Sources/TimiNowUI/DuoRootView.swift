import Foundation
import Observation
import TimiNowCore
#if os(Android)
import SkipFuseUI
#else
import SwiftUI
#endif

/// When the fold UI takes over.
///
/// There is no separate app and no fold API — the device hands the running app
/// a new size. So the decision is the horizontal size class, `.regular` only
/// on an unfolded device, which means every phone build takes the branch it
/// always did and the existing UI pays nothing for this.
///
/// TIMI_DUO=1 in a scheme's environment forces it on, so the layout can be
/// worked on in an iPad simulator without fold hardware.
public enum DuoLayout {
    public static var forced: Bool {
        ProcessInfo.processInfo.environment["TIMI_DUO"] == "1"
    }
}

/// The unfolded app.
///
/// A vertical menu bar on the far edge, one question on the stage, and the
/// half wheel inset from the near edge. Nothing scrolls and nothing is
/// hierarchical: the wheel turns through answers, a vertical flick on the hub
/// changes the question, and the hub commits.
/// `@MainActor` on the type, not on six separate members: the initialiser
/// builds groups from the store, `rebuild()` does it again, and `take()` calls
/// store methods. All of that is main-actor work because AppStore is
/// `@MainActor @Observable`, and a View's `body` already is.
@MainActor
public struct DuoRootView: View {
    @Bindable var store: AppStore
    @State var navigator: DuoNavigator
    @State var section: DuoSection = .find
    @State var handedness = "right"

    public init(store: AppStore) {
        self.store = store
        _navigator = State(initialValue: DuoNavigator(
            groups: DuoContent.groups(for: store, section: .find, handedness: "right")))
    }

    private var menuExpanded: Bool { navigator.group.kind == .menu }
    private var nearTrailing: Bool { handedness == "right" }

    /// Sign-in and onboarding are forms, and a wheel cannot type. So they keep
    /// their own screens here — capped to a readable column rather than
    /// stretched the width of an unfolded device, which is what a phone layout
    /// on a tablet looks like and why it reads as broken.
    ///
    /// The wheel appears once there is something to turn.
    private var needsAuth: Bool {
        guard store.auth.signInRequired, !store.auth.isSignedIn else { return false }
        // TIMI_DUO=1 skips the gate as well as forcing the layout, so the wheel
        // can be worked on without a live sign-in code. It grants nothing: the
        // store still has no token, so every call that needs one fails exactly
        // as it should. An environment variable can only be set by whoever
        // launches the process, which on a shipped app is nobody.
        return !DuoLayout.forced
    }

    public var body: some View {
        ZStack {
            TimiColor.paper.ignoresSafeArea()
            if needsAuth { authColumn } else { wheelLayout }
        }
        .onChange(of: store.pets.count) { _, _ in rebuild() }
        .onChange(of: store.currentSearch?.offers?.count ?? 0) { _, _ in rebuild() }
        .onChange(of: store.currentSearch?.status ?? "") { _, _ in rebuild() }
    }

    private var authColumn: some View {
        Group {
            if store.hasCompletedOnboarding || store.onboardingSignInRequested {
                SignInView(auth: store.auth,
                           handoff: store.hasCompletedOnboarding && store.hasPet,
                           handoffPetName: store.pets.first?.name ?? "")
            } else {
                OnboardingView(store: store)
            }
        }
        .frame(maxWidth: 640)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var wheelLayout: some View {
        ZStack {
            HStack(spacing: 0) {
                if nearTrailing { menuBar }
                stage
                if !nearTrailing { menuBar }
            }

            // The wheel, inset from the near edge rather than flush to it.
            HStack {
                if nearTrailing { Spacer(minLength: 0) }
                DuoWheel(navigator: navigator) { action in take(action) }
                    .padding(.trailing, CGFloat(nearTrailing ? 34 : 0))
                    .padding(.leading, CGFloat(nearTrailing ? 0 : 34))
                    .padding(.bottom, 28)
                if !nearTrailing { Spacer(minLength: 0) }
            }
            .frame(maxHeight: .infinity, alignment: .bottom)
        }
    }

    private var menuBar: some View {
        DuoMenuBar(navigator: navigator,
                   expanded: menuExpanded,
                   currentID: section.rawValue) { action in
            if let index = navigator.groups.firstIndex(where: { $0.kind == .menu }) {
                navigator.groupIndex = index
                if let spot = navigator.groups[index].actions.firstIndex(where: { $0.id == action.id }) {
                    navigator.focus(spot)
                }
                navigator.commit()
                take(action)
            }
        }
        .animation(.easeOut(duration: 0.2), value: menuExpanded)
    }

    private var stage: some View {
        DuoStage(navigator: navigator)
            .padding(.horizontal, 36)
            .padding(.vertical, 28)
            // Room for the wheel, so the longest answer never slides under it.
            .padding(nearTrailing ? .trailing : .leading, 290)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: Committing

    /// The one place a committed action turns into something happening.
    ///
    /// Switched on the group rather than on the action, because the same
    /// action id means different things in different questions — and because
    /// a group the wheel can ask but nothing here handles is then obviously a
    /// gap rather than a silent no-op.
    private func take(_ action: DuoAction) {
        switch navigator.group.id {
        case "menu":
            guard let next = DuoSection(rawValue: action.id) else { return }
            section = next
            rebuild()
            // Land on the first real question rather than leaving the menu
            // selected — choosing a destination should take you to it.
            navigator.groupIndex = min(1, max(0, navigator.groups.count - 1))
            navigator.focusIndex = 0

        case "species":
            if let species = PetSpecies(rawValue: action.id) {
                store.draft.pet.species = species
            }

        case "pet", "pets":
            store.choosePet(action.id)
            rebuild()

        case "urgency":
            if let urgency = CareUrgency(rawValue: action.id) {
                store.draft.urgency = urgency
            }

        case "clinic":
            guard let offer = store.currentSearch?.offers?.first(where: { $0.id == action.id })
            else { return }
            Task { await store.selectOffer(offer) }

        case "start":
            if action.id == "refresh" {
                Task { await store.refreshSearch() }
            } else {
                Task { await store.startSearch() }
            }

        case "hand":
            handedness = action.id
            rebuild()

        default:
            break
        }
    }

    /// Rebuild the questions, keeping the place in them where that still makes
    /// sense — a refresh that threw you back to the menu every time an offer
    /// arrived would be unusable.
    private func rebuild() {
        let previousGroupID = navigator.group.id
        let previousActionID = navigator.focused?.id
        navigator.groups = DuoContent.groups(for: store, section: section, handedness: handedness)

        if let index = navigator.groups.firstIndex(where: { $0.id == previousGroupID }) {
            navigator.groupIndex = index
            if let actionID = previousActionID,
               let spot = navigator.groups[index].actions.firstIndex(where: { $0.id == actionID }) {
                navigator.focusIndex = spot
            } else {
                navigator.focusIndex = 0
            }
        } else {
            navigator.groupIndex = min(navigator.groupIndex, max(0, navigator.groups.count - 1))
            navigator.focusIndex = 0
        }
    }
}
