import AudioToolbox
import CoreMedia
import Foundation
import ScreenCaptureKit

public protocol SystemAudioSource {
    func start() throws
    func stop()
    func setCallback(_ callback: @escaping (Data, UInt64) -> Void)
    var isRunning: Bool { get }
    func setFailureCallback(_ callback: @escaping () -> Void)
}

public extension SystemAudioSource {
    func setFailureCallback(_ callback: @escaping () -> Void) {}
}

/// ScreenCaptureKit system-mix source. It requests audio only and never adds a
/// video output; callbacks are normalized to the helper's 16 kHz mono s16le
/// contract before entering the shared host-time timeline.
///
/// `start()` and `stop()` are serialized through a private control queue, so a
/// `start()` can never interleave with an in-flight `stop()` and no-op on the
/// stale `running` flag. Callers may call from any thread; calls may block
/// while a serialized peer finishes — the coordinator always calls them
/// outside its own lock.
public final class SystemAudioSourceImpl: NSObject, SystemAudioSource, SCStreamOutput, SCStreamDelegate {
    private let callbackQueue = DispatchQueue(label: "CounterNoteAudioCapture.system-audio")
    private let controlQueue = DispatchQueue(label: "CounterNoteAudioCapture.system-audio.control")
    private var callback: ((Data, UInt64) -> Void)?
    private var failureCallback: (() -> Void)?
    private var stream: SCStream?
    private var running = false

    public func start() throws {
        try controlQueue.sync {
            try startOnControlQueue()
        }
    }

    public func stop() {
        controlQueue.sync {
            guard let stream else { return }
            running = false
            self.stream = nil
            stream.stopCapture { _ in }
        }
    }

    private func startOnControlQueue() throws {
        guard !running else { return }
        let started = DispatchSemaphore(value: 0)
        var startError: Error?

        SCShareableContent.getWithCompletionHandler { [weak self] content, error in
            guard let self else { started.signal(); return }
            guard error == nil, let display = content?.displays.first else {
                startError = error ?? NativeSystemAudioError.noDisplay
                started.signal()
                return
            }

            let configuration = SCStreamConfiguration()
            configuration.capturesAudio = true
            configuration.sampleRate = 16_000
            configuration.channelCount = 1
            configuration.excludesCurrentProcessAudio = true
            let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
            let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
            do {
                try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: self.callbackQueue)
            } catch {
                startError = error
                started.signal()
                return
            }
            self.stream = stream
            stream.startCapture { error in
                if let error { startError = error }
                else { self.running = true }
                started.signal()
            }
        }

        guard started.wait(timeout: .now() + 10) == .success else {
            throw NativeSystemAudioError.startTimedOut
        }
        if let startError { throw startError }
    }

    public func setCallback(_ callback: @escaping (Data, UInt64) -> Void) {
        self.callback = callback
    }

    public func setFailureCallback(_ callback: @escaping () -> Void) {
        failureCallback = callback
    }

    public var isRunning: Bool { running }

    public func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .audio,
              let synchronizationClock = stream.synchronizationClock,
              let pcm = normalizedPCM(from: sampleBuffer) else { return }
        let presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let hostTime = CMSyncConvertTime(presentationTime, from: synchronizationClock, to: CMClock.hostTimeClock)
        guard hostTime.isValid, hostTime.isNumeric else { return }
        let nanoseconds = CMTimeConvertScale(hostTime, timescale: 1_000_000_000, method: .default)
        guard nanoseconds.value >= 0 else { return }
        callback?(pcm, UInt64(nanoseconds.value))
    }

    public func stream(_ stream: SCStream, didStopWithError error: Error) {
        running = false
        failureCallback?()
    }

    private func normalizedPCM(from sampleBuffer: CMSampleBuffer) -> Data? {
        guard let description = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(description),
              let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return nil }
        let length = CMBlockBufferGetDataLength(blockBuffer)
        guard length > 0 else { return nil }
        var bytes = Data(count: length)
        let result = bytes.withUnsafeMutableBytes {
            CMBlockBufferCopyDataBytes(blockBuffer, atOffset: 0, dataLength: length, destination: $0.baseAddress!)
        }
        guard result == kCMBlockBufferNoErr else { return nil }
        let channels = max(1, Int(asbd.pointee.mChannelsPerFrame))
        let flags = asbd.pointee.mFormatFlags
        if flags & kAudioFormatFlagIsFloat != 0, asbd.pointee.mBitsPerChannel == 32 {
            let frames = bytes.count / (MemoryLayout<Float>.size * channels)
            var output = Data(count: frames * MemoryLayout<Int16>.size)
            bytes.withUnsafeBytes { source in
                output.withUnsafeMutableBytes { destination in
                    let input = source.bindMemory(to: Float.self)
                    let result = destination.bindMemory(to: Int16.self)
                    for frame in 0..<frames {
                        let sample = max(-1, min(1, input[frame * channels]))
                        result[frame] = Int16(sample * Float(Int16.max))
                    }
                }
            }
            return output
        }
        guard asbd.pointee.mBitsPerChannel == 16 else { return nil }
        if channels == 1 { return bytes }
        let frames = bytes.count / (MemoryLayout<Int16>.size * channels)
        var output = Data(count: frames * MemoryLayout<Int16>.size)
        bytes.withUnsafeBytes { source in
            output.withUnsafeMutableBytes { destination in
                let input = source.bindMemory(to: Int16.self)
                let result = destination.bindMemory(to: Int16.self)
                for frame in 0..<frames { result[frame] = input[frame * channels] }
            }
        }
        return output
    }
}

public enum NativeSystemAudioError: Error {
    case noDisplay
    case startTimedOut
}
