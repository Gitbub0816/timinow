import XCTest
@testable import TimiVetCore

@MainActor
final class ClinicStoreTests: XCTestCase {
    /// Mirrors the Windows client's `Math.Clamp(Settings.PollSeconds, 3, 60)`
    /// used by both `RefreshAsync`'s status line and `PollLoopAsync`'s delay.
    func testPollSecondsIsClampedToThreeAndSixty() {
        let store = makeStore(pollSeconds: 1)
        XCTAssertEqual(store.clampedPollSeconds, 3)

        store.settings.pollSeconds = 6
        XCTAssertEqual(store.clampedPollSeconds, 6)

        store.settings.pollSeconds = 600
        XCTAssertEqual(store.clampedPollSeconds, 60)
    }

    func testPollSecondsClampHandlesNegativeValues() {
        let store = makeStore(pollSeconds: -5)
        XCTAssertEqual(store.clampedPollSeconds, 3)
    }

    private func makeStore(pollSeconds: Int) -> ClinicStore {
        var settings = AppSettings()
        settings.pollSeconds = pollSeconds
        let api = ClinicAPIClient(settings: settings)
        return ClinicStore(settingsStore: SettingsStore(), settings: settings, api: api)
    }
}
