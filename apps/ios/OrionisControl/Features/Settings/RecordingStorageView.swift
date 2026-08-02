import SwiftUI

/// Storage and retention for recorded footage.
///
/// Two things this screen is careful about. It reports what *recordings* occupy
/// against their budget, not what the server's disk is doing — the disk is shared
/// with everything else on the host, so its free space says nothing about how much
/// room footage has. And a retention change is applied outside the gateway, so a
/// queued change is shown as queued rather than as done.
@MainActor
@Observable
final class RecordingStorageModel {
    private(set) var storage: StorageStatus?
    private(set) var retention: RetentionSettings?
    private(set) var isLoading = false
    private(set) var error: APIError?
    private(set) var isSaving = false
    private(set) var savedMessage: String?

    private let service: any EventServicing

    init(service: any EventServicing) {
        self.service = service
    }

    func load() async {
        if storage == nil { isLoading = true }
        defer { isLoading = false }
        do {
            // Retention is secondary: a deployment that cannot report it should
            // still show storage rather than failing the whole screen.
            storage = try await service.recordingStorage()
            retention = try? await service.retention()
            error = nil
        } catch let apiError as APIError {
            error = apiError
        } catch {
            error = .unexpectedStatus(0, requestId: nil)
        }
    }

    func setRetention(days: Int) async {
        isSaving = true
        savedMessage = nil
        defer { isSaving = false }
        do {
            let updated = try await service.setRetention(days: days)
            retention = updated
            savedMessage =
                updated.pending
                ? "Queued. The recorder applies it within a few minutes."
                : "Retention is now \(days) days."
        } catch let apiError as APIError {
            error = apiError
        } catch {
            error = .unexpectedStatus(0, requestId: nil)
        }
    }
}

struct RecordingStorageView: View {
    @Environment(AppEnvironment.self) private var environment
    @State private var model: RecordingStorageModel?
    @State private var pendingDays: Int?
    @State private var confirming = false

    /// Options a person actually wants, rather than a free-text number of days.
    private let choices = [1, 3, 7, 14, 30, 60, 90, 180, 365]

    var body: some View {
        Form {
            if let model {
                if let storage = model.storage {
                    usageSection(storage)
                    if let cameras = storage.perCamera, !cameras.isEmpty {
                        perCameraSection(cameras)
                    }
                }
                retentionSection(model)
                if let error = model.error {
                    Section {
                        Label(error.message, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                }
            } else {
                Section { LoadingStateView(message: "Loading storage…") }
            }
        }
        .navigationTitle("Recordings")
        .task {
            if model == nil { model = RecordingStorageModel(service: environment.service) }
            await model?.load()
        }
        .refreshable { await model?.load() }
        .confirmationDialog(
            "Change retention?",
            isPresented: $confirming,
            titleVisibility: .visible
        ) {
            if let days = pendingDays {
                Button(confirmLabel(days), role: shortens(days) ? .destructive : nil) {
                    Task { await save(days) }
                }
            }
            Button("Cancel", role: .cancel) { pendingDays = nil }
        } message: {
            Text(confirmMessage())
        }
    }

    // MARK: Usage

    @ViewBuilder
    private func usageSection(_ storage: StorageStatus) -> some View {
        Section("Space used") {
            VStack(alignment: .leading, spacing: 10) {
                if let fraction = storage.usedFraction {
                    ProgressView(value: fraction)
                        .tint(fraction > 0.9 ? .red : fraction > 0.75 ? .orange : .accentColor)
                }
                HStack(alignment: .firstTextBaseline) {
                    Text((storage.recordingsUsed ?? 0).formattedBytes)
                        .font(.title2.weight(.semibold))
                    if let capacity = storage.recordingsCapacity {
                        Text(storage.isBudgeted ? "of \(capacity.formattedBytes) budget" : "of \(capacity.formattedBytes)")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .padding(.vertical, 4)

            if let daily = storage.dailyBytes, daily > 0 {
                LabeledContent("Recording", value: "\(daily.formattedBytes) a day")
            }
            if let days = storage.daysRemaining {
                LabeledContent(
                    "Room left",
                    value: days <= 1 ? "under a day" : "about \(days) days")
            }
            if let count = storage.fileCount {
                LabeledContent("Segments", value: "\(count)")
            }
            if let oldest = storage.oldestRecordingAt {
                LabeledContent(
                    "Oldest footage",
                    value: oldest.formatted(date: .abbreviated, time: .shortened))
            }
        }
    }

    @ViewBuilder
    private func perCameraSection(_ cameras: [CameraStorageUsage]) -> some View {
        Section("By camera") {
            ForEach(cameras) { camera in
                LabeledContent(camera.displayName) {
                    VStack(alignment: .trailing, spacing: 1) {
                        Text(camera.bytes.formattedBytes)
                            .monospacedDigit()
                        Text("\(camera.fileCount) segments")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    // MARK: Retention

    @ViewBuilder
    private func retentionSection(_ model: RecordingStorageModel) -> some View {
        Section {
            if let retention = model.retention {
                LabeledContent("Keeping footage for") {
                    Text(retention.appliedDays.map { "\($0) days" } ?? "unknown")
                        .foregroundStyle(.secondary)
                }

                // A queued change has not happened yet. Saying so beats implying
                // the recorder already agreed.
                if retention.pending, let requested = retention.requestedDays {
                    Label(
                        "Changing to \(requested) days — waiting for the recorder to apply it.",
                        systemImage: "clock.arrow.circlepath"
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }

                if canChange(retention) {
                    Picker("Change to", selection: retentionBinding(retention)) {
                        ForEach(choices.filter { $0 >= retention.minDays && $0 <= retention.maxDays }, id: \.self) { days in
                            Text("\(days) days").tag(days)
                        }
                    }
                    .disabled(model.isSaving)
                } else if !retention.changeable {
                    Text("Retention is set on the server and cannot be changed from here.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else {
                    Text("Changing retention needs administrator access.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                if let saved = model.savedMessage {
                    Label(saved, systemImage: "checkmark.circle.fill")
                        .font(.footnote)
                        .foregroundStyle(.green)
                }
            } else {
                Text("Retention could not be read.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Retention")
        } footer: {
            Text(
                "Footage older than this is deleted automatically. Shortening it deletes existing footage sooner."
            )
        }
    }

    private func retentionBinding(_ retention: RetentionSettings) -> Binding<Int> {
        Binding(
            get: { pendingDays ?? retention.requestedDays ?? retention.appliedDays ?? retention.minDays },
            set: { days in
                guard days != (retention.requestedDays ?? retention.appliedDays) else { return }
                pendingDays = days
                confirming = true
            }
        )
    }

    private func canChange(_ retention: RetentionSettings) -> Bool {
        retention.changeable && (environment.auth.state.user?.can(.recordingsDelete) ?? false)
    }

    /// Shortening retention destroys footage that exists today; lengthening does not.
    private func shortens(_ days: Int) -> Bool {
        guard let applied = model?.retention?.appliedDays else { return false }
        return days < applied
    }

    private func confirmLabel(_ days: Int) -> String {
        shortens(days) ? "Delete footage older than \(days) days" : "Keep footage for \(days) days"
    }

    private func confirmMessage() -> String {
        guard let days = pendingDays else { return "" }
        if shortens(days) {
            let applied = model?.retention?.appliedDays
            return
                "Footage older than \(days) days will be deleted"
                + (applied.map { ", including everything between \(days) and \($0) days old" } ?? "")
                + ". This cannot be undone."
        }
        return "Footage will be kept for \(days) days. Existing footage is unaffected."
    }

    private func save(_ days: Int) async {
        // Local biometric confirmation on top of the server's own role check, for
        // an action that destroys footage.
        if shortens(days), environment.preferences.requireBiometricForAdminActions {
            let outcome = await environment.biometrics.authenticate(
                reason: "Confirm shortening how long footage is kept.")
            guard outcome == .success else {
                pendingDays = nil
                return
            }
        }
        await model?.setRetention(days: days)
        pendingDays = nil
    }
}
