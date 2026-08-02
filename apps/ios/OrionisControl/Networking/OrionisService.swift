import Foundation

/// Typed access to every gateway route the app uses.
///
/// Split into protocols so a feature depends only on what it needs, and so
/// tests can substitute one area without stubbing the whole API.
protocol MetaServicing: Sendable {
    func meta() async throws -> GatewayMeta
}

protocol CameraServicing: Sendable {
    func cameras() async throws -> [Camera]
    func camera(id: String) async throws -> Camera
    func snapshot(cameraId: String) async throws -> Data
    func createStreamSession(
        cameraId: String,
        quality: StreamQuality,
        lowData: Bool,
        preferredProtocols: [StreamProtocolKind]
    ) async throws -> StreamSession
    func endStreamSession(cameraId: String, streamId: String) async throws
    func invokeControl(cameraId: String, request: CameraControlRequest) async throws
        -> CameraControlResult
    func cameraPreferences() async throws -> CameraPreferences
    func setCameraPreferences(_ update: CameraPreferencesUpdate) async throws -> CameraPreferences
}

/// Caddy and Authelia. Administrator-only on the server; the app hides it too.
protocol InfraServicing: Sendable {
    func infraStatus() async throws -> InfraStatus
    func autheliaUsers() async throws -> [AutheliaUserSummary]
    func autheliaBackups() async throws -> [AutheliaBackupSummary]
    func restoreAutheliaBackup(name: String) async throws
    func setAutheliaPassword(username: String, password: String) async throws
    func requestAutheliaRestart() async throws -> AutheliaRestartState
    func caddyConfig() async throws -> String
    func autheliaConfig() async throws -> String
}

extension CameraServicing {
    /// Requests the app's full preference order (best latency first). The explicit
    /// overload exists so the stream controller can pin a single protocol when it
    /// falls back from WebRTC to HLS.
    func createStreamSession(cameraId: String, quality: StreamQuality, lowData: Bool) async throws
        -> StreamSession
    {
        try await createStreamSession(
            cameraId: cameraId,
            quality: quality,
            lowData: lowData,
            preferredProtocols: StreamProtocolKind.preferenceOrder)
    }
}

protocol EventServicing: Sendable {
    func events(filter: EventFilter) async throws -> Paged<CameraEvent>
    func event(id: String) async throws -> CameraEvent
    func acknowledge(eventId: String, note: String?) async throws -> CameraEvent
    func recordings(cameraIds: [String], from: Date?, to: Date?, limit: Int, offset: Int)
        async throws -> Paged<Recording>
    func coverage(cameraId: String, day: Date) async throws -> RecordingCoverage
    /// Downloads a clip to a temporary file and returns it, ready to share.
    func exportClip(cameraId: String, start: Date, duration: Int) async throws -> URL
    func recordingStorage() async throws -> StorageStatus
    func retention() async throws -> RetentionSettings
    func setRetention(days: Int) async throws -> RetentionSettings
}

protocol AdGuardServicing: Sendable {
    func adGuardStatus() async throws -> AdGuardStatus
    func adGuardStats(range: AdGuardRange) async throws -> AdGuardStats
    func queryLog(search: String?, status: QueryLogFilter, client: String?, limit: Int)
        async throws -> Paged<DnsQuery>
    func adGuardClients() async throws -> [DnsClient]
    func adGuardFilters() async throws -> [FilterList]
    func customRules() async throws -> [String]
    func addRule(_ rule: String, kind: RuleKind) async throws -> AddRuleResult
    func removeRule(_ rule: String) async throws
    func setProtection(_ change: ProtectionChangeRequest) async throws -> AdGuardStatus
}

protocol SystemServicing: Sendable {
    func dashboard() async throws -> DashboardSnapshot
    func services() async throws -> SystemHealthSnapshot
    func availableActions() async throws -> [SystemAction]
    func runAction(_ actionId: String, serviceId: String?, reason: String?) async throws
        -> SystemActionResult
    func auditLog(limit: Int, offset: Int) async throws -> Paged<AuditRecord>
}

protocol DeviceServicing: Sendable {
    func devices() async throws -> [SessionSummary]
    func removeDevice(sessionId: String) async throws
    func registerPushToken(_ token: String, sandbox: Bool) async throws -> PushRegistrationResult
    func notificationPreferences() async throws -> NotificationPreferencesResponse
    func updateNotificationPreferences(_ prefs: NotificationPreferences) async throws
}

typealias OrionisServicing = MetaServicing & CameraServicing & EventServicing & AdGuardServicing
    & SystemServicing & DeviceServicing & InfraServicing

// MARK: - Request and response types

struct EventFilter: Sendable, Equatable {
    var cameraIds: [String] = []
    var types: [CameraEventType] = []
    var severities: [EventSeverity] = []
    var from: Date?
    var to: Date?
    var acknowledged: Bool?
    var limit = 50
    var offset = 0

    var isFiltered: Bool {
        !cameraIds.isEmpty || !types.isEmpty || !severities.isEmpty || from != nil || to != nil
            || acknowledged != nil
    }

    static let none = EventFilter()
}

enum QueryLogFilter: String, Sendable, CaseIterable, Identifiable {
    case all, blocked, allowed
    var id: String { rawValue }
    var displayName: String {
        switch self {
        case .all: "All"
        case .blocked: "Blocked"
        case .allowed: "Allowed"
        }
    }
}

enum RuleKind: String, Sendable { case allow, block }

struct AddRuleResult: Decodable, Sendable {
    let rule: String
    let ruleCount: Int
    let replayed: Bool?
}

struct ProtectionChangeRequest: Encodable, Sendable {
    let enabled: Bool
    let durationSeconds: Int?
    let until: Date?
    let reason: String?
}

struct CameraControlRequest: Encodable, Sendable, Equatable {
    enum Action: String, Encodable, Sendable {
        case ptz, preset, zoom, light, siren, privacy, recording, motion, sensitivity, restart
    }
    enum Direction: String, Encodable, Sendable { case up, down, left, right, stop }

    let action: Action
    var direction: Direction?
    var presetId: String?
    var value: ControlValue?
    var speed: Double?

    /// Controls take either a flag or a number; this keeps the payload honest.
    enum ControlValue: Encodable, Sendable, Equatable {
        case flag(Bool)
        case number(Double)

        func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            switch self {
            case .flag(let value): try container.encode(value)
            case .number(let value): try container.encode(value)
            }
        }
    }

    /// Actions that need an explicit confirmation before they are sent.
    var isDisruptive: Bool {
        [.siren, .privacy, .restart, .recording].contains(action)
    }

    /// The permission the gateway will require.
    var requiredPermission: Permission {
        switch action {
        case .ptz, .preset, .zoom: .camerasControlPTZ
        case .light: .camerasControlLight
        case .siren: .camerasControlSiren
        case .privacy: .camerasControlPrivacy
        case .recording: .camerasControlRecording
        case .motion, .sensitivity: .camerasControlDetection
        case .restart: .camerasRestart
        }
    }
}

struct CameraControlResult: Decodable, Sendable {
    let applied: Bool
    let message: String?
    let replayed: Bool?
}

/// Each dashboard section can fail independently.
struct DashboardSection<T: Decodable & Sendable>: Decodable, Sendable {
    struct SectionError: Decodable, Sendable {
        let code: String
        let message: String
        let recoverable: Bool
    }
    let available: Bool
    let data: T?
    let error: SectionError?

    var apiError: APIError? {
        guard let error, let code = APIErrorCode(rawValue: error.code) else { return nil }
        return .server(
            code: code, message: error.message, recoverable: error.recoverable, requestId: nil)
    }
}

struct CameraCounts: Decodable, Sendable, Equatable {
    let total: Int
    let online: Int
    let offline: Int
    let degraded: Int
    let recording: Int
    let streaming: Int
}

struct RecentEvents: Decodable, Sendable {
    let items: [CameraEvent]
    let unacknowledged: Int
}

struct ServiceCounts: Decodable, Sendable, Equatable {
    let total: Int
    let healthy: Int
    let degraded: Int
    let failing: Int
    let unknown: Int
}

struct DashboardSnapshot: Decodable, Sendable {
    struct AdGuardSections: Decodable, Sendable {
        let status: DashboardSection<AdGuardStatus>
        let stats: DashboardSection<AdGuardStats>
    }
    let cameras: DashboardSection<CameraCounts>
    let events: DashboardSection<RecentEvents>
    let adguard: AdGuardSections
    let storage: DashboardSection<StorageStatus>
    let services: DashboardSection<ServiceCounts>
    let generatedAt: Date
}

struct SystemHealthSnapshot: Decodable, Sendable {
    struct Gateway: Decodable, Sendable {
        let version: String
        let uptimeSeconds: Int
        let environment: String
    }
    let overall: ServiceStatus
    let services: [ServiceHealth]
    let gateway: Gateway
    let checkedAt: Date
}

struct PushRegistrationResult: Decodable, Sendable {
    let registered: Bool
    let pushConfigured: Bool
    let note: String?
}

struct NotificationQuietHours: Codable, Sendable, Equatable {
    var enabled: Bool
    var startMinute: Int
    var endMinute: Int
}

struct NotificationPreferences: Codable, Sendable, Equatable {
    var enabled: Bool
    var kinds: [String: Bool]
    var cameras: [String: Bool]
    var minimumSeverity: EventSeverity
    var quietHours: NotificationQuietHours
    var criticalBypassesQuietHours: Bool

    static let `default` = NotificationPreferences(
        enabled: true,
        kinds: [:],
        cameras: [:],
        minimumSeverity: .info,
        quietHours: .init(enabled: false, startMinute: 22 * 60, endMinute: 7 * 60),
        criticalBypassesQuietHours: true
    )
}

struct NotificationPreferencesResponse: Decodable, Sendable {
    let preferences: NotificationPreferences
    let availableKinds: [String]
    let pushConfigured: Bool
}

// MARK: - Live implementation

/// The real service. Every method is a thin, typed wrapper over `APIClient`.
struct OrionisService: OrionisServicing {
    let api: APIClient

    // MARK: Meta

    func meta() async throws -> GatewayMeta {
        try await api.requestPublic(
            Endpoint(path: "/meta", timeout: 10, isRetryable: true), as: GatewayMeta.self)
    }

    // MARK: Cameras

    private struct ListResponse<T: Decodable & Sendable>: Decodable, Sendable {
        let items: [T]
        let total: Int?
    }

    func cameras() async throws -> [Camera] {
        try await api.request(
            Endpoint(path: "/cameras", isRetryable: true), as: ListResponse<Camera>.self
        ).items
    }

    func camera(id: String) async throws -> Camera {
        try await api.request(
            Endpoint(path: "/cameras/\(escaped(id))", isRetryable: true), as: Camera.self)
    }

    func snapshot(cameraId: String) async throws -> Data {
        try await api.requestData(
            Endpoint(path: "/cameras/\(escaped(cameraId))/snapshot", timeout: 15))
    }

    func createStreamSession(
        cameraId: String,
        quality: StreamQuality,
        lowData: Bool,
        preferredProtocols: [StreamProtocolKind]
    ) async throws -> StreamSession {
        struct Body: Encodable {
            let preferredProtocols: [String]
            let quality: String
            let lowData: Bool
        }
        return try await api.request(
            Endpoint(
                method: .post,
                path: "/cameras/\(escaped(cameraId))/stream-sessions",
                body: Body(
                    preferredProtocols: preferredProtocols.map(\.rawValue),
                    quality: quality.rawValue,
                    lowData: lowData
                ),
                timeout: 15
            ),
            as: StreamSession.self
        )
    }

    func endStreamSession(cameraId: String, streamId: String) async throws {
        try await api.requestVoid(
            Endpoint(
                method: .delete,
                path: "/cameras/\(escaped(cameraId))/stream-sessions/\(escaped(streamId))"))
    }

    func invokeControl(cameraId: String, request: CameraControlRequest) async throws
        -> CameraControlResult
    {
        try await api.request(
            Endpoint(
                method: .post,
                path: "/cameras/\(escaped(cameraId))/controls",
                body: request,
                // A control must never be applied twice by a retry.
                idempotencyKey: UUID().uuidString,
                confirmDisruptive: request.isDisruptive
            ),
            as: CameraControlResult.self
        )
    }

    // MARK: Events

    func events(filter: EventFilter) async throws -> Paged<CameraEvent> {
        try await api.request(
            Endpoint(
                path: "/events",
                query: [
                    "cameraIds": filter.cameraIds.isEmpty
                        ? nil : filter.cameraIds.joined(separator: ","),
                    "types": filter.types.isEmpty
                        ? nil : filter.types.map(\.rawValue).joined(separator: ","),
                    "severities": filter.severities.isEmpty
                        ? nil : filter.severities.map(\.rawValue).joined(separator: ","),
                    "from": filter.from.map { ISO8601DateFormatter.orionisPlain.string(from: $0) },
                    "to": filter.to.map { ISO8601DateFormatter.orionisPlain.string(from: $0) },
                    "acknowledged": filter.acknowledged.map(String.init),
                    "limit": String(filter.limit),
                    "offset": String(filter.offset),
                ],
                isRetryable: true
            ),
            as: Paged<CameraEvent>.self
        )
    }

    func event(id: String) async throws -> CameraEvent {
        try await api.request(
            Endpoint(path: "/events/\(escaped(id))", isRetryable: true), as: CameraEvent.self)
    }

    func acknowledge(eventId: String, note: String?) async throws -> CameraEvent {
        struct Body: Encodable { let note: String? }
        return try await api.request(
            Endpoint(
                method: .post,
                path: "/events/\(escaped(eventId))/acknowledge",
                body: Body(note: note),
                idempotencyKey: "ack-\(eventId)"
            ),
            as: CameraEvent.self
        )
    }

    func recordings(cameraIds: [String], from: Date?, to: Date?, limit: Int, offset: Int)
        async throws -> Paged<Recording>
    {
        try await api.request(
            Endpoint(
                path: "/recordings",
                query: [
                    "cameraIds": cameraIds.isEmpty ? nil : cameraIds.joined(separator: ","),
                    "from": from.map { ISO8601DateFormatter.orionisPlain.string(from: $0) },
                    "to": to.map { ISO8601DateFormatter.orionisPlain.string(from: $0) },
                    "limit": String(limit),
                    "offset": String(offset),
                ],
                isRetryable: true
            ),
            as: Paged<Recording>.self
        )
    }

    func coverage(cameraId: String, day: Date) async throws -> RecordingCoverage {
        try await api.request(
            Endpoint(
                path: "/recordings/coverage",
                query: [
                    "cameraId": cameraId,
                    "day": ISO8601DateFormatter.orionisPlain.string(from: day),
                ],
                isRetryable: true
            ),
            as: RecordingCoverage.self
        )
    }

    /// Downloads a clip and returns a temporary file.
    ///
    /// Written to disk rather than held in memory because a share sheet needs a
    /// file URL, and a ten-minute clip is tens of megabytes. The name comes from
    /// the gateway's own Content-Disposition where possible, so a saved clip is
    /// recognisable months later.
    func exportClip(cameraId: String, start: Date, duration: Int) async throws -> URL {
        let (data, suggestedName) = try await api.requestDownload(
            Endpoint(
                path: "/recordings/clip",
                query: [
                    "cameraId": cameraId,
                    "start": ISO8601DateFormatter.orionisPlain.string(from: start),
                    "duration": String(duration),
                    "download": "true",
                ],
                timeout: 120
            )
        )
        let stamp = ISO8601DateFormatter.orionisPlain.string(from: start)
            .replacingOccurrences(of: ":", with: "-")
        let name = suggestedName ?? "clip-\(cameraId)-\(stamp).mp4"
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        try data.write(to: url, options: .atomic)
        return url
    }

    func recordingStorage() async throws -> StorageStatus {
        try await api.request(
            Endpoint(path: "/recordings/storage", isRetryable: true), as: StorageStatus.self)
    }

    func retention() async throws -> RetentionSettings {
        try await api.request(
            Endpoint(path: "/recordings/retention", isRetryable: true),
            as: RetentionSettings.self)
    }

    /// Shortening retention deletes footage sooner, so this is treated as
    /// disruptive: the gateway requires an explicit confirmation header.
    func setRetention(days: Int) async throws -> RetentionSettings {
        try await api.request(
            Endpoint(
                method: .put,
                path: "/recordings/retention",
                body: RetentionChangeRequest(days: days),
                idempotencyKey: UUID().uuidString,
                confirmDisruptive: true
            ),
            as: RetentionSettings.self
        )
    }

    // MARK: AdGuard

    func adGuardStatus() async throws -> AdGuardStatus {
        try await api.request(
            Endpoint(path: "/adguard/status", isRetryable: true), as: AdGuardStatus.self)
    }

    func adGuardStats(range: AdGuardRange) async throws -> AdGuardStats {
        try await api.request(
            Endpoint(path: "/adguard/stats", query: ["range": range.rawValue], isRetryable: true),
            as: AdGuardStats.self
        )
    }

    func queryLog(search: String?, status: QueryLogFilter, client: String?, limit: Int)
        async throws -> Paged<DnsQuery>
    {
        try await api.request(
            Endpoint(
                path: "/adguard/query-log",
                query: [
                    "search": search?.isEmpty == true ? nil : search,
                    "status": status.rawValue,
                    "client": client,
                    "limit": String(limit),
                ],
                isRetryable: true
            ),
            as: Paged<DnsQuery>.self
        )
    }

    func adGuardClients() async throws -> [DnsClient] {
        try await api.request(
            Endpoint(path: "/adguard/clients", isRetryable: true), as: ListResponse<DnsClient>.self
        ).items
    }

    func adGuardFilters() async throws -> [FilterList] {
        try await api.request(
            Endpoint(path: "/adguard/filters", isRetryable: true), as: ListResponse<FilterList>.self
        ).items
    }

    func customRules() async throws -> [String] {
        struct Response: Decodable, Sendable { let rules: [String] }
        return try await api.request(
            Endpoint(path: "/adguard/rules", isRetryable: true), as: Response.self
        ).rules
    }

    func addRule(_ rule: String, kind: RuleKind) async throws -> AddRuleResult {
        struct Body: Encodable {
            let rule: String
            let kind: String
        }
        return try await api.request(
            Endpoint(
                method: .post,
                path: "/adguard/rules",
                body: Body(rule: rule, kind: kind.rawValue),
                idempotencyKey: UUID().uuidString
            ),
            as: AddRuleResult.self
        )
    }

    func removeRule(_ rule: String) async throws {
        struct Body: Encodable { let rule: String }
        try await api.requestVoid(
            Endpoint(method: .delete, path: "/adguard/rules", body: Body(rule: rule)))
    }

    func setProtection(_ change: ProtectionChangeRequest) async throws -> AdGuardStatus {
        try await api.request(
            Endpoint(
                method: .post,
                path: "/adguard/protection",
                body: change,
                idempotencyKey: UUID().uuidString,
                confirmDisruptive: true
            ),
            as: AdGuardStatus.self
        )
    }

    // MARK: Camera preferences

    func cameraPreferences() async throws -> CameraPreferences {
        try await api.request(
            Endpoint(path: "/cameras/preferences", isRetryable: true), as: CameraPreferences.self)
    }

    func setCameraPreferences(_ update: CameraPreferencesUpdate) async throws -> CameraPreferences {
        try await api.request(
            Endpoint(method: .put, path: "/cameras/preferences", body: update),
            as: CameraPreferences.self)
    }

    // MARK: Infrastructure

    func infraStatus() async throws -> InfraStatus {
        try await api.request(Endpoint(path: "/infra/status", isRetryable: true), as: InfraStatus.self)
    }

    func autheliaUsers() async throws -> [AutheliaUserSummary] {
        struct Response: Decodable { let items: [AutheliaUserSummary] }
        return try await api.request(
            Endpoint(path: "/infra/authelia/users", isRetryable: true), as: Response.self
        ).items
    }

    func autheliaBackups() async throws -> [AutheliaBackupSummary] {
        struct Response: Decodable { let items: [AutheliaBackupSummary] }
        return try await api.request(
            Endpoint(path: "/infra/authelia/backups", isRetryable: true), as: Response.self
        ).items
    }

    func restoreAutheliaBackup(name: String) async throws {
        struct Body: Encodable { let name: String }
        try await api.requestVoid(
            Endpoint(
                method: .post,
                path: "/infra/authelia/backups/restore",
                body: Body(name: name),
                idempotencyKey: UUID().uuidString,
                confirmDisruptive: true
            ))
    }

    func setAutheliaPassword(username: String, password: String) async throws {
        struct Body: Encodable { let password: String }
        try await api.requestVoid(
            Endpoint(
                method: .put,
                path: "/infra/authelia/users/\(escaped(username))/password",
                body: Body(password: password),
                confirmDisruptive: true
            ))
    }

    func requestAutheliaRestart() async throws -> AutheliaRestartState {
        try await api.request(
            Endpoint(
                method: .post,
                path: "/infra/authelia/restart",
                idempotencyKey: UUID().uuidString,
                confirmDisruptive: true
            ),
            as: AutheliaRestartState.self)
    }

    func caddyConfig() async throws -> String {
        struct Response: Decodable { let raw: String }
        return try await api.request(
            Endpoint(path: "/infra/caddy/config", timeout: 30), as: Response.self).raw
    }

    func autheliaConfig() async throws -> String {
        struct Response: Decodable { let content: String }
        return try await api.request(
            Endpoint(path: "/infra/authelia/config", timeout: 30), as: Response.self).content
    }

    // MARK: System

    func dashboard() async throws -> DashboardSnapshot {
        try await api.request(
            Endpoint(path: "/dashboard", timeout: 25, isRetryable: true),
            as: DashboardSnapshot.self)
    }

    func services() async throws -> SystemHealthSnapshot {
        try await api.request(
            Endpoint(path: "/system/services", timeout: 25, isRetryable: true),
            as: SystemHealthSnapshot.self)
    }

    func availableActions() async throws -> [SystemAction] {
        try await api.request(
            Endpoint(path: "/system/actions", isRetryable: true), as: ListResponse<SystemAction>.self
        ).items
    }

    func runAction(_ actionId: String, serviceId: String?, reason: String?) async throws
        -> SystemActionResult
    {
        struct Body: Encodable {
            let actionId: String
            let serviceId: String?
            let reason: String?
        }
        let disruptive = ["cameras.reconnect", "orionis.service.restart"].contains(actionId)
        return try await api.request(
            Endpoint(
                method: .post,
                path: "/system/actions",
                body: Body(actionId: actionId, serviceId: serviceId, reason: reason),
                idempotencyKey: UUID().uuidString,
                confirmDisruptive: disruptive,
                timeout: 45
            ),
            as: SystemActionResult.self
        )
    }

    func auditLog(limit: Int, offset: Int) async throws -> Paged<AuditRecord> {
        try await api.request(
            Endpoint(
                path: "/audit",
                query: ["limit": String(limit), "offset": String(offset)],
                isRetryable: true
            ),
            as: Paged<AuditRecord>.self
        )
    }

    // MARK: Devices

    func devices() async throws -> [SessionSummary] {
        try await api.request(
            Endpoint(path: "/devices", isRetryable: true), as: ListResponse<SessionSummary>.self
        ).items
    }

    func removeDevice(sessionId: String) async throws {
        try await api.requestVoid(
            Endpoint(method: .delete, path: "/devices/\(escaped(sessionId))"))
    }

    func registerPushToken(_ token: String, sandbox: Bool) async throws -> PushRegistrationResult {
        struct Body: Encodable {
            let token: String
            let environment: String
        }
        return try await api.request(
            Endpoint(
                method: .post,
                path: "/devices/push",
                body: Body(token: token, environment: sandbox ? "sandbox" : "production")
            ),
            as: PushRegistrationResult.self
        )
    }

    func notificationPreferences() async throws -> NotificationPreferencesResponse {
        try await api.request(
            Endpoint(path: "/notifications/preferences", isRetryable: true),
            as: NotificationPreferencesResponse.self)
    }

    func updateNotificationPreferences(_ prefs: NotificationPreferences) async throws {
        try await api.requestVoid(
            Endpoint(method: .put, path: "/notifications/preferences", body: prefs))
    }

    private func escaped(_ component: String) -> String {
        component.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? component
    }
}
