import XCTest
@testable import AudioCaptureCore

final class CaptureProtocolTests: XCTestCase {

    // MARK: - Test Helpers

    private func loadFixture(name: String) throws -> [String: Any] {
        // Locate fixtures relative to this test file (Tests/AudioCaptureCoreTests -> Tests/Fixtures)
        let testFile = URL(fileURLWithPath: #filePath)
        let fixturesURL = testFile
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures")
            .appendingPathComponent("\(name).json")

        let data = try Data(contentsOf: fixturesURL)
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NSError(domain: "Test", code: 2, userInfo: [NSLocalizedDescriptionKey: "Invalid JSON"])
        }
        return json
    }

    private func testCase(from fixture: [String: Any], name: String) throws -> (frames: [Data], outcome: String) {
        guard let cases = fixture["cases"] as? [[String: Any]],
              let testCase = cases.first(where: { $0["name"] as? String == name }),
              let framesBase64 = testCase["frames"] as? [String],
              let outcome = testCase["outcome"] as? String else {
            throw NSError(domain: "Test", code: 3, userInfo: [NSLocalizedDescriptionKey: "Test case not found: \(name)"])
        }

        let frames = framesBase64.compactMap { Data(base64Encoded: $0) }
        return (frames, outcome)
    }

    // MARK: - Fixture Tests

    func testValidReady() throws {
        let fixture = try loadFixture(name: "protocol-v1")
        let (frames, outcome) = try testCase(from: fixture, name: "valid-ready")
        XCTAssertEqual(outcome, "ok")

        let decoder = CaptureProtocolDecoder()
        var results: [CaptureFrame] = []
        for frame in frames {
            let decoded = try decoder.push(frame)
            results.append(contentsOf: decoded)
        }
        try decoder.finish()

        XCTAssertEqual(results.count, 1)
        guard case .ready(let sequence, let payload) = results[0] else {
            XCTFail("Expected ready frame")
            return
        }
        XCTAssertEqual(sequence, 0)
        XCTAssertEqual(payload.sampleRateHz, 16_000)
        XCTAssertEqual(payload.framesPerBlock, 320)
        XCTAssertEqual(payload.encoding, "s16le")
        XCTAssertEqual(payload.channelOrder, ["interviewer", "you"])
        XCTAssertEqual(payload.firstBlock, 0)
    }

    func testValidInitError() throws {
        let fixture = try loadFixture(name: "protocol-v1")
        let (frames, outcome) = try testCase(from: fixture, name: "valid-init-error")
        XCTAssertEqual(outcome, "ok")

        let decoder = CaptureProtocolDecoder()
        var results: [CaptureFrame] = []
        for frame in frames {
            let decoded = try decoder.push(frame)
            results.append(contentsOf: decoded)
        }
        try decoder.finish()

        XCTAssertEqual(results.count, 1)
        guard case .error(_, let payload) = results[0] else {
            XCTFail("Expected error frame")
            return
        }
        XCTAssertEqual(payload.phase, .initialization)
        XCTAssertEqual(payload.code, .unsupportedFormat)
        XCTAssertEqual(payload.terminal, true)
    }

    func testWrongMagic() throws {
        let fixture = try loadFixture(name: "protocol-v1")
        let (frames, outcome) = try testCase(from: fixture, name: "wrong-magic")
        XCTAssertEqual(outcome, "INVALID_MAGIC")

        let decoder = CaptureProtocolDecoder()
        XCTAssertThrowsError(try decoder.push(frames[0])) { error in
            guard let protocolError = error as? CaptureProtocolError else {
                XCTFail("Expected CaptureProtocolError")
                return
            }
            XCTAssertEqual(protocolError.code, .invalidMagic)
        }
    }

    func testWrongVersion() throws {
        let fixture = try loadFixture(name: "protocol-v1")
        let (frames, outcome) = try testCase(from: fixture, name: "wrong-version")
        XCTAssertEqual(outcome, "UNSUPPORTED_VERSION")

        let decoder = CaptureProtocolDecoder()
        XCTAssertThrowsError(try decoder.push(frames[0])) { error in
            guard let protocolError = error as? CaptureProtocolError else {
                XCTFail("Expected CaptureProtocolError")
                return
            }
            XCTAssertEqual(protocolError.code, .unsupportedVersion)
        }
    }

    func testNonzeroReserved() throws {
        let fixture = try loadFixture(name: "protocol-v1")
        let (frames, outcome) = try testCase(from: fixture, name: "nonzero-reserved")
        XCTAssertEqual(outcome, "NONZERO_RESERVED_BYTES")

        let decoder = CaptureProtocolDecoder()
        XCTAssertThrowsError(try decoder.push(frames[0])) { error in
            guard let protocolError = error as? CaptureProtocolError else {
                XCTFail("Expected CaptureProtocolError")
                return
            }
            XCTAssertEqual(protocolError.code, .nonzeroReservedBytes)
        }
    }

    func testOversizedJsonLength() throws {
        let fixture = try loadFixture(name: "protocol-v1")
        let (frames, outcome) = try testCase(from: fixture, name: "oversized-json-length")
        XCTAssertEqual(outcome, "INVALID_PAYLOAD_LENGTH")

        let decoder = CaptureProtocolDecoder()
        XCTAssertThrowsError(try decoder.push(frames[0])) { error in
            guard let protocolError = error as? CaptureProtocolError else {
                XCTFail("Expected CaptureProtocolError")
                return
            }
            XCTAssertEqual(protocolError.code, .invalidPayloadLength)
        }
    }

    func testMalformedJSON() throws {
        let fixture = try loadFixture(name: "protocol-v1")
        let (frames, outcome) = try testCase(from: fixture, name: "malformed-json")
        XCTAssertEqual(outcome, "MALFORMED_JSON")

        let decoder = CaptureProtocolDecoder()
        XCTAssertThrowsError(try decoder.push(frames[0])) { error in
            guard let protocolError = error as? CaptureProtocolError else {
                XCTFail("Expected CaptureProtocolError")
                return
            }
            XCTAssertEqual(protocolError.code, .malformedJSON)
        }
    }

    func testDuplicateKey() throws {
        let fixture = try loadFixture(name: "protocol-v1")
        let (frames, outcome) = try testCase(from: fixture, name: "duplicate-key")
        XCTAssertEqual(outcome, "DUPLICATE_JSON_KEY")

        let decoder = CaptureProtocolDecoder()
        XCTAssertThrowsError(try decoder.push(frames[0])) { error in
            guard let protocolError = error as? CaptureProtocolError else {
                XCTFail("Expected CaptureProtocolError")
                return
            }
            XCTAssertEqual(protocolError.code, .duplicateJSONKey)
        }
    }

    func testUnknownKey() throws {
        let fixture = try loadFixture(name: "protocol-v1")
        let (frames, outcome) = try testCase(from: fixture, name: "unknown-key")
        XCTAssertEqual(outcome, "INVALID_SCHEMA")

        let decoder = CaptureProtocolDecoder()
        XCTAssertThrowsError(try decoder.push(frames[0])) { error in
            guard let protocolError = error as? CaptureProtocolError else {
                XCTFail("Expected CaptureProtocolError")
                return
            }
            XCTAssertEqual(protocolError.code, .invalidSchema)
        }
    }

    func testExplicitNull() throws {
        let fixture = try loadFixture(name: "protocol-v1")
        let (frames, outcome) = try testCase(from: fixture, name: "explicit-null")
        XCTAssertEqual(outcome, "INVALID_SCHEMA")

        let decoder = CaptureProtocolDecoder()
        XCTAssertThrowsError(try decoder.push(frames[0])) { error in
            guard let protocolError = error as? CaptureProtocolError else {
                XCTFail("Expected CaptureProtocolError")
                return
            }
            XCTAssertEqual(protocolError.code, .invalidSchema)
        }
    }

    func testNoninteger() throws {
        let fixture = try loadFixture(name: "protocol-v1")
        let (frames, outcome) = try testCase(from: fixture, name: "noninteger")
        XCTAssertEqual(outcome, "INVALID_SCHEMA")

        let decoder = CaptureProtocolDecoder()
        XCTAssertThrowsError(try decoder.push(frames[0])) { error in
            guard let protocolError = error as? CaptureProtocolError else {
                XCTFail("Expected CaptureProtocolError")
                return
            }
            XCTAssertEqual(protocolError.code, .invalidSchema)
        }
    }

    // MARK: - Sequence Tests

    func testSequenceStartsAtZero() throws {
        let decoder = CaptureProtocolDecoder()
        let readyFrame = makeValidReadyFrame()

        let results = try decoder.push(readyFrame)
        XCTAssertEqual(results.count, 1)
        guard case .ready(let sequence, _) = results[0] else {
            XCTFail("Expected ready frame")
            return
        }
        XCTAssertEqual(sequence, 0)
    }

    func testSequenceIncrements() throws {
        let decoder = CaptureProtocolDecoder()

        let readyFrame = makeValidReadyFrame()
        let results1 = try decoder.push(readyFrame)
        XCTAssertEqual(results1.count, 1)

        // Create a valid error frame (which can follow ready)
        let errorFrame = makeValidErrorFrame(phase: "runtime", code: "invalid-control")
        let results2 = try decoder.push(errorFrame)
        XCTAssertEqual(results2.count, 1)

        guard case .error(let sequence, _) = results2[0] else {
            XCTFail("Expected error frame")
            return
        }
        XCTAssertEqual(sequence, 1)
    }

    func testSequenceNoWrap() throws {
        let decoder = CaptureProtocolDecoder()

        // Push a ready frame at sequence 0, advancing expectedSequence to 1
        let readyFrame = makeValidReadyFrame()
        _ = try decoder.push(readyFrame)

        // Attempt to push a frame with sequence at the uint32 boundary (0xFFFF_FFFF).
        // The decoder expects sequence 1, so this must be rejected.
        // This exercises the sequence comparison logic near the upper bound.
        let boundaryFrame = makeErrorFrame(sequence: 0xFFFF_FFFF, phase: "runtime", code: "invalid-control")
        XCTAssertThrowsError(try decoder.push(boundaryFrame)) { error in
            guard let protocolError = error as? CaptureProtocolError else {
                XCTFail("Expected CaptureProtocolError")
                return
            }
            XCTAssertEqual(protocolError.code, .invalidSequence)
        }

        // Verify that a correct sequence is accepted when using a fresh decoder
        let freshDecoder = CaptureProtocolDecoder()
        _ = try freshDecoder.push(readyFrame)
        let validFrame = makeErrorFrame(sequence: 1, phase: "runtime", code: "invalid-control")
        let results = try freshDecoder.push(validFrame)
        XCTAssertEqual(results.count, 1)
        guard case .error(let sequence, _) = results[0] else {
            XCTFail("Expected error frame")
            return
        }
        XCTAssertEqual(sequence, 1)
    }

    // MARK: - Writer Tests

    func testWriterErrorPropagation() throws {
        let sink = FailingByteSink(error: NSError(domain: "Test", code: 1, userInfo: [NSLocalizedDescriptionKey: "write failed"]))
        let writer = CaptureProtocolWriter(sink: sink)

        let readyPayload = ReadyPayload(
            type: "ready",
            sampleRateHz: 16_000,
            framesPerBlock: 320,
            encoding: "s16le",
            channelOrder: ["interviewer", "you"],
            firstBlock: 0
        )

        XCTAssertThrowsError(try writer.writeFrame(.ready(sequence: 0, payload: readyPayload))) { error in
            let nsError = error as NSError
            XCTAssertEqual(nsError.domain, "Test")
            XCTAssertEqual(nsError.code, 1)
        }
    }

    func testWriterRoundtrip() throws {
        let sink = MockByteSink()
        let writer = CaptureProtocolWriter(sink: sink)

        let readyPayload = ReadyPayload(
            type: "ready",
            sampleRateHz: 16_000,
            framesPerBlock: 320,
            encoding: "s16le",
            channelOrder: ["interviewer", "you"],
            firstBlock: 0
        )

        try writer.writeFrame(.ready(sequence: 0, payload: readyPayload))

        // Verify the written data can be decoded
        let decoder = CaptureProtocolDecoder()
        let frames = try decoder.push(sink.writtenData)
        XCTAssertEqual(frames.count, 1)

        guard case .ready(let sequence, let payload) = frames[0] else {
            XCTFail("Expected ready frame")
            return
        }
        XCTAssertEqual(sequence, 0)
        XCTAssertEqual(payload.sampleRateHz, 16_000)
    }

    // MARK: - Helper Methods

    private func makeValidReadyFrame() -> Data {
        let payload: [String: Any] = [
            "type": "ready",
            "sampleRateHz": 16_000,
            "framesPerBlock": 320,
            "encoding": "s16le",
            "channelOrder": ["interviewer", "you"],
            "firstBlock": 0
        ]
        let jsonData = try! JSONSerialization.data(withJSONObject: payload)
        return makeFrame(type: 0x01, sequence: 0, payload: jsonData)
    }

    private func makeValidErrorFrame(phase: String, code: String) -> Data {
        return makeErrorFrame(sequence: 1, phase: phase, code: code)
    }

    private func makeErrorFrame(sequence: UInt32, phase: String, code: String) -> Data {
        let payload: [String: Any] = [
            "type": "error",
            "phase": phase,
            "code": code,
            "terminal": true
        ]
        let jsonData = try! JSONSerialization.data(withJSONObject: payload)
        return makeFrame(type: 0x07, sequence: sequence, payload: jsonData)
    }

    private func makeFrame(type: UInt8, sequence: UInt32, payload: Data) -> Data {
        var header = Data(count: 16)
        // Magic: ICAP
        header[0] = 0x49
        header[1] = 0x43
        header[2] = 0x41
        header[3] = 0x50
        // Version
        header[4] = 1
        // Frame type
        header[5] = type
        // Reserved
        header[6] = 0
        header[7] = 0
        // Payload length (little-endian)
        let length = UInt32(payload.count)
        header[8] = UInt8(length & 0xFF)
        header[9] = UInt8((length >> 8) & 0xFF)
        header[10] = UInt8((length >> 16) & 0xFF)
        header[11] = UInt8((length >> 24) & 0xFF)
        // Sequence (little-endian)
        header[12] = UInt8(sequence & 0xFF)
        header[13] = UInt8((sequence >> 8) & 0xFF)
        header[14] = UInt8((sequence >> 16) & 0xFF)
        header[15] = UInt8((sequence >> 24) & 0xFF)

        return header + payload
    }
}

// MARK: - Mock Byte Sink

class MockByteSink: ByteSink {
    var writtenData = Data()

    func writeAll(_ data: Data) throws {
        writtenData.append(data)
    }
}

class FailingByteSink: ByteSink {
    private let error: Error

    init(error: Error) {
        self.error = error
    }

    func writeAll(_ data: Data) throws {
        throw error
    }
}
