import SwiftUI

/// Settings, as a hub rather than one long wall of controls.
///
/// The screen answers "where is that setting?" in two ways: search, which jumps
/// straight to the screen holding a control, and a short list of icon-led
/// categories that each open a focused screen. Nothing was removed in the
/// redesign — every control from the old single `Form` lives in a category.
struct SettingsView: View {
    /// False when pushed from the More hub, which already owns the stack.
    var embedsNavigationStack: Bool = true

    @Environment(AppEnvironment.self) private var environment
    @State private var query = ""
    @State private var showSignOutConfirmation = false

    var body: some View {
        OptionalNavigationStack(isEnabled: embedsNavigationStack) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if searchIsActive {
                        searchResults
                    } else {
                        hub
                    }
                }
                .padding(16)
            }
            .orionisScreen()
            .navigationTitle("Settings")
            .searchable(
                text: $query,
                placement: .navigationBarDrawer(displayMode: .always),
                prompt: "Search settings")
            .confirmationDialog(
                "Sign out of Orionis Control?",
                isPresented: $showSignOutConfirmation,
                titleVisibility: .visible
            ) {
                Button("Sign out", role: .destructive) {
                    Task { await environment.signOutAndForget() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(
                    "Your saved session is removed from this device and this device's push registration is cancelled."
                )
            }
        }
    }

    private var searchIsActive: Bool {
        !query.trimmingCharacters(in: .whitespaces).isEmpty
    }

    // MARK: Hub

    @ViewBuilder
    private var hub: some View {
        if let user = environment.auth.state.user {
            profileCard(user)
        }

        SectionLabel("Preferences")
        SettingsGroup {
            SettingsNavRow(
                title: "Security & Privacy",
                subtitle: "Face ID, auto-lock, app-switcher privacy",
                systemImage: "lock.shield.fill",
                tint: Theme.good
            ) { SecuritySettingsView() }

            SettingsDivider(inset: 56)

            SettingsNavRow(
                title: "Cameras & Streaming",
                subtitle: "Quality, layout, recordings",
                systemImage: "video.fill",
                tint: Theme.accent
            ) { CameraSettingsView() }

            SettingsDivider(inset: 56)

            SettingsNavRow(
                title: "Notifications",
                subtitle: "Alerts, quiet hours, alert types",
                systemImage: "bell.fill",
                tint: Theme.warn
            ) { NotificationSettingsView() }

            SettingsDivider(inset: 56)

            SettingsNavRow(
                title: "Appearance",
                subtitle: "Theme",
                systemImage: "circle.lefthalf.filled",
                tint: Color(lightHex: 0x8A6CFF, darkHex: 0x8A6CFF),
                value: environment.preferences.appearance.displayName
            ) { AppearanceSettingsView() }
        }

        SectionLabel("System")
        SettingsGroup {
            SettingsNavRow(
                title: "Server & Connection",
                subtitle: connectionSubtitle,
                systemImage: "wifi",
                tint: Theme.accent,
                statusColor: environment.meta == nil ? Theme.warn : Theme.good
            ) { ServerConnectionView() }

            if environment.auth.state.user?.role == .administrator {
                SettingsDivider(inset: 56)
                SettingsNavRow(
                    title: "Infrastructure",
                    subtitle: "Caddy & Authelia",
                    systemImage: "server.rack",
                    tint: Theme.warn,
                    chip: "Admin"
                ) { InfrastructureView() }
            }

            SettingsDivider(inset: 56)

            SettingsNavRow(
                title: "About & Diagnostics",
                subtitle: "Version, connection test, export report",
                systemImage: "info.circle.fill",
                tint: Theme.textSecondary,
                value: environment.configuration.version
            ) { AboutSettingsView() }
        }

        Button(role: .destructive) {
            showSignOutConfirmation = true
        } label: {
            Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.critical)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(
                    Theme.soft(Theme.critical),
                    in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
        .padding(.top, 2)
    }

    private var connectionSubtitle: String {
        let host =
            URL(string: environment.preferences.serverURLString)?.host
            ?? environment.preferences.serverURLString
        let state = environment.meta == nil ? "Not verified yet" : "Connected"
        return host.isEmpty ? state : "\(host) · \(state)"
    }

    /// Who you are signed in as, opening the account screen.
    private func profileCard(_ user: CurrentUser) -> some View {
        NavigationLink {
            AccountSettingsView()
        } label: {
            HStack(spacing: 13) {
                Text(String(user.name.prefix(1)).uppercased())
                    .font(.system(size: 19, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 48, height: 48)
                    .background(
                        LinearGradient(
                            colors: [
                                Theme.accent, Color(lightHex: 0x8A6CFF, darkHex: 0x6A4CFF),
                            ],
                            startPoint: .topLeading, endPoint: .bottomTrailing),
                        in: RoundedRectangle(cornerRadius: 15, style: .continuous))

                VStack(alignment: .leading, spacing: 3) {
                    Text(user.name)
                        .font(.system(size: 18, weight: .bold))
                        .foregroundStyle(Theme.textPrimary)
                    HStack(spacing: 6) {
                        if let email = user.email {
                            Text(email)
                                .font(.caption)
                                .foregroundStyle(Theme.textSecondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        SettingsChip(
                            text: user.role == .administrator ? "Admin" : user.role.displayName,
                            tint: Theme.accent)
                    }
                }
                Spacer(minLength: 6)
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.textTertiary)
            }
            .padding(14)
            .orionisCard(fill: Theme.surfaceRaised)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: Search

    @ViewBuilder
    private var searchResults: some View {
        let matches = SettingsIndex.matches(for: query, isAdministrator: isAdministrator)
        if matches.isEmpty {
            VStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 26, weight: .light))
                    .foregroundStyle(Theme.textTertiary)
                Text("No settings match “\(query)”")
                    .font(.subheadline)
                    .foregroundStyle(Theme.textSecondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 40)
        } else {
            SectionLabel("\(matches.count) result\(matches.count == 1 ? "" : "s")")
            SettingsGroup {
                ForEach(Array(matches.enumerated()), id: \.element.id) { index, entry in
                    if index > 0 { SettingsDivider(inset: 56) }
                    SettingsNavRow(
                        title: entry.title,
                        subtitle: entry.category.title,
                        systemImage: entry.category.systemImage,
                        tint: entry.category.tint
                    ) { destination(for: entry.category) }
                }
            }
        }
    }

    private var isAdministrator: Bool {
        environment.auth.state.user?.role == .administrator
    }

    @ViewBuilder
    private func destination(for category: SettingsCategory) -> some View {
        switch category {
        case .account: AccountSettingsView()
        case .security: SecuritySettingsView()
        case .cameras: CameraSettingsView()
        case .notifications: NotificationSettingsView()
        case .appearance: AppearanceSettingsView()
        case .connection: ServerConnectionView()
        case .infrastructure: InfrastructureView()
        case .about: AboutSettingsView()
        }
    }
}

// MARK: - Search index

/// The categories a setting can live in, and how each is presented.
enum SettingsCategory: String, CaseIterable {
    case account, security, cameras, notifications, appearance, connection, infrastructure, about

    var title: String {
        switch self {
        case .account: return "Account"
        case .security: return "Security & Privacy"
        case .cameras: return "Cameras & Streaming"
        case .notifications: return "Notifications"
        case .appearance: return "Appearance"
        case .connection: return "Server & Connection"
        case .infrastructure: return "Infrastructure"
        case .about: return "About & Diagnostics"
        }
    }

    var systemImage: String {
        switch self {
        case .account: return "person.crop.circle.fill"
        case .security: return "lock.shield.fill"
        case .cameras: return "video.fill"
        case .notifications: return "bell.fill"
        case .appearance: return "circle.lefthalf.filled"
        case .connection: return "wifi"
        case .infrastructure: return "server.rack"
        case .about: return "info.circle.fill"
        }
    }

    var tint: Color {
        switch self {
        case .account: return Theme.accent
        case .security: return Theme.good
        case .cameras: return Theme.accent
        case .notifications: return Theme.warn
        case .appearance: return Color(lightHex: 0x8A6CFF, darkHex: 0x8A6CFF)
        case .connection: return Theme.accent
        case .infrastructure: return Theme.warn
        case .about: return Theme.textSecondary
        }
    }

    /// Only administrators see infrastructure, matching what the gateway enforces.
    var isAdministratorOnly: Bool { self == .infrastructure }
}

/// A flat, searchable list of every control in Settings.
///
/// Kept next to the screens themselves: when a control is added, add its entry
/// here so search keeps covering the whole surface.
struct SettingsIndex {
    struct Entry: Identifiable {
        let title: String
        let category: SettingsCategory
        /// Extra words a person might type instead of the control's own name.
        var keywords: String = ""

        var id: String { "\(category.rawValue).\(title)" }
    }

    static let entries: [Entry] = [
        .init(title: "Signed in as", category: .account, keywords: "name user profile who"),
        .init(title: "Email", category: .account, keywords: "address"),
        .init(title: "Role and groups", category: .account, keywords: "admin permissions member"),
        .init(title: "Sign in again", category: .account, keywords: "reauthenticate login refresh"),
        .init(title: "Signed-in devices", category: .account, keywords: "sessions revoke phone"),

        .init(title: "Require Face ID / Touch ID", category: .security, keywords: "biometric unlock passcode"),
        .init(title: "Lock after", category: .security, keywords: "auto-lock timeout idle"),
        .init(title: "Confirm privileged actions", category: .security, keywords: "biometric admin confirm"),
        .init(title: "Hide previews in the app switcher", category: .security, keywords: "privacy screenshot blur"),

        .init(title: "Default quality", category: .cameras, keywords: "stream resolution bitrate hd"),
        .init(title: "Grid size", category: .cameras, keywords: "layout columns tiles compact"),
        .init(title: "Start live view automatically", category: .cameras, keywords: "autoplay"),
        .init(title: "Start muted", category: .cameras, keywords: "audio sound mute volume"),
        .init(title: "Reduce quality on cellular", category: .cameras, keywords: "data 5g lte mobile"),
        .init(title: "Recordings storage & retention", category: .cameras, keywords: "disk keep days delete"),

        .init(title: "Enable notifications", category: .notifications, keywords: "push alerts"),
        .init(title: "Minimum severity", category: .notifications, keywords: "critical warning filter"),
        .init(title: "Quiet hours", category: .notifications, keywords: "do not disturb night schedule"),
        .init(title: "Alert types", category: .notifications, keywords: "kinds motion offline events"),

        .init(title: "Theme", category: .appearance, keywords: "dark light appearance mode"),

        .init(title: "Gateway address", category: .connection, keywords: "server url host https"),
        .init(title: "Test connection", category: .connection, keywords: "check reachability ping"),
        .init(title: "Server and API version", category: .connection, keywords: "build environment"),

        .init(title: "Caddy and Authelia", category: .infrastructure, keywords: "proxy sso sites routes"),

        .init(title: "App version", category: .about, keywords: "build number release"),
        .init(title: "Export diagnostic report", category: .about, keywords: "support logs share troubleshoot"),
    ]

    /// Case- and diacritic-insensitive match over a control's name, its keywords
    /// and its category name.
    static func matches(for query: String, isAdministrator: Bool) -> [Entry] {
        let needle = query.trimmingCharacters(in: .whitespaces)
        guard !needle.isEmpty else { return [] }
        return entries.filter { entry in
            guard !entry.category.isAdministratorOnly || isAdministrator else { return false }
            let haystack = "\(entry.title) \(entry.keywords) \(entry.category.title)"
            return haystack.range(of: needle, options: [.caseInsensitive, .diacriticInsensitive])
                != nil
        }
    }
}
