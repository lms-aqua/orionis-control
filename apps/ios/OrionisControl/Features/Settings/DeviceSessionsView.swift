import SwiftUI

@MainActor
@Observable
final class DeviceSessionsModel {
    private(set) var sessions: [SessionSummary] = []
    private(set) var isLoading = false
    private(set) var removingId: String?
    private(set) var error: APIError?
    private(set) var notice: String?

    private let service: any DeviceServicing

    init(service: any DeviceServicing) {
        self.service = service
    }

    var activeSessions: [SessionSummary] {
        sessions
            .filter { !$0.revoked }
            .sorted {
                if $0.current != $1.current { return $0.current }
                return ($0.lastUsedAt ?? $0.createdAt ?? .distantPast)
                    > ($1.lastUsedAt ?? $1.createdAt ?? .distantPast)
            }
    }

    func load() async {
        if sessions.isEmpty { isLoading = true }
        defer { isLoading = false }
        do {
            sessions = try await service.devices()
            error = nil
        } catch let apiError as APIError {
            error = apiError
        } catch {
            error = .unexpectedStatus(0, requestId: nil)
        }
    }

    func remove(_ session: SessionSummary) async {
        guard !session.current, removingId == nil else { return }
        removingId = session.id
        error = nil
        notice = nil
        defer { removingId = nil }
        do {
            try await service.removeDevice(sessionId: session.id)
            sessions.removeAll { $0.id == session.id }
            let name = session.deviceName ?? "That device"
            notice = "\(name) has been signed out."
        } catch let apiError as APIError {
            error = apiError
        } catch {
            error = .unexpectedStatus(0, requestId: nil)
        }
    }
}

struct DeviceSessionsView: View {
    @Environment(AppEnvironment.self) private var environment
    @State private var model: DeviceSessionsModel?
    @State private var pendingRemoval: SessionSummary?

    var body: some View {
        Group {
            if let model {
                content(model)
            } else {
                LoadingStateView(message: "Loading devices...")
            }
        }
        .navigationTitle("Signed-in devices")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if model == nil { model = DeviceSessionsModel(service: environment.service) }
            await model?.load()
        }
        .confirmationDialog(
            pendingRemoval.map { "Sign out \($0.deviceName ?? "this device")?" } ?? "",
            isPresented: Binding(
                get: { pendingRemoval != nil },
                set: { if !$0 { pendingRemoval = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Sign out device", role: .destructive) {
                if let session = pendingRemoval { Task { await model?.remove(session) } }
                pendingRemoval = nil
            }
            Button("Cancel", role: .cancel) { pendingRemoval = nil }
        } message: {
            Text("That device will need to authenticate again. This device stays signed in.")
        }
    }

    @ViewBuilder
    private func content(_ model: DeviceSessionsModel) -> some View {
        if model.isLoading && model.sessions.isEmpty {
            LoadingStateView(message: "Loading devices...")
        } else if let error = model.error, model.sessions.isEmpty {
            ErrorStateView(error: error, retry: { await model.load() })
        } else {
            List {
                if let notice = model.notice {
                    Label(notice, systemImage: "checkmark.circle.fill")
                        .font(.footnote)
                        .foregroundStyle(.green)
                }
                if let error = model.error { ErrorSummary(error: error) }

                if model.activeSessions.isEmpty {
                    EmptyStateView(
                        title: "No active sessions",
                        message: "Signed-in devices will appear here.",
                        systemImage: "iphone.slash"
                    )
                    .listRowBackground(Color.clear)
                } else {
                    Section {
                        ForEach(model.activeSessions) { session in
                            sessionRow(session, model: model)
                        }
                    } header: {
                        Text("Active sessions")
                    } footer: {
                        Text("Remove devices you no longer use. Your current session cannot be removed here.")
                    }
                }
            }
            .refreshable { await model.load() }
        }
    }

    private func sessionRow(_ session: SessionSummary, model: DeviceSessionsModel) -> some View {
        HStack(spacing: 12) {
            Image(systemName: session.current ? "iphone.gen3.circle.fill" : "iphone.gen3")
                .font(.title2)
                .foregroundStyle(session.current ? Color.accentColor : .secondary)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(session.deviceName ?? "Unnamed device").font(.headline)
                    if session.current {
                        Text("THIS DEVICE")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.tint)
                    }
                }
                if let lastUsed = session.lastUsedAt ?? session.createdAt {
                    Text("Last used \(lastUsed.formatted(.relative(presentation: .named)))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer()

            if !session.current {
                Button(role: .destructive) { pendingRemoval = session } label: {
                    if model.removingId == session.id {
                        ProgressView()
                    } else {
                        Image(systemName: "rectangle.portrait.and.arrow.right")
                    }
                }
                .disabled(model.removingId != nil)
                .accessibilityLabel("Sign out \(session.deviceName ?? "device")")
            }
        }
    }
}
