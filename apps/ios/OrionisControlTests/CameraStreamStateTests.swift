import XCTest

@testable import OrionisControl

final class CameraStreamStateTests: XCTestCase {
    func testOnlyLiveMayBeLabelledLive() {
        XCTAssertTrue(CameraStreamState.live.isLive)
        for state: CameraStreamState in [
            .idle, .connecting, .buffering, .paused, .reconnecting(attempt: 1),
            .offline(reason: nil), .authenticationFailed,
            .unsupported(protocol: .webrtc, detail: "d"), .failed(reason: "r"),
        ] {
            XCTAssertFalse(state.isLive, "\(state) must not be presented as live")
        }
    }

    func testLastFrameIsHeldOnlyWhileRecoveryIsPlausible() {
        XCTAssertTrue(CameraStreamState.reconnecting(attempt: 2).showsLastFrame)
        XCTAssertTrue(CameraStreamState.buffering.showsLastFrame)
        XCTAssertTrue(CameraStreamState.paused.showsLastFrame)
        // A camera that is offline or failed must not keep a stale frame on screen.
        XCTAssertFalse(CameraStreamState.offline(reason: "offline").showsLastFrame)
        XCTAssertFalse(CameraStreamState.failed(reason: "gone").showsLastFrame)
        XCTAssertFalse(CameraStreamState.live.showsLastFrame)
    }

    func testTerminalStatesStopAutomaticWork() {
        for state: CameraStreamState in [
            .idle, .offline(reason: nil), .authenticationFailed,
            .unsupported(protocol: .mjpeg, detail: "d"), .failed(reason: "r"),
        ] {
            XCTAssertTrue(state.isTerminal, "\(state) should be terminal")
        }
        for state: CameraStreamState in [
            .connecting, .buffering, .live, .paused, .reconnecting(attempt: 1),
        ] {
            XCTAssertFalse(state.isTerminal, "\(state) should not be terminal")
        }
    }

    func testStatusTextNeverLeaksInternalDetail() {
        let detail = "AVFoundationErrorDomain -11800 token=secret"
        let state = CameraStreamState.unsupported(protocol: .webrtc, detail: detail)
        XCTAssertFalse(state.statusText.contains("secret"))
        XCTAssertFalse(CameraStreamState.failed(reason: detail).statusText.contains("secret"))
    }

    func testReconnectDelayBacksOffAndClamps() {
        let policy = ReconnectPolicy(
            maxAttempts: 5, baseDelay: .seconds(1), maxDelay: .seconds(8))
        XCTAssertEqual(policy.delay(forAttempt: 1), .seconds(1))
        XCTAssertEqual(policy.delay(forAttempt: 2), .seconds(2))
        XCTAssertEqual(policy.delay(forAttempt: 3), .seconds(4))
        XCTAssertEqual(policy.delay(forAttempt: 4), .seconds(8))
        // Clamped, not unbounded.
        XCTAssertEqual(policy.delay(forAttempt: 5), .seconds(8))
        XCTAssertEqual(policy.delay(forAttempt: 40), .seconds(8))
    }

    func testReconnectStopsAfterMaxAttempts() {
        let policy = ReconnectPolicy(maxAttempts: 3)
        XCTAssertTrue(policy.shouldRetry(afterAttempt: 1))
        XCTAssertTrue(policy.shouldRetry(afterAttempt: 2))
        XCTAssertFalse(policy.shouldRetry(afterAttempt: 3), "must not loop forever")
        XCTAssertFalse(policy.shouldRetry(afterAttempt: 99))
    }

    func testWebRTCFrameHealthIgnoresJitterButBoundsFrozenStreamRecovery() {
        let policy = WebRTCFrameHealthPolicy(staleTolerance: 5, maxRenegotiations: 2)
        XCTAssertFalse(policy.isFrozen(staleFor: nil))
        XCTAssertFalse(policy.isFrozen(staleFor: 4.99))
        XCTAssertTrue(policy.isFrozen(staleFor: 5))
        XCTAssertTrue(policy.shouldRenegotiate(afterRecoveries: 0))
        XCTAssertTrue(policy.shouldRenegotiate(afterRecoveries: 1))
        XCTAssertFalse(policy.shouldRenegotiate(afterRecoveries: 2))
    }

    func testAdaptiveQualityDropsHighAndAutomaticStreamsToLow() {
        let policy = WebRTCAdaptiveQualityPolicy()
        XCTAssertEqual(
            policy.recoveryQuality(requested: .auto, active: .auto, lowData: false),
            .low)
        XCTAssertEqual(
            policy.recoveryQuality(requested: .high, active: .high, lowData: false),
            .low)
        XCTAssertEqual(
            policy.recoveryQuality(requested: .medium, active: .medium, lowData: false),
            .low)
    }

    func testAdaptiveQualityDoesNotOscillateOrOverrideLowData() {
        let policy = WebRTCAdaptiveQualityPolicy()
        XCTAssertNil(policy.recoveryQuality(requested: .low, active: .low, lowData: false))
        XCTAssertNil(policy.recoveryQuality(requested: .high, active: .high, lowData: true))
    }

    func testHLSLiveEdgePolicyCorrectsOnlyMeaningfulDrift() {
        let policy = HLSLiveEdgePolicy(maximumLag: 12, targetLag: 2)
        XCTAssertNil(policy.correction(current: 89, rangeStart: 0, rangeEnd: 100))
        XCTAssertEqual(policy.correction(current: 70, rangeStart: 0, rangeEnd: 100), 98)
        XCTAssertNil(policy.correction(current: .nan, rangeStart: 0, rangeEnd: 100))
    }

    func testWebRTCICEURLsPreferUDPButKeepEveryFallback() {
        let urls = [
            "turns:relay.example:5349?transport=tcp",
            "turn:relay.example:3478?transport=tcp",
            "turn:relay.example:3478?transport=udp",
            "stun:relay.example:3478",
        ]
        XCTAssertEqual(
            prioritizedWebRTCICEURLs(urls),
            [urls[2], urls[1], urls[0], urls[3]])
    }

    func testWebRTCICEURLsTrimAndDeduplicateConfigurationNoise() {
        XCTAssertEqual(
            prioritizedWebRTCICEURLs([
                " turn:relay.example:3478?transport=udp ",
                "turn:relay.example:3478?transport=udp",
                "",
                "turn:relay.example:3478?transport=tcp",
            ]),
            [
                "turn:relay.example:3478?transport=udp",
                "turn:relay.example:3478?transport=tcp",
            ])
    }

    func testFrozenFrameDetectorNeedsAStillPlayheadForLongerThanTolerance() {
        var detector = FrozenFrameDetector(tolerance: 5)
        let t0 = Date(timeIntervalSince1970: 1_000_000)
        // First observation only establishes a baseline.
        XCTAssertFalse(detector.observe(time: 10, now: t0))
        // Advancing playhead is healthy however long it runs.
        XCTAssertFalse(detector.observe(time: 12, now: t0.addingTimeInterval(2)))
        XCTAssertFalse(detector.observe(time: 14, now: t0.addingTimeInterval(30)))
        // Stuck, but not yet past tolerance.
        XCTAssertFalse(detector.observe(time: 14, now: t0.addingTimeInterval(33)))
        // Stuck beyond tolerance.
        XCTAssertTrue(detector.observe(time: 14, now: t0.addingTimeInterval(40)))
    }

    func testPlaylistResetCountsAsMovementNotAFreeze() {
        var detector = FrozenFrameDetector(tolerance: 5)
        let t0 = Date(timeIntervalSince1970: 2_000_000)
        XCTAssertFalse(detector.observe(time: 100, now: t0))
        // A live playlist reset can move the playhead backwards; that is a live
        // stream, not a frozen one.
        XCTAssertFalse(detector.observe(time: 4, now: t0.addingTimeInterval(10)))
        XCTAssertFalse(detector.observe(time: 6, now: t0.addingTimeInterval(12)))
    }

    func testResetClearsFreezeTracking() {
        var detector = FrozenFrameDetector(tolerance: 2)
        let t0 = Date(timeIntervalSince1970: 3_000_000)
        _ = detector.observe(time: 5, now: t0)
        XCTAssertTrue(detector.observe(time: 5, now: t0.addingTimeInterval(10)))
        detector.reset(now: t0.addingTimeInterval(10))
        XCTAssertFalse(
            detector.observe(time: 5, now: t0.addingTimeInterval(11)),
            "after a reset the detector needs a fresh baseline")
    }

    func testDiagnosticsReportFrameStaleness() {
        var diagnostics = CameraStreamDiagnostics()
        XCTAssertNil(diagnostics.framesStaleFor())
        let now = Date(timeIntervalSince1970: 4_000_000)
        diagnostics.lastFrameAt = now.addingTimeInterval(-3)
        XCTAssertEqual(diagnostics.framesStaleFor(now: now) ?? 0, 3, accuracy: 0.001)
    }

    func testLowFrameRateDetectorIgnoresOneSampleDip() {
        var detector = WebRTCLowFrameRateDetector(expectedFrameRate: 20)
        XCTAssertEqual(detector.observe(framesPerSecond: 20), .none)
        XCTAssertEqual(detector.observe(framesPerSecond: 1), .none)
        XCTAssertEqual(detector.observe(framesPerSecond: 19), .none)
        for _ in 0..<2 { XCTAssertEqual(detector.observe(framesPerSecond: 1), .none) }
    }

    func testLowFrameRateDetectorReportsSustainedCollapse() {
        var detector = WebRTCLowFrameRateDetector(expectedFrameRate: 20)
        for _ in 0..<2 { XCTAssertEqual(detector.observe(framesPerSecond: 1), .none) }
        XCTAssertEqual(
            detector.observe(framesPerSecond: 1),
            .degraded(baseline: 20, current: 1))
        XCTAssertTrue(detector.isDegraded)
    }

    func testLowFrameRateDetectorUsesHysteresisForRecovery() {
        var detector = WebRTCLowFrameRateDetector(expectedFrameRate: 20)
        for _ in 0..<3 { _ = detector.observe(framesPerSecond: 1) }
        XCTAssertEqual(detector.observe(framesPerSecond: 18), .none)
        XCTAssertEqual(detector.observe(framesPerSecond: 5), .none)
        XCTAssertEqual(detector.observe(framesPerSecond: 18), .none)
        XCTAssertEqual(detector.observe(framesPerSecond: 18), .none)
        XCTAssertEqual(detector.observe(framesPerSecond: 18), .recovered)
        XCTAssertFalse(detector.isDegraded)
    }

    func testLowFrameRateDetectorAcceptsNaturallyLowBaseline() {
        var detector = WebRTCLowFrameRateDetector()
        for _ in 0..<20 {
            XCTAssertEqual(detector.observe(framesPerSecond: 2), .none)
        }
        XCTAssertEqual(detector.baseline, 2)
        XCTAssertFalse(detector.isDegraded)
    }

    func testLowFrameRateDetectorCanKeepBaselineAcrossRenegotiation() {
        var detector = WebRTCLowFrameRateDetector(expectedFrameRate: 20)
        detector.reset(keepingBaseline: true)
        XCTAssertEqual(detector.baseline, 20)
        for _ in 0..<4 { XCTAssertEqual(detector.observe(framesPerSecond: 1), .none) }
        XCTAssertEqual(
            detector.observe(framesPerSecond: 1),
            .degraded(baseline: 20, current: 1))
    }
}
