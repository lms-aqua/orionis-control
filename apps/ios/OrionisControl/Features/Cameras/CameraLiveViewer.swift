import AVKit
import SwiftUI

/// Full-screen live viewing for a wall of cameras.
///
/// Exactly one stream is ever open: switching cameras revokes the previous session
/// before opening the next, so swiping through a wall does not leave a trail of
/// live streams behind it, and the device is never asked to decode several at once.
@MainActor
struct CameraLiveViewer: View {
    let cameras: [Camera]

    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss

    @State private var index: Int
    @State private var stream: CameraStreamController?
    @State private var thumbnails: CameraSnapshotStore?
    @State private var showsControls = true
    @State private var fillsScreen = false
    @State private var isMuted = true
    @State private var zoom: CGFloat = 1
    @State private var committedZoom: CGFloat = 1
    @State private var pan: CGSize = .zero
    @State private var committedPan: CGSize = .zero
    @State private var hideControlsTask: Task<Void, Never>?

    private let maxZoom: CGFloat = 5

    init(cameras: [Camera], startAt index: Int = 0) {
        self.cameras = cameras
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
        .animation(.easeInOut(duration: 0.2), value: showsControls)
        .task {
            if stream == nil, let camera {
                stream = CameraStreamController(cameraId: camera.id, service: environment.service)
            }
            if thumbnails == nil {
                thumbnails = CameraSnapshotStore(service: environment.service)
            }
            isMuted = environment.preferences.startMuted
            if let camera { await begin(camera: camera) }
            // One pass for the switcher strip; the wall is not kept refreshing
            // while a live stream is the thing being watched.
            await thumbnails?.refresh(
                cameraIds: cameras.filter { $0.health.status.isUsable }.map(\.id))
            scheduleControlsHide()
        }
        .onDisappear {
            hideControlsTask?.cancel()
            Task { [stream] in await stream?.stop() }
        }
    }

    // MARK: Video

    @ViewBuilder
    private func video(_ stream: CameraStreamController) -> some View {
        GeometryReader { geometry in
            ZStack {
                if stream.state.isLive || stream.state.showsLastFrame {
                    CameraVideoView(player: stream.player, fills: fillsScreen)
                        .scaleEffect(zoom)
                        .offset(x: pan.width, y: pan.height)
                        .opacity(stream.state.isLive ? 1 : 0.45)
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
            // Double tap must be attached before the single tap so the single
            // tap does not swallow it.
            .onTapGesture(count: 2) { toggleFillMode() }
            .onTapGesture { toggleControls() }
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
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 24)
        .background(
            LinearGradient(
                colors: [.black.opacity(0.6), .clear], startPoint: .top, endPoint: .bottom)
        )
    }

    @ViewBuilder
    private func bottomBar(_ stream: CameraStreamController, camera: Camera) -> some View {
        VStack(spacing: 12) {
            if cameras.count > 1 { switcher }

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
                if camera.capabilities.audio {
                    circleButton(
                        isMuted ? "speaker.slash.fill" : "speaker.wave.2.fill",
                        label: isMuted ? "Unmute" : "Mute"
                    ) {
                        isMuted.toggle()
                        stream.player.isMuted = isMuted
                        scheduleControlsHide()
                    }
                }

                circleButton(
                    fillsScreen
                        ? "arrow.down.right.and.arrow.up.left"
                        : "arrow.up.left.and.arrow.down.right",
                    label: fillsScreen ? "Fit to screen" : "Fill screen"
                ) { toggleFillMode() }

                if isZoomed {
                    circleButton("1.magnifyingglass", label: "Reset zoom") {
                        withAnimation(.easeOut(duration: 0.2)) { resetZoom() }
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
            .padding(.horizontal, 16)
            .padding(.bottom, 16)
        }
        .background(
            LinearGradient(
                colors: [.clear, .black.opacity(0.65)], startPoint: .top, endPoint: .bottom)
        )
    }

    /// Horizontal strip for jumping straight to another camera.
    private var switcher: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Array(cameras.enumerated()), id: \.element.id) { position, item in
                    Button {
                        guard position != index else { return }
                        index = position
                        Task { await switchCamera(to: item) }
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
            if let frame = thumbnails?.frame(for: item.id), let image = UIImage(data: frame.data) {
                Image(uiImage: image)
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
        .frame(width: 108, height: 61)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(isCurrent ? Color.accentColor : .white.opacity(0.25), lineWidth: isCurrent ? 2 : 1)
        )
    }

    private func circleButton(
        _ symbol: String, label: String, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.body)
                .frame(width: 42, height: 42)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.white)
        .background(.black.opacity(0.45), in: Circle())
        .accessibilityLabel(label)
    }

    // MARK: Actions

    private func begin(camera: Camera) async {
        guard let stream else { return }
        let conservingData = await environment.api.conservingData
        let lowData = environment.preferences.limitQualityOnCellular && conservingData
        stream.player.isMuted = isMuted
        stream.start(
            camera: camera,
            quality: environment.preferences.defaultStreamQuality,
            lowData: lowData)
    }

    private func switchCamera(to camera: Camera) async {
        guard let stream else { return }
        resetZoom()
        let conservingData = await environment.api.conservingData
        let lowData = environment.preferences.limitQualityOnCellular && conservingData
        stream.player.isMuted = isMuted
        await stream.switchTo(
            camera: camera,
            quality: environment.preferences.defaultStreamQuality,
            lowData: lowData)
        scheduleControlsHide()
    }

    private func advance(by delta: Int) {
        guard cameras.count > 1 else { return }
        let next = (index + delta + cameras.count) % cameras.count
        index = next
        showsControls = true
        Task { await switchCamera(to: cameras[next]) }
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
            showsControls = false
        }
    }
}
