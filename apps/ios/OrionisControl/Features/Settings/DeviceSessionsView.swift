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
    private var loadGeneration = 0
    private var removedSessionIds = Set<String>()

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
        loadGeneration &+= 1
        let generation = loadGeneration
        if sessions.isEmpty { isLoading = true }
        defer {
            if generation == loadGeneration { isLoading = false }
        }
        do {
            let loadedSessions = try await service.devices()
            guard generation == loadGeneration else { return }
            sessions = loadedSessions.filter { !removedSessionIds.contains($0.id) }
            error = nil
        } catch let apiError as APIError {
            guard generation == loadGeneration else { return }
            error = apiError
        } catch {
            guard generation == loadGeneration else { return }
            self.error = .unexpectedStatus(0, requestId: nil)
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
            removedSessionIds.insert(session.id)
            sessions.removeAll { $0.id == session.id }
            let name = session.deviceName ?? "That device"
            notice = "\(name) has been signed out."
        } catch let apiError as APIError {
            error = apiError
        } catch {
            self.error = .unexpectedStatus(0, requestId: nil)
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
        .orionisScreen()
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
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if let notice = model.notice {
                        SettingsNoteRow(
                            text: notice, systemImage: "checkmark.circle.fill", tint: Theme.good
                        )
                        .orionisCard()
                    }
                    // The list survives a failed refresh, so mark it stale
                    // rather than presenting old sessions as current.
                    if let error = model.error, !model.sessions.isEmpty {
                        StaleDataBanner(
                            asOf: Date(),
                            title: "Couldn't refresh devices",
                            reason: error.message,
                            retry: { await model.load() })
                    }

                    if model.activeSessions.isEmpty {
                        EmptyStateView(
                            title: "No active sessions",
                            message: "Signed-in devices will appear here.",
                            systemImage: "iphone.slash")
                    } else {
                        DetailGroup("Active sessions") {
                            ForEach(Array(model.activeSessions.enumerated()), id: \.element.id) {
                                index, session in
                                if index > 0 { SettingsDivider(inset: 46) }
                                sessionRow(session, model: model)
                            }
                        }
                        SettingsHint(
                            "Remove devices you no longer use. Your current session cannot be removed here."
                        )
                    }
                }
                .padding(16)
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
            }
            .scrollContentBackground(.hidden)
            .refreshable { await model.load() }
        }
    }

    /// One session. The device you are holding is marked unmistakably, because
    /// signing the wrong one out is the mistake this screen has to prevent.
    private func sessionRow(_ session: SessionSummary, model: DeviceSessionsModel) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: session.current ? "iphone.gen3.circle.fill" : "iphone.gen3")
                .font(.system(size: 19))
                .foregroundStyle(session.current ? Theme.accent : Theme.textTertiary)
                .frame(width: 26)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 4) {
                Text(session.deviceName ?? "Unnamed device")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)

                if session.current {
                    StatusPill(
                        title: "Current device", systemImage: "checkmark.circle.fill",
                        tint: Theme.accent)
                }

                if let lastUsed = session.lastUsedAt ?? session.createdAt {
                    Text("Last active \(lastUsed.formatted(.relative(presentation: .named)))")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textSecondary)
                }
                if let created = session.createdAt, session.lastUsedAt != nil {
                    Text("Signed in \(created.formatted(date: .abbreviated, time: .omitted))")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.textTertiary)
                }
            }

            Spacer(minLength: 8)

            if !session.current {
                Button { pendingRemoval = session } label: {
                    if model.removingId == session.id {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Revoke")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Theme.critical)
                            .padding(.horizontal, 11)
                            .padding(.vertical, 6)
                            .background(Theme.soft(Theme.critical), in: Capsule())
                    }
                }
                .buttonStyle(.plain)
                .disabled(model.removingId != nil)
                .accessibilityLabel("Revoke \(session.deviceName ?? "device")")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLine(session))
    }

    private func accessibilityLine(_ session: SessionSummary) -> String {
        var parts = [session.deviceName ?? "Unnamed device"]
        if session.current { parts.append("current device") }
        if let lastUsed = session.lastUsedAt ?? session.createdAt {
            parts.append("last active \(lastUsed.formatted(.relative(presentation: .named)))")
        }
        return parts.joined(separator: ", ")
    }
}
