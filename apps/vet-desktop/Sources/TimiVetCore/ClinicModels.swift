import Foundation

// Swift port of apps/vet-windows/src/TimiVet/Models/ClinicModels.cs.
// Field names match the Worker JSON (`/api/clinic/*`) exactly so no custom
// CodingKeys are needed anywhere in this file.

public struct ClinicPolicy: Codable, Hashable, Sendable {
    public var version: Int?
    public var depositRequired: Bool?
    public var depositAmountCents: Int?
    public var freeCancelMinutes: Int?
    public var completedPlatformFeeCents: Int?
    public var noShowPlatformFeeCents: Int?

    public init(version: Int? = nil, depositRequired: Bool? = nil, depositAmountCents: Int? = nil, freeCancelMinutes: Int? = nil, completedPlatformFeeCents: Int? = nil, noShowPlatformFeeCents: Int? = nil) {
        self.version = version; self.depositRequired = depositRequired; self.depositAmountCents = depositAmountCents
        self.freeCancelMinutes = freeCancelMinutes; self.completedPlatformFeeCents = completedPlatformFeeCents; self.noShowPlatformFeeCents = noShowPlatformFeeCents
    }
}

public struct ClinicAvailability: Codable, Hashable, Sendable {
    public var intakeStatus: String
    public var label: String?
    public var stableWaitMin: Int?
    public var stableWaitMax: Int?
    public var capacityCount: Int?
    public var acceptsCritical: Bool
    public var source: String?
    public var confidence: String?
    public var note: String?
    public var reportedAt: String?
    public var expiresAt: String?

    public init(intakeStatus: String = "unverified", label: String? = nil, stableWaitMin: Int? = nil, stableWaitMax: Int? = nil, capacityCount: Int? = nil, acceptsCritical: Bool = false, source: String? = nil, confidence: String? = nil, note: String? = nil, reportedAt: String? = nil, expiresAt: String? = nil) {
        self.intakeStatus = intakeStatus; self.label = label; self.stableWaitMin = stableWaitMin; self.stableWaitMax = stableWaitMax
        self.capacityCount = capacityCount; self.acceptsCritical = acceptsCritical; self.source = source; self.confidence = confidence
        self.note = note; self.reportedAt = reportedAt; self.expiresAt = expiresAt
    }
}

public struct ClinicLocationSummary: Codable, Hashable, Sendable {
    public var id: String
    public var tenantId: String?
    public var name: String
    public var address: String?
    public var phone: String?
    public var kind: String?
    public var availability: ClinicAvailability
    public var policy: ClinicPolicy

    public init(id: String = "", tenantId: String? = nil, name: String = "Veterinary clinic", address: String? = nil, phone: String? = nil, kind: String? = nil, availability: ClinicAvailability = ClinicAvailability(), policy: ClinicPolicy = ClinicPolicy()) {
        self.id = id; self.tenantId = tenantId; self.name = name; self.address = address; self.phone = phone; self.kind = kind
        self.availability = availability; self.policy = policy
    }
}

public struct PetSummary: Codable, Hashable, Sendable {
    public var name: String
    public var species: String
    public var breed: String?
    public var ageYears: Double?
    public var weightLbs: Double?
    /// Optional, owner-supplied, unverified. Shown so the desk is not hearing
    /// it for the first time when the animal walks in — not as a record, and
    /// never as something to act on without confirming.
    public var medications: String?
    public var allergies: String?

    public init(name: String = "Pet", species: String = "other", breed: String? = nil, ageYears: Double? = nil, weightLbs: Double? = nil, medications: String? = nil, allergies: String? = nil) {
        self.name = name; self.species = species; self.breed = breed; self.ageYears = ageYears; self.weightLbs = weightLbs
        self.medications = medications; self.allergies = allergies
    }
}

public struct OwnerSummary: Codable, Hashable, Sendable {
    public var name: String
    public var phone: String
    public var email: String?

    public init(name: String = "", phone: String = "", email: String? = nil) {
        self.name = name; self.phone = phone; self.email = email
    }
}

public struct ClinicRequest: Identifiable, Codable, Hashable, Sendable {
    public var id: String
    public var searchId: String?
    public var publicCode: String?
    public var locationId: String
    public var tenantId: String
    public var pet: PetSummary
    public var owner: OwnerSummary
    public var concernSummary: String
    public var urgency: String
    public var redFlags: [String]
    public var travelMinutes: Int?
    public var status: String
    public var requestedAt: String?
    public var requestExpiresAt: String?
    public var updatedAt: String?
    public var searchTarget: Bool

    public init(id: String = "", searchId: String? = nil, publicCode: String? = nil, locationId: String = "", tenantId: String = "", pet: PetSummary = PetSummary(), owner: OwnerSummary = OwnerSummary(), concernSummary: String = "", urgency: String = "urgent", redFlags: [String] = [], travelMinutes: Int? = nil, status: String = "pending", requestedAt: String? = nil, requestExpiresAt: String? = nil, updatedAt: String? = nil, searchTarget: Bool = false) {
        self.id = id; self.searchId = searchId; self.publicCode = publicCode; self.locationId = locationId; self.tenantId = tenantId
        self.pet = pet; self.owner = owner; self.concernSummary = concernSummary; self.urgency = urgency; self.redFlags = redFlags
        self.travelMinutes = travelMinutes; self.status = status; self.requestedAt = requestedAt; self.requestExpiresAt = requestExpiresAt
        self.updatedAt = updatedAt; self.searchTarget = searchTarget
    }

    public var petLine: String { "\(pet.name) · \(Self.display(pet.species))" }
    public var requestType: String { searchTarget ? "MULTI-CLINIC SEARCH" : "DIRECT INTAKE" }
    public var travelLabel: String { travelMinutes.map { "\($0) min away" } ?? "Travel unknown" }
    public var requestedLabel: String {
        guard let requestedAt, let date = ClinicDateFormat.parse(requestedAt) else { return "Just now" }
        return ClinicDateFormat.shortTime(date)
    }
    public var isEmergency: Bool { urgency == "emergency" || !redFlags.isEmpty }

    private static func display(_ value: String) -> String { value.replacingOccurrences(of: "_", with: " ").uppercased() }
}

public struct ClinicMetrics: Codable, Hashable, Sendable {
    public var pending: Int
    public var activeArrivals: Int
    public var completedToday: Int
    public var declinedToday: Int

    public init(pending: Int = 0, activeArrivals: Int = 0, completedToday: Int = 0, declinedToday: Int = 0) {
        self.pending = pending; self.activeArrivals = activeArrivals; self.completedToday = completedToday; self.declinedToday = declinedToday
    }
}

public struct ClinicDashboard: Codable, Sendable {
    public var location: ClinicLocationSummary
    public var requests: [ClinicRequest]
    public var metrics: ClinicMetrics

    public init(location: ClinicLocationSummary = ClinicLocationSummary(), requests: [ClinicRequest] = [], metrics: ClinicMetrics = ClinicMetrics()) {
        self.location = location; self.requests = requests; self.metrics = metrics
    }
}

/// Body of `POST /api/clinic/availability`.
public struct AvailabilityUpdate: Codable, Sendable {
    public var intakeStatus: String = "available"
    public var stableWaitMin: Int = 15
    public var stableWaitMax: Int = 35
    public var capacityCount: Int = 3
    public var ttlMinutes: Int = 30
    public var acceptsCritical: Bool = true
    public var note: String = "Accepting stable urgent-care arrivals."

    public init(intakeStatus: String = "available", stableWaitMin: Int = 15, stableWaitMax: Int = 35, capacityCount: Int = 3, ttlMinutes: Int = 30, acceptsCritical: Bool = true, note: String = "Accepting stable urgent-care arrivals.") {
        self.intakeStatus = intakeStatus; self.stableWaitMin = stableWaitMin; self.stableWaitMax = stableWaitMax
        self.capacityCount = capacityCount; self.ttlMinutes = ttlMinutes; self.acceptsCritical = acceptsCritical; self.note = note
    }
}

/// Client-side decision form. `ClinicAPIClient.respond` shapes this into the two
/// different wire payloads the Worker expects (search-target vs. direct intake).
public struct DecisionPayload: Sendable {
    public var decision: String = "offer"
    public var responseType: String = "available_now"
    public var availableAt: String?
    public var arrivalWindowMinutes: Int = 30
    public var holdMinutes: Int = 5
    public var waitMin: Int = 15
    public var waitMax: Int = 35
    public var note: String = ""

    public init(decision: String = "offer", responseType: String = "available_now", availableAt: String? = nil, arrivalWindowMinutes: Int = 30, holdMinutes: Int = 5, waitMin: Int = 15, waitMax: Int = 35, note: String = "") {
        self.decision = decision; self.responseType = responseType; self.availableAt = availableAt
        self.arrivalWindowMinutes = arrivalWindowMinutes; self.holdMinutes = holdMinutes; self.waitMin = waitMin; self.waitMax = waitMax; self.note = note
    }
}

public enum TimiVetEnvironment {
    /// Where a fresh install talks to.
    ///
    /// This was empty, and an empty address means the console never reaches
    /// /api/config, never learns the Clerk publishable key, and reports it as
    /// "Tími could not reach Clerk" — which sends you looking at Clerk and at
    /// DNS rather than at a blank field in Settings. Settings still overrides
    /// it; this is only the starting point.
    public static let defaultAPIBaseURL = "https://providers.timinow.pet"
}

/// Whether Tími may ring this clinic, and on what number.
///
/// A practice with one person at the desk and a phone already ringing has a
/// real reason to say no to an automated call, and until now had no way to.
public struct CallPreferences: Codable, Hashable, Sendable {
    public var callsEnabled: Bool
    public var voicePhone: String?
    /// The location's listed number, shown as the fallback when no dedicated
    /// voice line is set.
    public var locationPhone: String?
    public var quietHours: QuietHours?

    public init(callsEnabled: Bool = true, voicePhone: String? = nil, locationPhone: String? = nil, quietHours: QuietHours? = nil) {
        self.callsEnabled = callsEnabled; self.voicePhone = voicePhone
        self.locationPhone = locationPhone; self.quietHours = quietHours
    }
}

public struct QuietHours: Codable, Hashable, Sendable {
    public var start: String?
    public var end: String?
    public init(start: String? = nil, end: String? = nil) { self.start = start; self.end = end }
}

public struct CallPreferencesEnvelope: Codable, Sendable {
    public var preferences: CallPreferences
}

public struct AppSettings: Codable, Sendable {
    public var apiBaseUrl: String = TimiVetEnvironment.defaultAPIBaseURL
    public var tenantId: String = "tenant_hearth"
    public var pollSeconds: Int = 6
    public var alertsEnabled: Bool = true
    public var playSound: Bool = true
    public var miniWindowTopmost: Bool = true
    public var stayAboveEverything: Bool = false
    public var startAtLogin: Bool = false
    public var autoShowMiniOnNewRequest: Bool = false

    // Floating console geometry, restored across launches instead of a
    // hardcoded startup position (the historic WPF behavior this app fixes).
    public var miniWindowLeft: Double?
    public var miniWindowTop: Double?
    public var miniWindowWidth: Double?
    public var miniWindowHeight: Double?

    // `apiBaseUrl` defaults to the same address as the stored property above,
    // and not to "". A property default is dead the moment an explicit
    // initializer assigns the parameter over it, so `AppSettings()` handed back
    // a blank address no matter what the property said — which is how a fresh
    // install reported "Could not read no Worker address/api/config" while the
    // default sat right there in the source.
    public init(apiBaseUrl: String = TimiVetEnvironment.defaultAPIBaseURL, tenantId: String = "tenant_hearth", pollSeconds: Int = 6, alertsEnabled: Bool = true, playSound: Bool = true, miniWindowTopmost: Bool = true, stayAboveEverything: Bool = false, startAtLogin: Bool = false, autoShowMiniOnNewRequest: Bool = false, miniWindowLeft: Double? = nil, miniWindowTop: Double? = nil, miniWindowWidth: Double? = nil, miniWindowHeight: Double? = nil) {
        self.apiBaseUrl = apiBaseUrl; self.tenantId = tenantId; self.pollSeconds = pollSeconds; self.alertsEnabled = alertsEnabled
        self.playSound = playSound; self.miniWindowTopmost = miniWindowTopmost; self.stayAboveEverything = stayAboveEverything
        self.startAtLogin = startAtLogin; self.autoShowMiniOnNewRequest = autoShowMiniOnNewRequest
        self.miniWindowLeft = miniWindowLeft; self.miniWindowTop = miniWindowTop; self.miniWindowWidth = miniWindowWidth; self.miniWindowHeight = miniWindowHeight
    }
}

// MARK: - Tenant people management (GET/POST/PATCH/DELETE /api/tenant/members)

public struct TenantMember: Identifiable, Codable, Hashable, Sendable {
    public var clerkUserId: String
    public var clerkMembershipId: String?
    public var email: String?
    public var name: String
    public var imageUrl: String?
    public var role: String
    public var isSelf: Bool
    public var createdAt: String?
    public var id: String { clerkUserId }
}

public struct TenantInvitation: Identifiable, Codable, Hashable, Sendable {
    public var id: String
    public var email: String
    public var role: String
    public var status: String
    public var createdAt: String?
}

public struct TenantSummary: Codable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var slug: String?
    public var status: String
}

public struct TenantRoster: Codable, Sendable {
    public var tenant: TenantSummary?
    public var members: [TenantMember]
    public var invitations: [TenantInvitation]
}

// MARK: - Session (GET /api/session) and config (GET /api/config)

public struct SessionUser: Codable, Sendable {
    public var id: String
    public var email: String?
    public var name: String?
    public var role: String
    public var permissions: [String]
}

public struct SessionOrganization: Codable, Sendable {
    public var id: String
    public var slug: String?
}

public struct SessionLocation: Codable, Sendable {
    public var id: String
    public var name: String
    public var address: String?
    public var phone: String?
}

public struct SessionSurfaces: Codable, Sendable {
    public var customer: Bool
    public var clinic: Bool
    public var admin: Bool
}

public struct SessionDescriptor: Codable, Sendable {
    public var authenticated: Bool
    public var demo: Bool?
    public var user: SessionUser?
    public var organization: SessionOrganization?
    public var tenant: TenantSummary?
    public var location: SessionLocation?
    public var platformAdmin: Bool
    public var surfaces: SessionSurfaces?
    public var repairedMetadata: [String]?
}

public struct SessionEnvelope: Codable, Sendable { public var session: SessionDescriptor? }

public struct MapConfig: Codable, Sendable {
    public var token: String?
    public var styleUrl: String?
    public var navigationStyleUrl: String?
}

public struct AppConfig: Codable, Sendable {
    public var appName: String?
    public var signInRequired: Bool?
    public var clerkPublishableKey: String?
    /// Present only if the Worker ever starts returning the Clerk Frontend
    /// API host explicitly; `AuthController` prefers it over decoding the
    /// publishable key, matching the Windows client's fallback order.
    public var clerkFrontendApi: String?
    public var clerkJsUrl: String?
    public var demoMode: Bool?
    public var surface: String?
    public var map: MapConfig?
}

// MARK: - Payouts

/// One line of the Tími ledger, as this clinic is allowed to see it.
///
/// A deliberately thin slice of `payment_ledger`: the clinic gets its own
/// transfers and its own payouts and nothing else. It never sees what the
/// customer's card was charged or what Tími retained — those are on the
/// platform side of the transaction, and putting them on a clinic's screen
/// invites an argument about a number the clinic cannot act on.
public struct ClinicLedgerEntry: Identifiable, Codable, Hashable, Sendable {
    public var id: String
    public var occurredAt: String
    public var kind: String
    public var amountCents: Int
    public var status: String
    /// The Stripe transfer or payout id, so a clinic reading its own Express
    /// dashboard can match that line to this one.
    public var stripeObjectId: String?
    public var intakeId: String?

    public init(id: String = "", occurredAt: String = "", kind: String = "", amountCents: Int = 0, status: String = "", stripeObjectId: String? = nil, intakeId: String? = nil) {
        self.id = id; self.occurredAt = occurredAt; self.kind = kind; self.amountCents = amountCents
        self.status = status; self.stripeObjectId = stripeObjectId; self.intakeId = intakeId
    }
}

/// What this clinic is owed and what Stripe has already sent it.
///
/// `awaitingPayoutCents` is what Tími transferred less what Stripe paid out —
/// not the clinic's Stripe balance, which moves for reasons Tími does not
/// control and would turn this screen into an explanation of Stripe's
/// arithmetic rather than ours.
public struct ClinicEarnings: Codable, Sendable {
    public var transferredCents: Int
    public var paidOutCents: Int
    public var awaitingPayoutCents: Int
    public var transfers: [ClinicLedgerEntry]
    public var payouts: [ClinicLedgerEntry]

    public init(transferredCents: Int = 0, paidOutCents: Int = 0, awaitingPayoutCents: Int = 0, transfers: [ClinicLedgerEntry] = [], payouts: [ClinicLedgerEntry] = []) {
        self.transferredCents = transferredCents; self.paidOutCents = paidOutCents
        self.awaitingPayoutCents = awaitingPayoutCents
        self.transfers = transfers; self.payouts = payouts
    }
}

/// Only what a clinic can act on. Stripe's requirements hash is an operator's
/// problem and stays in the platform console.
public struct ClinicConnectStatus: Codable, Hashable, Sendable {
    public var onboardingStatus: String
    public var transfersEnabled: Bool
    public var payoutsEnabled: Bool
    public var disabledReason: String?

    public init(onboardingStatus: String = "not_started", transfersEnabled: Bool = false, payoutsEnabled: Bool = false, disabledReason: String? = nil) {
        self.onboardingStatus = onboardingStatus; self.transfersEnabled = transfersEnabled
        self.payoutsEnabled = payoutsEnabled; self.disabledReason = disabledReason
    }
}

public struct ClinicPayouts: Codable, Sendable {
    public var earnings: ClinicEarnings
    public var connect: ClinicConnectStatus?

    public init(earnings: ClinicEarnings = ClinicEarnings(), connect: ClinicConnectStatus? = nil) {
        self.earnings = earnings; self.connect = connect
    }
}

/// Tiny ISO-8601 helper kept internal so it does not widen the public surface
/// with a `DateFormatter`/`ISO8601DateFormatter` instance in every model.
enum ClinicDateFormat {
    static func parse(_ value: String) -> Date? { ISO8601DateFormatter().date(from: value) }
    static func shortTime(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "h:mm a"
        return formatter.string(from: date)
    }
}
