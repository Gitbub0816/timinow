import Foundation
import Observation
import SkipFuse

public enum CustomerRoute: String, Codable, Sendable { case home, intake, searching, tracker }

@MainActor @Observable public final class AppStore {
    public var hasCompletedOnboarding: Bool
    public var onboardingPage = 0
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

    public init() {
        #if os(Android)
        let storedPets = [DemoData.pet]
        let selectedPetId = storedPets[0].id
        let storedHistory: [CareHistoryItem] = []
        let completedOnboarding = false
        let apiBaseURLText = TimiEnvironment.defaultAPIBaseURL
        let storedOwner = ("", "", "")
        let storedDeveloperMode = false
        let storedNavigationPreferences = NavigationPreferences.default
        #else
        let defaults = UserDefaults.standard
        self.defaults = defaults
        let storedPets = Self.decode([PetProfile].self, from: defaults.data(forKey: "timi.pets")) ?? [DemoData.pet]
        let selectedPetId = defaults.string(forKey: "timi.selectedPet") ?? storedPets[0].id
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
        #endif
        self.pets = storedPets
        self.selectedPetId = selectedPetId
        let selected = storedPets.first(where: { $0.id == selectedPetId }) ?? storedPets[0]
        self.draft = CareDraft(pet: selected)
        self.history = storedHistory
        self.hasCompletedOnboarding = completedOnboarding
        self.apiBaseURLText = apiBaseURLText
        self.developerModeEnabled = storedDeveloperMode
        self.ownerName = storedOwner.0
        self.ownerPhone = storedOwner.1
        self.ownerEmail = storedOwner.2
        self.navigationPreferences = storedNavigationPreferences
        self.gateway = TimiGateway(baseURL: Self.validBaseURL(apiBaseURLText))
    }

    /// Sign-in, and the token every Worker call carries.
    ///
    /// Built here rather than in a view so a session restored at launch is
    /// already in place before the first screen asks for anything.
    public private(set) lazy var auth: AuthController = AuthController(gateway: gateway)

    /// Single shared instance so the CarPlay scene and the Watch
    /// connectivity bridge — both instantiated by the OS outside the main
    /// SwiftUI view hierarchy — observe the same live state as the phone UI.
    public static let shared = AppStore()

    public var selectedPet: PetProfile { pets.first(where: { $0.id == selectedPetId }) ?? pets[0] }
    public var isDemoMode: Bool { gateway.isDemo }
    /// What the gateway resolved to, which is not always what is in the text
    /// field — an address that fails validation leaves the gateway on nothing
    /// at all, and the difference is worth being able to see.
    public var resolvedAPIAddress: String {
        let address = gateway.configuredAddress
        return address.isEmpty ? "nothing — demo data" : address
    }
    public var concernValidation: ConcernValidation { ConcernValidator.evaluate(summary: draft.summary, symptoms: draft.symptomKeys, startedWhen: draft.startedWhen) }

    public func completeOnboarding(name: String, species: PetSpecies) {
        if pets.count == 1 && pets[0] == DemoData.pet && !name.isEmpty {
            pets = [PetProfile(name: name, species: species, colorToken: 0)]
            selectedPetId = pets[0].id
            draft = CareDraft(pet: pets[0])
        }
        hasCompletedOnboarding = true
        #if !os(Android)
        defaults.set(true, forKey: "timi.onboarding.complete")
        #endif
        persistPets()
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
        persistPets()
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
            locations = try await gateway.locations(latitude: draft.latitude, longitude: draft.longitude, species: draft.pet.species)
            currentSearch = try await gateway.startSearch(draft, locationIds: locations.prefix(30).map(\.id))
            route = .searching
        } catch { errorMessage = Self.describe(error) }
        isWorking = false
    }

    public func refreshSearch() async {
        guard let search = currentSearch, !gateway.isDemo, ["collecting", "offers_ready"].contains(search.status) else { return }
        do { currentSearch = try await gateway.refreshSearch(search.id) }
        catch { errorMessage = Self.describe(error) }
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
        } catch { errorMessage = Self.describe(error) }
        isWorking = false
    }

    public func updateIntake(status: String) async {
        guard var intake = currentIntake else { return }
        if gateway.isDemo { intake.status = status; currentIntake = intake }
        else {
            do { currentIntake = try await gateway.updateIntake(intake.id, status: status) }
            catch { errorMessage = Self.describe(error) }
        }
    }

    public func record(_ milestone: String) async {
        guard var intake = currentIntake else { return }
        do { try await gateway.recordObservation(intake: intake, milestone: milestone); intake.status = milestone; currentIntake = intake }
        catch { errorMessage = Self.describe(error) }
    }

    public func resetCareFlow() {
        currentSearch = nil; currentIntake = nil; route = .home; selectedTab = 0
        navigationDestination = nil; currentNavigationStep = nil; currentRouteSummary = nil
    }

    /// Refreshes the Mapbox token and style URLs from `GET /api/config`.
    /// Falls back silently to the compiled-in `MapDefaults.styleURL` (already
    /// the initial value of `mapStyleURL`/`navigationStyleURL`) whenever the
    /// Worker is unreachable or running in demo mode.
    public func loadMapConfig() async {
        guard let config = try? await gateway.fetchMapConfig() else { return }
        if let token = config.token, !token.isEmpty { mapToken = token }
        if let styleUrl = config.styleUrl, !styleUrl.isEmpty { mapStyleURL = styleUrl }
        if let navStyleUrl = config.navigationStyleUrl, !navStyleUrl.isEmpty { navigationStyleURL = navStyleUrl }
    }

    /// Called from the navigation screen as Mapbox reports progress, and
    /// mirrored to the Watch app by `WatchBridge`.
    public func updateNavigationProgress(step: NavigationStepModel?, summary: RouteSummary?) {
        currentNavigationStep = step
        currentRouteSummary = summary
    }

    public func beginNavigation(to destination: NavigationDestination) {
        navigationDestination = destination
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
        onboardingPage = 0
        #if !os(Android)
        defaults.set(false, forKey: "timi.onboarding.complete")
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
    static func describe(_ error: Error) -> String {
        if let apiError = error as? TimiAPIError { return apiError.message }
        return error.localizedDescription
    }

    private static func validBaseURL(_ text: String) -> URL? { guard let url = URL(string: text), url.scheme == "https", url.host != nil else { return nil }; return url }
}
