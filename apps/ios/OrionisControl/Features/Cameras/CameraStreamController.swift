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
    /// rebuilds the view hierarchy. Used for the HLS transport (and the fallback).
    let player = AVPlayer()

    /// The sub-second transport. Parallel to `player`; exactly one is active at a
    /// time, chosen by the negotiated protocol. The view renders whichever
    /// `isWebRTC` selects.
    let webrtc = WebRTCStreamPlayer()

    /// True while the active session is being served over WebRTC, so the viewer
    /// knows to mount the Metal renderer instead of the `AVPlayer` layer.
    private(set) var isWebRTC = false

    private(set) var cameraId: String
    private let service: any CameraServicing
    private let policy: ReconnectPolicy

    private var session: StreamSession?
    private var camera: Camera?
    private var quality: StreamQuality = .auto
    private var lowData = false
    private var detector = FrozenFrameDetector()
    private var attempt = 0
    private var wasPlayingBeforeBackground = false
    private var isMuted = true

    /// What we ask the gateway to negotiate. Normally the full preference order
    /// (WebRTC first); pinned to HLS once WebRTC has failed for this camera, so a
    /// fallback retry does not just land back on WebRTC and loop.
    private var preferredProtocols: [StreamProtocolKind] = StreamProtocolKind.preferenceOrder
    private var webRTCFallbackUsed = false
    /// How many times this open has renegotiated WebRTC because it connected but
    /// painted no video. Bounded, then it gives up to HLS.
    private var webRTCFrameRetries = 0

    /// Touched from the nonisolated `deinit` purely to cancel and deregister.
    /// `Task.cancel()` and `NotificationCenter.removeObserver` are both safe from
    /// any isolation domain.
    private nonisolated(unsafe) var connectTask: Task<Void, Never>?
    private nonisolated(unsafe) var recoveryTask: Task<Void, Never>?
    private nonisolated(unsafe) var webRTCWatchdog: Task<Void, Never>?
    private nonisolated(unsafe) var webRTCFrameWatchdog: Task<Void, Never>?
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
        webRTCWatchdog?.cancel()
        webRTCFrameWatchdog?.cancel()
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
        // A fresh camera gets the full ladder again; a prior camera's WebRTC
        // failure must not permanently pin this one to HLS.
        preferredProtocols = StreamProtocolKind.preferenceOrder
        webRTCFallbackUsed = false
        webRTCFrameRetries = 0
        connect(isRetry: false)
    }

    /// Mutes/unmutes whichever transport is live. The viewer calls this instead of
    /// touching `player` directly so WebRTC audio is covered too.
    func setAudioMuted(_ muted: Bool) {
        isMuted = muted
        player.isMuted = muted
        webrtc.setMuted(muted)
    }

    /// Moves this controller to another camera, reusing the same player.
    ///
    /// The previous session is revoked before the next is opened, so swiping
    /// through a wall of cameras never leaves a trail of live streams behind it
    /// and only one stream is ever active.
    func switchTo(camera: Camera, quality: StreamQuality, lowData: Bool) async {
        await stop()
        cameraId = camera.id
        start(camera: camera, quality: quality, lowData: lowData)
    }

    /// Viewer-initiated pause. Distinct from a stall: no recovery is attempted.
    func pause() {
        player.pause()
        recoveryTask?.cancel()
        // WebRTC has no "pause": stop pulling media entirely. `resume()` rejoins
        // from a fresh session, which is what a live stream wants anyway.
        connectTask?.cancel()
        teardownWebRTC()
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
        teardownWebRTC()
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
        connectTask?.cancel()
        teardownWebRTC()
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
        webRTCWatchdog?.cancel()
        webRTCFrameWatchdog?.cancel()
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
                    cameraId: self.cameraId,
                    quality: self.quality,
                    lowData: self.lowData,
                    preferredProtocols: self.preferredProtocols)
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
        switch session.protocol {
        case .hls, .llhls:
            teardownWebRTC()
            playHLS(session)
        case .webrtc:
            playWebRTC(session)
        case .mjpeg:
            teardownWebRTC()
            transition(
                to: .unsupported(
                    protocol: .mjpeg,
                    detail:
                        "The gateway offered only MJPEG for this camera, which this version does not play."
                ))
        }
    }

    /// AVFoundation transport: hand the token-bound playlist to the player.
    private func playHLS(_ session: StreamSession) {
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
        player.isMuted = isMuted
        transition(to: .buffering)
        observe(item: item)
        player.replaceCurrentItem(with: item)
        player.play()
    }

    // MARK: - WebRTC transport

    /// Sub-second transport. Signalling runs on `connectTask`; the transition to
    /// `.live` arrives via the connection-state callback. Any failure — signalling
    /// throw, a failed peer connection, or the watchdog — falls back to HLS once,
    /// then defers to normal recovery.
    private func playWebRTC(_ session: StreamSession) {
        self.session = session
        isWebRTC = true
        diagnostics.transport = .webrtc

        // No AVPlayer item backs this transport; make sure a stale HLS frame is
        // not left on screen underneath the Metal renderer.
        clearItemObservers()
        player.replaceCurrentItem(with: nil)
        detector.reset()
        transition(to: .buffering)

        webrtc.setMuted(isMuted)
        webrtc.onConnectionState = { [weak self] state in
            guard let self else { return }
            switch state {
            case .connected: self.webRTCDidConnect()
            case .failed: self.webRTCDidFail(reason: "The WebRTC connection dropped")
            case .connecting: break
            }
        }
        webrtc.onFirstFrame = { [weak self] in self?.webRTCDidRenderFirstFrame() }

        startWebRTCWatchdog()

        connectTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await self.webrtc.connect(session: session)
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                self.webRTCDidFail(reason: "WebRTC could not negotiate a stream")
            }
        }
    }

    /// The peer connection is up — but "connected" is not "playing". Wait for a
    /// real frame before calling it live; a connection that paints nothing is the
    /// black-first-open bug, and it is caught by the first-frame watchdog.
    private func webRTCDidConnect() {
        guard isWebRTC else { return }
        webRTCWatchdog?.cancel()
        attempt = 0
        startFirstFrameWatchdog()
    }

    /// A frame actually decoded: now it is genuinely live.
    private func webRTCDidRenderFirstFrame() {
        guard isWebRTC else { return }
        webRTCWatchdog?.cancel()
        webRTCFrameWatchdog?.cancel()
        webRTCFrameRetries = 0
        attempt = 0
        diagnostics.lastFrameAt = Date()
        transition(to: .live)
    }

    /// Connected but no video painted in time. Renegotiate from scratch — the same
    /// thing reopening the camera does, which reliably shakes a keyframe loose —
    /// and only give up to HLS after a couple of tries.
    private func webRTCNoFirstFrame() {
        guard isWebRTC, state != .live, let session else { return }
        if webRTCFrameRetries < 2 {
            webRTCFrameRetries += 1
            diagnostics.lastErrorSummary = "WebRTC connected but showed no video; renegotiating"
            playWebRTC(session)
        } else {
            webRTCFrameRetries = 0
            webRTCDidFail(reason: "WebRTC connected but never showed video")
        }
    }

    private func startFirstFrameWatchdog() {
        webRTCFrameWatchdog?.cancel()
        webRTCFrameWatchdog = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            await MainActor.run {
                guard let self, self.isWebRTC, self.state != .live else { return }
                self.webRTCNoFirstFrame()
            }
        }
    }

    /// The one place WebRTC failure is handled: fall back to HLS the first time,
    /// then hand off to bounded recovery so a dead camera still ends in a final
    /// state rather than ping-ponging between transports.
    private func webRTCDidFail(reason: String) {
        guard isWebRTC else { return }
        webRTCWatchdog?.cancel()
        teardownWebRTC()

        if !webRTCFallbackUsed {
            webRTCFallbackUsed = true
            preferredProtocols = [.hls]
            diagnostics.lastErrorSummary = "WebRTC unavailable, falling back to HLS"
            attempt = 0
            connect(isRetry: false)
        } else {
            beginRecovery(reason: reason)
        }
    }

    /// Bounds how long a WebRTC negotiation may sit before "connected". Without it
    /// a silent ICE failure would leave the viewer buffering forever.
    private func startWebRTCWatchdog() {
        webRTCWatchdog?.cancel()
        webRTCWatchdog = Task { [weak self] in
            try? await Task.sleep(for: .seconds(10))
            guard !Task.isCancelled else { return }
            await MainActor.run {
                guard let self, self.isWebRTC, self.state != .live else { return }
                self.webRTCDidFail(reason: "WebRTC did not connect in time")
            }
        }
    }

    private func teardownWebRTC() {
        webRTCWatchdog?.cancel()
        webRTCFrameWatchdog?.cancel()
        guard isWebRTC else { return }
        isWebRTC = false
        webrtc.onConnectionState = nil
        webrtc.onFirstFrame = nil
        webrtc.close()
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
