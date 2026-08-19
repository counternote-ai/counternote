import XCTest
@testable import AudioCaptureCore

// MARK: - Restart Verification Tests

/// A start() that returns without throwing can still be a fake success:
/// wedged engine, dead stream, or a stop/start interleave. The coordinator
/// verifies every restart after 2 s and folds an unverified restart back into
/// a fresh failure cycle instead of letting the retry chain go blind.
final class CaptureCoordinatorRestartVerifyTests: XCTestCase {

    private func makePCMData(sample: Int16 = 100, count: Int = 320) -> Data {
        var samples = [Int16](repeating: sample, count: count)
        return Data(bytes: &samples, count: samples.count * 2)
    }

    private func makeCoordinator(
        clock: FakeHostClock,
        systemAudio: FakeSystemAudioSource,
        microphone: FakeMicrophoneSource,
        sink: RecordingByteSink,
        diagSink: MockDiagnosticSink,
        scheduler: FakeScheduler
    ) -> CaptureCoordinator {
        return CaptureCoordinator(
            hostClock: clock,
            systemAudio: systemAudio,
            microphone: microphone,
            writer: CaptureProtocolWriter(sink: sink),
            diagnostics: Diagnostics(sink: diagSink),
            scheduler: scheduler
        )
    }

    private func reconnectingStates(for channel: String, in data: Data) -> [[String: Any]] {
        FrameCounter().extractJSONPayloads(ofType: .state, from: data).filter {
            $0["channel"] as? String == channel && $0["status"] as? String == "reconnecting"
        }
    }

    private func diagnosticJSONLines(_ sink: MockDiagnosticSink) -> [[String: String]] {
        sink.lines.compactMap { line in
            guard let data = line.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: String] else {
                return nil
            }
            return json
        }
    }

    // MARK: - Unverified Restart Re-Fails

    func testUnverifiedRestartTriggersSecondFailureCycle() throws {
        let clock = FakeHostClock(initialTime: 1_000_000_000)
        let systemAudio = FakeSystemAudioSource()
        let microphone = FakeMicrophoneSource()
        let sink = RecordingByteSink()
        let diagSink = MockDiagnosticSink()
        let scheduler = FakeScheduler()
        let coordinator = makeCoordinator(
            clock: clock, systemAudio: systemAudio, microphone: microphone,
            sink: sink, diagSink: diagSink, scheduler: scheduler
        )

        try coordinator.start()
        systemAudio.simulateAudioData(makePCMData(), hostTime: clock.now())
        microphone.simulateAudioData(makePCMData(), hostTime: clock.now())
        XCTAssertEqual(coordinator.getState(), .recording)

        // Advance so the restart timestamp is strictly after the last callback.
        clock.advance(by: 1_000_000)

        // Failure cycle 1: route invalidation stops the source, schedules retry.
        microphone.simulateFailure()
        XCTAssertEqual(microphone.stopCount, 1)
        XCTAssertEqual(reconnectingStates(for: "you", in: sink.writtenData).count, 1)

        // First retry: start() succeeds, but no callbacks ever arrive.
        scheduler.executeAll()
        XCTAssertEqual(microphone.startCount, 2, "first retry should restart the source")
        XCTAssertEqual(microphone.stopCount, 1, "restart alone must not stop the source")

        // Fire the 2 s verify: still no callback since the restart, so the
        // channel must fold back into a fresh failure cycle.
        scheduler.executeAll()
        XCTAssertEqual(microphone.stopCount, 2, "unverified restart must stop the source again")
        XCTAssertEqual(microphone.startCount, 2, "no new start until the next retry fires")
        XCTAssertEqual(
            reconnectingStates(for: "you", in: sink.writtenData).count, 2,
            "the refailure re-emits the reconnecting state frame"
        )
        XCTAssertTrue(
            scheduler.scheduledWork.contains { $0.delay == 0.5 },
            "the refailure starts a fresh fast-retry chain"
        )

        let codes = diagnosticJSONLines(diagSink).compactMap { $0["code"] }
        XCTAssertTrue(codes.contains("source-restart-attempt"))
        XCTAssertTrue(codes.contains("source-restarted"))
        XCTAssertTrue(codes.contains("source-restart-unverified"))
        XCTAssertEqual(
            diagnosticJSONLines(diagSink).filter { $0["code"] == "source-restart-unverified" }.count, 1
        )
    }

    // MARK: - Verified Restart Is Left Alone

    func testVerifiedRestartDoesNotRefail() throws {
        let clock = FakeHostClock(initialTime: 1_000_000_000)
        let systemAudio = FakeSystemAudioSource()
        let microphone = FakeMicrophoneSource()
        let sink = RecordingByteSink()
        let diagSink = MockDiagnosticSink()
        let scheduler = FakeScheduler()
        let coordinator = makeCoordinator(
            clock: clock, systemAudio: systemAudio, microphone: microphone,
            sink: sink, diagSink: diagSink, scheduler: scheduler
        )

        try coordinator.start()
        systemAudio.simulateAudioData(makePCMData(), hostTime: clock.now())
        microphone.simulateAudioData(makePCMData(), hostTime: clock.now())
        XCTAssertEqual(coordinator.getState(), .recording)

        clock.advance(by: 1_000_000)
        microphone.simulateFailure()
        scheduler.executeAll() // first retry restarts the source
        XCTAssertEqual(microphone.startCount, 2)

        // Proof of life: a real callback after the restart.
        clock.advance(by: 1_000_000)
        microphone.simulateAudioData(makePCMData(), hostTime: clock.now())

        // The 2 s verify fires and must no-op.
        scheduler.executeAll()
        XCTAssertEqual(microphone.stopCount, 1, "verified restart must not be stopped again")
        XCTAssertEqual(microphone.startCount, 2, "verified restart must not retry again")
        XCTAssertEqual(reconnectingStates(for: "you", in: sink.writtenData).count, 1)

        let codes = diagnosticJSONLines(diagSink).compactMap { $0["code"] }
        XCTAssertFalse(codes.contains("source-restart-unverified"))
    }

    // MARK: - Failure Diagnostics Carry Channel, Reason, Timestamp

    func testSourceFailureDiagnosticsCarryDetails() throws {
        let clock = FakeHostClock(initialTime: 1_000_000_000)
        let systemAudio = FakeSystemAudioSource()
        let microphone = FakeMicrophoneSource()
        let sink = RecordingByteSink()
        let diagSink = MockDiagnosticSink()
        let scheduler = FakeScheduler()
        let coordinator = makeCoordinator(
            clock: clock, systemAudio: systemAudio, microphone: microphone,
            sink: sink, diagSink: diagSink, scheduler: scheduler
        )

        try coordinator.start()
        systemAudio.simulateAudioData(makePCMData(), hostTime: clock.now())
        microphone.simulateAudioData(makePCMData(), hostTime: clock.now())

        systemAudio.simulateFailure() // reason: stream-error on interviewer

        let lines = diagnosticJSONLines(diagSink)
        let failures = lines.filter { $0["code"] == "source-failure" }
        XCTAssertEqual(failures.count, 1)
        XCTAssertEqual(failures[0]["channel"], "interviewer")
        XCTAssertEqual(failures[0]["reason"], "stream-error")
        XCTAssertNotNil(failures[0]["ts"], "every diagnostic line carries an ISO8601 ts")

        // Restart diagnostics carry channel + attempt.
        scheduler.executeAll()
        let attempts = diagnosticJSONLines(diagSink).filter { $0["code"] == "source-restart-attempt" }
        XCTAssertEqual(attempts.count, 1)
        XCTAssertEqual(attempts[0]["channel"], "interviewer")
        XCTAssertEqual(attempts[0]["attempt"], "1")
        let restarted = diagnosticJSONLines(diagSink).filter { $0["code"] == "source-restarted" }
        XCTAssertEqual(restarted.count, 1)
        XCTAssertEqual(restarted[0]["channel"], "interviewer")
    }
}
