import AVKit
import SwiftUI

/// Live view for a single camera: player, supported controls, recent events.
@MainActor
@Observable
final class CameraDetailViewModel {
    enum PlaybackState: Equatable {
        case idle
        case negotiating
        case playing(StreamSession)
        case reconnecting(attempt: Int)
        case unsupported(StreamProtocolKind, String)
        case failed(APIError)
    }

    private(set) var camera: Camera?
    private(set) var events: [CameraEvent] = []
    private(set) var loadError: APIError?
    private(set) var playback: PlaybackState = .idle
    private(set) var controlMessage: String?
    private(set) var isInvokingControl = false
    private(set) var snapshot: Data?

    private let cameraId: String
    private let cameras: any CameraServicing
    private let eventsService: any EventServicing
    // Assigned only on the main actor; read from the nonisolated deinit purely
    // to cancel it. Task.cancel() is safe to call from any isolation domain.
    private nonisolated(unsafe) var renewTask: Task<Void, Never>?

    init(cameraId: String, cameras: any CameraServicing, events: any EventServicing) {
        self.cameraId = cameraId
        self.cameras = cameras
        self.eventsService = events
    }

    deinit { renewTask?.cancel() }

    func load() async {
        do {
            camera = try await cameras.camera(id: cameraId)
            loadError = nil
        } catch let error as APIError {
            loadError = error
            return
        } catch {
            loadError = .unexpectedStatus(0, requestId: nil)
            return
        }

        // Events are secondary: a failure here must not blank the live view.
        if let page = try? await eventsService.events(
            filter: EventFilter(cameraIds: [cameraId], limit: 10))
        {
            events = page.items
        }
    }

    func loadSnapshot() async {
        snapshot = try? await cameras.snapshot(cameraId: cameraId)
    }

    /// Starts playback, negotiating protocol and quality with the gateway.
    func startStream(quality: StreamQuality, lowData: Bool) async {
        guard let camera else { return }
        guard camera.health.status.isUsable else {
            playback = .failed(
                .server(
                    code: .cameraOffline,
                    message: "\(camera.name) is offline, so there is nothing to play.",
                    recoverable: true, requestId: nil))
            return
        }

        playback = .negotiating
        do {
            let session = try await cameras.createStreamSession(
                cameraId: cameraId, quality: quality, lowData: lowData)

            // AVKit plays HLS natively. WebRTC needs a peer-connection stack
            // this build does not ship; say so rather than fail obscurely.
            switch session.protocol {
            case .hls, .llhls:
                playback = .playing(session)
                scheduleRenewal(session, quality: quality, lowData: lowData)
            case .webrtc:
                playback = .unsupported(
                    .webrtc,
                    "This build plays HLS and Low-Latency HLS. The gateway negotiated WebRTC, which needs a WebRTC stack that is not bundled in this version."
                )
            case .mjpeg:
                playback = .unsupported(
                    .mjpeg,
                    "The gateway offered only MJPEG for this camera. MJPEG playback is not implemented in this version."
                )
            }
        } catch let error as APIError {
            playback = .failed(error)
        } catch {
            playback = .failed(.unexpectedStatus(0, requestId: nil))
        }
    }

    /// Stream tokens are short-lived; renew before they lapse so playback does
    /// not visibly stall.
    private func scheduleRenewal(_ session: StreamSession, quality: StreamQuality, lowData: Bool) {
        renewTask?.cancel()
        renewTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(max(15, session.renewAfterSeconds)))
            guard !Task.isCancelled, let self else { return }
            await self.startStream(quality: quality, lowData: lowData)
        }
    }

    func stopStream() async {
        renewTask?.cancel()
        renewTask = nil
        if case .playing(let session) = playback {
            try? await cameras.endStreamSession(cameraId: cameraId, streamId: session.id)
        }
        playback = .idle
    }

    func invoke(_ request: CameraControlRequest) async {
        isInvokingControl = true
        controlMessage = nil
        defer { isInvokingControl = false }

        do {
            let result = try await cameras.invokeControl(cameraId: cameraId, request: request)
            controlMessage =
                result.message ?? (result.applied ? "Applied." : "The camera did not apply it.")
            // Reflect any state change the camera reports.
            camera = try? await cameras.camera(id: cameraId)
        } catch let error as APIError {
            controlMessage = "\(error.title): \(error.message)"
        } catch {
            controlMessage = "The control could not be sent."
        }
    }
}

struct CameraDetailView: View {
    let cameraId: String

    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @State private var model: CameraDetailViewModel?
    @State private var quality: StreamQuality = .auto
    @State private var isMuted = true
    @State private var confirmingControl: CameraControlRequest?
    @State private var showDiagnostics = false

    var body: some View {
        Group {
            if let model {
                content(model)
            } else {
                LoadingStateView()
            }
        }
        .navigationTitle(model?.camera?.name ?? "Camera")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if model == nil {
                model = CameraDetailViewModel(
                    cameraId: cameraId,
                    cameras: environment.service,
                    events: environment.service)
            }
            quality = environment.preferences.defaultStreamQuality
            isMuted = environment.preferences.startMuted
            await model?.load()
            if environment.preferences.autoplayLiveView {
                await startStream()
            }
        }
        .onDisappear {
            Task { await model?.stopStream() }
        }
        .confirmationDialog(
            confirmationTitle,
            isPresented: Binding(
                get: { confirmingControl != nil },
                set: { if !$0 { confirmingControl = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button(confirmationAction, role: .destructive) {
                if let request = confirmingControl {
                    Task { await performControl(request) }
                }
                confirmingControl = nil
            }
            Button("Cancel", role: .cancel) { confirmingControl = nil }
        } message: {
            Text(confirmationMessage)
        }
    }

    // MARK: Content

    @ViewBuilder
    private func content(_ model: CameraDetailViewModel) -> some View {
        if let error = model.loadError, model.camera == nil {
            ErrorStateView(error: error, retry: { await model.load() })
        } else if let camera = model.camera {
            ScrollView {
                VStack(spacing: 16) {
                    playerSection(model, camera: camera)
                    if camera.capabilities.hasAnyControl {
                        controlsSection(model, camera: camera)
                    }
                    if let message = model.controlMessage {
                        Text(message)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    detailsSection(camera)
                    eventsSection(model)
                }
                .padding(16)
            }
            .refreshable { await model.load() }
        } else {
            LoadingStateView(message: "Loading camera…")
        }
    }

    @ViewBuilder
    private func playerSection(_ model: CameraDetailViewModel, camera: Camera) -> some View {
        VStack(spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: 14).fill(.black)
                switch model.playback {
                case .idle:
                    VStack(spacing: 10) {
                        Image(systemName: "play.circle.fill")
                            .font(.system(size: 44))
                            .foregroundStyle(.white.opacity(0.9))
                        Text("Tap to start live view")
                            .font(.footnote)
                            .foregroundStyle(.white.opacity(0.75))
                    }
                    .onTapGesture { Task { await startStream() } }

                case .negotiating:
                    VStack(spacing: 8) {
                        ProgressView().tint(.white)
                        Text("Connecting…").font(.footnote).foregroundStyle(.white.opacity(0.8))
                    }

                case .reconnecting(let attempt):
                    VStack(spacing: 8) {
                        ProgressView().tint(.white)
                        Text("Reconnecting (attempt \(attempt))…")
                            .font(.footnote).foregroundStyle(.white.opacity(0.8))
                    }

                case .playing(let session):
                    HLSPlayerView(session: session, isMuted: $isMuted)

                case .unsupported(let kind, let detail):
                    VStack(spacing: 8) {
                        Image(systemName: "play.slash.fill")
                            .font(.title)
                            .foregroundStyle(.white.opacity(0.85))
                        Text("\(kind.displayName) is not supported in this build")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(.white)
                        Text(detail)
                            .font(.caption)
                            .foregroundStyle(.white.opacity(0.75))
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 20)
                    }

                case .failed(let error):
                    VStack(spacing: 8) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.title)
                            .foregroundStyle(.orange)
                        Text(error.title)
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(.white)
                        Text(error.message)
                            .font(.caption)
                            .foregroundStyle(.white.opacity(0.75))
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 20)
                        if error.isRetryable {
                            Button("Try again") { Task { await startStream() } }
                                .buttonStyle(.bordered)
                                .tint(.white)
                        }
                    }
                }
            }
            .aspectRatio(16 / 9, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: 14))

            HStack(spacing: 12) {
                if camera.capabilities.audio {
                    Button {
                        isMuted.toggle()
                    } label: {
                        Label(
                            isMuted ? "Unmute" : "Mute",
                            systemImage: isMuted ? "speaker.slash.fill" : "speaker.wave.2.fill"
                        )
                        .labelStyle(.iconOnly)
                    }
                    .buttonStyle(.bordered)
                    .accessibilityLabel(isMuted ? "Unmute audio" : "Mute audio")
                }

                if camera.capabilities.qualities.count > 1 {
                    Picker("Quality", selection: $quality) {
                        ForEach(camera.capabilities.qualities) { option in
                            Text(option.displayName).tag(option)
                        }
                    }
                    .pickerStyle(.menu)
                    .onChange(of: quality) { _, _ in Task { await startStream() } }
                }

                Spacer()

                Button {
                    showDiagnostics.toggle()
                } label: {
                    Label("Diagnostics", systemImage: "waveform.path.ecg")
                        .labelStyle(.iconOnly)
                }
                .buttonStyle(.bordered)
                .accessibilityLabel("Stream diagnostics")
            }

            if showDiagnostics {
                streamDiagnostics(model, camera: camera)
            }
        }
    }

    @ViewBuilder
    private func streamDiagnostics(_ model: CameraDetailViewModel, camera: Camera) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if case .playing(let session) = model.playback {
                diagnosticRow("Protocol", session.protocol.displayName)
                diagnosticRow("Quality", session.quality.displayName)
                diagnosticRow(
                    "Token expires",
                    session.expiresAt.formatted(date: .omitted, time: .standard))
            }
            if let resolution = camera.health.resolution {
                diagnosticRow("Resolution", resolution)
            }
            if let fps = camera.health.frameRate {
                diagnosticRow("Frame rate", String(format: "%.0f fps", fps))
            }
            if let bitrate = camera.health.bitrateKbps {
                diagnosticRow("Bitrate", String(format: "%.0f kbps", bitrate))
            }
            if let quality = camera.health.signalQuality {
                diagnosticRow("Signal", "\(Int(quality * 100))%")
            }
        }
        .font(.caption)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 10))
    }

    private func diagnosticRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value).monospaced()
        }
    }

    // MARK: Controls

    @ViewBuilder
    private func controlsSection(_ model: CameraDetailViewModel, camera: Camera) -> some View {
        let user = environment.auth.state.user

        VStack(alignment: .leading, spacing: 12) {
            Text("Controls").font(.headline)

            if camera.capabilities.ptz {
                PTZPad(
                    enabled: user?.can(.camerasControlPTZ) == true && !model.isInvokingControl
                ) { direction in
                    Task {
                        await performControl(
                            CameraControlRequest(action: .ptz, direction: direction, speed: 0.5))
                    }
                }
            }

            LazyVGrid(columns: [GridItem(.adaptive(minimum: 140), spacing: 10)], spacing: 10) {
                if camera.capabilities.light {
                    controlButton(
                        "Light", "lightbulb.fill", .camerasControlLight,
                        CameraControlRequest(action: .light, value: .flag(true)))
                }
                if camera.capabilities.siren {
                    controlButton(
                        "Siren", "speaker.wave.3.fill", .camerasControlSiren,
                        CameraControlRequest(action: .siren, value: .flag(true)))
                }
                if camera.capabilities.privacyMode {
                    controlButton(
                        camera.health.privacyEnabled ? "Privacy off" : "Privacy on",
                        "eye.slash.fill", .camerasControlPrivacy,
                        CameraControlRequest(
                            action: .privacy, value: .flag(!camera.health.privacyEnabled)))
                }
                if camera.capabilities.recordingToggle {
                    controlButton(
                        camera.health.recording ? "Stop recording" : "Start recording",
                        "record.circle", .camerasControlRecording,
                        CameraControlRequest(
                            action: .recording, value: .flag(!camera.health.recording)))
                }
                if camera.capabilities.motionToggle {
                    controlButton(
                        "Motion detection", "sensor.fill", .camerasControlDetection,
                        CameraControlRequest(action: .motion, value: .flag(true)))
                }
                if camera.capabilities.restart {
                    controlButton(
                        "Restart camera", "arrow.clockwise", .camerasRestart,
                        CameraControlRequest(action: .restart))
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 16))
    }

    @ViewBuilder
    private func controlButton(
        _ title: String, _ symbol: String, _ permission: Permission,
        _ request: CameraControlRequest
    ) -> some View {
        let allowed = environment.auth.state.user?.can(permission) ?? false

        Button {
            if request.isDisruptive {
                confirmingControl = request
            } else {
                Task { await performControl(request) }
            }
        } label: {
            Label(title, systemImage: symbol)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
        }
        .buttonStyle(.bordered)
        .disabled(!allowed || model?.isInvokingControl == true)
        // A disabled control explains itself rather than being silently inert.
        .accessibilityHint(
            allowed ? "" : "Requires a higher role than \(environment.auth.state.user?.role.displayName ?? "yours")")
    }

    // MARK: Details and events

    private func detailsSection(_ camera: Camera) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Details").font(.headline)
            CameraStatusBadge(health: camera.health)
            if let location = camera.location { detailRow("Location", location) }
            if let group = camera.group { detailRow("Group", group) }
            if let model = camera.model { detailRow("Model", model) }
            if let firmware = camera.firmware { detailRow("Firmware", firmware) }
            if let lastSeen = camera.health.lastSeenAt {
                detailRow("Last seen", lastSeen.relativeDescription)
            }
            if let message = camera.health.message {
                Text(message).font(.footnote).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 16))
    }

    private func detailRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value)
        }
        .font(.subheadline)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func eventsSection(_ model: CameraDetailViewModel) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Recent events").font(.headline)
            if model.events.isEmpty {
                Text("No recent events for this camera.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(model.events) { event in
                    EventRow(event: event, compact: true)
                    if event.id != model.events.last?.id { Divider() }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 16))
    }

    // MARK: Actions

    private func startStream() async {
        // Evaluate the async property first: `await` cannot appear inside the
        // autoclosure of `&&`.
        let conservingData = await environment.api.conservingData
        let lowData = environment.preferences.limitQualityOnCellular && conservingData
        await model?.startStream(quality: quality, lowData: lowData)
    }

    private func performControl(_ request: CameraControlRequest) async {
        // Privileged actions can require a biometric confirmation locally, in
        // addition to the server's own role check.
        if request.isDisruptive, environment.preferences.requireBiometricForAdminActions {
            let outcome = await environment.biometrics.authenticate(
                reason: "Confirm \(request.action.rawValue) on this camera.")
            guard outcome == .success else { return }
        }
        await model?.invoke(request)
    }

    private var confirmationTitle: String {
        guard let action = confirmingControl?.action else { return "Confirm" }
        return switch action {
        case .restart: "Restart this camera?"
        case .siren: "Sound the siren?"
        case .privacy: "Change privacy mode?"
        case .recording: "Change recording?"
        default: "Confirm"
        }
    }

    private var confirmationAction: String {
        switch confirmingControl?.action {
        case .restart: "Restart"
        case .siren: "Sound siren"
        default: "Confirm"
        }
    }

    private var confirmationMessage: String {
        switch confirmingControl?.action {
        case .restart:
            "The camera will be unavailable for up to a minute while it restarts."
        case .siren:
            "The siren will be audible to anyone nearby."
        case .privacy:
            "Privacy mode stops this camera recording and streaming until it is turned off."
        case .recording:
            "Changing this affects whether events from this camera are recorded."
        default:
            "This action affects live equipment."
        }
    }
}

/// Directional pad for pan and tilt.
struct PTZPad: View {
    let enabled: Bool
    let onMove: (CameraControlRequest.Direction) -> Void

    var body: some View {
        VStack(spacing: 6) {
            arrow(.up, "chevron.up")
            HStack(spacing: 6) {
                arrow(.left, "chevron.left")
                Button {
                    onMove(.stop)
                } label: {
                    Image(systemName: "stop.fill")
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.bordered)
                .disabled(!enabled)
                .accessibilityLabel("Stop movement")
                arrow(.right, "chevron.right")
            }
            arrow(.down, "chevron.down")
        }
        .frame(maxWidth: .infinity)
    }

    private func arrow(_ direction: CameraControlRequest.Direction, _ symbol: String) -> some View {
        Button {
            onMove(direction)
        } label: {
            Image(systemName: symbol)
                .frame(width: 44, height: 44)
        }
        .buttonStyle(.bordered)
        .disabled(!enabled)
        .accessibilityLabel("Pan \(direction.rawValue)")
    }
}

/// HLS / Low-Latency HLS playback.
///
/// The stream token is attached as an `Authorization` header rather than a
/// query parameter, so it never lands in a URL, a log or a cache key.
struct HLSPlayerView: UIViewControllerRepresentable {
    let session: StreamSession
    @Binding var isMuted: Bool

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let controller = AVPlayerViewController()
        controller.allowsPictureInPicturePlayback = true
        controller.canStartPictureInPictureAutomaticallyFromInline = true
        controller.videoGravity = .resizeAspect
        controller.player = makePlayer()
        controller.player?.isMuted = isMuted
        controller.player?.play()
        return controller
    }

    func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {
        controller.player?.isMuted = isMuted

        // Swap the item only when the session actually changed (renewal).
        let currentURL = (controller.player?.currentItem?.asset as? AVURLAsset)?.url
        if currentURL != session.playbackUrl {
            controller.player?.replaceCurrentItem(with: makeItem())
            controller.player?.play()
        }
    }

    static func dismantleUIViewController(
        _ controller: AVPlayerViewController, coordinator: Void
    ) {
        controller.player?.pause()
        controller.player?.replaceCurrentItem(with: nil)
    }

    private func makeItem() -> AVPlayerItem {
        let asset = AVURLAsset(
            url: session.playbackUrl,
            options: [
                "AVURLAssetHTTPHeaderFieldsKey": [
                    "Authorization": "Bearer \(session.streamToken)"
                ]
            ])
        let item = AVPlayerItem(asset: asset)
        // Keep the live edge tight; this is monitoring, not catch-up viewing.
        item.preferredForwardBufferDuration = 2
        return item
    }

    private func makePlayer() -> AVPlayer {
        let player = AVPlayer(playerItem: makeItem())
        player.automaticallyWaitsToMinimizeStalling = false
        return player
    }
}
