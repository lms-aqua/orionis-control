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
    case devicesManage = "devices.manage"
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
}

struct SessionSummary: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let deviceId: String
    let deviceName: String?
    let createdAt: Date?
    let lastUsedAt: Date?
    let expiresAt: Date?
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
    var audio = false
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
    var recording = false
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
    let hasAudio: Bool
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
    let answers: [String]
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

struct StorageStatus: Codable, Sendable, Equatable {
    let totalBytes: Double?
    let usedBytes: Double?
    let freeBytes: Double?
    let retentionDays: Int?
    let oldestRecordingAt: Date?

    var usedFraction: Double? {
        guard let total = totalBytes, let used = usedBytes, total > 0 else { return nil }
        return used / total
    }
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
