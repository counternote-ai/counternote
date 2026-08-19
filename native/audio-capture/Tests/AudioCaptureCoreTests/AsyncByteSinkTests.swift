import Darwin
import XCTest
@testable import AudioCaptureCore

// MARK: - Async Byte Sink Tests

final class AsyncByteSinkTests: XCTestCase {

    override func setUp() {
        super.setUp()
        // write(2) on a reader-less pipe raises SIGPIPE; the helper ignores it
        // process-wide in main.swift, and these tests exercise the same path.
        signal(SIGPIPE, SIG_IGN)
    }

    // MARK: - Helpers

    private func makePipe(file: StaticString = #filePath, line: UInt = #line) -> (read: Int32, write: Int32) {
        var fds: [Int32] = [0, 0]
        XCTAssertEqual(pipe(&fds), 0, file: file, line: line)
        return (fds[0], fds[1])
    }

    /// Writes 1 KiB chunks until the worker is stuck behind a full pipe (the
    /// test never reads), i.e. until drain times out.
    private func fillUntilBlocked(_ sink: AsyncByteSink, file: StaticString = #filePath, line: UInt = #line) {
        var drained = true
        var writes = 0
        while drained && writes < 16_384 {
            try? sink.writeAll(Data(count: 1_024))
            writes += 1
            drained = sink.drain(timeout: 0.05)
        }
        XCTAssertFalse(drained, "drain must time out while the reader never reads", file: file, line: line)
    }

    /// Reads from the pipe until the sink reports fully drained.
    private func readUntilDrained(_ sink: AsyncByteSink, readFD: Int32, file: StaticString = #filePath, line: UInt = #line) {
        var readBuffer = [UInt8](repeating: 0, count: 8_192)
        var drained = sink.drain(timeout: 0.05)
        let deadline = Date().addingTimeInterval(10)
        while !drained && Date() < deadline {
            _ = Darwin.read(readFD, &readBuffer, readBuffer.count)
            drained = sink.drain(timeout: 0.05)
        }
        XCTAssertTrue(drained, "sink should drain once the reader consumes the pipe", file: file, line: line)
    }

    // MARK: - Ordering Under Concurrent Writers

    func testConcurrentWritersPreservePerWriterByteOrder() {
        let fds = makePipe()
        let sink = AsyncByteSink(fileDescriptor: fds.write)

        let writerCount = 4
        let chunksPerWriter = 250
        DispatchQueue.concurrentPerform(iterations: writerCount) { writerID in
            for sequence in 0..<chunksPerWriter {
                var chunk = Data(count: 4)
                chunk[0] = UInt8(writerID)
                chunk[1] = UInt8(sequence >> 8)
                chunk[2] = UInt8(sequence & 0xFF)
                chunk[3] = 0xFF
                try? sink.writeAll(chunk)
            }
        }

        XCTAssertTrue(sink.drain(timeout: 5.0), "all queued bytes should be written")
        close(fds.write)

        var received = Data()
        var readBuffer = [UInt8](repeating: 0, count: 4_096)
        while true {
            let count = Darwin.read(fds.read, &readBuffer, readBuffer.count)
            if count <= 0 { break }
            received.append(contentsOf: readBuffer[0..<count])
        }
        close(fds.read)

        XCTAssertEqual(received.count, writerCount * chunksPerWriter * 4)

        // Bytes from different writers may interleave, but each writer's
        // chunks must arrive in the order that writer enqueued them.
        var nextExpected: [UInt8: Int] = [:]
        var offset = 0
        while offset + 4 <= received.count {
            let writerID = received[offset]
            let sequence = Int(received[offset + 1]) << 8 | Int(received[offset + 2])
            XCTAssertEqual(received[offset + 3], 0xFF)
            let expected = nextExpected[writerID] ?? 0
            XCTAssertEqual(sequence, expected, "writer \(writerID) chunk out of order")
            nextExpected[writerID] = expected + 1
            offset += 4
        }
        for writerID in 0..<writerCount {
            XCTAssertEqual(nextExpected[UInt8(writerID)] ?? 0, chunksPerWriter)
        }
    }

    // MARK: - Drain Semantics

    func testDrainWaitsForActualDelivery() {
        let fds = makePipe()
        let sink = AsyncByteSink(fileDescriptor: fds.write)

        try? sink.writeAll(Data(count: 4_096))
        XCTAssertTrue(sink.drain(timeout: 5.0), "drain should return once bytes reach the pipe")

        // The bytes must actually be readable from the pipe now.
        var readBuffer = [UInt8](repeating: 0, count: 4_096)
        XCTAssertEqual(Darwin.read(fds.read, &readBuffer, readBuffer.count), 4_096)

        close(fds.write)
        close(fds.read)
    }

    func testDrainTimesOutWhileReaderStalls() {
        let fds = makePipe()
        let sink = AsyncByteSink(fileDescriptor: fds.write)

        fillUntilBlocked(sink)

        // Unblock the worker by closing the reader: the pending write fails
        // with EPIPE and the sink latches failed.
        close(fds.read)
        XCTAssertTrue(sink.drain(timeout: 2.0), "failed sink drains immediately")
        close(fds.write)
    }

    // MARK: - Dead Reader

    func testClosedReaderLatchesFailureAndWritesBecomeNoOps() {
        let fds = makePipe()
        let sink = AsyncByteSink(fileDescriptor: fds.write)
        close(fds.read)

        // The first write hits EPIPE in the worker; drain waits for that
        // failure to be observed, then reports promptly.
        try? sink.writeAll(Data(count: 128))
        XCTAssertTrue(sink.drain(timeout: 2.0), "drain must not hang on a dead pipe")

        // Further writes are cheap no-ops: no throw, no block, instant drain.
        try? sink.writeAll(Data(count: 128))
        try? sink.writeAll(Data(count: 128))
        XCTAssertTrue(sink.drain(timeout: 0.5))

        close(fds.write)
    }

    /// Writes 1 KiB chunks until the one-shot backlog alarm reaches `target`.
    /// Assumes the worker is already blocked behind a full pipe, so every
    /// write grows the backlog and the alarm fires synchronously in writeAll.
    private func writeUntilAlarm(
        _ sink: AsyncByteSink,
        currentCount: () -> Int,
        target: Int,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        var writes = 0
        while currentCount() < target && writes < 256 {
            try? sink.writeAll(Data(count: 1_024))
            writes += 1
        }
        XCTAssertEqual(currentCount(), target, file: file, line: line)
    }

    // MARK: - Backlog Alarm

    func testBacklogHookFiresOnceAndRearmsAfterDrain() {
        let fds = makePipe()
        var backlogCount = 0
        let countLock = NSLock()
        // Above the transient backlog of a healthy worker (~1 chunk), below
        // any pipe capacity, so the alarm only fires once the reader stalls.
        let sink = AsyncByteSink(fileDescriptor: fds.write, backlogThresholdBytes: 8 * 1_024)
        sink.onBacklog = {
            countLock.lock()
            backlogCount += 1
            countLock.unlock()
        }
        let currentCount = { () -> Int in
            countLock.lock()
            defer { countLock.unlock() }
            return backlogCount
        }

        // Block the worker behind a full pipe, then grow the backlog past the
        // threshold: exactly one alarm per build-up, however many writes.
        fillUntilBlocked(sink)
        writeUntilAlarm(sink, currentCount: currentCount, target: 1)
        try? sink.writeAll(Data(count: 1_024))
        try? sink.writeAll(Data(count: 1_024))
        XCTAssertEqual(currentCount(), 1, "one alarm per backlog build-up, not per write")

        // Draining fully re-arms the alarm.
        readUntilDrained(sink, readFD: fds.read)

        // Block the worker again: the alarm fires a second time.
        fillUntilBlocked(sink)
        writeUntilAlarm(sink, currentCount: currentCount, target: 2)
        XCTAssertEqual(currentCount(), 2, "alarm must re-arm after the backlog fully drains")

        close(fds.read)
        XCTAssertTrue(sink.drain(timeout: 2.0))
        close(fds.write)
    }

    // MARK: - Async Line Sink

    func testAsyncLineSinkDeliversLines() {
        let fds = makePipe()
        let byteSink = AsyncByteSink(fileDescriptor: fds.write)
        let lineSink = AsyncLineSink(byteSink: byteSink)

        try? lineSink.writeLine("{\"code\":\"helper-started\"}")
        try? lineSink.writeLine("{\"code\":\"capture-stopped\"}")
        XCTAssertTrue(byteSink.drain(timeout: 5.0))
        close(fds.write)

        var received = Data()
        var readBuffer = [UInt8](repeating: 0, count: 1_024)
        while true {
            let count = Darwin.read(fds.read, &readBuffer, readBuffer.count)
            if count <= 0 { break }
            received.append(contentsOf: readBuffer[0..<count])
        }
        close(fds.read)

        let text = String(data: received, encoding: .utf8) ?? ""
        XCTAssertEqual(text, "{\"code\":\"helper-started\"}\n{\"code\":\"capture-stopped\"}\n")
    }
}
