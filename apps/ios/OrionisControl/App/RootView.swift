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
            Rectangle()
                .fill(.background)
            VStack(spacing: 12) {
                Image(systemName: "lock.shield.fill")
                    .font(.system(size: 44))
                    .foregroundStyle(.tint)
                Text("Orionis Control")
                    .font(.headline)
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

    private var visibleTabs: [RootTab] {
        RootTab.allCases.filter { tab in
            switch tab {
            case .adGuard: user.can(.adguardView)
            case .events: user.can(.eventsView)
            case .cameras: user.can(.camerasView)
            case .system: user.can(.systemView)
            case .home, .settings: true
            }
        }
    }

    var body: some View {
        @Bindable var router = router

        if sizeClass == .regular {
            // iPad and landscape iPhone Max: sidebar + detail.
            NavigationSplitView {
                List(visibleTabs, selection: Binding(
                    get: { router.selectedTab },
                    set: { router.selectedTab = $0 ?? .home }
                )) { tab in
                    Label(tab.title, systemImage: tab.symbolName)
                        .tag(tab)
                }
                .navigationTitle("Orionis Control")
                .listStyle(.sidebar)
            } detail: {
                destination(for: router.selectedTab)
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
        }
    }

    @ViewBuilder
    private func destination(for tab: RootTab) -> some View {
        switch tab {
        case .home: DashboardView()
        case .cameras: CamerasView()
        case .events: EventsView()
        case .adGuard: AdGuardView()
        case .system: SystemView()
        case .settings: SettingsView()
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
