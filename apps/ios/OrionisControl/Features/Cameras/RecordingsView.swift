import AVKit
import Foundation
import SwiftUI

/// Loads and holds a camera's recorded clips for a single day.
///
/// The DVR (MediaMTX) records continuously in 10-minute segments; the gateway
/// serves them back as a list and proxies each clip. A day is the right window
/// to page: small enough to load at once, large enough to scrub a night of
/// footage without hunting.
@MainActor
@Observable
final class RecordingsViewModel {
    private(set) var recordings: [Recording] = []
    private(set) var isLoading = false
    private(set) var loadError: String?

    let cameraId: String
    let cameraName: String
    private let service: any EventServicing

    init(cameraId: String, cameraName: String, service: any EventServicing) {
        self.cameraId = cameraId
        self.cameraName = cameraName
        self.service = service
    }

    func load(day: Date) async {
        isLoading = true
        loadError = nil
        let calendar = Calendar.current
        let start = calendar.startOfDay(for: day)
        let end = calendar.date(byAdding: .day, value: 1, to: start) ?? day
        do {
            let page = try await service.recordings(
                cameraIds: [cameraId], from: start, to: end, limit: 300, offset: 0)
            // Newest first: reviewing footage almost always starts from "what
            // just happened", not the small hours of the morning.
            recordings = page.items.sorted { $0.startedAt > $1.startedAt }
        } catch let error as APIError {
            loadError = error.message
        } catch {
            loadError = "Couldn't load recordings."
        }
        isLoading = false
    }

    /// Clips grouped under an hour header, so a day reads as a timeline rather
    /// than a flat wall of near-identical rows.
    var hourGroups: [RecordingHourGroup] {
        let calendar = Calendar.current
        let buckets = Dictionary(grouping: recordings) { rec -> Date in
            calendar.date(
                bySettingHour: calendar.component(.hour, from: rec.startedAt),
                minute: 0, second: 0, of: rec.startedAt) ?? rec.startedAt
        }
        return buckets.keys.sorted(by: >).map { hour in
            RecordingHourGroup(hour: hour, items: buckets[hour] ?? [])
        }
    }
}

struct RecordingHourGroup: Identifiable {
    let hour: Date
    let items: [Recording]
    var id: Date { hour }
}

/// A camera's recording timeline: pick a day, scan the clips by hour, tap to play.
@MainActor
struct RecordingsView: View {
    let cameraId: String
    let cameraName: String

    @Environment(AppEnvironment.self) private var environment
    @State private var model: RecordingsViewModel?
    @State private var day = Date()
    @State private var playing: Recording?

    var body: some View {
        List {
            Section {
                DatePicker(
                    "Day", selection: $day, in: ...Date(), displayedComponents: .date
                )
                .onChange(of: day) { _, newDay in
                    Task { await model?.load(day: newDay) }
                }
            }

            if let model {
                if model.isLoading {
                    HStack {
                        Spacer()
                        ProgressView()
                        Spacer()
                    }
                } else if let error = model.loadError {
                    Text(error).font(.subheadline).foregroundStyle(.secondary)
                } else if model.recordings.isEmpty {
                    Text("No recordings for this day.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(model.hourGroups) { group in
                        Section(Self.hourFormatter.string(from: group.hour)) {
                            ForEach(group.items) { recording in
                                Button {
                                    playing = recording
                                } label: {
                                    RecordingRow(recording: recording)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("Recordings")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if model == nil {
                let vm = RecordingsViewModel(
                    cameraId: cameraId, cameraName: cameraName, service: environment.service)
                model = vm
                await vm.load(day: day)
            }
        }
        .refreshable { await model?.load(day: day) }
        .sheet(item: $playing) { recording in
            RecordingPlayerView(recording: recording, cameraName: cameraName)
        }
    }

    private static let hourFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "h a"  // "3 PM"
        return f
    }()
}

private struct RecordingRow: View {
    let recording: Recording

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "play.rectangle.fill")
                .font(.title3)
                .foregroundStyle(.tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(Self.timeFormatter.string(from: recording.startedAt))
                    .font(.body.monospacedDigit())
                HStack(spacing: 8) {
                    Text(Self.durationText(recording.durationSeconds))
                    if recording.hasAudio {
                        Label("Audio", systemImage: "speaker.wave.1.fill").labelStyle(.iconOnly)
                    }
                    if !recording.markers.isEmpty {
                        Label("\(recording.markers.count)", systemImage: "bell.fill")
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
        .padding(.vertical, 2)
    }

    private static func durationText(_ seconds: Double) -> String {
        let total = Int(seconds.rounded())
        let m = total / 60
        let s = total % 60
        return m > 0 ? "\(m)m \(s)s" : "\(s)s"
    }

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "h:mm:ss a"
        return f
    }()
}

/// Plays a single recorded clip. The gateway proxies the fmp4 from the DVR, so
/// this is an ordinary authorised media fetch — the same header trick live HLS
/// uses, since AVFoundation cannot go through the typed API client.
@MainActor
struct RecordingPlayerView: View {
    let recording: Recording
    let cameraName: String

    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @State private var player: AVPlayer?
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                if let player {
                    VideoPlayer(player: player).ignoresSafeArea(edges: .bottom)
                } else if let errorText {
                    ContentUnavailableView(
                        "Can't play this clip", systemImage: "exclamationmark.triangle",
                        description: Text(errorText))
                } else {
                    ProgressView().tint(.white)
                }
            }
            .navigationTitle(cameraName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                }
            }
            .task { await prepare() }
            .onDisappear { player?.pause() }
        }
    }

    private func prepare() async {
        guard let path = recording.playbackPath else {
            errorText = "This clip is not available."
            return
        }
        do {
            let media = try await environment.api.authorizedMedia(path: path)
            let asset = AVURLAsset(
                url: media.url,
                options: media.headers.isEmpty
                    ? nil : ["AVURLAssetHTTPHeaderFieldsKey": media.headers])
            let item = AVPlayerItem(asset: asset)
            let avPlayer = AVPlayer(playerItem: item)
            player = avPlayer
            avPlayer.play()
        } catch {
            errorText = "Couldn't load this clip."
        }
    }
}
