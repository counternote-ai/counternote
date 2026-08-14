import Foundation

// MARK: - Source Health State

public enum SourceHealthState: String, Sendable {
    case connected
    case connectedWithGap = "connected-with-gap"
    case noAudioDetected = "no-audio-detected"
    case reconnecting
    case disconnected
}

// MARK: - Source Health

public class SourceHealth {
    private let channel: SourceChannel
    private var state: SourceHealthState = .connected
    private var silentBlocks: UInt32 = 0
    private var hasGap: Bool = false
    private var lastEffectiveBlock: UInt32 = 0

    public init(channel: SourceChannel) {
        self.channel = channel
    }

    /// Update health state based on PCM content.
    /// Non-zero audio resets silent counter but does NOT clear connected-with-gap.
    public func update(pcmBlock: Data, effectiveBlock: UInt32) {
        let isSilent = pcmBlock.allSatisfy { $0 == 0 }

        if isSilent {
            silentBlocks &+= 1
            if silentBlocks >= 1_500 {
                state = .noAudioDetected
            }
        } else {
            // Non-zero audio resets silent counter
            silentBlocks = 0
            if state == .noAudioDetected {
                state = .connected
            }
            // Persistent late-data: if hasGap is set, stay in connectedWithGap.
            // New PCM coverage does NOT clear the persistent gap marker.
            if !hasGap && state != .reconnecting && state != .disconnected {
                state = .connected
            }
        }

        lastEffectiveBlock = effectiveBlock
    }

    /// Mark a gap in the source
    public func markGap(effectiveBlock: UInt32) {
        hasGap = true
        state = .connectedWithGap
        lastEffectiveBlock = effectiveBlock
    }

    /// Mark source as reconnecting
    public func markReconnecting(effectiveBlock: UInt32, reason: RecoverableReason) {
        state = .reconnecting
        lastEffectiveBlock = effectiveBlock
    }

    /// Mark source as disconnected
    public func markDisconnected(effectiveBlock: UInt32, reason: RecoverableReason) {
        state = .disconnected
        lastEffectiveBlock = effectiveBlock
    }

    /// Mark source as connected again
    public func markConnected(effectiveBlock: UInt32) {
        if hasGap {
            state = .connectedWithGap
        } else {
            state = .connected
        }
        lastEffectiveBlock = effectiveBlock
    }

    /// Get current health state
    public func getState() -> SourceHealthState {
        return state
    }

    /// Get silent block count
    public func getSilentBlocks() -> UInt32 {
        return silentBlocks
    }

    /// Get last effective block
    public func getLastEffectiveBlock() -> UInt32 {
        return lastEffectiveBlock
    }

    /// Reset gap flag (used for testing or re-initialization)
    public func resetGapFlag() {
        hasGap = false
        if state == .connectedWithGap {
            state = .connected
        }
    }

    /// Generate a state payload for the protocol
    public func toStatePayload(effectiveBlock: UInt32) -> StatePayload {
        switch state {
        case .connected:
            return StatePayload(
                type: "state",
                channel: channel,
                status: .connected,
                effectiveBlock: effectiveBlock,
                reason: nil,
                silentBlocks: nil,
                attempt: nil
            )
        case .connectedWithGap:
            return StatePayload(
                type: "state",
                channel: channel,
                status: .connectedWithGap,
                effectiveBlock: effectiveBlock,
                reason: "late-data",
                silentBlocks: nil,
                attempt: nil
            )
        case .noAudioDetected:
            return StatePayload(
                type: "state",
                channel: channel,
                status: .noAudioDetected,
                effectiveBlock: effectiveBlock,
                reason: nil,
                silentBlocks: silentBlocks,
                attempt: nil
            )
        case .reconnecting:
            return StatePayload(
                type: "state",
                channel: channel,
                status: .reconnecting,
                effectiveBlock: effectiveBlock,
                reason: "callback-stall",
                silentBlocks: nil,
                attempt: 1
            )
        case .disconnected:
            return StatePayload(
                type: "state",
                channel: channel,
                status: .disconnected,
                effectiveBlock: effectiveBlock,
                reason: "stream-error",
                silentBlocks: nil,
                attempt: nil
            )
        }
    }
}
