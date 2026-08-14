import Foundation

// MARK: - Capture State

public enum CaptureState: String, Sendable {
    case idle
    case starting
    case recording
    case stopping
}

// MARK: - Scheduler Protocol

public protocol Scheduler {
    func schedule(delay: TimeInterval, _ work: @escaping () -> Void)
    func cancelAll()
}

// MARK: - System Scheduler

public class SystemScheduler: Scheduler {
    private var workItems: [DispatchWorkItem] = []

    public init() {}

    public func schedule(delay: TimeInterval, _ work: @escaping () -> Void) {
        let item = DispatchWorkItem(block: work)
        workItems.append(item)
        DispatchQueue.global().asyncAfter(deadline: .now() + delay, execute: item)
    }

    public func cancelAll() {
        workItems.forEach { $0.cancel() }
        workItems.removeAll()
    }
}

// MARK: - Capture Output Protocol

public protocol CaptureOutput {
    func writeFrame(_ frame: CaptureFrame) throws
}

extension CaptureProtocolWriter: CaptureOutput {}

// MARK: - Capture Coordinator

public class CaptureCoordinator {
    private let hostClock: HostClock
    private let systemAudio: SystemAudioSource
    private let microphone: MicrophoneSource
    private let mixer: TimelineMixer
    private let writer: CaptureOutput
    private let diagnostics: Diagnostics
    private let scheduler: Scheduler
    private let healthSystem: SourceHealth
    private let healthMicrophone: SourceHealth

    private var state: CaptureState = .idle
    private var readyEmitted = false
    private var systemAudioReady = false
    private var microphoneReady = false
    private var currentBlock: UInt32 = 0
    private var pcmBlocks: UInt32 = 0
    private var gapBlocks: UInt32 = 0
    private var interruptionIdCounter: UInt32 = 1
    private var openInterruptions: [SourceChannel: InterruptionPayload] = [:]

    // Retry state
    private var systemRetryAttempt: UInt32 = 0
    private var microphoneRetryAttempt: UInt32 = 0
    private var systemRetrying = false
    private var microphoneRetrying = false

    // Stall detection timestamps (in nanoseconds)
    private var lastSystemCallbackTime: UInt64 = 0
    private var lastMicrophoneCallbackTime: UInt64 = 0
    private var stallTimerActive = false

    // Fast retry intervals: 0.5s, 1s, 2s, then 10s periodic
    private let fastRetryIntervals: [TimeInterval] = [0.5, 1.0, 2.0]
    private let periodicRetryInterval: TimeInterval = 10.0
    private let callbackStallThresholdNs: UInt64 = 2_000_000_000 // 2 seconds

    // Route change callback storage
    private var routeChangeHandler: (() -> Void)?

    public init(
        hostClock: HostClock,
        systemAudio: SystemAudioSource,
        microphone: MicrophoneSource,
        writer: CaptureOutput,
        diagnostics: Diagnostics,
        scheduler: Scheduler? = nil
    ) {
        self.hostClock = hostClock
        self.systemAudio = systemAudio
        self.microphone = microphone
        self.mixer = TimelineMixer(hostClock: hostClock)
        self.writer = writer
        self.diagnostics = diagnostics
        self.scheduler = scheduler ?? SystemScheduler()
        self.healthSystem = SourceHealth(channel: .interviewer)
        self.healthMicrophone = SourceHealth(channel: .you)
    }

    // MARK: - Start

    /// Start the capture session
    public func start() throws {
        state = .starting

        // Set up callbacks
        systemAudio.setCallback { [weak self] data, hostTime in
            self?.handleSystemAudio(data: data, hostTime: hostTime)
        }

        microphone.setCallback { [weak self] data, hostTime in
            self?.handleMicrophone(data: data, hostTime: hostTime)
        }
        systemAudio.setFailureCallback { [weak self] in
            self?.handleSourceFailure(channel: .interviewer, reason: .streamError)
        }
        microphone.setFailureCallback { [weak self] in
            self?.handleSourceFailure(channel: .you, reason: .routeInvalidated)
        }

        // Start sources
        do {
            try systemAudio.start()
        } catch {
            state = .idle
            healthSystem.markDisconnected(effectiveBlock: currentBlock, reason: .streamError)
            try writer.writeFrame(.error(sequence: currentBlock, payload: ErrorPayload(
                type: "error",
                phase: .initialization,
                code: .sourceStartFailed,
                channel: .interviewer,
                terminal: true
            )))
            try diagnostics.emit(level: .error, code: .sourceError)
            return
        }

        do {
            try microphone.start()
        } catch {
            systemAudio.stop()
            state = .idle
            healthMicrophone.markDisconnected(effectiveBlock: currentBlock, reason: .streamError)
            try writer.writeFrame(.error(sequence: currentBlock, payload: ErrorPayload(
                type: "error",
                phase: .initialization,
                code: .sourceStartFailed,
                channel: .you,
                terminal: true
            )))
            try diagnostics.emit(level: .error, code: .sourceError)
            return
        }

        // Record initial callback times for stall detection
        let now = hostClock.now()
        lastSystemCallbackTime = now
        lastMicrophoneCallbackTime = now

        // Start stall detection timer
        startStallTimer()

        try diagnostics.emit(level: .info, code: .captureStarted)
    }

    // MARK: - Stop

    /// Stop the capture session
    public func stop() {
        guard state == .recording || state == .starting else { return }
        state = .stopping

        // Cancel all pending retries and stall timer
        scheduler.cancelAll()
        stallTimerActive = false
        systemRetrying = false
        microphoneRetrying = false

        systemAudio.stop()
        microphone.stop()

        // Close any open interruptions with recovered: false
        let channelsToClose = Array(openInterruptions.keys)
        for channel in channelsToClose {
            closeInterruption(channel: channel, recovered: false)
        }

        // Drain any remaining blocks from the mixer
        drainMixer()

        // Emit stopped frame
        let stopped = StoppedPayload(
            type: "stopped",
            reason: "stop",
            finalBlockExclusive: currentBlock,
            pcmBlocks: pcmBlocks,
            gapBlocks: gapBlocks,
            openInterruptionIds: []
        )

        do {
            try writer.writeFrame(.stopped(sequence: currentBlock, payload: stopped))
        } catch {
            // Log error but continue
        }

        state = .idle
        try? diagnostics.emit(level: .info, code: .captureStopped)
    }

    /// Get current capture state
    public func getState() -> CaptureState {
        return state
    }

    // MARK: - Audio Handling

    private func handleSystemAudio(data: Data, hostTime: UInt64) {
        guard state == .recording || state == .starting else { return }

        // Reset stall timer for this source
        lastSystemCallbackTime = hostClock.now()

        if !systemAudioReady {
            systemAudioReady = true
            // Close any reconnecting interruption on first callback after retry
            if systemRetrying {
                systemRetrying = false
                systemRetryAttempt = 0
                if openInterruptions[.interviewer] != nil {
                    closeInterruption(channel: .interviewer, recovered: true)
                }
                healthSystem.markConnected(effectiveBlock: currentBlock)
            }
            checkReady()
        }

        mixer.feed(channel: .interviewer, pcm: data, hostTime: hostTime)
        processOutput()
    }

    private func handleMicrophone(data: Data, hostTime: UInt64) {
        guard state == .recording || state == .starting else { return }

        // Reset stall timer for this source
        lastMicrophoneCallbackTime = hostClock.now()

        if !microphoneReady {
            microphoneReady = true
            // Close any reconnecting interruption on first callback after retry
            if microphoneRetrying {
                microphoneRetrying = false
                microphoneRetryAttempt = 0
                if openInterruptions[.you] != nil {
                    closeInterruption(channel: .you, recovered: true)
                }
                healthMicrophone.markConnected(effectiveBlock: currentBlock)
            }
            checkReady()
        }

        mixer.feed(channel: .you, pcm: data, hostTime: hostTime)
        processOutput()
    }

    private func checkReady() {
        guard !readyEmitted && systemAudioReady && microphoneReady else { return }

        // Emit ready frame
        let ready = ReadyPayload(
            type: "ready",
            sampleRateHz: 16_000,
            framesPerBlock: 320,
            encoding: "s16le",
            channelOrder: ["interviewer", "you"],
            firstBlock: 0
        )

        do {
            try writer.writeFrame(.ready(sequence: 0, payload: ready))
            readyEmitted = true
            state = .recording
        } catch {
            // Handle error
        }
    }

    // MARK: - Retry Logic

    /// Handle a source failure with retry
    private func handleSourceFailure(channel: SourceChannel, reason: SourceInterruptionReason) {
        guard state == .recording || state == .starting else { return }

        // Open interruption if none exists for this channel
        if openInterruptions[channel] == nil {
            openInterruption(channel: channel, reason: reason)
        }

        // Update health and emit state frame
        let health = channel == .interviewer ? healthSystem : healthMicrophone
        health.markReconnecting(effectiveBlock: currentBlock, reason: RecoverableReason(rawValue: reason.rawValue) ?? .streamError)
        emitStateFrame(channel: channel, status: .reconnecting, reason: reason.rawValue)

        // Stop the failing source
        if channel == .interviewer {
            systemAudio.stop()
            systemAudioReady = false
            systemRetrying = true
            systemRetryAttempt = 0
        } else {
            microphone.stop()
            microphoneReady = false
            microphoneRetrying = true
            microphoneRetryAttempt = 0
        }

        // Schedule first retry
        scheduleRetry(channel: channel)
    }

    private func emitStateFrame(channel: SourceChannel, status: StateStatus, reason: String? = nil, attempt: UInt32? = nil) {
        let statePayload = StatePayload(
            type: "state",
            channel: channel,
            status: status,
            effectiveBlock: currentBlock,
            reason: reason,
            silentBlocks: nil,
            attempt: attempt
        )
        do {
            try writer.writeFrame(.state(sequence: currentBlock, payload: statePayload))
        } catch {
            // Best effort
        }
    }

    private func scheduleRetry(channel: SourceChannel) {
        guard state == .recording || state == .starting else { return }

        let attempt: UInt32
        if channel == .interviewer {
            attempt = systemRetryAttempt
        } else {
            attempt = microphoneRetryAttempt
        }

        let delay: TimeInterval
        if Int(attempt) < fastRetryIntervals.count {
            delay = fastRetryIntervals[Int(attempt)]
        } else {
            delay = periodicRetryInterval
        }

        scheduler.schedule(delay: delay) { [weak self] in
            self?.attemptReconnect(channel: channel)
        }

        // Increment attempt
        if channel == .interviewer {
            systemRetryAttempt &+= 1
        } else {
            microphoneRetryAttempt &+= 1
        }
    }

    private func attemptReconnect(channel: SourceChannel) {
        guard state == .recording || state == .starting else { return }

        do {
            if channel == .interviewer {
                try systemAudio.start()
                lastSystemCallbackTime = hostClock.now()
            } else {
                try microphone.start()
                lastMicrophoneCallbackTime = hostClock.now()
            }
        } catch {
            // Source failed to start, schedule next retry
            scheduleRetry(channel: channel)
        }
    }

    /// Handle a route change for the microphone
    public func handleRouteChange() {
        guard state == .recording || state == .starting else { return }

        // Route change triggers immediate attempt without cancelling/resetting retry loop
        scheduler.schedule(delay: 0) { [weak self] in
            self?.attemptReconnect(channel: .you)
        }
    }

    // MARK: - Stall Detection

    private func startStallTimer() {
        stallTimerActive = true
        scheduleStallCheck()
    }

    private func scheduleStallCheck() {
        guard stallTimerActive else { return }

        // Check every second
        scheduler.schedule(delay: 1.0) { [weak self] in
            self?.checkForStall()
        }
    }

    private func checkForStall() {
        guard state == .recording || state == .starting else { return }
        guard stallTimerActive else { return }

        let now = hostClock.now()

        // Check system audio stall
        let systemElapsed = now &- lastSystemCallbackTime
        if systemElapsed >= callbackStallThresholdNs {
            if !systemRetrying {
                handleSourceFailure(channel: .interviewer, reason: .callbackStall)
            }
        }

        // Check microphone stall
        let micElapsed = now &- lastMicrophoneCallbackTime
        if micElapsed >= callbackStallThresholdNs {
            if !microphoneRetrying {
                handleSourceFailure(channel: .you, reason: .callbackStall)
            }
        }

        // Schedule next check
        scheduleStallCheck()
    }

    // MARK: - Output Processing

    private func processOutput() {
        while let output = mixer.tryEmit() {
            switch output {
            case .pcm(let left, let right, let blockIndex):
                let stereo = interleave(left: left, right: right)
                emitPCM(data: stereo, blockIndex: blockIndex)
            case .gap(let startBlock, let endBlock, _):
                emitGap(startBlock: startBlock, endBlock: endBlock)
            }
        }
    }

    private func drainMixer() {
        while let output = mixer.tryEmit() {
            switch output {
            case .pcm(let left, let right, _):
                let stereo = interleave(left: left, right: right)
                emitPCM(data: stereo, blockIndex: currentBlock)
            case .gap(let startBlock, let endBlock, _):
                emitGap(startBlock: startBlock, endBlock: endBlock)
            }
        }
        for remaining in mixer.stop() {
            if case .gap(let startBlock, let endBlock, _) = remaining {
                emitGap(startBlock: startBlock, endBlock: endBlock)
            }
        }
    }

    private func emitPCM(data: Data, blockIndex: UInt32) {
        guard currentBlock < maxBlocks else { return }

        do {
            try writer.writeFrame(.pcm(sequence: currentBlock, payload: data))
            currentBlock &+= 1
            pcmBlocks &+= 1
        } catch {
            // Handle error
        }
    }

    private func emitGap(startBlock: UInt32, endBlock: UInt32) {
        guard currentBlock < maxBlocks else { return }

        let gap = GapPayload(
            type: "gap",
            channel: "capture",
            startBlock: startBlock,
            endBlockExclusive: endBlock,
            reason: "buffer-overflow",
            recovered: true
        )

        do {
            try writer.writeFrame(.gap(sequence: currentBlock, payload: gap))
            gapBlocks &+= (endBlock - startBlock)
            currentBlock = endBlock
        } catch {
            // Handle error
        }
    }

    // MARK: - Interruption Management

    private func openInterruption(channel: SourceChannel, reason: SourceInterruptionReason) {
        guard openInterruptions[channel] == nil else { return }

        let id = interruptionIdCounter
        interruptionIdCounter &+= 1

        let interruption = InterruptionPayload(
            type: "interruption",
            phase: .opened,
            id: id,
            channel: channel,
            startBlock: currentBlock,
            endBlockExclusive: nil,
            reason: reason,
            recovered: nil
        )

        do {
            try writer.writeFrame(.interruption(sequence: currentBlock, payload: interruption))
            openInterruptions[channel] = interruption
        } catch {
            // Handle error
        }
    }

    private func closeInterruption(channel: SourceChannel, recovered: Bool) {
        guard let open = openInterruptions[channel] else { return }

        let closed = InterruptionPayload(
            type: "interruption",
            phase: .closed,
            id: open.id,
            channel: channel,
            startBlock: open.startBlock,
            endBlockExclusive: currentBlock,
            reason: open.reason,
            recovered: recovered
        )

        do {
            try writer.writeFrame(.interruption(sequence: currentBlock, payload: closed))
            openInterruptions.removeValue(forKey: channel)
        } catch {
            // Handle error
        }
    }

    // MARK: - Helpers

    private func interleave(left: Data, right: Data) -> Data {
        let sampleCount = min(left.count, right.count) / 2
        var stereo = Data(count: sampleCount * 4)

        for i in 0..<sampleCount {
            let leftSample = left.withUnsafeBytes { bytes in
                bytes.load(fromByteOffset: i * 2, as: Int16.self)
            }
            let rightSample = right.withUnsafeBytes { bytes in
                bytes.load(fromByteOffset: i * 2, as: Int16.self)
            }

            stereo.withUnsafeMutableBytes { bytes in
                bytes.storeBytes(of: leftSample, toByteOffset: i * 4, as: Int16.self)
                bytes.storeBytes(of: rightSample, toByteOffset: i * 4 + 2, as: Int16.self)
            }
        }

        return stereo
    }
}
