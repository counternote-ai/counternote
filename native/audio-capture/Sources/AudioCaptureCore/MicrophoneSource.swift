import AVFoundation
import Foundation

public protocol MicrophoneSource {
    func start() throws
    func stop()
    func setCallback(_ callback: @escaping (Data, UInt64) -> Void)
    var isRunning: Bool { get }
    var deviceName: String? { get }
    func setFailureCallback(_ callback: @escaping () -> Void)
}

public extension MicrophoneSource {
    func setFailureCallback(_ callback: @escaping () -> Void) {}
}

/// Captures the default macOS input with AVAudioEngine's raw input node.
/// The tap converts each callback to the helper's 16 kHz mono s16le contract
/// before passing it to the timeline mixer.
///
/// `start()` and `stop()` are serialized through a private control queue, so a
/// `start()` can never interleave with an in-flight `stop()` (route changes
/// can make `removeTap`/`engine.stop()` block for seconds, and an interleaved
/// `start()` would no-op on the stale `running` flag). Every `start()` builds
/// a FRESH AVAudioEngine: retries after a route invalidation never reuse a
/// wedged engine. Callers may call from any thread; calls may block while a
/// serialized peer finishes — the coordinator always calls them outside its
/// own lock.
public final class MicrophoneSourceImpl: NSObject, MicrophoneSource {
    private let controlQueue = DispatchQueue(label: "InterviewAudioCapture.microphone.control")
    private var engine: AVAudioEngine?
    private let targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: 16_000,
        channels: 1,
        interleaved: true
    )!
    private var callback: ((Data, UInt64) -> Void)?
    private var failureCallback: (() -> Void)?
    private var running = false
    private var currentDeviceName: String?
    private var converter: AVAudioConverter?

    public override init() {
        super.init()
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    public func start() throws {
        try controlQueue.sync {
            guard !running else { return }
            let newEngine = AVAudioEngine()
            let input = newEngine.inputNode
            let format = input.inputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else {
                throw NativeMicrophoneError.invalidInputFormat
            }
            // The tap can fire the moment the engine starts rendering, so the
            // converter must be in place before the engine is started.
            converter = AVAudioConverter(from: format, to: targetFormat)
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(handleConfigurationChange),
                name: .AVAudioEngineConfigurationChange,
                object: newEngine
            )
            input.installTap(onBus: 0, bufferSize: 1_024, format: format) { [weak self] buffer, time in
                self?.handle(buffer: buffer, time: time)
            }
            do {
                newEngine.prepare()
                try newEngine.start()
                engine = newEngine
                currentDeviceName = "Default Input"
                running = true
            } catch {
                NotificationCenter.default.removeObserver(
                    self,
                    name: .AVAudioEngineConfigurationChange,
                    object: newEngine
                )
                input.removeTap(onBus: 0)
                converter = nil
                throw error
            }
        }
    }

    public func stop() {
        controlQueue.sync {
            guard running, let engine else { return }
            NotificationCenter.default.removeObserver(
                self,
                name: .AVAudioEngineConfigurationChange,
                object: engine
            )
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
            self.engine = nil
            converter = nil
            running = false
        }
    }

    public func setCallback(_ callback: @escaping (Data, UInt64) -> Void) {
        self.callback = callback
    }

    public func setFailureCallback(_ callback: @escaping () -> Void) {
        failureCallback = callback
    }

    public var isRunning: Bool { running }
    public var deviceName: String? { currentDeviceName }

    @objc private func handleConfigurationChange() {
        guard running else { return }
        // A default-device change invalidates the existing raw input route.
        // The coordinator stops and rebuilds it through its shared retry path.
        failureCallback?()
    }

    private func handle(buffer: AVAudioPCMBuffer, time: AVAudioTime) {
        guard time.isHostTimeValid, let converter else { return }
        let capacity = AVAudioFrameCount(
            max(1, Int((Double(buffer.frameLength) * 16_000 / buffer.format.sampleRate).rounded(.up)) + 2)
        )
        guard let output = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return }
        var consumed = false
        var conversionError: NSError?
        let status = converter.convert(to: output, error: &conversionError) { _, outStatus in
            if consumed {
                outStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            outStatus.pointee = .haveData
            return buffer
        }
        guard conversionError == nil, status != .error, output.frameLength > 0,
              let samples = output.int16ChannelData else { return }
        callback?(
            Data(bytes: samples[0], count: Int(output.frameLength) * MemoryLayout<Int16>.size),
            SystemHostClock.nanoseconds(fromMachTicks: time.hostTime)
        )
    }
}

public enum NativeMicrophoneError: Error {
    case invalidInputFormat
}
