import XCTest
@testable import TimiNowCore

final class CareSearchDecodingTests: XCTestCase {
    /// Regression: `revealLocation: offer.status === "selected"` in
    /// `src/db.js` means every offer is masked until the customer chooses
    /// one — the *default* state of a fresh offer, not an edge case. A
    /// masked offer's `location` key holds `maskedMatchCard()`'s shape
    /// (`matchToken`/`alias`/`timinow`), not a `ClinicLocation`. Decoding it
    /// as `ClinicLocation` unconditionally threw on every offer the
    /// customer had not yet selected, which failed the *entire*
    /// `GET /api/searches/:id` decode — the app showed "That didn't work"
    /// on every poll from the moment a clinic responded, with no way to see
    /// or select the offer that had just arrived.
    func testCareSearchDecodesMaskedAndRevealedOffersTogether() throws {
        let json = """
        {
          "search": {
            "id": "search_1", "status": "offers_ready", "maxOffers": 5,
            "offers": [
              {
                "id": "offer_masked", "searchId": "search_1", "responseType": "available_now", "status": "active",
                "waitMin": 15, "waitMax": 35,
                "location": {
                  "matchToken": "offer_masked",
                  "alias": {"displayName": "Harbor Point Animal Care", "label": "Temporary TímiNOW match name"},
                  "timinow": {"distanceMiles": 4.2, "acceptingNow": true, "estimatedWait": {"minMinutes": 15, "maxMinutes": 35}}
                }
              },
              {
                "id": "offer_selected", "searchId": "search_1", "locationId": "loc_1", "tenantId": "tenant_1",
                "responseType": "available_now", "status": "selected",
                "location": {"id": "loc_1", "name": "Hayward Veterinary Clinic", "address": "832 B Street, Hayward, CA"}
              }
            ]
          }
        }
        """
        let envelope = try JSONDecoder().decode(CareSearchEnvelope.self, from: Data(json.utf8))
        let offers = try XCTUnwrap(envelope.search.offers)
        XCTAssertEqual(offers.count, 2)

        let masked = try XCTUnwrap(offers.first { $0.id == "offer_masked" })
        XCTAssertNil(masked.location)
        XCTAssertNil(masked.locationId)
        let maskedCard = try XCTUnwrap(masked.maskedCard)
        XCTAssertEqual(maskedCard.alias?.displayName, "Harbor Point Animal Care")
        XCTAssertEqual(maskedCard.timinow?.distanceMiles, 4.2)

        let revealed = try XCTUnwrap(offers.first { $0.id == "offer_selected" })
        XCTAssertNil(revealed.maskedCard)
        XCTAssertEqual(revealed.location?.name, "Hayward Veterinary Clinic")
        XCTAssertEqual(revealed.locationId, "loc_1")
    }
}
