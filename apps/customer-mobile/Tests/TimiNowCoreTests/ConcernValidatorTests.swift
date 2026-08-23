import XCTest
@testable import TimiNowCore

final class ConcernValidatorTests: XCTestCase {
    func testRejectsVagueConcern() {
        let result = ConcernValidator.evaluate(summary: "My dog isn't acting like himself", symptoms: [], startedWhen: "")
        XCTAssertFalse(result.isReady)
        XCTAssertGreaterThanOrEqual(result.issues.count, 2)
    }

    func testAcceptsObservableConcern() {
        let result = ConcernValidator.evaluate(summary: "Milo vomited three times and will not drink water today", symptoms: ["vomiting_or_diarrhea"], startedWhen: ConcernOnset.today.rawValue)
        XCTAssertTrue(result.isReady)
        XCTAssertEqual(result.score, 100)
    }

    /// The reason no care request from this app has ever been accepted: the
    /// Worker takes one of five tokens and the app sent whatever was typed.
    func testRejectsFreeTextOnset() {
        let result = ConcernValidator.evaluate(summary: "Milo vomited three times and will not drink water today", symptoms: ["vomiting_or_diarrhea"], startedWhen: "About four hours ago")
        XCTAssertFalse(result.isReady)
        XCTAssertTrue(result.issues.contains("Choose when the concern started."))
    }

    /// The Worker measures characters as well as words. Eight short words
    /// passed here and failed there.
    func testRejectsShortSummaryThatPassedOnWordCountAlone() {
        let result = ConcernValidator.evaluate(summary: "he ate my dog toy again now", symptoms: ["vomiting_or_diarrhea"], startedWhen: ConcernOnset.today.rawValue)
        XCTAssertFalse(result.isReady)
        XCTAssertTrue(result.issues.contains("Describe what changed with at least 30 characters and six words."))
    }

    /// The Worker refuses behaviour-only symptoms without a concrete
    /// observation; this used to accept them.
    func testRejectsBehaviourOnlySymptomsWithoutObservation() {
        let result = ConcernValidator.evaluate(summary: "Since yesterday morning he has been much quieter than usual", symptoms: ["energy_or_behavior"], startedWhen: ConcernOnset.oneToThreeDays.rawValue)
        XCTAssertFalse(result.isReady)
        XCTAssertTrue(result.issues.contains("Behavior or energy concerns need a specific observable action."))
    }

    /// The Worker accepts a countable with no body part named. This must too,
    /// or the app refuses something the Worker would have taken.
    func testAcceptsCountableWithoutNamedObservation() {
        let result = ConcernValidator.evaluate(summary: "This happened three times since yesterday morning and again", symptoms: ["vomiting_or_diarrhea"], startedWhen: ConcernOnset.oneToThreeDays.rawValue)
        XCTAssertTrue(result.isReady)
    }
}
