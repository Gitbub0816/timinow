import Foundation
import XCTest
@testable import TimiNowCore

/// Regression: `FeeConfig.ownerFeeCents` was declared `customerFeeCents`,
/// a key `publicConfig` in src/config.js never actually sends (it sends
/// `ownerFeeCents`). The mismatch didn't crash anything — Codable just left
/// the field nil — so the deposit screen silently quoted the compiled-in
/// fallback forever, never picking up a real fee change from the server.
final class AppConfigDecodingTests: XCTestCase {
    func testFeeConfigDecodesOwnerFeeCentsFromTheWorkersActualKey() throws {
        let json = """
        {
          "map": null, "clerkPublishableKey": null, "clerkTokenTemplate": null, "signInRequired": true,
          "fees": {
            "ownerFeeCents": 1500, "clinicFeeCents": 2000, "timiMatchCents": 500,
            "sponsorshipFundCents": 3000, "minBookingContributionCents": 0, "minStandaloneContributionCents": 0,
            "maxBookingContributionCents": 5000, "maxStandaloneContributionCents": 5000,
            "pricingVersion": 1, "currency": "usd"
          },
          "legalVersion": "2026-01"
        }
        """
        let config = try JSONDecoder().decode(AppConfigEnvelope.self, from: Data(json.utf8))
        XCTAssertEqual(config.fees?.ownerFeeCents, 1500)
    }
}
