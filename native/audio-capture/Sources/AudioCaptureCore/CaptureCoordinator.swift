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
    private let lock = NSLock()

    public init() {}

    public func schedule(delay: TimeInterval, _ work: @escaping () -> Void) {
        let item = DispatchWorkItem(block: work)
        lock.lock()
        workItems.append(item)
        lock.unlock()
        DispatchQueue.global().asyncAfter(deadline: .now() + delay, execute: item)
    }

    public func cancelAll() {
        lock.lock()
        let items = workItems
        workItems.removeAll()
        lock.unlock()
        items.forEach { $0.cancel() }
    }
}

// MARK: - Capture Output Protocol

public protocol CaptureOutput {
    func writeFrame(_ frame: CaptureFrame) throws
}

extension CaptureProtocolWriter: CaptureOutput {}

// MARK: - Capture Coordinator

/// Threading: source callbacks, pacing/stall scheduler work, and stdin-driven
/// start/stop all arrive on different threads. Every entry point serializes on
/// `lock`, so mixer / scheduler state is never mutated concurrently and
/// protocol frames are written by one thread at a time. Frame writes under the
/// lock are non-blocking enqueues: the production writer sits on AsyncByteSink,
/// so a stalled pipe reader can never freeze the capture loop. Source
/// `start()`/`stop()` calls must run OUTSIDE the lock: SCStream start blocks on
/// a semaphore and AVAudioEngine stop can wait for the render thread, which may
/// itself be waiting for this lock — calling them under the lock can deadlock.
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

    /// Serializes all coordinator state and protocol output. Recursive because
    /// helpers like `handleSourceFailure` run both at entry points and from
    /// within already-locked sections.
    private let lock = NSRecursiveLock()

    private var state: CaptureState = .idle
    private var readyEmitted = false
    private var systemAudioReady = false
    private var microphoneReady = false
    private var currentBlock: UInt32 = 0
    private var pcmBlocks: UInt32 = 0
    private var gapBlocks: UInt32 = 0
    private var interruptionIdCounter: UInt32 = 1
    private var openInterruptions: [SourceChannel: InterruptionPayload] = [:]
    /// Root cause of an ongoing outage, set before any uncovered block has been
    /// emitted. The interruption opens lazily at the first uncovered block so
    /// covered blocks emitted late are never misclassified as a recovery, and
    /// the gap carries the failure reason instead of late-data.
    private var pendingFailureReason: [SourceChannel: SourceInterruptionReason] = [:]

    // Retry state
    private var systemRetryAttempt: UInt32 = 0
    private var microphoneRetryAttempt: UInt32 = 0
    private var systemRetrying = false
    private var microphoneRetrying = false

    // Restart verification state: a start() that returns without throwing is
    // only a success once the rebuilt source proves it with a real callback.
    /// Host time (ns) of the last successful restart per channel.
    private var restartCompletedAt: [SourceChannel: UInt64] = [:]
    /// Incremented on every successful restart; stale verify closures no-op.
    private var restartGeneration: [SourceChannel: UInt64] = [:]

    // Stall detection timestamps (in nanoseconds)
    private var lastSystemCallbackTime: UInt64 = 0
    private var lastMicrophoneCallbackTime: UInt64 = 0
    private var stallTimerActive = false

    // Fast retry intervals: 0.5s, 1s, 2s, then 10s periodic
    private let fastRetryIntervals: [TimeInterval] = [0.5, 1.0, 2.0]
    private let periodicRetryInterval: TimeInterval = 10.0
    private let callbackStallThresholdNs: UInt64 = 2_000_000_000 // 2 seconds
    /// Delay after a successful restart before verifying callbacks resumed.
    private let restartVerifyDelay: TimeInterval = 2.0

    // Route change callback storage
    private var routeChangeHandler: (() -> Void)?

    // Block emission pacing
    private var pacingActive = false
    private static let pacingIntervalSeconds: TimeInterval = 0.02
    /// Grace window before a stop finalizes: 200 ms jitter bound + one 20 ms
    /// block + 30 ms margin — the tail's last block passes its natural
    /// deadline inside this window, so in-flight packets still land.
    private static let stopGraceSeconds: TimeInterval = 0.25

    /// Invoked once, outside the lock, after the stopped frame has been
    /// enqueued and the `captureStopped` diagnostic emitted.
    public var onStopped: (() -> Void)?

    // Last health state emitted per channel, to emit state frames on transitions
    private var lastEmittedHealth: [SourceChannel: SourceHealthState] = [
        .interviewer: .connected,
        .you: .connected,
    ]

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
        self.mixer = TimelineMixer()
        self.writer = writer
        self.diagnostics = diagnostics
        self.scheduler = scheduler ?? SystemScheduler()
        self.healthSystem = SourceHealth(channel: .interviewer)
        self.healthMicrophone = SourceHealth(channel: .you)
    }

    // MARK: - Start

    /// Start the capture session. Called once from the main thread before any
    /// timer runs; source callbacks may already arrive once a source starts,
    /// so shared state and frame writes are taken under the lock.
    public func start() throws {
        lock.lock()
        state = .starting
        lock.unlock()

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
            lock.lock()
            state = .idle
            healthSystem.markDisconnected(effectiveBlock: currentBlock, reason: .streamError)
            try writer.writeFrame(.error(sequence: currentBlock, payload: ErrorPayload(
                type: "error",
                phase: .initialization,
                code: .sourceStartFailed,
                channel: .interviewer,
                terminal: true
            )))
            lock.unlock()
            try diagnostics.emit(level: .error, code: .sourceError)
            return
        }

        do {
            try microphone.start()
        } catch {
            systemAudio.stop()
            lock.lock()
            state = .idle
            healthMicrophone.markDisconnected(effectiveBlock: currentBlock, reason: .streamError)
            try writer.writeFrame(.error(sequence: currentBlock, payload: ErrorPayload(
                type: "error",
                phase: .initialization,
                code: .sourceStartFailed,
                channel: .you,
                terminal: true
            )))
            lock.unlock()
            try diagnostics.emit(level: .error, code: .sourceError)
            return
        }

        lock.lock()
        // Record initial callback times for stall detection
        let now = hostClock.now()
        lastSystemCallbackTime = now
        lastMicrophoneCallbackTime = now

        // Start stall detection timer
        startStallTimer()

        // Start deadline-paced block emission
        startPacingTimer()
        lock.unlock()

        try diagnostics.emit(level: .info, code: .captureStarted)
    }

    // MARK: - Stop

    /// Stop the capture session. Two-phase: a short grace window keeps
    /// deadline-paced emission alive so in-flight tail packets still land,
    /// then the scheduled `finalizeStop()` drains the mixer and emits the
    /// stopped frame. Stopping a second time, or stopping while idle, is a
    /// no-op (no stopped frame).
    public func stop() {
        lock.lock()
        guard state == .recording || state == .starting else {
            lock.unlock()
            return
        }
        state = .stopping

        // Cancel pending retries, stall checks, restart verifies, and pacing.
        scheduler.cancelAll()
        systemRetrying = false
        microphoneRetrying = false
        stallTimerActive = false

        // Re-arm emission for the grace window, then finalize once.
        pacingActive = true
        schedulePacingTick()
        scheduler.schedule(delay: Self.stopGraceSeconds) { [weak self] in
            self?.finalizeStop()
        }
        lock.unlock()

        emitDiagnostic(level: .info, code: .helperStopping)
    }

    /// Stdin EOF path: the parent is gone, so skip the tail grace window and
    /// finish the stop synchronously on the calling thread.
    public func stopImmediately() {
        lock.lock()
        switch state {
        case .idle:
            lock.unlock()
            return
        case .recording, .starting:
            state = .stopping
            scheduler.cancelAll()
            systemRetrying = false
            microphoneRetrying = false
            stallTimerActive = false
            lock.unlock()
        case .stopping:
            lock.unlock()
        }
        finalizeStop()
    }

    /// Final phase of every stop: claims finalization by flipping to idle
    /// (source callbacks and pacing ticks drop out via their state guards, and
    /// a late second finalize no-ops), stops the sources, drains the mixer,
    /// closes interruptions as unrecovered, and emits the stopped frame.
    private func finalizeStop() {
        lock.lock()
        guard state == .stopping else {
            lock.unlock()
            return
        }
        state = .idle
        pacingActive = false
        scheduler.cancelAll()
        lock.unlock()

        // Stop sources outside the lock: AVAudioEngine.stop may wait for the
        // render thread, which could itself be waiting for this lock.
        systemAudio.stop()
        microphone.stop()

        lock.lock()
        // Drain remaining blocks first: coverage closes interruptions as
        // recovered where the source delivered before stopping.
        for output in mixer.finalDrain() {
            emitBlock(output)
        }

        // Any interruption still open never recovered; per protocol, only
        // interruption/stopped frames may follow an unrecovered close.
        let channelsToClose = Array(openInterruptions.keys)
        for channel in channelsToClose {
            closeInterruption(channel: channel, recovered: false)
        }

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
        lock.unlock()

        emitDiagnostic(level: .info, code: .captureStopped)
        onStopped?()
    }

    /// Get current capture state
    public func getState() -> CaptureState {
        lock.lock()
        defer { lock.unlock() }
        return state
    }

    // MARK: - Audio Handling

    private func handleSystemAudio(data: Data, hostTime: UInt64) {
        lock.lock()
        guard state == .recording || state == .starting || state == .stopping else {
            lock.unlock()
            return
        }

        // Reset stall timer for this source
        lastSystemCallbackTime = hostClock.now()

        if !systemAudioReady {
            systemAudioReady = true
            // Close any reconnecting interruption on first callback after retry
            if systemRetrying {
                systemRetrying = false
                systemRetryAttempt = 0
                pendingFailureReason[.interviewer] = nil
                if openInterruptions[.interviewer] != nil {
                    closeInterruption(channel: .interviewer, recovered: true)
                }
                healthSystem.markConnected(effectiveBlock: currentBlock)
            }
            checkReady()
        }

        let result = mixer.feed(channel: .interviewer, pcm: data, hostTime: hostTime)
        var stopSource = false
        // A discontinuity inside the stop grace window is not worth a
        // rebuild: the tail drains as buffered and both sources stop at
        // finalization.
        if result == .timestampDiscontinuity, state != .stopping {
            stopSource = beginSourceFailure(channel: .interviewer, reason: .timestampDiscontinuity)
        }
        processOutput()
        lock.unlock()

        if stopSource {
            emitFailureDiagnostic(channel: .interviewer, reason: .timestampDiscontinuity)
            systemAudio.stop()
        }
    }

    private func handleMicrophone(data: Data, hostTime: UInt64) {
        lock.lock()
        guard state == .recording || state == .starting || state == .stopping else {
            lock.unlock()
            return
        }

        // Reset stall timer for this source
        lastMicrophoneCallbackTime = hostClock.now()

        if !microphoneReady {
            microphoneReady = true
            // Close any reconnecting interruption on first callback after retry
            if microphoneRetrying {
                microphoneRetrying = false
                microphoneRetryAttempt = 0
                pendingFailureReason[.you] = nil
                if openInterruptions[.you] != nil {
                    closeInterruption(channel: .you, recovered: true)
                }
                healthMicrophone.markConnected(effectiveBlock: currentBlock)
            }
            checkReady()
        }

        let result = mixer.feed(channel: .you, pcm: data, hostTime: hostTime)
        var stopSource = false
        // A discontinuity inside the stop grace window is not worth a
        // rebuild: the tail drains as buffered and both sources stop at
        // finalization.
        if result == .timestampDiscontinuity, state != .stopping {
            stopSource = beginSourceFailure(channel: .you, reason: .timestampDiscontinuity)
        }
        processOutput()
        lock.unlock()

        if stopSource {
            emitFailureDiagnostic(channel: .you, reason: .timestampDiscontinuity)
            microphone.stop()
        }
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
            // A stop during .starting can land the anchor inside the grace
            // window: ready must still precede any pcm, but the transition
            // out of .stopping is owned by finalizeStop alone.
            if state == .starting {
                state = .recording
            }
        } catch {
            // Handle error
        }
    }

    // MARK: - Retry Logic

    /// Entry point for source-failure notifications, which arrive on
    /// source-owned threads. Bookkeeping runs under the lock; diagnostics and
    /// the source stop run after unlocking.
    private func handleSourceFailure(channel: SourceChannel, reason: SourceInterruptionReason) {
        lock.lock()
        let shouldStop = beginSourceFailure(channel: channel, reason: reason)
        lock.unlock()

        guard shouldStop else { return }
        emitFailureDiagnostic(channel: channel, reason: reason)
        stopSource(channel)
    }

    /// Records a source failure and starts its retry chain. Requires the lock.
    /// Returns true when the caller must stop the source (outside the lock).
    /// A channel already being retried keeps its existing chain — route-change
    /// flapping must not multiply retries or re-stop a restarting source.
    private func beginSourceFailure(channel: SourceChannel, reason: SourceInterruptionReason) -> Bool {
        guard state == .recording || state == .starting else { return false }

        let retrying = channel == .interviewer ? systemRetrying : microphoneRetrying
        if retrying { return false }

        // The interruption opens lazily at the first uncovered block; blocks
        // already delivered by the source are still emitted as covered.
        pendingFailureReason[channel] = reason

        // Update health and emit state frame. The protocol requires a positive
        // attempt on reconnecting frames; a fresh failure announces attempt 1.
        let health = channel == .interviewer ? healthSystem : healthMicrophone
        health.markReconnecting(effectiveBlock: currentBlock, reason: RecoverableReason(rawValue: reason.rawValue) ?? .streamError)
        emitStateFrame(channel: channel, status: .reconnecting, reason: reason.rawValue, attempt: 1)
        lastEmittedHealth[channel] = .reconnecting

        // End the source's mixer generation: buffered data keeps draining into
        // its timestamped windows, and the rebuilt source's timestamps start a
        // fresh generation.
        if channel == .interviewer {
            systemAudioReady = false
            systemRetrying = true
            systemRetryAttempt = 0
        } else {
            microphoneReady = false
            microphoneRetrying = true
            microphoneRetryAttempt = 0
        }
        mixer.endGeneration(channel)

        // Schedule first retry
        scheduleRetry(channel: channel)
        return true
    }

    private func stopSource(_ channel: SourceChannel) {
        if channel == .interviewer {
            systemAudio.stop()
        } else {
            microphone.stop()
        }
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
        lock.lock()
        guard state == .recording || state == .starting else {
            lock.unlock()
            return
        }
        // scheduleRetry incremented the counter after scheduling, so by the
        // time this runs the counter IS this attempt's 1-based number.
        let attempt = channel == .interviewer ? systemRetryAttempt : microphoneRetryAttempt
        lock.unlock()

        emitDiagnostic(level: .info, code: .sourceRestartAttempt, details: [
            "channel": channel.rawValue,
            "attempt": String(attempt),
        ])

        // Source start runs outside the lock: SCStream start blocks on a
        // semaphore and must not stall pacing, callbacks, or stop.
        var startError: Error?
        do {
            if channel == .interviewer {
                try systemAudio.start()
            } else {
                try microphone.start()
            }
        } catch {
            startError = error
        }

        lock.lock()
        let stillActive = state == .recording || state == .starting
        if startError == nil, stillActive {
            // Do not reset the channel's last-callback timestamp here: the
            // verify below compares it against the restart time, and the stall
            // detector is already suppressed by the retrying latch.
            restartCompletedAt[channel] = hostClock.now()
            let generation = (restartGeneration[channel] ?? 0) &+ 1
            restartGeneration[channel] = generation
            lock.unlock()

            emitDiagnostic(level: .info, code: .sourceRestarted, details: [
                "channel": channel.rawValue,
                "attempt": String(attempt),
            ])

            // A start() that returns without throwing can still be a fake
            // success (wedged engine, dead stream): verify that a real
            // callback arrives within restartVerifyDelay.
            scheduler.schedule(delay: restartVerifyDelay) { [weak self] in
                self?.verifyRestart(channel: channel, generation: generation)
            }
        } else if startError == nil {
            // The session stopped while the source was starting; don't leak a
            // running source.
            lock.unlock()
            stopSource(channel)
        } else {
            // Source failed to start, schedule next retry
            scheduleRetry(channel: channel)
            lock.unlock()
            emitDiagnostic(level: .warn, code: .sourceRestartFailed, details: [
                "channel": channel.rawValue,
                "attempt": String(attempt),
                "error": startError.map { String(describing: $0) } ?? "unknown",
            ])
        }
    }

    /// Fires `restartVerifyDelay` after a successful restart. If the rebuilt
    /// source still has not delivered a single real callback, the restart was
    /// a fake success: fold the channel back into a fresh, properly bookkept
    /// failure cycle instead of leaving the retry chain stuck on the retrying
    /// latch. The generation counter makes verify closures from superseded
    /// restarts no-op.
    private func verifyRestart(channel: SourceChannel, generation: UInt64) {
        lock.lock()
        guard state == .recording || state == .starting else {
            lock.unlock()
            return
        }
        guard restartGeneration[channel] == generation,
              let restartedAt = restartCompletedAt[channel] else {
            lock.unlock()
            return
        }
        let retrying = channel == .interviewer ? systemRetrying : microphoneRetrying
        let lastCallback = channel == .interviewer ? lastSystemCallbackTime : lastMicrophoneCallbackTime
        // A real callback after the restart clears the retrying latch and
        // advances the timestamp; both checks together are the proof of life.
        guard retrying, lastCallback < restartedAt else {
            lock.unlock()
            return
        }

        restartCompletedAt[channel] = nil
        if channel == .interviewer {
            systemRetrying = false
        } else {
            microphoneRetrying = false
        }
        // With the retrying latch cleared, beginSourceFailure books a
        // brand-new cycle: fresh reconnecting state frame, attempt counter
        // reset, new fast retry.
        let shouldStop = beginSourceFailure(channel: channel, reason: .callbackStall)
        lock.unlock()

        emitDiagnostic(level: .warn, code: .sourceRestartUnverified, details: ["channel": channel.rawValue])
        if shouldStop {
            emitFailureDiagnostic(channel: channel, reason: .callbackStall)
            stopSource(channel)
        }
    }

    /// Handle a route change for the microphone
    public func handleRouteChange() {
        lock.lock()
        defer { lock.unlock() }
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
        lock.lock()
        guard state == .recording || state == .starting, stallTimerActive else {
            lock.unlock()
            return
        }

        let now = hostClock.now()
        var sourcesToStop: [SourceChannel] = []

        // Check system audio stall
        let systemElapsed = now &- lastSystemCallbackTime
        if systemElapsed >= callbackStallThresholdNs {
            if beginSourceFailure(channel: .interviewer, reason: .callbackStall) {
                sourcesToStop.append(.interviewer)
            }
        }

        // Check microphone stall
        let micElapsed = now &- lastMicrophoneCallbackTime
        if micElapsed >= callbackStallThresholdNs {
            if beginSourceFailure(channel: .you, reason: .callbackStall) {
                sourcesToStop.append(.you)
            }
        }

        // Schedule next check
        scheduleStallCheck()
        lock.unlock()

        for channel in sourcesToStop {
            emitFailureDiagnostic(channel: channel, reason: .callbackStall)
            stopSource(channel)
        }
    }

    // MARK: - Output Processing

    /// Deadline-gated emission: only blocks whose window end plus the jitter
    /// bound has passed are emitted, so in-window callback jitter never opens
    /// a gap. Called from source callbacks and the pacing timer, always under
    /// the lock. Emission stays alive through the stop grace window so
    /// in-flight tail data still lands.
    private func processOutput() {
        guard state == .recording || state == .starting || state == .stopping else { return }
        for output in mixer.emitDue(now: hostClock.now()) {
            emitBlock(output)
        }
    }

    /// Emits one block. Protocol ordering per block: interruption closes for
    /// channels that recovered, then interruption opens for newly uncovered
    /// channels, then the pcm frame.
    private func emitBlock(_ output: MixerOutput) {
        guard case .pcm(let left, let right, let index, let coverage) = output else { return }
        guard currentBlock < maxBlocks else { return }

        if coverage.interviewer.covered, openInterruptions[.interviewer] != nil {
            closeInterruption(channel: .interviewer, recovered: true)
            pendingFailureReason[.interviewer] = nil
        }
        if coverage.you.covered, openInterruptions[.you] != nil {
            closeInterruption(channel: .you, recovered: true)
            pendingFailureReason[.you] = nil
        }
        if !coverage.interviewer.covered, openInterruptions[.interviewer] == nil {
            let reason = pendingFailureReason[.interviewer] ?? coverage.interviewer.reason ?? .lateData
            openInterruption(channel: .interviewer, reason: reason)
        }
        if !coverage.you.covered, openInterruptions[.you] == nil {
            let reason = pendingFailureReason[.you] ?? coverage.you.reason ?? .lateData
            openInterruption(channel: .you, reason: reason)
        }

        let stereo = interleave(left: left, right: right)
        do {
            try writer.writeFrame(.pcm(sequence: currentBlock, payload: stereo))
            currentBlock &+= 1
            pcmBlocks &+= 1
        } catch {
            return
        }

        updateHealth(channel: .interviewer, coverage: coverage.interviewer, data: left, block: index)
        updateHealth(channel: .you, coverage: coverage.you, data: right, block: index)
    }

    private func updateHealth(channel: SourceChannel, coverage: ChannelCoverage, data: Data, block: UInt32) {
        let health = channel == .interviewer ? healthSystem : healthMicrophone
        let state = health.getState()
        if coverage.covered {
            health.update(pcmBlock: data, effectiveBlock: block)
        } else if state != .reconnecting && state != .disconnected {
            // A failure/reconnect path owns the visible state while it runs.
            health.markGap(effectiveBlock: block)
        }
        emitHealthStateIfNeeded(channel: channel, block: block, gapReason: coverage.reason)
    }

    private func emitHealthStateIfNeeded(channel: SourceChannel, block: UInt32, gapReason: SourceInterruptionReason?) {
        let health = channel == .interviewer ? healthSystem : healthMicrophone
        let current = health.getState()
        guard current != lastEmittedHealth[channel] else { return }
        lastEmittedHealth[channel] = current
        var payload = health.toStatePayload(effectiveBlock: block)
        if current == .connectedWithGap, let gapReason {
            payload = StatePayload(
                type: "state",
                channel: channel,
                status: .connectedWithGap,
                effectiveBlock: block,
                reason: gapReason.rawValue,
                silentBlocks: nil,
                attempt: nil
            )
        }
        do {
            try writer.writeFrame(.state(sequence: currentBlock, payload: payload))
        } catch {
            // Best effort
        }
    }

    // MARK: - Pacing

    private func startPacingTimer() {
        pacingActive = true
        schedulePacingTick()
    }

    private func schedulePacingTick() {
        guard pacingActive else { return }
        scheduler.schedule(delay: Self.pacingIntervalSeconds) { [weak self] in
            self?.pacingTick()
        }
    }

    private func pacingTick() {
        lock.lock()
        defer { lock.unlock() }
        guard pacingActive, state == .recording || state == .starting || state == .stopping else { return }
        processOutput()
        schedulePacingTick()
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

    /// Diagnostics are always emitted outside the coordinator lock; the sink
    /// is asynchronous in production, but the discipline keeps the lock free
    /// of I/O either way.
    private func emitDiagnostic(level: DiagnosticLevel, code: DiagnosticCode, details: [String: String] = [:]) {
        try? diagnostics.emit(level: level, code: code, details: details)
    }

    private func emitFailureDiagnostic(channel: SourceChannel, reason: SourceInterruptionReason) {
        emitDiagnostic(level: .warn, code: .sourceFailure, details: [
            "channel": channel.rawValue,
            "reason": reason.rawValue,
        ])
    }

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
