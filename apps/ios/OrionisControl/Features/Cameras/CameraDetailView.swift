import AVKit
import SwiftUI

/// Live view for a single camera: metadata, supported controls, recent events.
///
/// Playback is not here. `CameraStreamController` owns the player and the stream
/// lifecycle, so this type never has to reason about reconnects — and the player
/// is not rebuilt every time this view model changes.
@MainActor
@Observable
final class CameraDetailViewModel {
    private(set) var camera: Camera?
    /// The rest of the wall, so full screen can swipe between cameras without
    /// going back to the grid first.
    private(set) var siblings: [Camera] = []
    private(set) var events: [CameraEvent] = []
    private(set) var loadError: APIError?
    private(set) var controlMessage: String?
    private(set) var isInvokingControl = false
    private(set) var snapshot: Data?

    private let cameraId: String
    private let cameras: any CameraServicing
    private let eventsService: any EventServicing

    init(cameraId: String, cameras: any CameraServicing, events: any EventServicing) {
        self.cameraId = cameraId
        self.cameras = cameras
        self.eventsService = events
    }

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

        // Events and the sibling list are secondary: a failure in either must not
        // blank the live view.
        if let page = try? await eventsService.events(
            filter: EventFilter(cameraIds: [cameraId], limit: 10))
        {
            events = page.items
        }
        if let all = try? await cameras.cameras() {
            siblings = all
        }
    }

    func loadSnapshot() async {
        snapshot = try? await cameras.snapshot(cameraId: cameraId)
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
    @Environment(\.scenePhase) private var scenePhase
    @State private var model: CameraDetailViewModel?
    /// Held as view state, not built in `body`: the player must survive
    /// re-evaluation rather than being recreated by it.
    @State private var stream: CameraStreamController?
    @State private var quality: StreamQuality = .auto
    @State private var isMuted = true
    @State private var confirmingControl: CameraControlRequest?
    @State private var showDiagnostics = false
    @State private var showFullScreen = false

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
            if stream == nil {
                stream = CameraStreamController(
                    cameraId: cameraId, service: environment.service)
            }
            quality = environment.preferences.defaultStreamQuality
            isMuted = environment.preferences.startMuted
            await model?.load()
            if environment.preferences.autoplayLiveView {
                await startStream()
            }
        }
        .onDisappear {
            // Revokes the gateway session as well as stopping the decoder, so no
            // stream is left running for a screen nobody is looking at.
            Task { [stream] in await stream?.stop() }
        }
        .fullScreenCover(isPresented: $showFullScreen) {
            // Inline playback is released first: only one stream should be open.
            let wall = model?.siblings.isEmpty == false
                ? model!.siblings
                : [model?.camera].compactMap { $0 }
            CameraLiveViewer(
                cameras: wall,
                startAt: wall.firstIndex(where: { $0.id == cameraId }) ?? 0)
        }
        .onChange(of: showFullScreen) { _, presented in
            if presented {
                Task { await stream?.stop() }
            } else if environment.preferences.autoplayLiveView {
                Task { await startStream() }
            }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: stream?.resumeFromBackground()
            case .inactive, .background: stream?.suspendForBackground()
            @unknown default: break
            }
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

                if let stream {
                    // The video layer stays mounted through buffering and
                    // reconnects so the last decoded frame remains on screen
                    // rather than the view flashing to black. It is dimmed and
                    // labelled whenever the stream is not genuinely live.
                    if stream.state.isLive || stream.state.showsLastFrame {
                        Group {
                            if stream.isWebRTC {
                                WebRTCVideoView(track: stream.webrtc.remoteVideoTrack)
                            } else {
                                CameraVideoView(player: stream.player)
                            }
                        }
                        .opacity(stream.state.isLive ? 1 : 0.45)
                        .allowsHitTesting(false)
                    }
                    playerOverlay(stream, camera: camera)
                }
            }
            .aspectRatio(16 / 9, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .accessibilityElement(children: .combine)
            .accessibilityLabel(
                "\(camera.name) live view. \(stream?.state.statusText ?? "Not connected")")

            playerControls(model, camera: camera)

            if showDiagnostics {
                streamDiagnostics(model, camera: camera)
            }
        }
    }

    /// Status and recovery affordances drawn over the video.
    @ViewBuilder
    private func playerOverlay(_ stream: CameraStreamController, camera: Camera) -> some View {
        switch stream.state {
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

        case .connecting, .buffering:
            VStack(spacing: 8) {
                ProgressView().tint(.white)
                Text(stream.state.statusText)
                    .font(.footnote)
                    .foregroundStyle(.white.opacity(0.8))
            }

        case .reconnecting:
            VStack(spacing: 8) {
                ProgressView().tint(.white)
                Text(stream.state.statusText)
                    .font(.footnote)
                    .foregroundStyle(.white.opacity(0.8))
                Button("Retry now") { stream.retryNow() }
                    .buttonStyle(.bordered)
                    .tint(.white)
                    .controlSize(.small)
            }

        case .live:
            // A live badge, and nothing else covering the picture.
            VStack {
                HStack {
                    LiveBadge()
                    Spacer()
                }
                Spacer()
            }
            .padding(10)

        case .paused:
            VStack(spacing: 8) {
                Image(systemName: "pause.circle.fill")
                    .font(.system(size: 40))
                    .foregroundStyle(.white.opacity(0.9))
                Text("Paused — showing the last frame")
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.8))
            }
            .onTapGesture { stream.resume() }

        case .offline(let reason):
            statusOverlay(
                symbol: "video.slash.fill",
                tint: .orange,
                title: "\(camera.name) is offline",
                detail: reason ?? camera.health.message,
                lastSeen: camera.health.lastSeenAt,
                retry: { stream.retryNow() })

        case .authenticationFailed:
            statusOverlay(
                symbol: "lock.fill",
                tint: .orange,
                title: "Authentication required",
                detail: "Sign in again to watch this camera.",
                lastSeen: nil,
                retry: nil)

        case .unsupported(let kind, let detail):
            statusOverlay(
                symbol: "play.slash.fill",
                tint: .white,
                title: "\(kind.displayName) is not supported in this build",
                detail: detail,
                lastSeen: nil,
                retry: nil)

        case .failed(let reason):
            statusOverlay(
                symbol: "exclamationmark.triangle.fill",
                tint: .orange,
                title: "Stream unavailable",
                detail: reason,
                lastSeen: camera.health.lastSeenAt,
                retry: { stream.retryNow() })
        }
    }

    @ViewBuilder
    private func statusOverlay(
        symbol: String,
        tint: Color,
        title: String,
        detail: String?,
        lastSeen: Date?,
        retry: (() -> Void)?
    ) -> some View {
        VStack(spacing: 8) {
            Image(systemName: symbol).font(.title).foregroundStyle(tint)
            Text(title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.white)
                .multilineTextAlignment(.center)
            if let detail {
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.75))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 20)
            }
            if let lastSeen {
                Text("Last seen \(lastSeen.formatted(date: .abbreviated, time: .shortened))")
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.6))
            }
            if let retry {
                Button("Try again", action: retry)
                    .buttonStyle(.bordered)
                    .tint(.white)
            }
        }
    }

    @ViewBuilder
    private func playerControls(_ model: CameraDetailViewModel, camera: Camera) -> some View {
        HStack(spacing: 12) {
            if let stream, !stream.state.isTerminal {
                Button {
                    if stream.state == .paused { stream.resume() } else { stream.pause() }
                } label: {
                    Label(
                        stream.state == .paused ? "Play" : "Pause",
                        systemImage: stream.state == .paused ? "play.fill" : "pause.fill"
                    )
                    .labelStyle(.iconOnly)
                }
                .buttonStyle(.bordered)
                .accessibilityLabel(
                    stream.state == .paused ? "Resume live view" : "Pause live view")
            }

            if camera.capabilities.audio {
                Button {
                    isMuted.toggle()
                    stream?.setAudioMuted(isMuted)
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

            if camera.health.status.isUsable {
                Button {
                    showFullScreen = true
                } label: {
                    Label(
                        "Full screen",
                        systemImage: "arrow.up.left.and.arrow.down.right"
                    )
                    .labelStyle(.iconOnly)
                }
                .buttonStyle(.bordered)
                .accessibilityLabel("Open full screen")
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
    }

    @ViewBuilder
    private func streamDiagnostics(_ model: CameraDetailViewModel, camera: Camera) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if let stream {
                let d = stream.diagnostics
                diagnosticRow("State", stream.state.statusText)
                if let transport = d.transport {
                    diagnosticRow("Transport", transport.displayName)
                }
                diagnosticRow("Connection attempts", "\(d.connectionAttempts)")
                diagnosticRow("Reconnects", "\(d.reconnectCount)")
                diagnosticRow("Stalls", "\(d.stallCount)")
                if let stale = d.framesStaleFor() {
                    diagnosticRow("Last frame", String(format: "%.0fs ago", stale))
                }
                if let error = d.lastErrorSummary {
                    diagnosticRow("Last error", error)
                }
            }
            // Prefer what the player actually reports over what the camera claims.
            if let resolution = stream?.diagnostics.resolution ?? camera.health.resolution {
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
        guard let camera = model?.camera, let stream else { return }
        // Evaluate the async property first: `await` cannot appear inside the
        // autoclosure of `&&`.
        let conservingData = await environment.api.conservingData
        let lowData = environment.preferences.limitQualityOnCellular && conservingData
        stream.setAudioMuted(isMuted)
        stream.start(camera: camera, quality: quality, lowData: lowData)
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

/// Displays a player that something else owns.
///
/// This view deliberately creates nothing: `CameraStreamController` owns the
/// `AVPlayer`, its item, and the stream's lifecycle. Building a player inside a
/// SwiftUI view means rebuilding it whenever SwiftUI re-evaluates the body, which
/// is what previously restarted playback for unrelated state changes.
struct CameraVideoView: UIViewControllerRepresentable {
    let player: AVPlayer
    /// `false` fits the whole frame (letterboxed); `true` fills the screen and
    /// crops. Cameras are not all 16:9, so this is the viewer's choice, not ours.
    var fills = false

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let controller = AVPlayerViewController()
        controller.allowsPictureInPicturePlayback = true
        controller.canStartPictureInPictureAutomaticallyFromInline = true
        controller.videoGravity = fills ? .resizeAspectFill : .resizeAspect
        // The controller's own chrome would cover the picture and duplicate the
        // app's controls; status and actions are drawn by the viewer instead.
        controller.showsPlaybackControls = false
        controller.player = player
        return controller
    }

    func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {
        if controller.player !== player {
            controller.player = player
        }
        let gravity: AVLayerVideoGravity = fills ? .resizeAspectFill : .resizeAspect
        if controller.videoGravity != gravity {
            controller.videoGravity = gravity
        }
    }

    static func dismantleUIViewController(
        _ controller: AVPlayerViewController, coordinator: Void
    ) {
        // The player outlives this view and is torn down by its controller, so
        // only the reference is dropped here.
        controller.player = nil
    }
}

/// "LIVE" indicator. Text as well as colour, so the state is not conveyed by a
/// red dot alone.
struct LiveBadge: View {
    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(.red)
                .frame(width: 7, height: 7)
            Text("LIVE")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.white)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(.black.opacity(0.55), in: Capsule())
        .accessibilityLabel("Live")
    }
}
