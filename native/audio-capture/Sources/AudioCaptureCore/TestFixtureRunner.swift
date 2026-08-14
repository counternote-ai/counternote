import Foundation

#if CAPTURE_TEST_SEAMS

// MARK: - Fixture Manifest

public struct FixtureManifest: Codable {
    public let name: String
    public let virtualDurationSeconds: Double
    public let systemInputRate: Int
    public let microphoneInputRate: Int
    public let outputSampleRate: Int
    public let framesPerBlock: Int
    public let pcmBlockBytes: Int
    public let blockDurationMs: Int
    public let impulseIntervalBlocks: Int
    public let impulseAmplitude: Int16
    public let discontinuity: DiscontinuityConfig?
    public let expected: ExpectedCounts

    public struct DiscontinuityConfig: Codable {
        public let channel: String
        public let atBlock: Int
        public let gapBlocks: Int
        public let reason: String
    }

    public struct ExpectedCounts: Codable {
        public let totalBlocks: Int
        public let pcmBlocks: Int
        public let gapBlocks: Int
        public let interruptionOpens: Int
        public let interruptionCloses: Int
    }
}

// MARK: - Test Fixture Runner

public class TestFixtureRunner {
    private let manifest: FixtureManifest
    private let writer: CaptureProtocolWriter

    public init(manifest: FixtureManifest, writer: CaptureProtocolWriter) {
        self.manifest = manifest
        self.writer = writer
    }

    /// Run the fixture, generating frames to the writer's sink.
    public func run() throws {
        // Emit ready frame
        let ready = ReadyPayload(
            type: "ready",
            sampleRateHz: manifest.outputSampleRate,
            framesPerBlock: manifest.framesPerBlock,
            encoding: "s16le",
            channelOrder: ["interviewer", "you"],
            firstBlock: 0
        )
        try writer.writeFrame(.ready(sequence: 0, payload: ready))

        if let discontinuity = manifest.discontinuity {
            try runWithDiscontinuity(discontinuity)
        } else {
            try runContinuous()
        }

        // Emit stopped frame
        let totalBlocks = UInt32(manifest.expected.totalBlocks)
        let pcmBlocks = UInt32(manifest.expected.pcmBlocks)
        let gapBlocks = UInt32(manifest.expected.gapBlocks)
        let stopped = StoppedPayload(
            type: "stopped",
            reason: "stop",
            finalBlockExclusive: totalBlocks,
            pcmBlocks: pcmBlocks,
            gapBlocks: gapBlocks,
            openInterruptionIds: []
        )
        try writer.writeFrame(.stopped(sequence: totalBlocks + 1, payload: stopped))
    }

    private func runContinuous() throws {
        let totalBlocks = manifest.expected.totalBlocks
        let impulseInterval = manifest.impulseIntervalBlocks
        let amplitude = manifest.impulseAmplitude
        let framesPerBlock = manifest.framesPerBlock

        for block in 0..<totalBlocks {
            let isImpulseBlock = (block % impulseInterval == 0) && (block > 0 || impulseInterval == 1)
            let pcmData = makeStereoBlock(
                framesPerBlock: framesPerBlock,
                amplitude: isImpulseBlock ? amplitude : 0
            )
            try writer.writeFrame(.pcm(sequence: UInt32(block + 1), payload: pcmData))
        }
    }

    private func runWithDiscontinuity(_ discontinuity: FixtureManifest.DiscontinuityConfig) throws {
        let totalBlocks = manifest.expected.totalBlocks
        let impulseInterval = manifest.impulseIntervalBlocks
        let amplitude = manifest.impulseAmplitude
        let framesPerBlock = manifest.framesPerBlock
        let gapStart = discontinuity.atBlock
        let gapCount = discontinuity.gapBlocks
        let gapEnd = gapStart + gapCount

        // Phase 1: Normal PCM before discontinuity
        for block in 0..<gapStart {
            let isImpulseBlock = (block % impulseInterval == 0) && block > 0
            let pcmData = makeStereoBlock(
                framesPerBlock: framesPerBlock,
                amplitude: isImpulseBlock ? amplitude : 0
            )
            try writer.writeFrame(.pcm(sequence: UInt32(block + 1), payload: pcmData))
        }

        // Phase 2: Interruption open
        let interruptionId: UInt32 = 1
        let interruptionOpen = InterruptionPayload(
            type: "interruption",
            phase: .opened,
            id: interruptionId,
            channel: .you,
            startBlock: UInt32(gapStart),
            endBlockExclusive: nil,
            reason: .timestampDiscontinuity,
            recovered: nil
        )
        try writer.writeFrame(.interruption(sequence: UInt32(gapStart + 1), payload: interruptionOpen))

        // Phase 3: PCM during interruption (system data, microphone zeros)
        for block in gapStart..<gapEnd {
            let isImpulseBlock = (block % impulseInterval == 0)
            // During interruption: system channel has data, microphone is silent
            let pcmData = makeStereoBlockDuringInterruption(
                framesPerBlock: framesPerBlock,
                amplitude: isImpulseBlock ? amplitude : 0
            )
            try writer.writeFrame(.pcm(sequence: UInt32(block + 2), payload: pcmData))
        }

        // Phase 4: Interruption closed (recovered)
        let interruptionClose = InterruptionPayload(
            type: "interruption",
            phase: .closed,
            id: interruptionId,
            channel: .you,
            startBlock: UInt32(gapStart),
            endBlockExclusive: UInt32(gapEnd),
            reason: .timestampDiscontinuity,
            recovered: true
        )
        try writer.writeFrame(.interruption(sequence: UInt32(gapEnd + 2), payload: interruptionClose))

        // Phase 5: Normal PCM after recovery
        for block in gapEnd..<totalBlocks {
            let isImpulseBlock = (block % impulseInterval == 0)
            let pcmData = makeStereoBlock(
                framesPerBlock: framesPerBlock,
                amplitude: isImpulseBlock ? amplitude : 0
            )
            // Sequence: gapStart+1 (open) + gapCount PCM + 1 (close) + remaining PCM
            let sequenceOffset = gapStart + 1 + gapCount + 1
            let seq = UInt32(sequenceOffset + (block - gapEnd) + 1)
            try writer.writeFrame(.pcm(sequence: seq, payload: pcmData))
        }
    }

    /// Create a stereo PCM block with equal impulse on both channels.
    private func makeStereoBlock(framesPerBlock: Int, amplitude: Int16) -> Data {
        var data = Data(count: framesPerBlock * 4) // 2 channels * 2 bytes
        data.withUnsafeMutableBytes { buffer in
            let samples = buffer.bindMemory(to: Int16.self)
            for i in 0..<framesPerBlock {
                let value = amplitude
                samples[i * 2] = value     // left (system)
                samples[i * 2 + 1] = value // right (microphone)
            }
        }
        return data
    }

    /// Create a stereo PCM block where left (system) has impulse, right (microphone) is zero.
    private func makeStereoBlockDuringInterruption(framesPerBlock: Int, amplitude: Int16) -> Data {
        var data = Data(count: framesPerBlock * 4)
        data.withUnsafeMutableBytes { buffer in
            let samples = buffer.bindMemory(to: Int16.self)
            for i in 0..<framesPerBlock {
                samples[i * 2] = amplitude  // left (system) has impulse
                samples[i * 2 + 1] = 0      // right (microphone) is silent
            }
        }
        return data
    }
}

#endif
