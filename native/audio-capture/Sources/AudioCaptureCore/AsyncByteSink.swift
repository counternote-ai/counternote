import Darwin
import Foundation

// MARK: - Async Byte Sink

/// A `ByteSink` that never blocks its caller on pipe I/O. `writeAll` appends
/// to an in-memory buffer under a small lock; a dedicated serial worker
/// performs the actual blocking `write(2)` loop. Callers run under the
/// coordinator lock, so a stalled pipe reader must never reach them — with
/// SIGPIPE ignored process-wide, a dead reader fails `write(2)` with EPIPE and
/// latches the sink into a failed state where writes become cheap no-ops that
/// return normally instead of throwing.
public final class AsyncByteSink: ByteSink {
    /// Default backlog alarm threshold: 500 protocol frames (~10 s of audio).
    public static let defaultBacklogThresholdBytes = 500 * (headerBytes + pcmBlockBytes)

    private let fileDescriptor: Int32
    private let fileHandle: FileHandle?
    private let condition = NSCondition()
    private var buffer = Data()
    private var backlogBytes = 0
    private var writing = false
    private var failed = false
    private var backlogNotified = false
    private let backlogThresholdBytes: Int

    /// Fires once when the pending backlog first crosses the threshold, then
    /// re-arms only after the backlog fully drains. Invoked on the caller's
    /// thread, outside the internal lock.
    public var onBacklog: (() -> Void)?

    /// Bytes accepted but not yet written to the descriptor. Diagnostic only.
    public var pendingBytes: Int {
        condition.lock()
        defer { condition.unlock() }
        return backlogBytes
    }

    public init(
        fileHandle: FileHandle,
        backlogThresholdBytes: Int = AsyncByteSink.defaultBacklogThresholdBytes,
        onBacklog: (() -> Void)? = nil
    ) {
        self.fileDescriptor = fileHandle.fileDescriptor
        self.fileHandle = fileHandle
        self.backlogThresholdBytes = backlogThresholdBytes
        self.onBacklog = onBacklog
        startWorker()
    }

    public init(
        fileDescriptor: Int32,
        backlogThresholdBytes: Int = AsyncByteSink.defaultBacklogThresholdBytes,
        onBacklog: (() -> Void)? = nil
    ) {
        self.fileDescriptor = fileDescriptor
        self.fileHandle = nil
        self.backlogThresholdBytes = backlogThresholdBytes
        self.onBacklog = onBacklog
        startWorker()
    }

    // MARK: - ByteSink

    /// Enqueues bytes for the worker. Never blocks on pipe I/O and never
    /// throws: once the descriptor has failed, writes are silent no-ops so
    /// callers under the coordinator lock are never disturbed.
    public func writeAll(_ data: Data) throws {
        condition.lock()
        if failed {
            condition.unlock()
            return
        }
        buffer.append(data)
        backlogBytes += data.count
        let shouldNotify = !backlogNotified && backlogBytes >= backlogThresholdBytes
        if shouldNotify { backlogNotified = true }
        condition.signal()
        condition.unlock()

        if shouldNotify { onBacklog?() }
    }

    // MARK: - Drain

    /// Blocks until every buffered byte has been written, the sink has failed,
    /// or `timeout` elapses. Returns true when nothing remains to deliver.
    /// Used before process exit so terminal frames actually reach the pipe.
    public func drain(timeout: TimeInterval) -> Bool {
        condition.lock()
        let deadline = Date().addingTimeInterval(timeout)
        while !failed && (!buffer.isEmpty || writing) && Date() < deadline {
            condition.wait(until: deadline)
        }
        let drained = failed || (buffer.isEmpty && !writing)
        condition.unlock()
        return drained
    }

    // MARK: - Worker

    private func startWorker() {
        // The loop runs for the sink's lifetime and intentionally retains it:
        // the sink is a process-lifetime object and the worker must outlive
        // every writer.
        DispatchQueue(label: "InterviewAudioCapture.async-byte-sink.\(fileDescriptor)").async {
            self.workerLoop()
        }
    }

    private func workerLoop() {
        while true {
            condition.lock()
            while buffer.isEmpty && !failed {
                condition.wait()
            }
            if failed {
                condition.unlock()
                return
            }
            let chunk = buffer
            buffer = Data()
            writing = true
            condition.unlock()

            if writeToDescriptor(chunk) {
                condition.lock()
                backlogBytes -= chunk.count
                if backlogBytes == 0 {
                    // Backlog fully drained: re-arm the one-shot alarm.
                    backlogNotified = false
                }
                writing = false
                condition.broadcast()
                condition.unlock()
            } else {
                condition.lock()
                failed = true
                buffer.removeAll()
                backlogBytes = 0
                writing = false
                condition.broadcast()
                condition.unlock()
                return
            }
        }
    }

    /// Writes every byte with `write(2)`, tolerating EINTR. Returns false on a
    /// terminal error (EPIPE once the reader is gone, EBADF, ...).
    private func writeToDescriptor(_ data: Data) -> Bool {
        var written = 0
        while written < data.count {
            let result = data.withUnsafeBytes { pointer -> Int in
                guard let baseAddress = pointer.baseAddress else { return -1 }
                return Darwin.write(fileDescriptor, baseAddress.advanced(by: written), data.count - written)
            }
            if result < 0 {
                if errno == EINTR { continue }
                return false
            }
            if result == 0 { return false }
            written += result
        }
        return true
    }
}

// MARK: - Async Line Sink

/// `DiagnosticSink` adapter over an `AsyncByteSink`: diagnostic lines take the
/// same non-blocking path as protocol frames, so stderr backpressure can never
/// stall a `Diagnostics` caller.
public final class AsyncLineSink: DiagnosticSink {
    private let byteSink: AsyncByteSink

    public init(byteSink: AsyncByteSink) {
        self.byteSink = byteSink
    }

    public convenience init(fileHandle: FileHandle) {
        self.init(byteSink: AsyncByteSink(fileHandle: fileHandle))
    }

    public func writeLine(_ line: String) throws {
        guard let data = (line + "\n").data(using: .utf8) else { return }
        try byteSink.writeAll(data)
    }
}
