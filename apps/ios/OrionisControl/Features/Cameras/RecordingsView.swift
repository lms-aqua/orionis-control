import AVFoundation
import Foundation
import SwiftUI

/// Drives the scrubbable recording timeline: one continuous player whose footage
/// is pulled from an arbitrary instant, plus the day's coverage for the scrubber
/// to draw. Dragging the timeline seeks to a moment; playback rolls forward and
/// loads the next window automatically, so it behaves like a real NVR scrubber
/// rather than a list of clips.
@MainActor
@Observable
final class RecordingsTimelineModel {
    let cameraId: String
    let cameraName: String
    private let service: any EventServicing
    private let api: APIClient

    let player = AVPlayer()

    private(set) var coverage: [DateInterval] = []
    private(set) var isLoading = false
    private(set) var errorText: String?
    private(set) var hasFootage = false

    /// The instant under the playhead. Updated by playback (when not scrubbing)
    /// and by dragging the timeline.
    var currentTime = Date()
    private(set) var isScrubbing = false
    private(set) var isPlaying = false

    /// The day being viewed, and its bounds. The end never runs past "now".
    private(set) var dayStart = Calendar.current.startOfDay(for: Date())
    var dayEnd: Date {
        let end = Calendar.current.date(byAdding: .day, value: 1, to: dayStart) ?? dayStart
        return min(end, Date())
    }

    /// Where the loaded window began, so playback position maps back to wall time.
    private var windowStart: Date?
    private let windowSeconds = 600

    private var timeObserver: Any?
    private nonisolated(unsafe) var endToken: NSObjectProtocol?

    init(cameraId: String, cameraName: String, service: any EventServicing, api: APIClient) {
        self.cameraId = cameraId
        self.cameraName = cameraName
        self.service = service
        self.api = api
        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
    }

    deinit {
        if let endToken { NotificationCenter.default.removeObserver(endToken) }
    }

    // MARK: Loading

    func load(day: Date) async {
        isLoading = true
        errorText = nil
        dayStart = Calendar.current.startOfDay(for: day)
        let end = Calendar.current.date(byAdding: .day, value: 1, to: dayStart) ?? day
        do {
            let page = try await service.recordings(
                cameraIds: [cameraId], from: dayStart, to: end, limit: 200, offset: 0)
            coverage = page.items
                .map { DateInterval(start: $0.startedAt, duration: $0.durationSeconds) }
                .sorted { $0.start < $1.start }
            hasFootage = !coverage.isEmpty
            // Start at the most recent footage — that's what people look at first.
            if let last = coverage.last {
                currentTime = min(last.end - 1, dayEnd)
                loadWindow(from: currentTime, autoplay: false)
            } else {
                currentTime = dayEnd
                player.replaceCurrentItem(with: nil)
            }
        } catch let error as APIError {
            errorText = error.message
        } catch {
            errorText = "Couldn't load recordings."
        }
        isLoading = false
    }

    // MARK: Scrubbing

    func beginScrub() {
        isScrubbing = true
        player.pause()
    }

    func scrub(to date: Date) {
        currentTime = clamp(date)
    }

    func endScrub() {
        isScrubbing = false
        seek(to: currentTime, autoplay: isPlaying)
    }

    func togglePlay() {
        if isPlaying {
            player.pause()
            isPlaying = false
        } else {
            isPlaying = true
            if player.currentItem == nil || !isCovered(currentTime) {
                seek(to: currentTime, autoplay: true)
            } else {
                player.play()
            }
        }
    }

    // MARK: Seeking / windows

    private func seek(to date: Date, autoplay: Bool) {
        let target = clamp(date)
        currentTime = target
        if isCovered(target) {
            loadWindow(from: target, autoplay: autoplay)
        } else if let next = nextCoverageStart(after: target) {
            currentTime = next
            loadWindow(from: next, autoplay: autoplay)
        } else {
            player.replaceCurrentItem(with: nil)
            isPlaying = false
        }
    }

    private func loadWindow(from date: Date, autoplay: Bool) {
        windowStart = date
        let path = "/recordings/clip"
        let query = [
            "cameraId": cameraId,
            "start": Self.iso.string(from: date),
            "duration": String(windowSeconds),
        ]
        Task { [weak self] in
            guard let self else { return }
            do {
                let media = try await self.api.authorizedMedia(path: path, query: query)
                let asset = AVURLAsset(
                    url: media.url,
                    options: media.headers.isEmpty
                        ? nil : ["AVURLAssetHTTPHeaderFieldsKey": media.headers])
                let item = AVPlayerItem(asset: asset)
                self.observeEnd(of: item)
                self.player.replaceCurrentItem(with: item)
                if autoplay {
                    self.player.play()
                    self.isPlaying = true
                }
            } catch {
                self.errorText = "Couldn't load footage at that time."
            }
        }
    }

    private func observeEnd(of item: AVPlayerItem) {
        if let endToken { NotificationCenter.default.removeObserver(endToken) }
        endToken = NotificationCenter.default.addObserver(
            forName: AVPlayerItem.didPlayToEndTimeNotification, object: item, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.windowDidEnd() }
        }
    }

    private func windowDidEnd() {
        // Roll straight into the next window so continuous footage plays through
        // segment boundaries without the user lifting a finger.
        guard isPlaying else { return }
        seek(to: currentTime, autoplay: true)
    }

    private func tick() {
        guard !isScrubbing, let windowStart, let item = player.currentItem else { return }
        let position = player.currentTime().seconds
        guard position.isFinite else { return }
        if item.status == .failed {
            isPlaying = false
            return
        }
        currentTime = min(windowStart.addingTimeInterval(position), dayEnd)
    }

    // MARK: Coverage helpers

    func isCovered(_ date: Date) -> Bool {
        coverage.contains { $0.contains(date) }
    }

    private func nextCoverageStart(after date: Date) -> Date? {
        coverage.first { $0.start > date }?.start
    }

    private func clamp(_ date: Date) -> Date {
        min(max(date, dayStart), dayEnd)
    }

    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
}

/// The recording timeline screen: a player up top, a draggable time-bar below.
@MainActor
struct RecordingsView: View {
    let cameraId: String
    let cameraName: String

    @Environment(AppEnvironment.self) private var environment
    @State private var model: RecordingsTimelineModel?
    @State private var day = Date()

    var body: some View {
        VStack(spacing: 0) {
            DatePicker("Day", selection: $day, in: ...Date(), displayedComponents: .date)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .onChange(of: day) { _, newDay in
                    Task { await model?.load(day: newDay) }
                }

            if let model {
                videoArea(model)
                controls(model)
                Divider()
                TimelineScrubber(model: model)
                    .frame(height: 96)
                    .background(.background.secondary)
            } else {
                Spacer()
                ProgressView()
                Spacer()
            }
        }
        .navigationTitle("Recordings")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if model == nil {
                let vm = RecordingsTimelineModel(
                    cameraId: cameraId, cameraName: cameraName,
                    service: environment.service, api: environment.api)
                model = vm
                await vm.load(day: day)
            }
        }
        .onDisappear { model?.player.pause() }
    }

    @ViewBuilder
    private func videoArea(_ model: RecordingsTimelineModel) -> some View {
        ZStack {
            Color.black
            PlayerLayerView(player: model.player)
            if model.isLoading {
                ProgressView().tint(.white)
            } else if !model.hasFootage {
                ContentUnavailableView(
                    "No recordings", systemImage: "film.stack",
                    description: Text("Nothing was recorded on this day."))
            } else if !model.isCovered(model.currentTime) {
                Text("No footage at this time")
                    .font(.footnote)
                    .foregroundStyle(.white.opacity(0.85))
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .background(.black.opacity(0.5), in: Capsule())
            }
        }
        .aspectRatio(16 / 9, contentMode: .fit)
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    private func controls(_ model: RecordingsTimelineModel) -> some View {
        HStack(spacing: 16) {
            Button {
                model.togglePlay()
            } label: {
                Image(systemName: model.isPlaying ? "pause.circle.fill" : "play.circle.fill")
                    .font(.system(size: 40))
            }
            .buttonStyle(.plain)
            .disabled(!model.hasFootage)

            VStack(alignment: .leading, spacing: 1) {
                Text(Self.clock.string(from: model.currentTime))
                    .font(.title3.monospacedDigit())
                Text(Self.dayLabel.string(from: model.currentTime))
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private static let clock: DateFormatter = {
        let f = DateFormatter(); f.dateFormat = "h:mm:ss a"; return f
    }()
    private static let dayLabel: DateFormatter = {
        let f = DateFormatter(); f.dateFormat = "EEE, MMM d"; return f
    }()
}

/// A horizontal, draggable time-bar. The playhead is fixed at centre; the bar
/// scrolls under it. Recorded stretches are drawn as filled bands so gaps are
/// obvious, and each hour is ticked and labelled.
@MainActor
struct TimelineScrubber: View {
    let model: RecordingsTimelineModel

    /// Screen points per second of footage. 300 pt/hour reads as a comfortable
    /// drag: a full swipe moves a bit over an hour.
    private let pointsPerSecond: Double = 300.0 / 3600.0
    @State private var dragAnchor: Date?

    var body: some View {
        // Read the observed values here, in the body, so the Canvas (an escaping
        // closure that wouldn't otherwise register the dependency) redraws as the
        // playhead moves and coverage loads.
        let currentTime = model.currentTime
        let coverage = model.coverage
        return GeometryReader { geo in
            let center = geo.size.width / 2
            Canvas { context, size in
                let mid = size.height / 2

                // Recorded coverage bands.
                for interval in coverage {
                    let x0 = center + interval.start.timeIntervalSince(currentTime)
                        * pointsPerSecond
                    let x1 = center + interval.end.timeIntervalSince(currentTime)
                        * pointsPerSecond
                    guard x1 >= 0, x0 <= size.width else { continue }
                    let rect = CGRect(
                        x: max(x0, -4), y: mid - 12,
                        width: max(2, min(x1, size.width + 4) - max(x0, -4)), height: 24)
                    context.fill(
                        Path(roundedRect: rect, cornerRadius: 4),
                        with: .color(.accentColor.opacity(0.55)))
                }

                // Hour ticks + labels across the visible span.
                let visibleSeconds = Double(size.width) / pointsPerSecond
                let firstHour = currentTime.addingTimeInterval(-visibleSeconds / 2)
                var hour = Calendar.current.dateInterval(of: .hour, for: firstHour)?.start
                    ?? firstHour
                while hour <= currentTime.addingTimeInterval(visibleSeconds / 2) {
                    let x = center + hour.timeIntervalSince(currentTime) * pointsPerSecond
                    if x >= 0, x <= size.width {
                        context.stroke(
                            Path { p in
                                p.move(to: CGPoint(x: x, y: mid - 18))
                                p.addLine(to: CGPoint(x: x, y: mid + 18))
                            }, with: .color(.secondary.opacity(0.4)), lineWidth: 1)
                        context.draw(
                            Text(Self.hour.string(from: hour)).font(.caption2)
                                .foregroundStyle(.secondary),
                            at: CGPoint(x: x, y: mid + 30))
                    }
                    hour = hour.addingTimeInterval(3600)
                }
            }
            .overlay {
                // Fixed centre playhead.
                Rectangle().fill(.red).frame(width: 2)
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 1)
                    .onChanged { value in
                        if dragAnchor == nil {
                            dragAnchor = model.currentTime
                            model.beginScrub()
                        }
                        let deltaSeconds = -Double(value.translation.width) / pointsPerSecond
                        model.scrub(to: (dragAnchor ?? model.currentTime)
                            .addingTimeInterval(deltaSeconds))
                    }
                    .onEnded { _ in
                        dragAnchor = nil
                        model.endScrub()
                    }
            )
        }
    }

    private static let hour: DateFormatter = {
        let f = DateFormatter(); f.dateFormat = "h a"; return f
    }()
}

/// AVPlayer surface with no built-in controls — the timeline owns interaction.
struct PlayerLayerView: UIViewRepresentable {
    let player: AVPlayer

    func makeUIView(context: Context) -> PlayerHostView {
        let view = PlayerHostView()
        view.playerLayer.player = player
        view.playerLayer.videoGravity = .resizeAspect
        return view
    }

    func updateUIView(_ view: PlayerHostView, context: Context) {
        if view.playerLayer.player !== player { view.playerLayer.player = player }
    }
}

final class PlayerHostView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}
