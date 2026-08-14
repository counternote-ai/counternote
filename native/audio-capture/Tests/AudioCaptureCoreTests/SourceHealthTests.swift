import XCTest
@testable import AudioCaptureCore

final class SourceHealthTests: XCTestCase {

    func testInitialState() {
        let health = SourceHealth(channel: .interviewer)

        XCTAssertEqual(health.getState(), .connected)
        XCTAssertEqual(health.getSilentBlocks(), 0)
    }

    func testSilentBlockTracking() {
        let health = SourceHealth(channel: .interviewer)

        let silentBlock = Data(repeating: 0, count: 640)

        // Feed 1499 silent blocks - should remain connected
        for i in 0..<1499 {
            health.update(pcmBlock: silentBlock, effectiveBlock: UInt32(i))
        }
        XCTAssertEqual(health.getState(), .connected)
        XCTAssertEqual(health.getSilentBlocks(), 1499)

        // 1500th silent block should trigger no-audio-detected
        health.update(pcmBlock: silentBlock, effectiveBlock: 1499)
        XCTAssertEqual(health.getState(), .noAudioDetected)
        XCTAssertEqual(health.getSilentBlocks(), 1500)
    }

    func testSilentBlockReset() {
        let health = SourceHealth(channel: .interviewer)

        let silentBlock = Data(repeating: 0, count: 640)
        let audioBlock = Data(repeating: 1, count: 640)

        // Get to no-audio-detected state
        for i in 0..<1500 {
            health.update(pcmBlock: silentBlock, effectiveBlock: UInt32(i))
        }
        XCTAssertEqual(health.getState(), .noAudioDetected)

        // Non-audio block should reset to connected
        health.update(pcmBlock: audioBlock, effectiveBlock: 1500)
        XCTAssertEqual(health.getState(), .connected)
        XCTAssertEqual(health.getSilentBlocks(), 0)
    }

    func testGapMarking() {
        let health = SourceHealth(channel: .interviewer)

        health.markGap(effectiveBlock: 100)

        XCTAssertEqual(health.getState(), .connectedWithGap)
        XCTAssertEqual(health.getLastEffectiveBlock(), 100)
    }

    func testReconnecting() {
        let health = SourceHealth(channel: .interviewer)

        health.markReconnecting(effectiveBlock: 50, reason: .callbackStall)

        XCTAssertEqual(health.getState(), .reconnecting)
        XCTAssertEqual(health.getLastEffectiveBlock(), 50)
    }

    func testDisconnected() {
        let health = SourceHealth(channel: .interviewer)

        health.markDisconnected(effectiveBlock: 75, reason: .streamError)

        XCTAssertEqual(health.getState(), .disconnected)
        XCTAssertEqual(health.getLastEffectiveBlock(), 75)
    }

    func testReconnection() {
        let health = SourceHealth(channel: .interviewer)

        // Go to disconnected state
        health.markDisconnected(effectiveBlock: 50, reason: .streamError)
        XCTAssertEqual(health.getState(), .disconnected)

        // Reconnect
        health.markConnected(effectiveBlock: 100)
        XCTAssertEqual(health.getState(), .connected)
        XCTAssertEqual(health.getLastEffectiveBlock(), 100)
    }

    func testReconnectionWithGap() {
        let health = SourceHealth(channel: .interviewer)

        // Mark gap first
        health.markGap(effectiveBlock: 50)
        XCTAssertEqual(health.getState(), .connectedWithGap)

        // Then disconnect and reconnect
        health.markDisconnected(effectiveBlock: 75, reason: .streamError)
        health.markConnected(effectiveBlock: 100)

        // Should retain the gap state
        XCTAssertEqual(health.getState(), .connectedWithGap)
    }

    func testStatePayloadGeneration() {
        let health = SourceHealth(channel: .interviewer)

        // Connected state
        let connected = health.toStatePayload(effectiveBlock: 0)
        XCTAssertEqual(connected.status, .connected)
        XCTAssertEqual(connected.channel, .interviewer)
        XCTAssertNil(connected.reason)
        XCTAssertNil(connected.silentBlocks)

        // No-audio-detected state
        let silentBlock = Data(repeating: 0, count: 640)
        for i in 0..<1500 {
            health.update(pcmBlock: silentBlock, effectiveBlock: UInt32(i))
        }
        let noAudio = health.toStatePayload(effectiveBlock: 1500)
        XCTAssertEqual(noAudio.status, .noAudioDetected)
        XCTAssertEqual(noAudio.silentBlocks, 1500)

        // Connected-with-gap state
        let gapHealth = SourceHealth(channel: .you)
        gapHealth.markGap(effectiveBlock: 200)
        let withGap = gapHealth.toStatePayload(effectiveBlock: 200)
        XCTAssertEqual(withGap.status, .connectedWithGap)
        XCTAssertEqual(withGap.reason, "late-data")

        // Reconnecting state
        let reconHealth = SourceHealth(channel: .interviewer)
        reconHealth.markReconnecting(effectiveBlock: 300, reason: .callbackStall)
        let recon = reconHealth.toStatePayload(effectiveBlock: 300)
        XCTAssertEqual(recon.status, .reconnecting)
        XCTAssertEqual(recon.reason, "callback-stall")
        XCTAssertEqual(recon.attempt, 1)

        // Disconnected state
        let disconHealth = SourceHealth(channel: .you)
        disconHealth.markDisconnected(effectiveBlock: 400, reason: .streamError)
        let discon = disconHealth.toStatePayload(effectiveBlock: 400)
        XCTAssertEqual(discon.status, .disconnected)
        XCTAssertEqual(discon.reason, "stream-error")
    }
}
