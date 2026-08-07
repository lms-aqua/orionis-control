import SwiftUI

/// Chooses between setup, sign-in, the lock screen and the app itself.
struct RootView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(DeepLinkRouter.self) private var router
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            switch environment.auth.state {
            case .initialising:
                LoadingStateView(message: "Restoring your session…")
            case .needsServer:
                ServerSetupView()
            case .signedOut(let reason):
                SignInView(reason: reason)
            case .authenticating:
                SignInView(reason: nil, isAuthenticating: true)
            case .locked(let user):
                LockScreenView(user: user)
            case .signedIn(let user):
                MainTabView(user: user)
            }
        }
        .animation(.smooth(duration: 0.25), value: environment.auth.state)
        // Privacy shield: the app switcher must never show a camera frame.
        .overlay {
            if environment.preferences.hidePreviewsInAppSwitcher, scenePhase != .active,
                environment.auth.state.isSignedIn
            {
                PrivacyShieldView()
                    .transition(.opacity)
            }
        }
    }
}

/// Covers the interface while the app is not frontmost.
struct PrivacyShieldView: View {
    var body: some View {
        ZStack {
            AppBackground()
            VStack(spacing: 12) {
                Image(systemName: "lock.shield.fill")
                    .font(.system(size: 44))
                    .foregroundStyle(Theme.accent)
                Text("Orionis Control")
                    .font(.headline)
                    .foregroundStyle(Theme.textPrimary)
            }
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
}

// MARK: - Main navigation

struct MainTabView: View {
    let user: CurrentUser
    @Environment(AppEnvironment.self) private var environment
    @Environment(DeepLinkRouter.self) private var router
    @Environment(\.horizontalSizeClass) private var sizeClass

    /// Permission-filtered primary tabs. Home and More are always present —
    /// More holds Settings, which every signed-in user can reach. The count can
    /// only ever shrink from five, so UIKit's automatic "More" never appears.
    private var visibleTabs: [RootTab] {
        RootTab.allCases.filter { tab in
            switch tab {
            case .adGuard: user.can(.adguardView)
            case .cameras: user.can(.camerasView)
            case .system: user.can(.systemView)
            case .home, .more: true
            }
        }
    }

    /// On regular width there is no tab-count ceiling, so Events and Settings
    /// are promoted out of the More hub into the sidebar as siblings.
    private var sidebarItems: [SidebarDestination] {
        var items = visibleTabs.filter { $0 != .more }.map(SidebarDestination.tab)
        if user.can(.eventsView) { items.append(.more(.events)) }
        items.append(.more(.settings))
        return items
    }

    var body: some View {
        @Bindable var router = router

        if sizeClass == .regular {
            // iPad and landscape iPhone Max: sidebar + detail.
            NavigationSplitView {
                // The `List(data, selection:)` form binds selection to the
                // element's ID; the explicit ForEach + .tag() form binds it to
                // the value itself, which is what the router needs.
                List(selection: sidebarSelection) {
                    ForEach(sidebarItems) { item in
                        Label(item.title, systemImage: item.symbolName)
                            .tag(item)
                    }
                }
                .navigationTitle("Orionis Control")
                .listStyle(.sidebar)
            } detail: {
                switch router.selectedTab {
                case .more:
                    // The sidebar selects a concrete More route directly, so the
                    // detail pane shows that screen rather than the hub itself.
                    moreDetail(for: router.morePath.first ?? .settings)
                default:
                    destination(for: router.selectedTab)
                }
            }
        } else {
            TabView(selection: $router.selectedTab) {
                ForEach(visibleTabs) { tab in
                    destination(for: tab)
                        .tabItem { Label(tab.title, systemImage: tab.symbolName) }
                        .tag(tab)
                }
            }
            .tint(Theme.accent)
            // The camera wall and the DNS feed are both long scrolls where the
            // tab bar is not what the user is looking at. Minimising it on the
            // way down returns that space to the content and brings it back the
            // moment they scroll up.
            .tabBarMinimizeBehavior(.onScrollDown)
        }
    }

    /// Bridges the sidebar's flat selection onto the router's tab + path state.
    private var sidebarSelection: Binding<SidebarDestination?> {
        Binding(
            get: {
                router.selectedTab == .more
                    ? .more(router.morePath.first ?? .settings)
                    : .tab(router.selectedTab)
            },
            set: { selection in
                switch selection {
                case .tab(let tab):
                    router.selectedTab = tab
                    router.morePath = []
                case .more(let route):
                    router.selectedTab = .more
                    router.morePath = [route]
                case nil:
                    router.selectedTab = .home
                    router.morePath = []
                }
            })
    }

    @ViewBuilder
    private func destination(for tab: RootTab) -> some View {
        switch tab {
        case .home: DashboardView()
        case .cameras: CamerasView()
        case .adGuard: AdGuardView()
        case .system: SystemView()
        case .more: MoreView(user: user)
        }
    }

    @ViewBuilder
    private func moreDetail(for route: MoreRoute) -> some View {
        switch route {
        case .events: EventsView()
        default: SettingsView()
        }
    }
}

/// A single selectable row in the regular-width sidebar: either a primary tab or
/// a destination promoted out of the More hub.
enum SidebarDestination: Hashable, Identifiable {
    case tab(RootTab)
    case more(MoreRoute)

    var id: String {
        switch self {
        case .tab(let tab): "tab.\(tab.rawValue)"
        case .more(let route): "more.\(route.rawValue)"
        }
    }

    var title: String {
        switch self {
        case .tab(let tab): tab.title
        case .more(let route): route == .events ? "Events" : route.title
        }
    }

    var symbolName: String {
        switch self {
        case .tab(let tab): tab.symbolName
        case .more(let route): route.symbolName
        }
    }
}

// MARK: - Lock screen

struct LockScreenView: View {
    let user: CurrentUser
    @Environment(AppEnvironment.self) private var environment
    @State private var message: String?
    @State private var isAuthenticating = false

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            Image(systemName: environment.biometrics.availability.symbolName)
                .font(.system(size: 56))
                .foregroundStyle(.tint)

            VStack(spacing: 6) {
                Text("Orionis Control is locked")
                    .font(.title2.weight(.semibold))
                Text("Signed in as \(user.name)")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            if let message {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 40)
            }

            Button {
                Task { await unlock() }
            } label: {
                if isAuthenticating {
                    ProgressView()
                } else {
                    Text("Unlock with \(environment.biometrics.availability.displayName)")
                }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(isAuthenticating)

            Spacer()

            Button("Sign out", role: .destructive) {
                Task { await environment.signOutAndForget() }
            }
            .padding(.bottom, 32)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background { AppBackground() }
        .tint(Theme.accent)
        .task { await unlock() }
    }

    private func unlock() async {
        guard !isAuthenticating else { return }
        isAuthenticating = true
        defer { isAuthenticating = false }

        let outcome = await environment.biometrics.authenticate(
            reason: "Unlock Orionis Control to view your cameras and network.")

        switch outcome {
        case .success:
            environment.auth.unlock()
        case .cancelled:
            message = nil
        case .failed(let detail):
            message = detail
        case .unavailable(let detail):
            // If the device can no longer authenticate, do not trap the user.
            message = "\(detail) Unlocking without biometrics."
            environment.auth.unlock()
        }
    }
}
