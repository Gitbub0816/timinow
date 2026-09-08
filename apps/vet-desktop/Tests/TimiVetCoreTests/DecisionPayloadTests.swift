import Foundation
import XCTest
@testable import TimiVetCore

final class DecisionPayloadTests: XCTestCase {
    /// `DecisionPayload` is what `ClinicStore.offer()`/`decline()` hand to
    /// `ClinicAPIClient.respond(to:decision:)`, which then shapes the two
    /// different wire payloads docs/PLATFORM-CONTRACT.md's
    /// `/api/clinic/search-targets/{id}/decision` and
    /// `/api/clinic/intakes/{id}/decision` expect. This guards the shape of
    /// that shared model against an accidental field rename.
    func testDecisionPayloadDefaults() {
        let payload = DecisionPayload()
        XCTAssertEqual(payload.decision, "offer")
        XCTAssertEqual(payload.responseType, "available_now")
        XCTAssertNil(payload.availableAt)
        XCTAssertEqual(payload.arrivalWindowMinutes, 30)
        XCTAssertEqual(payload.holdMinutes, 5)
        XCTAssertEqual(payload.waitMin, 15)
        XCTAssertEqual(payload.waitMax, 35)
        XCTAssertEqual(payload.note, "")
    }

    func testDecisionPayloadCarriesDeclineFields() {
        let payload = DecisionPayload(decision: "decline", responseType: "available_now", arrivalWindowMinutes: 45, holdMinutes: 10, waitMin: 20, waitMax: 40, note: "Full for the evening.")
        XCTAssertEqual(payload.decision, "decline")
        XCTAssertEqual(payload.arrivalWindowMinutes, 45)
        XCTAssertEqual(payload.note, "Full for the evening.")
    }

    /// `AvailabilityUpdate` is the body of `POST /api/clinic/availability`;
    /// its JSON keys must match the Worker's camelCase contract verbatim —
    /// no snake_case conversion, no renamed fields.
    func testAvailabilityUpdateEncodesContractKeys() throws {
        let update = AvailabilityUpdate(intakeStatus: "limited", stableWaitMin: 10, stableWaitMax: 20, capacityCount: 2, ttlMinutes: 15, acceptsCritical: false, note: "Two beds open.")
        let data = try JSONEncoder().encode(update)
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(object["intakeStatus"] as? String, "limited")
        XCTAssertEqual(object["stableWaitMin"] as? Int, 10)
        XCTAssertEqual(object["stableWaitMax"] as? Int, 20)
        XCTAssertEqual(object["capacityCount"] as? Int, 2)
        XCTAssertEqual(object["ttlMinutes"] as? Int, 15)
        XCTAssertEqual(object["acceptsCritical"] as? Bool, false)
        XCTAssertEqual(object["note"] as? String, "Two beds open.")
    }

    /// `ClinicRequest` decodes `/api/clinic/dashboard`'s `requests[]`; this
    /// guards its computed display properties against a logic regression.
    func testClinicRequestEmergencyDetection() {
        let emergency = ClinicRequest(urgency: "emergency", redFlags: [])
        XCTAssertTrue(emergency.isEmergency)

        let redFlagged = ClinicRequest(urgency: "urgent", redFlags: ["breathing_difficulty"])
        XCTAssertTrue(redFlagged.isEmergency)

        let routine = ClinicRequest(urgency: "same_day", redFlags: [])
        XCTAssertFalse(routine.isEmergency)
    }

    /// Regression: `/api/clinic/dashboard` mixes two request shapes in the
    /// same `requests[]` array — a multi-clinic search target (masked owner,
    /// `owner.phone: null`, `searchTarget`/`contactRevealed` present) and a
    /// direct intake (real owner, and *no* `searchTarget` or
    /// `contactRevealed` key at all — see `normalizeIntakeRow` in
    /// `src/db.js`). The synthesized `Decodable` required both keys on every
    /// element and threw on `null` into a non-optional `owner.phone`, so one
    /// masked search target failed decoding of the *entire* dashboard —
    /// every poll surfaced as `ClinicAPIError.invalidResponse`
    /// ("The Tími API returned a response it could not read") with no
    /// indication a new request had even arrived.
    func testClinicRequestDecodesMaskedSearchTargetAndPlainIntakeTogether() throws {
        let json = """
        {
          "location": {"id": "loc_1", "name": "Hayward", "availability": {"intakeStatus": "available", "acceptsCritical": true}, "policy": {}},
          "requests": [
            {
              "id": "target_1", "searchId": "search_1", "locationId": "loc_1", "tenantId": "tenant_hearth",
              "pet": {"name": "Milo", "species": "dog"},
              "owner": {"name": "M*** L.", "phone": null, "email": null},
              "concernSummary": "Limping.", "urgency": "urgent", "redFlags": [],
              "status": "pending", "searchTarget": true, "contactRevealed": false
            },
            {
              "id": "intake_1", "locationId": "loc_1", "tenantId": "tenant_hearth",
              "pet": {"name": "Rex", "species": "dog"},
              "owner": {"name": "Sam Rivera", "phone": "(510) 555-0181", "email": null},
              "concernSummary": "Ear infection.", "urgency": "same_day", "redFlags": [],
              "status": "pending"
            }
          ],
          "metrics": {"pending": 2, "activeArrivals": 0, "completedToday": 0, "declinedToday": 0}
        }
        """
        let dashboard = try JSONDecoder().decode(ClinicDashboard.self, from: Data(json.utf8))
        XCTAssertEqual(dashboard.requests.count, 2)

        let target = try XCTUnwrap(dashboard.requests.first { $0.id == "target_1" })
        XCTAssertTrue(target.searchTarget)
        XCTAssertFalse(target.contactRevealed)
        XCTAssertNil(target.owner.phone)

        let intake = try XCTUnwrap(dashboard.requests.first { $0.id == "intake_1" })
        XCTAssertFalse(intake.searchTarget)
        XCTAssertTrue(intake.contactRevealed)
        XCTAssertEqual(intake.owner.phone, "(510) 555-0181")
    }
}
