import XCTest
@testable import AudioCaptureCore

final class HostClockTests: XCTestCase {

    func testFakeClockAdvances() {
        let clock = FakeHostClock(initialTime: 0)

        XCTAssertEqual(clock.now(), 0)

        clock.advance(by: 1_000_000_000) // 1 second
        XCTAssertEqual(clock.now(), 1_000_000_000)

        clock.advance(by: 500_000_000) // 0.5 seconds
        XCTAssertEqual(clock.now(), 1_500_000_000)
    }

    func testFakeClockSetTime() {
        let clock = FakeHostClock(initialTime: 0)

        clock.set(to: 5_000_000_000)
        XCTAssertEqual(clock.now(), 5_000_000_000)
    }

    func testToSeconds() {
        let clock = FakeHostClock(initialTime: 0)

        XCTAssertEqual(clock.toSeconds(1_000_000_000), 1.0, accuracy: 0.001)
        XCTAssertEqual(clock.toSeconds(500_000_000), 0.5, accuracy: 0.001)
        XCTAssertEqual(clock.toSeconds(2_500_000_000), 2.5, accuracy: 0.001)
    }

    func testFromSeconds() {
        let clock = FakeHostClock(initialTime: 0)

        XCTAssertEqual(clock.fromSeconds(1.0), 1_000_000_000)
        XCTAssertEqual(clock.fromSeconds(0.5), 500_000_000)
        XCTAssertEqual(clock.fromSeconds(2.5), 2_500_000_000)
    }

    func testRoundtrip() {
        let clock = FakeHostClock(initialTime: 0)

        let seconds = 1.5
        let hostTime = clock.fromSeconds(seconds)
        let roundtripped = clock.toSeconds(hostTime)

        XCTAssertEqual(roundtripped, seconds, accuracy: 0.001)
    }
}
