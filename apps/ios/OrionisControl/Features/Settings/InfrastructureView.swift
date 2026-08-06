import SwiftUI

/// Caddy and Authelia, from the phone.
///
/// This screen is written to be hard to hurt yourself with. Everything on it can
/// affect every site on the server and every user's ability to sign in — including
/// the person holding the phone — so each action states its blast radius before it
/// happens, restarting Authelia is presented as queued rather than instant, and
/// configuration is shown read-only. Editing a Caddyfile on a phone keyboard is
/// not a feature, it is a way to take a client's site down at a bus stop.
@MainActor
@Observable
final class InfrastructureModel {
    private(set) var status: InfraStatus?
    private(set) var users: [AutheliaUserSummary] = []
    private(set) var backups: [AutheliaBackupSummary] = []
    private(set) var isLoading = false
    private(set) var error: APIError?
    private(set) var notice: String?
    private(set) var isWorking = false

    private let service: any InfraServicing
    private var loadGeneration = 0

    init(service: any InfraServicing) {
        self.service = service
    }

    func load() async {
        loadGeneration &+= 1
        let generation = loadGeneration
        if status == nil { isLoading = true }
        defer {
            if generation == loadGeneration { isLoading = false }
        }
        async let usersRequest = service.autheliaUsers()
        async let backupsRequest = service.autheliaBackups()
        do {
            let loadedStatus = try await service.infraStatus()
            let loadedUsers = try? await usersRequest
            let loadedBackups = try? await backupsRequest
            guard generation == loadGeneration else { return }
            status = loadedStatus
            error = nil
            // Users and backups are secondary: failing to read them should not
            // hide whether Caddy and Authelia are up or erase prior good data.
            if let loadedUsers { users = loadedUsers }
            if let loadedBackups { backups = loadedBackups }
        } catch let apiError as APIError {
            guard generation == loadGeneration else { return }
            error = apiError
        } catch {
            guard generation == loadGeneration else { return }
            self.error = .unexpectedStatus(0, requestId: nil)
        }
    }

    func requestRestart() async {
        loadGeneration &+= 1
        isLoading = false
        isWorking = true
        notice = nil
        defer { isWorking = false }
        do {
            let state = try await service.requestAutheliaRestart()
            status = status.map {
                InfraStatus(caddy: $0.caddy, authelia: $0.authelia, autheliaRestart: state)
            }
            notice = state.message ?? "Restart queued."
        } catch let apiError as APIError {
            error = apiError
        } catch {
            self.error = .unexpectedStatus(0, requestId: nil)
        }
    }

    func restore(backup: String) async {
        loadGeneration &+= 1
        isLoading = false
        isWorking = true
        notice = nil
        defer { isWorking = false }
        do {
            try await service.restoreAutheliaBackup(name: backup)
            notice =
                "Restored \(backup). Authelia keeps running its current configuration until it is restarted."
            await load()
        } catch let apiError as APIError {
            error = apiError
        } catch {
            self.error = .unexpectedStatus(0, requestId: nil)
        }
    }
}

struct InfrastructureView: View {
    @Environment(AppEnvironment.self) private var environment
    @State private var model: InfrastructureModel?
    @State private var confirmingRestart = false
    @State private var restoringBackup: String?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                if let model {
                    if let status = model.status {
                        hero(status)
                        // Operations sit directly under the state they act on,
                        // before the reference material below.
                        caddySection(status.caddy)
                        autheliaSection(
                            status.authelia, restart: status.autheliaRestart, model: model)
                    }

                    if let notice = model.notice {
                        SettingsNoteRow(
                            text: notice, systemImage: "checkmark.circle.fill", tint: Theme.good
                        )
                        .orionisCard()
                    }
                    // The model keeps prior good data through a failed refresh,
                    // so this reports staleness rather than replacing the screen.
                    if let error = model.error {
                        if model.status == nil {
                            WarningBanner(
                                title: error.title, message: error.message, tint: Theme.critical)
                        } else {
                            StaleDataBanner(
                                asOf: Date(),
                                title: "Infrastructure status may be outdated",
                                reason: error.message,
                                retry: { await model.load() })
                        }
                    }

                    if !model.users.isEmpty { usersSection(model.users) }
                    if !model.backups.isEmpty { backupsSection(model) }
                    configSection
                } else {
                    LoadingStateView(message: "Reading infrastructure…")
                        .frame(minHeight: 220)
                }
            }
            .padding(16)
            .frame(maxWidth: 820)
            .frame(maxWidth: .infinity)
        }
        .orionisScreen()
        .navigationTitle("Infrastructure")
        .task {
            if model == nil { model = InfrastructureModel(service: environment.service) }
            await model?.load()
        }
        .refreshable { await model?.load() }
        .confirmationDialog(
            "Restart Authelia?",
            isPresented: $confirmingRestart,
            titleVisibility: .visible
        ) {
            Button("Queue restart", role: .destructive) {
                Task { await restart() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                "Every signed-in user will be signed out of every protected site — including you, in this app. The restart runs on the server within a few minutes."
            )
        }
        .confirmationDialog(
            "Restore this backup?",
            isPresented: Binding(
                get: { restoringBackup != nil },
                set: { if !$0 { restoringBackup = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let name = restoringBackup {
                Button("Restore \(name)", role: .destructive) {
                    Task {
                        await model?.restore(backup: name)
                        restoringBackup = nil
                    }
                }
            }
            Button("Cancel", role: .cancel) { restoringBackup = nil }
        } message: {
            Text(
                "This replaces Authelia's current configuration. It does not take effect until Authelia is restarted, so you can review it first."
            )
        }
    }

    // MARK: Sections

    /// The one-line answer to "is anything wrong down there?".
    ///
    /// Counts come only from what the gateway actually reported — a missing
    /// figure is omitted rather than defaulted to zero, which would read as a
    /// confident "nothing is online".
    @ViewBuilder
    private func hero(_ status: InfraStatus) -> some View {
        let caddyDown = status.caddy.offline ?? 0
        let autheliaDown = status.authelia.running == false
        let unreadable = status.caddy.error != nil || status.authelia.error != nil
        let healthy = caddyDown == 0 && !autheliaDown && !unreadable

        var detail: [String] = []
        if let online = status.caddy.online, let total = status.caddy.total {
            detail.append("\(online) of \(total) Caddy servers online")
        }
        if let autheliaStatus = status.authelia.status {
            detail.append("Authelia \(autheliaStatus.lowercased())")
        }

        OperationalStatusHero(
            title: healthy
                ? "Infrastructure healthy"
                : unreadable ? "Infrastructure status incomplete" : "Infrastructure needs attention",
            message: detail.isEmpty
                ? (unreadable ? "Some components could not be read." : "No details reported.")
                : detail.joined(separator: " · "),
            systemImage: healthy ? "checkmark.circle.fill" : "exclamationmark.triangle.fill",
            tint: healthy ? Theme.good : (unreadable ? Theme.warn : Theme.critical))
    }

    @ViewBuilder
    private func caddySection(_ caddy: CaddyState) -> some View {
        if let error = caddy.error {
            WarningBanner(title: "Caddy could not be read", message: error, tint: Theme.warn)
        } else {
            DetailGroup("Caddy") {
                DetailValueRow(
                    label: "Servers",
                    value: "\(caddy.online ?? 0) of \(caddy.total ?? 0) online",
                    tint: (caddy.offline ?? 0) > 0 ? Theme.warn : nil)
                // Offline servers first: the reason to open this screen is
                // usually that one of them is down.
                ForEach(
                    (caddy.servers ?? []).sorted {
                        $0.isOnline == $1.isOnline
                            ? $0.name.localizedStandardCompare($1.name) == .orderedAscending
                            : !$0.isOnline
                    }
                ) { server in
                    SettingsDivider()
                    HStack(spacing: 11) {
                        StatusDot(color: server.isOnline ? Theme.good : Theme.critical)
                        Text(server.name)
                            .font(.system(size: 14))
                            .foregroundStyle(Theme.textPrimary)
                            .lineLimit(1)
                        Spacer(minLength: 8)
                        Text(server.status.capitalized)
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(server.isOnline ? Theme.good : Theme.critical)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 11)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(server.name), \(server.status)")
                }
            }
        }
    }

    @ViewBuilder
    private func autheliaSection(
        _ authelia: AutheliaState,
        restart: AutheliaRestartState,
        model: InfrastructureModel
    ) -> some View {
        if let error = authelia.error {
            WarningBanner(title: "Authelia could not be read", message: error, tint: Theme.warn)
        } else {
            DetailGroup("Authelia") {
                DetailValueRow(
                    label: "State",
                    value: authelia.status?.capitalized ?? "Unknown",
                    tint: authelia.running == true ? Theme.good : Theme.critical)
                if let health = authelia.health {
                    SettingsDivider()
                    DetailValueRow(label: "Health", value: health.capitalized)
                }
                if let started = authelia.startedAt {
                    SettingsDivider()
                    DetailValueRow(
                        label: "Running since",
                        value: started.formatted(date: .abbreviated, time: .shortened))
                }
                if let restarts = authelia.restartCount {
                    SettingsDivider()
                    DetailValueRow(label: "Restarts", value: "\(restarts)")
                }

                // A queued restart has not happened. Say so, rather than letting
                // the button look like it already did something.
                if restart.pending, let at = restart.requestedAt {
                    SettingsDivider()
                    SettingsNoteRow(
                        text: "Restart queued \(at.formatted(date: .omitted, time: .shortened))"
                            + (restart.requestedBy.map { " by \($0)" } ?? ""),
                        systemImage: "clock.arrow.circlepath", tint: Theme.warn)
                } else if let last = restart.lastRestartedAt {
                    SettingsDivider()
                    DetailValueRow(
                        label: "Last restarted",
                        value: last.formatted(date: .abbreviated, time: .shortened))
                }
            }

            // The disruptive action is its own group. Only it carries the
            // destructive treatment — the screen around it stays neutral.
            if canManage, restart.available {
                DetailGroup("Operations") {
                    SettingsButtonRow(
                        title: "Restart Authelia",
                        subtitle: "Signs out every user on every protected site, including you",
                        systemImage: "arrow.clockwise",
                        tint: Theme.critical,
                        isBusy: model.isWorking,
                        isEnabled: !restart.pending
                    ) { confirmingRestart = true }
                }
            }

            SettingsHint(
                "Authelia reads its configuration only when it starts, so a saved change is not live until it is restarted."
            )
        }
    }

    @ViewBuilder
    private func usersSection(_ users: [AutheliaUserSummary]) -> some View {
        DetailGroup("Users") {
            ForEach(Array(users.enumerated()), id: \.element.id) { index, user in
                if index > 0 { SettingsDivider() }
                HStack(alignment: .top, spacing: 11) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(user.displayName ?? user.username)
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(Theme.textPrimary)
                        if let email = user.email {
                            Text(email)
                                .font(.system(size: 12))
                                .foregroundStyle(Theme.textSecondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        if !user.groups.isEmpty {
                            Text(user.groups.joined(separator: ", "))
                                .font(.system(size: 11))
                                .foregroundStyle(Theme.textTertiary)
                        }
                    }
                    Spacer(minLength: 8)
                    if user.disabled {
                        StatusPill(title: "Disabled", tint: Theme.critical)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .accessibilityElement(children: .combine)
                .accessibilityLabel(
                    "\(user.displayName ?? user.username)\(user.disabled ? ", disabled" : "")")
            }
        }
    }

    @ViewBuilder
    private func backupsSection(_ model: InfrastructureModel) -> some View {
        DetailGroup("Configuration backups") {
            ForEach(Array(model.backups.enumerated()), id: \.element.id) { index, backup in
                if index > 0 { SettingsDivider() }
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(backup.name)
                            .font(.system(size: 13, design: .monospaced))
                            .foregroundStyle(Theme.textPrimary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        HStack(spacing: 6) {
                            if let modified = backup.modifiedAt {
                                Text(modified.formatted(date: .abbreviated, time: .shortened))
                            }
                            Text(backup.size.formattedBytes)
                        }
                        .font(.system(size: 11).monospacedDigit())
                        .foregroundStyle(Theme.textTertiary)
                    }
                    Spacer(minLength: 8)
                    if canManage {
                        Button { restoringBackup = backup.name } label: {
                            Text("Restore")
                                .font(.system(size: 12.5, weight: .semibold))
                                .foregroundStyle(Theme.warn)
                                .padding(.horizontal, 11)
                                .padding(.vertical, 6)
                                .background(Theme.soft(Theme.warn), in: Capsule())
                        }
                        .buttonStyle(.plain)
                        .disabled(model.isWorking)
                        .accessibilityLabel("Restore backup \(backup.name)")
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
            }
        }
    }

    @ViewBuilder
    private var configSection: some View {
        DetailGroup("Configuration") {
            SettingsNavRow(
                title: "Caddy Configuration",
                subtitle: "Read-only",
                systemImage: "doc.plaintext.fill",
                tint: Theme.textSecondary
            ) { InfraConfigView(kind: .caddy) }
            SettingsDivider()
            SettingsNavRow(
                title: "Authelia Configuration",
                subtitle: "Read-only",
                systemImage: "doc.plaintext.fill",
                tint: Theme.textSecondary
            ) { InfraConfigView(kind: .authelia) }
        }
        SettingsHint(
            "Read-only here on purpose. Editing these by hand on a phone is how a site goes down by accident — make changes from the Caddy manager, where the diff is visible."
        )
    }

    private var canManage: Bool {
        // Mirrors the server, which refuses these to anyone but an administrator.
        environment.auth.state.user?.role == .administrator
    }

    private func restart() async {
        if environment.preferences.requireBiometricForAdminActions {
            let outcome = await environment.biometrics.authenticate(
                reason: "Confirm restarting Authelia. Everyone will be signed out.")
            guard outcome == .success else { return }
        }
        await model?.requestRestart()
    }
}

/// Read-only configuration viewer.
struct InfraConfigView: View {
    enum Kind {
        case caddy, authelia

        var title: String {
            switch self {
            case .caddy: "Caddy configuration"
            case .authelia: "Authelia configuration"
            }
        }
    }

    let kind: Kind

    @Environment(AppEnvironment.self) private var environment
    @State private var content: String?
    @State private var error: APIError?

    var body: some View {
        ScrollView([.vertical, .horizontal]) {
            if let content {
                Text(content)
                    .font(.system(.caption2, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(12)
            } else if let error {
                Label(error.message, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.orange)
                    .padding()
            } else {
                ProgressView().padding()
            }
        }
        .orionisScreen()
        .navigationTitle(kind.title)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            do {
                content =
                    kind == .caddy
                    ? try await environment.service.caddyConfig()
                    : try await environment.service.autheliaConfig()
            } catch let apiError as APIError {
                error = apiError
            } catch {
                self.error = .unexpectedStatus(0, requestId: nil)
            }
        }
    }
}
