import Foundation

// MARK: - PCM Format

public struct PCMFormat: Sendable {
    public let sampleRate: Double
    public let channels: Int
    public let bitsPerSample: Int

    public init(sampleRate: Double, channels: Int, bitsPerSample: Int) {
        self.sampleRate = sampleRate
        self.channels = channels
        self.bitsPerSample = bitsPerSample
    }
}

// MARK: - PCM Converter

public class PCMConverter {
    private let sourceFormat: PCMFormat
    private let targetFormat: PCMFormat

    public init(sourceFormat: PCMFormat, targetFormat: PCMFormat) {
        self.sourceFormat = sourceFormat
        self.targetFormat = targetFormat
    }

    /// Convert PCM data from source format to target format.
    /// Uses linear interpolation for resampling when sample rates differ.
    /// Returns nil if conversion fails.
    public func convert(_ input: Data) -> Data? {
        guard sourceFormat.bitsPerSample == 16 && targetFormat.bitsPerSample == 16 else {
            return nil
        }

        // Same sample rate: passthrough
        if sourceFormat.sampleRate == targetFormat.sampleRate {
            return input
        }

        // Linear interpolation resampling
        let inputSamples = input.count / 2
        let ratio = sourceFormat.sampleRate / targetFormat.sampleRate
        let outputSamples = Int(Double(inputSamples) / ratio)

        guard outputSamples > 0 else { return Data() }

        var output = Data(count: outputSamples * 2)

        input.withUnsafeBytes { srcBytes in
            output.withUnsafeMutableBytes { dstBytes in
                let src = srcBytes.bindMemory(to: Int16.self)
                let dst = dstBytes.bindMemory(to: Int16.self)

                for i in 0..<outputSamples {
                    let srcPos = Double(i) * ratio
                    let srcIndex = Int(srcPos)
                    let frac = srcPos - Double(srcIndex)

                    let sample0: Double
                    let sample1: Double

                    if srcIndex < inputSamples {
                        sample0 = Double(src[srcIndex])
                    } else {
                        sample0 = 0
                    }

                    if srcIndex + 1 < inputSamples {
                        sample1 = Double(src[srcIndex + 1])
                    } else {
                        sample1 = sample0
                    }

                    // Linear interpolation
                    let interpolated = sample0 + frac * (sample1 - sample0)
                    let clamped = max(Double(Int16.min), min(Double(Int16.max), interpolated))
                    dst[i] = Int16(clamped)
                }
            }
        }

        return output
    }
}

// MARK: - Mono to Stereo Interleaver

public class StereoInterleaver {
    public init() {}

    /// Interleave two mono channels into stereo
    public func interleave(left: Data, right: Data) -> Data {
        let sampleCount = min(left.count, right.count) / 2
        var stereo = Data(count: sampleCount * 4) // 2 channels * 2 bytes per sample

        for i in 0..<sampleCount {
            let leftSample = left.withUnsafeBytes { bytes in
                bytes.load(fromByteOffset: i * 2, as: Int16.self)
            }
            let rightSample = right.withUnsafeBytes { bytes in
                bytes.load(fromByteOffset: i * 2, as: Int16.self)
            }

            stereo.withUnsafeMutableBytes { bytes in
                bytes.storeBytes(of: leftSample, toByteOffset: i * 4, as: Int16.self)
                bytes.storeBytes(of: rightSample, toByteOffset: i * 4 + 2, as: Int16.self)
            }
        }

        return stereo
    }

    /// Deinterleave stereo into two mono channels
    public func deinterleave(stereo: Data) -> (left: Data, right: Data) {
        let sampleCount = stereo.count / 4 // 2 channels * 2 bytes per sample
        var left = Data(count: sampleCount * 2)
        var right = Data(count: sampleCount * 2)

        for i in 0..<sampleCount {
            let leftSample = stereo.withUnsafeBytes { bytes in
                bytes.load(fromByteOffset: i * 4, as: Int16.self)
            }
            let rightSample = stereo.withUnsafeBytes { bytes in
                bytes.load(fromByteOffset: i * 4 + 2, as: Int16.self)
            }

            left.withUnsafeMutableBytes { bytes in
                bytes.storeBytes(of: leftSample, toByteOffset: i * 2, as: Int16.self)
            }
            right.withUnsafeMutableBytes { bytes in
                bytes.storeBytes(of: rightSample, toByteOffset: i * 2, as: Int16.self)
            }
        }

        return (left, right)
    }
}
