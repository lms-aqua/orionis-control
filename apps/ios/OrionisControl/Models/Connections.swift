import Foundation

/// Camera sources configured from the app rather than from the server's
/// environment.
///
/// The shapes here mirror the gateway's connections API exactly, with one rule
/// carried across: a stored credential is never sent to the app. `secretsSet`
/// reports which credentials exist and nothing else, so the editor can show
/// "Saved — leave blank to keep" instead of a value it does not have.

// MARK: - Provider descriptions

/// One field an operator fills in when adding a connection.
///
/// The app renders its form from these rather than shipping a hard-coded screen
/// per provider, so a provider added on the server appears here with no app
/// release.
struct ProviderField: Codable, Sendable, Equatable, Identifiable {
    enum Kind: String, Codable, Sendable {
        case text, url, secret, number, boolean
    }

    let key: String
    let label: String
    let type: Kind
    let required: Bool
    let placeholder: String?
    let help: String?
    /// Correct by default; collapsed behind a disclosure rather than shown.
    let advanced: Bool

    var id: String { key }

    /// `default` is a Swift keyword, and the value may be any JSON scalar.
    let defaultValue: SettingValue?

    private enum CodingKeys: String, CodingKey {
        case key, label, type, required, placeholder, help, advanced
        case defaultValue = "default"
    }

    /// Unknown field types are dropped rather than failing the whole provider:
    /// the gateway is deployed independently and may describe a kind this build
    /// has never heard of.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        key = try container.decode(String.self, forKey: .key)
        label = try container.decode(String.self, forKey: .label)
        type = (try? container.decode(Kind.self, forKey: .type)) ?? .text
        required = try container.decodeIfPresent(Bool.self, forKey: .required) ?? false
        placeholder = try container.decodeIfPresent(String.self, forKey: .placeholder)
        help = try container.decodeIfPresent(String.self, forKey: .help)
        advanced = try container.decodeIfPresent(Bool.self, forKey: .advanced) ?? false
        defaultValue = try container.decodeIfPresent(SettingValue.self, forKey: .defaultValue)
    }
}

/// A helper service a provider needs somebody to be running.
///
/// Blink needs a lostblink bridge; Wyze needs docker-wyze-bridge. When the
/// gateway has an applier behind it, the app offers to start one instead of
/// asking for an address that does not exist yet.
struct ProviderBridge: Codable, Sendable, Equatable {
    let template: String
    let summary: String
    /// Settings the bridge fills in. Hidden in the editor when it will.
    let provides: [String]
    /// Whether the provider works without this bridge at all.
    ///
    /// Defaults to false, which is the Blink and Wyze case: no bridge, no
    /// protocol, so the address it will supply is not worth asking for. A
    /// convenience bridge — go2rtc — keeps its fields, because the one Orionis
    /// starts publishes nothing until someone points it at cameras.
    let optional: Bool

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        template = try container.decode(String.self, forKey: .template)
        summary = try container.decodeIfPresent(String.self, forKey: .summary) ?? ""
        provides = try container.decodeIfPresent([String].self, forKey: .provides) ?? []
        // Absent means mandatory: a gateway older than this field only ever
        // described bridges the provider could not work without.
        optional = try container.decodeIfPresent(Bool.self, forKey: .optional) ?? false
    }

    private enum CodingKeys: String, CodingKey { case template, summary, provides, optional }
}

struct ProviderCapabilities: Codable, Sendable, Equatable {
    let snapshots: Bool
    let liveStream: Bool
    let events: Bool
    let eventDetection: Bool
    let recordings: Bool
    let controls: Bool
    let storageReporting: Bool
    let interactiveAuth: Bool

    /// What this source can actually do, in the order worth reading.
    var summaryLine: String {
        var parts: [String] = []
        if liveStream { parts.append("Live view") }
        if snapshots { parts.append("Snapshots") }
        if events { parts.append("Events") }
        if recordings { parts.append("Recordings") }
        return parts.isEmpty ? "No capabilities declared" : parts.joined(separator: " · ")
    }
}

struct ProviderDescriptor: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let displayName: String
    let summary: String
    let capabilities: ProviderCapabilities
    let fields: [ProviderField]
    /// Present only when this provider needs a helper service to work at all.
    let bridge: ProviderBridge?

    /// Fields worth showing before anything is collapsed.
    ///
    /// A field the bridge will fill in is not merely advanced, it is *wrong* to
    /// ask for — the container it addresses does not exist yet. So when a bridge
    /// is going to be provisioned those keys are dropped entirely rather than
    /// tucked away where someone can still type into them.
    ///
    /// Unless the bridge is a convenience. Dropping them there was a dead end:
    /// the go2rtc Orionis starts publishes no streams until someone points it at
    /// cameras, so hiding the address field left the source reporting healthy
    /// over an empty camera wall with nothing left to type into.
    func visibleFields(provisioning: Bool) -> [ProviderField] {
        guard provisioning, let bridge, !bridge.optional else { return fields }
        return fields.filter { !bridge.provides.contains($0.key) }
    }

    /// SF Symbol per known provider; anything unrecognised still gets an icon.
    var symbolName: String {
        switch id {
        case "frigate": return "square.grid.2x2.fill"
        case "rtsp": return "dot.radiowaves.left.and.right"
        case "lostblink": return "bolt.fill"
        case "unifi": return "shield.lefthalf.filled"
        case "tapo": return "camera.fill"
        case "wyze": return "antenna.radiowaves.left.and.right"
        case "nest": return "house.fill"
        default: return "camera.metering.center.weighted"
        }
    }
}

// MARK: - Stored connections

struct ConnectionHealth: Codable, Sendable, Equatable {
    enum Status: String, Codable, Sendable {
        case healthy, degraded, unreachable, unknown
    }

    let status: Status
    let message: String?
    let cameraCount: Int?
    let latencyMs: Int?
    let checkedAt: Date?

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        status = (try? container.decode(Status.self, forKey: .status)) ?? .unknown
        message = try container.decodeIfPresent(String.self, forKey: .message)
        cameraCount = try container.decodeIfPresent(Int.self, forKey: .cameraCount)
        latencyMs = try container.decodeIfPresent(Int.self, forKey: .latencyMs)
        checkedAt = try container.decodeIfPresent(Date.self, forKey: .checkedAt)
    }
}

/// The state of a bridge the gateway asked the host to run.
///
/// Distinct from health on purpose: health says whether an upstream answered,
/// this says whether the thing that answers it exists yet. A source that is
/// still being set up is not broken, and showing it as unreachable for the
/// ninety seconds an image takes to pull would be a lie with a red dot on it.
struct ConnectionProvisioning: Codable, Sendable, Equatable {
    enum State: String, Codable, Sendable {
        case pending, provisioning, ready, failed, removing, removed
    }

    let requestId: String
    let template: String
    let instance: String
    let state: State
    let message: String?
    let requestedAt: Date?
    let updatedAt: Date?

    /// Whether the app should keep polling. Settled states never change alone.
    var isInFlight: Bool {
        switch state {
        case .pending, .provisioning, .removing: return true
        case .ready, .failed, .removed: return false
        }
    }

    var title: String {
        switch state {
        case .pending: return "Waiting for the server"
        case .provisioning: return "Setting up…"
        case .ready: return "Bridge running"
        case .failed: return "Setup failed"
        case .removing: return "Stopping the bridge…"
        case .removed: return "Bridge stopped"
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        requestId = try container.decodeIfPresent(String.self, forKey: .requestId) ?? ""
        template = try container.decodeIfPresent(String.self, forKey: .template) ?? ""
        instance = try container.decodeIfPresent(String.self, forKey: .instance) ?? ""
        // An unknown state from a newer gateway reads as "still working" rather
        // than failing the screen: it will settle into something known.
        state = (try? container.decode(State.self, forKey: .state)) ?? .provisioning
        message = try container.decodeIfPresent(String.self, forKey: .message)
        requestedAt = try container.decodeIfPresent(Date.self, forKey: .requestedAt)
        updatedAt = try container.decodeIfPresent(Date.self, forKey: .updatedAt)
    }
}

struct ConnectionSummary: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let provider: String
    let name: String
    /// The prefix on every camera ID this source contributes. Fixed at creation.
    let slug: String
    let enabled: Bool
    let settings: [String: SettingValue]
    /// Which credentials are stored. Never the values — the API does not send them.
    let secretsSet: [String: Bool]
    let sortOrder: Int
    let createdAt: Date?
    let updatedAt: Date?
    let health: ConnectionHealth?
    /// Present only when Orionis was asked to run a bridge for this source.
    let provisioning: ConnectionProvisioning?

    func hasSecret(_ key: String) -> Bool { secretsSet[key] == true }
}

/// What can be added, and whether this gateway can start bridges at all.
struct ProviderCatalogue: Sendable, Equatable {
    let providers: [ProviderDescriptor]
    /// False when no applier is configured. The app then never offers to set a
    /// bridge up, because the button could only ever fail.
    let provisioningAvailable: Bool
}

// MARK: - Interactive sign-in

struct AuthChallenge: Codable, Sendable, Equatable {
    enum Kind: String, Codable, Sendable {
        case emailedCode = "emailed_code"
        case smsCode = "sms_code"
        case totp
    }

    let challengeId: String
    let kind: Kind
    let prompt: String
    /// Redacted destination, e.g. "p•••@example.com". Never the full address.
    let sentTo: String?
    let expiresAt: Date?

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        challengeId = try container.decode(String.self, forKey: .challengeId)
        kind = (try? container.decode(Kind.self, forKey: .kind)) ?? .emailedCode
        prompt = try container.decode(String.self, forKey: .prompt)
        sentTo = try container.decodeIfPresent(String.self, forKey: .sentTo)
        expiresAt = try container.decodeIfPresent(Date.self, forKey: .expiresAt)
    }
}

/// The result of one step of an interactive sign-in.
enum ConnectionAuthResult: Decodable, Sendable, Equatable {
    case complete(message: String)
    case challenge(AuthChallenge)
    case failed(message: String)

    private enum CodingKeys: String, CodingKey { case status, message, challenge }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let status = try container.decode(String.self, forKey: .status)
        switch status {
        case "complete":
            self = .complete(
                message: try container.decodeIfPresent(String.self, forKey: .message) ?? "Signed in.")
        case "challenge":
            self = .challenge(try container.decode(AuthChallenge.self, forKey: .challenge))
        default:
            self = .failed(
                message: try container.decodeIfPresent(String.self, forKey: .message)
                    ?? "The sign-in did not complete.")
        }
    }
}

// MARK: - Loosely typed setting values

/// One provider setting.
///
/// Providers declare their own fields, so the values are whatever JSON scalars
/// those fields need. This keeps them typed at the edges without the app having
/// to know any provider's schema.
enum SettingValue: Codable, Sendable, Equatable {
    case string(String)
    case number(Double)
    case boolean(Bool)

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(Bool.self) {
            self = .boolean(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else {
            // An object or array from a provider this build does not model.
            // Rendering it as text is honest; failing the whole screen is not.
            self = .string("")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .boolean(let value): try container.encode(value)
        }
    }

    var stringValue: String {
        switch self {
        case .string(let value): return value
        case .number(let value):
            return value == value.rounded() ? String(Int(value)) : String(value)
        case .boolean(let value): return value ? "true" : "false"
        }
    }

    var boolValue: Bool {
        switch self {
        case .boolean(let value): return value
        case .string(let value): return value == "true"
        case .number(let value): return value != 0
        }
    }
}

// MARK: - Requests

struct ConnectionCreateRequest: Encodable, Sendable {
    let provider: String
    let name: String
    let settings: [String: SettingValue]
    let secrets: [String: String]
    let enabled: Bool
}

struct ConnectionUpdateRequest: Encodable, Sendable {
    var name: String?
    var settings: [String: SettingValue]?
    /// Only the keys present are changed; an empty string clears one.
    var secrets: [String: String]?
    var enabled: Bool?
    var sortOrder: Int?
}
