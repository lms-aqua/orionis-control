import AVFoundation
import Foundation

/// Owns one camera's `AVPlayer` and drives `CameraStreamState`.
///
/// Deliberately separate from any view: a player must never be constructed inside
/// a SwiftUI body, which SwiftUI is free to re-evaluate at will. The view observes
/// `state` and hands `player` to an `AVPlayerViewController`; everything about the
/// stream's lifecycle lives here.
///
/// Stall detection watches the playhead rather than `timeControlStatus`, because
/// AVPlayer reports `.playing` while sitting on a decoded frame after the segments
/// behind it dry up — which is exactly how a dead camera comes to look live.
@MainActor
@Observable
final class CameraStreamController {
    private(set) var state: CameraStreamState = .idle
    private(set) var diagnostics = CameraStreamDiagnostics()

    /// Created once and reused across reconnects, so renegotiating a stream never
    /// rebuilds the view hierarchy.
    let player = AVPlayer()

    private let cameraId: String
    private let service: any CameraServicing
    private let policy: ReconnectPolicy

    private var session: StreamSession?
    private var camera: Camera?
    private var quality: StreamQuality = .auto
    private var lowData = false
    private var detector = FrozenFrameDetector()
    private var attempt = 0
    private var wasPlayingBeforeBackground = false

    /// Touched from the nonisolated `deinit` purely to cancel and deregister.
    /// `Task.cancel()` and `NotificationCenter.removeObserver` are both safe from
    /// any isolation domain.
    private nonisolated(unsafe) var connectTask: Task<Void, Never>?
    private nonisolated(unsafe) var recoveryTask: Task<Void, Never>?
    private nonisolated(unsafe) var itemTokens: [NSObjectProtocol] = []

    private var timeObserver: Any?

    init(
        cameraId: String,
        service: any CameraServicing,
        policy: ReconnectPolicy = ReconnectPolicy()
    ) {
        self.cameraId = cameraId
        self.service = service
        self.policy = policy
        player.automaticallyWaitsToMinimizeStalling = true
        observePlayhead()
    }

    deinit {
        connectTask?.cancel()
        recoveryTask?.cancel()
        for token in itemTokens { NotificationCenter.default.removeObserver(token) }
    }

    // MARK: - Lifecycle

    /// Starts (or restarts) playback. Safe to call repeatedly: in-flight work is
    /// cancelled first, so a double tap cannot open two sessions.
    func start(camera: Camera, quality: StreamQuality, lowData: Bool) {
        self.camera = camera
        self.quality = quality
        self.lowData = lowData
        attempt = 0
        wasPlayingBeforeBackground = false
        connect(isRetry: false)
    }

    /// Viewer-initiated pause. Distinct from a stall: no recovery is attempted.
    func pause() {
        player.pause()
        recoveryTask?.cancel()
        if !state.isTerminal { transition(to: .paused) }
    }

    /// A live stream has moved on while paused, so rejoin rather than resume from
    /// a stale playhead.
    func resume() {
        guard state == .paused else { return }
        attempt = 0
        connect(isRetry: false)
    }

    /// Immediate manual retry, ignoring any backoff currently in flight.
    func retryNow() {
        recoveryTask?.cancel()
        attempt = 0
        connect(isRetry: false)
    }

    /// Releases the stream. Always call this when leaving the viewer: it stops
    /// decoding, drops the item, and revokes the gateway session so no stream is
    /// left running for a screen nobody is looking at.
    func stop() async {
        connectTask?.cancel()
        recoveryTask?.cancel()
        connectTask = nil
        recoveryTask = nil
        player.pause()
        clearItemObservers()
        player.replaceCurrentItem(with: nil)
        detector.reset()
        transition(to: .idle)
        if let session {
            self.session = nil
            try? await service.endStreamSession(cameraId: cameraId, streamId: session.id)
        }
    }

    /// Backgrounding: stop pulling video, remembering whether to rejoin later.
    func suspendForBackground() {
        wasPlayingBeforeBackground = state.isLive || state == .buffering || state == .connecting
        recoveryTask?.cancel()
        player.pause()
    }

    func resumeFromBackground() {
        guard wasPlayingBeforeBackground else { return }
        wasPlayingBeforeBackground = false
        attempt = 0
        connect(isRetry: false)
    }

    /// A network path change invalidates any in-flight stream; rejoin from scratch.
    func networkPathChanged() {
        guard state.isLive || state == .buffering || isReconnecting else { return }
        beginRecovery(reason: "Network changed")
    }

    private var isReconnecting: Bool {
        if case .reconnecting = state { return true }
        return false
    }

    // MARK: - Connecting

    private func connect(isRetry: Bool) {
        connectTask?.cancel()
        guard let camera else { return }

        // An offline camera is not a stream failure, and retrying it is pointless.
        guard camera.health.status.isUsable else {
            transition(to: .offline(reason: camera.health.message ?? "\(camera.name) is offline"))
            return
        }

        transition(to: isRetry ? .reconnecting(attempt: attempt) : .connecting)
        diagnostics.connectionAttempts += 1

        connectTask = Task { [weak self] in
            guard let self else { return }
            do {
                let session = try await self.service.createStreamSession(
                    cameraId: self.cameraId, quality: self.quality, lowData: self.lowData)
                guard !Task.isCancelled else { return }
                self.play(session: session)
            } catch let error as APIError {
                guard !Task.isCancelled else { return }
                self.handle(error: error)
            } catch {
                guard !Task.isCancelled else { return }
                self.beginRecovery(reason: "Stream unavailable")
            }
        }
    }

    private func play(session: StreamSession) {
        // Only HLS is playable by AVFoundation here. Say so plainly rather than
        // failing obscurely with an empty player.
        switch session.protocol {
        case .hls, .llhls:
            break
        case .webrtc:
            transition(
                to: .unsupported(
                    protocol: .webrtc,
                    detail:
                        "This build plays HLS and Low-Latency HLS. The gateway negotiated WebRTC, which needs a peer-connection stack that is not bundled in this version."
                ))
            return
        case .mjpeg:
            transition(
                to: .unsupported(
                    protocol: .mjpeg,
                    detail:
                        "The gateway offered only MJPEG for this camera, which this version does not play."
                ))
            return
        }

        self.session = session
        diagnostics.transport = session.protocol

        // The stream token travels as a header so it stays out of URLs, logs and
        // cache keys. Every sub-resource URL is minted by the gateway.
        let asset = AVURLAsset(
            url: session.playbackUrl,
            options: [
                "AVURLAssetHTTPHeaderFieldsKey": [
                    "Authorization": "Bearer \(session.streamToken)"
                ]
            ])
        let item = AVPlayerItem(asset: asset)
        detector.reset()
        transition(to: .buffering)
        observe(item: item)
        player.replaceCurrentItem(with: item)
        player.play()
    }

    private func handle(error: APIError) {
        diagnostics.lastErrorSummary = error.message
        if error.requiresReauthentication {
            transition(to: .authenticationFailed)
            return
        }
        if error.isUnsupported {
            transition(to: .unsupported(protocol: session?.protocol ?? .hls, detail: error.message))
            return
        }
        if case .server(let code, let message, _, _) = error, code == .cameraOffline {
            transition(to: .offline(reason: message))
            return
        }
        guard error.isRetryable else {
            transition(to: .failed(reason: error.message))
            return
        }
        beginRecovery(reason: error.message)
    }

    // MARK: - Recovery

    /// Bounded backoff. Gives up rather than looping, so a real outage surfaces as
    /// a final state instead of a permanent spinner.
    private func beginRecovery(reason: String) {
        recoveryTask?.cancel()
        diagnostics.lastErrorSummary = reason

        guard policy.shouldRetry(afterAttempt: attempt) else {
            transition(to: .failed(reason: reason))
            return
        }

        attempt += 1
        diagnostics.reconnectCount += 1
        transition(to: .reconnecting(attempt: attempt))

        let delay = policy.delay(forAttempt: attempt)
        recoveryTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled, let self else { return }
            self.connect(isRetry: true)
        }
    }

    // MARK: - Player observation

    /// Polled rather than KVO-observed: one place to reason about, and no observer
    /// lifetime to get wrong.
    private func observePlayhead() {
        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 1, preferredTimescale: 600), queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
    }

    /// Item notifications are registered against the specific item, so a second
    /// camera streaming elsewhere cannot drive this controller's recovery.
    private func observe(item: AVPlayerItem) {
        clearItemObservers()
        let center = NotificationCenter.default
        itemTokens = [
            center.addObserver(
                forName: AVPlayerItem.playbackStalledNotification, object: item, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.playbackStalled() }
            },
            center.addObserver(
                forName: AVPlayerItem.failedToPlayToEndTimeNotification, object: item, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.playbackFailed() }
            },
        ]
    }

    private func clearItemObservers() {
        for token in itemTokens { NotificationCenter.default.removeObserver(token) }
        itemTokens = []
    }

    private func tick() {
        guard let item = player.currentItem else { return }

        if item.status == .failed {
            playbackFailed()
            return
        }

        let seconds = player.currentTime().seconds
        guard seconds.isFinite else { return }

        if detector.observe(time: seconds) {
            // The playhead has not moved for longer than tolerance while the
            // player believes it is playing: the stream is frozen, not live.
            diagnostics.stallCount += 1
            beginRecovery(reason: "The stream stopped sending video")
            return
        }

        if item.isPlaybackLikelyToKeepUp, player.timeControlStatus == .playing {
            diagnostics.lastFrameAt = Date()
            let size = item.presentationSize
            if size.width > 0, size.height > 0 {
                diagnostics.resolution = "\(Int(size.width))×\(Int(size.height))"
            }
            if state == .buffering || isReconnecting {
                attempt = 0
                transition(to: .live)
            }
        } else if state.isLive {
            transition(to: .buffering)
        }
    }

    private func playbackStalled() {
        guard state.isLive || state == .buffering else { return }
        diagnostics.stallCount += 1
        transition(to: .buffering)
    }

    private func playbackFailed() {
        beginRecovery(reason: "Stream unavailable")
    }

    private func transition(to next: CameraStreamState) {
        guard state != next else { return }
        state = next
        diagnostics.lastStateChangeAt = Date()
    }
}
