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
public final class MicrophoneSourceImpl: NSObject, MicrophoneSource {
    private let engine = AVAudioEngine()
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
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleConfigurationChange),
            name: .AVAudioEngineConfigurationChange,
            object: engine
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    public func start() throws {
        guard !running else { return }
        let input = engine.inputNode
        let format = input.inputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw NativeMicrophoneError.invalidInputFormat
        }
        converter = AVAudioConverter(from: format, to: targetFormat)
        input.installTap(onBus: 0, bufferSize: 1_024, format: format) { [weak self] buffer, time in
            self?.handle(buffer: buffer, time: time)
        }
        do {
            engine.prepare()
            try engine.start()
            currentDeviceName = "Default Input"
            running = true
        } catch {
            input.removeTap(onBus: 0)
            converter = nil
            throw error
        }
    }

    public func stop() {
        guard running else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        converter = nil
        running = false
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
