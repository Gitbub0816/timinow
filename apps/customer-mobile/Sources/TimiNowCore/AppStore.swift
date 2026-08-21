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
        let apiBaseURLText = ""
        #else
        let defaults = UserDefaults.standard
        self.defaults = defaults
        let storedPets = Self.decode([PetProfile].self, from: defaults.data(forKey: "timi.pets")) ?? [DemoData.pet]
        let selectedPetId = defaults.string(forKey: "timi.selectedPet") ?? storedPets[0].id
        let storedHistory = Self.decode([CareHistoryItem].self, from: defaults.data(forKey: "timi.history")) ?? []
        let completedOnboarding = defaults.bool(forKey: "timi.onboarding.complete")
        let apiBaseURLText = defaults.string(forKey: "timi.apiBaseURL") ?? ""
        #endif
        self.pets = storedPets
        self.selectedPetId = selectedPetId
        let selected = storedPets.first(where: { $0.id == selectedPetId }) ?? storedPets[0]
        self.draft = CareDraft(pet: selected)
        self.history = storedHistory
        self.hasCompletedOnboarding = completedOnboarding
        self.apiBaseURLText = apiBaseURLText
        self.gateway = TimiGateway(baseURL: Self.validBaseURL(apiBaseURLText))
    }

    public var selectedPet: PetProfile { pets.first(where: { $0.id == selectedPetId }) ?? pets[0] }
    public var isDemoMode: Bool { gateway.isDemo }
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

    public func beginCare() {
        draft = CareDraft(pet: selectedPet)
        draft.latitude = currentLatitude
        draft.longitude = currentLongitude
        route = .intake
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
        isWorking = true; errorMessage = nil
        do {
            locations = try await gateway.locations(latitude: draft.latitude, longitude: draft.longitude, species: draft.pet.species)
            currentSearch = try await gateway.startSearch(draft, locationIds: locations.prefix(30).map(\.id))
            route = .searching
        } catch { errorMessage = error.localizedDescription }
        isWorking = false
    }

    public func refreshSearch() async {
        guard let search = currentSearch, !gateway.isDemo, ["collecting", "offers_ready"].contains(search.status) else { return }
        do { currentSearch = try await gateway.refreshSearch(search.id) }
        catch { errorMessage = error.localizedDescription }
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
        } catch { errorMessage = error.localizedDescription }
        isWorking = false
    }

    public func updateIntake(status: String) async {
        guard var intake = currentIntake else { return }
        if gateway.isDemo { intake.status = status; currentIntake = intake }
        else {
            do { currentIntake = try await gateway.updateIntake(intake.id, status: status) }
            catch { errorMessage = error.localizedDescription }
        }
    }

    public func record(_ milestone: String) async {
        guard var intake = currentIntake else { return }
        do { try await gateway.recordObservation(intake: intake, milestone: milestone); intake.status = milestone; currentIntake = intake }
        catch { errorMessage = error.localizedDescription }
    }

    public func resetCareFlow() { currentSearch = nil; currentIntake = nil; route = .home; selectedTab = 0 }

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
    private static func decode<T: Decodable>(_ type: T.Type, from data: Data?) -> T? { guard let data else { return nil }; return try? JSONDecoder().decode(type, from: data) }
    private static func validBaseURL(_ text: String) -> URL? { guard let url = URL(string: text), url.scheme == "https", url.host != nil else { return nil }; return url }
}
