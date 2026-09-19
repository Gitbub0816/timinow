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
/// There is no separate app and no fold API — the device simply hands the
/// running app a new size. So the decision is made on the horizontal size
/// class, which is `.regular` on an unfolded device and `.compact` on every
/// phone the existing app is built for. The phone UI is untouched: below the
/// threshold this file never renders.
///
/// TIMI_DUO=1 in the scheme's environment forces it on, so the layout can be
/// worked on in an iPad simulator without waiting for fold hardware.
public enum DuoLayout {
    public static var forced: Bool {
        ProcessInfo.processInfo.environment["TIMI_DUO"] == "1"
    }
}

/// The unfolded app.
///
/// A vertical menu bar on the far edge, one question on the stage, and the
/// half wheel inset from the near edge. Nothing scrolls and nothing is
/// hierarchical: the wheel turns through answers, a vertical flick on its hub
/// changes the question, and the hub commits.
public struct DuoRootView: View {
    @Bindable var store: AppStore
    // Internal, not private: Skip cannot bridge a private @State property to
    // Android, and the fold UI is the surface most likely to be wanted on a
    // Z Fold later. Costs nothing to keep the door open.
    @State var navigator: DuoNavigator
    @State var handedness = "right"

    public init(store: AppStore) {
        self.store = store
        let groups = DuoContent.groups(for: store)
        _navigator = State(initialValue: DuoNavigator(groups: groups.isEmpty
                                                      ? DuoContent.sample() : groups))
    }

    private var menuExpanded: Bool { navigator.group.kind == .menu }

    public var body: some View {
        ZStack {
            TimiColor.paper.ignoresSafeArea()

            HStack(spacing: 0) {
                if handedness == "right" { menuBar }
                stage
                if handedness == "left" { menuBar }
            }

            // The wheel, inset from the near edge rather than flush to it.
            HStack {
                if handedness == "right" { Spacer(minLength: 0) }
                DuoWheel(navigator: navigator) { action in
                    take(action)
                }
                .padding(.trailing, CGFloat(handedness == "right" ? 34 : 0))
                .padding(.leading, CGFloat(handedness == "left" ? 34 : 0))
                .padding(.bottom, 28)
                if handedness == "left" { Spacer(minLength: 0) }
            }
            .frame(maxHeight: .infinity, alignment: .bottom)
        }
        // Rebuild the groups when the data behind them changes — the wheel
        // reads groups, so a pet added elsewhere appears here without this
        // view knowing anything about pets.
        .onChange(of: store.pets.count) { _, _ in rebuild() }
    }

    private var menuBar: some View {
        DuoMenuBar(navigator: navigator, expanded: menuExpanded) { action in
            if let index = navigator.groups.firstIndex(where: { $0.kind == .menu }) {
                navigator.groupIndex = index
                if let spot = navigator.group.actions.firstIndex(where: { $0.id == action.id }) {
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
            .padding(handedness == "right" ? .trailing : .leading, 290)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// One place where a committed action turns into something happening.
    /// Deliberately thin for now: the wheel and the groups are the piece worth
    /// getting right first, and wiring each action into the existing store is
    /// a change per action rather than one change.
    private func take(_ action: DuoAction) {
        switch navigator.group.id {
        case "species":
            if let species = PetSpecies(rawValue: action.id) {
                store.draft.pet.species = species
            }
        case "pet":
            if let pet = store.pets.first(where: { $0.id == action.id }) {
                store.draft.pet = pet
            }
        default:
            break
        }
    }

    private func rebuild() {
        let groups = DuoContent.groups(for: store)
        navigator.groups = groups.isEmpty ? DuoContent.sample() : groups
        navigator.groupIndex = min(navigator.groupIndex, max(0, navigator.groups.count - 1))
        navigator.focusIndex = 0
    }
}
