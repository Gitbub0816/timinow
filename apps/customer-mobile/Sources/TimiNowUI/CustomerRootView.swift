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
            if !store.hasCompletedOnboarding { OnboardingView(store: store) }
            else { appContent.transition(.opacity) }
            if let error = store.errorMessage { ErrorToast(message: error) { store.errorMessage = nil }.padding(.top, 8).transition(.move(edge: .top).combined(with: .opacity)).zIndex(20) }
            if store.showCelebration { CelebrationOverlay().onAppear { Task { try? await Task.sleep(for: .seconds(1.15)); store.showCelebration = false } }.zIndex(30) }
        }.animation(.easeInOut(duration: 0.25), value: store.errorMessage != nil)
    }

    @ViewBuilder var appContent: some View {
        switch store.route {
        case .intake: IntakeFlowView(store: store).transition(.move(edge: .trailing))
        case .searching: OfferSearchView(store: store).transition(.opacity)
        case .tracker: TrackerView(store: store).transition(.move(edge: .trailing))
        case .home:
            TabView(selection: $store.selectedTab) {
                NavigationStack { HomeView(store: store) }.tabItem { Label("Care", systemImage: "cross.case.fill") }.tag(0)
                NavigationStack { PetsView(store: store) }.tabItem { Label("Pets", systemImage: "pawprint.fill") }.tag(1)
                NavigationStack { ActivityView(store: store) }.tabItem { Label("Activity", systemImage: "clock.arrow.circlepath") }.tag(2)
                NavigationStack { SettingsView(store: store) }.tabItem { Label("Settings", systemImage: "gearshape.fill") }.tag(3)
            }.tint(TimiColor.blue)
        }
    }
}

struct HomeView: View {
    @Bindable var store: AppStore
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HStack { TimiWordmark(compact: true); Spacer(); Button { store.selectedTab = 1 } label: { Image(systemName: store.selectedPet.species.icon).font(.title3).foregroundStyle(.white).frame(width: 44, height: 44).background(TimiColor.blue, in: Circle()).overlay(Circle().stroke(TimiColor.ink, lineWidth: 2)) } }
                VStack(alignment: .leading, spacing: 8) { Eyebrow(text: store.isDemoMode ? "INTERACTIVE DEMO" : "LIVE NETWORK", color: TimiColor.blue); Text("Who can see\n\(store.selectedPet.name) now?").font(.system(size: 45, weight: .bold, design: .serif)).foregroundStyle(TimiColor.ink); Text("Tell us what's happening once. Compare current responses before you leave home.").font(.title3).foregroundStyle(TimiColor.muted) }
                CareLaunchPanel(petName: store.selectedPet.name).timiCard(TimiColor.paper)
                Button { withAnimation(.spring(response: 0.42)) { store.beginCare() } } label: { Label("Find care for \(store.selectedPet.name)", systemImage: "arrow.right") }.buttonStyle(TimiPrimaryButtonStyle())
                HStack(spacing: 12) { MetricChip(title: "One intake", value: "Up to 30 clinics"); MetricChip(title: "Your choice", value: "Up to 5 offers", color: TimiColor.goldSoft) }
                SafetyBanner(compact: true)
                VStack(alignment: .leading, spacing: 12) { Eyebrow(text: "HOW TÍMI WORKS"); processRow(1, "Describe what you observe", "Rules prevent vague requests before anything is shared."); processRow(2, "Clinics answer with live capacity", "Each response includes timing, wait, deposit, and offer hold."); processRow(3, "Choose the best fit", "Only your selected clinic is confirmed; every other offer is released.") }.timiCard(TimiColor.paper)
            }.padding(20).padding(.bottom, 20)
        }.background(TimiColor.canvas)
    }

    func processRow(_ number: Int, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 13) { Text("\(number)").font(.system(size: 16, weight: .black, design: .serif)).frame(width: 36, height: 36).background(number == 2 ? TimiColor.coral : TimiColor.gold, in: Circle()).overlay(Circle().stroke(TimiColor.ink, lineWidth: 2)); VStack(alignment: .leading, spacing: 3) { Text(title).fontWeight(.bold); Text(detail).font(.caption).foregroundStyle(TimiColor.muted) } }
    }
}
