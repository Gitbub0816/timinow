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
    @State var showEditor = false
    /// nil means the sheet is adding; a pet means it is editing that one. Both
    /// used the same "Add a pet" sheet before, which is why a profile could be
    /// created and then never corrected.
    @State var editing: PetProfile?
    @State var note = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack {
                    VStack(alignment: .leading) {
                        Eyebrow(text: "CARE COMPANIONS")
                        Text("Your pets").font(.system(size: 40, weight: .bold, design: .serif))
                    }
                    Spacer()
                    Button {
                        editing = nil
                        showEditor = true
                    } label: {
                        Image(systemName: "plus").font(.title3).frame(width: 44, height: 44)
                            .background(TimiColor.coral, in: Circle()).foregroundStyle(.white)
                            .overlay(Circle().stroke(TimiColor.ink, lineWidth: 2))
                    }
                }
                if !note.isEmpty {
                    Text(note).font(.callout).foregroundStyle(TimiColor.coral)
                        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                        .background(TimiColor.coralSoft, in: RoundedRectangle(cornerRadius: 14))
                }
                if store.pets.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "pawprint.circle.fill").font(.system(size: 44)).foregroundStyle(TimiColor.blue)
                        Text("No pets yet").font(.title3).fontWeight(.black)
                        Text("Add the animal you would be asking clinics about. Tími keeps them with your account, so this is the last time you type it.")
                            .font(.caption).foregroundStyle(TimiColor.muted).multilineTextAlignment(.center)
                        Button { editing = nil; showEditor = true } label: { Label("Add a pet", systemImage: "plus") }
                            .buttonStyle(TimiPrimaryButtonStyle())
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 34)
                    .timiCard(Color.white)
                }
                ForEach(store.pets) { pet in
                    HStack(spacing: 0) {
                        Button {
                            store.choosePet(pet.id)
                            note = ""
                        } label: {
                            HStack(spacing: 15) {
                                Image(systemName: pet.species.icon).font(.title).foregroundStyle(.white)
                                    .frame(width: 62, height: 62)
                                    .background(pet.colorToken % 2 == 0 ? TimiColor.blue : TimiColor.coral, in: RoundedRectangle(cornerRadius: 19))
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(pet.name).font(.title3).fontWeight(.black)
                                    Text(Self.detail(pet)).font(.caption).foregroundStyle(TimiColor.muted)
                                }
                                Spacer()
                                Image(systemName: store.selectedPetId == pet.id ? "checkmark.circle.fill" : "circle")
                                    .font(.title2).foregroundStyle(TimiColor.blue)
                            }
                        }.buttonStyle(.plain)
                        // A separate hit target rather than a swipe: a swipe
                        // needs a List, and there is no affordance telling
                        // anyone it is there.
                        Button {
                            editing = pet
                            note = ""
                            showEditor = true
                        } label: {
                            Image(systemName: "pencil").font(.title3).foregroundStyle(TimiColor.blue)
                                .frame(width: 44, height: 44)
                        }.buttonStyle(.plain)
                    }
                    .timiCard(store.selectedPetId == pet.id ? TimiColor.blueSoft : .white)
                }
                Text("Pet profiles speed operational intake. Medical records are never sent unless you explicitly include them in a future supported flow.")
                    .font(.caption).foregroundStyle(TimiColor.muted)
            }.padding(20)
        }
        .background(TimiColor.canvas)
        .navigationTitle("Pets")
        .sheet(isPresented: $showEditor) {
            PetEditor(store: store, isPresented: $showEditor, editing: editing, note: $note)
        }
    }

    static func detail(_ pet: PetProfile) -> String {
        var parts: [String] = [pet.species.title]
        if !pet.breed.isEmpty { parts.append(pet.breed) }
        if let weight = pet.weightLbs { parts.append(String(format: "%.0f lb", weight)) }
        if !pet.allergies.isEmpty { parts.append("Allergies noted") }
        if !pet.medications.isEmpty { parts.append("On medication") }
        return parts.joined(separator: " · ")
    }
}

/// The pet sheet, in Tími's own hand.
///
/// It was a `Form`: grouped grey sections, hairline separators, a system
/// header in small caps. That is what every settings screen on the phone looks
/// like, and it is the one screen in this app that looked like all of them —
/// opened straight from a coral button with a 2pt ink border and a hard drop
/// shadow, which made the join obvious.
struct PetEditor: View {
    @Bindable var store: AppStore
    @Binding var isPresented: Bool
    /// nil adds, non-nil edits that pet — the id is carried through so saving
    /// updates the profile instead of adding a second one with the same name.
    var editing: PetProfile?
    @Binding var note: String

    @State var name = ""
    @State var species: PetSpecies = .dog
    @State var breed = ""
    @State var sex = ""
    @State var weight = ""
    @State var medications = ""
    @State var allergies = ""
    @State var confirmingDelete = false
    @State var loaded = false

    var body: some View {
        ZStack {
            TimiColor.canvas.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    HStack {
                        Button { isPresented = false } label: {
                            Image(systemName: "xmark").frame(width: 42, height: 42).background(.white, in: Circle())
                                .overlay(Circle().stroke(TimiColor.ink.faded(0.25)))
                        }.buttonStyle(.plain)
                        Spacer()
                    }
                    Eyebrow(text: editing == nil ? "NEW CARE COMPANION" : "EDIT PROFILE")
                    Text(editing == nil ? "Who are we\nlooking after?" : "Edit \(editing?.name ?? "this pet")")
                        .font(.system(size: 38, weight: .bold, design: .serif)).foregroundStyle(TimiColor.ink)

                    field("Name") {
                        TextField("Otis", text: $name).textContentType(.name).timiField()
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Text("Species").font(.headline)
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 104))], spacing: 10) {
                            ForEach(PetSpecies.allCases, id: \.self) { option in
                                let selected = species == option
                                Button { species = option } label: {
                                    HStack(spacing: 7) {
                                        Image(systemName: option.icon)
                                        Text(option.title).font(.caption).fontWeight(.bold)
                                        Spacer()
                                    }
                                    .padding(11)
                                    .frame(minHeight: 48)
                                    .background(selected ? TimiColor.blueSoft : .white, in: RoundedRectangle(cornerRadius: 14))
                                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(selected ? TimiColor.blue : TimiColor.ink.faded(0.14), lineWidth: CGFloat(selected ? 2 : 1)))
                                }.buttonStyle(.plain)
                            }
                        }
                    }

                    field("Breed") {
                        TextField("Optional", text: $breed).timiField()
                    }
                    field("Sex") {
                        HStack(spacing: 10) {
                            sexChip("male", "Male")
                            sexChip("female", "Female")
                            sexChip("unknown", "Not sure")
                        }
                    }
                    field("Weight in pounds") {
                        TextField("Optional", text: $weight).timiKeyboard(.decimal).timiField()
                    }

                    VStack(alignment: .leading, spacing: 10) {
                        Eyebrow(text: "OPTIONAL — MEDICATIONS AND ALLERGIES")
                        TextField("Medications", text: $medications).timiField()
                        TextField("Allergies", text: $allergies).timiField()
                        Text("Shared with the clinics your care request reaches, exactly as you write it. Tími is not a medical record: nothing here comes from a veterinarian, none of it is verified, and a clinic will confirm everything with you on arrival. Leave it blank if you would rather not.")
                            .font(.caption).foregroundStyle(TimiColor.muted)
                    }.timiCard(TimiColor.paper)

                    Button { save() } label: {
                        Label(editing == nil ? "Add \(displayName)" : "Save changes", systemImage: "checkmark")
                    }
                    .buttonStyle(TimiPrimaryButtonStyle())
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)

                    if let pet = editing {
                        VStack(alignment: .leading, spacing: 10) {
                            if confirmingDelete {
                                Text("Remove \(pet.name)? Past requests stay in your activity.")
                                    .font(.callout).fontWeight(.semibold).foregroundStyle(TimiColor.ink)
                                Button("Yes, remove \(pet.name)") {
                                    store.deletePet(pet.id)
                                    note = ""
                                    isPresented = false
                                }.buttonStyle(TimiPrimaryButtonStyle())
                                Button("Keep \(pet.name)") { confirmingDelete = false }.buttonStyle(TimiQuietButtonStyle())
                            } else {
                                Button("Remove this pet") { confirmingDelete = true }.buttonStyle(TimiQuietButtonStyle())
                            }
                        }.timiCard(TimiColor.coralSoft)
                    }

                    Text("Profiles are kept with your account, so they follow you to a new phone.")
                        .font(.caption).foregroundStyle(TimiColor.muted)
                    Spacer(minLength: 20)
                }
                .padding(22)
            }
        }
        // A sheet's @State survives between presentations, so without this the
        // second pet opened still shows the first one's details.
        .onAppear {
            guard !loaded else { return }
            loaded = true
            if let pet = editing {
                name = pet.name
                species = pet.species
                breed = pet.breed
                sex = pet.sex
                weight = pet.weightLbs.map { String(format: "%.0f", $0) } ?? ""
                medications = pet.medications
                allergies = pet.allergies
            }
        }
    }

    var displayName: String {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty ? "this pet" : trimmed
    }

    @ViewBuilder
    func field(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.headline)
            content()
        }
    }

    /// Same skippable chips as onboarding: tapping the selected one clears it.
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

    func save() {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        let existing = editing
        store.savePet(PetProfile(
            id: existing?.id ?? UUID().uuidString,
            name: trimmed,
            species: species,
            breed: breed.trimmingCharacters(in: .whitespaces),
            sex: sex,
            weightLbs: Double(weight),
            birthYear: existing?.birthYear,
            colorToken: existing?.colorToken ?? store.pets.count,
            medications: medications.trimmingCharacters(in: .whitespacesAndNewlines),
            allergies: allergies.trimmingCharacters(in: .whitespacesAndNewlines)
        ))
        isPresented = false
    }
}

struct ActivityView: View {
    @Bindable var store: AppStore
    var body: some View {
        ScrollView { VStack(alignment: .leading, spacing: 18) { Eyebrow(text: "CARE HISTORY"); Text("Recent activity").font(.system(size: 40, weight: .bold, design: .serif)); if store.history.isEmpty { VStack(spacing: 14) { Image(systemName: "clock.badge.questionmark").font(.system(size: 45)).foregroundStyle(TimiColor.blue); Text("No completed searches yet").font(.title3).fontWeight(.black); Text("Selected clinics and arrival progress will appear here.").font(.caption).foregroundStyle(TimiColor.muted) }.frame(maxWidth: .infinity).padding(.vertical, 50).timiCard(Color.white) } else { ForEach(store.history) { item in HStack(spacing: 13) { Image(systemName: "checkmark.seal.fill").font(.title2).foregroundStyle(TimiColor.blue); VStack(alignment: .leading) { Text("\(item.petName) · \(item.clinicName)").fontWeight(.bold); Text(item.status.replacingOccurrences(of: "_", with: " ").capitalized).font(.caption).foregroundStyle(TimiColor.muted) }; Spacer() }.timiCard(Color.white) } } }.padding(20) }.background(TimiColor.canvas).navigationTitle("Activity")
    }
}

/// Settings, in Tími's own hand.
///
/// This was a `Form`: grouped grey sections, hairline separators, system
/// small-caps headers. The pet sheet next door was rewritten off exactly that
/// look and this was left behind, which made it the one screen in the app that
/// looked like every other app on the phone — reached from a tab bar whose
/// other three screens are ink borders, serif headlines and coral.
///
/// Every binding below is the one the `Form` had. What changed is the
/// chrome: cards instead of sections, chips instead of wheel pickers, and
/// labels above fields rather than beside them.
struct SettingsView: View {
    @Bindable var store: AppStore
    @State var versionTaps = 0

    func registerVersionTap() {
        versionTaps += 1
        if versionTaps >= 7 { store.developerModeEnabled = true }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Eyebrow(text: "YOUR ACCOUNT")
                Text("Settings").font(.system(size: 40, weight: .bold, design: .serif))

                details
                if store.auth.isSignedIn { account }
                permissions
                navigation
                legal

                // Tapping the version seven times brings the developer card
                // back — the same idiom Apple's own apps use, and the only
                // people who know to do it are the people who need it.
                Text("Tími NOW \(TimiEnvironment.appVersion) · built \(TimiEnvironment.buildStamp)")
                    .font(.footnote).foregroundStyle(TimiColor.muted)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .contentShape(Rectangle())
                    .onTapGesture { registerVersionTap() }
                    .padding(.top, 6)

                if store.developerModeEnabled { developer }
            }
            .padding(20)
            .padding(.bottom, 30)
        }
        .background(TimiColor.canvas)
        .navigationTitle("Settings")
    }

    // MARK: - Cards

    /// What a pet owner actually needs from this screen: who the clinic calls.
    /// Typed once here or once on the intake form, then remembered — not
    /// re-entered on every care request.
    var details: some View {
        card("YOUR DETAILS") {
            field("Name") { TextField("Your name", text: $store.ownerName).textContentType(.name).timiField() }
            field("Mobile number") { TextField("(555) 123-4567", text: $store.ownerPhone).textContentType(.telephoneNumber).timiKeyboard(.phone).timiField() }
            field("Email") { TextField("Optional", text: $store.ownerEmail).textContentType(.emailAddress).timiKeyboard(.email).autocorrectionDisabled().timiField() }
            Text("Used to fill in your next care request, and given to the clinic you choose so they can reach you.")
                .font(.caption).foregroundStyle(TimiColor.muted)
        }
    }

    var account: some View {
        card("ACCOUNT") {
            // Naming the account is the whole point of having one. Not saying
            // which one is signed in is why "we have sign-ins and it doesn't
            // save anything" was a reasonable reading.
            VStack(alignment: .leading, spacing: 3) {
                Text("Signed in as").font(.caption).foregroundStyle(TimiColor.muted)
                Text(signedInAs).font(.title3).fontWeight(.black)
            }
            // Shown only when it is not working, and shown without seven taps.
            //
            // "It does not stay signed in" has cost several rounds of guessing
            // between three indistinguishable causes: a Keychain that refuses
            // the write, a Clerk instance that returned no client token to
            // store, and a Worker that could not be reached at launch. The
            // device knows which. There is nothing a customer can do about any
            // of them, so this is worded as a fault report rather than an
            // instruction — but a fault nobody can see is one nobody fixes.
            if store.auth.credentialDiagnostics != "stored and readable" {
                VStack(alignment: .leading, spacing: 4) {
                    Text("This device may not stay signed in").font(.caption).fontWeight(.bold).foregroundStyle(TimiColor.coral)
                    Text(store.auth.credentialDiagnostics).font(.caption).foregroundStyle(TimiColor.muted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(11)
                .background(TimiColor.coralSoft, in: RoundedRectangle(cornerRadius: 12))
            }
            Button("Sign out") { Task { await store.auth.signOut() } }
                .buttonStyle(TimiQuietButtonStyle())
        }
    }

    var signedInAs: String {
        if !store.ownerEmail.isEmpty { return store.ownerEmail }
        if !store.ownerPhone.isEmpty { return store.ownerPhone }
        return store.ownerName.isEmpty ? "This device" : store.ownerName
    }

    /// The onboarding flow no longer primes OS permissions — it asks about
    /// the pet, not the phone — so flipping these on is now what actually
    /// requests them. The toggle settles to what the system granted, so a
    /// refusal reads as the switch declining rather than lying on.
    var permissions: some View {
        card("PERMISSIONS") {
            toggle("Offer notifications", "Tell me when a clinic answers.", $store.notificationsEnabled)
            Divider()
            toggle("Use precise location", "Rank clinics by how far you actually have to drive.", $store.locationEnabled)
        }
        .onChange(of: store.notificationsEnabled) { enabled in
            guard enabled else { return }
            Task { store.notificationsEnabled = await PlatformPermissions.requestNotifications() }
        }
        .onChange(of: store.locationEnabled) { enabled in
            guard enabled else { return }
            Task {
                store.locationEnabled = await PlatformPermissions.requestLocation()
                if let point = await PlatformPermissions.currentLocation() {
                    store.setLocation(latitude: point.0, longitude: point.1)
                }
            }
        }
    }

    var navigation: some View {
        card("NAVIGATION") {
            toggle("Spoken turn-by-turn", "Directions read aloud on the way.", $store.navigationPreferences.voiceEnabled)

            voiceChips

            #if os(iOS) && !SKIP
            let deviceVoices = VoicePreviewer.availableVoices()
            if !deviceVoices.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Device voice").font(.headline)
                    // The unset default is the best installed voice, not the
                    // system's compact one — see VoicePreviewer.bestVoice.
                    chipRow(title: "Best available", selected: store.navigationPreferences.preferredVoiceIdentifier == nil) {
                        store.navigationPreferences.preferredVoiceIdentifier = nil
                    }
                    ForEach(deviceVoices, id: \.identifier) { voice in
                        chipRow(title: VoicePreviewer.label(for: voice), selected: store.navigationPreferences.preferredVoiceIdentifier == voice.identifier) {
                            store.navigationPreferences.preferredVoiceIdentifier = voice.identifier
                        }
                    }
                }
            }
            #endif

            VStack(alignment: .leading, spacing: 6) {
                Text("Speech rate").font(.headline)
                Slider(value: $store.navigationPreferences.speechRate, in: 0...1).tint(TimiColor.blue)
            }

            unitChips

            Divider()
            toggle("Avoid tolls", nil, $store.navigationPreferences.avoidTolls)
            toggle("Avoid highways", nil, $store.navigationPreferences.avoidHighways)
            toggle("Avoid ferries", nil, $store.navigationPreferences.avoidFerries)
            toggle("Announce arrival at clinic", nil, $store.navigationPreferences.announceArrivalAtClinic)

            #if os(iOS) && !SKIP
            Button("Preview voice") {
                VoicePreviewer.shared.preview(
                    // Previewed in the calm register: this is a settings
                    // screen, not a drive, and it is the register whose
                    // wording anyone customising the voice will care about.
                    text: TimiInstructionRewriter.announcement(
                        "arrival",
                        tone: .calm,
                        clinicName: "Hearth and Paw",
                        petName: store.selectedPet.name
                    ) ?? "You've arrived.",
                    preferences: store.navigationPreferences
                )
            }.buttonStyle(TimiQuietButtonStyle())
            #endif
        }
    }

    var legal: some View {
        card("LEGAL AND SUPPORT") {
            NavigationLink { LegalView() } label: {
                row("Terms, privacy, and veterinary safety", "chevron.right")
            }.buttonStyle(.plain)
            Divider()
            Link(destination: URL(string: "mailto:privacy@clearkey.solutions")!) {
                row("Privacy requests", "envelope")
            }.buttonStyle(.plain)
            Divider()
            Link(destination: URL(string: "mailto:billing@clearkey.solutions")!) {
                row("Billing support", "envelope")
            }.buttonStyle(.plain)
        }
    }

    /// The Worker address, the mode, the onboarding replay: all of it is ours,
    /// none of it is a pet owner's, and a settings screen that opens with
    /// "https://your-worker.workers.dev" tells them they are holding something
    /// unfinished.
    var developer: some View {
        card("DEVELOPER") {
            field("Worker address") { TextField("https://your-worker.workers.dev", text: $store.apiBaseURLText).autocorrectionDisabled().timiField() }
            Button("Save API address") { store.saveAPIBaseURL() }.buttonStyle(TimiQuietButtonStyle())
            Divider()
            labelled("Mode", store.isDemoMode ? "Interactive demo" : "Live Worker")
            labelled("Talking to", store.resolvedAPIAddress)
            Divider()
            // Whether this device can stay signed in, answered now rather than
            // by relaunching and seeing. Three things have to be true and each
            // used to fail silently: the Keychain has to accept the write, the
            // credential has to be worth writing, and it has to read back.
            labelled("Sign-in storage", store.auth.credentialDiagnostics)
            labelled("Last crash", TimiBreadcrumb.lastCrash ?? "none recorded")
            labelled("Last launch", store.auth.lastRestoreOutcome)
            Divider()
            Button("Replay guided onboarding") { store.resetOnboarding() }.buttonStyle(TimiQuietButtonStyle())
            Button("Hide developer settings") { store.developerModeEnabled = false; versionTaps = 0 }.buttonStyle(TimiQuietButtonStyle())
        }
    }

    // MARK: - Pieces

    func card(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Eyebrow(text: title)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .timiCard(Color.white)
    }

    func field(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.headline)
            content()
        }
    }

    func toggle(_ title: String, _ subtitle: String?, _ value: Binding<Bool>) -> some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                if let subtitle { Text(subtitle).font(.caption).foregroundStyle(TimiColor.muted) }
            }
            Spacer()
            Toggle("", isOn: value).labelsHidden().tint(TimiColor.blue)
        }
    }

    /// The species-picker idiom from the pet sheet, reused. A wheel picker is
    /// the single most system-looking control on the phone.
    ///
    /// Written out per type rather than once over `Option: Hashable`. Nothing
    /// else in this module has a generic view helper, and this module is the
    /// one skipstone transpiles to Kotlin — a first generic here is a Kotlin
    /// build risk paid for two call sites.
    var voiceChips: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Voice").font(.headline)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 120))], spacing: 10) {
                ForEach(VoiceProfile.allCases, id: \.self) { option in
                    chipRow(title: option.title, selected: store.navigationPreferences.voiceProfile == option) {
                        store.navigationPreferences.voiceProfile = option
                    }
                }
            }
        }
    }

    var unitChips: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Distance units").font(.headline)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 120))], spacing: 10) {
                ForEach(DistanceUnits.allCases, id: \.self) { option in
                    chipRow(title: option.title, selected: store.navigationPreferences.distanceUnits == option) {
                        store.navigationPreferences.distanceUnits = option
                    }
                }
            }
        }
    }

    func chipRow(title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 7) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(selected ? TimiColor.blue : TimiColor.ink.faded(0.3))
                Text(title).font(.caption).fontWeight(.bold).multilineTextAlignment(.leading)
                Spacer(minLength: 0)
            }
            .padding(11)
            .frame(minHeight: 48)
            .background(selected ? TimiColor.blueSoft : .white, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(selected ? TimiColor.blue : TimiColor.ink.faded(0.14), lineWidth: CGFloat(selected ? 2 : 1)))
        }.buttonStyle(.plain)
    }

    func row(_ title: String, _ icon: String) -> some View {
        HStack {
            Text(title).font(.headline).multilineTextAlignment(.leading)
            Spacer()
            Image(systemName: icon).font(.caption).foregroundStyle(TimiColor.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    func labelled(_ title: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).font(.headline)
            Spacer()
            Text(value).font(.caption).foregroundStyle(TimiColor.muted).multilineTextAlignment(.trailing)
        }
    }
}

struct LegalView: View {
    var body: some View {
        ScrollView { VStack(alignment: .leading, spacing: 22) {
            Eyebrow(text: "EFFECTIVE AUGUST 24, 2026"); Text("Legal and safety").font(.system(size: 40, weight: .bold, design: .serif))
            legalSection("Tími is not veterinary care", "Tími provides technology for locating participating veterinary facilities, displaying reported intake capacity, sharing structured operational intake, and comparing availability offers. Tími does not diagnose, prescribe, recommend treatment, create a veterinarian-client-patient relationship, guarantee care, or replace clinical triage.")
            legalSection("No promise of care or priority", "A listing, reported status, offer, estimated wait, or arrival window is not a guaranteed appointment or examination time. Capacity can change. The independent clinic decides whether and when to examine or treat an animal, and critical patients may be seen first.")
            legalSection("Information sharing", "Your structured intake — including any medications or allergies you chose to record — may be shared with up to 30 matching participating clinics, including clinics you do not select, so they can evaluate current capacity. Tími displays up to five active offers. Only the clinic you choose is confirmed. Service providers may process data for hosting, authentication, communications, security, analytics, and payments.")
            legalSection("Deposits and veterinary charges", "When a clinic requires a deposit, its amount, policy version, cancellation, refund, and no-show rules are shown before payment. Unless that displayed policy says otherwise, the deposit is credited to the clinic invoice. The clinic bills remaining veterinary charges and handles insurance. Tími does not submit insurance claims.")
            legalSection("Tími service fee", "Tími charges a total service fee of $50 per completed intake. Under the standard arrangement, $25 is collected from the customer at the time of service and the remainder is deducted from the clinic's payout. A clinic may elect to pass the entire $50 service fee to the customer; in that case the full amount is disclosed at checkout before payment.")
            legalSection("Providers staffed by a veterinary technician", "Some participating providers are staffed by a registered, licensed, or certified veterinary technician rather than a veterinarian, and Tími labels them before you choose. A veterinary technician works under a veterinarian's supervision and, under state practice acts, may not diagnose, prognose, prescribe, or perform surgery. Those providers are listed for minor concerns; anything that may need a diagnosis or a treatment decision should go to a veterinarian. The label is set by Tími from what the provider supplies at onboarding and is not a verification of any individual's credential, licence status, or scope of practice.")
            legalSection("Medications and allergies you record", "Anything you add to a pet profile is optional, stored as you type it, and shared with the clinics your care request reaches. Tími is not a medical record system: nothing in that field comes from a veterinarian, none of it is verified, and no clinic may rely on it in place of its own history-taking. Keep it current, confirm it with the treating clinic, and do not record anything you would not want shared with the clinics contacted for a request.")
            legalSection("Finding emergency hospitals", "The emergency list is not limited to Tími's participating clinics, because the nearest emergency hospital often is not one. Listings outside the network come from third-party map data, including their names, addresses and phone numbers. Tími has not verified that they exist as listed, are open, are equipped for your animal, or will accept a patient, and no request is sent to them — the list is somewhere to drive, not a booking and not a recommendation. Call before you travel where you can.")
            legalSection("Emergency safety", "Do not wait for Tími if your animal may be in immediate danger. Travel to the nearest appropriate emergency-capable veterinary facility while someone calls ahead. For suspected poisoning, contact a veterinarian or recognized animal poison-control service immediately.")
            legalSection("Analytics", "Tími measures its own app with first-party, cookieless analytics. What is recorded: the event name, the screen it happened on, coarse device and country information, and a daily-rotating anonymous hash. No cookies are set, no advertising identifiers are used, and nothing is sold or shared for advertising. Because the hash rotates every day, these measurements cannot follow you across days.")
            legalSection("Operator and contact", "Tími NOW is operated by ClearKey Solutions, LLC in Hayward, California. California law governs the service to the extent permitted. Contact legal@clearkey.solutions or privacy@clearkey.solutions for applicable requests.")
        }.padding(20).padding(.bottom, 40) }.background(TimiColor.paper).navigationTitle("Legal")
    }
    func legalSection(_ title: String, _ text: String) -> some View { VStack(alignment: .leading, spacing: 8) { Text(title).font(.title3).fontWeight(.black); Text(text).font(.callout).foregroundStyle(TimiColor.muted).lineSpacing(4) } }
}
