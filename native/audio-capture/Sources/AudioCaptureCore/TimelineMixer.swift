import Foundation

// MARK: - Coverage

/// Per-channel coverage of one emitted block. An uncovered block is zero-filled
/// and carries the reason assigned at emission time; classification is final.
public struct ChannelCoverage: Sendable, Equatable {
    public let covered: Bool
    public let reason: SourceInterruptionReason?
}

public struct BlockCoverage: Sendable, Equatable {
    public let interviewer: ChannelCoverage
    public let you: ChannelCoverage
}

// MARK: - Mixer Output

public enum MixerOutput: Sendable {
    case pcm(left: Data, right: Data, blockIndex: UInt32, coverage: BlockCoverage)
}

// MARK: - Feed Result

public enum FeedResult: Sendable, Equatable {
    case accepted
    /// The chunk's time span was already emitted; late data is dropped without
    /// reclassifying what was persisted.
    case discardedLate
    /// The chunk's timestamp regressed or jumped beyond the 200 ms jitter bound
    /// within one generation. The source must be rebuilt.
    case timestampDiscontinuity
}

// MARK: - Timeline Mixer

/// Places both sources onto a shared host-clock sequence of 20 ms blocks.
/// Emission is deadline-paced: block N is emitted only once its window end plus
/// the 200 ms jitter bound has passed, so in-window delivery jitter never
/// becomes a gap. Uncovered frames are zero-filled per channel and reported via
/// coverage; late data is discarded.
public class TimelineMixer {
    static let framesPerBlock = 320
    static let blockDurationNs: UInt64 = 20_000_000
    static let jitterBufferNs: UInt64 = 200_000_000
    private static let frameDurationNs: Double = 62_500 // 1 s / 16_000
    /// 200 ms of frames at 16 kHz: the timestamp discontinuity bound.
    static let discontinuityFrames: Int64 = 3_200
    /// 5 ms of frames: timestamp noise snapped onto the contiguous timeline.
    static let snapToleranceFrames: Int64 = 80
    /// 2 s per channel: bound on buffered data awaiting emission.
    static let maxBufferedFrames: Int = 32_000

    private struct TimedChunk {
        var startFrame: Int64
        var data: Data
        var frames: Int64 { Int64(data.count / 2) }
        var endFrame: Int64 { startFrame + frames }
    }

    private struct RawChunk {
        var startNs: UInt64
        var data: Data
    }

    private struct ChannelState {
        var started = false
        var firstStartNs: UInt64 = 0
        /// Pre-anchor chunks in nanosecond space; converted to frame space once
        /// the anchor exists. Frame positions are always derived from the
        /// original nanosecond timestamps in a single rounding step.
        var rawChunks: [RawChunk] = []
        /// Buffered chunks in timeline frame space, ordered and contiguous per
        /// generation. Only whole unconsumed chunks are retained; consumption
        /// advances the first chunk's start.
        var chunks: [TimedChunk] = []
        /// Expected start frame of the next chunk within the current generation;
        /// nil while no chunk of this generation has been accepted.
        var expectedStartFrame: Int64?
        /// Nanosecond expectation used only before the anchor exists.
        var expectedStartNs: UInt64?
    }

    private var interviewer = ChannelState()
    private var you = ChannelState()
    private var anchorNs: UInt64?
    private var currentBlock: UInt32 = 0
    private let blockLimit: UInt32

    public init() {
        self.blockLimit = maxBlocks
    }

    init(blockLimit: UInt32) {
        self.blockLimit = blockLimit
    }

    // MARK: - Feed

    @discardableResult
    public func feed(channel: SourceChannel, pcm: Data, hostTime: UInt64) -> FeedResult {
        let result = withChannel(channel) { state in
            var data = pcm
            // Re-base slices: Data dropped from either end shares the original
            // buffer, and every Data stored in a chunk must be zero-based.
            if data.count % 2 != 0 { data = Data(data.dropLast()) }

            if !state.started {
                state.started = true
                state.firstStartNs = hostTime
            }

            if let anchor = anchorNs {
                return feedAnchored(&state, data: data, hostTime: hostTime, anchor: anchor)
            }
            return feedPreAnchor(&state, data: data, hostTime: hostTime)
        }
        trySetAnchor()
        return result
    }

    private func feedAnchored(
        _ state: inout ChannelState,
        data: Data,
        hostTime: UInt64,
        anchor: UInt64
    ) -> FeedResult {
        var startFrame = frameIndex(hostTime, anchor: anchor)
        let frames = Int64(data.count / 2)
        let frontier = Int64(currentBlock) * Int64(Self.framesPerBlock)

        // Late data: its window (or part of it) was already emitted.
        if startFrame + frames <= frontier { return .discardedLate }
        var data = data
        if startFrame < frontier {
            let trim = frontier - startFrame
            data = Data(data.dropFirst(Int(trim) * 2))
            startFrame = frontier
            if data.isEmpty { return .discardedLate }
            // The trimmed chunk continues the timeline only if nothing is
            // buffered ahead of the frontier; otherwise it collides with
            // already-buffered data and its timestamps cannot be trusted.
            if let expected = state.expectedStartFrame, expected != frontier {
                return startFrame + Int64(data.count / 2) > expected
                    ? .timestampDiscontinuity
                    : .discardedLate
            }
        }

        if let expected = state.expectedStartFrame {
            let diff = startFrame - expected
            if diff > Self.discontinuityFrames { return .timestampDiscontinuity }
            if diff < -Self.snapToleranceFrames { return .timestampDiscontinuity }
            if diff <= 0 {
                let trim = min(-diff, Int64(data.count / 2))
                data = Data(data.dropFirst(Int(trim) * 2))
                if data.isEmpty { return .accepted }
            }
            // Within the snap tolerance the chunk is pulled onto the contiguous
            // timeline; a larger forward jump is a real, provable hole.
            if diff <= Self.snapToleranceFrames {
                startFrame = expected
            }
        }

        state.chunks.append(TimedChunk(startFrame: startFrame, data: data))
        state.expectedStartFrame = startFrame + Int64(data.count / 2)
        enforceBufferCap(&state)
        return .accepted
    }

    private func feedPreAnchor(_ state: inout ChannelState, data: Data, hostTime: UInt64) -> FeedResult {
        guard !data.isEmpty else { return .accepted }
        var startNs = hostTime
        var data = data
        if let expectedNs = state.expectedStartNs {
            let diff = Int64(startNs) - Int64(expectedNs)
            if diff > Int64(Self.jitterBufferNs) { return .timestampDiscontinuity }
            if diff < -5_000_000 { return .timestampDiscontinuity }
            if diff <= 0 {
                let trimFrames = min((-diff) / 62_500, Int64(data.count / 2))
                data = Data(data.dropFirst(Int(trimFrames) * 2))
                if data.isEmpty { return .accepted }
            }
            if diff <= 5_000_000 {
                startNs = expectedNs
            }
        }
        state.rawChunks.append(RawChunk(startNs: startNs, data: data))
        state.expectedStartNs = startNs + UInt64(data.count / 2) * 62_500
        return .accepted
    }

    /// Ends the current generation: buffered data keeps draining into its
    /// timestamped windows, but the next chunk starts a fresh generation whose
    /// timestamps are evaluated on their own.
    public func endGeneration(_ channel: SourceChannel) {
        withChannel(channel) { state in
            state.expectedStartFrame = nil
            state.expectedStartNs = nil
        }
    }

    /// Drops all buffered data and restarts the channel. Used when the source
    /// is rebuilt before the anchor exists.
    public func resetChannel(_ channel: SourceChannel) {
        withChannel(channel) { $0 = ChannelState() }
    }

    // MARK: - Anchoring

    private func trySetAnchor() {
        guard anchorNs == nil, interviewer.started, you.started else { return }
        let later = max(interviewer.firstStartNs, you.firstStartNs)
        // Recording time zero: the first 20 ms host-time boundary at or after
        // the later of the two first timestamps.
        let anchor = ((later + Self.blockDurationNs - 1) / Self.blockDurationNs) * Self.blockDurationNs
        anchorNs = anchor
        // Convert pre-anchor nanosecond placements into frame space.
        convertToFrameSpace(&interviewer, anchor: anchor)
        convertToFrameSpace(&you, anchor: anchor)
    }

    private func convertToFrameSpace(_ state: inout ChannelState, anchor: UInt64) {
        guard state.started else { return }
        var converted: [TimedChunk] = []
        var expected: Int64?
        for raw in state.rawChunks {
            var startFrame = frameIndex(raw.startNs, anchor: anchor)
            var data = raw.data
            if let exp = expected {
                let diff = startFrame - exp
                if diff <= 0 {
                    let trim = min(-diff, Int64(data.count / 2))
                    data = Data(data.dropFirst(Int(trim) * 2))
                    startFrame = exp
                } else if diff <= Self.snapToleranceFrames {
                    startFrame = exp
                }
            }
            if data.isEmpty { continue }
            converted.append(TimedChunk(startFrame: startFrame, data: data))
            expected = startFrame + Int64(data.count / 2)
        }
        state.chunks = converted
        state.rawChunks = []
        state.expectedStartFrame = expected
        state.expectedStartNs = nil
    }

    // MARK: - Emission

    /// Emits every block whose jitter deadline has passed.
    public func emitDue(now: UInt64) -> [MixerOutput] {
        guard let anchor = anchorNs else { return [] }
        var outputs: [MixerOutput] = []
        while currentBlock < blockLimit {
            let windowEndNs = anchor + UInt64(currentBlock + 1) * Self.blockDurationNs
            guard now >= windowEndNs + Self.jitterBufferNs else { break }
            outputs.append(materializeBlock())
        }
        return outputs
    }

    /// Stop path: emits every remaining block that still holds source data.
    /// The final block's uncovered tail on a channel whose data ends inside
    /// that block is not a loss — the recording was stopped there.
    public func finalDrain() -> [MixerOutput] {
        guard anchorNs != nil else { return [] }
        var outputs: [MixerOutput] = []
        var lastCoveredFrames: (interviewer: Int, you: Int) = (0, 0)
        while currentBlock < blockLimit {
            let blockStart = Int64(currentBlock) * Int64(Self.framesPerBlock)
            guard hasData(&interviewer, blockStart: blockStart) || hasData(&you, blockStart: blockStart)
            else { break }
            let (block, coveredFrames) = materializeBlockWithCounts()
            lastCoveredFrames = coveredFrames
            outputs.append(block)
        }
        if let last = outputs.last,
           case .pcm(let left, let right, let index, let coverage) = last {
            var fixed = coverage
            if !coverage.interviewer.covered && lastCoveredFrames.interviewer > 0 {
                fixed = BlockCoverage(
                    interviewer: ChannelCoverage(covered: true, reason: nil),
                    you: fixed.you
                )
            }
            if !coverage.you.covered && lastCoveredFrames.you > 0 {
                fixed = BlockCoverage(
                    interviewer: fixed.interviewer,
                    you: ChannelCoverage(covered: true, reason: nil)
                )
            }
            outputs[outputs.count - 1] = .pcm(left: left, right: right, blockIndex: index, coverage: fixed)
        }
        return outputs
    }

    private func hasData(_ state: inout ChannelState, blockStart: Int64) -> Bool {
        let windowEnd = blockStart + Int64(Self.framesPerBlock)
        while let first = state.chunks.first, first.endFrame <= blockStart {
            state.chunks.removeFirst()
        }
        guard let first = state.chunks.first else { return false }
        return first.startFrame < windowEnd
    }

    private func materializeBlock() -> MixerOutput {
        materializeBlockWithCounts().0
    }

    private func materializeBlockWithCounts() -> (MixerOutput, (interviewer: Int, you: Int)) {
        let blockStart = Int64(currentBlock) * Int64(Self.framesPerBlock)
        let (left, leftCoverage, leftCount) = materializeChannel(&interviewer, blockStart: blockStart)
        let (right, rightCoverage, rightCount) = materializeChannel(&you, blockStart: blockStart)
        let index = currentBlock
        currentBlock &+= 1
        return (
            .pcm(
                left: left,
                right: right,
                blockIndex: index,
                coverage: BlockCoverage(interviewer: leftCoverage, you: rightCoverage)
            ),
            (leftCount, rightCount)
        )
    }

    private func materializeChannel(
        _ state: inout ChannelState,
        blockStart: Int64
    ) -> (Data, ChannelCoverage, Int) {
        let windowEnd = blockStart + Int64(Self.framesPerBlock)
        while let first = state.chunks.first, first.endFrame <= blockStart {
            state.chunks.removeFirst()
        }

        var block = Data(count: Self.framesPerBlock * 2)
        var coveredFrames = 0
        var cursor = blockStart
        while cursor < windowEnd,
              let chunk = state.chunks.first,
              chunk.startFrame < windowEnd,
              chunk.startFrame <= cursor {
            let copyEnd = min(chunk.endFrame, windowEnd)
            let count = Int(copyEnd - cursor)
            let srcByteOffset = Int(cursor - chunk.startFrame) * 2
            let dstByteOffset = Int(cursor - blockStart) * 2
            block.replaceSubrange(
                dstByteOffset..<(dstByteOffset + count * 2),
                with: chunk.data[srcByteOffset..<(srcByteOffset + count * 2)]
            )
            coveredFrames += count
            cursor = copyEnd
            if copyEnd == chunk.endFrame {
                state.chunks.removeFirst()
            } else {
                // Data slices share the original buffer with a nonzero
                // startIndex; re-base so later subscripts stay valid.
                state.chunks[0].startFrame = copyEnd
                state.chunks[0].data = Data(chunk.data.dropFirst(Int(copyEnd - chunk.startFrame) * 2))
            }
        }

        if coveredFrames == Self.framesPerBlock {
            return (block, ChannelCoverage(covered: true, reason: nil), coveredFrames)
        }
        // A remaining chunk proves the hole by its own timestamp (source-gap);
        // nothing buffered means the deadline expired with data possibly still
        // in flight (late-data).
        let reason: SourceInterruptionReason = state.chunks.isEmpty ? .lateData : .sourceGap
        return (block, ChannelCoverage(covered: false, reason: reason), coveredFrames)
    }

    // MARK: - Accessors

    public func getCurrentBlock() -> UInt32 { currentBlock }

    // MARK: - Helpers

    private func withChannel<T>(_ channel: SourceChannel, _ body: (inout ChannelState) -> T) -> T {
        switch channel {
        case .interviewer: return body(&interviewer)
        case .you: return body(&you)
        }
    }

    private func frameIndex(_ hostTime: UInt64, anchor: UInt64) -> Int64 {
        Int64((Double(Int64(hostTime) - Int64(anchor)) / Self.frameDurationNs).rounded())
    }

    private func enforceBufferCap(_ state: inout ChannelState) {
        var buffered = state.chunks.reduce(0) { $0 + Int($1.frames) }
        while buffered > Self.maxBufferedFrames, let last = state.chunks.last {
            state.chunks.removeLast()
            buffered -= Int(last.frames)
        }
        state.expectedStartFrame = state.chunks.last?.endFrame
    }
}
