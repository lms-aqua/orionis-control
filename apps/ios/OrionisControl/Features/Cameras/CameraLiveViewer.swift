import AVKit
import Combine
import SwiftUI

/// Full-screen live viewing for a wall of cameras.
///
/// Exactly one stream is ever open: switching cameras revokes the previous session
/// before opening the next, so swiping through a wall does not leave a trail of
/// live streams behind it, and the device is never asked to decode several at once.
@MainActor
struct CameraLiveViewer: View {
    @State private var cameras: [Camera]

    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase

    @State private var index: Int
    @State private var stream: CameraStreamController?
    @State private var thumbnails: CameraSnapshotStore?
    @State private var showsControls = true
    @State private var showsPlaybackStats = false
    @State private var fillsScreen = false
    @State private var isMuted = true
    @State private var zoom: CGFloat = 1
    @State private var committedZoom: CGFloat = 1
    @State private var pan: CGSize = .zero
    @State private var committedPan: CGSize = .zero
    @State private var hideControlsTask: Task<Void, Never>?
    @State private var cameraSwitchTask: Task<Void, Never>?
    /// Viewer-local quality. Seeded from the preference, then overridable for
    /// this session only — changing it here is not a settings change.
    @State private var quality: StreamQuality = .auto
    /// Chrome must not vanish while a menu is open on top of it.
    @State private var isMenuOpen = false
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Landscape on iPhone: the video has to keep almost the whole display, so
    /// chrome and the switcher both shrink rather than stacking at portrait size.
    private var isCompactHeight: Bool { verticalSizeClass == .compact }

    private let maxZoom: CGFloat = 5

    init(cameras: [Camera], startAt index: Int = 0) {
        _cameras = State(initialValue: cameras)
        _index = State(initialValue: min(max(0, index), max(0, cameras.count - 1)))
    }

    private var camera: Camera? {
        cameras.indices.contains(index) ? cameras[index] : nil
    }

    private var isZoomed: Bool { zoom > 1.01 }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if let stream, let camera {
                video(stream)
                    .ignoresSafeArea()

                if showsControls {
                    controls(stream, camera: camera)
                        .transition(.opacity)
                }
            }
        }
        .statusBarHidden(!showsControls)
        .persistentSystemOverlays(showsControls ? .automatic : .hidden)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: showsControls)
        .task {
            if stream == nil, let camera {
                stream = CameraStreamController(cameraId: camera.id, service: environment.service)
            }
            if thumbnails == nil {
                thumbnails = CameraSnapshotStore(service: environment.service)
            }
            isMuted = environment.preferences.startMuted
            // Seeded before `begin`, which reads it.
            quality = environment.preferences.defaultStreamQuality
            if let camera { await begin(camera: camera) }
            // One pass for the switcher strip; the wall is not kept refreshing
            // while a live stream is the thing being watched.
            await thumbnails?.refresh(
                cameraIds: cameras.filter { $0.health.status.isUsable }.map(\.id))
            scheduleControlsHide()
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(20))
                } catch {
                    return
                }
                await refreshCameraMetadata()
            }
        }
        .onDisappear {
            hideControlsTask?.cancel()
            cameraSwitchTask?.cancel()
            Task { [stream] in await stream?.stop() }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: stream?.resumeFromBackground()
            case .inactive, .background: stream?.suspendForBackground()
            @unknown default: break
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .orionisNetworkPathChanged)) { _ in
            Task { await handleNetworkPathChange() }
        }
    }

    // MARK: Video

    /// Picks the renderer for the active transport: the Metal WebRTC view for
    /// sub-second streams, the `AVPlayer` layer for HLS.
    @ViewBuilder
    private func transportView(_ stream: CameraStreamController) -> some View {
        if stream.isWebRTC {
            WebRTCVideoView(renderer: stream.webrtc.videoRenderer, fills: fillsScreen)
        } else {
            CameraVideoView(player: stream.player, fills: fillsScreen)
        }
    }

    @ViewBuilder
    private func video(_ stream: CameraStreamController) -> some View {
        GeometryReader { geometry in
            ZStack {
                if stream.state.isLive || stream.state.showsLastFrame {
                    transportView(stream)
                        .scaleEffect(zoom)
                        .offset(x: pan.width, y: pan.height)
                        .opacity(stream.state.isLive ? 1 : 0.45)
                } else if let camera, camera.health.status == .offline {
                    // An offline camera is a normal thing to land on while
                    // swiping a wall. Say so plainly and leave every way out
                    // available rather than showing an indefinite spinner.
                    offlineState(camera)
                } else {
                    Color.black
                }

                if !stream.state.isLive, !showsControls {
                    // Even with the chrome hidden, a stream that is not live must
                    // say so rather than presenting a held frame silently.
                    Text(stream.state.statusText)
                        .font(.footnote)
                        .foregroundStyle(.white.opacity(0.85))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(.black.opacity(0.5), in: Capsule())
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
            .contentShape(Rectangle())
            .gesture(zoomGesture)
            .simultaneousGesture(dragGesture(viewport: geometry.size))
            .highPriorityGesture(tapGesture)
        }
    }

    /// Shown instead of an empty black frame when the selected camera is down.
    ///
    /// The last snapshot stays underneath where one exists, desaturated, so the
    /// scene is still recognisable — but it is unmistakably labelled as history
    /// rather than presented as a live picture.
    @ViewBuilder
    private func offlineState(_ camera: Camera) -> some View {
        ZStack {
            Color.black
            if let frame = thumbnails?.frame(for: camera.id) {
                Image(uiImage: frame.image)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .grayscale(1)
                    .opacity(0.28)
            }
            VStack(spacing: 9) {
                Image(systemName: "video.slash.fill")
                    .font(.system(size: 34, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.75))
                Text("\(camera.name) is offline")
                    .font(.headline)
                    .foregroundStyle(.white)
                if let lastSeen = camera.health.lastSeenAt {
                    Text("Last seen \(lastSeen.formatted(date: .omitted, time: .shortened))")
                        .font(.footnote)
                        .foregroundStyle(.white.opacity(0.7))
                }
                if cameras.count > 1 {
                    Text("Swipe or pick another camera below.")
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.55))
                        .padding(.top, 2)
                }
            }
            .padding(20)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(camera.name) is offline."
                + (camera.health.lastSeenAt.map {
                    " Last seen \($0.formatted(date: .omitted, time: .shortened))."
                } ?? ""))
    }

    /// Explicit exclusivity prevents a double tap from also firing the single
    /// tap action and unexpectedly changing both fill mode and control visibility.
    private var tapGesture: some Gesture {
        TapGesture(count: 2)
            .exclusively(before: TapGesture(count: 1))
            .onEnded { result in
                switch result {
                case .first: toggleFillMode()
                case .second: toggleControls()
                }
            }
    }

    private var zoomGesture: some Gesture {
        MagnifyGesture()
            .onChanged { value in
                zoom = min(max(1, committedZoom * value.magnification), maxZoom)
            }
            .onEnded { _ in
                committedZoom = zoom
                if !isZoomed { resetPan() }
            }
    }

    /// While zoomed, dragging pans the picture. At rest, a horizontal drag moves
    /// between cameras — so the two never fight over the same gesture.
    private func dragGesture(viewport: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 12)
            .onChanged { value in
                guard isZoomed else { return }
                pan = CGSize(
                    width: committedPan.width + value.translation.width,
                    height: committedPan.height + value.translation.height)
            }
            .onEnded { value in
                if isZoomed {
                    committedPan = clampPan(pan, viewport: viewport)
                    withAnimation(.easeOut(duration: 0.2)) { pan = committedPan }
                    return
                }
                let threshold: CGFloat = 60
                if value.translation.width < -threshold {
                    advance(by: 1)
                } else if value.translation.width > threshold {
                    advance(by: -1)
                }
            }
    }

    /// Keeps the zoomed picture from being dragged off screen.
    private func clampPan(_ proposed: CGSize, viewport: CGSize) -> CGSize {
        let slackX = max(0, (viewport.width * zoom - viewport.width) / 2)
        let slackY = max(0, (viewport.height * zoom - viewport.height) / 2)
        return CGSize(
            width: min(max(proposed.width, -slackX), slackX),
            height: min(max(proposed.height, -slackY), slackY))
    }

    // MARK: Controls

    @ViewBuilder
    private func controls(_ stream: CameraStreamController, camera: Camera) -> some View {
        VStack(spacing: 0) {
            topBar(stream, camera: camera)
            Spacer()
            bottomBar(stream, camera: camera)
        }
    }

    @ViewBuilder
    private func topBar(_ stream: CameraStreamController, camera: Camera) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.body.weight(.semibold))
                    .frame(width: 30, height: 30)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.white)
            .background(.black.opacity(0.45), in: Circle())
            .accessibilityLabel("Close live view")

            VStack(alignment: .leading, spacing: 2) {
                Text(camera.name)
                    .font(.headline)
                    .foregroundStyle(.white)
                HStack(spacing: 6) {
                    if stream.state.isLive {
                        LiveBadge()
                    } else {
                        Text(stream.state.statusText)
                            .font(.caption)
                            .foregroundStyle(.white.opacity(0.8))
                    }
                    if let location = camera.location {
                        Text(location)
                            .font(.caption)
                            .foregroundStyle(.white.opacity(0.7))
                    }
                }
            }

            Spacer()

            if cameras.count > 1 {
                Text("\(index + 1) of \(cameras.count)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.white.opacity(0.7))
            }

            moreMenu(stream, camera: camera)
        }
        .padding(.horizontal, 16)
        .padding(.top, isCompactHeight ? 6 : 12)
        .padding(.bottom, isCompactHeight ? 12 : 24)
        .background {
            // A gradient keeps the video visible under the chrome, but with
            // Reduce Transparency the label must win over the picture.
            if reduceTransparency {
                Color.black.opacity(0.85)
            } else {
                LinearGradient(
                    colors: [.black.opacity(0.6), .clear], startPoint: .top, endPoint: .bottom)
            }
        }
    }

    /// Secondary controls. Quality lives here rather than on the primary row:
    /// it is changed rarely and would otherwise crowd playback.
    @ViewBuilder
    private func moreMenu(_ stream: CameraStreamController, camera: Camera) -> some View {
        Menu {
            if camera.capabilities.qualities.count > 1 {
                Picker("Quality", selection: $quality) {
                    ForEach(camera.capabilities.qualities) { option in
                        Text(option.displayName).tag(option)
                    }
                }
            }
            Toggle(isOn: $showsPlaybackStats) {
                Label("Playback Statistics", systemImage: "waveform.path.ecg")
            }
            if stream.state.isTerminal, stream.state != .idle {
                Button {
                    stream.retryNow()
                    scheduleControlsHide()
                } label: {
                    Label("Try Again", systemImage: "arrow.clockwise")
                }
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.body.weight(.semibold))
                .foregroundStyle(.white)
                .frame(width: 44, height: 44)
                .contentShape(Circle())
        }
        .glassEffect(.regular.interactive(), in: Circle())
        .accessibilityLabel("More controls")
        // Chrome must not auto-hide out from under an open menu.
        .onTapGesture { isMenuOpen = true }
        .onChange(of: quality) { _, _ in
            isMenuOpen = false
            Task { await applyQualityChange() }
        }
    }

    @ViewBuilder
    private func bottomBar(_ stream: CameraStreamController, camera: Camera) -> some View {
        VStack(spacing: 12) {
            if cameras.count > 1 { switcher }
            if showsPlaybackStats { playbackStats(stream) }

            // Glass cannot sample glass, so the whole control cluster shares one
            // container: the shapes read as a single piece of material and morph
            // together as controls appear and disappear.
            GlassEffectContainer(spacing: 14) {
                HStack(spacing: 14) {
                    if !stream.state.isTerminal {
                        circleButton(
                            stream.state == .paused ? "play.fill" : "pause.fill",
                            label: stream.state == .paused ? "Resume" : "Pause"
                        ) {
                            if stream.state == .paused { stream.resume() } else { stream.pause() }
                            scheduleControlsHide()
                        }
                    }

                    // Only offered when the camera says it carries audio.
                    if camera.capabilities.audio == true {
                        circleButton(
                            isMuted ? "speaker.slash.fill" : "speaker.wave.2.fill",
                            label: isMuted ? "Unmute" : "Mute",
                            isActive: !isMuted
                        ) {
                            isMuted.toggle()
                            stream.setAudioMuted(isMuted)
                            scheduleControlsHide()
                        }
                    }

                    circleButton(
                        fillsScreen
                            ? "arrow.down.right.and.arrow.up.left"
                            : "arrow.up.left.and.arrow.down.right",
                        label: fillsScreen ? "Fit to screen" : "Fill screen",
                        isActive: fillsScreen
                    ) { toggleFillMode() }

                    if isZoomed {
                        circleButton("1.magnifyingglass", label: "Reset zoom") {
                            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) {
                                resetZoom()
                            }
                        }
                    }

                    if stream.state.isTerminal, stream.state != .idle {
                        circleButton("arrow.clockwise", label: "Try again") {
                            stream.retryNow()
                            scheduleControlsHide()
                        }
                    }

                    Spacer()
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, isCompactHeight ? 8 : 16)
        }
        // The glass controls provide their own legibility, so the scrim is only
        // a gentle grounding wash rather than the thing holding them up.
        .background {
            LinearGradient(
                colors: [.clear, .black.opacity(0.45)], startPoint: .top, endPoint: .bottom)
        }
    }


    /// Horizontal strip for jumping straight to another camera.
    private var switcher: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Array(cameras.enumerated()), id: \.element.id) { position, item in
                    Button {
                        guard position != index else { return }
                        selectCamera(at: position, camera: item)
                    } label: {
                        switcherThumbnail(item, isCurrent: position == index)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(
                        "\(item.name), \(item.health.status.accessibleDescription)")
                }
            }
            .padding(.horizontal, 16)
        }
    }

    @ViewBuilder
    private func switcherThumbnail(_ item: Camera, isCurrent: Bool) -> some View {
        ZStack(alignment: .bottomLeading) {
            if let frame = thumbnails?.frame(for: item.id) {
                Image(uiImage: frame.image)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .grayscale(item.health.status == .offline ? 1 : 0)
            } else {
                Rectangle().fill(.white.opacity(0.12))
                Image(systemName: item.health.status == .offline ? "video.slash" : "video")
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.6))
                    .padding(6)
            }

            Text(item.name)
                .font(.caption2.weight(.medium))
                .foregroundStyle(.white)
                .lineLimit(1)
                .padding(.horizontal, 5)
                .padding(.vertical, 2)
                .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 4))
                .padding(4)
        }
        // Landscape shrinks the strip so it cannot eat a third of the display's
        // height; the video is the point of this screen.
        .frame(
            width: isCompactHeight ? 76 : 108,
            height: isCompactHeight ? 43 : 61)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(
                    isCurrent ? Color.accentColor : .white.opacity(0.25),
                    lineWidth: isCurrent ? 2.5 : 1)
        )
        // A ring alone is easy to miss over busy footage, so the current camera
        // is also the only one at full brightness.
        .opacity(isCurrent ? 1 : 0.65)
    }

    /// A viewer control.
    ///
    /// 44×44 is the minimum comfortable target and this used to be 42, which is
    /// below it. The backing also has to hold up over arbitrary video, and turn
    /// opaque when the user asks for Reduce Transparency.
    /// A viewer control on Liquid Glass.
    ///
    /// 44×44 is the minimum comfortable target — this was 42, below it. The
    /// material adapts to whatever the camera is showing underneath, and
    /// handles Reduce Transparency and Increase Contrast itself, so the old
    /// hand-rolled opacity fallback is gone.
    private func circleButton(
        _ symbol: String, label: String, isActive: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(isActive ? Color.accentColor : .white)
                .frame(width: 44, height: 44)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .glassEffect(
            isActive ? .regular.tint(Color.accentColor.opacity(0.28)).interactive()
                : .regular.interactive(),
            in: Circle())
        .accessibilityLabel(label)
        .accessibilityAddTraits(isActive ? [.isButton, .isSelected] : .isButton)
    }

    private func playbackStats(_ stream: CameraStreamController) -> some View {
        let diagnostics = stream.diagnostics
        return HStack(spacing: 12) {
            if let transport = diagnostics.transport {
                Label(transport.displayName, systemImage: "network")
            }
            if let fps = diagnostics.frameRate {
                Label(String(format: "%.0f fps", fps), systemImage: "film.stack")
            }
            Label("\(diagnostics.stallCount) stalls", systemImage: "exclamationmark.arrow.triangle.2.circlepath")
            if diagnostics.lowFrameRateEvents > 0 {
                Label("\(diagnostics.lowFrameRateEvents) low-FPS", systemImage: "speedometer")
            }
            Label("\(diagnostics.reconnectCount) reconnects", systemImage: "arrow.clockwise")
        }
        .font(.caption.monospacedDigit())
        .foregroundStyle(.white.opacity(0.9))
        .lineLimit(1)
        .minimumScaleFactor(0.75)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.black.opacity(0.55), in: Capsule())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "Playback statistics, \(diagnostics.transport?.displayName ?? "unknown transport"), "
                + "\(diagnostics.frameRate.map { String(format: "%.0f frames per second", $0) } ?? "frame rate unavailable"), "
                + "\(diagnostics.stallCount) stalls, \(diagnostics.lowFrameRateEvents) low frame rate recoveries, "
                + "\(diagnostics.reconnectCount) reconnects")
        .padding(.horizontal, 16)
    }

    // MARK: Actions

    private func begin(camera: Camera) async {
        guard let stream else { return }
        let conservingData = await environment.api.conservingData
        let lowData = environment.preferences.limitQualityOnCellular && conservingData
        stream.setAudioMuted(isMuted)
        stream.start(
            camera: camera,
            quality: quality,
            lowData: lowData)
    }

    private func handleNetworkPathChange() async {
        let conservingData = await environment.api.conservingData
        let lowData = environment.preferences.limitQualityOnCellular && conservingData
        stream?.networkPathChanged(lowData: lowData)
    }

    private func refreshCameraMetadata() async {
        guard scenePhase == .active else { return }
        guard let latest = try? await environment.service.cameras() else { return }
        var byId: [String: Camera] = [:]
        for camera in latest { byId[camera.id] = camera }
        // Preserve the filtered/order-specific wall that opened full screen, but
        // refresh names and health so its labels do not become stale.
        cameras = cameras.map { byId[$0.id] ?? $0 }
    }

    private func switchCamera(to camera: Camera) async {
        guard let stream else { return }
        resetZoom()
        let conservingData = await environment.api.conservingData
        let lowData = environment.preferences.limitQualityOnCellular && conservingData
        stream.setAudioMuted(isMuted)
        await stream.switchTo(
            camera: camera,
            quality: quality,
            lowData: lowData)
        scheduleControlsHide()
    }

    private func advance(by delta: Int) {
        guard cameras.count > 1 else { return }
        let next = (index + delta + cameras.count) % cameras.count
        selectCamera(at: next, camera: cameras[next])
    }

    private func selectCamera(at position: Int, camera: Camera) {
        index = position
        showsControls = true
        cameraSwitchTask?.cancel()
        cameraSwitchTask = Task { await switchCamera(to: camera) }
    }

    private func toggleControls() {
        showsControls.toggle()
        if showsControls { scheduleControlsHide() } else { hideControlsTask?.cancel() }
    }

    private func toggleFillMode() {
        fillsScreen.toggle()
        withAnimation(.easeOut(duration: 0.2)) { resetZoom() }
    }

    private func resetZoom() {
        zoom = 1
        committedZoom = 1
        resetPan()
    }

    private func resetPan() {
        pan = .zero
        committedPan = .zero
    }

    /// Chrome gets out of the way on its own, but never while it is the only thing
    /// explaining a stream that is not playing.
    private func scheduleControlsHide() {
        hideControlsTask?.cancel()
        hideControlsTask = Task { [weak stream] in
            try? await Task.sleep(for: .seconds(4))
            guard !Task.isCancelled else { return }
            guard let state = stream?.state, state.isLive else { return }
            // Never pull the chrome out from under an open menu.
            guard !isMenuOpen else { return }
            showsControls = false
        }
    }

    /// Restarts the stream at a newly chosen quality.
    ///
    /// Routed through the same switch path the camera switcher uses, so the
    /// existing cancellation and session-revocation guarantees apply: the old
    /// session is revoked before the new one opens, and mute survives.
    private func applyQualityChange() async {
        guard cameras.indices.contains(index) else { return }
        cameraSwitchTask?.cancel()
        let camera = cameras[index]
        cameraSwitchTask = Task { await switchCamera(to: camera) }
    }
}
