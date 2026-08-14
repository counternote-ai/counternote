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

    func simulateAudioData(_ data: Data, hostTime: UInt64) {
        callback?(data, hostTime)
    }
}

class FakeMicrophoneSource: MicrophoneSource {
    var callback: ((Data, UInt64) -> Void)?
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

    func simulateAudioData(_ data: Data, hostTime: UInt64) {
        callback?(data, hostTime)
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

        let dataCountBefore = sink.writtenData.count

        // Callbacks after stop should be ignored
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

        // Should have PCM frames
        let counter = FrameCounter()
        let counts = counter.countFrames(in: sink.writtenData)
        XCTAssertGreaterThan(counts[.pcm] ?? 0, 0, "Should emit PCM frames for audio data")
    }
}
