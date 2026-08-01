import Foundation

/// Keeps recent snapshot frames for the camera grid.
///
/// The grid shows periodic stills, not live video — several simultaneous decoders
/// would be wasteful on a scrolling list and hard on the battery. Every frame is
/// therefore stamped with the moment it arrived so the UI can say how fresh it is
/// and never imply a still is live.
@MainActor
@Observable
final class CameraSnapshotStore {
    struct Frame: Equatable {
        let data: Data
        let capturedAt: Date
    }

    private(set) var frames: [String: Frame] = [:]
    /// Cameras whose first frame has not arrived yet, so the grid can show a
    /// skeleton rather than an empty box.
    private(set) var pending: Set<String> = []

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

    /// Refreshes the given cameras until cancelled. Driven by the view's `task`,
    /// so it stops when the grid disappears and no work continues off-screen.
    func run(cameraIds: [String]) async {
        guard !cameraIds.isEmpty else { return }
        while !Task.isCancelled {
            await refresh(cameraIds: cameraIds)
            do {
                try await Task.sleep(for: refreshInterval)
            } catch {
                return  // cancelled
            }
        }
    }

    /// One pass over the cameras, at most `maxConcurrent` requests at a time.
    func refresh(cameraIds: [String]) async {
        for slice in chunk(cameraIds, size: maxConcurrent) {
            if Task.isCancelled { return }
            await withTaskGroup(of: Void.self) { group in
                for id in slice {
                    group.addTask { @MainActor in
                        await self.fetch(cameraId: id)
                    }
                }
            }
        }
    }

    private func fetch(cameraId: String) async {
        if frames[cameraId] == nil { pending.insert(cameraId) }
        defer { pending.remove(cameraId) }
        // A camera that cannot produce a frame keeps its previous one, which the
        // grid then marks as stale. Failing loudly per tile would make a busy
        // wall unreadable.
        guard let data = try? await service.snapshot(cameraId: cameraId), !data.isEmpty else {
            return
        }
        frames[cameraId] = Frame(data: data, capturedAt: Date())
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
