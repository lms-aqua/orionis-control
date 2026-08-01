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
    /// The remote video track, once received. The renderer observes this and
    /// attaches itself when it appears.
    private(set) var remoteVideoTrack: RTCVideoTrack?

    /// Reported to the controller so it can drive `CameraStreamState`.
    var onConnectionState: ((WebRTCConnectionState) -> Void)?

    private var peerConnection: RTCPeerConnection?
    private var remoteAudioTrack: RTCAudioTrack?
    private var observer: PeerConnectionObserver?
    private var gatheringContinuation: CheckedContinuation<Void, Never>?
    private var gatheringResumed = false
    private var muted = true

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
        muted = true
        // `close()` resumes any prior wait (setting the flag); arm a fresh one.
        gatheringResumed = false

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
                urlStrings: ice.urls,
                username: ice.username ?? "",
                credential: ice.credential ?? "")
        }

        let observer = PeerConnectionObserver()
        observer.onIceGatheringComplete = { [weak self] in
            Task { @MainActor in self?.resumeGathering() }
        }
        observer.onRemoteVideoTrack = { [weak self] track in
            Task { @MainActor in self?.attach(videoTrack: track) }
        }
        observer.onRemoteAudioTrack = { [weak self] track in
            Task { @MainActor in self?.attach(audioTrack: track) }
        }
        observer.onConnectionState = { [weak self] state in
            Task { @MainActor in self?.handle(connectionState: state) }
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
        await awaitGathering(timeout: .seconds(3))
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
        resumeGathering()
        remoteVideoTrack = nil
        remoteAudioTrack = nil
        peerConnection?.close()
        peerConnection = nil
        observer = nil
    }

    // MARK: - Delegate handling (already hopped to the main actor)

    private func attach(videoTrack: RTCVideoTrack) {
        remoteVideoTrack = videoTrack
    }

    private func attach(audioTrack: RTCAudioTrack) {
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
            Task { [weak self] in
                try? await Task.sleep(for: timeout)
                await MainActor.run { self?.resumeGathering() }
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

        let (data, response) = try await URLSession.shared.data(for: request)
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
private final class PeerConnectionObserver: NSObject, RTCPeerConnectionDelegate {
    var onIceGatheringComplete: (@Sendable () -> Void)?
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

    func peerConnection(_ pc: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}

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
