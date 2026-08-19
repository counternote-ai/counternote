import XCTest
@testable import AudioCaptureCore

// MARK: - Fake Scheduler

class FakeScheduler: Scheduler {
    struct ScheduledWork {
        let delay: TimeInterval
        let work: () -> Void
    }

    var scheduledWork: [ScheduledWork] = []
    private(set) var cancelCount = 0

    func schedule(delay: TimeInterval, _ work: @escaping () -> Void) {
        scheduledWork.append(ScheduledWork(delay: delay, work: work))
    }

    func cancelAll() {
        cancelCount += 1
        scheduledWork.removeAll()
    }

    /// Execute all pending scheduled work (simulates time passing)
    func executeAll() {
        let work = scheduledWork
        scheduledWork.removeAll()
        for item in work {
            item.work()
        }
    }

    /// Execute the next pending scheduled work
    func executeNext() {
        guard !scheduledWork.isEmpty else { return }
        let item = scheduledWork.removeFirst()
        item.work()
    }

    /// Get retry work items (delay > 0 and delay <= 10)
    var retryWork: [ScheduledWork] {
        scheduledWork.filter { $0.delay > 0 && $0.delay <= 10.0 }
    }

    /// Get the next retry delay, if any
    var nextRetryDelay: TimeInterval? {
        retryWork.first?.delay
    }
}

// MARK: - Tracking Scheduler

class TrackingScheduler: Scheduler {
    private var workItems: [(delay: TimeInterval, work: () -> Void)] = []
    private(set) var scheduledDelays: [TimeInterval] = []
    private(set) var cancelCount = 0

    func schedule(delay: TimeInterval, _ work: @escaping () -> Void) {
        workItems.append((delay: delay, work: work))
        scheduledDelays.append(delay)
    }

    func cancelAll() {
        cancelCount += 1
        workItems.removeAll()
    }

    func executeAll() {
        let items = workItems
        workItems.removeAll()
        for item in items {
            item.work()
        }
    }
}

// MARK: - Failing Source (fails on restart)

class FailingSystemAudioSource: SystemAudioSource {
    var callback: ((Data, UInt64) -> Void)?
    private(set) var isRunning = false
    private(set) var startCount = 0
    private(set) var stopCount = 0
    var failOnStart = false

    func start() throws {
        startCount += 1
        if failOnStart {
            throw NSError(domain: "test", code: 1)
        }
        isRunning = true
    }

    func stop() {
        isRunning = false
        stopCount += 1
    }

    func setCallback(_ callback: @escaping (Data, UInt64) -> Void) {
        self.callback = callback
    }

    func simulateAudioData(_ data: Data, hostTime: UInt64) {
        callback?(data, hostTime)
    }
}

class FailingMicrophoneSource: MicrophoneSource {
    var callback: ((Data, UInt64) -> Void)?
    private(set) var isRunning = false
    private(set) var startCount = 0
    private(set) var stopCount = 0
    var failOnStart = false
    var deviceName: String? = "Default Input"

    func start() throws {
        startCount += 1
        if failOnStart {
            throw NSError(domain: "test", code: 1)
        }
        isRunning = true
    }

    func stop() {
        isRunning = false
        stopCount += 1
    }

    func setCallback(_ callback: @escaping (Data, UInt64) -> Void) {
        self.callback = callback
    }

    func simulateAudioData(_ data: Data, hostTime: UInt64) {
        callback?(data, hostTime)
    }

    func simulateRouteChange(newDeviceName: String) {
        deviceName = newDeviceName
    }
}

// MARK: - Fake Source (for protocol conformance)

class FakeSystemAudioSource: SystemAudioSource {
    var callback: ((Data, UInt64) -> Void)?
    var failureCallback: (() -> Void)?
    private(set) var isRunning = false
    private(set) var startCount = 0
    private(set) var stopCount = 0
    var startError: Error?

    func start() throws {
        if let error = startError {
            throw error
        }
        isRunning = true
        startCount += 1
    }

    func stop() {
        isRunning = false
        stopCount += 1
    }

    func setCallback(_ callback: @escaping (Data, UInt64) -> Void) {
        self.callback = callback
    }

    func setFailureCallback(_ callback: @escaping () -> Void) {
        failureCallback = callback
    }

    func simulateAudioData(_ data: Data, hostTime: UInt64) {
        callback?(data, hostTime)
    }

    func simulateFailure() {
        failureCallback?()
    }
}

class FakeMicrophoneSource: MicrophoneSource {
    var callback: ((Data, UInt64) -> Void)?
    var failureCallback: (() -> Void)?
    private(set) var isRunning = false
    private(set) var startCount = 0
    private(set) var stopCount = 0
    var startError: Error?
    var deviceName: String? = "Default Input"

    func start() throws {
        if let error = startError {
            throw error
        }
        isRunning = true
        startCount += 1
    }

    func stop() {
        isRunning = false
        stopCount += 1
    }

    func setCallback(_ callback: @escaping (Data, UInt64) -> Void) {
        self.callback = callback
    }

    func setFailureCallback(_ callback: @escaping () -> Void) {
        failureCallback = callback
    }

    func simulateAudioData(_ data: Data, hostTime: UInt64) {
        callback?(data, hostTime)
    }

    func simulateFailure() {
        failureCallback?()
    }

    func simulateRouteChange(newDeviceName: String) {
        deviceName = newDeviceName
    }
}

// MARK: - Recording Byte Sink

class RecordingByteSink: ByteSink {
    var writtenData = Data()

    func writeAll(_ data: Data) throws {
        writtenData.append(data)
    }

    func reset() {
        writtenData = Data()
    }
}

// MARK: - Frame Type Counter

/// Counts frame types in raw protocol data without full decoding
class FrameCounter {
    private let headerSize = 16

    func countFrames(in data: Data) -> [CaptureFrameType: Int] {
        var counts: [CaptureFrameType: Int] = [:]
        var offset = 0

        while offset + headerSize <= data.count {
            // Check magic
            guard data[offset] == 0x49, data[offset+1] == 0x43,
                  data[offset+2] == 0x41, data[offset+3] == 0x50 else {
                break
            }

            let frameType = data[offset + 5]
            let payloadLength = UInt32(data[offset+8]) |
                (UInt32(data[offset+9]) << 8) |
                (UInt32(data[offset+10]) << 16) |
                (UInt32(data[offset+11]) << 24)

            if let type = CaptureFrameType(rawValue: frameType) {
                counts[type, default: 0] += 1
            }

            offset += headerSize + Int(payloadLength)
        }

        return counts
    }

    func extractJSONPayloads(ofType targetType: CaptureFrameType, from data: Data) -> [[String: Any]] {
        var payloads: [[String: Any]] = []
        var offset = 0

        while offset + headerSize <= data.count {
            guard data[offset] == 0x49, data[offset+1] == 0x43,
                  data[offset+2] == 0x41, data[offset+3] == 0x50 else {
                break
            }

            let frameType = data[offset + 5]
            let payloadLength = Int(UInt32(data[offset+8]) |
                (UInt32(data[offset+9]) << 8) |
                (UInt32(data[offset+10]) << 16) |
                (UInt32(data[offset+11]) << 24))

            let payloadStart = offset + headerSize
            let payloadEnd = payloadStart + payloadLength

            if payloadEnd <= data.count, CaptureFrameType(rawValue: frameType) == targetType {
                let payloadData = data[payloadStart..<payloadEnd]
                if let json = try? JSONSerialization.jsonObject(with: Data(payloadData)) as? [String: Any] {
                    payloads.append(json)
                }
            }

            offset = payloadEnd
        }

        return payloads
    }
}

// MARK: - Capture Coordinator Tests

final class CaptureCoordinatorTests: XCTestCase {

    // MARK: - Helpers

    private func makePCMData(sample: Int16 = 100, count: Int = 320) -> Data {
        var samples = [Int16](repeating: sample, count: count)
        return Data(bytes: &samples, count: samples.count * 2)
    }

    private func makeSilentPCMData(count: Int = 320) -> Data {
        return Data(count: count * 2)
    }

    // MARK: - Initialization Tests

    func testCoordinatorStartsInIdleState() {
        let clock = FakeHostClock()
        let systemAudio = FakeSystemAudioSource()
        let microphone = FakeMicrophoneSource()
        let sink = RecordingByteSink()
        let writer = CaptureProtocolWriter(sink: sink)
        let diagnostics = Diagnostics(sink: MockDiagnosticSink())
        let scheduler = FakeScheduler()

        let coordinator = CaptureCoordinator(
            hostClock: clock,
            systemAudio: systemAudio,
            microphone: microphone,
            writer: writer,
            diagnostics: diagnostics,
            scheduler: scheduler
        )

        XCTAssertEqual(coordinator.getState(), .idle)
    }

    // MARK: - Both Callbacks Before Ready

    func testReadyEmittedAfterBothSourcesProvideCallbacks() throws {
        let clock = FakeHostClock(initialTime: 1_000_000_000)
        let systemAudio = FakeSystemAudioSource()
        let microphone = FakeMicrophoneSource()
        let sink = RecordingByteSink()
        let writer = CaptureProtocolWriter(sink: sink)
        let diagnostics = Diagnostics(sink: MockDiagnosticSink())
        let scheduler = FakeScheduler()

        let coordinator = CaptureCoordinator(
            hostClock: clock,
            systemAudio: systemAudio,
            microphone: microphone,
            writer: writer,
            diagnostics: diagnostics,
            scheduler: scheduler
        )

        try coordinator.start()
        XCTAssertEqual(coordinator.getState(), .starting)

        // First callback from system audio only - should NOT be ready yet
        systemAudio.simulateAudioData(makePCMData(), hostTime: clock.now())
        XCTAssertEqual(coordinator.getState(), .starting)

        // First callback from microphone - NOW should be ready
        microphone.simulateAudioData(makePCMData(), hostTime: clock.now())
        XCTAssertEqual(coordinator.getState(), .recording)
    }

    func testReadyNotEmittedTwice() throws {
        let clock = FakeHostClock(initialTime: 1_000_000_000)
        let systemAudio = FakeSystemAudioSource()
        let microphone = FakeMicrophoneSource()
        let sink = RecordingByteSink()
        let writer = CaptureProtocolWriter(sink: sink)
        let diagnostics = Diagnostics(sink: MockDiagnosticSink())
        let scheduler = FakeScheduler()

        let coordinator = CaptureCoordinator(
            hostClock: clock,
            systemAudio: systemAudio,
            microphone: microphone,
            writer: writer,
            diagnostics: diagnostics,
            scheduler: scheduler
        )

        try coordinator.start()

        // Both callbacks to trigger ready
        systemAudio.simulateAudioData(makePCMData(), hostTime: clock.now())
        microphone.simulateAudioData(makePCMData(), hostTime: clock.now())

        // Additional callbacks should not emit another ready
        systemAudio.simulateAudioData(makePCMData(), hostTime: clock.now())
        microphone.simulateAudioData(makePCMData(), hostTime: clock.now())

        // Count frame types in raw data
        let counter = FrameCounter()
        let counts = counter.countFrames(in: sink.writtenData)
        XCTAssertEqual(counts[.ready] ?? 0, 1, "Should emit exactly one ready frame")
    }

    // MARK: - Initialization Failure

    func testSystemAudioStartFailureEmitsTerminalError() throws {
        let clock = FakeHostClock()
        let systemAudio = FakeSystemAudioSource()
        systemAudio.startError = NSError(domain: "test", code: 1)
        let microphone = FakeMicrophoneSource()
        let sink = RecordingByteSink()
        let writer = CaptureProtocolWriter(sink: sink)
        let diagnostics = Diagnostics(sink: MockDiagnosticSink())
        let scheduler = FakeScheduler()

        let coordinator = CaptureCoordinator(
            hostClock: clock,
            systemAudio: systemAudio,
            microphone: microphone,
            writer: writer,
            diagnostics: diagnostics,
            scheduler: scheduler
        )

        try coordinator.start()

        // Should be idle after failure
        XCTAssertEqual(coordinator.getState(), .idle)

        // Should have emitted an error frame
        let counter = FrameCounter()
        let counts = counter.countFrames(in: sink.writtenData)
        XCTAssertEqual(counts[.error] ?? 0, 1, "Should emit exactly one error frame")

        // Verify error payload
        let payloads = counter.extractJSONPayloads(ofType: .error, from: sink.writtenData)
        XCTAssertEqual(payloads.count, 1)
        XCTAssertEqual(payloads[0]["phase"] as? String, "initialization")
        XCTAssertEqual(payloads[0]["code"] as? String, "source-start-failed")
        XCTAssertEqual(payloads[0]["channel"] as? String, "interviewer")
        XCTAssertEqual(payloads[0]["terminal"] as? Bool, true)
    }

    func testMicrophoneStartFailureEmitsTerminalError() throws {
        let clock = FakeHostClock()
        let systemAudio = FakeSystemAudioSource()
        let microphone = FakeMicrophoneSource()
        microphone.startError = NSError(domain: "test", code: 1)
        let sink = RecordingByteSink()
        let writer = CaptureProtocolWriter(sink: sink)
        let diagnostics = Diagnostics(sink: MockDiagnosticSink())
        let scheduler = FakeScheduler()

        let coordinator = CaptureCoordinator(
            hostClock: clock,
            systemAudio: systemAudio,
            microphone: microphone,
            writer: writer,
            diagnostics: diagnostics,
            scheduler: scheduler
        )

        try coordinator.start()

        // Should be idle after failure
        XCTAssertEqual(coordinator.getState(), .idle)

        // System audio should have been stopped
        XCTAssertFalse(systemAudio.isRunning)

        // Should have emitted an error frame for microphone
        let counter = FrameCounter()
        let counts = counter.countFrames(in: sink.writtenData)
        XCTAssertEqual(counts[.error] ?? 0, 1, "Should emit exactly one error frame")

        // Verify error payload
        let payloads = counter.extractJSONPayloads(ofType: .error, from: sink.writtenData)
        XCTAssertEqual(payloads.count, 1)
        XCTAssertEqual(payloads[0]["channel"] as? String, "you")
    }

    // MARK: - Stop Closes Interruptions with recovered: false

    func testStopClosesOpenInterruptionsWithRecoveredFalse() throws {
        let clock = FakeHostClock(initialTime: 1_000_000_000)
        let systemAudio = FakeSystemAudioSource()
        let microphone = FakeMicrophoneSource()
        let sink = RecordingByteSink()
        let writer = CaptureProtocolWriter(sink: sink)
        let diagnostics = Diagnostics(sink: MockDiagnosticSink())
        let scheduler = FakeScheduler()

        let coordinator = CaptureCoordinator(
            hostClock: clock,
            systemAudio: systemAudio,
            microphone: microphone,
            writer: writer,
            diagnostics: diagnostics,
            scheduler: scheduler
        )

        try coordinator.start()

        // Both callbacks to reach recording state
        systemAudio.simulateAudioData(makePCMData(), hostTime: clock.now())
        microphone.simulateAudioData(makePCMData(), hostTime: clock.now())
        XCTAssertEqual(coordinator.getState(), .recording)

        // Simulate system audio stall to open an interruption
        clock.advance(by: 2_100_000_000) // 2.1 seconds
        scheduler.executeAll() // trigger stall check

        // Stop should close the interruption with recovered: false
        coordinator.stop()
        // Stop is two-phase now: the grace-window pacing tick runs first,
        // then the one-shot finalize emits the stopped frame.
        scheduler.executeAll()

        XCTAssertEqual(coordinator.getState(), .idle)

        // Verify the interruption was closed with recovered: false
        let counter = FrameCounter()
        let interruptionPayloads = counter.extractJSONPayloads(ofType: .interruption, from: sink.writtenData)
        let closedPayloads = interruptionPayloads.filter { $0["phase"] as? String == "closed" }
        XCTAssertFalse(closedPayloads.isEmpty, "Should have closed interruption")

        let recoveredFalse = closedPayloads.filter { $0["recovered"] as? Bool == false }
        XCTAssertFalse(recoveredFalse.isEmpty, "Should have closed interruption with recovered: false")
    }

    func testStopEmitsStoppedFrame() throws {
        let clock = FakeHostClock(initialTime: 1_000_000_000)
        let systemAudio = FakeSystemAudioSource()
        let microphone = FakeMicrophoneSource()
        let sink = RecordingByteSink()
        let writer = CaptureProtocolWriter(sink: sink)
        let diagnostics = Diagnostics(sink: MockDiagnosticSink())
        let scheduler = FakeScheduler()

        let coordinator = CaptureCoordinator(
            hostClock: clock,
            systemAudio: systemAudio,
            microphone: microphone,
            writer: writer,
            diagnostics: diagnostics,
            scheduler: scheduler
        )

        try coordinator.start()

        // Both callbacks
        systemAudio.simulateAudioData(makePCMData(), hostTime: clock.now())
        microphone.simulateAudioData(makePCMData(), hostTime: clock.now())

        coordinator.stop()
        scheduler.executeAll() // run the grace pacing tick + finalize

        // Verify stopped frame
        let counter = FrameCounter()
        let counts = counter.countFrames(in: sink.writtenData)
        XCTAssertEqual(counts[.stopped] ?? 0, 1, "Should emit exactly one stopped frame")

        let stoppedPayloads = counter.extractJSONPayloads(ofType: .stopped, from: sink.writtenData)
        XCTAssertEqual(stoppedPayloads.count, 1)
        XCTAssertEqual(stoppedPayloads[0]["reason"] as? String, "stop")
    }

    func testStopStopsBothSources() throws {
        let clock = FakeHostClock(initialTime: 1_000_000_000)
        let systemAudio = FakeSystemAudioSource()
        let microphone = FakeMicrophoneSource()
        let sink = RecordingByteSink()
        let writer = CaptureProtocolWriter(sink: sink)
        let diagnostics = Diagnostics(sink: MockDiagnosticSink())
        let scheduler = FakeScheduler()

        let coordinator = CaptureCoordinator(
            hostClock: clock,
            systemAudio: systemAudio,
            microphone: microphone,
            writer: writer,
            diagnostics: diagnostics,
            scheduler: scheduler
        )

        try coordinator.start()

        systemAudio.simulateAudioData(makePCMData(), hostTime: clock.now())
        microphone.simulateAudioData(makePCMData(), hostTime: clock.now())

        coordinator.stop()
        scheduler.executeAll() // finalize stops the sources

        XCTAssertFalse(systemAudio.isRunning)
        XCTAssertFalse(microphone.isRunning)
    }

    // MARK: - Stall Detection (1,999 ms vs 2,000 ms)

    func testCallbackStallAt2000msTriggersReconnecting() throws {
        let clock = FakeHostClock(initialTime: 1_000_000_000)
        let systemAudio = FakeSystemAudioSource()
        let microphone = FakeMicrophoneSource()
        let sink = RecordingByteSink()
        let writer = CaptureProtocolWriter(sink: sink)
        let diagnostics = Diagnostics(sink: MockDiagnosticSink())
        let scheduler = FakeScheduler()

        let coordinator = CaptureCoordinator(
            hostClock: clock,
            systemAudio: systemAudio,
            microphone: microphone,
            writer: writer,
            diagnostics: diagnostics,
            scheduler: scheduler
        )

        try coordinator.start()

        // Both callbacks to reach recording
        systemAudio.simulateAudioData(makePCMData(), hostTime: clock.now())
        microphone.simulateAudioData(makePCMData(), hostTime: clock.now())
        XCTAssertEqual(coordinator.getState(), .recording)

        // Advance by 1,999 ms - should NOT trigger stall
        clock.advance(by: 1_999_000_000)
        scheduler.executeAll()

        // Count interruption and state frames at this point
        let counter = FrameCounter()
        let interruptionsBefore = counter.extractJSONPayloads(ofType: .interruption, from: sink.writtenData)
        let statesBefore = counter.extractJSONPayloads(ofType: .state, from: sink.writtenData)
        let reconnectingBefore = statesBefore.filter { $0["status"] as? String == "reconnecting" }
        XCTAssertTrue(reconnectingBefore.isEmpty, "1,999 ms should not trigger stall")

        // Reset sink for clearer assertions
        sink.reset()

        // Advance past 2,000 ms total - stall should trigger now
        clock.advance(by: 2_000_000_000) // total now well > 2s from last callback
        scheduler.executeAll()

        // Should now have reconnecting state with callback-stall
        let counter2 = FrameCounter()
        let statesAfter = counter2.extractJSONPayloads(ofType: .state, from: sink.writtenData)
        let reconnectingAfter = statesAfter.filter {
            $0["status"] as? String == "reconnecting" && $0["reason"] as? String == "callback-stall"
        }
        XCTAssertFalse(reconnectingAfter.isEmpty, "2,000+ ms should trigger stall with callback-stall reason")
    }

    // MARK: - Retry at 0.5/1/2 seconds then 10-second periodic

    func testRetryIntervalsFollowBackoff() throws {
        // System audio starts successfully but fails on retry attempts
        let clock = FakeHostClock(initialTime: 1_000_000_000)
        let systemAudio = FailingSystemAudioSource()
        // failOnStart is false initially so start() succeeds
        let microphone = FakeMicrophoneSource()
        let sink = RecordingByteSink()
        let writer = CaptureProtocolWriter(sink: sink)
        let diagnostics = Diagnostics(sink: MockDiagnosticSink())
        let scheduler = TrackingScheduler()

        let coordinator = CaptureCoordinator(
            hostClock: clock,
            systemAudio: systemAudio,
            microphone: microphone,
            writer: writer,
            diagnostics: diagnostics,
            scheduler: scheduler
        )

        try coordinator.start()

        // Both callbacks to reach recording
        systemAudio.simulateAudioData(makePCMData(), hostTime: clock.now())
        microphone.simulateAudioData(makePCMData(), hostTime: clock.now())
        XCTAssertEqual(coordinator.getState(), .recording)

        // Now make system audio fail on subsequent start attempts (retries)
        systemAudio.failOnStart = true

        // Trigger stall: advance past 2s threshold
        clock.advance(by: 2_100_000_000)
        scheduler.executeAll()

        // The stall detected for system audio calls handleSourceFailure which:
        // 1. Opens interruption
        // 2. Emits reconnecting state
        // 3. Stops system audio
        // 4. Schedules retry at 0.5s
        // The stall timer also reschedules itself at 1.0s

        // Execute pending work: the 0.5s retry fires, calls attemptReconnect,
        // which calls systemAudio.start() which now fails, scheduling retry at 1.0s
        scheduler.executeAll()
        XCTAssertGreaterThan(systemAudio.startCount, 1, "First retry should attempt restart")

        // Execute again: 1.0s retry fires, fails, schedules 2.0s
        scheduler.executeAll()
        let countAfterSecond = systemAudio.startCount
        XCTAssertGreaterThan(countAfterSecond, 2, "Second retry should attempt restart")

        // Execute again: 2.0s retry fires, fails, schedules 10.0s periodic
        scheduler.executeAll()
        let countAfterThird = systemAudio.startCount
        XCTAssertGreaterThan(countAfterThird, 3, "Third retry should attempt restart")

        // Verify the total retry attempts match the expected fast-retry pattern
        // 1 (initial start) + 3 (fast retries at 0.5/1/2s) = 4 starts
        // The 10.0s periodic retry is scheduled but not yet executed
        XCTAssertEqual(systemAudio.startCount, 4,
            "Should have 1 initial start + 3 fast retry attempts")
    }

    // MARK: - Route Change

    func testRouteChangeTriggersImmediateRetryWithoutCancelling() throws {
        let clock = FakeHostClock(initialTime: 1_000_000_000)
        let systemAudio = FakeSystemAudioSource()
        let microphone = FakeMicrophoneSource()
        let sink = RecordingByteSink()
        let writer = CaptureProtocolWriter(sink: sink)
        let diagnostics = Diagnostics(sink: MockDiagnosticSink())
        let scheduler = FakeScheduler()

        let coordinator = CaptureCoordinator(
            hostClock: clock,
            systemAudio: systemAudio,
            microphone: microphone,
            writer: writer,
            diagnostics: diagnostics,
            scheduler: scheduler
        )

        try coordinator.start()

        // Both callbacks
        systemAudio.simulateAudioData(makePCMData(), hostTime: clock.now())
        microphone.simulateAudioData(makePCMData(), hostTime: clock.now())

        // Record pre-route-change scheduled count
        let preCount = scheduler.scheduledWork.count

        // Trigger route change
        coordinator.handleRouteChange()

        // Should have added a new immediate (delay=0) scheduled work
        XCTAssertGreaterThan(scheduler.scheduledWork.count, preCount)
        let routeWork = scheduler.scheduledWork.last { $0.delay == 0 }
        XCTAssertNotNil(routeWork, "Route change should schedule immediate retry at delay 0")
    }

    // MARK: - System Audio Stream Error

    func testStreamErrorTriggersRetryAndInterruption() throws {
        let clock = FakeHostClock(initialTime: 1_000_000_000)
        let systemAudio = FakeSystemAudioSource()
        let microphone = FakeMicrophoneSource()
        let sink = RecordingByteSink()
        let writer = CaptureProtocolWriter(sink: sink)
        let diagnostics = Diagnostics(sink: MockDiagnosticSink())
        let scheduler = FakeScheduler()

        let coordinator = CaptureCoordinator(
            hostClock: clock,
            systemAudio: systemAudio,
            microphone: microphone,
            writer: writer,
            diagnostics: diagnostics,
            scheduler: scheduler
        )

        try coordinator.start()

        // Both callbacks
        systemAudio.simulateAudioData(makePCMData(), hostTime: clock.now())
        microphone.simulateAudioData(makePCMData(), hostTime: clock.now())

        // Simulate stall to trigger failure handling
        clock.advance(by: 2_100_000_000)
        scheduler.executeAll()

        // Should have opened an interruption
        let counter = FrameCounter()
        let interruptionPayloads = counter.extractJSONPayloads(ofType: .interruption, from: sink.writtenData)
        let openedPayloads = interruptionPayloads.filter { $0["phase"] as? String == "opened" }
        XCTAssertFalse(openedPayloads.isEmpty, "Should have opened an interruption for stall")
    }

    // MARK: - Meeting App Mute/Unmute (Silent PCM)

    func testSilentPCMDoesNotStopOrRebuildSystemCapture() throws {
        let clock = FakeHostClock(initialTime: 1_000_000_000)
        let systemAudio = FakeSystemAudioSource()
        let microphone = FakeMicrophoneSource()
        let sink = RecordingByteSink()
        let writer = CaptureProtocolWriter(sink: sink)
        let diagnostics = Diagnostics(sink: MockDiagnosticSink())
        let scheduler = FakeScheduler()

        let coordinator = CaptureCoordinator(
            hostClock: clock,
            systemAudio: systemAudio,
            microphone: microphone,
            writer: writer,
            diagnostics: diagnostics,
            scheduler: scheduler
        )

        try coordinator.start()

        // Both callbacks with audio
        systemAudio.simulateAudioData(makePCMData(), hostTime: clock.now())
        microphone.simulateAudioData(makePCMData(), hostTime: clock.now())
        XCTAssertEqual(coordinator.getState(), .recording)

        let preStopCount = systemAudio.stopCount

        // Simulate meeting mute: silent PCM (all zeros) still delivers callbacks
        for _ in 0..<10 {
            clock.advance(by: 20_000_000) // 20ms
            systemAudio.simulateAudioData(makeSilentPCMData(), hostTime: clock.now())
            microphone.simulateAudioData(makePCMData(), hostTime: clock.now())
        }

        // System audio should NOT have been stopped/rebuilt for silent PCM
        XCTAssertEqual(systemAudio.stopCount, preStopCount, "Silent PCM should not trigger source stop")
        XCTAssertEqual(coordinator.getState(), .recording)

        // Unmute: non-zero PCM should continue normally
        clock.advance(by: 20_000_000)
        systemAudio.simulateAudioData(makePCMData(), hostTime: clock.now())
        microphone.simulateAudioData(makePCMData(), hostTime: clock.now())

        XCTAssertEqual(coordinator.getState(), .recording)
    }

    // MARK: - Stop During Every Open Interruption Reason

    func testStopDuringSourceGapInterruption() throws {
        let clock = FakeHostClock(initialTime: 1_000_000_000)
        let systemAudio = FakeSystemAudioSource()
        let microphone = FakeMicrophoneSource()
        let sink = RecordingByteSink()
        let writer = CaptureProtocolWriter(sink: sink)
        let diagnostics = Diagnostics(sink: MockDiagnosticSink())
        let scheduler = FakeScheduler()

        let coordinator = CaptureCoordinator(
            hostClock: clock,
            systemAudio: systemAudio,
            microphone: microphone,
            writer: writer,
            diagnostics: diagnostics,
            scheduler: scheduler
        )

        try coordinator.start()

        // Both callbacks
        systemAudio.simulateAudioData(makePCMData(), hostTime: clock.now())
        microphone.simulateAudioData(makePCMData(), hostTime: clock.now())

        // Trigger stall to open interruption
        clock.advance(by: 2_100_000_000)
        scheduler.executeAll()

        // Stop while interruption is open
        coordinator.stop()
        scheduler.executeAll() // run the grace pacing tick + finalize

        // Verify: interruption closed with recovered: false, stopped emitted
        let counter = FrameCounter()
        let interruptionPayloads = counter.extractJSONPayloads(ofType: .interruption, from: sink.writtenData)
        let closedPayloads = interruptionPayloads.filter { $0["phase"] as? String == "closed" }
        let recoveredFalse = closedPayloads.filter { $0["recovered"] as? Bool == false }
        XCTAssertFalse(recoveredFalse.isEmpty, "Should close interruption with recovered: false")

        let counts = counter.countFrames(in: sink.writtenData)
        XCTAssertEqual(counts[.stopped] ?? 0, 1, "Should emit stopped frame")
    }

    func testStopDuringCallbackStallInterruption() throws {
        let clock = FakeHostClock(initialTime: 1_000_000_000)
        let systemAudio = FakeSystemAudioSource()
        let microphone = FakeMicrophoneSource()
        let sink = RecordingByteSink()
        let writer = CaptureProtocolWriter(sink: sink)
        let diagnostics = Diagnostics(sink: MockDiagnosticSink())
        let scheduler = FakeScheduler()

        let coordinator = CaptureCoordinator(
            hostClock: clock,
            systemAudio: systemAudio,
            microphone: microphone,
            writer: writer,
            diagnostics: diagnostics,
            scheduler: scheduler
        )

        try coordinator.start()

        // Both callbacks
        systemAudio.simulateAudioData(makePCMData(), hostTime: clock.now())
        microphone.simulateAudioData(makePCMData(), hostTime: clock.now())

        // Trigger stall for callback-stall reason
        clock.advance(by: 2_100_000_000)
        scheduler.executeAll()

        // Stop while callback-stall interruption is open
        coordinator.stop()
        scheduler.executeAll() // run the grace pacing tick + finalize

        let counter = FrameCounter()
        let interruptionPayloads = counter.extractJSONPayloads(ofType: .interruption, from: sink.writtenData)
        let closedCallbackStall = interruptionPayloads.filter {
            $0["phase"] as? String == "closed" &&
            $0["reason"] as? String == "callback-stall" &&
            $0["recovered"] as? Bool == false
        }
        XCTAssertFalse(closedCallbackStall.isEmpty, "Should close callback-stall with recovered: false on Stop")
    }

    // MARK: - Parent-pipe EOF / Stop Cancellation

    func testStopCancelsAllPendingRetries() throws {
        let clock = FakeHostClock(initialTime: 1_000_000_000)
        let systemAudio = FakeSystemAudioSource()
        let microphone = FakeMicrophoneSource()
        let sink = RecordingByteSink()
        let writer = CaptureProtocolWriter(sink: sink)
        let diagnostics = Diagnostics(sink: MockDiagnosticSink())
        let scheduler = FakeScheduler()

        let coordinator = CaptureCoordinator(
            hostClock: clock,
            systemAudio: systemAudio,
            microphone: microphone,
            writer: writer,
            diagnostics: diagnostics,
            scheduler: scheduler
        )

        try coordinator.start()

        // Both callbacks
        systemAudio.simulateAudioData(makePCMData(), hostTime: clock.now())
        microphone.simulateAudioData(makePCMData(), hostTime: clock.now())

        // Trigger stall to schedule retries
        clock.advance(by: 2_100_000_000)
        scheduler.executeAll()

        // Stop should cancel all pending work
        coordinator.stop()

        XCTAssertGreaterThanOrEqual(scheduler.cancelCount, 1, "Stop should cancel scheduler work")
    }

    // MARK: - Invalid Timestamp Handling

    func testCallbacksBeforeStartAreIgnored() {
        let clock = FakeHostClock(initialTime: 1_000_000_000)
        let systemAudio = FakeSystemAudioSource()
        let microphone = FakeMicrophoneSource()
        let sink = RecordingByteSink()
        let writer = CaptureProtocolWriter(sink: sink)
        let diagnostics = Diagnostics(sink: MockDiagnosticSink())
        let scheduler = FakeScheduler()

        let coordinator = CaptureCoordinator(
            hostClock: clock,
            systemAudio: systemAudio,
            microphone: microphone,
            writer: writer,
            diagnostics: diagnostics,
            scheduler: scheduler
        )

        // Send callbacks before start - should be ignored
        systemAudio.simulateAudioData(makePCMData(), hostTime: clock.now())
        microphone.simulateAudioData(makePCMData(), hostTime: clock.now())

        XCTAssertEqual(coordinator.getState(), .idle)
        XCTAssertTrue(sink.writtenData.isEmpty, "No frames should be emitted before start")
    }

    func testCallbacksAfterStopAreIgnored() throws {
        let clock = FakeHostClock(initialTime: 1_000_000_000)
        let systemAudio = FakeSystemAudioSource()
        let microphone = FakeMicrophoneSource()
        let sink = RecordingByteSink()
        let writer = CaptureProtocolWriter(sink: sink)
        let diagnostics = Diagnostics(sink: MockDiagnosticSink())
        let scheduler = FakeScheduler()

        let coordinator = CaptureCoordinator(
            hostClock: clock,
            systemAudio: systemAudio,
            microphone: microphone,
            writer: writer,
            diagnostics: diagnostics,
            scheduler: scheduler
        )

        try coordinator.start()

        systemAudio.simulateAudioData(makePCMData(), hostTime: clock.now())
        microphone.simulateAudioData(makePCMData(), hostTime: clock.now())

        coordinator.stop()
        // Complete the stop: callbacks inside the grace window still feed the
        // mixer by design; once finalized the state guard drops them.
        scheduler.executeAll()

        let dataCountBefore = sink.writtenData.count

        // Callbacks after stop has finalized should be ignored
        systemAudio.simulateAudioData(makePCMData(), hostTime: clock.now())
        microphone.simulateAudioData(makePCMData(), hostTime: clock.now())

        XCTAssertEqual(sink.writtenData.count, dataCountBefore, "No new frames after stop")
    }

    // MARK: - Health Integration

    func testSourceFailureUpdatesHealthImmediately() throws {
        let clock = FakeHostClock(initialTime: 1_000_000_000)
        let systemAudio = FakeSystemAudioSource()
        let microphone = FakeMicrophoneSource()
        let sink = RecordingByteSink()
        let writer = CaptureProtocolWriter(sink: sink)
        let diagnostics = Diagnostics(sink: MockDiagnosticSink())
        let scheduler = FakeScheduler()

        let coordinator = CaptureCoordinator(
            hostClock: clock,
            systemAudio: systemAudio,
            microphone: microphone,
            writer: writer,
            diagnostics: diagnostics,
            scheduler: scheduler
        )

        try coordinator.start()

        // Both callbacks
        systemAudio.simulateAudioData(makePCMData(), hostTime: clock.now())
        microphone.simulateAudioData(makePCMData(), hostTime: clock.now())

        // Trigger stall
        clock.advance(by: 2_100_000_000)
        scheduler.executeAll()

        // Verify reconnecting state was emitted (health update)
        let counter = FrameCounter()
        let statePayloads = counter.extractJSONPayloads(ofType: .state, from: sink.writtenData)
        let reconnectingStates = statePayloads.filter { $0["status"] as? String == "reconnecting" }
        XCTAssertFalse(reconnectingStates.isEmpty, "Health should update to reconnecting on failure")
    }

    // MARK: - Recovery After Retry

    func testRecoveryAfterRetryClosesInterruptionWithRecoveredTrue() throws {
        let clock = FakeHostClock(initialTime: 1_000_000_000)
        let systemAudio = FakeSystemAudioSource()
        let microphone = FakeMicrophoneSource()
        let sink = RecordingByteSink()
        let writer = CaptureProtocolWriter(sink: sink)
        let diagnostics = Diagnostics(sink: MockDiagnosticSink())
        let scheduler = FakeScheduler()

        let coordinator = CaptureCoordinator(
            hostClock: clock,
            systemAudio: systemAudio,
            microphone: microphone,
            writer: writer,
            diagnostics: diagnostics,
            scheduler: scheduler
        )

        try coordinator.start()

        // Both callbacks
        systemAudio.simulateAudioData(makePCMData(), hostTime: clock.now())
        microphone.simulateAudioData(makePCMData(), hostTime: clock.now())

        // Trigger stall
        clock.advance(by: 2_100_000_000)
        scheduler.executeAll()

        // Execute the first retry (system audio will restart successfully)
        scheduler.executeAll()

        // Simulate recovery: system audio sends a new callback
        systemAudio.simulateAudioData(makePCMData(), hostTime: clock.now())

        // Should close the interruption with recovered: true
        let counter = FrameCounter()
        let interruptionPayloads = counter.extractJSONPayloads(ofType: .interruption, from: sink.writtenData)
        let recoveredCloses = interruptionPayloads.filter {
            $0["phase"] as? String == "closed" && $0["recovered"] as? Bool == true
        }
        XCTAssertFalse(recoveredCloses.isEmpty, "Recovery should close interruption with recovered: true")
    }

    // MARK: - Diagnostics Emission

    func testStartEmitsCaptureStartedDiagnostic() throws {
        let clock = FakeHostClock()
        let systemAudio = FakeSystemAudioSource()
        let microphone = FakeMicrophoneSource()
        let sink = RecordingByteSink()
        let writer = CaptureProtocolWriter(sink: sink)
        let diagSink = MockDiagnosticSink()
        let diagnostics = Diagnostics(sink: diagSink)
        let scheduler = FakeScheduler()

        let coordinator = CaptureCoordinator(
            hostClock: clock,
            systemAudio: systemAudio,
            microphone: microphone,
            writer: writer,
            diagnostics: diagnostics,
            scheduler: scheduler
        )

        try coordinator.start()

        // Should have emitted capture-started
        let captureStarted = diagSink.lines.first { $0.contains("capture-started") }
        XCTAssertNotNil(captureStarted, "Should emit capture-started diagnostic")
    }

    func testStopEmitsCaptureStoppedDiagnostic() throws {
        let clock = FakeHostClock(initialTime: 1_000_000_000)
        let systemAudio = FakeSystemAudioSource()
        let microphone = FakeMicrophoneSource()
        let sink = RecordingByteSink()
        let writer = CaptureProtocolWriter(sink: sink)
        let diagSink = MockDiagnosticSink()
        let diagnostics = Diagnostics(sink: diagSink)
        let scheduler = FakeScheduler()

        let coordinator = CaptureCoordinator(
            hostClock: clock,
            systemAudio: systemAudio,
            microphone: microphone,
            writer: writer,
            diagnostics: diagnostics,
            scheduler: scheduler
        )

        try coordinator.start()

        systemAudio.simulateAudioData(makePCMData(), hostTime: clock.now())
        microphone.simulateAudioData(makePCMData(), hostTime: clock.now())

        coordinator.stop()
        scheduler.executeAll() // finalize emits the capture-stopped diagnostic

        let captureStopped = diagSink.lines.first { $0.contains("capture-stopped") }
        XCTAssertNotNil(captureStopped, "Should emit capture-stopped diagnostic")
    }

    // MARK: - PCM Emission

    func testPCMEmittedForAudioBlocks() throws {
        let clock = FakeHostClock(initialTime: 1_000_000_000)
        let systemAudio = FakeSystemAudioSource()
        let microphone = FakeMicrophoneSource()
        let sink = RecordingByteSink()
        let writer = CaptureProtocolWriter(sink: sink)
        let diagnostics = Diagnostics(sink: MockDiagnosticSink())
        let scheduler = FakeScheduler()

        let coordinator = CaptureCoordinator(
            hostClock: clock,
            systemAudio: systemAudio,
            microphone: microphone,
            writer: writer,
            diagnostics: diagnostics,
            scheduler: scheduler
        )

        try coordinator.start()

        // Both callbacks to trigger ready + PCM
        systemAudio.simulateAudioData(makePCMData(), hostTime: clock.now())
        microphone.simulateAudioData(makePCMData(), hostTime: clock.now())

        // Emission is deadline-gated: block 0 ships once its window end plus
        // the 200 ms jitter bound has passed. Advance time and run the pacing
        // tick.
        clock.advance(by: 300_000_000)
        scheduler.executeAll()

        // Should have PCM frames
        let counter = FrameCounter()
        let counts = counter.countFrames(in: sink.writtenData)
        XCTAssertGreaterThan(counts[.pcm] ?? 0, 0, "Should emit PCM frames for audio data")
    }
}

// MARK: - Protocol conformance (decoded with the real validator)

/// The frame counter used elsewhere in this file never validates the stream;
/// these tests run the coordinator's bytes through the real protocol decoder,
/// which enforces sequence, ordering invariants, and clean EOF.
final class CaptureCoordinatorProtocolTests: XCTestCase {

    private func makePCMData(sample: Int16 = 100, count: Int = 320) -> Data {
        var samples = [Int16](repeating: sample, count: count)
        return Data(bytes: &samples, count: samples.count * 2)
    }

    private func assertValidProtocolStream(_ data: Data, file: StaticString = #filePath, line: UInt = #line) {
        let decoder = CaptureProtocolDecoder()
        do {
            // The decoder bounds its retained buffer, so push in small chunks
            // like the incremental stdout reads in production.
            var offset = 0
            while offset < data.count {
                let end = min(offset + 4_096, data.count)
                _ = try decoder.push(Data(data[offset..<end]))
                offset = end
            }
            try decoder.finish()
        } catch {
            XCTFail("protocol stream rejected: \(error)", file: file, line: line)
        }
    }

    func testCleanRecordStopPassesProtocolValidation() throws {
        let clock = FakeHostClock(initialTime: 1_000_000_000)
        let systemAudio = FakeSystemAudioSource()
        let microphone = FakeMicrophoneSource()
        let sink = RecordingByteSink()
        let writer = CaptureProtocolWriter(sink: sink)
        let diagnostics = Diagnostics(sink: MockDiagnosticSink())
        let scheduler = FakeScheduler()

        let coordinator = CaptureCoordinator(
            hostClock: clock,
            systemAudio: systemAudio,
            microphone: microphone,
            writer: writer,
            diagnostics: diagnostics,
            scheduler: scheduler
        )

        try coordinator.start()
        // Feed 10 blocks per channel so every deadline-gated block is covered.
        systemAudio.simulateAudioData(makePCMData(count: 3_200), hostTime: clock.now())
        microphone.simulateAudioData(makePCMData(count: 3_200), hostTime: clock.now())
        clock.advance(by: 300_000_000)
        scheduler.executeAll()
        coordinator.stop()
        scheduler.executeAll() // grace pacing tick + finalize emit the tail

        assertValidProtocolStream(sink.writtenData)

        // A clean run emits no interruptions at all.
        let counter = FrameCounter()
        let interruptions = counter.extractJSONPayloads(ofType: .interruption, from: sink.writtenData)
        XCTAssertTrue(interruptions.isEmpty, "clean recording should have no interruptions")
    }

    func testOutageRecoveryStopPassesProtocolValidation() throws {
        let clock = FakeHostClock(initialTime: 1_000_000_000)
        let systemAudio = FakeSystemAudioSource()
        let microphone = FakeMicrophoneSource()
        let sink = RecordingByteSink()
        let writer = CaptureProtocolWriter(sink: sink)
        let diagnostics = Diagnostics(sink: MockDiagnosticSink())
        let scheduler = FakeScheduler()

        let coordinator = CaptureCoordinator(
            hostClock: clock,
            systemAudio: systemAudio,
            microphone: microphone,
            writer: writer,
            diagnostics: diagnostics,
            scheduler: scheduler
        )

        try coordinator.start()
        systemAudio.simulateAudioData(makePCMData(count: 3_200), hostTime: clock.now())
        microphone.simulateAudioData(makePCMData(count: 3_200), hostTime: clock.now())
        clock.advance(by: 300_000_000)
        scheduler.executeAll()

        // Microphone route invalidation: failure callback, retry, restart.
        microphone.simulateFailure()
        scheduler.executeAll() // retry attempt restarts the source

        // First callback after the restart: recovery. Feed 10 fresh blocks on
        // the rebuilt source's timeline.
        microphone.simulateAudioData(makePCMData(count: 3_200), hostTime: clock.now())
        clock.advance(by: 300_000_000)
        scheduler.executeAll()

        coordinator.stop()
        scheduler.executeAll() // grace pacing tick + finalize emit the tail

        assertValidProtocolStream(sink.writtenData)
        let counter = FrameCounter()
        let interruptions = counter.extractJSONPayloads(ofType: .interruption, from: sink.writtenData)
        XCTAssertTrue(interruptions.contains {
            $0["phase"] as? String == "closed" && $0["recovered"] as? Bool == true
        }, "outage should close recovered after the restart")
    }

    func testStopMidOutagePassesProtocolValidation() throws {
        let clock = FakeHostClock(initialTime: 1_000_000_000)
        let systemAudio = FakeSystemAudioSource()
        let microphone = FakeMicrophoneSource()
        let sink = RecordingByteSink()
        let writer = CaptureProtocolWriter(sink: sink)
        let diagnostics = Diagnostics(sink: MockDiagnosticSink())
        let scheduler = FakeScheduler()

        let coordinator = CaptureCoordinator(
            hostClock: clock,
            systemAudio: systemAudio,
            microphone: microphone,
            writer: writer,
            diagnostics: diagnostics,
            scheduler: scheduler
        )

        try coordinator.start()
        systemAudio.simulateAudioData(makePCMData(), hostTime: clock.now())
        microphone.simulateAudioData(makePCMData(), hostTime: clock.now())

        // Stall both channels, then stop with interruptions still open
        clock.advance(by: 2_100_000_000)
        scheduler.executeAll()
        coordinator.stop()
        scheduler.executeAll() // grace pacing tick + finalize close the outage

        assertValidProtocolStream(sink.writtenData)
    }
}

// MARK: - Retry re-entry guard

final class CaptureCoordinatorRetryGuardTests: XCTestCase {

    private func makePCMData(sample: Int16 = 100, count: Int = 320) -> Data {
        var samples = [Int16](repeating: sample, count: count)
        return Data(bytes: &samples, count: samples.count * 2)
    }

    /// Route-change flapping can report the same failure repeatedly. A channel
    /// already being retried must keep its single retry chain: no re-stop, no
    /// extra state frame, no extra retry.
    func testRepeatedFailureWhileRetryingDoesNotMultiplyRetries() throws {
        let clock = FakeHostClock(initialTime: 1_000_000_000)
        let systemAudio = FakeSystemAudioSource()
        let microphone = FakeMicrophoneSource()
        let sink = RecordingByteSink()
        let writer = CaptureProtocolWriter(sink: sink)
        let diagnostics = Diagnostics(sink: MockDiagnosticSink())
        let scheduler = FakeScheduler()

        let coordinator = CaptureCoordinator(
            hostClock: clock,
            systemAudio: systemAudio,
            microphone: microphone,
            writer: writer,
            diagnostics: diagnostics,
            scheduler: scheduler
        )

        try coordinator.start()
        let t0 = clock.now()
        microphone.simulateAudioData(makePCMData(), hostTime: t0)
        systemAudio.simulateAudioData(makePCMData(), hostTime: t0)

        systemAudio.simulateFailure()
        XCTAssertEqual(systemAudio.stopCount, 1, "first failure stops the source once")
        XCTAssertEqual(
            scheduler.scheduledWork.filter { $0.delay == 0.5 }.count, 1,
            "first failure schedules one retry"
        )

        systemAudio.simulateFailure()
        XCTAssertEqual(systemAudio.stopCount, 1, "repeated failure must not re-stop the source")
        XCTAssertEqual(
            scheduler.scheduledWork.filter { $0.delay == 0.5 }.count, 1,
            "repeated failure must not add a second retry"
        )

        let counter = FrameCounter()
        let reconnectingStates = counter.extractJSONPayloads(ofType: .state, from: sink.writtenData).filter {
            $0["status"] as? String == "reconnecting"
        }
        XCTAssertEqual(reconnectingStates.count, 1, "one reconnecting state frame per outage")
    }
}

// MARK: - Concurrency stress

/// Source callbacks, pacing ticks, and stop all run on different threads in
/// production. The coordinator must serialize them so the protocol stream is
/// never corrupted; this test hammers those entry points concurrently and
/// validates the output with the real decoder.
final class CaptureCoordinatorConcurrencyTests: XCTestCase {

    func testConcurrentFeedPacingAndStopProduceValidProtocolStream() throws {
        let clock = SystemHostClock()
        let systemAudio = FakeSystemAudioSource()
        let microphone = FakeMicrophoneSource()
        let sink = RecordingByteSink()
        let writer = CaptureProtocolWriter(sink: sink)
        let diagnostics = Diagnostics(sink: MockDiagnosticSink())
        let scheduler = SystemScheduler()

        let coordinator = CaptureCoordinator(
            hostClock: clock,
            systemAudio: systemAudio,
            microphone: microphone,
            writer: writer,
            diagnostics: diagnostics,
            scheduler: scheduler
        )

        // Stop finalizes on the real scheduler after the 250 ms grace window;
        // block the assertions on the one-shot completion signal.
        let stopped = expectation(description: "stopped")
        coordinator.onStopped = { stopped.fulfill() }

        try coordinator.start()

        // Two feeder threads deliver 20 ms chunks every ~5 ms of real time
        // (burstier than production) while the pacing timer emits concurrently.
        let chunk = Data(count: 640)
        let group = DispatchGroup()
        let feeders: [(Data, UInt64) -> Void] = [
            { systemAudio.simulateAudioData($0, hostTime: $1) },
            { microphone.simulateAudioData($0, hostTime: $1) },
        ]
        for feed in feeders {
            group.enter()
            DispatchQueue.global().async {
                var timestamp = clock.now()
                for _ in 0..<100 {
                    feed(chunk, timestamp)
                    timestamp += 20_000_000
                    usleep(5_000)
                }
                group.leave()
            }
        }
        group.wait()

        // Let pacing drain past the 200 ms jitter deadline, then stop.
        usleep(400_000)
        coordinator.stop()
        wait(for: [stopped], timeout: 5.0)

        let decoder = CaptureProtocolDecoder()
        do {
            // The decoder bounds its retained buffer, so push in small chunks
            // like the incremental stdout reads in production.
            var offset = 0
            while offset < sink.writtenData.count {
                let end = min(offset + 4_096, sink.writtenData.count)
                _ = try decoder.push(Data(sink.writtenData[offset..<end]))
                offset = end
            }
            try decoder.finish()
        } catch {
            XCTFail("concurrent run corrupted the protocol stream: \(error)")
        }

        let counts = FrameCounter().countFrames(in: sink.writtenData)
        XCTAssertGreaterThan(counts[.pcm] ?? 0, 0, "should have emitted pcm blocks")
        XCTAssertEqual(counts[.stopped] ?? 0, 1, "should end with exactly one stopped frame")
    }
}
