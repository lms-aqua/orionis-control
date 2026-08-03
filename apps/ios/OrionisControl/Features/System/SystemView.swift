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
            List {
                Section {
                    HStack {
                        StatusBadge(status: snapshot.overall, label: "Overall")
                        Spacer()
                        Text(snapshot.checkedAt.formatted(date: .omitted, time: .shortened))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Section("Services") {
                    ForEach(snapshot.services) { service in
                        ServiceRow(service: service)
                    }
                }

                if let result = model.lastResult {
                    Section("Last action") {
                        Label(
                            result.message,
                            systemImage: result.ok
                                ? "checkmark.circle.fill" : "xmark.octagon.fill"
                        )
                        .font(.subheadline)
                        .foregroundStyle(result.ok ? .green : .red)
                        Text(result.ranAt.formatted(date: .omitted, time: .standard))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                if let actionError = model.actionError {
                    Section { ErrorSummary(error: actionError) }
                }

                if environment.auth.state.user?.can(.systemActionsRun) == true,
                    !model.actions.isEmpty
                {
                    Section {
                        ForEach(model.actions) { action in
                            Button {
                                if action.disruptive {
                                    confirming = action
                                } else {
                                    Task { await run(action) }
                                }
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(action.name)
                                        Text(action.description)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    if model.runningActionId == action.id {
                                        ProgressView()
                                    } else if action.disruptive {
                                        Image(systemName: "exclamationmark.triangle.fill")
                                            .font(.caption)
                                            .foregroundStyle(.orange)
                                    }
                                }
                            }
                            .disabled(model.runningActionId != nil)
                        }
                    } header: {
                        Text("Operations")
                    } footer: {
                        Text(
                            "Only these specific operations can be run from the app. There is no general command access."
                        )
                    }
                }

                Section("Gateway") {
                    LabeledContent("Version", value: snapshot.gateway.version)
                    LabeledContent("Environment", value: snapshot.gateway.environment.capitalized)
                    LabeledContent(
                        "Uptime", value: formatUptime(snapshot.gateway.uptimeSeconds))
                }

                if environment.auth.state.user?.can(.auditView) == true {
                    Section {
                        NavigationLink("Audit log") { AuditLogView() }
                    }
                }
            }
            .refreshable { await model.load(showSpinner: false) }
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

struct ServiceRow: View {
    let service: ServiceHealth

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                StatusBadge(status: service.status, label: service.name)
                Spacer()
                if let latency = service.latencyMs {
                    Text("\(Int(latency)) ms")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
            if let message = service.message {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if !service.impacts.isEmpty {
                Text("Affects: \(service.impacts.formatted(.list(type: .and)))")
                    .font(.caption2)
                    .foregroundStyle(.orange)
            }
            if let version = service.version {
                Text(version)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
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
                List(records) { record in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text(record.action)
                                .font(.subheadline.weight(.medium))
                            Spacer()
                            Text(record.outcome)
                                .font(.caption2)
                                .foregroundStyle(record.outcome == "success" ? .green : .orange)
                        }
                        Text(
                            "\(record.actorName ?? "system") · \(record.occurredAt.formatted(date: .abbreviated, time: .standard))"
                        )
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        if let target = record.targetId {
                            Text(target).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
                        }
                        if let reason = record.reason {
                            Text(reason).font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
                .listStyle(.plain)
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
