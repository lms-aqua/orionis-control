import Foundation

// MARK: - Identity and permissions

enum Role: String, Codable, Sendable, CaseIterable, Comparable {
    case viewer
    case operatorRole = "operator"
    case administrator

    private var rank: Int {
        switch self {
        case .viewer: 1
        case .operatorRole: 2
        case .administrator: 3
        }
    }

    static func < (lhs: Role, rhs: Role) -> Bool { lhs.rank < rhs.rank }

    var displayName: String {
        switch self {
        case .viewer: "Viewer"
        case .operatorRole: "Operator"
        case .administrator: "Administrator"
        }
    }
}

/// Mirrors the server-side permission list.
///
/// This exists so the interface can hide controls the user cannot use. It is
/// **not** a security boundary — the gateway re-checks every protected action.
enum Permission: String, Codable, Sendable {
    case camerasView = "cameras.view"
    case camerasStream = "cameras.stream"
    case camerasSnapshot = "cameras.snapshot"
    case camerasControlPTZ = "cameras.control.ptz"
    case camerasControlLight = "cameras.control.light"
    case camerasControlSiren = "cameras.control.siren"
    case camerasControlPrivacy = "cameras.control.privacy"
    case camerasControlRecording = "cameras.control.recording"
    case camerasControlDetection = "cameras.control.detection"
    case camerasRestart = "cameras.restart"
    case eventsView = "events.view"
    case eventsAcknowledge = "events.acknowledge"
    case recordingsView = "recordings.view"
    case recordingsDelete = "recordings.delete"
    case adguardView = "adguard.view"
    case adguardProtectionPause = "adguard.protection.pause"
    case adguardRulesWrite = "adguard.rules.write"
    case adguardClientsWrite = "adguard.clients.write"
    case adguardFiltersWrite = "adguard.filters.write"
    case systemView = "system.view"
    case systemActionsRun = "system.actions.run"
    case auditView = "audit.view"
    case infraView = "infra.view"
    case infraManage = "infra.manage"
    case devicesManage = "devices.manage"
    case connectionsView = "connections.view"
    case connectionsManage = "connections.manage"
}

struct CurrentUser: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let username: String
    let displayName: String?
    let email: String?
    let role: Role
    let groups: [String]
    let permissions: [Permission]

    func can(_ permission: Permission) -> Bool { permissions.contains(permission) }

    var name: String { displayName ?? username }

    init(
        id: String,
        username: String,
        displayName: String?,
        email: String?,
        role: Role,
        groups: [String],
        permissions: [Permission]
    ) {
        self.id = id
        self.username = username
        self.displayName = displayName
        self.email = email
        self.role = role
        self.groups = groups
        self.permissions = permissions
    }

    /// Decodes the account, ignoring permissions this build does not recognise.
    ///
    /// The gateway owns the permission list and is deployed independently of the
    /// app, so it will periodically hold names a shipped build has never heard of.
    /// Decoding those strictly made the *whole* account undecodable, which blocked
    /// sign-in entirely — a gateway-side feature addition could lock every older
    /// install out of the app. An unrecognised permission is dropped instead: the
    /// worst case is a control the app does not draw yet, and since authorisation
    /// is enforced on the gateway, dropping one grants nothing.
    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        username = try container.decode(String.self, forKey: .username)
        displayName = try container.decodeIfPresent(String.self, forKey: .displayName)
        email = try container.decodeIfPresent(String.self, forKey: .email)
        role = try container.decode(Role.self, forKey: .role)
        groups = try container.decodeIfPresent([String].self, forKey: .groups) ?? []
        permissions = try container.decodeIfPresent([String].self, forKey: .permissions)?
            .compactMap(Permission.init(rawValue:)) ?? []
    }
}

struct SessionSummary: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let deviceId: String
    let deviceName: String?
    let createdAt: Date?
    let lastUsedAt: Date?
    let expiresAt: Date?
    let revoked: Bool
    let current: Bool

    private enum CodingKeys: String, CodingKey {
        case id, deviceId, deviceName, createdAt, lastUsedAt, expiresAt, revoked, current
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        deviceId = try container.decode(String.self, forKey: .deviceId)
        deviceName = try container.decodeIfPresent(String.self, forKey: .deviceName)
        createdAt = try container.decodeIfPresent(Date.self, forKey: .createdAt)
        lastUsedAt = try container.decodeIfPresent(Date.self, forKey: .lastUsedAt)
        expiresAt = try container.decodeIfPresent(Date.self, forKey: .expiresAt)
        // Older gateways did not expose these flags. Treat those sessions as
        // active/non-current so a mobile update remains backward compatible.
        revoked = try container.decodeIfPresent(Bool.self, forKey: .revoked) ?? false
        current = try container.decodeIfPresent(Bool.self, forKey: .current) ?? false
    }
}

// MARK: - Cameras

enum CameraStatus: String, Codable, Sendable {
    case online, offline, degraded, unknown

    var isUsable: Bool { self == .online || self == .degraded }
}

enum StreamProtocolKind: String, Codable, Sendable, CaseIterable {
    case webrtc, llhls, hls, mjpeg

    var displayName: String {
        switch self {
        case .webrtc: "WebRTC"
        case .llhls: "Low-Latency HLS"
        case .hls: "HLS"
        case .mjpeg: "MJPEG"
        }
    }

    /// Preference order the app requests, best latency first.
    static let preferenceOrder: [StreamProtocolKind] = [.webrtc, .llhls, .hls, .mjpeg]
}

enum StreamQuality: String, Codable, Sendable, CaseIterable, Identifiable {
    case auto, low, medium, high
    var id: String { rawValue }
    var displayName: String {
        switch self {
        case .auto: "Automatic"
        case .low: "Low"
        case .medium: "Medium"
        case .high: "High"
        }
    }
}

struct CameraCapabilities: Codable, Sendable, Equatable {
    var ptz = false
    var presets = false
    var zoom = false
    var light = false
    var siren = false
    var privacyMode = false
    var twoWayAudio = false
    /// Nil when the hub has not exposed track metadata yet.
    var audio: Bool? = nil
    var recordingToggle = false
    var motionToggle = false
    var sensitivity = false
    var restart = false
    var snapshot = true
    var protocols: [StreamProtocolKind] = []
    var qualities: [StreamQuality] = [.auto]

    var hasAnyControl: Bool {
        ptz || presets || zoom || light || siren || privacyMode || recordingToggle
            || motionToggle || sensitivity || restart
    }
}

struct CameraHealth: Codable, Sendable, Equatable {
    var status: CameraStatus = .unknown
    /// Nil when the camera hub cannot prove current recorder activity.
    var recording: Bool? = nil
    var streaming = false
    var motionDetected = false
    var privacyEnabled = false
    var lastSeenAt: Date?
    var signalQuality: Double?
    var bitrateKbps: Double?
    var frameRate: Double?
    var resolution: String?
    var message: String?
}

struct Camera: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let name: String
    let location: String?
    let group: String?
    let model: String?
    let firmware: String?
    let capabilities: CameraCapabilities
    let health: CameraHealth
    let snapshotPath: String?
}

struct IceServer: Codable, Sendable, Equatable {
    let urls: [String]
    let username: String?
    let credential: String?
}

struct StreamSession: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let cameraId: String
    let `protocol`: StreamProtocolKind
    let quality: StreamQuality
    let supportedQualities: [StreamQuality]
    let playbackUrl: URL
    let streamToken: String
    let expiresAt: Date
    let iceServers: [IceServer]
    let renewAfterSeconds: Int

    var isExpired: Bool { expiresAt <= Date() }
}

// MARK: - Events and recordings

enum CameraEventType: String, Codable, Sendable, CaseIterable, Identifiable {
    case motion, person, vehicle, package, animal, audio
    case offline, online
    case recordingFailure = "recording_failure"
    case tamper, system

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .motion: "Motion"
        case .person: "Person"
        case .vehicle: "Vehicle"
        case .package: "Package"
        case .animal: "Animal"
        case .audio: "Audio"
        case .offline: "Camera offline"
        case .online: "Camera restored"
        case .recordingFailure: "Recording failure"
        case .tamper: "Tamper"
        case .system: "System"
        }
    }

    var symbolName: String {
        switch self {
        case .motion: "wave.3.right"
        case .person: "figure.walk"
        case .vehicle: "car.fill"
        case .package: "shippingbox.fill"
        case .animal: "pawprint.fill"
        case .audio: "waveform"
        case .offline: "video.slash.fill"
        case .online: "video.fill"
        case .recordingFailure: "exclamationmark.triangle.fill"
        case .tamper: "hand.raised.fill"
        case .system: "gearshape.fill"
        }
    }
}

enum EventSeverity: String, Codable, Sendable, CaseIterable, Comparable {
    case info, warning, critical

    private var rank: Int {
        switch self {
        case .info: 0
        case .warning: 1
        case .critical: 2
        }
    }

    static func < (lhs: EventSeverity, rhs: EventSeverity) -> Bool { lhs.rank < rhs.rank }

    var displayName: String { rawValue.capitalized }
}

struct CameraEvent: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let cameraId: String
    let cameraName: String?
    let type: CameraEventType
    let severity: EventSeverity
    let occurredAt: Date
    let endedAt: Date?
    let confidence: Double?
    let thumbnailPath: String?
    let clipPath: String?
    let recordingId: String?
    let retentionUntil: Date?
    let acknowledged: Bool
    let acknowledgedBy: String?
    let acknowledgedAt: Date?
    let note: String?
}

struct RecordingMarker: Codable, Sendable, Equatable {
    let at: Date
    let type: CameraEventType
    let eventId: String
}

struct Recording: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let cameraId: String
    let cameraName: String?
    let startedAt: Date
    let endedAt: Date
    let durationSeconds: Double
    let sizeBytes: Double?
    /// Nil when the recorder does not expose track metadata for this clip.
    let hasAudio: Bool?
    let retentionUntil: Date?
    let playbackPath: String?
    let markers: [RecordingMarker]
}

// MARK: - AdGuard

enum AdGuardRange: String, Codable, Sendable, CaseIterable, Identifiable {
    case hour, today, day, week, month
    var id: String { rawValue }
    var displayName: String {
        switch self {
        case .hour: "Last hour"
        case .today: "Today"
        case .day: "24 hours"
        case .week: "7 days"
        case .month: "30 days"
        }
    }
}

struct ProtectionOverride: Codable, Sendable, Equatable {
    let id: String
    let disabledBy: String
    let disabledAt: Date
    let resumeAt: Date?
    let reason: String?
}

struct AdGuardStatus: Codable, Sendable, Equatable {
    let protectionEnabled: Bool
    let running: Bool
    let version: String?
    let dnsPort: Int?
    let protectionDisabledUntil: Date?
    let filteringEnabled: Bool
    let safeBrowsingEnabled: Bool?
    let parentalEnabled: Bool?
    let checkedAt: Date
    let override: ProtectionOverride?
}

struct NameCount: Codable, Sendable, Equatable, Identifiable {
    let name: String
    let count: Int
    var id: String { name }
}

struct StatsPoint: Codable, Sendable, Equatable, Identifiable {
    let at: Date
    let queries: Int
    let blocked: Int
    var id: Date { at }
}

struct AdGuardStats: Codable, Sendable, Equatable {
    let range: AdGuardRange
    let totalQueries: Int
    let blockedQueries: Int
    let blockedPercent: Double
    let replacedSafeBrowsing: Int
    let replacedParental: Int
    let averageProcessingMs: Double
    let topClients: [NameCount]
    let topQueriedDomains: [NameCount]
    let topBlockedDomains: [NameCount]
    let series: [StatsPoint]
}

enum QueryStatus: String, Codable, Sendable, CaseIterable {
    case allowed, blocked, rewritten
    case safeSearch = "safe_search"
    case unknown

    var displayName: String {
        switch self {
        case .allowed: "Allowed"
        case .blocked: "Blocked"
        case .rewritten: "Rewritten"
        case .safeSearch: "Safe search"
        case .unknown: "Unknown"
        }
    }
}

struct DnsQuery: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let at: Date
    let client: String
    let clientName: String?
    let domain: String
    let type: String
    let upstream: String?
    let processingMs: Double?
    let status: QueryStatus
    let rule: String?
    let ruleFilterId: Int?
    let responseCode: String?
    /// Exact result reported by AdGuard Home for transparent diagnostics.
    let reason: String?
    let answers: [String]
}

/// A deterministic summary of the query rows currently loaded on-device.
/// It deliberately describes a sample, not AdGuard's all-time statistics.
struct DnsQueryInsights: Sendable, Equatable {
    let total: Int
    let allowed: Int
    let blocked: Int
    let other: Int
    let averageProcessingMs: Double?
    let slowestDomain: String?
    let slowestProcessingMs: Double?
    let topDomains: [NameCount]
    let topClients: [NameCount]

    init(queries: [DnsQuery], topLimit: Int = 5) {
        total = queries.count
        allowed = queries.filter { $0.status == .allowed }.count
        blocked = queries.filter { $0.status == .blocked }.count
        other = total - allowed - blocked

        let timings = queries.compactMap { query -> (String, Double)? in
            guard let value = query.processingMs, value.isFinite, value >= 0 else { return nil }
            return (query.domain, value)
        }
        averageProcessingMs = timings.isEmpty
            ? nil : timings.reduce(0) { $0 + $1.1 } / Double(timings.count)
        let slowest = timings.max { lhs, rhs in lhs.1 < rhs.1 }
        slowestDomain = slowest?.0
        slowestProcessingMs = slowest?.1
        topDomains = Self.ranked(queries.map(\.domain), limit: topLimit)
        topClients = Self.ranked(queries.map { query in
            guard let name = query.clientName, !name.isEmpty else { return query.client }
            return name
        }, limit: topLimit)
    }

    var blockRate: Double? {
        let classified = allowed + blocked
        return classified == 0 ? nil : Double(blocked) / Double(classified) * 100
    }

    var shareText: String {
        var lines = [
            "Orionis Control DNS activity — latest \(total) loaded results",
            "Allowed: \(allowed)",
            "Blocked: \(blocked)",
            "Other: \(other)",
        ]
        if let blockRate { lines.append(String(format: "Block rate: %.1f%%", blockRate)) }
        if let averageProcessingMs {
            lines.append(String(format: "Average processing: %.2f ms", averageProcessingMs))
        }
        if !topDomains.isEmpty {
            lines.append("Top domains: " + topDomains.map { "\($0.name) (\($0.count))" }.joined(separator: ", "))
        }
        if !topClients.isEmpty {
            lines.append("Top clients: " + topClients.map { "\($0.name) (\($0.count))" }.joined(separator: ", "))
        }
        return lines.joined(separator: "\n")
    }

    private static func ranked(_ values: [String], limit: Int) -> [NameCount] {
        guard limit > 0 else { return [] }
        let counts = values.reduce(into: [String: Int]()) { result, value in
            let key = value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !key.isEmpty else { return }
            result[key, default: 0] += 1
        }
        let namedCounts: [NameCount] = counts.map { entry in
            NameCount(name: entry.key, count: entry.value)
        }
        let sortedCounts = namedCounts.sorted { left, right in
            if left.count != right.count { return left.count > right.count }
            return left.name.localizedCaseInsensitiveCompare(right.name) == .orderedAscending
        }
        return Array(sortedCounts.prefix(limit))
    }
}

/// Compact JSON-backed persistence for domains an operator wants to revisit.
enum WatchedDomainStore {
    static let maximumCount = 25

    static func decode(_ rawValue: String) -> [String] {
        guard let data = rawValue.data(using: .utf8),
              let decoded = try? JSONDecoder().decode([String].self, from: data)
        else { return [] }
        var seen = Set<String>()
        return decoded.compactMap(normalize)
            .filter { seen.insert($0).inserted }
            .prefix(maximumCount)
            .map { $0 }
    }

    static func encode(_ domains: [String]) -> String {
        let clean = domains.compactMap(normalize).prefix(maximumCount)
        guard let data = try? JSONEncoder().encode(Array(clean)) else { return "[]" }
        return String(decoding: data, as: UTF8.self)
    }

    static func toggling(_ domain: String, in domains: [String]) -> [String] {
        guard let normalized = normalize(domain) else { return domains }
        let normalizedDomains = domains.compactMap(normalize)
        let wasPresent = normalizedDomains.contains(normalized)
        let clean = normalizedDomains.filter { $0 != normalized }
        if wasPresent { return Array(clean.prefix(maximumCount)) }
        return Array(([normalized] + clean).prefix(maximumCount))
    }

    static func contains(_ domain: String, in domains: [String]) -> Bool {
        guard let normalized = normalize(domain) else { return false }
        return domains.contains(normalized)
    }

    private static func normalize(_ domain: String) -> String? {
        var value = domain.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        while value.hasSuffix(".") { value.removeLast() }
        return value.isEmpty ? nil : value
    }
}

struct DnsClient: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let name: String
    let ids: [String]
    let useGlobalSettings: Bool
    let filteringEnabled: Bool
    let safeBrowsingEnabled: Bool
    let parentalEnabled: Bool
    let tags: [String]
    let lastSeenAt: Date?
    let queryCount: Int?
    let blockedCount: Int?
}

struct FilterList: Codable, Sendable, Equatable, Identifiable {
    let id: Int
    let name: String
    let url: String
    let enabled: Bool
    let ruleCount: Int
    let lastUpdatedAt: Date?
    let whitelist: Bool
}

// MARK: - System

enum ServiceStatus: String, Codable, Sendable, CaseIterable {
    case healthy, warning, critical, offline, unknown

    var displayName: String {
        switch self {
        case .healthy: "Healthy"
        case .warning: "Warning"
        case .critical: "Critical"
        case .offline: "Offline"
        case .unknown: "Unknown"
        }
    }

    /// Status is never communicated by colour alone; every use pairs this
    /// symbol with the display name.
    var symbolName: String {
        switch self {
        case .healthy: "checkmark.circle.fill"
        case .warning: "exclamationmark.triangle.fill"
        case .critical: "xmark.octagon.fill"
        case .offline: "bolt.horizontal.circle.fill"
        case .unknown: "questionmark.circle.fill"
        }
    }

    var severityRank: Int {
        switch self {
        case .healthy: 0
        case .unknown: 1
        case .warning: 2
        case .offline: 3
        case .critical: 4
        }
    }
}

struct ServiceHealth: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let name: String
    let status: ServiceStatus
    let message: String?
    let latencyMs: Double?
    let version: String?
    let checkedAt: Date
    let impacts: [String]
}

struct SystemAction: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let name: String
    let description: String
    let disruptive: Bool
    let target: String
}

struct SystemActionResult: Codable, Sendable, Equatable {
    let actionId: String
    let ok: Bool
    let message: String
    let ranAt: Date
}

struct CameraStorageUsage: Codable, Sendable, Equatable, Identifiable {
    let cameraId: String
    let cameraName: String?
    let bytes: Double
    let fileCount: Int
    let oldestAt: Date?
    let newestAt: Date?

    var id: String { cameraId }
    var displayName: String { cameraName ?? cameraId }
}

struct StorageStatus: Codable, Sendable, Equatable {
    /// The filesystem holding recordings. Shared with everything else on the
    /// host, so these are context rather than the headline.
    let totalBytes: Double?
    let usedBytes: Double?
    let freeBytes: Double?
    /// What recordings themselves occupy, and the budget they are allowed.
    let recordingsBytes: Double?
    let quotaBytes: Double?
    let quotaUsedRatio: Double?
    let quotaFreeBytes: Double?
    let fileCount: Int?
    /// Measured write rate and how long the remaining budget lasts at it.
    let dailyBytes: Double?
    let daysRemaining: Int?
    let retentionDays: Int?
    let oldestRecordingAt: Date?
    let newestRecordingAt: Date?
    let perCamera: [CameraStorageUsage]?

    /// How full the *recordings budget* is.
    ///
    /// Falls back to the filesystem only when no budget is configured. Showing
    /// disk usage under a heading about recordings answered a question nobody
    /// asked: on a shared host, "105 GB of 5.8 TB used" says nothing about how
    /// much room recordings have left.
    var usedFraction: Double? {
        if let ratio = quotaUsedRatio, ratio.isFinite { return min(1, max(0, ratio)) }
        if let quota = quotaBytes, quota > 0, let used = recordingsBytes {
            return min(1, max(0, used / quota))
        }
        guard let total = totalBytes, let used = usedBytes, total > 0 else { return nil }
        return min(1, max(0, used / total))
    }

    /// Bytes recordings occupy, whichever figure the gateway could measure.
    var recordingsUsed: Double? { recordingsBytes ?? usedBytes }

    /// The budget, or the disk when unbudgeted.
    var recordingsCapacity: Double? { quotaBytes ?? totalBytes }

    /// Space recordings may still take, honouring both budget and disk.
    var recordingsHeadroom: Double? { quotaFreeBytes ?? freeBytes }

    /// True when a real budget is in force, as opposed to falling back to the disk.
    var isBudgeted: Bool { (quotaBytes ?? 0) > 0 }
}

/// Recording retention, as reported by the gateway.
///
/// `appliedDays` is what the recorder is actually enforcing; `requestedDays` is a
/// change that has been queued but not yet picked up. They are separate because a
/// change is applied outside the gateway — showing one value would mean claiming a
/// change took effect the moment it was accepted.
struct RetentionSettings: Codable, Sendable, Equatable {
    let appliedDays: Int?
    let requestedDays: Int?
    let requestedAt: Date?
    let pending: Bool
    let minDays: Int
    let maxDays: Int
    /// False when this deployment cannot change retention at all, so the UI shows
    /// a value rather than a control that could not work.
    let changeable: Bool
}

struct RetentionChangeRequest: Codable, Sendable, Equatable {
    let days: Int
}

/// A continuous run of footage, or a gap between runs.
struct CoverageRun: Codable, Sendable, Equatable, Identifiable {
    let startedAt: Date
    let endedAt: Date
    let durationSeconds: Double

    var id: String { "\(startedAt.timeIntervalSince1970)-\(endedAt.timeIntervalSince1970)" }
    var interval: DateInterval { DateInterval(start: startedAt, end: max(endedAt, startedAt)) }
}

/// What the timeline draws for one day.
///
/// The gateway merges the recorder's segments into runs and reports the real gaps,
/// so the app no longer pages through hundreds of ten-minute segments — and the
/// seams where the recorder rotates files are not mistaken for missing footage.
struct RecordingCoverage: Codable, Sendable, Equatable {
    let cameraId: String
    let dayStart: Date
    let dayEnd: Date
    let runs: [CoverageRun]
    let gaps: [CoverageRun]
    let recordedSeconds: Double
    let coverageRatio: Double
    let earliestAt: Date?
    let latestAt: Date?
}

/// Starred cameras and their order, held per account so a second device inherits them.
struct CameraPreferences: Codable, Sendable, Equatable {
    let favouriteIds: [String]
    let order: [String]
}

struct CameraPreferencesUpdate: Codable, Sendable, Equatable {
    let favouriteIds: [String]?
    let order: [String]?
}

// MARK: - Infrastructure

struct CaddyServerState: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let name: String
    let status: String
    let lastPinged: Date?

    var isOnline: Bool { status.lowercased() == "online" }
}

struct CaddyState: Codable, Sendable, Equatable {
    let total: Int?
    let online: Int?
    let offline: Int?
    let unknown: Int?
    let servers: [CaddyServerState]?
    /// Set when this section could not be read; the rest of the page still renders.
    let error: String?
}

struct AutheliaState: Codable, Sendable, Equatable {
    let running: Bool?
    let status: String?
    let health: String?
    let startedAt: Date?
    let restartCount: Int?
    let image: String?
    let error: String?
}

/// A queued Authelia restart. Separate request/applied timestamps because the
/// restart happens outside the gateway — and signs out the session that asked.
struct AutheliaRestartState: Codable, Sendable, Equatable {
    let requestedAt: Date?
    let requestedBy: String?
    let lastRestartedAt: Date?
    let pending: Bool
    let available: Bool
    let message: String?
}

struct InfraStatus: Codable, Sendable, Equatable {
    let caddy: CaddyState
    let authelia: AutheliaState
    let autheliaRestart: AutheliaRestartState
}

struct AutheliaUserSummary: Codable, Sendable, Equatable, Identifiable {
    let username: String
    let displayName: String?
    let email: String?
    let groups: [String]
    let disabled: Bool

    var id: String { username }
}

struct AutheliaBackupSummary: Codable, Sendable, Equatable, Identifiable {
    let name: String
    let size: Double
    let modifiedAt: Date?

    var id: String { name }
}

// MARK: - Audit

struct AuditRecord: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let occurredAt: Date
    let actorName: String?
    let actorRole: String?
    let action: String
    let targetType: String?
    let targetId: String?
    let outcome: String
    let reason: String?
}

// MARK: - Gateway metadata

struct GatewayCapabilities: Codable, Sendable, Equatable {
    let cameras: Bool
    let events: Bool
    let recordings: Bool
    let streaming: Bool
    let adguard: Bool
    let push: Bool
    /// Whether anything upstream can actually detect events.
    ///
    /// Distinct from `events`, which only says the endpoint exists. A healthy
    /// events endpoint with no detection source behind it can never return
    /// anything, and saying "nothing has been recorded" in that case describes a
    /// quiet period rather than a feature that cannot work.
    ///
    /// Optional so an older gateway that does not report it still decodes; nil
    /// means "not stated", which is treated as unknown rather than as false.
    let eventDetection: Bool?
}

struct GatewayAuthentication: Codable, Sendable, Equatable {
    let method: String
    let configured: Bool
    let loginPath: String
    let tokenPath: String
    let allowedRedirectSchemes: [String]
}

struct GatewayMeta: Codable, Sendable, Equatable {
    let product: String
    let apiVersion: String
    let serverVersion: String
    let minimumAppBuild: Int
    let environment: String
    let authentication: GatewayAuthentication
    let capabilities: GatewayCapabilities
    let unconfigured: [String]
}
