import Foundation

// MARK: - Constants

public let captureProtocolVersion: UInt8 = 1
public let headerBytes = 16
public let maxJsonPayloadBytes = 4096
public let pcmBlockBytes = 1280
public let maxBlocks: UInt32 = 3_355_443

// MARK: - Frame Types

public enum CaptureFrameType: UInt8, Codable, Sendable {
    case ready = 0x01
    case pcm = 0x02
    case gap = 0x03
    case interruption = 0x04
    case state = 0x05
    case stopped = 0x06
    case error = 0x07
}

// MARK: - Protocol Errors

public enum CaptureProtocolErrorCode: String, Codable, Sendable {
    case invalidMagic = "INVALID_MAGIC"
    case unsupportedVersion = "UNSUPPORTED_VERSION"
    case nonzeroReservedBytes = "NONZERO_RESERVED_BYTES"
    case unknownFrameType = "UNKNOWN_FRAME_TYPE"
    case invalidPayloadLength = "INVALID_PAYLOAD_LENGTH"
    case invalidSequence = "INVALID_SEQUENCE"
    case partialFrameAtEOF = "PARTIAL_FRAME_AT_EOF"
    case malformedJSON = "MALFORMED_JSON"
    case duplicateJSONKey = "DUPLICATE_JSON_KEY"
    case invalidSchema = "INVALID_SCHEMA"
    case invalidInvariant = "INVALID_INVARIANT"
    case terminalFrame = "TERMINAL_FRAME"
}

public struct CaptureProtocolError: Error, Sendable {
    public let code: CaptureProtocolErrorCode
    public let message: String

    public init(code: CaptureProtocolErrorCode, message: String) {
        self.code = code
        self.message = message
    }
}

// MARK: - Payload Types

public struct ReadyPayload: Codable, Sendable {
    public let type: String
    public let sampleRateHz: Int
    public let framesPerBlock: Int
    public let encoding: String
    public let channelOrder: [String]
    public let firstBlock: UInt32

    enum CodingKeys: String, CodingKey {
        case type, sampleRateHz, framesPerBlock, encoding, channelOrder, firstBlock
    }
}

public enum SourceChannel: String, Codable, Sendable {
    case interviewer
    case you
}

public enum RecoverableReason: String, Codable, Sendable {
    case streamError = "stream-error"
    case callbackStall = "callback-stall"
    case routeInvalidated = "route-invalidated"
    case timestampInvalid = "timestamp-invalid"
    case timestampDiscontinuity = "timestamp-discontinuity"
}

public enum GapReason: String, Codable, Sendable {
    case sourceGap = "source-gap"
    case lateData = "late-data"
    case streamError = "stream-error"
    case callbackStall = "callback-stall"
    case routeInvalidated = "route-invalidated"
    case timestampInvalid = "timestamp-invalid"
    case timestampDiscontinuity = "timestamp-discontinuity"
}

public enum SourceInterruptionReason: String, Codable, Sendable {
    case sourceGap = "source-gap"
    case lateData = "late-data"
    case streamError = "stream-error"
    case callbackStall = "callback-stall"
    case routeInvalidated = "route-invalidated"
    case timestampInvalid = "timestamp-invalid"
    case timestampDiscontinuity = "timestamp-discontinuity"
}

public enum StateStatus: String, Codable, Sendable {
    case connected
    case connectedWithGap = "connected-with-gap"
    case noAudioDetected = "no-audio-detected"
    case reconnecting
    case disconnected
}

public struct StatePayload: Codable, Sendable {
    public let type: String
    public let channel: SourceChannel
    public let status: StateStatus
    public let effectiveBlock: UInt32
    public let reason: String?
    public let silentBlocks: UInt32?
    public let attempt: UInt32?

    enum CodingKeys: String, CodingKey {
        case type, channel, status, effectiveBlock, reason, silentBlocks, attempt
    }
}

public struct StoppedPayload: Codable, Sendable {
    public let type: String
    public let reason: String
    public let finalBlockExclusive: UInt32
    public let pcmBlocks: UInt32
    public let gapBlocks: UInt32
    public let openInterruptionIds: [UInt32]

    enum CodingKeys: String, CodingKey {
        case type, reason, finalBlockExclusive, pcmBlocks, gapBlocks, openInterruptionIds
    }
}

public enum ErrorPhase: String, Codable, Sendable {
    case initialization
    case runtime
}

public enum ErrorCode: String, Codable, Sendable {
    case sourceStartFailed = "source-start-failed"
    case sourceTimestampUnavailable = "source-timestamp-unavailable"
    case unsupportedFormat = "unsupported-format"
    case invalidControl = "invalid-control"
    case internalError = "internal"
}

public struct ErrorPayload: Codable, Sendable {
    public let type: String
    public let phase: ErrorPhase
    public let code: ErrorCode
    public let channel: SourceChannel?
    public let terminal: Bool

    enum CodingKeys: String, CodingKey {
        case type, phase, code, channel, terminal
    }

    public init(
        type: String,
        phase: ErrorPhase,
        code: ErrorCode,
        channel: SourceChannel?,
        terminal: Bool
    ) {
        self.type = type
        self.phase = phase
        self.code = code
        self.channel = channel
        self.terminal = terminal
    }
}

public enum InterruptionPhase: String, Codable, Sendable {
    case opened
    case closed
}

public struct InterruptionPayload: Codable, Sendable {
    public let type: String
    public let phase: InterruptionPhase
    public let id: UInt32
    public let channel: SourceChannel
    public let startBlock: UInt32
    public let endBlockExclusive: UInt32?
    public let reason: SourceInterruptionReason
    public let recovered: Bool?

    enum CodingKeys: String, CodingKey {
        case type, phase, id, channel, startBlock, endBlockExclusive, reason, recovered
    }
}

public struct GapPayload: Codable, Sendable {
    public let type: String
    public let channel: String
    public let startBlock: UInt32
    public let endBlockExclusive: UInt32
    public let reason: String
    public let recovered: Bool

    enum CodingKeys: String, CodingKey {
        case type, channel, startBlock, endBlockExclusive, reason, recovered
    }
}

// MARK: - Capture Frame

public enum CaptureFrame: Sendable {
    case ready(sequence: UInt32, payload: ReadyPayload)
    case pcm(sequence: UInt32, payload: Data)
    case gap(sequence: UInt32, payload: GapPayload)
    case interruption(sequence: UInt32, payload: InterruptionPayload)
    case state(sequence: UInt32, payload: StatePayload)
    case stopped(sequence: UInt32, payload: StoppedPayload)
    case error(sequence: UInt32, payload: ErrorPayload)
}

// MARK: - Byte Sink Protocol

public protocol ByteSink {
    func writeAll(_ data: Data) throws
}

// MARK: - Frame Writer

public class CaptureProtocolWriter {
    private let sink: ByteSink
    private var nextSequence: UInt32 = 0

    public init(sink: ByteSink) {
        self.sink = sink
    }

    public func writeFrame(_ frame: CaptureFrame) throws {
        let (frameType, payloadData) = try encodeFrame(frame)
        let sequence = nextSequence

        var header = Data(count: headerBytes)
        // Magic: ICAP
        header[0] = 0x49 // I
        header[1] = 0x43 // C
        header[2] = 0x41 // A
        header[3] = 0x50 // P
        // Version
        header[4] = captureProtocolVersion
        // Frame type
        header[5] = frameType.rawValue
        // Reserved bytes (must be zero)
        header[6] = 0
        header[7] = 0
        // Payload length (little-endian UInt32)
        let payloadLength = UInt32(payloadData.count)
        header[8] = UInt8(payloadLength & 0xFF)
        header[9] = UInt8((payloadLength >> 8) & 0xFF)
        header[10] = UInt8((payloadLength >> 16) & 0xFF)
        header[11] = UInt8((payloadLength >> 24) & 0xFF)
        // Sequence (little-endian UInt32)
        header[12] = UInt8(sequence & 0xFF)
        header[13] = UInt8((sequence >> 8) & 0xFF)
        header[14] = UInt8((sequence >> 16) & 0xFF)
        header[15] = UInt8((sequence >> 24) & 0xFF)

        try sink.writeAll(header)
        try sink.writeAll(payloadData)

        nextSequence &+= 1
    }

    private func encodeFrame(_ frame: CaptureFrame) throws -> (CaptureFrameType, Data) {
        switch frame {
        case .ready(_, let payload):
            let data = try JSONEncoder().encode(payload)
            return (.ready, data)
        case .pcm(_, let payload):
            return (.pcm, payload)
        case .gap(_, let payload):
            let data = try JSONEncoder().encode(payload)
            return (.gap, data)
        case .interruption(_, let payload):
            let data = try JSONEncoder().encode(payload)
            return (.interruption, data)
        case .state(_, let payload):
            let data = try JSONEncoder().encode(payload)
            return (.state, data)
        case .stopped(_, let payload):
            let data = try JSONEncoder().encode(payload)
            return (.stopped, data)
        case .error(_, let payload):
            let data = try JSONEncoder().encode(payload)
            return (.error, data)
        }
    }
}

// MARK: - Frame Decoder

public class CaptureProtocolDecoder {
    private var retained = Data()
    private var expectedSequence: UInt32 = 0
    private var sequenceExhausted = false
    private var readySeen = false
    private var stoppedSeen = false
    private var errorSeen = false
    private var persistedBlocks: UInt32 = 0
    private var pcmBlocks: UInt32 = 0
    private var gapBlocks: UInt32 = 0
    private var lastStateBlock: [SourceChannel: UInt32] = [.interviewer: 0, .you: 0]
    private var stateSeen: [SourceChannel: Bool] = [.interviewer: false, .you: false]
    private var openInterruptions: [SourceChannel: InterruptionPayload] = [:]
    private var usedInterruptionIds = Set<UInt32>()
    private var requirePcmAfterOpen = false
    private var unrecoveredClosePending = false

    public init() {}

    public func push(_ chunk: Data) throws -> [CaptureFrame] {
        if retained.count + chunk.count > 65_536 {
            throw CaptureProtocolError(code: .invalidSchema, message: "Protocol retained buffer exceeded 64 KiB.")
        }
        retained.append(chunk)

        var frames: [CaptureFrame] = []
        while retained.count >= headerBytes {
            let header = try readHeader(retained)
            if retained.count < headerBytes + Int(header.payloadLength) {
                break
            }
            let payloadStart = headerBytes
            let payloadEnd = payloadStart + Int(header.payloadLength)
            let payload = retained[payloadStart..<payloadEnd]
            let frame = try decodeFrame(
                frameType: header.frameType,
                sequence: header.sequence,
                payload: Data(payload)
            )
            retained = Data(retained[payloadEnd...])
            frames.append(frame)
        }
        return frames
    }

    public func finish() throws {
        if !retained.isEmpty {
            throw CaptureProtocolError(code: .partialFrameAtEOF, message: "Protocol stream ended with a partial frame.")
        }
    }

    // MARK: - Header Reading

    /// StrictJSONParser yields Double for every JSON number, and Swift numeric
    /// casts (`as? UInt32`) fail across types, so integer fields are extracted
    /// through this helper: exactly representable, in-range values only.
    private func uint32Value(_ value: Any?) -> UInt32? {
        if let uint = value as? UInt32 { return uint }
        guard let double = value as? Double,
              double >= 0,
              double <= Double(UInt32.max),
              double.rounded() == double else { return nil }
        return UInt32(double)
    }

    private func uint32Array(_ value: Any?) -> [UInt32]? {
        guard let array = value as? [Any] else { return nil }
        var result: [UInt32] = []
        for element in array {
            guard let uint = uint32Value(element) else { return nil }
            result.append(uint)
        }
        return result
    }

    private struct FrameHeader {
        let frameType: CaptureFrameType
        let payloadLength: UInt32
        let sequence: UInt32
    }

    private func readHeader(_ buffer: Data) throws -> FrameHeader {
        // Check magic: ICAP
        guard buffer.count >= 4,
              buffer[0] == 0x49, buffer[1] == 0x43, buffer[2] == 0x41, buffer[3] == 0x50 else {
            throw CaptureProtocolError(code: .invalidMagic, message: "Protocol frame has invalid magic.")
        }

        // Check version
        guard buffer[4] == captureProtocolVersion else {
            throw CaptureProtocolError(code: .unsupportedVersion, message: "Protocol frame has an unsupported version.")
        }

        // Check reserved bytes
        guard buffer[6] == 0, buffer[7] == 0 else {
            throw CaptureProtocolError(code: .nonzeroReservedBytes, message: "Protocol frame reserved bytes must be zero.")
        }

        // Frame type
        guard let frameType = CaptureFrameType(rawValue: buffer[5]) else {
            throw CaptureProtocolError(code: .unknownFrameType, message: "Protocol frame type is unknown.")
        }

        // Payload length (little-endian UInt32)
        let payloadLength = UInt32(buffer[8]) |
            (UInt32(buffer[9]) << 8) |
            (UInt32(buffer[10]) << 16) |
            (UInt32(buffer[11]) << 24)

        // Sequence (little-endian UInt32)
        let sequence = UInt32(buffer[12]) |
            (UInt32(buffer[13]) << 8) |
            (UInt32(buffer[14]) << 16) |
            (UInt32(buffer[15]) << 24)

        // Validate payload length
        let expectedLength = frameType == .pcm ? UInt32(pcmBlockBytes) : UInt32(maxJsonPayloadBytes)
        if payloadLength > expectedLength || (frameType == .pcm && payloadLength != UInt32(pcmBlockBytes)) {
            throw CaptureProtocolError(code: .invalidPayloadLength, message: "Protocol frame payload length is invalid.")
        }

        // Validate sequence
        if sequenceExhausted || sequence != expectedSequence {
            throw CaptureProtocolError(code: .invalidSequence, message: "Protocol sequence is not the exact successor.")
        }

        return FrameHeader(frameType: frameType, payloadLength: payloadLength, sequence: sequence)
    }

    // MARK: - Frame Decoding

    private func decodeFrame(frameType: CaptureFrameType, sequence: UInt32, payload: Data) throws -> CaptureFrame {
        if errorSeen || stoppedSeen {
            throw CaptureProtocolError(code: .terminalFrame, message: "A semantic frame followed a terminal frame.")
        }

        if unrecoveredClosePending && frameType != .stopped && frameType != .interruption {
            throw CaptureProtocolError(code: .invalidInvariant, message: "An unrecovered interruption close must end in stopped.")
        }

        let decodedPayload: Any
        if frameType == .pcm {
            decodedPayload = payload
        } else {
            decodedPayload = try decodeJsonPayload(payload)
        }

        if requirePcmAfterOpen && frameType != .pcm {
            if frameType != .interruption || !isInterruptionOpen(decodedPayload) {
                throw CaptureProtocolError(code: .invalidInvariant, message: "An interruption open must immediately precede PCM.")
            }
        }

        let frame = try validateFrame(frameType: frameType, sequence: sequence, payload: decodedPayload)
        advanceSequence()
        return frame
    }

    private func advanceSequence() {
        if expectedSequence == 0xFFFF_FFFF {
            sequenceExhausted = true
            return
        }
        expectedSequence &+= 1
    }

    // MARK: - Frame Validation

    private func validateFrame(frameType: CaptureFrameType, sequence: UInt32, payload: Any) throws -> CaptureFrame {
        if frameType != .error && !readySeen && frameType != .ready {
            throw CaptureProtocolError(code: .invalidInvariant, message: "Ready must be the first non-error frame.")
        }

        switch frameType {
        case .ready:
            if readySeen {
                throw CaptureProtocolError(code: .invalidInvariant, message: "Ready may only be emitted once.")
            }
            let ready = try validateReady(payload)
            readySeen = true
            return .ready(sequence: sequence, payload: ready)

        case .pcm:
            guard let data = payload as? Data, data.count == pcmBlockBytes else {
                throw CaptureProtocolError(code: .invalidSchema, message: "PCM payload must be exactly one stereo block.")
            }
            if persistedBlocks >= maxBlocks {
                throw CaptureProtocolError(code: .invalidInvariant, message: "PCM exceeds the RIFF block limit.")
            }
            persistedBlocks &+= 1
            pcmBlocks &+= 1
            requirePcmAfterOpen = false
            return .pcm(sequence: sequence, payload: data)

        case .gap:
            let gap = try validateGap(payload)
            persistedBlocks = gap.endBlockExclusive
            gapBlocks &+= (gap.endBlockExclusive - gap.startBlock)
            return .gap(sequence: sequence, payload: gap)

        case .interruption:
            let interruption = try validateInterruption(payload)
            return .interruption(sequence: sequence, payload: interruption)

        case .state:
            let state = try validateState(payload)
            return .state(sequence: sequence, payload: state)

        case .stopped:
            let stopped = try validateStopped(payload)
            stoppedSeen = true
            return .stopped(sequence: sequence, payload: stopped)

        case .error:
            let error = try validateError(payload)
            errorSeen = true
            return .error(sequence: sequence, payload: error)
        }
    }

    // MARK: - Payload Validation

    private func validateReady(_ value: Any) throws -> ReadyPayload {
        guard let dict = value as? [String: Any] else {
            throw CaptureProtocolError(code: .invalidSchema, message: "Ready payload must be an object.")
        }

        let allowedKeys = Set(["type", "sampleRateHz", "framesPerBlock", "encoding", "channelOrder", "firstBlock"])
        guard Set(dict.keys) == allowedKeys else {
            throw CaptureProtocolError(code: .invalidSchema, message: "Ready payload contains unknown or missing fields.")
        }

        guard dict["type"] as? String == "ready" else {
            throw CaptureProtocolError(code: .invalidSchema, message: "Ready payload type is invalid.")
        }

        // Handle both Int and Double for numeric values (JSON parser returns Double)
        guard let sampleRateHz = dict["sampleRateHz"] as? Double, sampleRateHz == 16_000 else {
            throw CaptureProtocolError(code: .invalidSchema, message: "Ready payload sampleRateHz is invalid.")
        }
        guard let framesPerBlock = dict["framesPerBlock"] as? Double, framesPerBlock == 320 else {
            throw CaptureProtocolError(code: .invalidSchema, message: "Ready payload framesPerBlock is invalid.")
        }
        guard dict["encoding"] as? String == "s16le" else {
            throw CaptureProtocolError(code: .invalidSchema, message: "Ready payload encoding is invalid.")
        }
        guard let firstBlock = dict["firstBlock"] as? Double, firstBlock == 0 else {
            throw CaptureProtocolError(code: .invalidSchema, message: "Ready payload firstBlock is invalid.")
        }
        guard let channelOrder = dict["channelOrder"] as? [String],
              channelOrder.count == 2,
              channelOrder[0] == "interviewer",
              channelOrder[1] == "you" else {
            throw CaptureProtocolError(code: .invalidSchema, message: "Ready payload channelOrder is invalid.")
        }

        return ReadyPayload(
            type: "ready",
            sampleRateHz: 16_000,
            framesPerBlock: 320,
            encoding: "s16le",
            channelOrder: ["interviewer", "you"],
            firstBlock: 0
        )
    }

    private func validateGap(_ value: Any) throws -> GapPayload {
        guard let dict = value as? [String: Any] else {
            throw CaptureProtocolError(code: .invalidSchema, message: "Gap payload must be an object.")
        }

        let allowedKeys = Set(["type", "channel", "startBlock", "endBlockExclusive", "reason", "recovered"])
        guard Set(dict.keys) == allowedKeys else {
            throw CaptureProtocolError(code: .invalidSchema, message: "Gap payload contains unknown or missing fields.")
        }

        guard dict["type"] as? String == "gap",
              dict["channel"] as? String == "capture",
              dict["reason"] as? String == "buffer-overflow",
              dict["recovered"] as? Bool == true else {
            throw CaptureProtocolError(code: .invalidInvariant, message: "Gap payload does not describe a valid contiguous timeline range.")
        }

        guard let startBlock = uint32Value(dict["startBlock"]),
              let endBlockExclusive = uint32Value(dict["endBlockExclusive"]) else {
            throw CaptureProtocolError(code: .invalidSchema, message: "Gap payload missing block indices.")
        }

        if startBlock != persistedBlocks || endBlockExclusive <= startBlock || endBlockExclusive - startBlock > 3_000 {
            throw CaptureProtocolError(code: .invalidInvariant, message: "Gap payload does not describe a valid contiguous timeline range.")
        }

        return GapPayload(
            type: "gap",
            channel: "capture",
            startBlock: startBlock,
            endBlockExclusive: endBlockExclusive,
            reason: "buffer-overflow",
            recovered: true
        )
    }

    private func validateInterruption(_ value: Any) throws -> InterruptionPayload {
        guard let dict = value as? [String: Any] else {
            throw CaptureProtocolError(code: .invalidSchema, message: "Interruption payload must be an object.")
        }

        guard let phaseStr = dict["phase"] as? String,
              let phase = InterruptionPhase(rawValue: phaseStr) else {
            throw CaptureProtocolError(code: .invalidSchema, message: "Interruption phase is invalid.")
        }

        if unrecoveredClosePending && (phase != .closed || dict["recovered"] as? Bool != false) {
            throw CaptureProtocolError(code: .invalidInvariant, message: "Only unrecovered closes may precede stopped.")
        }

        switch phase {
        case .opened:
            let allowedKeys = Set(["type", "phase", "id", "channel", "startBlock", "reason"])
            guard Set(dict.keys) == allowedKeys else {
                throw CaptureProtocolError(code: .invalidSchema, message: "Interruption open contains unknown or missing fields.")
            }

            guard dict["type"] as? String == "interruption",
                  let id = uint32Value(dict["id"]),
                  let channelStr = dict["channel"] as? String,
                  let channel = SourceChannel(rawValue: channelStr),
                  let startBlock = uint32Value(dict["startBlock"]),
                  let reasonStr = dict["reason"] as? String,
                  let reason = SourceInterruptionReason(rawValue: reasonStr) else {
                throw CaptureProtocolError(code: .invalidSchema, message: "Interruption open payload is invalid.")
            }

            if startBlock != persistedBlocks || startBlock >= maxBlocks ||
                openInterruptions[channel] != nil || usedInterruptionIds.contains(id) {
                throw CaptureProtocolError(code: .invalidInvariant, message: "Interruption open is invalid for the current session.")
            }

            let interruption = InterruptionPayload(
                type: "interruption",
                phase: .opened,
                id: id,
                channel: channel,
                startBlock: startBlock,
                endBlockExclusive: nil,
                reason: reason,
                recovered: nil
            )
            openInterruptions[channel] = interruption
            usedInterruptionIds.insert(id)
            requirePcmAfterOpen = true
            return interruption

        case .closed:
            let allowedKeys = Set(["type", "phase", "id", "channel", "startBlock", "endBlockExclusive", "reason", "recovered"])
            guard Set(dict.keys) == allowedKeys else {
                throw CaptureProtocolError(code: .invalidSchema, message: "Interruption closed contains unknown or missing fields.")
            }

            guard dict["type"] as? String == "interruption",
                  let id = uint32Value(dict["id"]),
                  let channelStr = dict["channel"] as? String,
                  let channel = SourceChannel(rawValue: channelStr),
                  let startBlock = uint32Value(dict["startBlock"]),
                  let endBlockExclusive = uint32Value(dict["endBlockExclusive"]),
                  let reasonStr = dict["reason"] as? String,
                  let reason = SourceInterruptionReason(rawValue: reasonStr),
                  let recovered = dict["recovered"] as? Bool else {
                throw CaptureProtocolError(code: .invalidSchema, message: "Interruption closed payload is invalid.")
            }

            guard let open = openInterruptions[channel],
                  open.id == id,
                  open.startBlock == startBlock,
                  open.reason == reason,
                  endBlockExclusive == persistedBlocks,
                  endBlockExclusive > startBlock else {
                throw CaptureProtocolError(code: .invalidInvariant, message: "Interruption close does not match an open range.")
            }

            let interruption = InterruptionPayload(
                type: "interruption",
                phase: .closed,
                id: id,
                channel: channel,
                startBlock: startBlock,
                endBlockExclusive: endBlockExclusive,
                reason: reason,
                recovered: recovered
            )
            openInterruptions.removeValue(forKey: channel)
            if !recovered {
                unrecoveredClosePending = true
            }
            return interruption
        }
    }

    private func validateState(_ value: Any) throws -> StatePayload {
        guard let dict = value as? [String: Any] else {
            throw CaptureProtocolError(code: .invalidSchema, message: "State payload must be an object.")
        }

        guard dict["type"] as? String == "state",
              let channelStr = dict["channel"] as? String,
              let channel = SourceChannel(rawValue: channelStr),
              let statusStr = dict["status"] as? String,
              let status = StateStatus(rawValue: statusStr),
              let effectiveBlock = uint32Value(dict["effectiveBlock"]) else {
            throw CaptureProtocolError(code: .invalidSchema, message: "State payload is invalid.")
        }

        if effectiveBlock > persistedBlocks || (stateSeen[channel] == true && effectiveBlock < (lastStateBlock[channel] ?? 0)) {
            throw CaptureProtocolError(code: .invalidInvariant, message: "State effective block is invalid for the current timeline.")
        }

        // Validate status-specific fields
        switch status {
        case .connected:
            let allowedKeys = Set(["type", "channel", "status", "effectiveBlock"])
            guard Set(dict.keys) == allowedKeys else {
                throw CaptureProtocolError(code: .invalidSchema, message: "Connected state contains unknown fields.")
            }
        case .connectedWithGap:
            let allowedKeys = Set(["type", "channel", "status", "effectiveBlock", "reason"])
            guard Set(dict.keys) == allowedKeys else {
                throw CaptureProtocolError(code: .invalidSchema, message: "Connected-with-gap state contains unknown fields.")
            }
            guard let reasonStr = dict["reason"] as? String,
                  GapReason(rawValue: reasonStr) != nil else {
                throw CaptureProtocolError(code: .invalidSchema, message: "Connected-with-gap reason is invalid.")
            }
        case .noAudioDetected:
            let allowedKeys = Set(["type", "channel", "status", "effectiveBlock", "silentBlocks"])
            guard Set(dict.keys) == allowedKeys else {
                throw CaptureProtocolError(code: .invalidSchema, message: "No-audio-detected state contains unknown fields.")
            }
            guard let silentBlocks = uint32Value(dict["silentBlocks"]), silentBlocks >= 1_500 else {
                throw CaptureProtocolError(code: .invalidInvariant, message: "No-audio state requires at least 1500 silent blocks.")
            }
        case .reconnecting, .disconnected:
            let allowedKeys = Set(["type", "channel", "status", "effectiveBlock", "reason", "attempt"])
            guard Set(dict.keys) == allowedKeys else {
                throw CaptureProtocolError(code: .invalidSchema, message: "Reconnecting/disconnected state contains unknown fields.")
            }
            guard let reasonStr = dict["reason"] as? String,
                  RecoverableReason(rawValue: reasonStr) != nil else {
                throw CaptureProtocolError(code: .invalidSchema, message: "Reconnecting/disconnected reason is invalid.")
            }
            guard let attempt = uint32Value(dict["attempt"]) else {
                throw CaptureProtocolError(code: .invalidSchema, message: "Reconnecting/disconnected attempt is invalid.")
            }
            if status == .reconnecting && attempt < 1 {
                throw CaptureProtocolError(code: .invalidInvariant, message: "Reconnecting state requires a positive attempt.")
            }
        }

        lastStateBlock[channel] = effectiveBlock
        stateSeen[channel] = true

        return StatePayload(
            type: "state",
            channel: channel,
            status: status,
            effectiveBlock: effectiveBlock,
            reason: dict["reason"] as? String,
            silentBlocks: uint32Value(dict["silentBlocks"]),
            attempt: uint32Value(dict["attempt"])
        )
    }

    private func validateStopped(_ value: Any) throws -> StoppedPayload {
        guard let dict = value as? [String: Any] else {
            throw CaptureProtocolError(code: .invalidSchema, message: "Stopped payload must be an object.")
        }

        let allowedKeys = Set(["type", "reason", "finalBlockExclusive", "pcmBlocks", "gapBlocks", "openInterruptionIds"])
        guard Set(dict.keys) == allowedKeys else {
            throw CaptureProtocolError(code: .invalidSchema, message: "Stopped payload contains unknown or missing fields.")
        }

        guard dict["type"] as? String == "stopped",
              let reasonStr = dict["reason"] as? String,
              (reasonStr == "stop" || reasonStr == "format-limit"),
              let finalBlockExclusive = uint32Value(dict["finalBlockExclusive"]),
              let pcmBlocksVal = uint32Value(dict["pcmBlocks"]),
              let gapBlocksVal = uint32Value(dict["gapBlocks"]),
              let openInterruptionIds = uint32Array(dict["openInterruptionIds"]) else {
            throw CaptureProtocolError(code: .invalidSchema, message: "Stopped payload is invalid.")
        }

        if openInterruptionIds.count != 0 ||
            !openInterruptions.isEmpty ||
            finalBlockExclusive != persistedBlocks ||
            pcmBlocksVal != pcmBlocks ||
            gapBlocksVal != gapBlocks ||
            finalBlockExclusive != pcmBlocksVal + gapBlocksVal ||
            (reasonStr == "format-limit" && finalBlockExclusive != maxBlocks) {
            throw CaptureProtocolError(code: .invalidInvariant, message: "Stopped counters do not match the accepted timeline.")
        }

        unrecoveredClosePending = false

        return StoppedPayload(
            type: "stopped",
            reason: reasonStr,
            finalBlockExclusive: finalBlockExclusive,
            pcmBlocks: pcmBlocksVal,
            gapBlocks: gapBlocksVal,
            openInterruptionIds: openInterruptionIds
        )
    }

    private func validateError(_ value: Any) throws -> ErrorPayload {
        guard let dict = value as? [String: Any] else {
            throw CaptureProtocolError(code: .invalidSchema, message: "Error payload must be an object.")
        }

        guard dict["type"] as? String == "error",
              let phaseStr = dict["phase"] as? String,
              let phase = ErrorPhase(rawValue: phaseStr),
              let codeStr = dict["code"] as? String,
              let code = ErrorCode(rawValue: codeStr),
              let terminal = dict["terminal"] as? Bool, terminal == true else {
            throw CaptureProtocolError(code: .invalidSchema, message: "Error payload is invalid.")
        }

        let withChannel = phase == .initialization && (code == .sourceStartFailed || code == .sourceTimestampUnavailable)
        let withoutChannel =
            (phase == .initialization && (code == .unsupportedFormat || code == .internalError)) ||
            (phase == .runtime && (code == .invalidControl || code == .internalError))

        guard withChannel || withoutChannel else {
            throw CaptureProtocolError(code: .invalidSchema, message: "Error phase and code are invalid.")
        }

        if withChannel {
            let allowedKeys = Set(["type", "phase", "code", "channel", "terminal"])
            guard Set(dict.keys) == allowedKeys else {
                throw CaptureProtocolError(code: .invalidSchema, message: "Error payload contains unknown fields.")
            }
            guard let channelStr = dict["channel"] as? String,
                  SourceChannel(rawValue: channelStr) != nil else {
                throw CaptureProtocolError(code: .invalidSchema, message: "Error channel is invalid.")
            }
        } else {
            let allowedKeys = Set(["type", "phase", "code", "terminal"])
            guard Set(dict.keys) == allowedKeys else {
                throw CaptureProtocolError(code: .invalidSchema, message: "Error payload contains unknown fields.")
            }
        }

        return ErrorPayload(
            type: "error",
            phase: phase,
            code: code,
            channel: dict["channel"].flatMap { $0 as? String }.flatMap { SourceChannel(rawValue: $0) },
            terminal: true
        )
    }

    // MARK: - JSON Parsing

    private func decodeJsonPayload(_ payload: Data) throws -> Any {
        guard let text = String(data: payload, encoding: .utf8) else {
            throw CaptureProtocolError(code: .malformedJSON, message: "JSON payload is not valid UTF-8.")
        }

        let parser = StrictJSONParser(input: text)
        return try parser.parse()
    }

    private func isInterruptionOpen(_ value: Any) -> Bool {
        guard let dict = value as? [String: Any] else { return false }
        return dict["phase"] as? String == "opened"
    }
}

// MARK: - Strict JSON Parser (rejects duplicate keys)

private class StrictJSONParser {
    private let input: String
    private var position: String.Index

    init(input: String) {
        self.input = input
        self.position = input.startIndex
    }

    func parse() throws -> Any {
        skipWhitespace()
        let value = try parseValue()
        skipWhitespace()
        guard position == input.endIndex else {
            throw CaptureProtocolError(code: .malformedJSON, message: "JSON payload is malformed.")
        }
        return value
    }

    private func parseValue() throws -> Any {
        skipWhitespace()
        guard position < input.endIndex else {
            throw CaptureProtocolError(code: .malformedJSON, message: "JSON payload is malformed.")
        }

        let char = input[position]
        if char == "{" { return try parseObject() }
        if char == "[" { return try parseArray() }
        if char == "\"" { return try parseString() }
        if char == "t" { return try parseLiteral("true", value: true) }
        if char == "f" { return try parseLiteral("false", value: false) }
        if char == "n" { return try parseLiteral("null", value: NSNull()) }
        if char == "-" || (char >= "0" && char <= "9") { return try parseNumber() }

        throw CaptureProtocolError(code: .malformedJSON, message: "JSON payload is malformed.")
    }

    private func parseObject() throws -> [String: Any] {
        expect("{")
        skipWhitespace()
        var result: [String: Any] = [:]
        var keys = Set<String>()

        if consume("}") { return result }

        while true {
            skipWhitespace()
            guard position < input.endIndex, input[position] == "\"" else {
                throw CaptureProtocolError(code: .malformedJSON, message: "JSON payload is malformed.")
            }
            let key = try parseString()
            if keys.contains(key) {
                throw CaptureProtocolError(code: .duplicateJSONKey, message: "JSON payload contains a duplicate key.")
            }
            keys.insert(key)
            skipWhitespace()
            expect(":")
            result[key] = try parseValue()
            skipWhitespace()
            if consume("}") { return result }
            expect(",")
        }
    }

    private func parseArray() throws -> [Any] {
        expect("[")
        skipWhitespace()
        var result: [Any] = []

        if consume("]") { return result }

        while true {
            result.append(try parseValue())
            skipWhitespace()
            if consume("]") { return result }
            expect(",")
        }
    }

    private func parseString() throws -> String {
        let start = position
        guard position < input.endIndex, input[position] == "\"" else {
            throw CaptureProtocolError(code: .malformedJSON, message: "JSON payload is malformed.")
        }
        position = input.index(after: position)
        var escaped = false

        while position < input.endIndex {
            let char = input[position]
            position = input.index(after: position)

            if !escaped && char == "\"" {
                let str = String(input[start..<position])
                // Use JSON.parse to handle escape sequences
                guard let data = str.data(using: .utf8),
                      let parsed = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]),
                      let result = parsed as? String else {
                    throw CaptureProtocolError(code: .malformedJSON, message: "JSON payload is malformed.")
                }
                return result
            }
            if !escaped && char < " " {
                throw CaptureProtocolError(code: .malformedJSON, message: "JSON payload is malformed.")
            }
            if !escaped && char == "\\" {
                escaped = true
            } else {
                escaped = false
            }
        }

        throw CaptureProtocolError(code: .malformedJSON, message: "JSON payload is malformed.")
    }

    private func parseNumber() throws -> Double {
        let start = position
        if position < input.endIndex && input[position] == "-" {
            position = input.index(after: position)
        }
        while position < input.endIndex && input[position] >= "0" && input[position] <= "9" {
            position = input.index(after: position)
        }
        if position < input.endIndex && input[position] == "." {
            position = input.index(after: position)
            while position < input.endIndex && input[position] >= "0" && input[position] <= "9" {
                position = input.index(after: position)
            }
        }
        if position < input.endIndex && (input[position] == "e" || input[position] == "E") {
            position = input.index(after: position)
            if position < input.endIndex && (input[position] == "+" || input[position] == "-") {
                position = input.index(after: position)
            }
            while position < input.endIndex && input[position] >= "0" && input[position] <= "9" {
                position = input.index(after: position)
            }
        }

        let numStr = String(input[start..<position])
        guard let value = Double(numStr), value.isFinite else {
            throw CaptureProtocolError(code: .malformedJSON, message: "JSON payload is malformed.")
        }
        return value
    }

    private func parseLiteral(_ token: String, value: Any) throws -> Any {
        let end = input.index(position, offsetBy: token.count, limitedBy: input.endIndex)
        guard let end = end, String(input[position..<end]) == token else {
            throw CaptureProtocolError(code: .malformedJSON, message: "JSON payload is malformed.")
        }
        position = end
        return value
    }

    private func skipWhitespace() {
        while position < input.endIndex {
            let char = input[position]
            if char == " " || char == "\t" || char == "\r" || char == "\n" {
                position = input.index(after: position)
            } else {
                break
            }
        }
    }

    @discardableResult
    private func expect(_ character: Character) -> Bool {
        guard position < input.endIndex, input[position] == character else {
            return false
        }
        position = input.index(after: position)
        return true
    }

    @discardableResult
    private func consume(_ character: Character) -> Bool {
        guard position < input.endIndex, input[position] == character else {
            return false
        }
        position = input.index(after: position)
        return true
    }
}
