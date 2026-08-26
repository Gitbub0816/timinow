import Foundation
import Observation
import TimiNowCore
#if os(Android)
import SkipFuseUI
#else
import SwiftUI
#endif

/// The pre-auth welcome. It used to open with two screens about Tími and end
/// on a sign-in wall; now the first question is the pet's name, every named
/// pet gets one detail page, and the magic-code sign-in arrives as the
/// natural last step — the account is where the pets just described get kept.
/// A subtle reordering, and a deliberate one: nobody is asked for an email
/// before they have been asked about their animal.
///
/// Progress lives in AppStore (`onboardingNames` / `onboardingPetIndex`) and
/// is persisted between screens, so an app killed mid-flow resumes where it
/// stood. Pets are written through `savePet` the moment their page is done,
/// which is the same device-local storage the post-sign-in sync uploads from.
struct OnboardingView: View {
    @Bindable var store: AppStore

    var body: some View {
        ZStack {
            TimiColor.paper.ignoresSafeArea()
            VStack(spacing: 0) {
                header
                ZStack {
                    if store.onboardingPetIndex < 0 {
                        OnboardingNamesPage(store: store)
                            .transition(.asymmetric(insertion: .move(edge: .leading).combined(with: .opacity), removal: .move(edge: .leading).combined(with: .opacity)))
                    } else {
                        OnboardingPetPage(store: store)
                            // A fresh page per pet, so the second pet's form
                            // does not open pre-filled with the first one's
                            // breed and weight.
                            .id(store.onboardingPetIndex)
                            .transition(.asymmetric(insertion: .move(edge: .trailing).combined(with: .opacity), removal: .move(edge: .leading).combined(with: .opacity)))
                    }
                }
                .animation(.spring(response: 0.48, dampingFraction: 0.84), value: store.onboardingPetIndex)
            }
        }
    }

    /// Wordmark left, "Sign in" right — the skip for people who already have
    /// an account, present on every onboarding screen.
    var header: some View {
        HStack {
            TimiWordmark(compact: true)
            Spacer()
            Button {
                store.onboardingSignInRequested = true
            } label: {
                Text("Sign in")
                    .font(.system(size: 14, weight: .black))
                    .foregroundStyle(TimiColor.blue)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(Color.white, in: Capsule())
                    .overlay(Capsule().stroke(TimiColor.ink.faded(0.25)))
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 24)
        .padding(.top, 12)
    }
}

/// Screen one: "What is your pet's name?", with a field per pet and a button
/// that adds another — capped, politely, at AppStore.onboardingPetLimit.
struct OnboardingNamesPage: View {
    @Bindable var store: AppStore
    @State var names: [String] = [""]
    @State var showingCapNote = false

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Spacer(minLength: 24)
                    Eyebrow(text: "WELCOME TO TÍMI")
                    Text("What is your\npet's name?")
                        .font(.system(size: 44, weight: .bold, design: .serif))
                        .foregroundStyle(TimiColor.ink)
                    Text("Tími asks real clinics who can see your pet now — and it starts with a name.")
                        .font(.title3)
                        .foregroundStyle(TimiColor.muted)
                    ForEach(names.indices, id: \.self) { index in
                        TextField(index == 0 ? "Pet's name" : "Another pet's name", text: Binding(
                            get: { index < names.count ? names[index] : "" },
                            set: { value in if index < names.count { names[index] = value } }
                        ))
                        .autocorrectionDisabled()
                        .timiField()
                    }
                    Button { addNameField() } label: {
                        Label("I have another pet", systemImage: "plus")
                    }
                    .buttonStyle(TimiQuietButtonStyle())
                    if showingCapNote {
                        Text("Ninety-nine pets is where we stop — and honestly, hats off to your household. Start with these and add the rest from the Pets tab later.")
                            .font(.caption)
                            .foregroundStyle(TimiColor.coral)
                    }
                    CareCompanionArtwork(compact: true)
                        .frame(maxWidth: .infinity)
                    Spacer(minLength: 10)
                }
                .padding(24)
            }
            Button {
                store.beginOnboardingDetails(names: names)
            } label: {
                Label("Continue", systemImage: "arrow.right")
            }
            .buttonStyle(TimiPrimaryButtonStyle())
            .disabled(!hasAtLeastOneName)
            .padding(24)
        }
    }

    var hasAtLeastOneName: Bool {
        names.contains { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    }

    func addNameField() {
        guard names.count < AppStore.onboardingPetLimit else {
            showingCapNote = true
            return
        }
        withAnimation(.spring(response: 0.35)) { names.append("") }
    }
}

/// One page per named pet: species, breed, weight, age, and the two optional
/// notes the profile keeps — exactly the fields the Pet model stores, nothing
/// invented for this screen.
struct OnboardingPetPage: View {
    @Bindable var store: AppStore
    @State var species: PetSpecies = .dog
    @State var breed = ""
    @State var sex = ""
    @State var weight = ""
    @State var age = ""
    @State var medications = ""
    @State var allergies = ""

    var petName: String { store.onboardingPetName ?? "your pet" }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Spacer(minLength: 20)
                    Eyebrow(text: store.onboardingNames.count > 1
                        ? "PET \(store.onboardingPetIndex + 1) OF \(store.onboardingNames.count)"
                        : "ABOUT YOUR PET")
                    Text("Tell us about\n\(petName).")
                        .font(.system(size: 40, weight: .bold, design: .serif))
                        .foregroundStyle(TimiColor.ink)
                    Text("A little context helps clinics answer faster. Only the species is required — everything else can wait.")
                        .foregroundStyle(TimiColor.muted)

                    speciesGrid

                    labeled("Breed") {
                        TextField("Optional", text: $breed).timiField()
                    }
                    labeled("Sex") {
                        HStack(spacing: 10) {
                            sexChip("male", "Male")
                            sexChip("female", "Female")
                            sexChip("unknown", "Not sure")
                        }
                    }
                    HStack(alignment: .top, spacing: 12) {
                        labeled("Weight (lbs)") {
                            TextField("Optional", text: $weight).timiKeyboard(.decimal).timiField()
                        }
                        labeled("Age (years)") {
                            TextField("Optional", text: $age).timiKeyboard(.number).timiField()
                        }
                    }

                    VStack(alignment: .leading, spacing: 10) {
                        Eyebrow(text: "OPTIONAL — MEDICATIONS AND ALLERGIES")
                        TextField("Medications", text: $medications).timiField()
                        TextField("Allergies", text: $allergies).timiField()
                        Text("Shared with the clinics your care request reaches, exactly as you write it. Tími is not a medical record — leave these blank if you would rather not.")
                            .font(.caption)
                            .foregroundStyle(TimiColor.muted)
                    }
                    .timiCard(Color.white)
                    Spacer(minLength: 10)
                }
                .padding(24)
            }
            Button {
                saveAndContinue()
            } label: {
                Label(store.onboardingIsLastPet ? "Continue" : "Next: \(nextPetName)", systemImage: "arrow.right")
            }
            .buttonStyle(TimiPrimaryButtonStyle())
            .padding(24)
        }
    }

    var speciesGrid: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Species").font(.headline)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 94))], spacing: 12) {
                ForEach(PetSpecies.allCases, id: \.self) { item in
                    Button { species = item } label: {
                        VStack(spacing: 8) {
                            Image(systemName: item.icon).font(.title2)
                            Text(item.title).font(.caption).fontWeight(.bold)
                        }
                        .frame(maxWidth: .infinity, minHeight: 76)
                        .background(species == item ? TimiColor.blueSoft : .white, in: RoundedRectangle(cornerRadius: 16))
                        .overlay(RoundedRectangle(cornerRadius: 16).stroke(species == item ? TimiColor.blue : TimiColor.ink.faded(0.15), lineWidth: CGFloat(species == item ? 2 : 1)))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    var nextPetName: String {
        let next = store.onboardingPetIndex + 1
        guard next >= 0, next < store.onboardingNames.count else { return "" }
        return store.onboardingNames[next]
    }

    /// The model stores a birth year; the screen asks an age, because "she's
    /// four" is how anybody actually knows it.
    var birthYear: Int? {
        guard let years = Int(age.trimmingCharacters(in: .whitespaces)), years >= 0, years <= 55 else { return nil }
        let currentYear = Calendar.current.component(.year, from: Date())
        return max(1970, currentYear - years)
    }

    func saveAndContinue() {
        store.recordOnboardingPet(
            species: species,
            breed: breed,
            sex: sex,
            weightLbs: Double(weight.trimmingCharacters(in: .whitespaces)),
            birthYear: birthYear,
            medications: medications,
            allergies: allergies
        )
        if store.onboardingIsLastPet {
            // After the last pet, the root swaps to the magic-code sign-in —
            // worded there as the flow's natural last step, not a wall.
            store.completeOnboarding()
        } else {
            store.advanceOnboardingPet()
        }
    }

    /// Tapping the selected chip clears it — sex stays skippable, like every
    /// field on this page except species.
    func sexChip(_ value: String, _ title: String) -> some View {
        let selected = sex == value
        return Button { sex = selected ? "" : value } label: {
            Text(title)
                .font(.caption).fontWeight(.bold)
                .frame(maxWidth: .infinity, minHeight: 44)
                .background(selected ? TimiColor.blueSoft : .white, in: RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(selected ? TimiColor.blue : TimiColor.ink.faded(0.14), lineWidth: CGFloat(selected ? 2 : 1)))
        }.buttonStyle(.plain)
    }

    @ViewBuilder
    func labeled(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.headline)
            content()
        }
    }
}
