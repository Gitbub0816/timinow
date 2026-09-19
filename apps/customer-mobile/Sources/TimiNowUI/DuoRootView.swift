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
        let signedOut = store.auth.signInRequired && !store.auth.isSignedIn && !DuoLayout.forced
        _navigator = State(initialValue: DuoNavigator(
            groups: signedOut
                ? DuoContent.authGroups(store.auth.stage)
                : DuoContent.groups(for: store, section: .find, handedness: "right")))
    }

    private var menuExpanded: Bool { navigator.group.kind == .menu }
    private var nearTrailing: Bool { handedness == "right" }

    /// Signed out, the fold app is still the fold app: the same chrome, the
    /// same wheel, a different stage and a different set of choices. It never
    /// hands over to a phone screen, which is what made the wheel invisible to
    /// anyone who had not already signed in.
    ///
    /// Onboarding is gone from the fold entirely. It exists on the phone so a
    /// stranger is asked their pet's name rather than their email address —
    /// worth it there. Here the wheel *already* asks for the pet, the species
    /// and the urgency, so running onboarding first would ask the same
    /// questions twice, in two different interaction models, before showing
    /// the one the app is for. Sign in, then the wheel; pets are added from
    /// the Pets section with the same control as everything else.
    /// Onboarding runs BEFORE sign-in, here as on the phone.
    ///
    /// That ordering is deliberate and it is not mine to undo: a stranger is
    /// asked their pet's name rather than their email address, and the code
    /// screen arrives as the flow's natural last step. Removing it from the
    /// fold — which I did — threw that away for no reason beyond my wanting
    /// the wheel on screen sooner.
    ///
    /// It carries no wheel. It is a form with several fields and its own
    /// Continue, and a wheel with one thing to turn is a control that lies
    /// about what it does.
    private var needsOnboarding: Bool {
        guard !DuoLayout.forced else { return false }
        return !store.hasCompletedOnboarding && !store.onboardingSignInRequested
    }

    private var needsAuth: Bool {
        guard !needsOnboarding else { return false }
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
            wheelLayout
        }
        .onChange(of: store.pets.count) { _, _ in rebuild() }
        .onChange(of: store.currentSearch?.offers?.count ?? 0) { _, _ in rebuild() }
        .onChange(of: store.currentSearch?.status ?? "") { _, _ in rebuild() }
        .onChange(of: store.auth.stage) { _, _ in rebuild() }
        .onChange(of: store.hasCompletedOnboarding) { _, _ in rebuild() }
        .onChange(of: store.auth.isSignedIn) { _, _ in rebuild() }
    }

    private var wheelLayout: some View {
        ZStack {
            HStack(spacing: 0) {
                if nearTrailing && !needsAuth { menuBar }
                stage
                if !nearTrailing && !needsAuth { menuBar }
            }

            // The wheel, inset from the near edge rather than flush to it.
            if !needsOnboarding {
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

    @ViewBuilder private var stage: some View {
        Group {
            if needsOnboarding {
                OnboardingView(store: store)
            } else if needsAuth {
                DuoAuthStage(auth: store.auth)
            } else {
                DuoStage(navigator: navigator)
            }
        }
            .padding(.horizontal, 36)
            .padding(.vertical, 28)
            // Room for the wheel, so the longest answer never slides under it.
            .padding(nearTrailing ? .trailing : .leading, CGFloat(needsOnboarding ? 0 : 320))
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
        case "auth":
            switch action.id {
            case "send":    Task { await store.auth.submitIdentifier() }
            case "verify":  Task { await store.auth.submitCode() }
            case "restart": store.auth.startOver(); rebuild()
            default:        break
            }

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
        navigator.groups = needsAuth
            ? DuoContent.authGroups(store.auth.stage)
            : DuoContent.groups(for: store, section: section, handedness: handedness)

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
