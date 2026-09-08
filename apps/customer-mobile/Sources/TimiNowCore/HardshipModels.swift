import Foundation

/// The "Paw It Forward Fund" financial-hardship application — every wire
/// shape `/api/hardship` (src/hardship/index.js) can return.
///
/// Every property below except an object's own `id` is `Optional`. Two native
/// crashes already this session came from declaring a backend field
/// non-optional when it can legitimately be absent or null — a masked field,
/// or a field that only exists in one of several response shapes — which took
/// down the decode of the whole enclosing object, not just that one field.
/// `ApplicantView.status` in particular varies by application state
/// (`expiresAt`/`sponsoredVisitLimit` only exist on an approval,
/// `supportEmail` only on a soft denial), so nothing here is trusted to be
/// there without a key-by-key reading of `applicationRow`/`applicantView` in
/// src/hardship/index.js — which this was written against directly.

/// `GET /api/hardship/eligibility`'s whole response — there is no wrapper
/// object here, unlike the application endpoints below.
public struct HardshipEligibility: Codable, Hashable, Sendable {
    public var eligible: Bool?
    public var grant: HardshipGrant?
    public var ownerFeeCents: Int?
    public var standardOwnerFeeCents: Int?

    public init(eligible: Bool? = nil, grant: HardshipGrant? = nil, ownerFeeCents: Int? = nil, standardOwnerFeeCents: Int? = nil) {
        self.eligible = eligible; self.grant = grant; self.ownerFeeCents = ownerFeeCents; self.standardOwnerFeeCents = standardOwnerFeeCents
    }
}

/// `activeGrantFor` in src/hardship/index.js: every field here is present
/// whenever the grant itself is non-null, but declared optional anyway rather
/// than trusted on that reading alone.
public struct HardshipGrant: Codable, Hashable, Sendable {
    public var id: String?
    public var applicationId: String?
    public var decisionId: String?
    public var expiresAt: String?
    public var sponsoredVisitLimit: Int?
    public var sponsoredVisitsUsed: Int?

    public init(id: String? = nil, applicationId: String? = nil, decisionId: String? = nil, expiresAt: String? = nil, sponsoredVisitLimit: Int? = nil, sponsoredVisitsUsed: Int? = nil) {
        self.id = id; self.applicationId = applicationId; self.decisionId = decisionId
        self.expiresAt = expiresAt; self.sponsoredVisitLimit = sponsoredVisitLimit; self.sponsoredVisitsUsed = sponsoredVisitsUsed
    }
}

public struct HardshipGeography: Codable, Hashable, Sendable {
    public var areaId: String?
    public var datasetVersion: String?
    public var areaIndex: Int?

    public init(areaId: String? = nil, datasetVersion: String? = nil, areaIndex: Int? = nil) {
        self.areaId = areaId; self.datasetVersion = datasetVersion; self.areaIndex = areaIndex
    }
}

/// `applicationRow` in src/hardship/index.js. `id` is the one field kept
/// required — an application with no id is not something any screen here can
/// do anything with, the same call `CareOffer`/`PetProfile` make for theirs.
public struct HardshipApplication: Identifiable, Codable, Hashable, Sendable {
    public var id: String
    public var userId: String?
    public var identityKey: String?
    public var identityVerified: Bool?
    public var identityConfidence: String?
    public var identitySessionId: String?
    public var selectedPathway: String?
    public var state: String?
    public var householdSize: Int?
    public var householdAttested: Bool?
    public var geography: HardshipGeography?
    public var intakeId: String?
    public var petId: String?
    public var policyId: String?
    public var policyVersion: Int?
    public var submittedAt: String?
    public var decidedAt: String?
    public var createdAt: String?

    public init(id: String, userId: String? = nil, identityKey: String? = nil, identityVerified: Bool? = nil, identityConfidence: String? = nil, identitySessionId: String? = nil, selectedPathway: String? = nil, state: String? = nil, householdSize: Int? = nil, householdAttested: Bool? = nil, geography: HardshipGeography? = nil, intakeId: String? = nil, petId: String? = nil, policyId: String? = nil, policyVersion: Int? = nil, submittedAt: String? = nil, decidedAt: String? = nil, createdAt: String? = nil) {
        self.id = id; self.userId = userId; self.identityKey = identityKey; self.identityVerified = identityVerified
        self.identityConfidence = identityConfidence; self.identitySessionId = identitySessionId; self.selectedPathway = selectedPathway
        self.state = state; self.householdSize = householdSize; self.householdAttested = householdAttested; self.geography = geography
        self.intakeId = intakeId; self.petId = petId; self.policyId = policyId; self.policyVersion = policyVersion
        self.submittedAt = submittedAt; self.decidedAt = decidedAt; self.createdAt = createdAt
    }
}

/// `applicantView` in src/hardship/index.js — the sanitized, user-facing
/// status. This is what every hardship screen actually renders; reason codes,
/// the internal state name, and the decision's explanation never reach the
/// client at all.
///
/// Even `status` is optional here rather than trusted as always-present: a
/// response missing it should fall through to the in-progress screen (the
/// `default:` case wherever this is switched on), not fail the whole decode.
public struct HardshipApplicantView: Codable, Hashable, Sendable {
    public var status: String?
    public var title: String?
    public var message: String?
    public var ownerFeeCents: Int?
    /// APPROVED only.
    public var expiresAt: String?
    /// APPROVED only.
    public var sponsoredVisitLimit: Int?
    /// NOT_VERIFIED only.
    public var supportEmail: String?

    public init(status: String? = nil, title: String? = nil, message: String? = nil, ownerFeeCents: Int? = nil, expiresAt: String? = nil, sponsoredVisitLimit: Int? = nil, supportEmail: String? = nil) {
        self.status = status; self.title = title; self.message = message; self.ownerFeeCents = ownerFeeCents
        self.expiresAt = expiresAt; self.sponsoredVisitLimit = sponsoredVisitLimit; self.supportEmail = supportEmail
    }
}

/// `POST/GET .../applications[/:id]` and `.../submit` all answer with this
/// same pair. The wrapper keys are required — every success response from
/// those routes emits both together — mirroring how `CareSearchEnvelope`
/// treats its own wrapper key as required while everything inside `CareSearch`
/// stays optional.
public struct HardshipApplicationEnvelope: Codable, Sendable {
    public var application: HardshipApplication
    public var view: HardshipApplicantView
}

/// `startIdentitySession`'s normalized shape — see src/hardship/providers.js.
/// `sessionUrl` is the field to actually navigate a web sheet to; `hostedUrl`
/// carries the identical value only when the session was opened in HOSTED
/// mode, so a client that only knows about one of the two still works.
public struct HardshipIdentitySession: Codable, Hashable, Sendable {
    public var sessionId: String?
    public var provider: String?
    public var mode: String?
    public var sessionUrl: String?
    public var hostedUrl: String?

    public init(sessionId: String? = nil, provider: String? = nil, mode: String? = nil, sessionUrl: String? = nil, hostedUrl: String? = nil) {
        self.sessionId = sessionId; self.provider = provider; self.mode = mode; self.sessionUrl = sessionUrl; self.hostedUrl = hostedUrl
    }

    /// `sessionUrl` first, `hostedUrl` as the fallback — never the reverse,
    /// and never both trusted blindly: either may be missing, and a
    /// malformed value must not be handed to a web view as a valid URL.
    public var launchURL: URL? {
        if let sessionUrl, let url = URL(string: sessionUrl) { return url }
        if let hostedUrl, let url = URL(string: hostedUrl) { return url }
        return nil
    }
}

public struct HardshipIdentitySessionEnvelope: Codable, Sendable {
    public var session: HardshipIdentitySession
}

/// `GET .../identity-status`'s `identity` object. `verified` is a plain
/// boolean server-side and never null, but kept optional here anyway — the
/// cost of being wrong about "always present" has already been a crash twice
/// this session, and `?? false` at the call site is free.
public struct HardshipIdentityStatus: Codable, Hashable, Sendable {
    public var verified: Bool?
    public var status: String?

    public init(verified: Bool? = nil, status: String? = nil) {
        self.verified = verified; self.status = status
    }
}

public struct HardshipIdentityStatusEnvelope: Codable, Sendable {
    public var application: HardshipApplication
    public var identity: HardshipIdentityStatus
}

/// `POST .../uploads`'s 201 response.
public struct HardshipEvidenceUploadResult: Codable, Hashable, Sendable {
    public var evidenceId: String?
    public var retentionDeadline: String?
    public var byteSize: Int?
    public var contentSha256: String?

    public init(evidenceId: String? = nil, retentionDeadline: String? = nil, byteSize: Int? = nil, contentSha256: String? = nil) {
        self.evidenceId = evidenceId; self.retentionDeadline = retentionDeadline; self.byteSize = byteSize; self.contentSha256 = contentSha256
    }
}

/// `POST .../appeal`'s 201 response.
public struct HardshipAppealResult: Codable, Hashable, Sendable {
    public var appealId: String?
    public var message: String?

    public init(appealId: String? = nil, message: String? = nil) {
        self.appealId = appealId; self.message = message
    }
}

/// The evidence-type constants `DOCUMENT_ROUTES` in src/hardship/index.js
/// actually accepts — all 29 of them exist server-side, grouped there into
/// six routing buckets (benefit, termination, unemployment, reducedEarnings,
/// income, shock). Asking an applicant to pick from 29 raw constants is not a
/// screen anyone should ship, so this exposes one human-readable option per
/// bucket rather than the full list — the same "small raw-string enum with a
/// `title`" house style as `PetSpecies`/`CareUrgency` in Models.swift.
public enum HardshipEvidenceType: String, Codable, CaseIterable, Sendable {
    case benefitAwardLetter = "BENEFIT_AWARD_LETTER"
    case employerTerminationNotice = "EMPLOYER_TERMINATION_NOTICE"
    case unemploymentDetermination = "UNEMPLOYMENT_DETERMINATION"
    case payStubSet = "PAY_STUB_SET"
    case veterinaryInvoice = "VETERINARY_INVOICE"
    case itemizedInvoice = "ITEMIZED_INVOICE"

    public var title: String {
        switch self {
        case .benefitAwardLetter: return "Government benefit award letter"
        case .employerTerminationNotice: return "Job termination or layoff notice"
        case .unemploymentDetermination: return "Unemployment determination letter"
        case .payStubSet: return "Pay stubs"
        case .veterinaryInvoice: return "Veterinary or medical bill"
        case .itemizedInvoice: return "Other itemized invoice or receipt"
        }
    }
}

/// A document this device has uploaded, kept only for the screen to show what
/// was already attached. The Worker never echoes back a list of what it holds
/// by content — only `evidenceId`, `retentionDeadline`, `byteSize`, and a hash
/// — so this is a client-side memory of the upload, not a synced record. Lost
/// on relaunch, same as `depositIntent`; the Worker remains the source of
/// truth for whether `submit` has enough to decide.
public struct HardshipEvidenceSummary: Identifiable, Hashable, Sendable {
    public var id: String
    public var type: HardshipEvidenceType
    public var label: String
    public var byteSize: Int?

    public init(id: String, type: HardshipEvidenceType, label: String, byteSize: Int? = nil) {
        self.id = id; self.type = type; self.label = label; self.byteSize = byteSize
    }
}
