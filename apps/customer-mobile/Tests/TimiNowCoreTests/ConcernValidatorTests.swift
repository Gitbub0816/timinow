import XCTest
@testable import TimiNowCore

final class ConcernValidatorTests: XCTestCase {
    func testRejectsVagueConcern() {
        let result = ConcernValidator.evaluate(summary: "My dog isn't acting like himself", symptoms: [], startedWhen: "")
        XCTAssertFalse(result.isReady)
        XCTAssertGreaterThanOrEqual(result.issues.count, 2)
    }

    func testAcceptsObservableConcern() {
        let result = ConcernValidator.evaluate(summary: "Milo vomited three times and will not drink water today", symptoms: ["vomiting_or_diarrhea"], startedWhen: "About four hours ago")
        XCTAssertTrue(result.isReady)
        XCTAssertEqual(result.score, 100)
    }
}
