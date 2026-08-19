import XCTest
@testable import AudioCaptureCore

final class DiagnosticsTests: XCTestCase {

    func testHelperStartedDiagnostic() throws {
        let sink = MockDiagnosticSink()
        let diagnostics = Diagnostics(sink: sink)

        try diagnostics.emit(level: .info, code: .helperStarted)

        XCTAssertEqual(sink.lines.count, 1)
        let line = sink.lines[0]

        // Verify it's valid JSON
        guard let data = line.data(using: .utf8),
              let json = try JSONSerialization.jsonObject(with: data) as? [String: String] else {
            XCTFail("Diagnostic line is not valid JSON")
            return
        }

        XCTAssertEqual(json["level"], "info")
        XCTAssertEqual(json["code"], "helper-started")
    }

    func testDiagnosticLineLength() throws {
        let sink = MockDiagnosticSink()
        let diagnostics = Diagnostics(sink: sink)

        try diagnostics.emit(level: .info, code: .helperStarted)

        // Verify line length is within limits (1024 bytes + newline)
        let line = sink.lines[0]
        XCTAssertLessThanOrEqual(line.count, 1024)
    }

    func testMultipleDiagnostics() throws {
        let sink = MockDiagnosticSink()
        let diagnostics = Diagnostics(sink: sink)

        try diagnostics.emit(level: .info, code: .helperStarted)
        try diagnostics.emit(level: .info, code: .captureStarted)
        try diagnostics.emit(level: .error, code: .sourceError)

        XCTAssertEqual(sink.lines.count, 3)
    }

    func testDiagnosticLevels() throws {
        let sink = MockDiagnosticSink()
        let diagnostics = Diagnostics(sink: sink)

        try diagnostics.emit(level: .info, code: .helperStarted)
        try diagnostics.emit(level: .warn, code: .bufferOverflow)
        try diagnostics.emit(level: .error, code: .protocolError)

        XCTAssertEqual(sink.lines.count, 3)

        // Verify each line has correct level
        let levels = sink.lines.compactMap { line -> String? in
            guard let data = line.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: String] else {
                return nil
            }
            return json["level"]
        }

        XCTAssertEqual(levels, ["info", "warn", "error"])
    }

    func testEveryLineCarriesISO8601Timestamp() throws {
        let sink = MockDiagnosticSink()
        let diagnostics = Diagnostics(sink: sink)

        try diagnostics.emit(level: .info, code: .helperStarted)

        let line = sink.lines[0]
        guard let data = line.data(using: .utf8),
              let json = try JSONSerialization.jsonObject(with: data) as? [String: String] else {
            XCTFail("Diagnostic line is not valid JSON")
            return
        }

        guard let ts = json["ts"] else {
            XCTFail("Diagnostic line is missing ts")
            return
        }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        XCTAssertNotNil(formatter.date(from: ts), "ts must be ISO8601: \(ts)")
    }

    func testDetailsAreEmittedAsFlatKeys() throws {
        let sink = MockDiagnosticSink()
        let diagnostics = Diagnostics(sink: sink)

        try diagnostics.emit(level: .warn, code: .sourceFailure, details: [
            "channel": "you",
            "reason": "route-invalidated",
        ])

        let line = sink.lines[0]
        guard let data = line.data(using: .utf8),
              let json = try JSONSerialization.jsonObject(with: data) as? [String: String] else {
            XCTFail("Diagnostic line is not valid JSON")
            return
        }

        XCTAssertEqual(json["code"], "source-failure")
        XCTAssertEqual(json["channel"], "you")
        XCTAssertEqual(json["reason"], "route-invalidated")
    }

    func testLineCapAppliesWithDetails() throws {
        let sink = MockDiagnosticSink()
        let diagnostics = Diagnostics(sink: sink)

        try diagnostics.emit(level: .warn, code: .sourceRestartFailed, details: [
            "error": String(repeating: "x", count: 4_096),
        ])

        XCTAssertEqual(sink.lines.count, 1)
        XCTAssertLessThanOrEqual(sink.lines[0].count, 1_024)
    }
}

// MARK: - Mock Diagnostic Sink

class MockDiagnosticSink: DiagnosticSink {
    var lines: [String] = []

    func writeLine(_ line: String) throws {
        lines.append(line)
    }
}
