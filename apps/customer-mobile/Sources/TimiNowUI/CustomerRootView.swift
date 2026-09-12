import Foundation
import Observation
import TimiNowCore
#if os(Android)
import SkipFuseUI
#else
import SwiftUI
#endif

public struct CustomerRootView: View {
    @Bindable var store: AppStore
    public init(store: AppStore) { self.store = store }

    public var body: some View {
        ZStack(alignment: .top) {
            // Onboarding runs BEFORE sign-in now: a stranger is asked their
            // pet's name, not their email address, and the magic-code screen
            // arrives as the flow's natural last step. A subtle reordering —
            // better for conversion. Signed-in people never see any of it,
            // and a signed-out person who already finished onboarding on this
            // device lands straight on the auth step with their pets intact.
            if store.auth.signInRequired && !store.auth.isSignedIn {
                if store.hasCompletedOnboarding || store.onboardingSignInRequested {
                    SignInView(
                        auth: store.auth,
                        // Warm last-step wording only when onboarding just
                        // delivered pets here; the "Sign in" skip and a plain
                        // signed-out relaunch keep the ordinary copy.
                        handoff: store.hasCompletedOnboarding && store.hasPet,
                        handoffPetName: store.pets.first?.name ?? ""
                    ).transition(.opacity)
                } else {
                    OnboardingView(store: store)
                }
            }
            else { appContent.transition(.opacity) }
            if let error = store.errorMessage { ErrorToast(message: error) { store.errorMessage = nil }.padding(.top, 8).transition(.move(edge: .top).combined(with: .opacity)).zIndex(20) }
            if store.showCelebration { CelebrationOverlay().onAppear { Task { try? await Task.sleep(for: .seconds(1.15)); store.showCelebration = false } }.zIndex(30) }
        }
        .animation(.easeInOut(duration: 0.25), value: store.errorMessage != nil)
        // Mounted at the root, not on each banner: the button appears on the
        // home screen, the search screen and the intake form, and an emergency
        // list that vanishes because the screen underneath it changed would be
        // worse than not offering one.
        .sheet(isPresented: $store.showEmergencyList) { EmergencyCareSheet(store: store) }
        // MapboxMaps reads one process-wide access token, and every map pane
        // in the app - offers, tracker, live navigation - traps fatally if it
        // renders before that global is set. The token arrives from
        // /api/config after launch, so it is applied the moment it exists and
        // re-applied if it ever changes. No-op on builds without Mapbox.
        .task { TimiMapboxToken.apply(store.mapToken) }
        .onChange(of: store.mapToken) { token in TimiMapboxToken.apply(token) }
        // Silent — no prompt, no change to store.notificationsEnabled — so a
        // phone that already granted notification permission in an earlier
        // session keeps registering a fresh APNs token every cold start
        // rather than only when the Settings toggle happens to be flipped
        // again this launch. See PlatformPermissions.reregisterIfAlreadyAuthorized.
        .task { _ = await PlatformPermissions.reregisterIfAlreadyAuthorized() }
        // An active search or booked visit survives the app being killed:
        // once auth has settled, the persisted care flow (if any) is
        // re-fetched from the Worker and the app reopens on the tracker or
        // the search screen instead of home. See AppStore.restoreCareFlowIfNeeded.
        .task { await store.restoreCareFlowIfNeeded() }
    }

    /// One container owns every route change. Each screen sits on its own
    /// opaque canvas with a fixed z-order (deeper flow stages above home), so
    /// while a transition is in flight the two mounted screens layer
    /// deterministically instead of drawing through each other — which is how
    /// the tracker's headline used to render twice, one of them up at the
    /// status bar. The `.animation(value:)` on the container is what actually
    /// drives the transitions: `store.route` changes from async store methods
    /// with no `withAnimation` in reach, and before this container those
    /// changes animated only when some caller happened to wrap them.
    var appContent: some View {
        ZStack {
            switch store.route {
            case .home:
                // The same delayed-fade container transition as the flow
                // screens: without it, home's default instant crossfade let
                // its canvas cover the outgoing tracker's exit flight on the
                // way back.
                homeTabs
                    .timiScreenTransition()
                    .zIndex(0)
            case .intake:
                IntakeFlowView(store: store)
                    .background(TimiColor.canvas.ignoresSafeArea())
                    .timiScreenTransition()
                    .zIndex(1)
            case .searching:
                OfferSearchView(store: store)
                    .background(TimiColor.canvas.ignoresSafeArea())
                    .timiScreenTransition()
                    .zIndex(2)
            case .tracker:
                TrackerView(store: store)
                    .background(TimiColor.canvas.ignoresSafeArea())
                    .timiScreenTransition()
                    .zIndex(3)
            }
        }
        .animation(TimiScreenChange.animation, value: store.route)
    }

    /// The home screen's four tabs behind Tími's own bar (Components.swift's
    /// `TimiTabBar`) instead of the system `TabView`. All four stay mounted —
    /// exactly what `TabView` did — so switching tabs keeps each stack's
    /// pushed screens and scroll positions; the inactive ones are invisible,
    /// untouchable, and hidden from accessibility.
    var homeTabs: some View {
        // The bar lives in the bottom safe area on Apple platforms, so every
        // tab's scroll view is inset by exactly its height: content taller
        // than the screen clears it automatically, and content that fits no
        // longer needs — or gets — an artificial 112pt pad to scroll into.
        // Android keeps the overlay + fixed clearance until Skip proves
        // safeAreaInset.
        #if os(Android)
        ZStack(alignment: .bottom) {
            tabStack
            TimiTabBar(selection: $store.selectedTab)
        }
        .background(TimiColor.canvas.ignoresSafeArea())
        #else
        tabStack
            .safeAreaInset(edge: .bottom) { TimiTabBar(selection: $store.selectedTab) }
            .background(TimiColor.canvas.ignoresSafeArea())
        #endif
    }

    var tabStack: some View {
        ZStack {
            homeTab(0) { NavigationStack { HomeView(store: store) } }
            homeTab(1) { NavigationStack { PetsView(store: store) } }
            homeTab(2) { NavigationStack { ActivityView(store: store) } }
            homeTab(3) { NavigationStack { SettingsView(store: store) } }
        }
        .animation(.easeInOut(duration: 0.18), value: store.selectedTab)
    }

    func homeTab(_ index: Int, @ViewBuilder content: () -> some View) -> some View {
        let active = store.selectedTab == index
        return content()
            .opacity(Double(active ? 1 : 0))
            .allowsHitTesting(active)
            .accessibilityHidden(!active)
            .zIndex(active ? 1 : 0)
    }
}

struct HomeView: View {
    @Bindable var store: AppStore
    var body: some View {
        ScrollView {
            // The `timiMorph` indices choreograph route changes: leaving for
            // the intake flow, these blocks scatter off in alternating
            // directions top-to-bottom, and coming home they slide back in
            // the same order. See TimiMorph in Components.swift.
            VStack(alignment: .leading, spacing: 22) {
                HStack { TimiWordmark(compact: true); Spacer(); Button { store.selectedTab = 1 } label: { Image(systemName: store.hasPet ? store.selectedPet.species.icon : "plus").font(.title3).foregroundStyle(.white).frame(width: 44, height: 44).background(TimiColor.blue, in: Circle()).overlay(Circle().stroke(TimiColor.ink, lineWidth: 2)) } }
                    .timiMorph(0)
                VStack(alignment: .leading, spacing: 8) {
                    Eyebrow(text: store.isDemoMode ? "INTERACTIVE DEMO" : "LIVE NETWORK", color: TimiColor.blue)
                    // No pet yet is a real state, not something to paper over
                    // with a sample animal's name.
                    DisplayHeadline(text: store.hasPet ? "Who can see\n\(store.selectedPet.name) now?" : "Who are we\nfinding care for?", size: 45)
                    Text(store.hasPet
                        ? "Tell us what's happening once. Compare current responses before you leave home."
                        : "Add your pet once and Tími keeps them with your account. It takes about twenty seconds.")
                        .font(.title3).foregroundStyle(TimiColor.muted)
                }
                .timiMorph(1)
                if store.hasPet {
                    CareLaunchPanel(petName: store.selectedPet.name).timiCard(TimiColor.paper).timiMorph(2)
                    // No local withAnimation: the route container in
                    // CustomerRootView animates every route change the same
                    // way, and a second animation here fought it.
                    Button { store.beginCare() } label: { Label("Find care for \(store.selectedPet.name)", systemImage: "arrow.right") }.buttonStyle(TimiPrimaryButtonStyle()).timiMorph(3)
                } else {
                    Button { store.selectedTab = 1 } label: { Label("Add your pet", systemImage: "plus") }.buttonStyle(TimiPrimaryButtonStyle()).timiMorph(2)
                }
                HStack(spacing: 12) { MetricChip(title: "One intake", value: "Up to 30 clinics"); MetricChip(title: "Your choice", value: "Up to 5 offers", color: TimiColor.goldSoft) }.timiMorph(4)
                SafetyBanner(compact: true, store: store).timiMorph(5)
                VStack(alignment: .leading, spacing: 12) { Eyebrow(text: "HOW TÍMI WORKS"); processRow(1, "Describe what you observe", "Rules prevent vague requests before anything is shared."); processRow(2, "Clinics answer with live capacity", "Each response includes timing, wait, deposit, and offer hold."); processRow(3, "Choose the best fit", "Only your selected clinic is confirmed; every other offer is released.") }.timiCard(TimiColor.paper).timiMorph(6)
            // Enough clearance for the tab bar, which floats over the scroll
            // view rather than shortening it — the last card was rendering
            // behind it. Capped and centered so a fold-open or landscape
            // width reads as a comfortable column, not a wall of full-width
            // cards.
            }.padding(20).timiTabScrollClearance()
                .frame(maxWidth: 720)
                .frame(maxWidth: .infinity)
        }.timiScrollFits().background(TimiColor.canvas)
    }

    func processRow(_ number: Int, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 13) { Text("\(number)").font(.system(size: 16, weight: .black, design: .serif)).frame(width: 36, height: 36).background(number == 2 ? TimiColor.coral : TimiColor.gold, in: Circle()).overlay(Circle().stroke(TimiColor.ink, lineWidth: 2)); VStack(alignment: .leading, spacing: 3) { Text(title).fontWeight(.bold); Text(detail).font(.caption).foregroundStyle(TimiColor.muted) } }
    }
}
