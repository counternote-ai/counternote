import XCTest
@testable import AudioCaptureCore

// MARK: - Stop Path Tests

/// Stop is two-phase: `stop()` opens a 250 ms grace window in which
/// deadline-paced emission stays alive so in-flight tail packets still land,
/// then a one-shot finalize drains the mixer, closes interruptions as
/// unrecovered, emits the stopped frame, and fires `onStopped`.
/// `stopImmediately()` (stdin EOF) skips the grace window and finalizes
/// synchronously. The FakeScheduler drives both phases deterministically:
/// `executeAll()` snapshots pending work, so the re-armed pacing tick runs
/// before the finalize it was scheduled ahead of.
final class CaptureCoordinatorStopTests: XCTestCase {

    private func makePCMData(sample: Int16 = 100, count: Int = 320) -> Data {
        var samples = [Int16](repeating: sample, count: count)
        return Data(bytes: &samples, count: samples.count * 2)
    }

    private func makeCoordinator(
        clock: FakeHostClock,
        systemAudio: FakeSystemAudioSource,
        microphone: FakeMicrophoneSource,
        sink: RecordingByteSink,
        scheduler: FakeScheduler
    ) -> CaptureCoordinator {
        return CaptureCoordinator(
            hostClock: clock,
            systemAudio: systemAudio,
            microphone: microphone,
            writer: CaptureProtocolWriter(sink: sink),
            diagnostics: Diagnostics(sink: MockDiagnosticSink()),
            scheduler: scheduler
        )
    }

    /// Ordered frame types in raw protocol data, for stop-path ordering
    /// assertions (FrameCounter only aggregates).
    private func orderedFrameTypes(in data: Data) -> [CaptureFrameType] {
        let headerSize = 16
        var types: [CaptureFrameType] = []
        var offset = 0
        while offset + headerSize <= data.count {
            guard data[offset] == 0x49, data[offset+1] == 0x43,
                  data[offset+2] == 0x41, data[offset+3] == 0x50 else {
                break
            }
            let payloadLength = Int(UInt32(data[offset+8]) |
                (UInt32(data[offset+9]) << 8) |
                (UInt32(data[offset+10]) << 16) |
                (UInt32(data[offset+11]) << 24))
            if let type = CaptureFrameType(rawValue: data[offset + 5]) {
                types.append(type)
            }
            offset += headerSize + payloadLength
        }
        return types
    }

    // MARK: - Graceful Stop Preserves the In-Flight Tail

    /// Regression: the old synchronous stop drained the mixer immediately, so
    /// tail blocks still inside their 200 ms jitter deadline were zero-filled
    /// and reported as unrecovered late-data. The grace window must let them
    /// ship as covered pcm instead.
    func testGracefulStopPreservesInFlightTail() throws {
        let clock = FakeHostClock(initialTime: 1_000_000_000)
        let systemAudio = FakeSystemAudioSource()
        let microphone = FakeMicrophoneSource()
        let sink = RecordingByteSink()
        let scheduler = FakeScheduler()
        let coordinator = makeCoordinator(
            clock: clock, systemAudio: systemAudio, microphone: microphone,
            sink: sink, scheduler: scheduler
        )

        try coordinator.start()

        // Three blocks per channel whose jitter deadlines have NOT passed:
        // block 0 ships at anchor + 20 ms + 200 ms, and the clock never moves.
        systemAudio.simulateAudioData(makePCMData(count: 960), hostTime: clock.now())
        microphone.simulateAudioData(makePCMData(count: 960), hostTime: clock.now())
        XCTAssertEqual(coordinator.getState(), .recording)

        let counter = FrameCounter()
        XCTAssertEqual(counter.countFrames(in: sink.writtenData)[.pcm] ?? 0, 0,
            "precondition: the tail is still buffered awaiting its deadline")

        coordinator.stop()
        scheduler.executeAll() // grace pacing tick, then finalize

        XCTAssertEqual(coordinator.getState(), .idle)
        let counts = counter.countFrames(in: sink.writtenData)
        XCTAssertEqual(counts[.pcm] ?? 0, 3, "the buffered tail must be emitted, not zero-filled")
        XCTAssertEqual(counts[.interruption] ?? 0, 0,
            "no late-data interruption may be opened for the in-flight tail")
        XCTAssertEqual(counts[.stopped] ?? 0, 1)

        let stoppedPayloads = counter.extractJSONPayloads(ofType: .stopped, from: sink.writtenData)
        XCTAssertEqual(stoppedPayloads.count, 1)
        XCTAssertEqual(stoppedPayloads[0]["finalBlockExclusive"] as? Int, 3)
        XCTAssertEqual(stoppedPayloads[0]["pcmBlocks"] as? Int, 3,
            "the stopped frame's counters must include the tail blocks")
        XCTAssertEqual(stoppedPayloads[0]["gapBlocks"] as? Int, 0)
    }

    // MARK: - Feeding During the Grace Window Lands

    /// Packets in flight when stop arrives keep feeding the mixer during the
    /// grace window and are emitted before the stopped frame.
    func testFeedingDuringGraceWindowLandsBeforeStopped() throws {
        let clock = FakeHostClock(initialTime: 1_000_000_000)
        let systemAudio = FakeSystemAudioSource()
        let microphone = FakeMicrophoneSource()
        let sink = RecordingByteSink()
        let scheduler = FakeScheduler()
        let coordinator = makeCoordinator(
            clock: clock, systemAudio: systemAudio, microphone: microphone,
            sink: sink, scheduler: scheduler
        )

        try coordinator.start()
        systemAudio.simulateAudioData(makePCMData(), hostTime: clock.now())
        microphone.simulateAudioData(makePCMData(), hostTime: clock.now())

        coordinator.stop()

        // In-flight packets delivered inside the grace window.
        systemAudio.simulateAudioData(makePCMData(), hostTime: 1_020_000_000)
        microphone.simulateAudioData(makePCMData(), hostTime: 1_020_000_000)
        systemAudio.simulateAudioData(makePCMData(), hostTime: 1_040_000_000)
        microphone.simulateAudioData(makePCMData(), hostTime: 1_040_000_000)

        scheduler.executeAll() // grace pacing tick, then finalize

        let counter = FrameCounter()
        let counts = counter.countFrames(in: sink.writtenData)
        XCTAssertEqual(counts[.pcm] ?? 0, 3, "grace-window feeds must land")
        XCTAssertEqual(counts[.interruption] ?? 0, 0)
        XCTAssertEqual(counts[.stopped] ?? 0, 1)

        XCTAssertEqual(
            orderedFrameTypes(in: sink.writtenData),
            [.ready, .pcm, .pcm, .pcm, .stopped],
            "the late-fed blocks must precede the stopped frame"
        )
    }

    // MARK: - Genuine Outage Still Interrupts

    /// The grace window must not launder a real outage: a channel that never
    /// delivered is still closed unrecovered, and per protocol only
    /// interruption/stopped frames may follow that close.
    func testGenuineOutageStillInterruptsOnStop() throws {
        let clock = FakeHostClock(initialTime: 1_000_000_000)
        let systemAudio = FakeSystemAudioSource()
        let microphone = FakeMicrophoneSource()
        let sink = RecordingByteSink()
        let scheduler = FakeScheduler()
        let coordinator = makeCoordinator(
            clock: clock, systemAudio: systemAudio, microphone: microphone,
            sink: sink, scheduler: scheduler
        )

        try coordinator.start()
        // System audio is healthy for the whole run; the mic dies after block 0.
        systemAudio.simulateAudioData(makePCMData(count: 3_200), hostTime: clock.now())
        microphone.simulateAudioData(makePCMData(), hostTime: clock.now())

        // Route invalidation opens a real failure cycle on the mic channel.
        microphone.simulateFailure()

        // Emit blocks 0-4: the mic's hole opens a route-invalidated interruption.
        clock.advance(by: 300_000_000)
        scheduler.executeAll()

        coordinator.stop()
        scheduler.executeAll() // grace pacing tick, then finalize

        XCTAssertEqual(coordinator.getState(), .idle)
        let counter = FrameCounter()
        let counts = counter.countFrames(in: sink.writtenData)
        XCTAssertEqual(counts[.pcm] ?? 0, 10)
        XCTAssertEqual(counts[.stopped] ?? 0, 1)

        let interruptions = counter.extractJSONPayloads(ofType: .interruption, from: sink.writtenData)
        let unrecoveredClose = interruptions.filter {
            $0["phase"] as? String == "closed" &&
            $0["channel"] as? String == "you" &&
            $0["reason"] as? String == "route-invalidated" &&
            $0["recovered"] as? Bool == false
        }
        XCTAssertEqual(unrecoveredClose.count, 1,
            "the genuine outage must close unrecovered with its failure reason")

        let types = orderedFrameTypes(in: sink.writtenData)
        XCTAssertEqual(types.last, .stopped)
        if let closeIndex = types.lastIndex(of: .interruption) {
            let tail = types[types.index(after: closeIndex)...]
            XCTAssertTrue(
                tail.allSatisfy { $0 == .interruption || $0 == .stopped },
                "only interruption/stopped frames may follow an unrecovered close"
            )
        } else {
            XCTFail("expected an interruption frame")
        }
    }

    // MARK: - Double Stop Is a No-Op

    func testDoubleStopIsNoOpAndOnStoppedFiresOnce() throws {
        let clock = FakeHostClock(initialTime: 1_000_000_000)
        let systemAudio = FakeSystemAudioSource()
        let microphone = FakeMicrophoneSource()
        let sink = RecordingByteSink()
        let scheduler = FakeScheduler()
        let coordinator = makeCoordinator(
            clock: clock, systemAudio: systemAudio, microphone: microphone,
            sink: sink, scheduler: scheduler
        )

        var stoppedCalls = 0
        coordinator.onStopped = { stoppedCalls += 1 }

        try coordinator.start()
        systemAudio.simulateAudioData(makePCMData(), hostTime: clock.now())
        microphone.simulateAudioData(makePCMData(), hostTime: clock.now())

        coordinator.stop()
        XCTAssertEqual(coordinator.getState(), .stopping)
        coordinator.stop() // already stopping: must not re-arm or double-emit
        scheduler.executeAll()

        XCTAssertEqual(coordinator.getState(), .idle)
        XCTAssertEqual(stoppedCalls, 1, "onStopped must fire exactly once")
        XCTAssertEqual(FrameCounter().countFrames(in: sink.writtenData)[.stopped] ?? 0, 1)

        // A stop after finalization is also a no-op (unchanged idle semantics).
        coordinator.stop()
        scheduler.executeAll()
        XCTAssertEqual(stoppedCalls, 1)
        XCTAssertEqual(FrameCounter().countFrames(in: sink.writtenData)[.stopped] ?? 0, 1)
    }

    // MARK: - Stop Immediately (stdin EOF)

    func testStopImmediatelyFromRecordingFinalizesSynchronously() throws {
        let clock = FakeHostClock(initialTime: 1_000_000_000)
        let systemAudio = FakeSystemAudioSource()
        let microphone = FakeMicrophoneSource()
        let sink = RecordingByteSink()
        let scheduler = FakeScheduler()
        let coordinator = makeCoordinator(
            clock: clock, systemAudio: systemAudio, microphone: microphone,
            sink: sink, scheduler: scheduler
        )

        var stoppedCalls = 0
        coordinator.onStopped = { stoppedCalls += 1 }

        try coordinator.start()
        systemAudio.simulateAudioData(makePCMData(), hostTime: clock.now())
        microphone.simulateAudioData(makePCMData(), hostTime: clock.now())

        // No scheduler driving: the EOF path must finish on the calling thread.
        coordinator.stopImmediately()

        XCTAssertEqual(coordinator.getState(), .idle)
        XCTAssertEqual(stoppedCalls, 1)
        XCTAssertFalse(systemAudio.isRunning)
        XCTAssertFalse(microphone.isRunning)
        XCTAssertTrue(scheduler.scheduledWork.isEmpty, "no grace work may remain scheduled")

        let counter = FrameCounter()
        let counts = counter.countFrames(in: sink.writtenData)
        XCTAssertEqual(counts[.pcm] ?? 0, 1, "the buffered block drains without a grace window")
        XCTAssertEqual(counts[.stopped] ?? 0, 1)
    }

    func testStopImmediatelyFromIdleDoesNothing() {
        let clock = FakeHostClock(initialTime: 1_000_000_000)
        let systemAudio = FakeSystemAudioSource()
        let microphone = FakeMicrophoneSource()
        let sink = RecordingByteSink()
        let scheduler = FakeScheduler()
        let coordinator = makeCoordinator(
            clock: clock, systemAudio: systemAudio, microphone: microphone,
            sink: sink, scheduler: scheduler
        )

        var stoppedCalls = 0
        coordinator.onStopped = { stoppedCalls += 1 }

        coordinator.stopImmediately()

        XCTAssertEqual(coordinator.getState(), .idle)
        XCTAssertEqual(stoppedCalls, 0, "idle stop emits no stopped frame, so no onStopped")
        XCTAssertTrue(sink.writtenData.isEmpty, "no frames without a session")
    }
}
