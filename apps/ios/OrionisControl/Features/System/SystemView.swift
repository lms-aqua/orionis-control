import SwiftUI

@MainActor
@Observable
final class SystemViewModel {
    private(set) var snapshot: SystemHealthSnapshot?
    private(set) var actions: [SystemAction] = []
    private(set) var error: APIError?
    private(set) var isLoading = false
    private(set) var runningActionId: String?
    private(set) var lastResult: SystemActionResult?
    private(set) var actionError: APIError?

    private let service: any SystemServicing
    private var loadGeneration = 0

    init(service: any SystemServicing) {
        self.service = service
    }

    func load(showSpinner: Bool = true) async {
        loadGeneration &+= 1
        let generation = loadGeneration
        if showSpinner && snapshot == nil { isLoading = true }
        defer {
            if generation == loadGeneration { isLoading = false }
        }
        async let availableActions = service.availableActions()
        do {
            let loadedSnapshot = try await service.services()
            let loadedActions = try? await availableActions
            guard generation == loadGeneration else { return }
            snapshot = loadedSnapshot
            if let loadedActions { actions = loadedActions }
            error = nil
        } catch let apiError as APIError {
            guard generation == loadGeneration else { return }
            error = apiError
        } catch {
            guard generation == loadGeneration else { return }
            self.error = .unexpectedStatus(0, requestId: nil)
        }
    }

    func run(_ action: SystemAction, serviceId: String? = nil) async {
        // A snapshot requested before this mutation must not overwrite the
        // post-action refresh when it eventually returns.
        loadGeneration &+= 1
        isLoading = false
        runningActionId = action.id
        actionError = nil
        lastResult = nil
        defer { runningActionId = nil }

        do {
            lastResult = try await service.runAction(
                action.id, serviceId: serviceId, reason: nil)
            // Reflect whatever the action actually changed.
            await load(showSpinner: false)
        } catch let error as APIError {
            actionError = error
        } catch {
            actionError = .unexpectedStatus(0, requestId: nil)
        }
    }
}

struct SystemView: View {
    @Environment(AppEnvironment.self) private var environment
    @State private var model: SystemViewModel?
    @State private var confirming: SystemAction?

    var body: some View {
        NavigationStack {
            Group {
                if let model { content(model) } else { LoadingStateView() }
            }
            .navigationTitle("System")
            .confirmationDialog(
                confirming.map { "Run “\($0.name)”?" } ?? "",
                isPresented: Binding(
                    get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
                titleVisibility: .visible
            ) {
                Button("Run", role: .destructive) {
                    if let action = confirming { Task { await run(action) } }
                    confirming = nil
                }
                Button("Cancel", role: .cancel) { confirming = nil }
            } message: {
                Text(
                    (confirming?.description ?? "")
                        + "\n\nThis affects live infrastructure and is recorded in the audit log.")
            }
        }
        .task {
            if model == nil { model = SystemViewModel(service: environment.service) }
            await model?.load()
        }
    }

    @ViewBuilder
    private func content(_ model: SystemViewModel) -> some View {
        if model.isLoading {
            LoadingStateView(message: "Checking services…")
        } else if let error = model.error, model.snapshot == nil {
            ErrorStateView(error: error, retry: { await model.load() })
        } else if let snapshot = model.snapshot {
            // Severity order, so a failure is the first thing on the screen and
            // healthy services never have to be scrolled past to find it.
            let ranked = snapshot.services.sorted {
                Self.severity($0.status) != Self.severity($1.status)
                    ? Self.severity($0.status) < Self.severity($1.status)
                    : $0.name.localizedStandardCompare($1.name) == .orderedAscending
            }
            let attention = ranked.filter { $0.status != .healthy }
            let healthy = ranked.filter { $0.status == .healthy }

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    hero(snapshot, attention: attention)

                    // The model keeps the last good snapshot through a failed
                    // refresh. Showing that as though it were current would
                    // misreport live infrastructure health, so say it is old.
                    if let error = model.error {
                        StaleDataBanner(
                            asOf: snapshot.checkedAt,
                            title: "System status may be outdated",
                            reason: error.message,
                            retry: { await model.load(showSpinner: false) })
                    }

                    if let result = model.lastResult {
                        // An operation's outcome is a headline event, not a
                        // list row halfway down the screen.
                        WarningBanner(
                            title: result.message,
                            message:
                                "Completed at \(result.ranAt.formatted(date: .omitted, time: .standard))",
                            systemImage: result.ok
                                ? "checkmark.circle.fill" : "xmark.octagon.fill",
                            tint: result.ok ? Theme.good : Theme.critical)
                    }

                    if let actionError = model.actionError {
                        WarningBanner(
                            title: actionError.title, message: actionError.message,
                            tint: Theme.critical)
                    }

                    if !attention.isEmpty {
                        DetailGroup("Needs attention") {
                            ForEach(Array(attention.enumerated()), id: \.element.id) { index, service in
                                if index > 0 { SettingsDivider() }
                                ServiceRow(service: service)
                            }
                        }
                    }

                    if !healthy.isEmpty {
                        DetailGroup(attention.isEmpty ? "Services" : "Operating normally") {
                            ForEach(Array(healthy.enumerated()), id: \.element.id) { index, service in
                                if index > 0 { SettingsDivider() }
                                ServiceRow(service: service, compact: true)
                            }
                        }
                    }

                    operations(model)

                    // Gateway build information is reference material, so it
                    // sits below operational health rather than beside it.
                    DetailGroup("Gateway") {
                        DetailValueRow(label: "Version", value: snapshot.gateway.version)
                        SettingsDivider()
                        DetailValueRow(
                            label: "Environment",
                            value: snapshot.gateway.environment.capitalized)
                        SettingsDivider()
                        DetailValueRow(
                            label: "Uptime",
                            value: formatUptime(snapshot.gateway.uptimeSeconds))
                    }

                    if environment.auth.state.user?.can(.auditView) == true {
                        DetailGroup {
                            SettingsNavRow(
                                title: "Audit Log",
                                subtitle: "Who ran what, and what happened",
                                systemImage: "doc.text.magnifyingglass",
                                tint: Theme.textSecondary
                            ) { AuditLogView() }
                        }
                    }
                }
                .padding(16)
            }
            .orionisScreen()
            .refreshable { await model.load(showSpinner: false) }
        }
    }

    /// The one-line answer to "is anything wrong?".
    private func hero(_ snapshot: SystemHealthSnapshot, attention: [ServiceHealth]) -> some View {
        let checked = "Checked \(snapshot.checkedAt.formatted(date: .omitted, time: .shortened))"
        let worst = attention.first?.status
        return OperationalStatusHero(
            title: attention.isEmpty
                ? "All systems healthy"
                : attention.count == 1
                    ? "1 service needs attention"
                    : "\(attention.count) services need attention",
            message: attention.isEmpty
                ? "\(snapshot.services.count) service\(snapshot.services.count == 1 ? "" : "s") operational"
                // Name the actual problems rather than restating the count.
                : attention.prefix(2).map { "\($0.name): \($0.status.displayName)" }
                    .joined(separator: " · "),
            systemImage: attention.isEmpty
                ? "checkmark.circle.fill" : "exclamationmark.triangle.fill",
            tint: attention.isEmpty ? Theme.good : Self.tint(for: worst ?? .warning),
            caption: checked)
    }

    @ViewBuilder
    private func operations(_ model: SystemViewModel) -> some View {
        if environment.auth.state.user?.can(.systemActionsRun) == true, !model.actions.isEmpty {
            DetailGroup("Operations") {
                ForEach(Array(model.actions.enumerated()), id: \.element.id) { index, action in
                    if index > 0 { SettingsDivider() }
                    SettingsButtonRow(
                        title: action.name,
                        subtitle: action.description,
                        systemImage: action.disruptive
                            ? "exclamationmark.triangle.fill" : "play.circle.fill",
                        tint: action.disruptive ? Theme.warn : Theme.accent,
                        isBusy: model.runningActionId == action.id,
                        isEnabled: model.runningActionId == nil
                    ) {
                        if action.disruptive {
                            confirming = action
                        } else {
                            Task { await run(action) }
                        }
                    }
                }
            }
            SettingsHint(
                "Only these specific operations can be run from the app. There is no general command access."
            )
        }
    }

    /// Presentation order for §38: critical, offline, warning, unknown, healthy.
    private static func severity(_ status: ServiceStatus) -> Int {
        switch status {
        case .critical: 0
        case .offline: 1
        case .warning: 2
        case .unknown: 3
        case .healthy: 4
        }
    }

    static func tint(for status: ServiceStatus) -> Color {
        switch status {
        case .healthy: Theme.good
        case .warning: Theme.warn
        case .critical: Theme.critical
        case .offline: Theme.critical
        case .unknown: Theme.textTertiary
        }
    }

    private func run(_ action: SystemAction) async {
        if action.disruptive, environment.preferences.requireBiometricForAdminActions {
            let outcome = await environment.biometrics.authenticate(
                reason: "Confirm running “\(action.name)”.")
            guard outcome == .success else { return }
        }
        await model?.run(action)
    }

    private func formatUptime(_ seconds: Int) -> String {
        let formatter = DateComponentsFormatter()
        formatter.allowedUnits = [.day, .hour, .minute]
        formatter.unitsStyle = .abbreviated
        formatter.maximumUnitCount = 2
        return formatter.string(from: TimeInterval(seconds)) ?? "\(seconds)s"
    }
}

/// One service.
///
/// A healthy service says so in one compact line. A failing one explains what
/// broke and what it costs the user, because that is the only time the extra
/// vertical space is worth spending. Status is a dot *and* a word, never colour
/// alone.
struct ServiceRow: View {
    let service: ServiceHealth
    var compact = false

    private var tint: Color { SystemView.tint(for: service.status) }

    var body: some View {
        HStack(alignment: .top, spacing: 11) {
            StatusDot(color: tint)
                .padding(.top, 5)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(service.name)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    if let latency = service.latencyMs {
                        Text("\(Int(latency)) ms")
                            .font(.system(size: 12).monospacedDigit())
                            .foregroundStyle(Theme.textTertiary)
                    }
                }

                Text(service.status.displayName)
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(tint)

                if !compact {
                    if let message = service.message {
                        Text(message)
                            .font(.system(size: 12.5))
                            .foregroundStyle(Theme.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    // What this failure actually costs the user.
                    if !service.impacts.isEmpty {
                        Text("Affects: \(service.impacts.formatted(.list(type: .and)))")
                            .font(.system(size: 11.5))
                            .foregroundStyle(Theme.warn)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                if let version = service.version, !compact {
                    Text(version)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(Theme.textTertiary)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, compact ? 10 : 12)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLine)
    }

    private var accessibilityLine: String {
        var parts = [service.name, service.status.displayName]
        if let message = service.message { parts.append(message) }
        if !service.impacts.isEmpty {
            parts.append("affects \(service.impacts.formatted(.list(type: .and)))")
        }
        return parts.joined(separator: ", ")
    }
}

struct AuditLogView: View {
    @Environment(AppEnvironment.self) private var environment
    @State private var records: [AuditRecord] = []
    @State private var error: APIError?
    @State private var isLoading = true

    var body: some View {
        Group {
            if isLoading {
                LoadingStateView(message: "Loading audit log…")
            } else if let error {
                ErrorStateView(error: error, retry: { await load() })
            } else if records.isEmpty {
                EmptyStateView(
                    title: "No audit records",
                    message: "Nothing has been recorded yet.",
                    systemImage: "doc.text.magnifyingglass")
            } else {
                // Action, actor and result lead; identifiers stay secondary.
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(records) { record in
                            let ok = record.outcome == "success"
                            HStack(alignment: .top, spacing: 11) {
                                Image(
                                    systemName: ok
                                        ? "checkmark.circle.fill"
                                        : "exclamationmark.triangle.fill"
                                )
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(ok ? Theme.good : Theme.warn)
                                .frame(width: 18)
                                .padding(.top, 2)

                                VStack(alignment: .leading, spacing: 3) {
                                    Text(record.action)
                                        .font(.system(size: 14.5, weight: .medium))
                                        .foregroundStyle(Theme.textPrimary)
                                    Text(record.actorName ?? "system")
                                        .font(.system(size: 12.5))
                                        .foregroundStyle(Theme.textSecondary)
                                    if let target = record.targetId {
                                        Text(target)
                                            .font(.system(size: 11, design: .monospaced))
                                            .foregroundStyle(Theme.textTertiary)
                                            .lineLimit(1)
                                            .truncationMode(.middle)
                                    }
                                    if let reason = record.reason {
                                        Text(reason)
                                            .font(.system(size: 11.5))
                                            .foregroundStyle(Theme.textSecondary)
                                    }
                                }

                                Spacer(minLength: 6)

                                Text(
                                    record.occurredAt.formatted(
                                        date: .omitted, time: .shortened)
                                )
                                .font(.system(size: 11).monospacedDigit())
                                .foregroundStyle(Theme.textTertiary)
                            }
                            .padding(.horizontal, 16)
                            .padding(.vertical, 11)
                            .accessibilityElement(children: .combine)
                            .accessibilityLabel(
                                "\(record.action), \(record.actorName ?? "system"), \(record.outcome)"
                            )
                            SettingsDivider(inset: 45)
                        }
                    }
                }
                .orionisScreen()
                .refreshable { await load() }
            }
        }
        .navigationTitle("Audit log")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load() async {
        isLoading = records.isEmpty
        defer { isLoading = false }
        do {
            records = try await environment.service.auditLog(limit: 100, offset: 0).items
            error = nil
        } catch let apiError as APIError {
            error = apiError
        } catch {
            self.error = .unexpectedStatus(0, requestId: nil)
        }
    }
}
