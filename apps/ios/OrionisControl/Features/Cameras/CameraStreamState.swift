import Foundation

/// The lifecycle of one camera's live stream.
///
/// Kept deliberately free of AVFoundation and SwiftUI so the transitions and the
/// reconnect policy are unit-testable without a player or a view. `CameraStreamController`
/// owns the AVFoundation glue and drives this.
enum CameraStreamState: Equatable, Sendable {
    /// Nothing requested yet, or torn down after leaving the viewer.
    case idle
    /// Negotiating a stream session with the gateway.
    case connecting
    /// Session negotiated; the player is filling its buffer and has not shown a frame.
    case buffering
    /// Frames are advancing. This is the only state that may be labelled "live".
    case live
    /// Deliberately paused by the viewer.
    case paused
    /// Recovering: the stream stalled, froze, or the network changed.
    case reconnecting(attempt: Int)
    /// The camera itself reports offline; retrying the stream is pointless.
    case offline(reason: String?)
    /// The stream token or the signed-in session is no longer valid.
    case authenticationFailed
    /// The gateway negotiated a protocol this build cannot play.
    case unsupported(protocol: StreamProtocolKind, detail: String)
    /// Gave up after exhausting the reconnect policy.
    case failed(reason: String)

    /// Whether a "LIVE" badge may be shown. Only genuinely advancing video counts:
    /// a frozen last frame must never be presented as live.
    var isLive: Bool { self == .live }

    /// Whether the viewer should keep showing the last decoded frame (dimmed and
    /// labelled) rather than blanking the video area.
    var showsLastFrame: Bool {
        switch self {
        case .reconnecting, .buffering, .paused: true
        case .idle, .connecting, .live, .offline, .authenticationFailed, .unsupported, .failed:
            false
        }
    }

    /// Whether this is a resting state, i.e. no further automatic work is pending.
    var isTerminal: Bool {
        switch self {
        case .offline, .authenticationFailed, .unsupported, .failed, .idle: true
        case .connecting, .buffering, .live, .paused, .reconnecting: false
        }
    }

    /// Short, non-technical status line. Raw upstream errors never reach here.
    var statusText: String {
        switch self {
        case .idle: "Not connected"
        case .connecting: "Connecting…"
        case .buffering: "Buffering…"
        case .live: "Live"
        case .paused: "Paused"
        case .reconnecting(let attempt): attempt <= 1 ? "Reconnecting…" : "Reconnecting (\(attempt))…"
        case .offline(let reason): reason ?? "Camera offline"
        case .authenticationFailed: "Authentication required"
        case .unsupported: "Playback not supported"
        case .failed: "Stream unavailable"
        }
    }
}

/// Bounded exponential backoff. Deliberately finite: an endless reconnect loop
/// drains the battery and hides a real outage behind a permanent spinner.
struct ReconnectPolicy: Equatable, Sendable {
    var maxAttempts: Int = 5
    var baseDelay: Duration = .seconds(1)
    var maxDelay: Duration = .seconds(30)

    /// Delay before `attempt` (1-based). Doubles per attempt, clamped to `maxDelay`.
    func delay(forAttempt attempt: Int) -> Duration {
        guard attempt > 1 else { return baseDelay }
        let exponent = min(attempt - 1, 16)  // 2^16 * base is far past maxDelay already
        let scaled = baseDelay * Int(pow(2.0, Double(exponent)))
        return scaled > maxDelay ? maxDelay : scaled
    }

    func shouldRetry(afterAttempt attempt: Int) -> Bool { attempt < maxAttempts }
}

/// Counters surfaced in the administrator diagnostics panel. No credentials,
/// tokens or stream URLs are ever recorded here.
struct CameraStreamDiagnostics: Equatable, Sendable {
    var transport: StreamProtocolKind?
    var connectionAttempts = 0
    var reconnectCount = 0
    var stallCount = 0
    var lastFrameAt: Date?
    var lastStateChangeAt: Date?
    var resolution: String?
    var frameRate: Double?
    /// User-facing message of the last failure; never the raw underlying error.
    var lastErrorSummary: String?

    /// Seconds since the last advancing frame, or nil if none has been seen.
    func framesStaleFor(now: Date = Date()) -> TimeInterval? {
        lastFrameAt.map { now.timeIntervalSince($0) }
    }
}

/// Decides whether a stream that reports itself as playing has actually frozen.
///
/// AVPlayer will happily sit on a decoded frame with `timeControlStatus == .playing`
/// when the segments behind it dry up, which is exactly how a dead camera ends up
/// looking live. Watching for the playhead failing to advance catches that.
struct FrozenFrameDetector: Sendable {
    /// How long the playhead may fail to advance before the stream is treated as frozen.
    var tolerance: TimeInterval = 8

    private(set) var lastObservedTime: TimeInterval?
    private(set) var lastAdvanceAt: Date?

    init(tolerance: TimeInterval = 8) {
        self.tolerance = tolerance
    }

    /// Feeds an observed playhead position. Returns true when the stream looks frozen.
    mutating func observe(time: TimeInterval, now: Date = Date()) -> Bool {
        defer { lastObservedTime = time }
        guard let previous = lastObservedTime, let since = lastAdvanceAt else {
            lastAdvanceAt = now
            return false
        }
        // Any forward movement counts as alive. Live HLS playheads can jump
        // backwards on a playlist reset, which is also movement, not a freeze.
        if abs(time - previous) > 0.01 {
            lastAdvanceAt = now
            return false
        }
        return now.timeIntervalSince(since) > tolerance
    }

    mutating func reset(now: Date = Date()) {
        lastObservedTime = nil
        lastAdvanceAt = now
    }
}
