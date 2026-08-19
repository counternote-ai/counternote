import Foundation

// MARK: - Diagnostic Levels

public enum DiagnosticLevel: String, Codable, Sendable {
    case info
    case warn
    case error
}

// MARK: - Diagnostic Codes

public enum DiagnosticCode: String, Codable, Sendable {
    case helperStarted = "helper-started"
    case captureStarted = "capture-started"
    case captureStopped = "capture-stopped"
    case sourceError = "source-error"
    case sourceReconnecting = "source-reconnecting"
    case sourceConnected = "source-connected"
    case sourceDisconnected = "source-disconnected"
    case bufferOverflow = "buffer-overflow"
    case protocolError = "protocol-error"
    case persistenceError = "persistence-error"
    case sourceFailure = "source-failure"
    case sourceRestartAttempt = "source-restart-attempt"
    case sourceRestarted = "source-restarted"
    case sourceRestartFailed = "source-restart-failed"
    case sourceRestartUnverified = "source-restart-unverified"
    case helperStopping = "helper-stopping"
    case writerBacklog = "writer-backlog"
}

// MARK: - Diagnostic Sink Protocol

public protocol DiagnosticSink {
    func writeLine(_ line: String) throws
}

// MARK: - FileHandle Extension

extension FileHandle: DiagnosticSink {
    public func writeLine(_ line: String) throws {
        guard let data = (line + "\n").data(using: .utf8) else {
            return
        }
        self.write(data)
    }
}

// MARK: - Diagnostics

public class Diagnostics {
    /// Shared formatter: modern formatters are thread-safe, and diagnostics
    /// are emitted from several threads (coordinator, sinks, main).
    private static let timestampFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private let sink: DiagnosticSink
    private let maxLineLength = 1024

    public init(sink: DiagnosticSink) {
        self.sink = sink
    }

    /// Emits one JSON line: `level`, `code`, an ISO8601 `ts`, plus any
    /// `details` keys, all flat in a single object capped at 1 KiB.
    public func emit(level: DiagnosticLevel, code: DiagnosticCode, details: [String: String] = [:]) throws {
        var diagnostic: [String: String] = [
            "level": level.rawValue,
            "code": code.rawValue,
            "ts": Self.timestampFormatter.string(from: Date()),
        ]
        for (key, value) in details {
            diagnostic[key] = value
        }

        let data = try JSONSerialization.data(withJSONObject: diagnostic, options: [])
        guard var line = String(data: data, encoding: .utf8) else {
            return
        }

        // Enforce maximum line length
        if line.count > maxLineLength {
            line = String(line.prefix(maxLineLength))
        }

        try sink.writeLine(line)
    }
}
