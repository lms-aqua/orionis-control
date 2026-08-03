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
    private let webRTCHealthPolicy = WebRTCFrameHealthPolicy()
    private let hlsLiveEdgePolicy = HLSLiveEdgePolicy()

    private var session: StreamSession?
    private var camera: Camera?
    private var quality: StreamQuality = .auto
    private var lowData = false
    private var detector = FrozenFrameDetector()
    private var attempt = 0
    private var wasPlayingBeforeBackground = false
    private var isSuspendedForBackground = false
    private var isMuted = true
    private var audioSessionActive = false
    private var lastLiveEdgeCorrectionAt: Date?

    /// What we ask the gateway to negotiate. Normally the full preference order
    /// (WebRTC first); pinned to HLS once WebRTC has failed for this camera, so a
    /// fallback retry does not just land back on WebRTC and loop.
    private var preferredProtocols: [StreamProtocolKind] = StreamProtocolKind.preferenceOrder
    private var webRTCFallbackUsed = false
    /// How many times this open has renegotiated WebRTC because it connected but
    /// painted no video. Bounded, then it gives up to HLS.
    private var webRTCFrameRetries = 0
    /// A live peer can remain "connected" after media stops. Try a bounded fast
    /// renegotiation before falling back to the steadier HLS transport.
    private var webRTCStallRecoveries = 0
    /// Invalidates connection work that outlives a stop, pause, camera switch or
    /// newer retry. A cancelled URLSession call may still finish successfully;
    /// its server-side stream must then be explicitly revoked instead of leaked.
    private var connectionGeneration = 0

    /// Touched from the nonisolated `deinit` purely to cancel and deregister.
    /// `Task.cancel()` and `NotificationCenter.removeObserver` are both safe from
    /// any isolation domain.
    private nonisolated(unsafe) var connectTask: Task<Void, Never>?
    private nonisolated(unsafe) var recoveryTask: Task<Void, Never>?
    private nonisolated(unsafe) var renewalTask: Task<Void, Never>?
    private nonisolated(unsafe) var webRTCWatchdog: Task<Void, Never>?
    private nonisolated(unsafe) var webRTCFrameWatchdog: Task<Void, Never>?
    private nonisolated(unsafe) var webRTCHealthTask: Task<Void, Never>?
    private nonisolated(unsafe) var itemTokens: [NSObjectProtocol] = []
    private nonisolated(unsafe) var audioTokens: [NSObjectProtocol] = []

    private nonisolated(unsafe) var timeObserver: Any?

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
        observeAudioSession()
    }

    deinit {
        connectTask?.cancel()
        recoveryTask?.cancel()
        renewalTask?.cancel()
        webRTCWatchdog?.cancel()
        webRTCFrameWatchdog?.cancel()
        webRTCHealthTask?.cancel()
        for token in itemTokens { NotificationCenter.default.removeObserver(token) }
        for token in audioTokens { NotificationCenter.default.removeObserver(token) }
        if let timeObserver { player.removeTimeObserver(timeObserver) }
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
        isSuspendedForBackground = false
        // A fresh camera gets the full ladder again; a prior camera's WebRTC
        // failure must not permanently pin this one to HLS.
        preferredProtocols = StreamProtocolKind.preferenceOrder
        webRTCFallbackUsed = false
        webRTCFrameRetries = 0
        webRTCStallRecoveries = 0
        connect(isRetry: false)
    }

    /// Mutes/unmutes whichever transport is live. The viewer calls this instead of
    /// touching `player` directly so WebRTC audio is covered too.
    func setAudioMuted(_ muted: Bool) {
        isMuted = muted
        if muted {
            deactivateAudioPlayback()
        } else if state != .idle, !state.isTerminal {
            configureAudioPlayback()
        }
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
        guard !Task.isCancelled else { return }
        cameraId = camera.id
        start(camera: camera, quality: quality, lowData: lowData)
    }

    /// Viewer-initiated pause. Distinct from a stall: no recovery is attempted.
    func pause() {
        connectionGeneration &+= 1
        player.pause()
        clearItemObservers()
        player.replaceCurrentItem(with: nil)
        recoveryTask?.cancel()
        renewalTask?.cancel()
        // WebRTC has no "pause": stop pulling media entirely. `resume()` rejoins
        // from a fresh session, which is what a live stream wants anyway.
        connectTask?.cancel()
        teardownWebRTC()
        revokeCurrentSession()
        deactivateAudioPlayback()
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
        isSuspendedForBackground = false
        connectionGeneration &+= 1
        connectTask?.cancel()
        recoveryTask?.cancel()
        renewalTask?.cancel()
        connectTask = nil
        recoveryTask = nil
        renewalTask = nil
        teardownWebRTC()
        player.pause()
        clearItemObservers()
        player.replaceCurrentItem(with: nil)
        detector.reset()
        deactivateAudioPlayback()
        transition(to: .idle)
        if let session {
            self.session = nil
            try? await service.endStreamSession(cameraId: cameraId, streamId: session.id)
        }
    }

    /// Backgrounding: stop pulling video, remembering whether to rejoin later.
    func suspendForBackground() {
        guard !isSuspendedForBackground else { return }
        isSuspendedForBackground = true
        connectionGeneration &+= 1
        wasPlayingBeforeBackground = state.isLive || state == .buffering || state == .connecting
        recoveryTask?.cancel()
        renewalTask?.cancel()
        connectTask?.cancel()
        teardownWebRTC()
        player.pause()
        clearItemObservers()
        player.replaceCurrentItem(with: nil)
        revokeCurrentSession()
        deactivateAudioPlayback()
    }

    func resumeFromBackground() {
        guard isSuspendedForBackground else { return }
        isSuspendedForBackground = false
        guard wasPlayingBeforeBackground else { return }
        wasPlayingBeforeBackground = false
        attempt = 0
        connect(isRetry: false)
    }

    /// Pause/background APIs are synchronous because SwiftUI calls them from
    /// lifecycle callbacks. Move the session out immediately, then revoke it in
    /// the background so a paused camera does not keep consuming gateway slots.
    private func revokeCurrentSession() {
        guard let previous = session else { return }
        session = nil
        let cameraId = cameraId
        let service = service
        Task { try? await service.endStreamSession(cameraId: cameraId, streamId: previous.id) }
    }

    /// A network path change invalidates any in-flight stream; rejoin from scratch.
    func networkPathChanged(lowData: Bool) {
        guard !isSuspendedForBackground else { return }
        guard state.isLive || state == .buffering || state == .connecting || isReconnecting
        else { return }
        self.lowData = lowData
        connectTask?.cancel()
        beginRecovery(reason: "Network changed")
    }

    private var isReconnecting: Bool {
        if case .reconnecting = state { return true }
        return false
    }

    // MARK: - Connecting

    private func connect(isRetry: Bool) {
        connectTask?.cancel()
        renewalTask?.cancel()
        renewalTask = nil
        webRTCWatchdog?.cancel()
        webRTCFrameWatchdog?.cancel()
        webRTCHealthTask?.cancel()
        guard let camera else { return }

        connectionGeneration &+= 1
        let generation = connectionGeneration

        // An offline camera is not a stream failure, and retrying it is pointless.
        guard camera.health.status.isUsable else {
            terminatePlayback()
            transition(to: .offline(reason: camera.health.message ?? "\(camera.name) is offline"))
            return
        }

        transition(to: isRetry ? .reconnecting(attempt: attempt) : .connecting)
        diagnostics.connectionAttempts += 1

        connectTask = Task { [weak self] in
            guard let self else { return }
            do {
                // Reconnects replace, rather than accumulate, gateway sessions.
                // Keep the reference visible until revocation finishes so a
                // simultaneous stop can also perform a best-effort cleanup.
                if let previous = self.session {
                    do {
                        try await self.service.endStreamSession(
                            cameraId: self.cameraId, streamId: previous.id)
                    } catch {
                        // Cancellation means a newer connection owns cleanup;
                        // leave the reference intact for that task. A current
                        // task may continue after a best-effort server failure.
                        guard !Task.isCancelled, generation == self.connectionGeneration else {
                            return
                        }
                    }
                    if self.session?.id == previous.id { self.session = nil }
                }
                guard !Task.isCancelled, generation == self.connectionGeneration else { return }

                let newSession = try await self.service.createStreamSession(
                    cameraId: self.cameraId,
                    quality: self.quality,
                    lowData: self.lowData,
                    preferredProtocols: self.preferredProtocols)
                guard !Task.isCancelled, generation == self.connectionGeneration else {
                    // The gateway created this stream after the viewer moved on.
                    // Revoke it immediately so cancellation cannot leak sessions.
                    try? await self.service.endStreamSession(
                        cameraId: self.cameraId, streamId: newSession.id)
                    return
                }
                self.play(session: newSession)
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
        if !isMuted { configureAudioPlayback() }
        switch session.protocol {
        case .hls, .llhls:
            teardownWebRTC()
            playHLS(session)
        case .webrtc:
            playWebRTC(session)
        case .mjpeg:
            self.session = session
            teardownWebRTC()
            terminatePlayback()
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
        scheduleRenewal(for: session)
        diagnostics.transport = session.protocol
        lastLiveEdgeCorrectionAt = nil

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
        // Keep a small but explicit safety buffer. The default can grow
        // conservatively on a live feed and turn a brief stall into large latency.
        item.preferredForwardBufferDuration = lowData ? 1.5 : 3
        if lowData { item.preferredPeakBitRate = 1_000_000 }
        detector.reset()
        player.isMuted = isMuted
        transition(to: .buffering)
        observe(item: item)
        player.replaceCurrentItem(with: item)
        player.play()
    }

    private func configureAudioPlayback() {
        guard !audioSessionActive else { return }
        let audio = AVAudioSession.sharedInstance()
        do {
            try audio.setCategory(.playback, mode: .moviePlayback)
            try audio.setActive(true)
            audioSessionActive = true
        } catch {
            diagnostics.lastErrorSummary = "Audio output could not be activated"
        }
    }

    private func deactivateAudioPlayback() {
        guard audioSessionActive else { return }
        try? AVAudioSession.sharedInstance().setActive(
            false, options: .notifyOthersOnDeactivation)
        audioSessionActive = false
    }

    private func observeAudioSession() {
        audioTokens = [
            NotificationCenter.default.addObserver(
                forName: AVAudioSession.interruptionNotification,
                object: AVAudioSession.sharedInstance(),
                queue: .main
            ) { [weak self] notification in
                MainActor.assumeIsolated { self?.handleAudioInterruption(notification) }
            },
            NotificationCenter.default.addObserver(
                forName: AVAudioSession.routeChangeNotification,
                object: AVAudioSession.sharedInstance(),
                queue: .main
            ) { [weak self] notification in
                MainActor.assumeIsolated { self?.handleAudioRouteChange(notification) }
            },
        ]
    }

    private func handleAudioInterruption(_ notification: Notification) {
        guard let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw)
        else { return }
        switch type {
        case .began:
            // iOS has already deactivated it; keep our ownership state honest.
            audioSessionActive = false
        case .ended:
            let rawOptions = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            let options = AVAudioSession.InterruptionOptions(rawValue: rawOptions)
            if options.contains(.shouldResume), !isMuted,
               state.isLive || state == .buffering
            {
                configureAudioPlayback()
            }
        @unknown default:
            break
        }
    }

    private func handleAudioRouteChange(_ notification: Notification) {
        guard !isMuted, state.isLive || state == .buffering,
              let raw = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: raw)
        else { return }
        switch reason {
        case .newDeviceAvailable, .oldDeviceUnavailable, .routeConfigurationChange,
             .wakeFromSleep, .noSuitableRouteForCategory:
            // Reassert the receive-only playback category after Bluetooth,
            // AirPlay, headphones, or sleep changes the selected output.
            audioSessionActive = false
            configureAudioPlayback()
        case .unknown, .categoryChange, .override:
            break
        @unknown default:
            break
        }
    }

    // MARK: - WebRTC transport

    /// Sub-second transport. Signalling runs on `connectTask`; the transition to
    /// `.live` arrives via the connection-state callback. Any failure — signalling
    /// throw, a failed peer connection, or the watchdog — falls back to HLS once,
    /// then defers to normal recovery.
    private func playWebRTC(_ session: StreamSession) {
        self.session = session
        scheduleRenewal(for: session)
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
        webrtc.onFrame = { [weak self] metrics in self?.webRTCDidRenderFrame(metrics) }

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
        startWebRTCHealthMonitor()
    }

    private func webRTCDidRenderFrame(_ metrics: WebRTCFrameMetrics) {
        guard isWebRTC else { return }
        diagnostics.lastFrameAt = Date()
        diagnostics.resolution = "\(metrics.width)×\(metrics.height)"
        if let framesPerSecond = metrics.framesPerSecond {
            diagnostics.frameRate = framesPerSecond
        }
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

    /// A connected WebRTC peer is not proof that frames are still arriving.
    /// Check the decoder heartbeat off the frame callback and self-heal a frozen
    /// media path without disturbing healthy video or reacting to tiny jitter.
    private func startWebRTCHealthMonitor() {
        webRTCHealthTask?.cancel()
        webRTCHealthTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(2))
                } catch {
                    return
                }
                guard let self, self.isWebRTC, self.state.isLive else { return }
                guard self.webRTCHealthPolicy.isFrozen(staleFor: self.webrtc.framesStaleFor())
                else { continue }
                self.recoverFrozenWebRTC()
                return
            }
        }
    }

    private func recoverFrozenWebRTC() {
        guard isWebRTC, let session else { return }
        diagnostics.stallCount += 1
        diagnostics.reconnectCount += 1
        diagnostics.lastErrorSummary = "WebRTC stopped delivering frames"
        transition(to: .reconnecting(attempt: webRTCStallRecoveries + 1))
        if webRTCHealthPolicy.shouldRenegotiate(afterRecoveries: webRTCStallRecoveries) {
            webRTCStallRecoveries += 1
            playWebRTC(session)
        } else {
            webRTCDidFail(reason: "WebRTC repeatedly stopped delivering video")
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
        webRTCHealthTask?.cancel()
        guard isWebRTC else { return }
        isWebRTC = false
        webrtc.onConnectionState = nil
        webrtc.onFirstFrame = nil
        webrtc.onFrame = nil
        webrtc.close()
    }

    private func scheduleRenewal(for session: StreamSession) {
        renewalTask?.cancel()
        // Renegotiating the same WebRTC session must not restart a relative timer
        // past the token's absolute expiry.
        let beforeExpiry = max(1, Int(session.expiresAt.timeIntervalSinceNow) - 15)
        let delay = Duration.seconds(min(max(5, session.renewAfterSeconds), beforeExpiry))
        renewalTask = Task { [weak self] in
            do {
                try await Task.sleep(for: delay)
            } catch {
                return
            }
            guard let self, self.session?.id == session.id,
                  self.state.isLive || self.state == .buffering
            else { return }
            self.renewalTask = nil
            self.diagnostics.reconnectCount += 1
            self.diagnostics.lastErrorSummary = "Refreshing stream authorization"
            self.connect(isRetry: false)
        }
    }

    private func handle(error: APIError) {
        diagnostics.lastErrorSummary = error.message
        if error.requiresReauthentication {
            terminatePlayback()
            transition(to: .authenticationFailed)
            return
        }
        if error.isUnsupported {
            terminatePlayback()
            transition(to: .unsupported(protocol: session?.protocol ?? .hls, detail: error.message))
            return
        }
        if case .server(let code, let message, _, _) = error, code == .cameraOffline {
            terminatePlayback()
            transition(to: .offline(reason: message))
            return
        }
        guard error.isRetryable else {
            terminatePlayback()
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

        // Do not keep downloading/decoding a known-bad HLS item throughout the
        // backoff. The next connection starts at the live edge with fresh media.
        if !isWebRTC { player.pause() }

        guard policy.shouldRetry(afterAttempt: attempt) else {
            terminatePlayback()
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

        if let range = item.seekableTimeRanges.last?.timeRangeValue,
           lastLiveEdgeCorrectionAt.map({ Date().timeIntervalSince($0) > 10 }) ?? true,
           let target = hlsLiveEdgePolicy.correction(
            current: seconds,
            rangeStart: range.start.seconds,
            rangeEnd: CMTimeRangeGetEnd(range).seconds)
        {
            lastLiveEdgeCorrectionAt = Date()
            detector.reset()
            player.seek(
                to: CMTime(seconds: target, preferredTimescale: 600),
                toleranceBefore: CMTime(seconds: 0.5, preferredTimescale: 600),
                toleranceAfter: CMTime(seconds: 0.5, preferredTimescale: 600))
            return
        }

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

    /// Terminal states own no media resources. In particular, a negotiation that
    /// ended unsupported used to leave its freshly created gateway session live.
    private func terminatePlayback() {
        renewalTask?.cancel()
        renewalTask = nil
        teardownWebRTC()
        player.pause()
        clearItemObservers()
        player.replaceCurrentItem(with: nil)
        detector.reset()
        deactivateAudioPlayback()
        revokeCurrentSession()
    }

    private func transition(to next: CameraStreamState) {
        guard state != next else { return }
        state = next
        diagnostics.lastStateChangeAt = Date()
    }
}
