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
    /// The name typed during onboarding, before there is a pet to hang it on.
    @State var petNameDraft = ""

    public init(store: AppStore) {
        self.store = store
        // The first frame has to agree with rebuild() about which phase this
        // is, or the wheel opens holding the wrong question.
        let onboarding = !DuoLayout.forced
            && !store.hasCompletedOnboarding && !store.onboardingSignInRequested
        let signedOut = !onboarding && !DuoLayout.forced
            && store.auth.signInRequired && !store.auth.isSignedIn
        let initial: [DuoGroup]
        if onboarding { initial = DuoContent.onboardingGroups(store) }
        else if signedOut { initial = DuoContent.authGroups(store.auth.stage) }
        else { initial = DuoContent.groups(for: store, section: .find, handedness: "right") }
        _navigator = State(initialValue: DuoNavigator(groups: initial))
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
        .onChange(of: store.onboardingPetIndex) { _, _ in rebuild() }
        .onChange(of: store.auth.isSignedIn) { _, _ in rebuild() }
    }

    private var wheelLayout: some View {
        // A GeometryReader so the crease can be read, and an explicit frame on
        // the content so wrapping the layout in one changes nothing about it —
        // a GeometryReader fills its parent and top-leading aligns its child,
        // which silently re-lays-out anything dropped inside it.
        GeometryReader { proxy in
            panels(creaseInset: DuoHinge.creaseClearance(proxy, fromTrailing: nearTrailing),
                   creased: DuoHinge.isCreased(proxy))
                .frame(width: proxy.size.width, height: proxy.size.height)
        }
    }

    private func panels(creaseInset: CGFloat, creased: Bool) -> some View {
        ZStack {
            HStack(spacing: 0) {
                // The menu is on the NEAR edge, with the wheel. Putting it on
                // the far side was the whole point of the far side being far —
                // and it made the one control that moves between sections the
                // one control a thumb could not reach.
                if !nearTrailing && showsMenu { menuBar }
                stage(creaseInset: creaseInset)
                if nearTrailing && showsMenu { menuBar }
            }

            // The wheel, inset from the near edge rather than flush to it, and
            // inboard of the menu rail so the two never overlap. Present on
            // every screen including onboarding: a six-option species picker
            // is the best thing this control ever gets to do, and hiding it
            // there left the fold app looking like it had no navigation at all.
            HStack {
                if nearTrailing { Spacer(minLength: 0) }
                DuoWheel(navigator: navigator) { action in take(action) }
                    .padding(.trailing, wheelTrailingInset)
                    .padding(.leading, wheelLeadingInset)
                    .padding(.bottom, 28)
                    // Keep the whole control inside the near panel. A wheel
                    // straddling the seam is the worst case of all: the ridge
                    // sits under the thumb mid-sweep.
                    .padding(nearTrailing ? .leading : .trailing,
                             CGFloat(creased ? 12 : 0))
                if !nearTrailing { Spacer(minLength: 0) }
            }
            .frame(maxHeight: .infinity, alignment: .bottom)
        }
    }

    /// The menu rail is a sibling in the HStack, so the wheel — which floats
    /// over everything — has to step around it by hand.
    private var menuRailWidth: CGFloat { showsMenu ? (menuExpanded ? 232 : 66) : 0 }
    private var wheelEdgeInset: CGFloat { 34 + menuRailWidth }
    // Named rather than written inline as a ternary: a bare `0` in a ternary
    // handed to .padding is untyped, and several overloads accept it.
    private var wheelTrailingInset: CGFloat { nearTrailing ? wheelEdgeInset : 0 }
    private var wheelLeadingInset: CGFloat { nearTrailing ? 0 : wheelEdgeInset }

    /// Nothing to navigate to until there is an account and a pet.
    private var showsMenu: Bool { !needsOnboarding && !needsAuth }

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

    /// The stage keeps clear of the crease.
    ///
    /// It already leaves room on the near side for the wheel; when the device
    /// is partially folded and the crease sits further in than that, the
    /// clearance grows to match. Nothing is laid across the seam, and when the
    /// device is flat the reserved region is inactive and this is exactly the
    /// spacing it always was.
    @ViewBuilder private func stage(creaseInset: CGFloat) -> some View {
        let wheelRoom: CGFloat = 320 + menuRailWidth
        let nearInset = max(wheelRoom, creaseInset > 0 ? creaseInset + 24 : 0)

        Group {
            if needsOnboarding && store.onboardingPetIndex < 0 {
                DuoNameStage(name: $petNameDraft)
            } else if needsOnboarding {
                // The species question renders like any other: the wheel holds
                // the six answers, the stage shows the one in focus.
                DuoStage(navigator: navigator)
            } else if needsAuth {
                DuoAuthStage(auth: store.auth)
            } else {
                DuoStage(navigator: navigator)
            }
        }
            .padding(.horizontal, 36)
            .padding(.vertical, 28)
            // Room for the wheel, so the longest answer never slides under it.
            .padding(nearTrailing ? .trailing : .leading, nearInset)
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
        case "onbName":
            store.beginOnboardingDetails(names: [petNameDraft])
            rebuild()

        case "onbSpecies":
            guard let species = PetSpecies(rawValue: action.id) else { return }
            store.recordOnboardingPet(species: species, breed: "", sex: "",
                                      weightLbs: nil, birthYear: nil,
                                      medications: "", allergies: "")
            if store.onboardingIsLastPet { store.completeOnboarding() }
            else { store.advanceOnboardingPet() }
            rebuild()

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
        if needsOnboarding {
            navigator.groups = DuoContent.onboardingGroups(store)
        } else if needsAuth {
            navigator.groups = DuoContent.authGroups(store.auth.stage)
        } else {
            navigator.groups = DuoContent.groups(for: store, section: section,
                                                 handedness: handedness)
        }

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
