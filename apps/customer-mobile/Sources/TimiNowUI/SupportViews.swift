import Foundation
import Observation
import TimiNowCore
#if os(Android)
import SkipFuseUI
#else
import SwiftUI
#endif

struct PetsView: View {
    @Bindable var store: AppStore
    @State private var showEditor = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack { VStack(alignment: .leading) { Eyebrow(text: "CARE COMPANIONS"); Text("Your pets").font(.system(size: 40, weight: .bold, design: .serif)) }; Spacer(); Button { showEditor = true } label: { Image(systemName: "plus").font(.title3).frame(width: 44, height: 44).background(TimiColor.coral, in: Circle()).foregroundStyle(.white).overlay(Circle().stroke(TimiColor.ink, lineWidth: 2)) } }
                ForEach(store.pets) { pet in
                    Button { store.choosePet(pet.id) } label: {
                        HStack(spacing: 15) { Image(systemName: pet.species.icon).font(.title).foregroundStyle(.white).frame(width: 62, height: 62).background(pet.colorToken % 2 == 0 ? TimiColor.blue : TimiColor.coral, in: RoundedRectangle(cornerRadius: 19)); VStack(alignment: .leading, spacing: 4) { Text(pet.name).font(.title3).fontWeight(.black); Text([pet.breed, pet.weightLbs.map { String(format: "%.0f lb", $0) }].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")).font(.caption).foregroundStyle(TimiColor.muted) }; Spacer(); Image(systemName: store.selectedPetId == pet.id ? "checkmark.circle.fill" : "circle").font(.title2).foregroundStyle(TimiColor.blue) }.timiCard(store.selectedPetId == pet.id ? TimiColor.blueSoft : .white)
                    }.buttonStyle(.plain)
                }
                Text("Pet profiles speed operational intake. Medical records are never sent unless you explicitly include them in a future supported flow.").font(.caption).foregroundStyle(TimiColor.muted)
            }.padding(20)
        }.background(TimiColor.canvas).navigationTitle("Pets").navigationBarTitleDisplayMode(.inline).sheet(isPresented: $showEditor) { PetEditor(store: store, isPresented: $showEditor) }
    }
}

private struct PetEditor: View {
    @Bindable var store: AppStore
    @Binding var isPresented: Bool
    @State private var name = ""
    @State private var species: PetSpecies = .dog
    @State private var breed = ""
    @State private var weight = ""
    var body: some View {
        NavigationStack { Form { Section("Pet") { TextField("Name", text: $name); Picker("Species", selection: $species) { ForEach(PetSpecies.allCases, id: \.self) { Text($0.title).tag($0) } }; TextField("Breed", text: $breed); TextField("Weight in pounds", text: $weight) } Section { Text("Profiles are stored on this device while accounts are disabled.").font(.caption).foregroundStyle(TimiColor.muted) } }.navigationTitle("Add a pet").toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { isPresented = false } }; ToolbarItem(placement: .confirmationAction) { Button("Save") { store.savePet(PetProfile(name: name, species: species, breed: breed, weightLbs: Double(weight), colorToken: store.pets.count)); isPresented = false }.disabled(name.trimmingCharacters(in: .whitespaces).isEmpty) } } }
    }
}

struct ActivityView: View {
    @Bindable var store: AppStore
    var body: some View {
        ScrollView { VStack(alignment: .leading, spacing: 18) { Eyebrow(text: "CARE HISTORY"); Text("Recent activity").font(.system(size: 40, weight: .bold, design: .serif)); if store.history.isEmpty { VStack(spacing: 14) { Image(systemName: "clock.badge.questionmark").font(.system(size: 45)).foregroundStyle(TimiColor.blue); Text("No completed searches yet").font(.title3).fontWeight(.black); Text("Selected clinics and arrival progress will appear here.").font(.caption).foregroundStyle(TimiColor.muted) }.frame(maxWidth: .infinity).padding(.vertical, 50).timiCard(.white) } else { ForEach(store.history) { item in HStack(spacing: 13) { Image(systemName: "checkmark.seal.fill").font(.title2).foregroundStyle(TimiColor.blue); VStack(alignment: .leading) { Text("\(item.petName) · \(item.clinicName)").fontWeight(.bold); Text(item.status.replacingOccurrences(of: "_", with: " ").capitalized).font(.caption).foregroundStyle(TimiColor.muted) }; Spacer() }.timiCard(.white) } } }.padding(20) }.background(TimiColor.canvas).navigationTitle("Activity").navigationBarTitleDisplayMode(.inline)
    }
}

struct SettingsView: View {
    @Bindable var store: AppStore
    var body: some View {
        Form {
            Section("Connection") { TextField("https://your-worker.workers.dev", text: $store.apiBaseURLText).textInputAutocapitalization(.never).autocorrectionDisabled(); Button("Save API address") { store.saveAPIBaseURL() }; LabeledContent("Mode", value: store.isDemoMode ? "Interactive demo" : "Live Worker") }
            Section("Permissions") { Toggle("Offer notifications", isOn: $store.notificationsEnabled); Toggle("Use precise location", isOn: $store.locationEnabled) }
            Section("Legal and support") { NavigationLink("Terms, privacy, and veterinary safety") { LegalView() }; Link("Privacy requests", destination: URL(string: "mailto:privacy@clearkey.solutions")!); Link("Billing support", destination: URL(string: "mailto:billing@clearkey.solutions")!) }
            Section("Development") { Button("Replay guided onboarding") { store.resetOnboarding() }; Text("Authentication remains controlled by the Worker's exact SIGN_IN_REQUIRED flag. The app operates in fixture mode until a valid HTTPS Worker URL is saved.").font(.caption).foregroundStyle(TimiColor.muted) }
        }.navigationTitle("Settings")
    }
}

struct LegalView: View {
    var body: some View {
        ScrollView { VStack(alignment: .leading, spacing: 22) {
            Eyebrow(text: "EFFECTIVE AUGUST 21, 2026"); Text("Legal and safety").font(.system(size: 40, weight: .bold, design: .serif))
            legalSection("Tími is not veterinary care", "Tími provides technology for locating participating veterinary facilities, displaying reported intake capacity, sharing structured operational intake, and comparing availability offers. Tími does not diagnose, prescribe, recommend treatment, create a veterinarian-client-patient relationship, guarantee care, or replace clinical triage.")
            legalSection("No promise of care or priority", "A listing, reported status, offer, estimated wait, or arrival window is not a guaranteed appointment or examination time. Capacity can change. The independent clinic decides whether and when to examine or treat an animal, and critical patients may be seen first.")
            legalSection("Information sharing", "Your structured intake may be shared with up to 30 matching participating clinics, including clinics you do not select, so they can evaluate current capacity. Tími displays up to five active offers. Only the clinic you choose is confirmed. Service providers may process data for hosting, authentication, communications, security, analytics, and payments.")
            legalSection("Deposits and veterinary charges", "When a clinic requires a deposit, its amount, policy version, cancellation, refund, and no-show rules are shown before payment. Unless that displayed policy says otherwise, the deposit is credited to the clinic invoice. The clinic bills remaining veterinary charges and handles insurance. Tími does not submit insurance claims.")
            legalSection("Emergency safety", "Do not wait for Tími if your animal may be in immediate danger. Travel to the nearest appropriate emergency-capable veterinary facility while someone calls ahead. For suspected poisoning, contact a veterinarian or recognized animal poison-control service immediately.")
            legalSection("Operator and contact", "Tími NOW is operated by ClearKey Solutions, LLC in Hayward, California. California law governs the service to the extent permitted. Contact legal@clearkey.solutions or privacy@clearkey.solutions for applicable requests.")
        }.padding(20).padding(.bottom, 40) }.background(TimiColor.paper).navigationTitle("Legal").navigationBarTitleDisplayMode(.inline)
    }
    private func legalSection(_ title: String, _ text: String) -> some View { VStack(alignment: .leading, spacing: 8) { Text(title).font(.title3).fontWeight(.black); Text(text).font(.callout).foregroundStyle(TimiColor.muted).lineSpacing(4) } }
}
