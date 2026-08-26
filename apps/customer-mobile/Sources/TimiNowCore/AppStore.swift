import Foundation
import Observation
import SkipFuse

public enum CustomerRoute: String, Codable, Sendable { case home, intake, searching, tracker }

@MainActor @Observable public final class AppStore {
    public var hasCompletedOnboarding: Bool
    /// Pet names typed on the first onboarding screen, in the order they were
    /// given. Persisted while onboarding is underway so a killed app resumes
    /// where it stood; cleared the moment onboarding completes.
    public var onboardingNames: [String] = []
    /// Which named pet the detail page is describing: -1 while names are
    /// still being collected on the first screen.
    public var onboardingPetIndex = -1
    /// Set when "Sign in" is chosen from an onboarding screen — the skip for
    /// people who already have an account. Deliberately not persisted: killed
    /// before sign-in finishes, the app resumes onboarding instead.
    public var onboardingSignInRequested = false
    /// Ninety-nine name fields is already a refusal in practice; past it the
    /// screen declines politely instead of scrolling forever.
    public static let onboardingPetLimit = 99
    public var selectedTab = 0
    public var route: CustomerRoute = .home
    public var pets: [PetProfile]
    public var selectedPetId: String
    public var draft: CareDraft
    public var locations: [ClinicLocation] = []
    public var currentSearch: CareSearch?
    public var currentIntake: CareIntake?
    public var history: [CareHistoryItem]
    public var isWorking = false
    public var errorMessage: String?
    public var showCelebration = false
    public var apiBaseURLText: String
    public var notificationsEnabled = false
    public var locationEnabled = false
    public var currentLatitude = 37.6688
    public var currentLongitude = -122.0808
    public var mapToken: String?
    public var mapStyleURL = MapDefaults.styleURL
    public var navigationStyleURL = MapDefaults.styleURL
    /// The customer's share of the Tími service fee, in cents, disclosed
    /// beside the deposit. 2500 is the compiled-in fallback; `/api/config`
    /// overrides it the same way the map token arrives, so a fee change (or a
    /// clinic passing the whole fee through) does not strand shipped builds
    /// disclosing the wrong amount.
    public var customerFeeCents = 2500
    public var navigationDestination: NavigationDestination?
    public var currentNavigationStep: NavigationStepModel?
    public var currentRouteSummary: RouteSummary?
    public var navigationPreferences: NavigationPreferences {
        didSet { persistNavigationPreferences() }
    }

    #if !os(Android)
    private let defaults: UserDefaults
    #endif
    private var gateway: TimiGateway

    /// Sign-in, and the token every Worker call carries.
    ///
    /// A plain stored property, not `lazy`: @Observable rewrites stored
    /// properties into computed ones backed by init accessors, and neither
    /// `lazy` nor a default expression referring to another property survives
    /// that. Built in init, after the gateway it needs.
    public private(set) var auth: AuthController

    public init() {
        #if os(Android)
        let storedPets: [PetProfile] = []
        let selectedPetId = ""
        let storedHistory: [CareHistoryItem] = []
        let completedOnboarding = false
        let apiBaseURLText = TimiEnvironment.defaultAPIBaseURL
        let storedOwner = ("", "", "")
        let storedDeveloperMode = false
        let storedNavigationPreferences = NavigationPreferences.default
        let storedOnboardingNames: [String] = []
        let storedOnboardingIndex = -1
        #else
        let defaults = UserDefaults.standard
        self.defaults = defaults
        // No sample pet. A fresh install used to be handed one — Milo, and
        // then whatever the previous person on this device had named theirs,
        // because none of this was ever scoped to an account. Signing in as
        // somebody new showed them a stranger's pet.
        let storedPets = Self.decode([PetProfile].self, from: defaults.data(forKey: "timi.pets")) ?? []
        let selectedPetId = defaults.string(forKey: "timi.selectedPet") ?? storedPets.first?.id ?? ""
        let storedHistory = Self.decode([CareHistoryItem].self, from: defaults.data(forKey: "timi.history")) ?? []
        let completedOnboarding = defaults.bool(forKey: "timi.onboarding.complete")
        // Empty as well as absent: a previously saved blank would otherwise
        // pin the app in demo mode forever.
        let storedBaseURL = defaults.string(forKey: "timi.apiBaseURL") ?? ""
        let apiBaseURLText = storedBaseURL.isEmpty ? TimiEnvironment.defaultAPIBaseURL : storedBaseURL
        let storedDeveloperMode = defaults.bool(forKey: "timi.developerMode")
        let storedOwner = (
            defaults.string(forKey: "timi.owner.name") ?? "",
            defaults.string(forKey: "timi.owner.phone") ?? "",
            defaults.string(forKey: "timi.owner.email") ?? ""
        )
        let storedNavigationPreferences = Self.decode(NavigationPreferences.self, from: defaults.data(forKey: "timi.navigation.preferences")) ?? .default
        // Mid-onboarding progress, so being killed between screens is not
        // starting over. Absent reads as -1 — the names screen — because
        // integer(forKey:) answering 0 for "nothing stored" would otherwise
        // resume on the first pet's detail page with no names collected.
        let storedOnboardingNames = Self.decode([String].self, from: defaults.data(forKey: "timi.onboarding.names")) ?? []
        let storedOnboardingIndex = defaults.object(forKey: "timi.onboarding.petIndex") == nil ? -1 : defaults.integer(forKey: "timi.onboarding.petIndex")
        #endif
        self.pets = storedPets
        self.selectedPetId = selectedPetId
        let selected = storedPets.first(where: { $0.id == selectedPetId }) ?? storedPets.first ?? Self.placeholderPet
        self.draft = CareDraft(pet: selected)
        self.history = storedHistory
        self.hasCompletedOnboarding = completedOnboarding
        self.onboardingNames = storedOnboardingNames
        // Clamped rather than trusted: an index past the stored names would
        // have every detail page describing nobody.
        self.onboardingPetIndex = storedOnboardingNames.isEmpty ? -1 : max(-1, min(storedOnboardingIndex, storedOnboardingNames.count - 1))
        self.apiBaseURLText = apiBaseURLText
        self.developerModeEnabled = storedDeveloperMode
        self.ownerName = storedOwner.0
        self.ownerPhone = storedOwner.1
        self.ownerEmail = storedOwner.2
        self.navigationPreferences = storedNavigationPreferences
        let gateway = TimiGateway(baseURL: Self.validBaseURL(apiBaseURLText))
        self.gateway = gateway
        self.auth = AuthController(gateway: gateway)
        // Signing in is the last time these should ever be asked for. Set
        // after every stored property, which is when `self` may be captured.
        // Every request mints its own token from here on, so no caller has to
        // remember to.
        gateway.tokenProvider = self.auth
        self.auth.onProfileResolved = { [weak self] profile in self?.adoptOwner(profile) }
        self.auth.onSignedOut = { [weak self] in self?.forgetAccountData() }
        self.auth.onCredentialStorageFailed = { [weak self] status in self?.reportKeychainFailure(status) }
        self.auth.onRestoreOutcome = { [weak self] outcome in self?.reportRestoreOutcome(outcome) }
    }

    /// Brings this device's pets and the account's together.
    ///
    /// Called on every sign-in, and the reason a reinstall no longer loses
    /// anything. Two directions, and the order matters:
    ///
    /// 1. Anything on this phone that the account has never heard of is pushed
    ///    up. That is the upgrade case — somebody with three pets recorded
    ///    before pets were stored anywhere, whose phone is the only copy that
    ///    exists. It runs once and then finds nothing to do.
    /// 2. Whatever the account holds afterwards replaces what is on screen.
    ///    That is the reinstall and second-device case.
    ///
    /// A stored pet always wins over the local copy of the same pet: another
    /// device may have edited it since, and a copy from a phone that has been
    /// in a pocket for a week is the wrong winner. Locally deleted pets are
    /// not resurrected, because the delete was written through at the time.
    ///
    /// Silent on failure by design. Somebody who opens the app on a train has
    /// their pets — the device copy is still there and still authoritative for
    /// this launch — and being told that a sync failed is neither actionable
    /// nor true in any way they would care about.
    func reconcilePets() async {
        guard !gateway.isDemo else { return }
        guard let merged = try? await gateway.syncPets(pets) else { return }
        // An account that genuinely has no pets is a real state — a new
        // customer — but so is a Worker that answered oddly, and replacing a
        // phone full of pets with nothing is the one outcome worth refusing.
        // Empty from the server after we sent some means the push failed; keep
        // what we have and try again next launch.
        if merged.isEmpty && !pets.isEmpty { return }
        pets = merged
        if !pets.contains(where: { $0.id == selectedPetId }) {
            selectedPetId = pets.first?.id ?? ""
        }
        persistPets()
    }

    /// Sends the launch's restore outcome to the Worker when it was not clean.
    ///
    /// The two quiet outcomes are the two that need no investigation: a
    /// resumed session, and a fresh install with nothing stored. Everything
    /// else is a row an operator can read instead of asking for screenshots.
    func reportRestoreOutcome(_ outcome: String) {
        if outcome == "resumed the active session" { return }
        // A pending resume recurs on every launch for every customer while
        // the instance forces organization selection; reporting it would be
        // one row per app open saying the same thing.
        if outcome.hasPrefix("resumed a pending session") { return }
        if outcome.hasPrefix("no stored credential") { return }
        let report = ClientErrorReport(
            surface: "customer_ios",
            appVersion: TimiEnvironment.appVersion,
            path: "/auth/restore",
            code: "RESTORE_NOT_CLEAN",
            message: outcome,
            detail: ["build": TimiEnvironment.buildStamp]
        )
        Task { [gateway] in await gateway.reportFailure(report) }
    }

        /// Reports a stage the previous launch entered and never left.
    ///
    /// Called once at startup. Nothing is shown to the customer — they were
    /// there, they know it closed — and the report is what turns "it crashes
    /// when I press Navigate" into the name of the line it died on.
    public func reportCrashBreadcrumb() {
        guard let stage = TimiBreadcrumb.consume() else { return }
        let report = ClientErrorReport(
            surface: "customer_ios",
            appVersion: TimiEnvironment.appVersion,
            path: "/crash/\(stage)",
            code: "CRASHED_IN_STAGE",
            message: "The previous launch entered \(stage) and never left it — the app was killed or trapped inside that stage.",
            detail: ["stage": stage, "build": TimiEnvironment.buildStamp]
        )
        Task { [gateway] in await gateway.reportFailure(report) }
    }

    /// A Keychain that will not hold the credential, said out loud.
    ///
    /// Not shown to the customer: there is nothing they can do about a
    /// provisioning profile. It goes to the Worker, where it is one row saying
    /// which build on which device cannot stay signed in and with what
    /// OSStatus — -34018 is errSecMissingEntitlement, which is the app's
    /// keychain access group missing from the profile it was signed with.
    func reportKeychainFailure(_ status: Int32) {
        let report = ClientErrorReport(
            surface: "customer_ios",
            appVersion: TimiEnvironment.appVersion,
            path: "/keychain/save",
            code: "KEYCHAIN_WRITE_REFUSED",
            message: "The Keychain refused to store the sign-in credential (OSStatus \(status)). This device cannot stay signed in.",
            detail: ["osstatus": String(status)]
        )
        Task { [gateway] in await gateway.reportFailure(report) }
    }

    /// Everything device-local that belongs to whoever was signed in.
    ///
    /// Pets, history and contact details live in UserDefaults, which is a
    /// property of the phone rather than of the person. Signing out and back
    /// in as somebody else used to leave the previous account's pet on screen,
    /// which is how a stranger's animal greeted a brand-new customer.
    func forgetAccountData() {
        pets = []
        selectedPetId = ""
        history = []
        ownerName = ""; ownerPhone = ""; ownerEmail = ""
        draft = CareDraft(pet: Self.placeholderPet)
        currentSearch = nil
        currentIntake = nil
        emergencyLocations = []
        #if !os(Android)
        defaults.removeObject(forKey: "timi.selectedPet")
        defaults.removeObject(forKey: "timi.accountId")
        #endif
        persistPets()
        persistHistory()
    }

    /// Takes whatever sign-in learned without overwriting anything the owner
    /// has since typed by hand.
    func adoptOwner(_ profile: AuthProfile) {
        // A different account on the same phone starts clean. Without this,
        // signing in as somebody new inherits the last person's pets, their
        // care history and their phone number.
        if !profile.userId.isEmpty {
            #if !os(Android)
            let previous = defaults.string(forKey: "timi.accountId") ?? ""
            if !previous.isEmpty && previous != profile.userId { forgetAccountData() }
            defaults.set(profile.userId, forKey: "timi.accountId")
            #endif
        }
        // Signing in ends onboarding wherever it stood — through the flow's
        // last step or through its "Sign in" skip. The account is the
        // authority now, and a later sign-out must not replay the welcome.
        if !hasCompletedOnboarding { completeOnboarding() }
        // Pets belong to the account now, so this is where the two copies meet.
        Task { [weak self] in await self?.reconcilePets() }
        if !profile.name.isEmpty { ownerName = profile.name }
        if !profile.phone.isEmpty { ownerPhone = profile.phone }
        if !profile.email.isEmpty { ownerEmail = profile.email }
        // A draft built before sign-in finished is still on screen with empty
        // contact fields; fill it rather than making them type into it.
        if draft.ownerName.isEmpty { draft.ownerName = ownerName }
        if draft.ownerPhone.isEmpty { draft.ownerPhone = ownerPhone }
        if draft.ownerEmail.isEmpty { draft.ownerEmail = ownerEmail }
    }

    /// Single shared instance so the CarPlay scene and the Watch
    /// connectivity bridge — both instantiated by the OS outside the main
    /// SwiftUI view hierarchy — observe the same live state as the phone UI.
    public static let shared = AppStore()

    /// A profile that is not anybody's pet.
    ///
    /// `selectedPet` stays non-optional because a dozen screens read
    /// `selectedPet.name`, and `hasPet` is what gates anything that matters —
    /// `beginCare()` refuses without a real one, so this never reaches a
    /// clinic. It is named neutrally rather than after a sample animal, which
    /// is how "Milo" and then somebody else's "Otis" ended up greeting people
    /// who had added no pet at all.
    static let placeholderPet = PetProfile(id: "", name: "your pet", species: .dog)

    public var hasPet: Bool { !pets.isEmpty }
    public var selectedPet: PetProfile { pets.first(where: { $0.id == selectedPetId }) ?? pets.first ?? Self.placeholderPet }
    public var isDemoMode: Bool { gateway.isDemo }
    /// What the gateway resolved to, which is not always what is in the text
    /// field — an address that fails validation leaves the gateway on nothing
    /// at all, and the difference is worth being able to see.
    public var resolvedAPIAddress: String {
        let address = gateway.configuredAddress
        return address.isEmpty ? "nothing — demo data" : address
    }
    public var concernValidation: ConcernValidation { ConcernValidator.evaluate(summary: draft.summary, symptoms: draft.symptomKeys, startedWhen: draft.startedWhen) }

    // MARK: - Onboarding
    //
    // Onboarding now runs before sign-in, not after it: the first thing a new
    // person is asked is their pet's name, not their email address. Pets
    // captured here go through savePet — the same device-local storage the
    // post-sign-in reconcilePets sync reads — so the moment an account exists
    // they upload to it with no extra wiring.

    /// The pet the detail page is currently describing, or nil outside the
    /// per-pet pages.
    public var onboardingPetName: String? {
        guard onboardingPetIndex >= 0, onboardingPetIndex < onboardingNames.count else { return nil }
        return onboardingNames[onboardingPetIndex]
    }

    /// Whether the pet being described is the last one named.
    public var onboardingIsLastPet: Bool { onboardingPetIndex >= onboardingNames.count - 1 }

    /// The first screen's outcome: every name typed, in order. Blank fields
    /// are dropped rather than refused — an empty extra field is somebody who
    /// pressed "I have another pet" once too often.
    public func beginOnboardingDetails(names: [String]) {
        let cleaned = names.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        guard !cleaned.isEmpty else { return }
        onboardingNames = Array(cleaned.prefix(Self.onboardingPetLimit))
        onboardingPetIndex = 0
        persistOnboardingProgress()
    }

    /// Stores the pet currently being described. Goes through savePet so the
    /// profile is on disk immediately — killed one second later, the pet is
    /// still there — and so the sign-in sync picks it up like any other pet.
    public func recordOnboardingPet(species: PetSpecies, breed: String, sex: String, weightLbs: Double?, birthYear: Int?, medications: String, allergies: String) {
        guard let name = onboardingPetName else { return }
        savePet(PetProfile(
            name: name,
            species: species,
            breed: breed.trimmingCharacters(in: .whitespaces),
            sex: sex,
            weightLbs: weightLbs,
            birthYear: birthYear,
            colorToken: pets.count,
            medications: medications.trimmingCharacters(in: .whitespacesAndNewlines),
            allergies: allergies.trimmingCharacters(in: .whitespacesAndNewlines)
        ))
    }

    /// Moves to the next named pet's detail page.
    public func advanceOnboardingPet() {
        guard onboardingPetIndex + 1 < onboardingNames.count else { return }
        onboardingPetIndex += 1
        persistOnboardingProgress()
    }

    /// Ends onboarding and clears its working state. Reached from the last
    /// pet's detail page, and from sign-in when somebody skipped — either way
    /// the flow never shows again on this device.
    public func completeOnboarding() {
        hasCompletedOnboarding = true
        onboardingNames = []
        onboardingPetIndex = -1
        // The first pet named is the one selected — the same animal the
        // person led with when asked who they were here for.
        if let first = pets.first {
            selectedPetId = first.id
            draft = CareDraft(pet: first)
        }
        #if !os(Android)
        defaults.set(true, forKey: "timi.onboarding.complete")
        defaults.removeObject(forKey: "timi.onboarding.names")
        defaults.removeObject(forKey: "timi.onboarding.petIndex")
        #endif
        persistPets()
    }

    private func persistOnboardingProgress() {
        #if !os(Android)
        defaults.set(try? JSONEncoder().encode(onboardingNames), forKey: "timi.onboarding.names")
        defaults.set(onboardingPetIndex, forKey: "timi.onboarding.petIndex")
        #endif
    }

    /// Who to call, remembered.
    ///
    /// The draft is rebuilt from scratch on every care request — it has to be,
    /// since the concern is new each time — and that wiped the owner's name,
    /// phone and email along with it. Typing your own phone number again while
    /// your dog is being sick is not a small annoyance. Kept separately from
    /// the draft for exactly that reason, and written back whenever it changes.
    /// Reveals the Worker address and the onboarding replay. Off for everyone
    /// who has not deliberately turned it on.
    public var developerModeEnabled: Bool {
        didSet {
            #if !os(Android)
            defaults.set(developerModeEnabled, forKey: "timi.developerMode")
            #endif
        }
    }

    public var ownerName: String {
        didSet { persistOwner() }
    }
    public var ownerPhone: String {
        didSet { persistOwner() }
    }
    public var ownerEmail: String {
        didSet { persistOwner() }
    }

    public func beginCare() {
        guard hasPet else {
            errorMessage = "Add your pet first — clinics need to know who they are being asked about."
            selectedTab = 1
            return
        }
        draft = CareDraft(pet: selectedPet)
        draft.latitude = currentLatitude
        draft.longitude = currentLongitude
        draft.ownerName = ownerName
        draft.ownerPhone = ownerPhone
        draft.ownerEmail = ownerEmail
        route = .intake
    }

    /// Called when a search is submitted, so details typed into the intake
    /// screen are remembered even if Settings was never opened.
    func rememberOwnerFromDraft() {
        if !draft.ownerName.isEmpty { ownerName = draft.ownerName }
        if !draft.ownerPhone.isEmpty { ownerPhone = draft.ownerPhone }
        if !draft.ownerEmail.isEmpty { ownerEmail = draft.ownerEmail }
    }

    private func persistOwner() {
        #if !os(Android)
        defaults.set(ownerName, forKey: "timi.owner.name")
        defaults.set(ownerPhone, forKey: "timi.owner.phone")
        defaults.set(ownerEmail, forKey: "timi.owner.email")
        #endif
    }

    public func setLocation(latitude: Double, longitude: Double) {
        currentLatitude = latitude; currentLongitude = longitude; locationEnabled = true
    }

    public func choosePet(_ id: String) {
        selectedPetId = id
        #if !os(Android)
        defaults.set(id, forKey: "timi.selectedPet")
        #endif
    }

    public func savePet(_ pet: PetProfile) {
        if let index = pets.firstIndex(where: { $0.id == pet.id }) { pets[index] = pet } else { pets.append(pet) }
        selectedPetId = pet.id
        if draft.pet.id == pet.id { draft.pet = pet }
        persistPets()
        // On screen first, stored second. The device copy is what the person
        // is looking at and it is written synchronously; the account copy is
        // what survives a new phone, and a failure to write it must not undo
        // what they just typed. The next sign-in syncs anything that missed.
        Task { [gateway] in try? await gateway.savePet(pet) }
    }

    /// Removes a profile. The last one may go too — an account with no pets is
    /// a real state now, not a crash waiting to happen.
    @discardableResult
    public func deletePet(_ id: String) -> Bool {
        guard let index = pets.firstIndex(where: { $0.id == id }) else { return false }
        pets.remove(at: index)
        Task { [gateway] in try? await gateway.deletePet(id: id) }
        if selectedPetId == id {
            selectedPetId = pets.first?.id ?? ""
            #if !os(Android)
            defaults.set(selectedPetId, forKey: "timi.selectedPet")
            #endif
        }
        if draft.pet.id == id { draft.pet = selectedPet }
        persistPets()
        return true
    }

    public func startSearch() async {
        guard concernValidation.isReady, draft.legalConsent, draft.contactConsent else {
            errorMessage = "Complete the observable concern details and required acknowledgements first."; return
        }
        rememberOwnerFromDraft()
        isWorking = true; errorMessage = nil
        do {
            // Minted fresh if the one in hand is near expiry. A Clerk token
            // lives about a minute, so a search started on a screen opened
            // five minutes ago would otherwise arrive expired.
            try? await auth.ensureFreshToken()
            // An emergency asks a narrower set of hospitals, the way the web
            // client does. Sending every general practice a possible emergency
            // wastes the ninety seconds the search has.
            let care = (draft.urgency == .emergency || !draft.redFlags.isEmpty) ? "emergency" : "urgent"
            locations = try await gateway.locations(latitude: draft.latitude, longitude: draft.longitude, species: draft.pet.species, care: care)
            currentSearch = try await gateway.startSearch(draft, locationIds: locations.prefix(30).map(\.id))
            route = .searching
            // Species and urgency are coarse product facts; the pet's name,
            // the owner and the location deliberately stay out of the meta.
            trackEvent("search_started", path: "intake", meta: ["species": draft.pet.species.rawValue, "urgency": draft.urgency.rawValue])
        } catch { report(error) }
        isWorking = false
    }

    // MARK: - Emergency departments

    /// The nearest emergency-capable hospitals, for the "go now" path.
    ///
    /// Deliberately separate from a care search: this asks nobody for
    /// permission, waits for no clinic to answer, and does not create an
    /// intake. It is a list of places to drive to.
    public var emergencyLocations: [EmergencyPlace] = []
    /// The Worker's wording about where these listings come from. Shown as
    /// given rather than restated, so the caveat cannot drift per screen.
    public var emergencyNotice: String?
    public var isFindingEmergency = false
    public var emergencyError: String?
    public var showEmergencyList = false

    /// Five, not thirty. This is a list somebody reads at arm's length while
    /// picking up a carrier.
    public static let emergencyResultLimit = 5

    public func findEmergencyCare() async {
        isFindingEmergency = true
        emergencyError = nil
        showEmergencyList = true
        trackEvent("emergency_list_opened", path: "emergency")
        do {
            try? await auth.ensureFreshToken()
            let found = try await gateway.emergencyPlaces(
                latitude: currentLatitude, longitude: currentLongitude, species: selectedPet.species
            )
            emergencyNotice = found.notice
            emergencyLocations = Array(found.places.prefix(Self.emergencyResultLimit))
            if emergencyLocations.isEmpty {
                emergencyError = "No emergency hospital was found within 60 miles. Call your regular veterinarian — their outgoing message usually names an after-hours hospital."
            }
        } catch {
            if error is CancellationError || Task.isCancelled { isFindingEmergency = false; return }
            emergencyLocations = []
            emergencyError = Self.describe(error)
        }
        isFindingEmergency = false
    }

    public func refreshSearch() async {
        guard let search = currentSearch, !gateway.isDemo, ["collecting", "offers_ready"].contains(search.status) else { return }
        do { currentSearch = try await gateway.refreshSearch(search.id) }
        catch { report(error) }
    }

    public func selectOffer(_ offer: CareOffer) async {
        guard let search = currentSearch else { return }
        isWorking = true
        do {
            let result = try await gateway.selectOffer(search: search, offer: offer)
            currentSearch = result.search ?? search
            currentIntake = result.intake
            currentIntake?.location = result.location ?? offer.location
            route = .tracker
            showCelebration = true
            history.insert(CareHistoryItem(id: result.intake.id, petName: result.intake.pet?.name ?? selectedPet.name, clinicName: (result.location ?? offer.location)?.name ?? "Veterinary clinic", status: result.intake.status, dateISO: result.intake.decisionAt ?? ""), at: 0)
            persistHistory()
            trackEvent("offer_selected", path: "offers")
        } catch { report(error) }
        isWorking = false
    }

    public func updateIntake(status: String) async {
        guard var intake = currentIntake else { return }
        if gateway.isDemo { intake.status = status; currentIntake = intake }
        else {
            do { currentIntake = try await gateway.updateIntake(intake.id, status: status) }
            catch { report(error) }
        }
    }

    // MARK: - Deposit

    /// The current deposit intent, or nil until the screen asks for one.
    ///
    /// Held here rather than in the view so a redraw does not open a second
    /// PaymentIntent. The Worker's idempotency key would make that harmless at
    /// Stripe, but it would still be a request per redraw.
    public var depositIntent: DepositIntent?
    public var depositBusy = false

    /// Ask the Worker for the deposit intent for the current intake.
    ///
    /// Demo builds have no Stripe credentials, so the Worker completes the
    /// deposit locally and answers `mode: "demo"`. That path has to keep
    /// working — the whole test suite and every offline demo run through it —
    /// and it must be visibly a demo rather than a card form that goes
    /// nowhere.
    public func prepareDeposit() async {
        guard let intake = currentIntake, (intake.depositAmountCents ?? 0) > 0 else { return }
        if gateway.isDemo {
            var value = intake
            value.paymentStatus = "paid"
            currentIntake = value
            depositIntent = DepositIntent(mode: "demo", depositAmountCents: intake.depositAmountCents, intake: value)
            return
        }
        depositBusy = true
        do {
            let intent = try await gateway.createDepositIntent(intakeId: intake.id)
            depositIntent = intent
            if let updated = intent.intake { currentIntake = updated }
        } catch { report(error) }
        depositBusy = false
    }

    /// Called after Stripe reports the payment confirmed on the device.
    ///
    /// It re-reads the intake from the Worker rather than setting
    /// `paymentStatus` locally. The phone is not the authority on whether a
    /// payment cleared: the confirmation can arrive here and never reach
    /// Stripe, the app can be killed between the two, and a client that can
    /// mark itself paid is a client that can lie. `payment_intent.succeeded`
    /// on the webhook is what actually changes the row; this just asks what it
    /// says now.
    public func refreshDepositStatus() async {
        guard let intake = currentIntake, !gateway.isDemo else { return }
        // This method's only caller is the Stripe sheet reporting a completed
        // confirmation on-device, which makes it the client-side "payment
        // succeeded" moment — the webhook remains the authority on the money.
        trackEvent("deposit_paid", path: "tracker")
        do { currentIntake = try await gateway.refreshIntake(intake.id) }
        catch { report(error) }
    }

    public func record(_ milestone: String) async {
        guard var intake = currentIntake else { return }
        do { try await gateway.recordObservation(intake: intake, milestone: milestone); intake.status = milestone; currentIntake = intake }
        catch { report(error) }
    }

    public func resetCareFlow() {
        currentSearch = nil; currentIntake = nil; route = .home; selectedTab = 0
        navigationDestination = nil; currentNavigationStep = nil; currentRouteSummary = nil
    }

    /// Refreshes the Mapbox token, style URLs, fee disclosure, and legal
    /// version from `GET /api/config`. Falls back silently to the compiled-in
    /// defaults (already the initial values) whenever the Worker is
    /// unreachable or running in demo mode — every field here has one, so a
    /// launch on a dead connection changes nothing.
    public func loadMapConfig() async {
        guard let config = try? await gateway.fetchAppConfig() else { return }
        if let token = config.map?.token, !token.isEmpty { mapToken = token }
        if let styleUrl = config.map?.styleUrl, !styleUrl.isEmpty { mapStyleURL = styleUrl }
        if let navStyleUrl = config.map?.navigationStyleUrl, !navStyleUrl.isEmpty { navigationStyleURL = navStyleUrl }
        if let fee = config.fees?.customerFeeCents, fee > 0 { customerFeeCents = fee }
        // The Worker's own terms version outranks the compiled one, so a
        // server-side legal bump does not 422 every care request from builds
        // already in the field.
        if let legal = config.legalVersion, !legal.isEmpty { gateway.acceptedLegalVersion = legal }
    }

    // MARK: - Analytics

    /// True once this launch's app_open has gone out, so a second root task —
    /// a scene reconnecting, a preview — cannot double-count a launch.
    private var hasRecordedAppOpen = false

    /// One fire-and-forget product event. Never blocks the caller and never
    /// surfaces a failure — analytics must not be a second thing to go wrong.
    /// Nothing here may carry a user id or a coordinate: the endpoint is
    /// cookieless by contract, and this is the client's half of that promise.
    func trackEvent(_ name: String, path: String? = nil, meta: [String: String]? = nil) {
        Task { [gateway] in await gateway.recordAnalytics([TimiAnalyticsEvent(name: name, path: path, meta: meta)]) }
    }

    /// Called from the root view's launch task, once per process.
    public func recordAppOpen() {
        guard !hasRecordedAppOpen else { return }
        hasRecordedAppOpen = true
        trackEvent("app_open")
    }

    /// Called from the navigation screen as Mapbox reports progress, and
    /// mirrored to the Watch app by `WatchBridge`.
    public func updateNavigationProgress(step: NavigationStepModel?, summary: RouteSummary?) {
        currentNavigationStep = step
        currentRouteSummary = summary
    }

    public func beginNavigation(to destination: NavigationDestination) {
        navigationDestination = destination
        // The destination's name and coordinates deliberately stay out of the
        // event — where somebody drove is not a product metric.
        trackEvent("navigation_started", path: "navigation")
    }

    public func saveAPIBaseURL() {
        let trimmed = apiBaseURLText.trimmingCharacters(in: .whitespacesAndNewlines)
        apiBaseURLText = trimmed
        #if !os(Android)
        defaults.set(trimmed, forKey: "timi.apiBaseURL")
        #endif
        gateway.baseURL = Self.validBaseURL(trimmed)
    }

    public func resetOnboarding() {
        hasCompletedOnboarding = false
        onboardingNames = []
        onboardingPetIndex = -1
        onboardingSignInRequested = false
        #if !os(Android)
        defaults.set(false, forKey: "timi.onboarding.complete")
        defaults.removeObject(forKey: "timi.onboarding.names")
        defaults.removeObject(forKey: "timi.onboarding.petIndex")
        #endif
    }

    private func persistPets() {
        #if !os(Android)
        defaults.set(try? JSONEncoder().encode(pets), forKey: "timi.pets")
        defaults.set(selectedPetId, forKey: "timi.selectedPet")
        #endif
    }
    private func persistHistory() {
        #if !os(Android)
        defaults.set(try? JSONEncoder().encode(history), forKey: "timi.history")
        #endif
    }
    private func persistNavigationPreferences() {
        #if !os(Android)
        defaults.set(try? JSONEncoder().encode(navigationPreferences), forKey: "timi.navigation.preferences")
        #endif
    }
    private static func decode<T: Decodable>(_ type: T.Type, from data: Data?) -> T? { guard let data else { return nil }; return try? JSONDecoder().decode(type, from: data) }
    /// TimiAPIError is not a LocalizedError — Skip cannot translate one — so
    /// `localizedDescription` on it yields "The operation couldn't be
    /// completed. (TimiNowCore.TimiAPIError error 0.)" and nothing else.
    /// Every catch block goes through here so the real message reaches the
    /// screen.
    /// Shows an error, unless it is a cancellation.
    ///
    /// Every screen that polls does so from a `.task`, which SwiftUI cancels
    /// when the screen goes away — including when somebody presses Cancel. The
    /// request in flight is cancelled with it, and reporting that as a failure
    /// tells them something broke at the exact moment they asked for it to
    /// stop.
    func report(_ error: Error) {
        if error is CancellationError || Task.isCancelled { return }
        let failure = ErrorPresenter.present(error)
        guard !failure.message.isEmpty else { return }
        errorMessage = failure.displayText
        // The detail leaves the screen and goes where somebody can act on it.
        // Fire-and-forget: a failed report must never become a second error.
        let diagnostics = ErrorPresenter.diagnostics(error)
        let report = ClientErrorReport(
            surface: "customer_ios",
            appVersion: TimiEnvironment.appVersion,
            path: diagnostics.path,
            status: diagnostics.status,
            code: diagnostics.code,
            message: diagnostics.message,
            reference: failure.reference,
            detail: ["route": String(describing: route), "demo": String(gateway.isDemo)]
        )
        Task { [gateway] in await gateway.reportFailure(report) }
    }

    static func describe(_ error: Error) -> String {
        if let apiError = error as? TimiAPIError { return apiError.message }
        return error.localizedDescription
    }

    private static func validBaseURL(_ text: String) -> URL? { guard let url = URL(string: text), url.scheme == "https", url.host != nil else { return nil }; return url }
}
