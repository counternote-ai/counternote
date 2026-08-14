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
    private let sink: DiagnosticSink
    private let maxLineLength = 1024

    public init(sink: DiagnosticSink) {
        self.sink = sink
    }

    public func emit(level: DiagnosticLevel, code: DiagnosticCode) throws {
        let diagnostic: [String: String] = [
            "level": level.rawValue,
            "code": code.rawValue
        ]

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
