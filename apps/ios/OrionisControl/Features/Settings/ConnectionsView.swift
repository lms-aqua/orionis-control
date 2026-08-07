import SwiftUI

/// Camera sources, managed from the phone.
///
/// This is the screen that makes the gateway's camera list editable instead of
/// something only a redeploy can change. It is administrator-only, mirroring
/// what the gateway enforces — a connection holds credentials for a system this
/// app does not own.
@MainActor
@Observable
final class ConnectionsModel {
    private(set) var connections: [ConnectionSummary] = []
    private(set) var providers: [ProviderDescriptor] = []
    /// Whether this gateway has a host-side applier behind it. Without one the
    /// app never offers to start a bridge, because the button could only fail.
    private(set) var canProvision = false
    private(set) var isLoading = false
    private(set) var error: APIError?
    /// The connection currently being probed, so only its row shows a spinner.
    private(set) var probingId: String?

    private let service: any ConnectionServicing

    init(service: any ConnectionServicing) {
        self.service = service
    }

    func descriptor(for connection: ConnectionSummary) -> ProviderDescriptor? {
        providers.first { $0.id == connection.provider }
    }

    func load(showSpinner: Bool = true) async {
        if showSpinner, connections.isEmpty { isLoading = true }
        defer { isLoading = false }
        do {
            // Both together: the list is unreadable without the descriptors,
            // which supply each source's name, icon and capabilities.
            async let list = service.connections()
            async let catalogue = service.connectionProviders()
            connections = try await list
            let resolved = try await catalogue
            providers = resolved.providers
            canProvision = resolved.provisioningAvailable
            error = nil
        } catch let apiError as APIError {
            error = apiError
        } catch {
            self.error = .unexpectedStatus(0, requestId: nil)
        }
    }

    func probe(_ id: String) async {
        guard probingId == nil else { return }
        probingId = id
        defer { probingId = nil }
        // The probe's own result is written back into the row rather than
        // re-fetching the list, so the screen does not flicker.
        if (try? await service.probeConnection(id: id)) != nil {
            await load(showSpinner: false)
        }
    }

    func remove(_ id: String) async {
        do {
            try await service.removeConnection(id: id)
            connections.removeAll { $0.id == id }
        } catch let apiError as APIError {
            error = apiError
        } catch {
            self.error = .unexpectedStatus(0, requestId: nil)
        }
    }
}

struct ConnectionsView: View {
    @Environment(AppEnvironment.self) private var environment
    @State private var model: ConnectionsModel?
    @State private var isAdding = false

    private var canManage: Bool {
        environment.auth.state.user?.can(.connectionsManage) == true
    }

    var body: some View {
        SettingsScreen(title: "Connections") {
            if let model {
                content(model)
            } else {
                LoadingStateView(message: "Loading sources…")
            }
        }
        .toolbar {
            if canManage {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        isAdding = true
                    } label: {
                        Label("Add", systemImage: "plus")
                    }
                    .disabled(model?.providers.isEmpty ?? true)
                }
            }
        }
        .task {
            if model == nil { model = ConnectionsModel(service: environment.service) }
            await model?.load()
        }
        .refreshable { await model?.load(showSpinner: false) }
        .sheet(isPresented: $isAdding) {
            if let model {
                ConnectionEditorView(
                    providers: model.providers, canProvision: model.canProvision, existing: nil
                ) {
                    await model.load(showSpinner: false)
                }
            }
        }
    }

    @ViewBuilder
    private func content(_ model: ConnectionsModel) -> some View {
        if let error = model.error, model.connections.isEmpty {
            SettingsGroup { ErrorSummary(error: error).padding(14) }
            if case .server(let code, _, _, _) = error, code == .serviceNotConfigured {
                // The feature is off rather than broken, and the fix is on the
                // server — saying which switch saves a support round trip.
                SettingsHint(
                    "Connections are switched off on this gateway. An administrator turns them on by setting CONNECTIONS_SECRET_KEY on the server."
                )
            }
        } else if model.connections.isEmpty && !model.isLoading {
            emptyState
        } else {
            SectionLabel("Camera sources")
            SettingsGroup {
                ForEach(Array(model.connections.enumerated()), id: \.element.id) { index, item in
                    if index > 0 { SettingsDivider(inset: 56) }
                    connectionRow(item, model: model)
                }
            }
            SettingsHint(
                "Cameras from every enabled source appear together on the Cameras screen, grouped by the source they came from."
            )
        }
    }

    private var emptyState: some View {
        VStack(spacing: 14) {
            Image(systemName: "camera.metering.center.weighted")
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(Theme.textTertiary)
            Text("No camera sources yet")
                .font(.headline)
                .foregroundStyle(Theme.textPrimary)
            Text(
                "Add a Frigate server, a UniFi Protect console, a Tapo or Wyze camera, Nest, or any RTSP stream. They all appear as one camera list."
            )
            .font(.footnote)
            .foregroundStyle(Theme.textSecondary)
            .multilineTextAlignment(.center)

            if canManage {
                Button("Add a source") { isAdding = true }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 11)
                    .background(Theme.accent, in: Capsule())
                    .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
        .padding(.horizontal, 8)
    }

    @ViewBuilder
    private func connectionRow(_ item: ConnectionSummary, model: ConnectionsModel) -> some View {
        let descriptor = model.descriptor(for: item)
        SettingsNavRow(
            title: item.name,
            subtitle: subtitle(for: item, descriptor: descriptor),
            systemImage: descriptor?.symbolName ?? "camera.metering.center.weighted",
            tint: tint(for: item),
            statusColor: item.enabled ? tint(for: item) : nil
        ) {
            ConnectionDetailView(
                connectionId: item.id, providers: model.providers,
                canProvision: model.canProvision)
        }
    }

    /// One line that says what this source is and whether it is working.
    private func subtitle(for item: ConnectionSummary, descriptor: ProviderDescriptor?) -> String {
        let kind = descriptor?.displayName ?? item.provider
        guard item.enabled else { return "\(kind) · Disabled" }

        // A bridge still being built outranks health: the upstream genuinely is
        // not reachable yet, and "Not reachable" reads as a fault when it is
        // just work in progress.
        if let provisioning = item.provisioning, provisioning.isInFlight {
            return "\(kind) · \(provisioning.title)"
        }
        if item.provisioning?.state == .failed {
            return "\(kind) · Setup failed"
        }

        guard let health = item.health else { return "\(kind) · Not checked yet" }
        switch health.status {
        case .healthy:
            if let count = health.cameraCount {
                return "\(kind) · \(count) camera\(count == 1 ? "" : "s")"
            }
            return "\(kind) · Connected"
        case .degraded: return "\(kind) · Partly reachable"
        case .unreachable: return "\(kind) · Not reachable"
        case .unknown: return "\(kind) · Not checked yet"
        }
    }

    private func tint(for item: ConnectionSummary) -> Color {
        guard item.enabled else { return Theme.textSecondary }
        if let provisioning = item.provisioning {
            if provisioning.isInFlight { return Theme.warn }
            if provisioning.state == .failed { return Theme.critical }
        }
        switch item.health?.status {
        case .healthy: return Theme.good
        case .degraded: return Theme.warn
        case .unreachable: return Theme.critical
        default: return Theme.textSecondary
        }
    }
}
