import Foundation
import SwiftUI

/// Non-sensitive, user-visible preferences. Secrets never live here.
@MainActor
@Observable
final class Preferences {
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    private func value<T>(_ key: String, default fallback: T) -> T {
        defaults.object(forKey: key) as? T ?? fallback
    }

    // Server
    var serverURLString: String {
        get { value("server.url", default: "") }
        set { defaults.set(newValue, forKey: "server.url") }
    }
    var hasCompletedSetup: Bool {
        get { value("setup.complete", default: false) }
        set { defaults.set(newValue, forKey: "setup.complete") }
    }

    // Security
    var requireBiometricUnlock: Bool {
        get { value("security.biometricUnlock", default: false) }
        set { defaults.set(newValue, forKey: "security.biometricUnlock") }
    }
    var requireBiometricForAdminActions: Bool {
        get { value("security.biometricAdmin", default: true) }
        set { defaults.set(newValue, forKey: "security.biometricAdmin") }
    }
    var autoLockMinutes: Int {
        get { value("security.autoLockMinutes", default: 5) }
        set { defaults.set(newValue, forKey: "security.autoLockMinutes") }
    }
    var hidePreviewsInAppSwitcher: Bool {
        get { value("security.privacyShield", default: true) }
        set { defaults.set(newValue, forKey: "security.privacyShield") }
    }

    // Cameras
    var defaultStreamQuality: StreamQuality {
        get { StreamQuality(rawValue: value("cameras.quality", default: "auto")) ?? .auto }
        set { defaults.set(newValue.rawValue, forKey: "cameras.quality") }
    }
    var limitQualityOnCellular: Bool {
        get { value("cameras.limitCellular", default: true) }
        set { defaults.set(newValue, forKey: "cameras.limitCellular") }
    }
    var autoplayLiveView: Bool {
        get { value("cameras.autoplay", default: true) }
        set { defaults.set(newValue, forKey: "cameras.autoplay") }
    }
    var startMuted: Bool {
        get { value("cameras.startMuted", default: true) }
        set { defaults.set(newValue, forKey: "cameras.startMuted") }
    }
    var gridColumns: Int {
        get { value("cameras.gridColumns", default: 2) }
        set { defaults.set(newValue, forKey: "cameras.gridColumns") }
    }
    var favouriteCameraIds: [String] {
        get { value("cameras.favourites", default: [String]()) }
        set { defaults.set(newValue, forKey: "cameras.favourites") }
    }

    // Appearance
    var appearance: AppearanceSetting {
        get { AppearanceSetting(rawValue: value("appearance.mode", default: "system")) ?? .system }
        set { defaults.set(newValue.rawValue, forKey: "appearance.mode") }
    }

    func toggleFavourite(_ cameraId: String) {
        var current = favouriteCameraIds
        if let index = current.firstIndex(of: cameraId) {
            current.remove(at: index)
        } else {
            current.append(cameraId)
        }
        favouriteCameraIds = current
    }

    func isFavourite(_ cameraId: String) -> Bool { favouriteCameraIds.contains(cameraId) }

    /// Called on sign-out. Preferences that could identify the environment go;
    /// harmless display preferences stay.
    func clearAccountScopedData() {
        defaults.removeObject(forKey: "cameras.favourites")
    }
}

enum AppearanceSetting: String, CaseIterable, Identifiable, Sendable {
    case system, light, dark
    var id: String { rawValue }
    var displayName: String {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }
    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

/// Everything the app needs, constructed once and injected.
@MainActor
@Observable
final class AppEnvironment {
    let configuration: AppConfiguration
    let preferences: Preferences
    let secrets: SecretStoring
    let api: APIClient
    let auth: AuthenticationService
    let biometrics: BiometricLock
    private(set) var service: any OrionisServicing

    /// Gateway metadata, loaded during setup and on each cold start.
    private(set) var meta: GatewayMeta?
    private(set) var metaError: APIError?

    init(
        configuration: AppConfiguration = .load(),
        preferences: Preferences = Preferences(),
        secrets: SecretStoring = KeychainStore(),
        biometrics: BiometricLock = BiometricLock()
    ) {
        self.configuration = configuration
        self.preferences = preferences
        self.secrets = secrets
        self.biometrics = biometrics

        // Runtime-configured address wins over the build-time default, so one
        // build can serve development, staging and production installs.
        let resolved =
            URL(string: preferences.serverURLString)
            ?? configuration.apiBaseURL
            ?? URL(string: "https://gateway.invalid")!

        let client = APIClient(baseURL: resolved)
        self.api = client
        let authentication = AuthenticationService(
            configuration: configuration, api: client, secrets: secrets)
        self.auth = authentication
        self.service = OrionisService(api: client)

        Task { await client.setTokenProvider(authentication) }
    }

    var hasConfiguredServer: Bool {
        preferences.hasCompletedSetup && !preferences.serverURLString.isEmpty
    }

    /// Validates and applies a gateway address. Returns the metadata on success.
    func connect(to urlString: String) async throws -> GatewayMeta {
        let trimmed = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        let candidate = trimmed.contains("://") ? trimmed : "https://\(trimmed)"

        guard let url = URL(string: candidate), url.host() != nil else {
            throw APIError.configuration(
                "That does not look like a web address. Enter the gateway's hostname, for example gateway.example.com."
            )
        }

        let issues = configuration.validate(url: url, allowInsecure: true)
        if let first = issues.first {
            throw APIError.configuration(first.description)
        }

        await api.setBaseURL(url)
        do {
            let meta = try await service.meta()
            guard meta.apiVersion.hasPrefix("1.") else {
                throw APIError.server(
                    code: .unsupportedAPIVersion,
                    message:
                        "This gateway speaks API version \(meta.apiVersion), which this version of Orionis Control does not support.",
                    recoverable: false,
                    requestId: nil)
            }
            if let build = Int(configuration.build), build < meta.minimumAppBuild {
                throw APIError.server(
                    code: .unsupportedAPIVersion,
                    message:
                        "This gateway requires Orionis Control build \(meta.minimumAppBuild) or newer. This is build \(build).",
                    recoverable: false,
                    requestId: nil)
            }
            self.meta = meta
            self.metaError = nil
            preferences.serverURLString = url.absoluteString
            return meta
        } catch {
            // Roll back so a failed test does not leave the app pointing at a
            // gateway that never answered.
            if let previous = URL(string: preferences.serverURLString) {
                await api.setBaseURL(previous)
            }
            throw error
        }
    }

    func refreshMeta() async {
        do {
            meta = try await service.meta()
            metaError = nil
        } catch let error as APIError {
            metaError = error
        } catch {
            metaError = .unexpectedStatus(0, requestId: nil)
        }
    }

    func completeSetup() {
        preferences.hasCompletedSetup = true
    }

    func signOutAndForget() async {
        await auth.signOut()
        preferences.clearAccountScopedData()
    }
}
