import Foundation

public enum CareUrgency: String, Codable, CaseIterable, Sendable {
    case sameDay = "same_day"
    case urgent
    case emergency

    public var title: String {
        switch self {
        case .sameDay: return "Today"
        case .urgent: return "As soon as possible"
        case .emergency: return "Possible emergency"
        }
    }
}

public enum PetSpecies: String, Codable, CaseIterable, Sendable {
    case dog, cat, rabbit, bird, reptile, other
    public var title: String { rawValue.prefix(1).uppercased() + rawValue.dropFirst() }
    public var icon: String {
        switch self { case .dog: return "pawprint.fill"; case .cat: return "cat.fill"; case .rabbit: return "hare.fill"; case .bird: return "bird.fill"; default: return "heart.fill" }
    }
}

public struct PetProfile: Identifiable, Codable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var species: PetSpecies
    public var breed: String
    public var weightLbs: Double?
    public var birthYear: Int?
    public var colorToken: Int
    /// Optional, always. What the owner chose to write down, passed to the
    /// clinic as typed. Not a medical record: nothing here comes from a
    /// veterinarian, and no request needs it.
    public var medications: String
    public var allergies: String

    public init(id: String = UUID().uuidString, name: String, species: PetSpecies, breed: String = "", weightLbs: Double? = nil, birthYear: Int? = nil, colorToken: Int = 0, medications: String = "", allergies: String = "") {
        self.id = id; self.name = name; self.species = species; self.breed = breed; self.weightLbs = weightLbs; self.birthYear = birthYear; self.colorToken = colorToken
        self.medications = medications; self.allergies = allergies
    }

    // Explicit, so a profile stored before these existed still decodes. Swift's
    // synthesized init(from:) does not fall back to a property's default when
    // the key is absent — it throws — and every pet on every phone was written
    // without them.
    enum CodingKeys: String, CodingKey {
        case id, name, species, breed, weightLbs, birthYear, colorToken, medications, allergies
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        species = try container.decode(PetSpecies.self, forKey: .species)
        breed = try container.decodeIfPresent(String.self, forKey: .breed) ?? ""
        weightLbs = try container.decodeIfPresent(Double.self, forKey: .weightLbs)
        birthYear = try container.decodeIfPresent(Int.self, forKey: .birthYear)
        colorToken = try container.decodeIfPresent(Int.self, forKey: .colorToken) ?? 0
        medications = try container.decodeIfPresent(String.self, forKey: .medications) ?? ""
        allergies = try container.decodeIfPresent(String.self, forKey: .allergies) ?? ""
    }
}

public struct CareDraft: Codable, Hashable, Sendable {
    public var pet: PetProfile
    public var symptomKeys: [String] = []
    public var startedWhen = ""
    public var summary = ""
    public var urgency: CareUrgency = .urgent
    public var ownerName = ""
    public var ownerPhone = ""
    public var ownerEmail = ""
    public var latitude = 37.6688
    public var longitude = -122.0808
    public var legalConsent = false
    public var contactConsent = false
    public var redFlags: [String] = []

    public init(pet: PetProfile) { self.pet = pet }
}

public struct ClinicPolicy: Codable, Hashable, Sendable {
    public var id: String?
    public var version: Int?
    public var depositRequired: Bool?
    public var depositAmountCents: Int?
    public var depositRefundable: Bool?
    public var freeCancelMinutes: Int?
    public var completedPlatformFeeCents: Int?
    public var noShowPlatformFeeCents: Int?
}

public struct ClinicAvailability: Codable, Hashable, Sendable {
    public var intakeStatus: String
    public var label: String?
    public var stableWaitMin: Int?
    public var stableWaitMax: Int?
    public var capacityCount: Int?
    public var acceptsCritical: Bool?
    public var source: String?
    public var confidence: String?
    public var note: String?
    public var reportedAt: String?
    public var expiresAt: String?
}

public struct ClinicLocation: Identifiable, Codable, Hashable, Sendable {
    public var id: String
    public var tenantId: String?
    public var name: String
    public var kind: String?
    public var address: String?
    public var phone: String?
    public var latitude: Double?
    public var longitude: Double?
    public var distanceMiles: Double?
    public var baseExamFeeCents: Int?
    public var capabilities: [String]?
    /// `veterinarian` or `veterinary_technician`, set by a platform operator.
    public var staffingLevel: String?
    /// The notice to show when this provider is technician-staffed. Composed by
    /// the Worker so the wording is identical on every surface; nil when a
    /// veterinarian staffs the place.
    public var staffingNotice: String?
    public var availability: ClinicAvailability?
    public var policy: ClinicPolicy?

    public init(id: String, tenantId: String? = nil, name: String, kind: String? = nil, address: String? = nil, phone: String? = nil, latitude: Double? = nil, longitude: Double? = nil, distanceMiles: Double? = nil, baseExamFeeCents: Int? = nil, capabilities: [String]? = nil, staffingLevel: String? = nil, staffingNotice: String? = nil, availability: ClinicAvailability? = nil, policy: ClinicPolicy? = nil) {
        self.id = id; self.tenantId = tenantId; self.name = name; self.kind = kind; self.address = address; self.phone = phone
        self.latitude = latitude; self.longitude = longitude; self.distanceMiles = distanceMiles; self.baseExamFeeCents = baseExamFeeCents
        self.capabilities = capabilities; self.staffingLevel = staffingLevel; self.staffingNotice = staffingNotice
        self.availability = availability; self.policy = policy
    }
}

/// One place to drive to in an emergency.
///
/// Not a `ClinicLocation`: most of these are not Tími providers at all. They
/// come from map data — a name, an address, a phone number and a point — and
/// nothing about them says a hospital is open, equipped, or accepting
/// patients. `partner` marks the ones Tími can actually send a request to.
public struct EmergencyPlace: Identifiable, Codable, Hashable, Sendable {
    public var id: String
    public var source: String
    public var partner: Bool
    public var name: String
    public var address: String?
    public var phone: String?
    public var latitude: Double?
    public var longitude: Double?
    public var distanceMiles: Double?
    /// Whether the name says it takes emergencies. A label, never a claim.
    public var emergencyNamed: Bool?
    public var staffingNotice: String?
    public var availabilityLabel: String?

    public init(id: String, source: String = "map", partner: Bool = false, name: String, address: String? = nil, phone: String? = nil, latitude: Double? = nil, longitude: Double? = nil, distanceMiles: Double? = nil, emergencyNamed: Bool? = nil, staffingNotice: String? = nil, availabilityLabel: String? = nil) {
        self.id = id; self.source = source; self.partner = partner; self.name = name; self.address = address
        self.phone = phone; self.latitude = latitude; self.longitude = longitude; self.distanceMiles = distanceMiles
        self.emergencyNamed = emergencyNamed; self.staffingNotice = staffingNotice; self.availabilityLabel = availabilityLabel
    }
}

public struct EmergencyPlacesEnvelope: Codable, Sendable {
    public var notice: String?
    public var places: [EmergencyPlace]
}

public struct CareOffer: Identifiable, Codable, Hashable, Sendable {
    public var id: String
    public var searchId: String?
    public var targetId: String?
    public var locationId: String
    public var tenantId: String?
    public var responseType: String
    public var status: String
    public var availableAt: String?
    public var arrivalBy: String?
    public var waitMin: Int?
    public var waitMax: Int?
    public var clinicNote: String?
    public var policy: ClinicPolicy?
    public var depositAmountCents: Int?
    public var baseExamFeeCents: Int?
    public var offeredAt: String?
    public var expiresAt: String?
    public var location: ClinicLocation?
}

public struct SearchProgress: Codable, Hashable, Sendable {
    public var contacted: Int?
    public var awaiting: Int?
    public var declined: Int?
    public var offers: Int?
}

public struct CareSearch: Identifiable, Codable, Hashable, Sendable {
    public var id: String
    public var publicCode: String?
    public var pet: PetProfilePayload?
    public var owner: OwnerPayload?
    public var concernCategory: String?
    public var concernSummary: String?
    public var urgency: String?
    public var redFlags: [String]?
    public var status: String
    public var maxOffers: Int?
    public var targetLimit: Int?
    public var selectedOfferId: String?
    public var selectedIntakeId: String?
    public var requestedAt: String?
    public var collectionExpiresAt: String?
    public var searchExpiresAt: String?
    public var offers: [CareOffer]?
    public var progress: SearchProgress?
    public var demo: Bool?
}

/// A stored pet on its way to `/api/pets`.
///
/// Not to be confused with `PetPayload` in APIClient.swift, which is the pet
/// *inside a care search* — no id, no card colour, and a different set of
/// fields, because a clinic being asked about an animal needs different things
/// from a record being filed against an account. Naming this one PetPayload
/// too was a build error rather than a subtle bug, which was lucky.
///
/// Separate from `PetProfile` because the wire shape is the Worker's to define
/// — `species` is its string vocabulary, not this app's enum.
public struct StoredPetPayload: Codable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var species: String
    public var breed: String?
    public var weightLbs: Double?
    public var birthYear: Int?
    public var colorToken: Int
    public var medications: String?
    public var allergies: String?

    public init(_ pet: PetProfile) {
        id = pet.id
        name = pet.name
        species = pet.species.rawValue
        breed = pet.breed.isEmpty ? nil : pet.breed
        weightLbs = pet.weightLbs
        birthYear = pet.birthYear
        colorToken = pet.colorToken
        medications = pet.medications.isEmpty ? nil : pet.medications
        allergies = pet.allergies.isEmpty ? nil : pet.allergies
    }
}

public struct PetSyncPayload: Codable, Sendable {
    public var pets: [StoredPetPayload]
}

public struct PetsEnvelope: Decodable, Sendable {
    public var pets: [PetProfile]
}

public struct PetEnvelope: Decodable, Sendable {
    public var pet: PetProfile
}

public struct RemovedEnvelope: Decodable, Sendable {
    public var removed: Bool?
}

public struct PetProfilePayload: Codable, Hashable, Sendable {
    public var name: String
    public var species: String
    public var breed: String?
    public var ageYears: Double?
    public var weightLbs: Double?
}

public struct OwnerPayload: Codable, Hashable, Sendable {
    public var name: String
    public var phone: String
    public var email: String?
}

public struct CareIntake: Identifiable, Codable, Hashable, Sendable {
    public var id: String
    public var publicCode: String?
    public var locationId: String
    public var tenantId: String?
    public var pet: PetProfilePayload?
    public var owner: OwnerPayload?
    public var concernSummary: String?
    public var urgency: String?
    public var redFlags: [String]?
    public var status: String
    public var clinicNote: String?
    public var requestedAt: String?
    public var decisionAt: String?
    public var requestExpiresAt: String?
    public var arrivalBy: String?
    public var policy: ClinicPolicy?
    public var depositAmountCents: Int?
    public var paymentStatus: String?
    public var sourceSearchId: String?
    public var selectedOfferId: String?
    public var location: ClinicLocation?
}

public struct CareSearchEnvelope: Codable, Sendable { public var search: CareSearch }
public struct LocationsEnvelope: Codable, Sendable { public var locations: [ClinicLocation] }
public struct IntakeEnvelope: Codable, Sendable { public var intake: CareIntake; public var location: ClinicLocation?; public var search: CareSearch? }
/// Matches what the Worker actually sends.
///
/// `apiError` in src/index.js returns `{ "error": { "code", "message",
/// "details" } }` — a nested object. This was declared with `error` and
/// `message` as top-level strings, so decoding threw on every single error
/// response, the `try?` swallowed it, and the app fell back to a generic
/// sentence. Every server error the app has ever shown has been that
/// fallback: the Worker's actual reason has never once reached the screen.
public struct APIErrorEnvelope: Codable, Sendable {
    public struct Failure: Codable, Sendable {
        public var code: String?
        public var message: String?
        public var details: [String]?
    }
    public var error: Failure?
}

public struct CareHistoryItem: Identifiable, Codable, Hashable, Sendable {
    public var id: String
    public var petName: String
    public var clinicName: String
    public var status: String
    public var dateISO: String
}
