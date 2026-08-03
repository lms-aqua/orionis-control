import Foundation
import ImageIO
import UIKit

struct PreparedSnapshotImage: @unchecked Sendable {
    let image: UIImage
}

enum SnapshotImageDecoder {
    static func prepare(
        _ data: Data, maxPixelSize: Int
    ) async -> PreparedSnapshotImage? {
        await Task.detached(priority: .utility) { () -> PreparedSnapshotImage? in
            guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
                kCGImageSourceShouldCacheImmediately: true,
            ]
            guard let image = CGImageSourceCreateThumbnailAtIndex(
                source, 0, options as CFDictionary)
            else { return nil }
            return PreparedSnapshotImage(image: UIImage(cgImage: image))
        }.value
    }
}

/// Keeps recent snapshot frames for the camera grid.
///
/// The grid shows periodic stills, not live video — several simultaneous decoders
/// would be wasteful on a scrolling list and hard on the battery. Every frame is
/// therefore stamped with the moment it arrived so the UI can say how fresh it is
/// and never imply a still is live.
@MainActor
@Observable
final class CameraSnapshotStore {
    struct Frame {
        /// Decode each JPEG once when it arrives. Keeping compressed bytes here
        /// made every SwiftUI body update run `UIImage(data:)` again, which was
        /// especially visible as hitching while scrolling a multi-camera grid.
        let image: UIImage
        let capturedAt: Date
    }

    private(set) var frames: [String: Frame] = [:]
    /// Cameras whose first frame has not arrived yet, so the grid can show a
    /// skeleton rather than an empty box.
    private(set) var pending: Set<String> = []
    /// Explicit/user-visible refreshes that already have an older frame to show.
    private(set) var refreshing: Set<String> = []
    /// Manual refresh and the periodic loop can meet at the same suspension
    /// point. Coalesce them so one camera never has duplicate downloads/decodes.
    private var inFlight: Set<String> = []
    /// Authoritative IDs for this store. A late decode from a camera removed
    /// while the request was in flight must not put that frame back in memory.
    private var activeCameraIds: Set<String> = []

    private let service: any CameraServicing
    /// Snapshots are full-resolution JPEGs; a handful in flight at once is plenty
    /// and keeps the gateway from being hammered when a big grid appears.
    private let maxConcurrent = 2
    private let refreshInterval: Duration

    init(service: any CameraServicing, refreshInterval: Duration = .seconds(10)) {
        self.service = service
        self.refreshInterval = refreshInterval
    }

    func frame(for cameraId: String) -> Frame? { frames[cameraId] }

    func isPending(_ cameraId: String) -> Bool { pending.contains(cameraId) }
    func isRefreshing(_ cameraId: String) -> Bool { refreshing.contains(cameraId) }

    /// Refreshes the given cameras until cancelled. Driven by the view's `task`,
    /// so it stops when the grid disappears and no work continues off-screen.
    func run(cameraIds: [String]) async {
        let ids = unique(cameraIds)
        reconcile(cameraIds: ids)
        guard !ids.isEmpty else { return }
        while !Task.isCancelled {
            await refreshActive(cameraIds: ids, showsActivity: false)
            do {
                try await Task.sleep(for: refreshInterval)
            } catch {
                return  // cancelled
            }
        }
    }

    /// One pass over the cameras, at most `maxConcurrent` requests at a time.
    func refresh(cameraIds: [String]) async {
        let ids = unique(cameraIds)
        // This can be a one-tile manual refresh, so it is not authoritative for
        // the whole store and must not prune every other camera's frame.
        activeCameraIds.formUnion(ids)
        await refreshActive(cameraIds: ids, showsActivity: true)
    }

    private func refreshActive(cameraIds: [String], showsActivity: Bool) async {
        for slice in chunk(cameraIds, size: maxConcurrent) {
            if Task.isCancelled { return }
            await withTaskGroup(of: Void.self) { group in
                for id in slice {
                    group.addTask { @MainActor in
                        await self.fetch(cameraId: id, showsActivity: showsActivity)
                    }
                }
            }
        }
    }

    private func fetch(cameraId: String, showsActivity: Bool) async {
        guard inFlight.insert(cameraId).inserted else { return }
        defer { inFlight.remove(cameraId) }
        if frames[cameraId] == nil {
            pending.insert(cameraId)
        } else if showsActivity {
            refreshing.insert(cameraId)
        }
        defer {
            pending.remove(cameraId)
            refreshing.remove(cameraId)
        }
        // A camera that cannot produce a frame keeps its previous one, which the
        // grid then marks as stale. Failing loudly per tile would make a busy
        // wall unreadable.
        guard let snapshot = try? await service.snapshot(cameraId: cameraId),
              !snapshot.data.isEmpty
        else {
            return
        }
        // JPEG decompression is CPU-heavy and was running on the main actor just
        // as WebRTC started painting. Downsample off-main to a size that is still
        // comfortably above every grid/switcher thumbnail.
        guard let prepared = await SnapshotImageDecoder.prepare(
            snapshot.data, maxPixelSize: 1_280)
        else { return }
        guard activeCameraIds.contains(cameraId) else { return }
        frames[cameraId] = Frame(image: prepared.image, capturedAt: snapshot.capturedAt)
    }

    private func reconcile(cameraIds: [String]) {
        activeCameraIds = Set(cameraIds)
        frames = frames.filter { activeCameraIds.contains($0.key) }
        pending.formIntersection(activeCameraIds)
        refreshing.formIntersection(activeCameraIds)
    }

    private func unique(_ ids: [String]) -> [String] {
        var seen: Set<String> = []
        return ids.filter { seen.insert($0).inserted }
    }

    private func chunk(_ ids: [String], size: Int) -> [[String]] {
        guard size > 0 else { return [ids] }
        var result: [[String]] = []
        var index = 0
        while index < ids.count {
            result.append(Array(ids[index..<min(index + size, ids.count)]))
            index += size
        }
        return result
    }
}

/// How a snapshot's age should be described, and whether it can still be trusted
/// as representative of what the camera sees now.
enum SnapshotFreshness: Equatable {
    case fresh(seconds: Int)
    case stale(seconds: Int)
    case old(Date)

    static func of(_ capturedAt: Date, now: Date = Date(), staleAfter: TimeInterval = 30) -> Self {
        let age = max(0, now.timeIntervalSince(capturedAt))
        if age < staleAfter { return .fresh(seconds: Int(age)) }
        if age < 300 { return .stale(seconds: Int(age)) }
        return .old(capturedAt)
    }

    var label: String {
        switch self {
        case .fresh(let seconds): seconds <= 1 ? "just now" : "\(seconds)s ago"
        case .stale(let seconds): "\(seconds)s ago"
        case .old(let date): date.formatted(date: .omitted, time: .shortened)
        }
    }

    var isStale: Bool {
        switch self {
        case .fresh: false
        case .stale, .old: true
        }
    }
}
