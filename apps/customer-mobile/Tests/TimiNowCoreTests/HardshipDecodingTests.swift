import Foundation
import XCTest
@testable import TimiNowCore

/// Regression coverage for the Paw It Forward Fund models — see
/// HardshipModels.swift's header comment. Two native crashes already this
/// session came from a backend field being declared non-optional when it
/// could legitimately be null; `ApplicantView` in particular has fields that
/// only exist for some application states, so every state is decoded here
/// rather than trusted from reading the server code alone.
final class HardshipDecodingTests: XCTestCase {
    func testApplicantViewDraftState() throws {
        let json = """
        { "status": "DRAFT", "title": null, "message": null, "ownerFeeCents": 2000 }
        """
        let view = try JSONDecoder().decode(HardshipApplicantView.self, from: Data(json.utf8))
        XCTAssertEqual(view.status, "DRAFT")
        XCTAssertNil(view.title)
        XCTAssertNil(view.message)
        XCTAssertEqual(view.ownerFeeCents, 2000)
        XCTAssertNil(view.expiresAt)
        XCTAssertNil(view.sponsoredVisitLimit)
        XCTAssertNil(view.supportEmail)
    }

    func testApplicantViewVerifyingState() throws {
        let json = """
        { "status": "VERIFYING", "title": null, "message": null, "ownerFeeCents": 2000 }
        """
        let view = try JSONDecoder().decode(HardshipApplicantView.self, from: Data(json.utf8))
        XCTAssertEqual(view.status, "VERIFYING")
    }

    /// `applicantView`'s APPROVED shape: the only one carrying `expiresAt`
    /// and `sponsoredVisitLimit`, and `ownerFeeCents` is zeroed.
    func testApplicantViewApprovedState() throws {
        let json = """
        {
          "status": "APPROVED",
          "title": "Paw It Forward assistance approved",
          "message": "Your $20 TímiNOW fee is covered for this booking, and the clinic will not be charged a TímiNOW referral fee. You remain responsible for the clinic's deposit and veterinary charges.",
          "expiresAt": "2027-03-01T00:00:00.000Z",
          "sponsoredVisitLimit": 1,
          "ownerFeeCents": 0
        }
        """
        let view = try JSONDecoder().decode(HardshipApplicantView.self, from: Data(json.utf8))
        XCTAssertEqual(view.status, "APPROVED")
        XCTAssertEqual(view.title, "Paw It Forward assistance approved")
        XCTAssertEqual(view.expiresAt, "2027-03-01T00:00:00.000Z")
        XCTAssertEqual(view.sponsoredVisitLimit, 1)
        XCTAssertEqual(view.ownerFeeCents, 0)
        XCTAssertNil(view.supportEmail)
    }

    /// The soft-denial shape: the only one carrying `supportEmail`, and
    /// `expiresAt`/`sponsoredVisitLimit` are absent from the payload entirely
    /// (not merely null) — proving the decode does not require those keys.
    func testApplicantViewNotVerifiedState() throws {
        let json = """
        {
          "status": "NOT_VERIFIED",
          "title": "We could not verify your hardship",
          "message": "TímiNOW could not independently verify your hardship at this time. This booking will require our standard $20 fee.",
          "supportEmail": "hardship@clearkey.solutions",
          "ownerFeeCents": 2000
        }
        """
        let view = try JSONDecoder().decode(HardshipApplicantView.self, from: Data(json.utf8))
        XCTAssertEqual(view.status, "NOT_VERIFIED")
        XCTAssertEqual(view.supportEmail, "hardship@clearkey.solutions")
        XCTAssertNil(view.expiresAt)
        XCTAssertNil(view.sponsoredVisitLimit)
    }

    /// TECHNICAL_RETRY and SECURITY_HOLD both collapse to the same neutral
    /// "PENDING" shape on the wire — see `applicantView` in
    /// src/hardship/index.js.
    func testApplicantViewPendingState() throws {
        let json = """
        { "status": "PENDING", "title": "Still checking", "message": "TímiNOW is still checking a few things and cannot confirm assistance right now.", "ownerFeeCents": 2000 }
        """
        let view = try JSONDecoder().decode(HardshipApplicantView.self, from: Data(json.utf8))
        XCTAssertEqual(view.status, "PENDING")
        XCTAssertEqual(view.title, "Still checking")
    }

    /// `applicationRow` shape with every nullable field actually null, plus a
    /// nested `geography` object whose own fields are null too. None of this
    /// should throw, and every null should decode to `nil` rather than
    /// crashing the whole `HardshipApplicationEnvelope` decode the way a
    /// non-optional field crashed `CareSearch` before (see
    /// CareSearchDecodingTests).
    func testApplicationDecodesWithNullableFieldsPresent() throws {
        let json = """
        {
          "application": {
            "id": "elig_1", "userId": "user_1", "identityKey": null, "identityVerified": false,
            "identityConfidence": null, "identitySessionId": null, "selectedPathway": null,
            "state": "DRAFT", "householdSize": null, "householdAttested": false,
            "geography": { "areaId": null, "datasetVersion": null, "areaIndex": null },
            "intakeId": null, "petId": null, "policyId": "policy_1", "policyVersion": 3,
            "submittedAt": null, "decidedAt": null, "createdAt": "2026-09-01T00:00:00.000Z"
          },
          "view": { "status": "DRAFT", "title": null, "message": null, "ownerFeeCents": 2000 }
        }
        """
        let envelope = try JSONDecoder().decode(HardshipApplicationEnvelope.self, from: Data(json.utf8))
        XCTAssertEqual(envelope.application.id, "elig_1")
        XCTAssertEqual(envelope.application.state, "DRAFT")
        XCTAssertNil(envelope.application.identityKey)
        XCTAssertNil(envelope.application.householdSize)
        XCTAssertEqual(envelope.application.householdAttested, false)
        XCTAssertNil(envelope.application.geography?.areaId)
        XCTAssertEqual(envelope.application.policyVersion, 3)
        XCTAssertEqual(envelope.view.status, "DRAFT")
    }

    /// A household of two, attested, with an identity already verified —
    /// exercises the non-null path through the same fields.
    func testApplicationDecodesWithValuesPresent() throws {
        let json = """
        {
          "application": {
            "id": "elig_2", "userId": "user_2", "identityKey": "idk_abc", "identityVerified": true,
            "identityConfidence": "HIGH", "identitySessionId": "sess_1", "selectedPathway": "benefit",
            "state": "VERIFYING", "householdSize": 2, "householdAttested": true,
            "geography": { "areaId": "area_9", "datasetVersion": "2026-q1", "areaIndex": 4 },
            "intakeId": null, "petId": null, "policyId": "policy_1", "policyVersion": 3,
            "submittedAt": "2026-09-05T00:00:00.000Z", "decidedAt": null, "createdAt": "2026-09-01T00:00:00.000Z"
          },
          "view": { "status": "VERIFYING", "title": null, "message": null, "ownerFeeCents": 2000 }
        }
        """
        let envelope = try JSONDecoder().decode(HardshipApplicationEnvelope.self, from: Data(json.utf8))
        XCTAssertEqual(envelope.application.identityVerified, true)
        XCTAssertEqual(envelope.application.identityConfidence, "HIGH")
        XCTAssertEqual(envelope.application.householdSize, 2)
        XCTAssertEqual(envelope.application.geography?.areaId, "area_9")
        XCTAssertEqual(envelope.application.geography?.areaIndex, 4)
    }

    /// `startIdentitySession`'s normalized shape (src/hardship/providers.js)
    /// always sends `sessionUrl`; this proves it wins over `hostedUrl` when
    /// both are present.
    func testIdentitySessionPrefersSessionUrl() throws {
        let json = """
        { "session": { "sessionId": "sess_1", "provider": "didit", "mode": "HOSTED", "sessionUrl": "https://identity.example/a", "hostedUrl": "https://identity.example/a" } }
        """
        let envelope = try JSONDecoder().decode(HardshipIdentitySessionEnvelope.self, from: Data(json.utf8))
        XCTAssertEqual(envelope.session.launchURL, URL(string: "https://identity.example/a"))
    }

    /// A client that only reads `hostedUrl`, or a response that only ever
    /// carries it, must still be able to open the sheet.
    func testIdentitySessionFallsBackToHostedUrl() throws {
        let json = """
        { "session": { "sessionId": "sess_2", "provider": "didit", "mode": "HOSTED", "hostedUrl": "https://identity.example/b" } }
        """
        let envelope = try JSONDecoder().decode(HardshipIdentitySessionEnvelope.self, from: Data(json.utf8))
        XCTAssertNil(envelope.session.sessionUrl)
        XCTAssertEqual(envelope.session.launchURL, URL(string: "https://identity.example/b"))
    }

    /// Neither field present — the launch URL must be nil rather than the
    /// decode throwing.
    func testIdentitySessionWithNeitherUrlDecodesToNilLaunchURL() throws {
        let json = """
        { "session": { "sessionId": "sess_3", "provider": "didit", "mode": "HOSTED" } }
        """
        let envelope = try JSONDecoder().decode(HardshipIdentitySessionEnvelope.self, from: Data(json.utf8))
        XCTAssertNil(envelope.session.launchURL)
    }

    /// `GET .../identity-status`'s shape.
    func testIdentityStatusDecodes() throws {
        let json = """
        {
          "application": { "id": "elig_1", "state": "VERIFYING" },
          "identity": { "verified": true, "status": "Approved" }
        }
        """
        let envelope = try JSONDecoder().decode(HardshipIdentityStatusEnvelope.self, from: Data(json.utf8))
        XCTAssertEqual(envelope.identity.verified, true)
        XCTAssertEqual(envelope.identity.status, "Approved")
    }

    /// `GET /api/hardship/eligibility` when nobody has an active grant: the
    /// flat top-level shape, `grant: null`.
    func testEligibilityDecodesWithNoGrant() throws {
        let json = """
        { "eligible": false, "grant": null, "ownerFeeCents": 2000, "standardOwnerFeeCents": 2000 }
        """
        let eligibility = try JSONDecoder().decode(HardshipEligibility.self, from: Data(json.utf8))
        XCTAssertEqual(eligibility.eligible, false)
        XCTAssertNil(eligibility.grant)
    }

    func testEligibilityDecodesWithActiveGrant() throws {
        let json = """
        {
          "eligible": true,
          "grant": { "id": "grant_1", "applicationId": "elig_1", "decisionId": "edec_1", "expiresAt": "2027-01-01T00:00:00.000Z", "sponsoredVisitLimit": 1, "sponsoredVisitsUsed": 0 },
          "ownerFeeCents": 0,
          "standardOwnerFeeCents": 2000
        }
        """
        let eligibility = try JSONDecoder().decode(HardshipEligibility.self, from: Data(json.utf8))
        XCTAssertEqual(eligibility.eligible, true)
        XCTAssertEqual(eligibility.grant?.sponsoredVisitLimit, 1)
        XCTAssertEqual(eligibility.ownerFeeCents, 0)
    }
}
