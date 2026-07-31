import Foundation

/// Build-time configuration, read from Info.plist (populated from xcconfig).
///
/// Nothing here is secret: everything in this struct ships inside the app
/// binary and must be treated as public. The OAuth client is a *public* client
/// using PKCE and has no client secret.
struct AppConfiguration: Sendable, Equatable {
    enum BuildEnvironment: String, Sendable, CaseIterable {
        case development
        case staging
        case production

        var isProduction: Bool { self == .production }
        var displayName: String {
            switch self {
            case .development: "Development"
            case .staging: "Staging"
            case .production: "Production"
            }
        }
    }

    /// The gateway the app talks to. Configurable at runtime during setup, but
    /// seeded from the build configuration.
    var apiBaseURL: URL?
    var oauthClientID: String
    var oauthRedirectScheme: String
    var environment: BuildEnvironment
    var displayName: String
    var version: String
    var build: String

    // MARK: - Loading

    static func load(from bundle: Bundle = .main) -> AppConfiguration {
        func string(_ key: String) -> String {
            (bundle.object(forInfoDictionaryKey: key) as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        }

        let raw = string("ORIONIS_API_BASE_URL")
        return AppConfiguration(
            apiBaseURL: raw.isEmpty ? nil : URL(string: raw),
            oauthClientID: string("ORIONIS_OAUTH_CLIENT_ID").isEmpty
                ? "orionis-control-mobile" : string("ORIONIS_OAUTH_CLIENT_ID"),
            oauthRedirectScheme: string("ORIONIS_OAUTH_REDIRECT_SCHEME").isEmpty
                ? "orioniscontrol" : string("ORIONIS_OAUTH_REDIRECT_SCHEME"),
            environment: BuildEnvironment(rawValue: string("ORIONIS_BUILD_ENVIRONMENT"))
                ?? .development,
            displayName: string("CFBundleDisplayName").isEmpty
                ? "Orionis Control" : string("CFBundleDisplayName"),
            version: string("CFBundleShortVersionString"),
            build: string("CFBundleVersion")
        )
    }

    var redirectURI: String { "\(oauthRedirectScheme)://auth/callback" }

    // MARK: - Validation

    enum ValidationIssue: Equatable, CustomStringConvertible {
        case missingBaseURL
        case insecureBaseURL(String)
        case fixtureURLInRelease(String)
        case missingClientID

        var description: String {
            switch self {
            case .missingBaseURL:
                "No gateway address is configured."
            case .insecureBaseURL(let host):
                "The gateway address (\(host)) is not HTTPS."
            case .fixtureURLInRelease(let host):
                "The gateway address (\(host)) is a development or fixture host, which release builds refuse."
            case .missingClientID:
                "No OAuth client identifier is configured."
            }
        }
    }

    /// Hosts that must never be reachable from a shipping build.
    private static let fixtureHostSuffixes = [".invalid", ".test", ".local", ".example"]
    private static let fixtureHosts = ["localhost", "127.0.0.1", "::1"]

    /// Returns everything wrong with this configuration for the given URL.
    /// A release build treats any issue as fatal for that connection.
    func validate(url: URL?, allowInsecure: Bool = false) -> [ValidationIssue] {
        var issues: [ValidationIssue] = []

        guard let url, let host = url.host() else {
            return [.missingBaseURL]
        }

        let isSecure = url.scheme?.lowercased() == "https"
        let isLoopback = Self.fixtureHosts.contains(host)

        // Plain HTTP is permitted only for loopback in a debug build, so a
        // developer can point at a gateway on their own machine.
        if !isSecure && !(allowInsecure && isLoopback && environment == .development) {
            issues.append(.insecureBaseURL(host))
        }

        if environment.isProduction {
            let looksLikeFixture =
                Self.fixtureHosts.contains(host)
                || Self.fixtureHostSuffixes.contains { host.hasSuffix($0) }
            if looksLikeFixture {
                issues.append(.fixtureURLInRelease(host))
            }
        }

        if oauthClientID.isEmpty {
            issues.append(.missingClientID)
        }

        return issues
    }

    /// True when this build is allowed to show fixture data anywhere.
    /// Compiled out entirely in release.
    var allowsFixtures: Bool {
        #if DEBUG
            return environment != .production
        #else
            return false
        #endif
    }
}
