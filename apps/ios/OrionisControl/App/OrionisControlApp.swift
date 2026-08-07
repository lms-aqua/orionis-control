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

    /// Navigation path for the More hub. Events and Settings are no longer
    /// top-level tabs, so a deep link to either selects `.more` and pushes the
    /// matching route onto this path.
    var morePath: [MoreRoute] = []

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
        case .camera:
            selectedTab = .cameras
            morePath = []
        case .event:
            // Events lives under the More hub; push it so the event detail has
            // a sensible back path rather than appearing as a rootless screen.
            selectedTab = .more
            morePath = [.events]
        case .adGuard:
            selectedTab = .adGuard
            morePath = []
        case .system:
            selectedTab = .system
            morePath = []
        case .settings:
            selectedTab = .more
            morePath = [.settings]
        }
        pendingDestination = destination
    }

    func consume() -> Destination? {
        defer { pendingDestination = nil }
        return pendingDestination
    }
}

/// The app's primary destinations.
///
/// Deliberately five, and never more: a compact-width `TabView` with six or more
/// tabs makes UIKit generate its own "More" list, which Orionis does not control
/// and does not want. Everything beyond the four operational surfaces lives in
/// `MoreView`, a real screen this app designs — see `MoreRoute`.
enum RootTab: String, Hashable, CaseIterable, Identifiable {
    case home, cameras, adGuard, system, more
    var id: String { rawValue }

    var title: String {
        switch self {
        case .home: "Home"
        case .cameras: "Cameras"
        case .adGuard: "Network"
        case .system: "System"
        case .more: "More"
        }
    }

    var symbolName: String {
        switch self {
        case .home: "house.fill"
        case .cameras: "video.fill"
        case .adGuard: "shield.lefthalf.filled"
        case .system: "server.rack"
        case .more: "square.grid.2x2.fill"
        }
    }
}

/// Destinations reachable from the More hub.
enum MoreRoute: String, Hashable, Identifiable {
    case events, settings, account, diagnostics, about, infrastructure
    var id: String { rawValue }

    var title: String {
        switch self {
        case .events: "Events & Activity"
        case .settings: "Settings"
        case .account: "Signed-in Devices"
        case .diagnostics: "Diagnostics"
        case .about: "About Orionis Control"
        case .infrastructure: "Infrastructure"
        }
    }

    var symbolName: String {
        switch self {
        case .events: "bell.badge.fill"
        case .settings: "gearshape.fill"
        case .account: "person.crop.circle.fill"
        case .diagnostics: "stethoscope"
        case .about: "info.circle.fill"
        case .infrastructure: "cube.transparent.fill"
        }
    }
}
