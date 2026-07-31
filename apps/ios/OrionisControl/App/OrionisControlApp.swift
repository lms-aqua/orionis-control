import SwiftUI
import UserNotifications

@main
struct OrionisControlApp: App {
    @State private var environment = AppEnvironment()
    @State private var router = DeepLinkRouter()
    @Environment(\.scenePhase) private var scenePhase

    /// Backgrounded-at timestamp, used for auto-lock.
    @State private var backgroundedAt: Date?

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(environment)
                .environment(router)
                .preferredColorScheme(environment.preferences.appearance.colorScheme)
                .onOpenURL { url in
                    router.handle(url)
                }
                .task {
                    await environment.auth.restore(
                        hasConfiguredServer: environment.hasConfiguredServer)
                    if environment.hasConfiguredServer {
                        await environment.refreshMeta()
                    }
                }
        }
        .onChange(of: scenePhase) { _, phase in
            handleScenePhase(phase)
        }
    }

    private func handleScenePhase(_ phase: ScenePhase) {
        switch phase {
        case .background:
            backgroundedAt = Date()
        case .active:
            applyAutoLockIfNeeded()
            backgroundedAt = nil
        case .inactive:
            break
        @unknown default:
            break
        }
    }

    /// Re-locks after the configured idle period. Zero means "every time".
    private func applyAutoLockIfNeeded() {
        guard environment.preferences.requireBiometricUnlock,
            environment.auth.state.isSignedIn
        else { return }

        let minutes = environment.preferences.autoLockMinutes
        guard let backgroundedAt else { return }

        let elapsed = Date().timeIntervalSince(backgroundedAt)
        if minutes == 0 || elapsed >= Double(minutes) * 60 {
            environment.auth.lock()
            environment.biometrics.lock()
        }
    }
}

// MARK: - Deep links

/// Routes notification taps and custom-scheme URLs to a destination.
///
/// Only paths the app understands are honoured; anything else is ignored
/// rather than guessed at.
@MainActor
@Observable
final class DeepLinkRouter {
    enum Destination: Equatable {
        case camera(String)
        case event(String)
        case adGuard
        case system
        case settings
    }

    var selectedTab: RootTab = .home
    var pendingDestination: Destination?

    @discardableResult
    func handle(_ url: URL) -> Destination? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            components.scheme?.lowercased() == "orioniscontrol"
        else { return nil }

        // The auth callback is consumed by ASWebAuthenticationSession, not here.
        guard components.host != "auth" else { return nil }

        let destination = Self.destination(host: components.host, path: components.path)
        guard let destination else { return nil }

        apply(destination)
        return destination
    }

    /// Pure mapping, unit-tested directly.
    static func destination(host: String?, path: String) -> Destination? {
        let segments = path.split(separator: "/").map(String.init)
        switch host {
        case "camera":
            guard let id = segments.first, !id.isEmpty else { return nil }
            return .camera(id)
        case "event":
            guard let id = segments.first, !id.isEmpty else { return nil }
            return .event(id)
        case "adguard":
            return .adGuard
        case "system":
            return .system
        case "settings":
            return .settings
        default:
            return nil
        }
    }

    func apply(_ destination: Destination) {
        switch destination {
        case .camera: selectedTab = .cameras
        case .event: selectedTab = .events
        case .adGuard: selectedTab = .adGuard
        case .system: selectedTab = .system
        case .settings: selectedTab = .settings
        }
        pendingDestination = destination
    }

    func consume() -> Destination? {
        defer { pendingDestination = nil }
        return pendingDestination
    }
}

enum RootTab: String, Hashable, CaseIterable, Identifiable {
    case home, cameras, events, adGuard, system, settings
    var id: String { rawValue }

    var title: String {
        switch self {
        case .home: "Home"
        case .cameras: "Cameras"
        case .events: "Events"
        case .adGuard: "Network"
        case .system: "System"
        case .settings: "Settings"
        }
    }

    var symbolName: String {
        switch self {
        case .home: "house.fill"
        case .cameras: "video.fill"
        case .events: "bell.fill"
        case .adGuard: "shield.lefthalf.filled"
        case .system: "server.rack"
        case .settings: "gearshape.fill"
        }
    }
}
