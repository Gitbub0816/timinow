import Foundation
import Observation
import TimiNowCore
#if os(Android)
import SkipFuseUI
#else
import SwiftUI
#endif

struct OnboardingView: View {
    @Bindable var store: AppStore
    @State var petName = ""
    @State var species: PetSpecies = .dog
    @State var direction = 1

    var body: some View {
        ZStack {
            TimiColor.paper.ignoresSafeArea()
            VStack(spacing: 0) {
                HStack { TimiWordmark(compact: true); Spacer(); ProgressPills(current: store.onboardingPage, total: 4) }.padding(.horizontal, 24).padding(.top, 12)
                ZStack { page.transition(.asymmetric(insertion: .move(edge: direction > 0 ? .trailing : .leading).combined(with: .opacity), removal: .move(edge: direction > 0 ? .leading : .trailing).combined(with: .opacity))) }
                    .id(store.onboardingPage).animation(.spring(response: 0.48, dampingFraction: 0.84), value: store.onboardingPage)
                HStack(spacing: 12) {
                    if store.onboardingPage > 0 { Button("Back") { move(-1) }.buttonStyle(TimiQuietButtonStyle()) }
                    Button(store.onboardingPage == 3 ? "Start with Tími" : "Continue") {
                        if store.onboardingPage == 3 { store.completeOnboarding(name: petName.trimmingCharacters(in: .whitespaces), species: species) } else { move(1) }
                    }.buttonStyle(TimiPrimaryButtonStyle()).disabled(store.onboardingPage == 2 && petName.trimmingCharacters(in: .whitespaces).isEmpty)
                }.padding(24)
            }
        }
    }

    @ViewBuilder var page: some View {
        switch store.onboardingPage {
        case 0:
            VStack(spacing: 12) { Spacer(); Eyebrow(text: "LIVE VETERINARY INTAKE"); Text("Less calling.\nFaster answers.").font(.system(size: 47, weight: .bold, design: .serif)).multilineTextAlignment(.center).foregroundStyle(TimiColor.ink); CareCompanionArtwork(); Text("Tími finds participating clinics that can actually consider your pet now—not tomorrow's calendar.").font(.title3).foregroundStyle(TimiColor.muted).multilineTextAlignment(.center).padding(.horizontal, 30); Spacer() }
        case 1:
            VStack(spacing: 20) { Spacer(); PulsingBeacon(symbol: "wave.3.right"); Eyebrow(text: "ONE INTAKE · MULTIPLE ANSWERS"); Text("Compare up to five\nreal offers.").font(.system(size: 42, weight: .bold, design: .serif)).multilineTextAlignment(.center); Text("We can ask up to 30 matching clinics. Nothing is booked until you choose the response that works best for you.").font(.title3).foregroundStyle(TimiColor.muted).multilineTextAlignment(.center).padding(.horizontal, 30); HStack { MetricChip(title: "Contacted", value: "Up to 30"); MetricChip(title: "Compare", value: "Up to 5", color: TimiColor.goldSoft) }.padding(.horizontal, 24); Spacer() }
        case 2:
            ScrollView { VStack(alignment: .leading, spacing: 20) { Spacer(minLength: 28); Eyebrow(text: "FIRST, WHO ARE WE HELPING?"); Text("Meet your care companion.").font(.system(size: 40, weight: .bold, design: .serif)); Text("We'll use this to make urgent intake faster. You can add medical details later.").foregroundStyle(TimiColor.muted); TextField("Pet's name", text: $petName).textFieldStyle(.roundedBorder).font(.title2).padding(.vertical, 8); Text("Species").font(.headline); LazyVGrid(columns: [GridItem(.adaptive(minimum: 94))], spacing: 12) { ForEach(PetSpecies.allCases, id: \.self) { item in Button { species = item } label: { VStack(spacing: 8) { Image(systemName: item.icon).font(.title2); Text(item.title).font(.caption).fontWeight(.bold) }.frame(maxWidth: .infinity, minHeight: 76).background(species == item ? TimiColor.blueSoft : .white, in: RoundedRectangle(cornerRadius: 16)).overlay(RoundedRectangle(cornerRadius: 16).stroke(species == item ? TimiColor.blue : TimiColor.ink.opacity(0.15), lineWidth: species == item ? 2 : 1)) }.buttonStyle(.plain) } } }.padding(24) }
        default:
            VStack(alignment: .leading, spacing: 22) { Spacer(); Eyebrow(text: "YOU STAY IN CONTROL"); Text("Ready when the\nunexpected happens.").font(.system(size: 42, weight: .bold, design: .serif)); permissionRow("location.fill", "Nearby care", "Location is used only to find care and estimate travel.", enabled: store.locationEnabled) { Task { store.locationEnabled = await PlatformPermissions.requestLocation(); if let point = await PlatformPermissions.currentLocation() { store.setLocation(latitude: point.0, longitude: point.1) } } }; permissionRow("bell.badge.fill", "Offer updates", "Get notified when a clinic responds.", enabled: store.notificationsEnabled) { Task { store.notificationsEnabled = await PlatformPermissions.requestNotifications() } }; SafetyBanner(); Text("Tími routes operational intake and does not diagnose, practice veterinary medicine, guarantee care, or replace a veterinarian. Clinic capacity and waits can change.").font(.caption).foregroundStyle(TimiColor.muted); Spacer() }.padding(24)
        }
    }

    func permissionRow(_ symbol: String, _ title: String, _ detail: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) { HStack(spacing: 14) { Image(systemName: enabled ? "checkmark.circle.fill" : symbol).font(.title2).foregroundStyle(enabled ? TimiColor.blue : TimiColor.coral).frame(width: 36); VStack(alignment: .leading) { Text(title).fontWeight(.bold); Text(detail).font(.caption).foregroundStyle(TimiColor.muted) }; Spacer(); Text(enabled ? "Ready" : "Enable").font(.caption).fontWeight(.black).foregroundStyle(TimiColor.blue) }.padding(15).background(.white, in: RoundedRectangle(cornerRadius: 18)).overlay(RoundedRectangle(cornerRadius: 18).stroke(TimiColor.ink.opacity(0.15))) }.buttonStyle(.plain)
    }

    func move(_ delta: Int) { direction = delta; withAnimation { store.onboardingPage = min(3, max(0, store.onboardingPage + delta)) } }
}
