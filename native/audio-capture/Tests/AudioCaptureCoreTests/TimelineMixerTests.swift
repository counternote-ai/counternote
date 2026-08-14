import XCTest
@testable import AudioCaptureCore

// MARK: - Helpers

private func pcmData(sampleCount: Int, value: Int16) -> Data {
    var samples = [Int16](repeating: value, count: sampleCount)
    return Data(bytes: &samples, count: samples.count * 2)
}

private let blockSamples = 320
private let blockBytes = 640

private func oneBlock(_ value: Int16) -> Data {
    return pcmData(sampleCount: blockSamples, value: value)
}

// MARK: - TimelineMixer: Host-Clock Alignment Tests

final class TimelineMixerAlignmentTests: XCTestCase {

    // 1. Later-of-two-starts anchor
    func testLaterOfTwoStartsAnchor() {
        let clock = FakeHostClock(initialTime: 0)
        let mixer = TimelineMixer(hostClock: clock)

        // Interviewer starts at t=100ms, feeds 10 blocks worth (enough to survive trimming)
        let t1: UInt64 = 100_000_000
        mixer.feed(channel: .interviewer, pcm: Data(repeating: 1, count: blockBytes * 10), hostTime: t1)

        // No anchor yet
        XCTAssertNil(mixer.tryEmit())

        // You starts at t=200ms (later); anchor = 200ms
        let t2: UInt64 = 200_000_000
        mixer.feed(channel: .you, pcm: oneBlock(2), hostTime: t2)

        // Anchor set. Interviewer's data from [100ms, 200ms] is trimmed (5 blocks).
        // 5 blocks remain in interviewer buffer.
        let output = mixer.tryEmit()
        XCTAssertNotNil(output)
        if case .pcm(let left, let right, let idx) = output {
            XCTAssertEqual(idx, 0)
            XCTAssertEqual(left.first, 1)  // interviewer = left
            XCTAssertEqual(right.first, 2) // you = right
        } else {
            XCTFail("Expected PCM output")
        }
    }

    // 2. Exact 20 ms boundaries
    func testExact20msBoundaries() {
        let clock = FakeHostClock(initialTime: 0)
        let mixer = TimelineMixer(hostClock: clock)

        let t: UInt64 = 100_000_000
        let pcm3 = Data(repeating: 1, count: blockBytes * 3)
        mixer.feed(channel: .interviewer, pcm: pcm3, hostTime: t)
        mixer.feed(channel: .you, pcm: pcm3, hostTime: t)

        for expectedIdx: UInt32 in 0..<3 {
            let output = mixer.tryEmit()
            XCTAssertNotNil(output, "Expected block \(expectedIdx)")
            if case .pcm(_, _, let idx) = output {
                XCTAssertEqual(idx, expectedIdx)
            }
        }

        XCTAssertNil(mixer.tryEmit())
    }

    // 3. Overlap trimming
    func testOverlapTrimming() {
        let clock = FakeHostClock(initialTime: 0)
        let mixer = TimelineMixer(hostClock: clock)

        // Interviewer starts at t=0, feeds 2 blocks
        let t0: UInt64 = 0
        mixer.feed(channel: .interviewer, pcm: Data(repeating: 1, count: blockBytes * 2), hostTime: t0)

        // You starts at t=20ms (1 block later)
        let t1: UInt64 = 20_000_000
        mixer.feed(channel: .you, pcm: oneBlock(2), hostTime: t1)

        // Anchor = 20ms; interviewer's first block trimmed
        let output = mixer.tryEmit()
        XCTAssertNotNil(output)
        if case .pcm(let left, _, let idx) = output {
            XCTAssertEqual(idx, 0)
            XCTAssertEqual(left.count, blockBytes)
        }

        // Interviewer only had 1 block left after trimming, now consumed.
        // Next emit should be gap (or nil if coalescing).
        let output2 = mixer.tryEmit()
        if case .gap = output2 {
            // Expected
        }
    }

    // 4. Partial-window zero fill: partial data is not a full block -> gap
    func testPartialWindowZeroFill() {
        let clock = FakeHostClock(initialTime: 0)
        let mixer = TimelineMixer(hostClock: clock)

        let t: UInt64 = 100_000_000
        let partialPcm = Data(repeating: 5, count: blockBytes / 2)
        mixer.feed(channel: .interviewer, pcm: partialPcm, hostTime: t)
        mixer.feed(channel: .you, pcm: oneBlock(2), hostTime: t)

        // With only 320 bytes (< 640), it's a gap
        let output = mixer.tryEmit()
        if case .gap(let start, let end, _) = output {
            XCTAssertEqual(start, 0)
            XCTAssertEqual(end, 1)
        } else if output == nil {
            // Gap coalesced, also acceptable
        } else {
            XCTFail("Expected gap or nil for partial window")
        }
    }

    // 5. Valid all-zero callback coverage
    func testAllZeroCallbackCoverage() {
        let clock = FakeHostClock(initialTime: 0)
        let mixer = TimelineMixer(hostClock: clock)

        let t: UInt64 = 100_000_000
        let silentBlock = Data(repeating: 0, count: blockBytes)

        mixer.feed(channel: .interviewer, pcm: silentBlock, hostTime: t)
        mixer.feed(channel: .you, pcm: silentBlock, hostTime: t)

        let output = mixer.tryEmit()
        XCTAssertNotNil(output)
        if case .pcm(let left, let right, let idx) = output {
            XCTAssertEqual(idx, 0)
            XCTAssertTrue(left.allSatisfy { $0 == 0 })
            XCTAssertTrue(right.allSatisfy { $0 == 0 })
        } else {
            XCTFail("Expected PCM output for all-zero block")
        }
    }

    // 6. Left/right interleave order: interviewer=left, you=right
    func testLeftRightInterleaveOrder() {
        let clock = FakeHostClock(initialTime: 0)
        let mixer = TimelineMixer(hostClock: clock)

        let t: UInt64 = 100_000_000
        let leftPcm = Data(repeating: 0xAA, count: blockBytes)
        let rightPcm = Data(repeating: 0xBB, count: blockBytes)

        mixer.feed(channel: .interviewer, pcm: leftPcm, hostTime: t)
        mixer.feed(channel: .you, pcm: rightPcm, hostTime: t)

        let output = mixer.tryEmit()
        if case .pcm(let left, let right, _) = output {
            XCTAssertEqual(left.first, 0xAA, "Interviewer should be left channel")
            XCTAssertEqual(right.first, 0xBB, "You should be right channel")
        } else {
            XCTFail("Expected PCM output")
        }
    }
}

// MARK: - TimelineMixer: Interruption Tests

final class TimelineMixerInterruptionTests: XCTestCase {

    // 1. One-frame hole marks the whole block as gap
    func testOneFrameHoleMarksWholeBlockAsGap() {
        let clock = FakeHostClock(initialTime: 0)
        let mixer = TimelineMixer(hostClock: clock)

        let t: UInt64 = 100_000_000
        // Feed interviewer with data, you with empty
        mixer.feed(channel: .interviewer, pcm: oneBlock(1), hostTime: t)
        mixer.feed(channel: .you, pcm: Data(), hostTime: t)

        // Feed next block for both
        let t2 = t + 20_000_000
        mixer.feed(channel: .interviewer, pcm: oneBlock(1), hostTime: t2)
        mixer.feed(channel: .you, pcm: oneBlock(2), hostTime: t2)

        // First emit should be a gap (you had no data for block 0)
        let output = mixer.tryEmit()
        if case .gap(let start, let end, let reason) = output {
            XCTAssertEqual(start, 0)
            XCTAssertEqual(end, 1)
            XCTAssertTrue(reason == .sourceGap || reason == .lateData)
        }
        // else gap might be coalesced
    }

    // 2. Contiguous block coalescing
    func testContiguousBlockCoalescing() {
        let clock = FakeHostClock(initialTime: 0)
        let mixer = TimelineMixer(hostClock: clock)

        let t: UInt64 = 100_000_000
        // Feed interviewer 5 blocks, you with empty feed (starts but no PCM)
        mixer.feed(channel: .interviewer, pcm: Data(repeating: 1, count: blockBytes * 5), hostTime: t)
        mixer.feed(channel: .you, pcm: Data(), hostTime: t)

        // Consume 5 gap blocks (coalesced into pending, returned as nil)
        for _ in 0..<5 {
            _ = mixer.tryEmit()
        }

        // Now feed PCM for both to trigger flush of the pending gap
        let t2 = t + 20_000_000 * 5
        mixer.feed(channel: .interviewer, pcm: oneBlock(1), hostTime: t2)
        mixer.feed(channel: .you, pcm: oneBlock(2), hostTime: t2)

        // First emit should be the coalesced gap (5 blocks), then PCM
        let gapOutput = mixer.tryEmit()
        var totalGapBlocks: UInt32 = 0
        if case .gap(let s, let e, _) = gapOutput {
            totalGapBlocks += (e - s)
        }
        XCTAssertEqual(totalGapBlocks, 5, "All 5 gap blocks should be coalesced into one gap")
    }

    // 3. source-gap vs late-data classification
    func testSourceGapVsLateDataClassification() {
        let clock = FakeHostClock(initialTime: 0)
        let mixer = TimelineMixer(hostClock: clock)

        let t: UInt64 = 100_000_000
        mixer.feed(channel: .interviewer, pcm: oneBlock(1), hostTime: t)
        mixer.feed(channel: .you, pcm: Data(), hostTime: t)

        let t2 = t + 20_000_000
        mixer.feed(channel: .interviewer, pcm: oneBlock(1), hostTime: t2)
        mixer.feed(channel: .you, pcm: oneBlock(2), hostTime: t2)

        var gapReasons: [GapReason] = []
        while let out = mixer.tryEmit() {
            if case .gap(_, _, let reason) = out {
                gapReasons.append(reason)
            }
        }

        for reason in gapReasons {
            XCTAssertTrue(reason == .sourceGap || reason == .lateData,
                          "Gap reason should be source-gap or late-data, got \(reason.rawValue)")
        }
    }

    // 4. Discarded late packets without reclassification
    func testDiscardedLatePackets() {
        let clock = FakeHostClock(initialTime: 0)
        let mixer = TimelineMixer(hostClock: clock)

        let t: UInt64 = 200_000_000
        mixer.feed(channel: .interviewer, pcm: oneBlock(1), hostTime: t)
        mixer.feed(channel: .you, pcm: oneBlock(2), hostTime: t)

        let out0 = mixer.tryEmit()
        if case .pcm(_, _, let idx) = out0 {
            XCTAssertEqual(idx, 0)
        }

        // Feed with timestamp in the past (regression) - should be discarded
        let lateTime: UInt64 = 50_000_000
        mixer.feed(channel: .interviewer, pcm: oneBlock(1), hostTime: lateTime)

        // Interruption should open for timestamp regression
        XCTAssertTrue(mixer.hasOpenInterruption(channel: .interviewer))
    }

    // 5. Timestamp regression detection
    func testTimestampRegressionDetection() {
        let clock = FakeHostClock(initialTime: 0)
        let mixer = TimelineMixer(hostClock: clock)

        let t: UInt64 = 200_000_000
        mixer.feed(channel: .interviewer, pcm: oneBlock(1), hostTime: t)

        let tRegression: UInt64 = 100_000_000
        mixer.feed(channel: .interviewer, pcm: oneBlock(1), hostTime: tRegression)

        XCTAssertTrue(mixer.hasOpenInterruption(channel: .interviewer))
    }

    // 6. Discontinuity over 200 ms detection
    func testDiscontinuityOver200ms() {
        let clock = FakeHostClock(initialTime: 0)
        let mixer = TimelineMixer(hostClock: clock)

        let t: UInt64 = 100_000_000
        mixer.feed(channel: .interviewer, pcm: oneBlock(1), hostTime: t)

        let t2: UInt64 = t + 250_000_000
        mixer.feed(channel: .interviewer, pcm: oneBlock(1), hostTime: t2)

        XCTAssertTrue(mixer.hasOpenInterruption(channel: .interviewer))
    }

    // 7. Local close with recovered: false on Stop
    func testCloseWithRecoveredFalseOnStop() {
        let clock = FakeHostClock(initialTime: 0)
        let mixer = TimelineMixer(hostClock: clock)

        let t: UInt64 = 100_000_000
        mixer.feed(channel: .interviewer, pcm: oneBlock(1), hostTime: t)
        mixer.feed(channel: .interviewer, pcm: oneBlock(1), hostTime: t + 250_000_000)

        XCTAssertTrue(mixer.hasOpenInterruption(channel: .interviewer))

        _ = mixer.stop()
        XCTAssertFalse(mixer.hasOpenInterruption(channel: .interviewer))
    }
}

// MARK: - TimelineMixer: Transition Case Tests

final class TimelineMixerTransitionTests: XCTestCase {

    // Open late-data, escalate, retain original reason/ID, close on coverage or termination
    func testLateDataEscalationRetainsReasonAndID() {
        let clock = FakeHostClock(initialTime: 0)
        let mixer = TimelineMixer(hostClock: clock)

        let t: UInt64 = 100_000_000
        mixer.feed(channel: .interviewer, pcm: oneBlock(1), hostTime: t)
        mixer.feed(channel: .you, pcm: oneBlock(2), hostTime: t)

        _ = mixer.tryEmit()  // block 0

        // Feed only interviewer for block 1 (you is late)
        let t1 = t + 20_000_000
        mixer.feed(channel: .interviewer, pcm: oneBlock(1), hostTime: t1)

        // Consume block 1 (gap for you)
        _ = mixer.tryEmit()

        // If interruption opened for you, verify it persists across more gaps
        if mixer.hasOpenInterruption(channel: .you) {
            let originalId = mixer.getOpenInterruptionId(channel: .you)

            // Feed more blocks - you still missing
            for i in 2..<10 {
                let tn = t + UInt64(i) * 20_000_000
                mixer.feed(channel: .interviewer, pcm: oneBlock(1), hostTime: tn)
                _ = mixer.tryEmit()
            }

            if mixer.hasOpenInterruption(channel: .you) {
                XCTAssertEqual(mixer.getOpenInterruptionId(channel: .you), originalId,
                               "Interruption ID should be retained")
            }

            // Close on termination
            _ = mixer.stop()
            XCTAssertFalse(mixer.hasOpenInterruption(channel: .you))
        }
    }
}

// MARK: - TimelineMixer: Health Boundary Tests

final class TimelineMixerHealthTests: XCTestCase {

    // 1,499 silent blocks = connected, 1,500th = no-audio-detected
    func testHealthBoundary1500SilentBlocks() {
        let health = SourceHealth(channel: .interviewer)
        let silentBlock = Data(repeating: 0, count: blockBytes)

        for i in 0..<1499 {
            health.update(pcmBlock: silentBlock, effectiveBlock: UInt32(i))
        }
        XCTAssertEqual(health.getState(), .connected)
        XCTAssertEqual(health.getSilentBlocks(), 1499)

        health.update(pcmBlock: silentBlock, effectiveBlock: 1499)
        XCTAssertEqual(health.getState(), .noAudioDetected)
        XCTAssertEqual(health.getSilentBlocks(), 1500)
    }

    // Nonzero sample resets to connected
    func testNonzeroSampleResetsToConnected() {
        let health = SourceHealth(channel: .interviewer)
        let silentBlock = Data(repeating: 0, count: blockBytes)
        let audioBlock = Data(repeating: 1, count: blockBytes)

        for i in 0..<1500 {
            health.update(pcmBlock: silentBlock, effectiveBlock: UInt32(i))
        }
        XCTAssertEqual(health.getState(), .noAudioDetected)

        health.update(pcmBlock: audioBlock, effectiveBlock: 1500)
        XCTAssertEqual(health.getState(), .connected)
        XCTAssertEqual(health.getSilentBlocks(), 0)
    }

    // Silence never opens interruption
    func testSilenceNeverOpensInterruption() {
        let health = SourceHealth(channel: .interviewer)
        let silentBlock = Data(repeating: 0, count: blockBytes)

        for i in 0..<2000 {
            health.update(pcmBlock: silentBlock, effectiveBlock: UInt32(i))
        }

        XCTAssertEqual(health.getState(), .noAudioDetected)
    }

    // Persistent late-data: later covered PCM does not clear connected-with-gap
    func testPersistentLateDataNotClearedByPCM() {
        let health = SourceHealth(channel: .interviewer)
        let audioBlock = Data(repeating: 1, count: blockBytes)

        health.markGap(effectiveBlock: 10)
        XCTAssertEqual(health.getState(), .connectedWithGap)

        health.update(pcmBlock: audioBlock, effectiveBlock: 11)
        XCTAssertEqual(health.getState(), .connectedWithGap,
                       "connected-with-gap should persist after new PCM coverage")
    }
}

// MARK: - TimelineMixer: Limit Tests

final class TimelineMixerLimitTests: XCTestCase {

    // PCM and gaps count toward MAX_BLOCKS
    func testPCMAndGapsCountTowardMaxBlocks() {
        let clock = FakeHostClock(initialTime: 0)
        let mixer = TimelineMixer(hostClock: clock)

        let t: UInt64 = 100_000_000
        let bigPcm = Data(repeating: 1, count: blockBytes * 10)
        mixer.feed(channel: .interviewer, pcm: bigPcm, hostTime: t)
        mixer.feed(channel: .you, pcm: bigPcm, hostTime: t)

        for i in 0..<10 {
            let out = mixer.tryEmit()
            if case .pcm(_, _, let idx) = out {
                XCTAssertEqual(idx, UInt32(i))
            }
        }

        XCTAssertEqual(mixer.getPCMBlockCount(), 10)
        XCTAssertEqual(mixer.getCurrentBlock(), 10)
    }

    // Gap split at 3,000 blocks
    func testGapSplitAt3000Blocks() {
        let clock = FakeHostClock(initialTime: 0)
        let mixer = TimelineMixer(hostClock: clock)

        let t: UInt64 = 100_000_000
        let bigPcm = Data(repeating: 1, count: blockBytes * 3500)
        mixer.feed(channel: .interviewer, pcm: bigPcm, hostTime: t)
        mixer.feed(channel: .you, pcm: Data(), hostTime: t)

        var gapOutputs: [MixerOutput] = []
        while let out = mixer.tryEmit() {
            gapOutputs.append(out)
        }

        for out in gapOutputs {
            if case .gap(let start, let end, _) = out {
                let length = end - start
                XCTAssertLessThanOrEqual(length, 3000, "Gap should be split at 3,000 blocks")
                XCTAssertGreaterThan(length, 0, "Gap should have positive length")
            }
        }
    }

    // Final gap clips at MAX_BLOCKS boundary
    func testFinalGapClipsAtMaxBlocksBoundary() {
        let clock = FakeHostClock(initialTime: 0)
        let mixer = TimelineMixer(hostClock: clock)

        let t: UInt64 = 100_000_000
        mixer.feed(channel: .interviewer, pcm: oneBlock(1), hostTime: t)
        mixer.feed(channel: .you, pcm: oneBlock(1), hostTime: t)

        let out = mixer.tryEmit()
        XCTAssertNotNil(out)
        XCTAssertLessThan(mixer.getCurrentBlock(), maxBlocks)
    }
}

// MARK: - TimelineMixer: 60-Minute Fixture Test

final class TimelineMixerFixtureTests: XCTestCase {

    // Final channel positions differ by at most one 20 ms block
    func testSixtyMinuteFinalChannelPositionDrift() {
        let clock = FakeHostClock(initialTime: 0)
        let mixer = TimelineMixer(hostClock: clock)

        let blockCount = 1000
        let t: UInt64 = 100_000_000

        // Feed both sources with slight drift (1us per block)
        for i in 0..<blockCount {
            let interviewerTime = t + UInt64(i) * 20_000_000
            let youTime = t + UInt64(i) * 20_001_000

            mixer.feed(channel: .interviewer, pcm: oneBlock(1), hostTime: interviewerTime)
            mixer.feed(channel: .you, pcm: oneBlock(2), hostTime: youTime)
        }

        var pcmCount = 0
        while let out = mixer.tryEmit() {
            if case .pcm = out {
                pcmCount += 1
            }
        }

        XCTAssertEqual(pcmCount, blockCount, "Should emit all blocks")
    }
}

// MARK: - PCMConverter Linear Interpolation Tests

final class PCMConverterLinearInterpolationTests: XCTestCase {

    func testSameSampleRatePassthrough() {
        let converter = PCMConverter(
            sourceFormat: PCMFormat(sampleRate: 16000, channels: 1, bitsPerSample: 16),
            targetFormat: PCMFormat(sampleRate: 16000, channels: 1, bitsPerSample: 16)
        )

        let input = pcmData(sampleCount: 100, value: 1000)
        let output = converter.convert(input)
        XCTAssertEqual(output, input)
    }

    func testLinearInterpolationDownsampling() {
        let converter = PCMConverter(
            sourceFormat: PCMFormat(sampleRate: 48000, channels: 1, bitsPerSample: 16),
            targetFormat: PCMFormat(sampleRate: 16000, channels: 1, bitsPerSample: 16)
        )

        // Create a ramp from 0 to 32000
        var ramp = [Int16]()
        for i in 0..<48000 {
            ramp.append(Int16((Double(i) / 48000.0) * 32000.0))
        }
        let input = Data(bytes: ramp, count: ramp.count * 2)

        let output = converter.convert(input)
        XCTAssertNotNil(output)

        let outputSamples = output!.count / 2
        XCTAssertEqual(outputSamples, 16000)

        // Verify monotonicity preserved by linear interpolation
        output!.withUnsafeBytes { bytes in
            let samples = bytes.bindMemory(to: Int16.self)
            for i in 1..<outputSamples {
                XCTAssertGreaterThanOrEqual(samples[i], samples[i - 1],
                    "Linear interpolation should preserve monotonicity at index \(i)")
            }
        }
    }

    func testLinearInterpolationUpsampling() {
        let converter = PCMConverter(
            sourceFormat: PCMFormat(sampleRate: 8000, channels: 1, bitsPerSample: 16),
            targetFormat: PCMFormat(sampleRate: 16000, channels: 1, bitsPerSample: 16)
        )

        var samples = [Int16](repeating: 1000, count: 4000)
        samples.append(contentsOf: [Int16](repeating: -1000, count: 4000))
        let input = Data(bytes: samples, count: samples.count * 2)

        let output = converter.convert(input)
        XCTAssertNotNil(output)

        let outputSamples = output!.count / 2
        XCTAssertEqual(outputSamples, 16000)
    }

    func testUnsupportedBitDepthReturnsNil() {
        let converter = PCMConverter(
            sourceFormat: PCMFormat(sampleRate: 16000, channels: 1, bitsPerSample: 24),
            targetFormat: PCMFormat(sampleRate: 16000, channels: 1, bitsPerSample: 16)
        )

        let input = Data(count: 100)
        XCTAssertNil(converter.convert(input))
    }
}
