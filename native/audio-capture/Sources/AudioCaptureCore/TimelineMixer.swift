import Foundation

// MARK: - Mixer Output

public enum MixerOutput: Sendable {
    case pcm(left: Data, right: Data, blockIndex: UInt32)
    case gap(startBlock: UInt32, endBlockExclusive: UInt32, reason: GapReason)
}

// MARK: - Open Interruption Record

struct OpenInterruption {
    let id: UInt32
    let channel: SourceChannel
    let startBlock: UInt32
    let reason: SourceInterruptionReason
}

// MARK: - Timeline Mixer

public class TimelineMixer {
    private let hostClock: HostClock

    static let sampleRate: UInt64 = 16_000
    static let framesPerBlock: Int = 320
    static let bytesPerBlock: Int = 640
    static let blockDurationNs: UInt64 = 20_000_000
    static let jitterBufferNs: UInt64 = 200_000_000
    static let discontinuityThresholdNs: UInt64 = 200_000_000

    private struct SourceState {
        var started: Bool = false
        var startTime: UInt64 = 0
        var buffer: Data = Data()
        var lastHostTime: UInt64 = 0
    }

    private var interviewerState = SourceState()
    private var youState = SourceState()
    private var anchorTime: UInt64? = nil
    private var anchorSet: Bool = false
    private var currentBlock: UInt32 = 0
    private var pcmBlockCount: UInt32 = 0
    private var gapBlockCount: UInt32 = 0
    private let interviewerHealth: SourceHealth
    private let youHealth: SourceHealth
    private var openInterruptions: [SourceChannel: OpenInterruption] = [:]
    private var nextInterruptionId: UInt32 = 1
    private var pendingGapStart: UInt32? = nil
    private var pendingGapReason: GapReason? = nil

    public init(hostClock: HostClock) {
        self.hostClock = hostClock
        self.interviewerHealth = SourceHealth(channel: .interviewer)
        self.youHealth = SourceHealth(channel: .you)
    }

    // MARK: - Feed

    public func feed(channel: SourceChannel, pcm: Data, hostTime: UInt64) {
        switch channel {
        case .interviewer:
            feedInterviewer(pcm: pcm, hostTime: hostTime)
        case .you:
            feedYou(pcm: pcm, hostTime: hostTime)
        }
    }

    private func feedInterviewer(pcm: Data, hostTime: UInt64) {
        if interviewerState.started && hostTime < interviewerState.lastHostTime {
            openInterruptionIfNeeded(channel: .interviewer, reason: .timestampDiscontinuity)
            return
        }
        if interviewerState.started {
            let elapsed = hostTime &- interviewerState.lastHostTime
            if elapsed > Self.discontinuityThresholdNs {
                openInterruptionIfNeeded(channel: .interviewer, reason: .timestampDiscontinuity)
            }
        }
        if !interviewerState.started {
            interviewerState.started = true
            interviewerState.startTime = hostTime
        }
        interviewerState.buffer.append(pcm)
        interviewerState.lastHostTime = hostTime
        trySetAnchor()
    }

    private func feedYou(pcm: Data, hostTime: UInt64) {
        if youState.started && hostTime < youState.lastHostTime {
            openInterruptionIfNeeded(channel: .you, reason: .timestampDiscontinuity)
            return
        }
        if youState.started {
            let elapsed = hostTime &- youState.lastHostTime
            if elapsed > Self.discontinuityThresholdNs {
                openInterruptionIfNeeded(channel: .you, reason: .timestampDiscontinuity)
            }
        }
        if !youState.started {
            youState.started = true
            youState.startTime = hostTime
        }
        youState.buffer.append(pcm)
        youState.lastHostTime = hostTime
        trySetAnchor()
    }

    private func trySetAnchor() {
        guard !anchorSet, interviewerState.started, youState.started else { return }
        anchorTime = max(interviewerState.startTime, youState.startTime)
        anchorSet = true
        trimOverlap()
    }

    private func trimOverlap() {
        guard let anchor = anchorTime else { return }
        trimSourceToAnchor(interviewerState.startTime, channel: .interviewer, anchor: anchor)
        trimSourceToAnchor(youState.startTime, channel: .you, anchor: anchor)
    }

    private func trimSourceToAnchor(_ startTime: UInt64, channel: SourceChannel, anchor: UInt64) {
        guard startTime < anchor else { return }
        let discardNs = anchor &- startTime
        let discardSamples = Int(discardNs * Self.sampleRate / 1_000_000_000)
        let discardBytes = discardSamples * 2
        switch channel {
        case .interviewer:
            if discardBytes <= interviewerState.buffer.count {
                interviewerState.buffer = Data(interviewerState.buffer.dropFirst(discardBytes))
            } else {
                interviewerState.buffer = Data()
            }
        case .you:
            if discardBytes <= youState.buffer.count {
                youState.buffer = Data(youState.buffer.dropFirst(discardBytes))
            } else {
                youState.buffer = Data()
            }
        }
    }

    // MARK: - Emit

    public func tryEmit() -> MixerOutput? {
        guard anchorSet else { return nil }
        guard currentBlock < maxBlocks else { return nil }

        let leftAvailable = interviewerState.buffer.count >= Self.bytesPerBlock
        let rightAvailable = youState.buffer.count >= Self.bytesPerBlock

        if leftAvailable && rightAvailable {
            return emitPCM()
        } else {
            return emitGapOrWait(leftAvailable: leftAvailable, rightAvailable: rightAvailable)
        }
    }

    public func tryEmitPCM() -> (left: Data, right: Data, blockIndex: UInt32)? {
        switch tryEmit() {
        case .pcm(let l, let r, let idx):
            return (l, r, idx)
        case .gap, .none:
            return nil
        }
    }

    private func emitPCM() -> MixerOutput {
        if let gap = flushPendingGap() {
            return gap
        }

        let leftBlock = Data(interviewerState.buffer.prefix(Self.bytesPerBlock))
        let rightBlock = Data(youState.buffer.prefix(Self.bytesPerBlock))
        interviewerState.buffer = Data(interviewerState.buffer.dropFirst(Self.bytesPerBlock))
        youState.buffer = Data(youState.buffer.dropFirst(Self.bytesPerBlock))

        closeInterruptionIfOpen(channel: .interviewer, recovered: true)
        closeInterruptionIfOpen(channel: .you, recovered: true)

        interviewerHealth.update(pcmBlock: leftBlock, effectiveBlock: currentBlock)
        youHealth.update(pcmBlock: rightBlock, effectiveBlock: currentBlock)

        let blockIndex = currentBlock
        currentBlock &+= 1
        pcmBlockCount &+= 1

        return .pcm(left: leftBlock, right: rightBlock, blockIndex: blockIndex)
    }

    private func emitGapOrWait(leftAvailable: Bool, rightAvailable: Bool) -> MixerOutput? {
        let reason = classifyGapReason(leftAvailable: leftAvailable, rightAvailable: rightAvailable)

        if !leftAvailable {
            interviewerHealth.markGap(effectiveBlock: currentBlock)
        }
        if !rightAvailable {
            youHealth.markGap(effectiveBlock: currentBlock)
        }

        if !leftAvailable {
            openInterruptionIfNeeded(channel: .interviewer, reason: mapGapToInterruptionReason(reason))
        }
        if !rightAvailable {
            openInterruptionIfNeeded(channel: .you, reason: mapGapToInterruptionReason(reason))
        }

        if pendingGapStart == nil {
            pendingGapStart = currentBlock
            pendingGapReason = reason
        }

        let gapLength = currentBlock &- pendingGapStart!
        if gapLength >= 3_000 {
            let gap = flushPendingGap()
            currentBlock &+= 1
            gapBlockCount &+= 1
            return gap
        }

        currentBlock &+= 1
        gapBlockCount &+= 1
        return nil
    }

    private func classifyGapReason(leftAvailable: Bool, rightAvailable: Bool) -> GapReason {
        let leftLate = interviewerState.started && !leftAvailable && interviewerState.lastHostTime > 0
        let rightLate = youState.started && !rightAvailable && youState.lastHostTime > 0
        if leftLate || rightLate {
            return .lateData
        }
        return .sourceGap
    }

    private func mapGapToInterruptionReason(_ gapReason: GapReason) -> SourceInterruptionReason {
        switch gapReason {
        case .sourceGap: return .sourceGap
        case .lateData: return .lateData
        case .streamError: return .streamError
        case .callbackStall: return .callbackStall
        case .routeInvalidated: return .routeInvalidated
        case .timestampInvalid: return .timestampInvalid
        case .timestampDiscontinuity: return .timestampDiscontinuity
        }
    }

    @discardableResult
    private func flushPendingGap() -> MixerOutput? {
        guard let start = pendingGapStart, let reason = pendingGapReason else { return nil }
        let end = currentBlock
        guard end > start else {
            pendingGapStart = nil
            pendingGapReason = nil
            return nil
        }
        pendingGapStart = nil
        pendingGapReason = nil
        return .gap(startBlock: start, endBlockExclusive: end, reason: reason)
    }

    // MARK: - Interruption Management

    private func openInterruptionIfNeeded(channel: SourceChannel, reason: SourceInterruptionReason) {
        guard openInterruptions[channel] == nil else { return }
        let id = nextInterruptionId
        nextInterruptionId &+= 1
        openInterruptions[channel] = OpenInterruption(
            id: id, channel: channel, startBlock: currentBlock, reason: reason
        )
    }

    private func closeInterruptionIfOpen(channel: SourceChannel, recovered: Bool) {
        guard openInterruptions[channel] != nil else { return }
        openInterruptions.removeValue(forKey: channel)
    }

    public func closeAllInterruptionsUnrecovered() {
        openInterruptions.removeAll()
    }

    // MARK: - Stop / Drain

    public func stop() -> [MixerOutput] {
        var outputs: [MixerOutput] = []
        if let gap = flushPendingGap() {
            outputs.append(gap)
        }
        closeAllInterruptionsUnrecovered()
        return outputs
    }

    // MARK: - Accessors

    public func getCurrentBlock() -> UInt32 { return currentBlock }
    public func getPCMBlockCount() -> UInt32 { return pcmBlockCount }
    public func getGapBlockCount() -> UInt32 { return gapBlockCount }
    public func getInterviewerHealth() -> SourceHealth { return interviewerHealth }
    public func getYouHealth() -> SourceHealth { return youHealth }

    public func hasOpenInterruption(channel: SourceChannel) -> Bool {
        return openInterruptions[channel] != nil
    }

    public func getOpenInterruptionId(channel: SourceChannel) -> UInt32? {
        return openInterruptions[channel]?.id
    }

    public func getOpenInterruptionReason(channel: SourceChannel) -> SourceInterruptionReason? {
        return openInterruptions[channel]?.reason
    }

    public func reset() {
        interviewerState = SourceState()
        youState = SourceState()
        anchorTime = nil
        anchorSet = false
        currentBlock = 0
        pcmBlockCount = 0
        gapBlockCount = 0
        openInterruptions.removeAll()
        nextInterruptionId = 1
        pendingGapStart = nil
        pendingGapReason = nil
    }
}
