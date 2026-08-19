import AudioCaptureCore
import Foundation

// MARK: - ByteSink for FileHandle

class FileHandleByteSink: ByteSink {
    private let handle: FileHandle

    init(_ handle: FileHandle) {
        self.handle = handle
    }

    func writeAll(_ data: Data) throws {
        handle.write(data)
    }
}

// MARK: - Stdin Control Message

struct ControlMessage: Codable {
    let version: Int
    let type: String
}

// MARK: - Main

// A dead stdout/stderr reader must fail write(2) with EPIPE inside the async
// sinks instead of killing the process with SIGPIPE (which FileHandle.write
// would translate into an uncatchable NSFileHandleOperationException).
signal(SIGPIPE, SIG_IGN)

#if CAPTURE_TEST_SEAMS
// Test-fixture mode: generate deterministic protocol output from a manifest
if CommandLine.arguments.count >= 3 && CommandLine.arguments[1] == "--test-fixture" {
    let fixturePath = CommandLine.arguments[2]

    do {
        let manifestData = try Data(contentsOf: URL(fileURLWithPath: fixturePath))
        let manifest = try JSONDecoder().decode(FixtureManifest.self, from: manifestData)

        let stdoutSink = FileHandleByteSink(FileHandle.standardOutput)
        let writer = CaptureProtocolWriter(sink: stdoutSink)
        let runner = TestFixtureRunner(manifest: manifest, writer: writer)
        try runner.run()
    } catch {
        FileHandle.standardError.write(Data(("fixture-error: \(error)\n").utf8))
        exit(1)
    }
    exit(0)
}
#endif

let stderrByteSink = AsyncByteSink(fileHandle: FileHandle.standardError)
let diagnostics = Diagnostics(sink: AsyncLineSink(byteSink: stderrByteSink))
try diagnostics.emit(level: .info, code: .helperStarted)

// MARK: - Stdin Parsing

let stdinHandle = FileHandle.standardInput
let stdoutByteSink = AsyncByteSink(fileHandle: FileHandle.standardOutput)
let writer = CaptureProtocolWriter(sink: stdoutByteSink)
let coordinator = CaptureCoordinator(
    hostClock: SystemHostClock(),
    systemAudio: SystemAudioSourceImpl(),
    microphone: MicrophoneSourceImpl(),
    writer: writer,
    diagnostics: diagnostics
)

// Surface a stalled reader: the async sink alarms once per backlog build-up,
// and the write path it protects never blocks the capture loop.
stdoutByteSink.onBacklog = { [weak stdoutByteSink] in
    let depth = stdoutByteSink?.pendingBytes ?? 0
    try? diagnostics.emit(level: .warn, code: .writerBacklog, details: ["depthBytes": String(depth)])
}

// The stopped frame is the last word: once it is enqueued, flush both async
// sinks and exit on our own instead of waiting for the parent's kill grace.
coordinator.onStopped = {
    _ = stdoutByteSink.drain(timeout: 3.0)
    _ = stderrByteSink.drain(timeout: 3.0)
    exit(0)
}
let maxLineBytes = 1024 // 1 KiB cap per line
var stdinBuffer = Data()

do {
    try coordinator.start()
} catch {
    let payload = ErrorPayload(
        type: "error",
        phase: .initialization,
        code: .sourceStartFailed,
        channel: nil,
        terminal: true
    )
    try? writer.writeFrame(.error(sequence: 0, payload: payload))
}

// Parse newline-delimited JSON from stdin
func processStdinLine(_ line: String) {
    guard let data = line.data(using: .utf8) else { return }

    // Try to parse as JSON
    guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        emitInvalidControl()
        return
    }

    // Check for stop command: {"version":1,"type":"stop"}
    if let version = json["version"] as? Int,
       let type = json["type"] as? String,
       version == 1 && type == "stop" {
        coordinator.stop()
        return
    }

    // Any other complete command is terminal invalid-control
    emitInvalidControl()
}

func emitInvalidControl() {
    let errorPayload = ErrorPayload(
        type: "error",
        phase: .runtime,
        code: .invalidControl,
        channel: nil,
        terminal: true
    )

    do {
        try writer.writeFrame(.error(sequence: 0, payload: errorPayload))
    } catch {
        // Best effort
    }
}

// Read stdin in a loop
while true {
    let data = stdinHandle.availableData

    // EOF = termination
    if data.isEmpty {
        coordinator.stopImmediately()
        break
    }

    stdinBuffer.append(data)

    // Process complete lines
    while let newlineIndex = stdinBuffer.firstIndex(of: 0x0A) { // \n
        let lineData = stdinBuffer[stdinBuffer.startIndex..<newlineIndex]
        stdinBuffer = Data(stdinBuffer[(newlineIndex + 1)...])

        // Enforce 1 KiB cap
        if lineData.count > maxLineBytes {
            // Skip oversized lines
            continue
        }

        if let line = String(data: lineData, encoding: .utf8) {
            processStdinLine(line)
        }
    }

    // Check if accumulated buffer exceeds cap (no newline found yet)
    if stdinBuffer.count > maxLineBytes {
        // Discard bytes until next newline or EOF
        stdinBuffer = Data()
    }
}

// The EOF path stopped the coordinator above; flush both async sinks so the
// final stopped frame and the trailing diagnostics actually reach the pipes
// before the process falls off the end.
_ = stdoutByteSink.drain(timeout: 3.0)
_ = stderrByteSink.drain(timeout: 3.0)
