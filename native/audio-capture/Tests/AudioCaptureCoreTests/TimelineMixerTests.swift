import XCTest
@testable import AudioCaptureCore

// MARK: - Shared helpers

private let blockBytes = 640
private let framesPerBlock = 320
private let blockNs: UInt64 = 20_000_000
private let jitterNs: UInt64 = 200_000_000
private let frameNs: UInt64 = 62_500 // 1_000_000_000 / 16_000

/// Mono s16le PCM whose sample values encode the global frame index,
/// so tests can verify exact sample placement after windowing.
private func counterData(startFrame: Int, frames: Int) -> Data {
    var data = Data(count: frames * 2)
    data.withUnsafeMutableBytes { raw in
        let samples = raw.bindMemory(to: Int16.self)
        for i in 0..<frames {
            samples[i] = Int16(truncatingIfNeeded: startFrame + i)
        }
    }
    return data
}

private func sampleValue(_ data: Data, frame: Int) -> Int16 {
    data.withUnsafeBytes { raw in
        raw.bindMemory(to: Int16.self)[frame]
    }
}

private struct PcmOutput {
    let left: Data
    let right: Data
    let blockIndex: UInt32
    let coverage: BlockCoverage
}

private func pcms(_ outputs: [MixerOutput]) -> [PcmOutput] {
    outputs.compactMap { output in
        if case .pcm(let l, let r, let idx, let coverage) = output {
            return PcmOutput(left: l, right: r, blockIndex: idx, coverage: coverage)
        }
        return nil
    }
}

// MARK: - TimelineMixer: anchoring and deadline gating

final class TimelineMixerAlignmentTests: XCTestCase {

    /// Anchor is the first 20 ms host-time boundary at or after the later start;
    /// samples before the anchor on the earlier channel are trimmed.
    func testAnchorUsesFirstBoundaryAtOrAfterLaterStart() {
        let mixer = TimelineMixer()

        // System audio starts at 100 ms; microphone audio starts at 203 ms -> anchor = 220 ms.
        mixer.feed(channel: .interviewer, pcm: counterData(startFrame: 0, frames: 6400), hostTime: 100_000_000)
        mixer.feed(channel: .you, pcm: counterData(startFrame: 0, frames: 6400), hostTime: 203_000_000)

        let anchor: UInt64 = 220_000_000
        let now = anchor + 10 * blockNs + jitterNs
        let outputs = pcms(mixer.emitDue(now: now))

        XCTAssertEqual(outputs.count, 10)
        XCTAssertEqual(outputs.map(\.blockIndex), Array(0..<10))
        for output in outputs {
            XCTAssertTrue(output.coverage.interviewer.covered)
            XCTAssertTrue(output.coverage.you.covered)
        }
        // Block 0 covers [220 ms, 240 ms): system sample = frame 1920, mic sample = frame 272.
        XCTAssertEqual(sampleValue(outputs[0].left, frame: 0), 1920)
        XCTAssertEqual(sampleValue(outputs[0].right, frame: 0), 272)
    }

    /// A block is emitted only once its window end plus the 200 ms jitter
    /// deadline has passed; undelivered-but-in-window data must not open a gap.
    func testEmissionIsDeadlineGated() {
        let mixer = TimelineMixer()
        let t: UInt64 = 200_000_000
        mixer.feed(channel: .interviewer, pcm: counterData(startFrame: 0, frames: 3200), hostTime: t)
        mixer.feed(channel: .you, pcm: counterData(startFrame: 0, frames: 3200), hostTime: t)

        XCTAssertTrue(mixer.emitDue(now: t + 219_999_999).isEmpty)

        let first = pcms(mixer.emitDue(now: t + 220_000_000))
        XCTAssertEqual(first.map(\.blockIndex), [0])

        let second = pcms(mixer.emitDue(now: t + 240_000_000))
        XCTAssertEqual(second.map(\.blockIndex), [1])
    }
}

// MARK: - TimelineMixer: jitter tolerance (production regression)

final class TimelineMixerJitterTests: XCTestCase {

    /// Reproduces the 2026-08-18 production failure cadence: microphone delivers
    /// ~21.3 ms chunks, system audio delivers 200 ms bursts. Normal callback
    /// jitter must produce zero uncovered blocks.
    func testBurstyMisalignedDeliveryProducesNoGaps() {
        let mixer = TimelineMixer()
        let anchor: UInt64 = 1_000_000_000

        // Build chunk schedules: (deliveryNs, channel, data, chunkStartNs).
        struct Chunk { let deliveryNs: UInt64; let channel: SourceChannel; let data: Data; let startNs: UInt64 }
        var schedule: [Chunk] = []

        // Microphone: alternating 341/342-frame chunks (48 kHz tap -> 16 kHz converter).
        var micFrame = 0
        var micPattern = [341, 342]
        var micIndex = 0
        while micFrame < 170_000 {
            let frames = micPattern[micIndex % 2]
            let startNs = anchor + UInt64(micFrame) * frameNs
            schedule.append(Chunk(
                deliveryNs: startNs + UInt64(frames) * frameNs,
                channel: .you,
                data: counterData(startFrame: micFrame, frames: frames),
                startNs: startNs
            ))
            micFrame += frames
            micIndex += 1
        }

        // System audio: 200 ms bursts delivered 3 ms after the burst ends.
        var sysFrame = 0
        while sysFrame < 170_000 {
            let startNs = anchor + UInt64(sysFrame) * frameNs
            schedule.append(Chunk(
                deliveryNs: startNs + UInt64(3200) * frameNs + 3_000_000,
                channel: .interviewer,
                data: counterData(startFrame: sysFrame, frames: 3200),
                startNs: startNs
            ))
            sysFrame += 3200
        }
        schedule.sort { $0.deliveryNs < $1.deliveryNs }

        var emitted: [PcmOutput] = []
        var nextChunk = 0
        let endNs = anchor + 10_000_000_000 // simulate 10 s
        var now = anchor
        while now <= endNs {
            while nextChunk < schedule.count && schedule[nextChunk].deliveryNs <= now {
                let chunk = schedule[nextChunk]
                XCTAssertEqual(mixer.feed(channel: chunk.channel, pcm: chunk.data, hostTime: chunk.startNs), .accepted)
                nextChunk += 1
            }
            emitted.append(contentsOf: pcms(mixer.emitDue(now: now)))
            now += 10_000_000
        }

        // 10 s of audio minus the 200 ms jitter lag -> 490 blocks.
        XCTAssertEqual(emitted.count, 490)
        XCTAssertEqual(emitted.map(\.blockIndex), Array(0..<490))
        for (i, output) in emitted.enumerated() {
            XCTAssertTrue(output.coverage.interviewer.covered, "block \(i) interviewer uncovered")
            XCTAssertTrue(output.coverage.you.covered, "block \(i) you uncovered")
            XCTAssertEqual(sampleValue(output.left, frame: 0), Int16(truncatingIfNeeded: i * framesPerBlock))
            XCTAssertEqual(sampleValue(output.right, frame: 0), Int16(truncatingIfNeeded: i * framesPerBlock))
        }
    }

    /// One hour of dual-cadence delivery must not drift by a single frame.
    func testOneHourDualRateNoDriftNoHoles() {
        let mixer = TimelineMixer()
        let anchor: UInt64 = 0

        struct Chunk { let deliveryNs: UInt64; let channel: SourceChannel; let data: Data; let startNs: UInt64 }
        var micChunks: [Chunk] = []
        var sysChunks: [Chunk] = []

        let totalFrames = 3_600 * 16_000 // one hour
        var micFrame = 0
        var micPattern = [341, 341, 342]
        var micIndex = 0
        while micFrame < totalFrames + 3_200 {
            let frames = micPattern[micIndex % 3]
            let startNs = anchor + UInt64(micFrame) * frameNs
            micChunks.append(Chunk(
                deliveryNs: startNs + UInt64(frames) * frameNs,
                channel: .you,
                data: counterData(startFrame: micFrame, frames: frames),
                startNs: startNs
            ))
            micFrame += frames
            micIndex += 1
        }
        var sysFrame = 0
        while sysFrame < totalFrames + 3_200 {
            let startNs = anchor + UInt64(sysFrame) * frameNs
            sysChunks.append(Chunk(
                deliveryNs: startNs + UInt64(3200) * frameNs + 3_000_000,
                channel: .interviewer,
                data: counterData(startFrame: sysFrame, frames: 3200),
                startNs: startNs
            ))
            sysFrame += 3200
        }

        var emitted = 0
        var micNext = 0
        var sysNext = 0
        var now = anchor
        let endNs = anchor + 3_600_000_000_000
        while now <= endNs {
            while micNext < micChunks.count && micChunks[micNext].deliveryNs <= now {
                let c = micChunks[micNext]
                XCTAssertEqual(mixer.feed(channel: c.channel, pcm: c.data, hostTime: c.startNs), .accepted)
                micNext += 1
            }
            while sysNext < sysChunks.count && sysChunks[sysNext].deliveryNs <= now {
                let c = sysChunks[sysNext]
                XCTAssertEqual(mixer.feed(channel: c.channel, pcm: c.data, hostTime: c.startNs), .accepted)
                sysNext += 1
            }
            for output in pcms(mixer.emitDue(now: now)) {
                XCTAssertTrue(output.coverage.interviewer.covered, "block \(output.blockIndex)")
                XCTAssertTrue(output.coverage.you.covered, "block \(output.blockIndex)")
                XCTAssertEqual(output.blockIndex, UInt32(emitted))
                XCTAssertEqual(sampleValue(output.left, frame: 0), Int16(truncatingIfNeeded: emitted * framesPerBlock))
                XCTAssertEqual(sampleValue(output.right, frame: 0), Int16(truncatingIfNeeded: emitted * framesPerBlock))
                emitted += 1
            }
            now += 100_000_000
        }

        XCTAssertEqual(emitted, 179_990) // one hour minus the 200 ms jitter lag
    }
}

// MARK: - TimelineMixer: coverage classification

final class TimelineMixerCoverageTests: XCTestCase {

    /// When a channel's data simply runs out (deadline expires, nothing proves
    /// the hole), uncovered blocks are late-data and zero-filled.
    func testLateDataClassificationAtDeadline() {
        let mixer = TimelineMixer()
        mixer.feed(channel: .interviewer, pcm: counterData(startFrame: 0, frames: 32_000), hostTime: 0)
        mixer.feed(channel: .you, pcm: counterData(startFrame: 0, frames: 12_800), hostTime: 0)

        let outputs = pcms(mixer.emitDue(now: 1_200_000_000))
        XCTAssertEqual(outputs.count, 50)

        for (i, output) in outputs.enumerated() {
            XCTAssertTrue(output.coverage.interviewer.covered)
            if i < 40 {
                XCTAssertTrue(output.coverage.you.covered, "block \(i)")
            } else {
                XCTAssertFalse(output.coverage.you.covered, "block \(i)")
                XCTAssertEqual(output.coverage.you.reason, .lateData)
                XCTAssertTrue(output.right.allSatisfy { $0 == 0 }, "block \(i) you must be zero-filled")
            }
        }
    }

    /// A hole proven by later-arriving data on the same channel is a source-gap.
    func testSourceGapClassificationWithLaterProof() {
        let mixer = TimelineMixer()
        mixer.feed(channel: .interviewer, pcm: counterData(startFrame: 0, frames: 32_000), hostTime: 0)
        // You: [0, 800 ms), hole, then [900 ms, 2 s). The 100 ms hole is within
        // the discontinuity bound, so the second chunk is accepted and proves it.
        mixer.feed(channel: .you, pcm: counterData(startFrame: 0, frames: 12_800), hostTime: 0)
        XCTAssertEqual(
            mixer.feed(channel: .you, pcm: counterData(startFrame: 14_400, frames: 17_600), hostTime: 900_000_000),
            .accepted
        )

        let outputs = pcms(mixer.emitDue(now: 1_400_000_000))
        XCTAssertEqual(outputs.count, 60)
        for i in 40..<45 {
            XCTAssertFalse(outputs[i].coverage.you.covered, "block \(i)")
            XCTAssertEqual(outputs[i].coverage.you.reason, .sourceGap, "block \(i)")
        }
        XCTAssertTrue(outputs[45].coverage.you.covered)
        XCTAssertEqual(sampleValue(outputs[45].right, frame: 0), 14_400)
    }

    /// Data arriving after its window was emitted is discarded and never
    /// reclassifies what was already persisted.
    func testDiscardedLatePacket() {
        let mixer = TimelineMixer()
        mixer.feed(channel: .interviewer, pcm: counterData(startFrame: 0, frames: 6_400), hostTime: 0)
        mixer.feed(channel: .you, pcm: counterData(startFrame: 0, frames: 6_400), hostTime: 0)

        let outputs = pcms(mixer.emitDue(now: 600_000_000))
        XCTAssertEqual(outputs.count, 20)

        // Entirely before the emission frontier: discarded.
        XCTAssertEqual(
            mixer.feed(channel: .you, pcm: counterData(startFrame: 640, frames: 320), hostTime: 40_000_000),
            .discardedLate
        )

        // Partially overlapping the frontier: overlap trimmed, remainder accepted.
        XCTAssertEqual(
            mixer.feed(channel: .you, pcm: counterData(startFrame: 6_240, frames: 320), hostTime: 390_000_000),
            .accepted
        )
        mixer.feed(channel: .interviewer, pcm: counterData(startFrame: 6_400, frames: 320), hostTime: 400_000_000)
        let next = pcms(mixer.emitDue(now: 630_000_000))
        XCTAssertEqual(next.map(\.blockIndex), [20])
        XCTAssertEqual(sampleValue(next[0].right, frame: 0), 6_400)
    }
}

// MARK: - TimelineMixer: timestamp validation

final class TimelineMixerTimestampTests: XCTestCase {

    func testRegressionBeyondToleranceSignalsDiscontinuity() {
        let mixer = TimelineMixer()
        mixer.feed(channel: .you, pcm: counterData(startFrame: 0, frames: 3_200), hostTime: 0)
        // 100 ms regression (> 5 ms tolerance): chunk dropped, rebuild signaled.
        XCTAssertEqual(
            mixer.feed(channel: .you, pcm: counterData(startFrame: 1_600, frames: 320), hostTime: 100_000_000),
            .timestampDiscontinuity
        )
    }

    func testForwardJumpOver200msSignalsDiscontinuity() {
        let mixer = TimelineMixer()
        mixer.feed(channel: .you, pcm: counterData(startFrame: 0, frames: 3_200), hostTime: 0)
        XCTAssertEqual(
            mixer.feed(channel: .you, pcm: counterData(startFrame: 9_600, frames: 320), hostTime: 600_000_000),
            .timestampDiscontinuity
        )
    }

    /// Small timestamp wobble (a few frames) is timestamp noise, not loss:
    /// the chunk is snapped onto the contiguous timeline.
    func testSmallOverlapSnappedWithoutDiscontinuity() {
        let mixer = TimelineMixer()
        mixer.feed(channel: .interviewer, pcm: counterData(startFrame: 0, frames: 6_400), hostTime: 0)
        mixer.feed(channel: .you, pcm: counterData(startFrame: 0, frames: 3_200), hostTime: 0)
        // Next chunk claims to start 48 frames (3 ms) before the expected end.
        XCTAssertEqual(
            mixer.feed(channel: .you, pcm: counterData(startFrame: 3_152, frames: 3_200), hostTime: 197_000_000),
            .accepted
        )

        let outputs = pcms(mixer.emitDue(now: 600_000_000))
        XCTAssertEqual(outputs.count, 20)
        // The snapped chunk lost its 48 duplicated frames, so coverage ends at
        // frame 6_352: blocks 0..<19 are full, block 19's tail is undelivered.
        for output in outputs.prefix(19) {
            XCTAssertTrue(output.coverage.you.covered)
        }
        XCTAssertFalse(outputs[19].coverage.you.covered)
        XCTAssertEqual(outputs[19].coverage.you.reason, .lateData)
        // No duplicated or skipped frames across the chunk boundary.
        XCTAssertEqual(sampleValue(outputs[9].right, frame: 319), 3_199)
        XCTAssertEqual(sampleValue(outputs[10].right, frame: 0), 3_200)
    }

    /// A rebuilt source starts a new generation; its timestamps are evaluated
    /// fresh and the hole before its first chunk is a proven source-gap.
    func testResetChannelStartsNewGeneration() {
        let mixer = TimelineMixer()
        mixer.feed(channel: .interviewer, pcm: counterData(startFrame: 0, frames: 80_000), hostTime: 0)
        mixer.feed(channel: .you, pcm: counterData(startFrame: 0, frames: 12_800), hostTime: 0)
        _ = mixer.emitDue(now: 1_200_000_000)

        mixer.resetChannel(.you)
        XCTAssertEqual(
            mixer.feed(channel: .you, pcm: counterData(startFrame: 0, frames: 16_000), hostTime: 2_000_000_000),
            .accepted
        )

        let outputs = pcms(mixer.emitDue(now: 2_500_000_000))
        // Blocks 50..114 emitted (deadline for 114 is 2.5 s).
        XCTAssertEqual(outputs.first?.blockIndex, 50)
        XCTAssertEqual(outputs.last?.blockIndex, 114)
        for i in 50..<100 {
            XCTAssertFalse(outputs[i - 50].coverage.you.covered, "block \(i)")
            XCTAssertEqual(outputs[i - 50].coverage.you.reason, .sourceGap, "block \(i)")
        }
        XCTAssertTrue(outputs[100 - 50].coverage.you.covered)
        XCTAssertEqual(sampleValue(outputs[100 - 50].right, frame: 0), 0)
    }
}

// MARK: - TimelineMixer: finalization

final class TimelineMixerFinalDrainTests: XCTestCase {

    /// Stop emits every block that still holds data. The final block's tail —
    /// frames past the end of a user-stopped recording — is not a loss.
    func testFinalDrainEmitsTailWithoutFalseMarking() {
        let mixer = TimelineMixer()
        mixer.feed(channel: .interviewer, pcm: counterData(startFrame: 0, frames: 3_360), hostTime: 0)
        mixer.feed(channel: .you, pcm: counterData(startFrame: 0, frames: 3_360), hostTime: 0)

        let outputs = pcms(mixer.finalDrain())
        XCTAssertEqual(outputs.map(\.blockIndex), Array(0..<11))
        for output in outputs {
            XCTAssertTrue(output.coverage.interviewer.covered)
            XCTAssertTrue(output.coverage.you.covered)
        }
        // Block 10 holds 160 real frames, then zeros.
        XCTAssertEqual(sampleValue(outputs[10].left, frame: 159), 3_359)
        XCTAssertEqual(sampleValue(outputs[10].left, frame: 160), 0)
    }

    /// A channel that died before stop is still marked on blocks its data does
    /// not touch; only the channel whose data ends inside the final block is
    /// exempt there.
    func testFinalDrainMarksDeadChannelTail() {
        let mixer = TimelineMixer()
        mixer.feed(channel: .interviewer, pcm: counterData(startFrame: 0, frames: 3_200), hostTime: 0)
        mixer.feed(channel: .you, pcm: counterData(startFrame: 0, frames: 1_920), hostTime: 0)

        let outputs = pcms(mixer.finalDrain())
        XCTAssertEqual(outputs.map(\.blockIndex), Array(0..<10))
        for i in 6..<10 {
            XCTAssertFalse(outputs[i].coverage.you.covered, "block \(i)")
            XCTAssertEqual(outputs[i].coverage.you.reason, .lateData, "block \(i)")
            XCTAssertTrue(outputs[i].coverage.interviewer.covered, "block \(i)")
        }
    }

    func testFinalDrainWithoutAnchorReturnsEmpty() {
        let mixer = TimelineMixer()
        mixer.feed(channel: .interviewer, pcm: counterData(startFrame: 0, frames: 3_200), hostTime: 0)
        XCTAssertTrue(mixer.finalDrain().isEmpty)
    }
}

// MARK: - TimelineMixer: block limit

final class TimelineMixerLimitTests: XCTestCase {

    func testEmissionStopsAtBlockLimit() {
        let mixer = TimelineMixer(blockLimit: 7)
        mixer.feed(channel: .interviewer, pcm: counterData(startFrame: 0, frames: 3_200), hostTime: 0)
        mixer.feed(channel: .you, pcm: counterData(startFrame: 0, frames: 3_200), hostTime: 0)

        let outputs = pcms(mixer.emitDue(now: 10_000_000_000))
        XCTAssertEqual(outputs.count, 7)
        XCTAssertEqual(mixer.getCurrentBlock(), 7)
        XCTAssertTrue(mixer.finalDrain().isEmpty)
    }
}
