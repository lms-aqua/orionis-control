import AVFoundation
import Foundation
import SwiftUI

struct RecordingPlaybackWindow: Equatable, Sendable {
    let start: Date
    let durationSeconds: Int
    let playableEnd: Date
    let continuation: Date
}

/// Pure window math shared by playback and export. Keeping this outside AVPlayer
/// makes gap, boundary and fractional-duration behavior regression-testable.
enum RecordingWindowPolicy {
    static func window(
        containing date: Date,
        coverage: [DateInterval],
        dayEnd: Date,
        maximumDuration: Int
    ) -> RecordingPlaybackWindow? {
        guard maximumDuration > 0,
              let interval = coverage.first(where: { $0.contains(date) })
        else { return nil }
        let size = Double(maximumDuration)
        let aligned = Date(
            timeIntervalSince1970: (date.timeIntervalSince1970 / size).rounded(.down) * size)
        let start = max(aligned, interval.start)
        let requestedEnd = min(
            min(start.addingTimeInterval(size), interval.end), dayEnd)
        let duration = Int(requestedEnd.timeIntervalSince(start).rounded(.down))
        guard duration >= 1 else { return nil }
        let playableEnd = start.addingTimeInterval(Double(duration))
        let continuation =
            interval.end.timeIntervalSince(playableEnd) < 1 ? interval.end : playableEnd
        return RecordingPlaybackWindow(
            start: start,
            durationSeconds: duration,
            playableEnd: playableEnd,
            continuation: continuation)
    }
}

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
    /// Real gaps between runs, so the scrubber can show where footage is missing
    /// instead of leaving a stretch that merely looks unrecorded.
    private(set) var gaps: [DateInterval] = []
    private(set) var coverageRatio: Double = 0
    private(set) var exportedClip: URL?
    private(set) var isExporting = false
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
    /// Actual end of the loaded clip after clipping it to recorded coverage.
    private var windowEnd: Date?
    private var windowContinuation: Date?
    /// Bumped per load so a slow request that lost the race cannot yank the
    /// viewer back to a moment they already scrubbed away from.
    private var loadGeneration = 0
    /// Coverage and media loads advance independently: installing a media item
    /// must not make the surrounding day load look stale to its own cleanup.
    private var coverageGeneration = 0
    private var resumeAfterBackground = false
    private var isSuspendedForBackground = false
    // Short windows load fast and make scrubbing responsive; playback rolls into
    // the next one automatically, so continuity isn't lost.
    private let windowSeconds = 90

    /// Reached from the nonisolated `deinit` to deregister observers. Swift 6.2
    /// calls the attribute ineffective, but removing it makes the deinit an
    /// isolation error — see the same note in `CameraStreamController`.
    private nonisolated(unsafe) var timeObserver: Any?
    private nonisolated(unsafe) var itemTokens: [NSObjectProtocol] = []

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
        for token in itemTokens { NotificationCenter.default.removeObserver(token) }
        if let timeObserver { player.removeTimeObserver(timeObserver) }
    }

    // MARK: Loading

    func load(day: Date) async {
        // Invalidate any clip URL/header request from the previous day before
        // awaiting coverage. Otherwise that older task can finish during this
        // suspension and briefly replace the player with footage from the wrong
        // date. The eventual loadWindow call gets its own newer generation.
        loadGeneration &+= 1
        coverageGeneration &+= 1
        let generation = coverageGeneration
        player.pause()
        unloadCurrentItem()
        windowStart = nil
        windowEnd = nil
        windowContinuation = nil
        isPlaying = false
        isLoading = true
        defer {
            if generation == coverageGeneration { isLoading = false }
        }
        errorText = nil
        clearExportedClip()
        coverage = []
        gaps = []
        coverageRatio = 0
        hasFootage = false
        dayStart = Calendar.current.startOfDay(for: day)
        do {
            // The gateway merges the recorder's ten-minute segments into runs and
            // reports the gaps, so this no longer pages through every segment and
            // the seams where files rotate are not drawn as missing footage.
            let summary = try await service.coverage(cameraId: cameraId, day: dayStart)
            guard generation == coverageGeneration else { return }
            coverage = summary.runs.map(\.interval)
            gaps = summary.gaps.map(\.interval)
            coverageRatio = summary.coverageRatio
            hasFootage = !coverage.isEmpty
            // Start at the most recent footage — that's what people look at first.
            if let last = coverage.last {
                currentTime = min(last.end - 1, dayEnd)
                loadWindow(containing: currentTime, autoplay: false)
            } else {
                currentTime = dayEnd
                unloadCurrentItem()
            }
        } catch let error as APIError {
            guard generation == coverageGeneration else { return }
            errorText = error.message
        } catch {
            guard generation == coverageGeneration else { return }
            errorText = "Couldn't load recordings."
        }
    }

    /// Extends today's coverage without replacing the active AVPlayer item. A
    /// full `load` here would interrupt playback once a minute; doing nothing
    /// leaves the final hours of a long-open timeline looking like a gap.
    func refreshCoverage(day: Date) async {
        guard !isLoading else { return }
        let requestedStart = Calendar.current.startOfDay(for: day)
        guard requestedStart == dayStart else { return }
        coverageGeneration &+= 1
        let generation = coverageGeneration
        guard let summary = try? await service.coverage(cameraId: cameraId, day: requestedStart),
              generation == coverageGeneration,
              requestedStart == dayStart
        else { return }
        coverage = summary.runs.map(\.interval)
        gaps = summary.gaps.map(\.interval)
        coverageRatio = summary.coverageRatio
        hasFootage = !coverage.isEmpty
    }

    /// Exports the window under the playhead as a file to share or save.
    func exportCurrentWindow() async {
        guard !isExporting else { return }
        guard let window = RecordingWindowPolicy.window(
            containing: currentTime,
            coverage: coverage,
            dayEnd: dayEnd,
            maximumDuration: windowSeconds)
        else {
            errorText = "Move the playhead onto recorded footage before exporting."
            return
        }
        isExporting = true
        defer { isExporting = false }
        do {
            clearExportedClip()
            exportedClip = try await service.exportClip(
                cameraId: cameraId, start: window.start, duration: window.durationSeconds)
        } catch let apiError as APIError {
            errorText = apiError.message
        } catch {
            errorText = "That clip could not be exported."
        }
    }

    func clearExportedClip() {
        if let exportedClip {
            let directory = exportedClip.deletingLastPathComponent()
            if directory.lastPathComponent.hasPrefix(".orionis-download-") {
                try? FileManager.default.removeItem(at: directory)
            } else {
                try? FileManager.default.removeItem(at: exportedClip)
            }
        }
        exportedClip = nil
    }

    var canExportCurrentTime: Bool { isCovered(currentTime) && !isExporting }

    func pause() {
        player.pause()
        isPlaying = false
    }

    func suspendForBackground() {
        guard !isSuspendedForBackground else { return }
        isSuspendedForBackground = true
        resumeAfterBackground = isPlaying
        pause()
    }

    func resumeFromBackground() {
        guard isSuspendedForBackground else { return }
        isSuspendedForBackground = false
        guard resumeAfterBackground else { return }
        resumeAfterBackground = false
        seek(to: currentTime, autoplay: true)
    }

    func clearError() { errorText = nil }

    // MARK: Scrubbing

    func beginScrub() {
        isScrubbing = true
        player.pause()
    }

    func scrub(to date: Date) {
        let target = clamp(date)
        currentTime = target
        // Follow the finger while the moment is already buffered. This costs
        // nothing and is what makes dragging feel immediate; anything outside the
        // loaded window waits for the drag to end rather than firing a request
        // per pixel.
        if isWithinLoadedWindow(target), let windowStart {
            player.seek(
                to: CMTime(seconds: target.timeIntervalSince(windowStart), preferredTimescale: 600),
                toleranceBefore: .zero,
                toleranceAfter: .zero)
        }
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

    /// Windows start on a fixed grid rather than wherever the finger landed.
    ///
    /// Two reasons, both about speed. A window that starts at an arbitrary instant
    /// is unique to that one scrub, so nothing — not the gateway's cache, not the
    /// device's HTTP cache — can ever be reused. And dragging within footage that
    /// is already loaded should not touch the network at all, which is only
    /// decidable if windows have stable boundaries.
    /// True when `date` falls inside the window currently loaded in the player.
    private func isWithinLoadedWindow(_ date: Date) -> Bool {
        guard let windowStart, let windowEnd, player.currentItem != nil else { return false }
        return date >= windowStart && date < windowEnd
    }

    private func seek(to date: Date, autoplay: Bool) {
        let target = clamp(date)
        currentTime = target

        // The fast path: the moment is already in the player's buffer, so this is
        // a local seek with no request and no new item.
        if isWithinLoadedWindow(target), let windowStart {
            let offset = target.timeIntervalSince(windowStart)
            player.seek(
                to: CMTime(seconds: offset, preferredTimescale: 600),
                toleranceBefore: .zero,
                toleranceAfter: .zero)
            if autoplay {
                player.play()
                isPlaying = true
            }
            return
        }

        if isCovered(target) {
            loadWindow(containing: target, autoplay: autoplay)
        } else if let next = nextCoverageStart(after: target) {
            currentTime = next
            loadWindow(containing: next, autoplay: autoplay)
        } else {
            unloadCurrentItem()
            windowStart = nil
            windowEnd = nil
            windowContinuation = nil
            isPlaying = false
        }
    }

    private func loadWindow(containing date: Date, autoplay: Bool) {
        guard let window = RecordingWindowPolicy.window(
            containing: date,
            coverage: coverage,
            dayEnd: dayEnd,
            maximumDuration: windowSeconds)
        else {
            unloadCurrentItem()
            windowStart = nil
            windowEnd = nil
            windowContinuation = nil
            isPlaying = false
            return
        }
        let offset = max(0, date.timeIntervalSince(window.start))
        windowStart = window.start
        windowEnd = window.playableEnd
        windowContinuation = window.continuation
        loadGeneration &+= 1
        let generation = loadGeneration

        let query = [
            "cameraId": cameraId,
            "start": Self.iso.string(from: window.start),
            "duration": String(window.durationSeconds),
        ]
        Task { [weak self] in
            guard let self else { return }
            do {
                let media = try await self.api.authorizedMedia(path: "/recordings/clip", query: query)
                // A later scrub already superseded this load; dropping it keeps a
                // slow request from yanking the viewer back to an old moment.
                guard generation == self.loadGeneration else { return }
                let asset = AVURLAsset(
                    url: media.url,
                    options: media.headers.isEmpty
                        ? nil : ["AVURLAssetHTTPHeaderFieldsKey": media.headers])
                let item = AVPlayerItem(asset: asset)
                self.observe(item: item)
                self.player.replaceCurrentItem(with: item)
                if offset > 0.1 {
                    // In an async context this resolves to the async overload of
                    // seek, which must be awaited; the sync one is only reachable
                    // from the non-async call sites above.
                    _ = await self.player.seek(
                        to: CMTime(seconds: offset, preferredTimescale: 600),
                        toleranceBefore: .zero,
                        toleranceAfter: .zero)
                }
                if autoplay {
                    self.player.play()
                    self.isPlaying = true
                }
            } catch {
                guard generation == self.loadGeneration else { return }
                self.unloadCurrentItem()
                self.windowStart = nil
                self.windowEnd = nil
                self.windowContinuation = nil
                self.isPlaying = false
                self.errorText = "Couldn't load footage at that time."
            }
        }
    }

    private func observe(item: AVPlayerItem) {
        clearItemObservers()
        let center = NotificationCenter.default
        itemTokens = [
            center.addObserver(
                forName: AVPlayerItem.didPlayToEndTimeNotification, object: item, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.windowDidEnd() }
            },
            center.addObserver(
                forName: AVPlayerItem.failedToPlayToEndTimeNotification,
                object: item,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.recordingPlaybackFailed() }
            },
            center.addObserver(
                forName: AVPlayerItem.playbackStalledNotification, object: item, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.errorText = "Recording playback stalled. Check the connection and try again."
                }
            },
        ]
    }

    private func clearItemObservers() {
        for token in itemTokens { NotificationCenter.default.removeObserver(token) }
        itemTokens = []
    }

    private func unloadCurrentItem() {
        clearItemObservers()
        player.replaceCurrentItem(with: nil)
    }

    private func recordingPlaybackFailed() {
        player.pause()
        isPlaying = false
        errorText = "This recording could not continue playing. Move the playhead to retry."
    }

    private func windowDidEnd() {
        // Roll straight into the next window so continuous footage plays through
        // segment boundaries without the user lifting a finger.
        guard isPlaying, let next = windowContinuation else { return }
        // Clear the old item first so seek cannot take its in-buffer fast path and
        // replay the final frame of the window that just ended.
        unloadCurrentItem()
        windowStart = nil
        windowEnd = nil
        windowContinuation = nil
        seek(to: next, autoplay: true)
    }

    private func tick() {
        guard !isScrubbing, let windowStart, let item = player.currentItem else { return }
        let position = player.currentTime().seconds
        guard position.isFinite else { return }
        if item.status == .failed {
            recordingPlaybackFailed()
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
    @Environment(\.scenePhase) private var scenePhase
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
        .sheet(
            isPresented: Binding(
                get: { model?.exportedClip != nil },
                set: { if !$0 { model?.clearExportedClip() } }
            )
        ) {
            if let url = model?.exportedClip {
                ShareLink(item: url) {
                    Label("Save or share this clip", systemImage: "square.and.arrow.up")
                        .padding()
                }
                .presentationDetents([.height(160)])
            }
        }
        .alert(
            "Recordings",
            isPresented: Binding(
                get: { model?.errorText != nil },
                set: { if !$0 { model?.clearError() } }
            )
        ) {
            Button("OK") { model?.clearError() }
        } message: {
            Text(model?.errorText ?? "")
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
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(60))
                } catch {
                    return
                }
                if Calendar.current.isDateInToday(day) {
                    if scenePhase == .active {
                        await model?.refreshCoverage(day: day)
                    }
                }
            }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: model?.resumeFromBackground()
            case .inactive, .background: model?.suspendForBackground()
            @unknown default: break
            }
        }
        .onDisappear { model?.pause() }
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

            if model.coverageRatio > 0 {
                VStack(alignment: .trailing, spacing: 1) {
                    Text("\(Int((model.coverageRatio * 100).rounded()))%")
                        .font(.subheadline.monospacedDigit())
                    Text(Calendar.current.isDateInToday(model.dayStart) ? "of today so far" : "of day")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }

            // Exports the window under the playhead, which is the footage the
            // viewer is actually looking at.
            Button {
                Task { await model.exportCurrentWindow() }
            } label: {
                if model.isExporting {
                    ProgressView()
                } else {
                    Image(systemName: "square.and.arrow.up")
                        .font(.title3)
                }
            }
            .buttonStyle(.plain)
            .disabled(!model.canExportCurrentTime)
            .accessibilityLabel("Export this clip")
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
        let gaps = model.gaps
        return GeometryReader { geo in
            let center = geo.size.width / 2
            Canvas { context, size in
                let mid = size.height / 2

                // Gaps first, so a coverage band drawn over one always wins. A gap
                // is real missing footage -- the recorder was not running, or the
                // camera was down -- as opposed to the seams between segment files,
                // which the gateway already merged away.
                for gap in gaps {
                    let x0 = center + gap.start.timeIntervalSince(currentTime) * pointsPerSecond
                    let x1 = center + gap.end.timeIntervalSince(currentTime) * pointsPerSecond
                    guard x1 >= 0, x0 <= size.width else { continue }
                    let rect = CGRect(
                        x: max(x0, -4), y: mid - 12,
                        width: max(1, min(x1, size.width + 4) - max(x0, -4)), height: 24)
                    context.fill(
                        Path(roundedRect: rect, cornerRadius: 2),
                        with: .color(.orange.opacity(0.28)))
                }

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
