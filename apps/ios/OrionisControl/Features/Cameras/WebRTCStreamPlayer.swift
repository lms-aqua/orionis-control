import Foundation
import WebRTC

/// Simplified connection lifecycle the controller reacts to. WebRTC's own state
/// machine is richer, but the viewer only needs: still trying, playing, or dead.
enum WebRTCConnectionState: Sendable {
    case connecting
    case connected
    case failed
}

enum WebRTCPlayerError: Error {
    case factoryUnavailable
    case offerFailed
    case noLocalDescription
    case signallingFailed(String)
    case noAnswer
}

struct WebRTCFrameMetrics: Sendable, Equatable {
    let width: Int
    let height: Int
    let framesPerSecond: Double?
}

/// Keeps UDP TURN first without discarding TCP/TLS fallbacks. Configuration
/// order is not assumed because environment-variable edits are easy to reorder.
func prioritizedWebRTCICEURLs(_ urls: [String]) -> [String] {
    var seen: Set<String> = []
    let normalized = urls.compactMap { raw -> String? in
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, seen.insert(value).inserted else { return nil }
        return value
    }
    return normalized.enumerated().sorted { lhs, rhs in
        let left = iceURLPriority(lhs.element)
        let right = iceURLPriority(rhs.element)
        return left == right ? lhs.offset < rhs.offset : left < right
    }.map(\.element)
}

private func iceURLPriority(_ url: String) -> Int {
    let value = url.lowercased()
    if value.contains("transport=udp") { return 0 }
    if value.hasPrefix("turn:") && !value.contains("transport=tcp") { return 1 }
    if value.contains("transport=tcp") { return 2 }
    return 3
}

/// Owns one camera's `RTCPeerConnection` — the sub-second media plane.
///
/// The gateway proxies SDP: this posts a recv-only offer to the stream's
/// signalling URL (authorised by the same stream token as HLS) and applies the
/// answer go2rtc returns. Media then flows over the per-session TURN relay whose
/// credentials rode in on `StreamSession.iceServers`, so go2rtc is never exposed
/// and the relay needs no IP allowlist.
///
/// Kept deliberately parallel to `AVPlayer`: the controller owns one of each and
/// picks per session, so HLS remains a clean fallback when WebRTC cannot connect.
@MainActor
@Observable
final class WebRTCStreamPlayer {
    /// The remote video track, once received.
    private(set) var remoteVideoTrack: RTCVideoTrack?

    /// The Metal renderer, owned here and merely *hosted* by `WebRTCVideoView`.
    /// Keeping it here lets the track be attached the instant it arrives, instead
    /// of waiting on a SwiftUI re-render — the race that left the first open black
    /// until the camera was reopened.
    let videoRenderer = RTCMTLVideoView()

    /// Reported to the controller so it can drive `CameraStreamState`.
    var onConnectionState: ((WebRTCConnectionState) -> Void)?

    /// Fires once per connection, the moment the first video frame actually
    /// decodes. "Connected" is not "playing": a peer connection can come up and
    /// still paint nothing until a keyframe arrives (or never, if the first
    /// negotiation is stillborn). The controller only calls the stream live on
    /// this, and renegotiates if it never comes.
    var onFirstFrame: (() -> Void)?
    /// Throttled to roughly once per second so diagnostics and freeze detection
    /// stay current without scheduling main-actor work for every decoded frame.
    var onFrame: ((WebRTCFrameMetrics) -> Void)?
    private let frameSignal = FrameSignal()

    private var peerConnection: RTCPeerConnection?
    private var remoteAudioTrack: RTCAudioTrack?
    private var observer: PeerConnectionObserver?
    private var gatheringContinuation: CheckedContinuation<Void, Never>?
    private var gatheringResumed = false
    private var gatheringTimeoutTask: Task<Void, Never>?
    private var muted = true
    /// Invalidates delegate callbacks already queued by a peer being replaced.
    private var connectionGeneration = 0

    /// Signalling carries bearer credentials and should neither share cookies nor
    /// reuse cached answers from unrelated app traffic.
    private let signallingSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration)
    }()

    /// One factory process-wide. `RTCInitializeSSL()` must run once before any
    /// factory is built and is balanced for the app's lifetime, so it is never
    /// cleaned up here.
    private static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        let encoder = RTCDefaultVideoEncoderFactory()
        let decoder = RTCDefaultVideoDecoderFactory()
        return RTCPeerConnectionFactory(encoderFactory: encoder, decoderFactory: decoder)
    }()

    // MARK: - Lifecycle

    /// Negotiates a stream. Returns once the answer is applied; the transition to
    /// "connected" arrives later via `onConnectionState`. Throws if signalling
    /// fails, so the controller can fall back to HLS.
    func connect(session: StreamSession) async throws {
        close()
        let generation = connectionGeneration
        // Preserve the controller's current audio preference across reconnects.
        // `playWebRTC` applies it before calling connect; resetting it here made
        // every retry silently mute a stream the viewer had explicitly unmuted.
        // `close()` resumes any prior wait (setting the flag); arm a fresh one.
        gatheringResumed = false
        // Arm first-frame detection for this connection.
        frameSignal.reset()
        frameSignal.onFirstFrame = { [weak self] in
            Task { @MainActor in
                guard let self, self.connectionGeneration == generation else { return }
                self.onFirstFrame?()
            }
        }
        frameSignal.onFrame = { [weak self] metrics in
            Task { @MainActor in
                guard let self, self.connectionGeneration == generation else { return }
                self.onFrame?(metrics)
            }
        }

        let config = RTCConfiguration()
        config.sdpSemantics = .unifiedPlan
        config.bundlePolicy = .maxBundle
        config.rtcpMuxPolicy = .require
        // Vanilla ICE: gather every candidate up front so the single offer we POST
        // carries the TURN relay candidate. go2rtc's HTTP endpoint answers once and
        // does not trickle, so continual gathering would never "complete".
        config.continualGatheringPolicy = .gatherOnce
        config.iceServers = session.iceServers.map { ice in
            RTCIceServer(
                urlStrings: prioritizedWebRTCICEURLs(ice.urls),
                username: ice.username ?? "",
                credential: ice.credential ?? "")
        }
        let hasTurnRelay = session.iceServers
            .flatMap(\.urls)
            .contains {
                let value = $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                return value.hasPrefix("turn:") || value.hasPrefix("turns:")
            }
        if hasTurnRelay {
            // The gateway deliberately does not expose go2rtc's media port;
            // direct host/srflx pairs cannot work and only slow or destabilize
            // candidate selection. Authenticated TURN is the intended path.
            config.iceTransportPolicy = .relay
        }

        let observer = PeerConnectionObserver()
        observer.onIceGatheringComplete = { [weak self] in
            Task { @MainActor in
                guard let self, self.connectionGeneration == generation else { return }
                self.resumeGathering()
            }
        }
        // Waiting for gathering to *complete* meant waiting for every configured
        // TURN URL to finish allocating -- UDP, TCP, and the IP-literal fallback --
        // which is seconds of dead time before the offer can even be sent. A relay
        // candidate is the one that will actually work through NAT, so the offer
        // goes as soon as one exists and the slower servers are simply not waited
        // on. They are still gathered; they are just no longer on the critical path.
        observer.onIceCandidate = { [weak self] sdp in
            let candidate = sdp.lowercased()
            // Prefer the UDP relay path. Sending the offer as soon as a TCP relay
            // appears can lock video onto head-of-line-blocked TURN/TCP before the
            // smoother UDP candidate finishes gathering.
            guard candidate.contains(" udp "), candidate.contains(" typ relay") else { return }
            Task { @MainActor in
                guard let self, self.connectionGeneration == generation else { return }
                self.resumeGathering()
            }
        }
        observer.onRemoteVideoTrack = { [weak self] track in
            let boxed = UncheckedTransfer(value: track)
            Task { @MainActor in
                guard let self, self.connectionGeneration == generation else { return }
                self.attach(videoTrack: boxed.value)
            }
        }
        observer.onRemoteAudioTrack = { [weak self] track in
            let boxed = UncheckedTransfer(value: track)
            Task { @MainActor in
                guard let self, self.connectionGeneration == generation else { return }
                self.attach(audioTrack: boxed.value)
            }
        }
        observer.onConnectionState = { [weak self] state in
            Task { @MainActor in
                guard let self, self.connectionGeneration == generation else { return }
                self.handle(connectionState: state)
            }
        }
        self.observer = observer

        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard
            let pc = Self.factory.peerConnection(
                with: config, constraints: constraints, delegate: observer)
        else {
            throw WebRTCPlayerError.factoryUnavailable
        }
        peerConnection = pc

        // Receive-only: the app never sends media, it only watches.
        let recvVideo = RTCRtpTransceiverInit()
        recvVideo.direction = .recvOnly
        pc.addTransceiver(of: .video, init: recvVideo)
        let recvAudio = RTCRtpTransceiverInit()
        recvAudio.direction = .recvOnly
        pc.addTransceiver(of: .audio, init: recvAudio)

        let offerConstraints = RTCMediaConstraints(
            mandatoryConstraints: [
                "OfferToReceiveVideo": "true",
                "OfferToReceiveAudio": "true",
            ],
            optionalConstraints: nil)

        let offer = try await makeOffer(pc, constraints: offerConstraints)
        try await setLocal(pc, offer)

        // Cap the wait: a relay candidate normally gathers in well under a second;
        // if something stalls we send what we have rather than hang the viewer.
        // Backstop only, for a network where no relay candidate ever appears; the
        // relay callback above normally resumes this in a few hundred milliseconds.
        await awaitGathering(timeout: .milliseconds(1500))
        try Task.checkCancellation()

        guard let local = pc.localDescription else { throw WebRTCPlayerError.noLocalDescription }
        let answerSDP = try await negotiate(offerSDP: local.sdp, session: session)
        try Task.checkCancellation()

        let answer = RTCSessionDescription(type: .answer, sdp: answerSDP)
        try await setRemote(pc, answer)
    }

    /// Mutes or unmutes remote audio by toggling the track. Video is unaffected.
    func setMuted(_ muted: Bool) {
        self.muted = muted
        remoteAudioTrack?.isEnabled = !muted
    }

    /// Tears the connection down. Safe to call repeatedly and from `stop()`.
    func close() {
        connectionGeneration &+= 1
        resumeGathering()
        remoteVideoTrack?.remove(videoRenderer)
        remoteVideoTrack?.remove(frameSignal)
        remoteVideoTrack = nil
        remoteAudioTrack = nil
        peerConnection?.close()
        peerConnection = nil
        observer = nil
    }

    func framesStaleFor() -> TimeInterval? { frameSignal.secondsSinceLastFrame() }

    // MARK: - Delegate handling (already hopped to the main actor)

    private func attach(videoTrack: RTCVideoTrack) {
        // Unified Plan may announce the same track through both `didAdd stream`
        // and `didAdd receiver`. Adding the renderer twice duplicates callbacks
        // and was a direct source of uneven frame delivery.
        if remoteVideoTrack === videoTrack || remoteVideoTrack?.trackId == videoTrack.trackId {
            return
        }
        if let old = remoteVideoTrack {
            old.remove(videoRenderer)
            old.remove(frameSignal)
        }
        remoteVideoTrack = videoTrack
        // Attach immediately, on the main actor, so the renderer is receiving by
        // the time the connection reports "live" — no dependency on view timing.
        videoTrack.add(videoRenderer)
        // A second, invisible renderer whose only job is to report the first frame.
        videoTrack.add(frameSignal)
    }

    private func attach(audioTrack: RTCAudioTrack) {
        if remoteAudioTrack === audioTrack || remoteAudioTrack?.trackId == audioTrack.trackId {
            return
        }
        remoteAudioTrack = audioTrack
        audioTrack.isEnabled = !muted
    }

    private func handle(connectionState: RTCPeerConnectionState) {
        switch connectionState {
        case .connected:
            onConnectionState?(.connected)
        case .failed, .closed:
            onConnectionState?(.failed)
        case .new, .connecting, .disconnected:
            // `.disconnected` is often transient (a brief network blip); WebRTC
            // recovers on its own, so it is not reported as a failure here.
            onConnectionState?(.connecting)
        @unknown default:
            break
        }
    }

    private func resumeGathering() {
        guard !gatheringResumed else { return }
        gatheringResumed = true
        gatheringTimeoutTask?.cancel()
        gatheringTimeoutTask = nil
        gatheringContinuation?.resume()
        gatheringContinuation = nil
    }

    private func awaitGathering(timeout: Duration) async {
        if peerConnection?.iceGatheringState == .complete { return }
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            gatheringContinuation = cont
            // Completion may have fired between the state check and here; if so,
            // resume now rather than waiting out the timeout.
            if gatheringResumed || peerConnection?.iceGatheringState == .complete {
                resumeGathering()
                return
            }
            gatheringTimeoutTask?.cancel()
            gatheringTimeoutTask = Task { [weak self] in
                do {
                    try await Task.sleep(for: timeout)
                } catch {
                    return
                }
                guard !Task.isCancelled else { return }
                self?.resumeGathering()
            }
        }
    }

    // MARK: - Continuation wrappers around the completion-handler API

    private func makeOffer(
        _ pc: RTCPeerConnection, constraints: RTCMediaConstraints
    ) async throws -> RTCSessionDescription {
        try await withCheckedThrowingContinuation { cont in
            pc.offer(for: constraints) { sdp, error in
                if let error {
                    cont.resume(throwing: error)
                } else if let sdp {
                    cont.resume(returning: sdp)
                } else {
                    cont.resume(throwing: WebRTCPlayerError.offerFailed)
                }
            }
        }
    }

    private func setLocal(_ pc: RTCPeerConnection, _ sdp: RTCSessionDescription) async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            pc.setLocalDescription(sdp) { error in
                if let error { cont.resume(throwing: error) } else { cont.resume() }
            }
        }
    }

    private func setRemote(_ pc: RTCPeerConnection, _ sdp: RTCSessionDescription) async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            pc.setRemoteDescription(sdp) { error in
                if let error { cont.resume(throwing: error) } else { cont.resume() }
            }
        }
    }

    // MARK: - Signalling

    /// POSTs the offer to the gateway's WHEP-style proxy and returns the answer
    /// SDP. Authorised by the stream token, not the user session, so it matches
    /// how HLS playback is authorised.
    private func negotiate(offerSDP: String, session: StreamSession) async throws -> String {
        var request = URLRequest(url: session.playbackUrl)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(session.streamToken)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 15
        request.httpBody = try JSONSerialization.data(
            withJSONObject: ["type": "offer", "sdp": offerSDP])

        let (data, response) = try await signallingSession.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw WebRTCPlayerError.signallingFailed("No HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw WebRTCPlayerError.signallingFailed("HTTP \(http.statusCode)")
        }

        struct Envelope: Decodable {
            struct Answer: Decodable { let sdp: String }
            let data: Answer
        }
        do {
            return try JSONDecoder().decode(Envelope.self, from: data).data.sdp
        } catch {
            throw WebRTCPlayerError.noAnswer
        }
    }
}

/// Bridges `RTCPeerConnectionDelegate` (an ObjC protocol whose callbacks arrive
/// on WebRTC's signalling thread) to closures. Kept separate from the
/// `@MainActor` player so the delegate methods stay `nonisolated` and each hops
/// to the main actor itself.
/// Carries a WebRTC object from a signalling thread to the main actor.
///
/// libwebrtc's ObjC types are not `Sendable`-annotated, so handing a track to the
/// main actor is flagged as a possible race. It is safe here for a specific reason:
/// the delegate hands over a freshly created track it does not touch again, and the
/// main actor's only use of it is to attach it to a renderer. This box states that
/// the guarantee comes from WebRTC's ownership model rather than from the compiler.
private struct UncheckedTransfer<Value>: @unchecked Sendable {
    let value: Value
}

/// A no-display `RTCVideoRenderer` attached alongside the Metal view purely to
/// learn when the first frame decodes. `RTCMTLVideoView`'s own size delegate is
/// unreliable across reconnects (the persistent view keeps its last size, so an
/// unchanged resolution fires nothing), whereas `renderFrame` is called for every
/// frame. Fires `onFirstFrame` once per connection; `reset()` re-arms it.
private final class FrameSignal: NSObject, RTCVideoRenderer {
    var onFirstFrame: (@Sendable () -> Void)?
    var onFrame: (@Sendable (WebRTCFrameMetrics) -> Void)?
    private let stateLock = NSLock()
    private var hasFired = false
    private var lastFrameUptime: TimeInterval?
    private var lastReportUptime: TimeInterval?
    private var framesSinceReport = 0

    func reset() {
        stateLock.lock()
        hasFired = false
        lastFrameUptime = nil
        lastReportUptime = nil
        framesSinceReport = 0
        stateLock.unlock()
    }

    func setSize(_ size: CGSize) {}

    func renderFrame(_ frame: RTCVideoFrame?) {
        guard let frame else { return }
        let now = ProcessInfo.processInfo.systemUptime
        stateLock.lock()
        let first = !hasFired
        hasFired = true
        lastFrameUptime = now
        framesSinceReport += 1
        let shouldReport = lastReportUptime.map { now - $0 >= 1 } ?? true
        let framesPerSecond: Double?
        if shouldReport, let previousReport = lastReportUptime {
            framesPerSecond = Double(framesSinceReport) / max(0.001, now - previousReport)
        } else {
            framesPerSecond = nil
        }
        if shouldReport {
            lastReportUptime = now
            framesSinceReport = 0
        }
        stateLock.unlock()
        if first { onFirstFrame?() }
        if shouldReport {
            onFrame?(
                WebRTCFrameMetrics(
                    width: Int(frame.width),
                    height: Int(frame.height),
                    framesPerSecond: framesPerSecond))
        }
    }

    func secondsSinceLastFrame(now: TimeInterval = ProcessInfo.processInfo.systemUptime) -> TimeInterval? {
        stateLock.lock()
        let last = lastFrameUptime
        stateLock.unlock()
        return last.map { max(0, now - $0) }
    }
}

private final class PeerConnectionObserver: NSObject, RTCPeerConnectionDelegate {
    var onIceGatheringComplete: (@Sendable () -> Void)?
    /// The candidate's SDP line only: enough to tell a relay from a host
    /// candidate, and Sendable, unlike RTCIceCandidate itself.
    var onIceCandidate: (@Sendable (String) -> Void)?
    var onRemoteVideoTrack: (@Sendable (RTCVideoTrack) -> Void)?
    var onRemoteAudioTrack: (@Sendable (RTCAudioTrack) -> Void)?
    var onConnectionState: (@Sendable (RTCPeerConnectionState) -> Void)?

    func peerConnection(_ pc: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}

    func peerConnection(_ pc: RTCPeerConnection, didAdd stream: RTCMediaStream) {
        // Unified Plan surfaces tracks via `didAdd rtpReceiver`; this legacy
        // callback is a belt-and-braces path for the video track.
        if let video = stream.videoTracks.first { onRemoteVideoTrack?(video) }
        if let audio = stream.audioTracks.first { onRemoteAudioTrack?(audio) }
    }

    func peerConnection(_ pc: RTCPeerConnection, didRemove stream: RTCMediaStream) {}

    func peerConnectionShouldNegotiate(_ pc: RTCPeerConnection) {}

    func peerConnection(_ pc: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}

    func peerConnection(_ pc: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        if newState == .complete { onIceGatheringComplete?() }
    }

    func peerConnection(_ pc: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        onIceCandidate?(candidate.sdp)
    }

    func peerConnection(_ pc: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}

    func peerConnection(_ pc: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}

    func peerConnection(_ pc: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        onConnectionState?(newState)
    }

    func peerConnection(
        _ pc: RTCPeerConnection, didAdd rtpReceiver: RTCRtpReceiver, streams: [RTCMediaStream]
    ) {
        switch rtpReceiver.track {
        case let video as RTCVideoTrack: onRemoteVideoTrack?(video)
        case let audio as RTCAudioTrack: onRemoteAudioTrack?(audio)
        default: break
        }
    }
}
