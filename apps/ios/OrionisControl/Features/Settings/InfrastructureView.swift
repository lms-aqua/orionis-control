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

    init(service: any InfraServicing) {
        self.service = service
    }

    func load() async {
        if status == nil { isLoading = true }
        defer { isLoading = false }
        do {
            status = try await service.infraStatus()
            error = nil
            // Users and backups are secondary: failing to read them should not
            // hide whether Caddy and Authelia are up.
            users = (try? await service.autheliaUsers()) ?? []
            backups = (try? await service.autheliaBackups()) ?? []
        } catch let apiError as APIError {
            error = apiError
        } catch {
            self.error = .unexpectedStatus(0, requestId: nil)
        }
    }

    func requestRestart() async {
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
        Form {
            if let model {
                if let status = model.status {
                    caddySection(status.caddy)
                    autheliaSection(status.authelia, restart: status.autheliaRestart, model: model)
                }
                if !model.users.isEmpty { usersSection(model.users) }
                if !model.backups.isEmpty { backupsSection(model) }
                configSection

                if let notice = model.notice {
                    Section {
                        Label(notice, systemImage: "checkmark.circle.fill")
                            .font(.footnote)
                            .foregroundStyle(.green)
                    }
                }
                if let error = model.error {
                    Section {
                        Label(error.message, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                }
            } else {
                Section { LoadingStateView(message: "Reading infrastructure…") }
            }
        }
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

    @ViewBuilder
    private func caddySection(_ caddy: CaddyState) -> some View {
        Section("Caddy") {
            if let error = caddy.error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            } else {
                LabeledContent("Servers") {
                    Text("\(caddy.online ?? 0) of \(caddy.total ?? 0) online")
                        .foregroundStyle((caddy.offline ?? 0) > 0 ? .orange : .secondary)
                }
                ForEach(caddy.servers ?? []) { server in
                    LabeledContent(server.name) {
                        Label(
                            server.status.capitalized,
                            systemImage: server.isOnline ? "checkmark.circle.fill" : "xmark.circle.fill"
                        )
                        .font(.caption)
                        .foregroundStyle(server.isOnline ? .green : .red)
                    }
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
        Section {
            if let error = authelia.error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            } else {
                LabeledContent("State") {
                    Label(
                        authelia.status?.capitalized ?? "Unknown",
                        systemImage: authelia.running == true ? "checkmark.circle.fill" : "xmark.circle.fill"
                    )
                    .font(.caption)
                    .foregroundStyle(authelia.running == true ? .green : .red)
                }
                if let health = authelia.health {
                    LabeledContent("Health", value: health.capitalized)
                }
                if let started = authelia.startedAt {
                    LabeledContent(
                        "Running since",
                        value: started.formatted(date: .abbreviated, time: .shortened))
                }
                if let restarts = authelia.restartCount {
                    LabeledContent("Restarts", value: "\(restarts)")
                }
            }

            // A queued restart has not happened. Say so, rather than letting the
            // button look like it already did something.
            if restart.pending, let at = restart.requestedAt {
                Label(
                    "Restart queued \(at.formatted(date: .omitted, time: .shortened))"
                        + (restart.requestedBy.map { " by \($0)" } ?? ""),
                    systemImage: "clock.arrow.circlepath"
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
            } else if let last = restart.lastRestartedAt {
                LabeledContent(
                    "Last restarted",
                    value: last.formatted(date: .abbreviated, time: .shortened))
            }

            if canManage, restart.available {
                Button(role: .destructive) {
                    confirmingRestart = true
                } label: {
                    Label("Restart Authelia", systemImage: "arrow.clockwise")
                }
                .disabled(model.isWorking || restart.pending)
            }
        } header: {
            Text("Authelia")
        } footer: {
            Text(
                "Authelia reads its configuration only when it starts, so a saved change is not live until it is restarted."
            )
        }
    }

    @ViewBuilder
    private func usersSection(_ users: [AutheliaUserSummary]) -> some View {
        Section("Users") {
            ForEach(users) { user in
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(user.displayName ?? user.username)
                        if user.disabled {
                            Text("disabled")
                                .font(.caption2)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1)
                                .background(.red.opacity(0.15), in: Capsule())
                                .foregroundStyle(.red)
                        }
                    }
                    if let email = user.email {
                        Text(email).font(.caption).foregroundStyle(.secondary)
                    }
                    if !user.groups.isEmpty {
                        Text(user.groups.joined(separator: ", "))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func backupsSection(_ model: InfrastructureModel) -> some View {
        Section("Configuration backups") {
            ForEach(model.backups) { backup in
                HStack {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(backup.name)
                            .font(.caption)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        if let modified = backup.modifiedAt {
                            Text(modified.formatted(date: .abbreviated, time: .shortened))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    Text(backup.size.formattedBytes)
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                    if canManage {
                        Button("Restore") { restoringBackup = backup.name }
                            .font(.caption)
                            .buttonStyle(.bordered)
                            .disabled(model.isWorking)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var configSection: some View {
        Section {
            NavigationLink {
                InfraConfigView(kind: .caddy)
            } label: {
                LabeledContent("Caddy configuration", value: "View")
            }
            NavigationLink {
                InfraConfigView(kind: .authelia)
            } label: {
                LabeledContent("Authelia configuration", value: "View")
            }
        } footer: {
            Text(
                "Read-only here on purpose. Editing these by hand on a phone is how a site goes down by accident — make changes from the Caddy manager, where the diff is visible."
            )
        }
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
