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
    private var loadGeneration = 0

    init(service: any EventServicing) {
        self.service = service
    }

    func load() async {
        guard !isSaving else { return }
        loadGeneration &+= 1
        let generation = loadGeneration
        if storage == nil { isLoading = true }
        defer {
            if generation == loadGeneration { isLoading = false }
        }
        async let retentionRequest = service.retention()
        do {
            // Retention is secondary: a deployment that cannot report it should
            // still show storage rather than failing the whole screen.
            let loadedStorage = try await service.recordingStorage()
            let loadedRetention = try? await retentionRequest
            guard generation == loadGeneration else { return }
            storage = loadedStorage
            if let loadedRetention { retention = loadedRetention }
            error = nil
        } catch let apiError as APIError {
            guard generation == loadGeneration else { return }
            error = apiError
        } catch {
            guard generation == loadGeneration else { return }
            // `self.` is load-bearing: inside an untyped catch, `error` is the
            // caught value, not this property.
            self.error = .unexpectedStatus(0, requestId: nil)
        }
    }

    func setRetention(days: Int) async {
        loadGeneration &+= 1
        isLoading = false
        isSaving = true
        savedMessage = nil
        defer { isSaving = false }
        do {
            let updated = try await service.setRetention(days: days)
            retention = updated
            error = nil
            savedMessage =
                updated.pending
                ? "Queued. The recorder applies it within a few minutes."
                : "Retention is now \(days) days."
        } catch let apiError as APIError {
            error = apiError
        } catch {
            // `self.` is load-bearing: inside an untyped catch, `error` is the
            // caught value, not this property.
            self.error = .unexpectedStatus(0, requestId: nil)
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
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                if let model {
                    if let storage = model.storage {
                        usageHero(storage)
                        metrics(storage)
                        if let cameras = storage.perCamera, !cameras.isEmpty {
                            perCameraSection(cameras)
                        }
                    }
                    retentionSection(model)
                    if let error = model.error {
                        WarningBanner(
                            title: "Couldn't read storage", message: error.message,
                            tint: Theme.warn)
                    }
                } else {
                    LoadingStateView(message: "Loading storage…")
                        .frame(minHeight: 220)
                }
            }
            .padding(16)
            .frame(maxWidth: 760)
            .frame(maxWidth: .infinity)
        }
        .orionisScreen()
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

    /// Leads with how full storage actually is.
    ///
    /// The percentage is only shown when the gateway gave a capacity to measure
    /// against — without one there is no honest fraction to draw, so the used
    /// figure stands alone rather than inventing a denominator.
    @ViewBuilder
    private func usageHero(_ storage: StorageStatus) -> some View {
        let fraction = storage.usedFraction
        let tint: Color =
            switch fraction {
            case .some(let value) where value > 0.9: Theme.critical
            case .some(let value) where value > 0.75: Theme.warn
            default: Theme.accent
            }

        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if let fraction {
                    Text("\(Int((fraction * 100).rounded()))%")
                        .font(.system(size: 34, weight: .bold).monospacedDigit())
                        .foregroundStyle(tint)
                    Text("used")
                        .font(.system(size: 15))
                        .foregroundStyle(Theme.textSecondary)
                } else {
                    Text(storage.recordingsUsed?.formattedBytes ?? "Unavailable")
                        .font(.system(size: 30, weight: .bold))
                        .foregroundStyle(Theme.textPrimary)
                }
                Spacer(minLength: 0)
            }

            if let fraction {
                // Already clamped upstream; drawn from the same clamped value so
                // a malformed gateway figure cannot overflow the track.
                GeometryReader { geometry in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Theme.inset)
                        Capsule()
                            .fill(tint)
                            .frame(width: max(3, geometry.size.width * fraction))
                    }
                }
                .frame(height: 10)
            }

            if let used = storage.recordingsUsed, let capacity = storage.recordingsCapacity {
                Text(
                    "\(used.formattedBytes) of \(capacity.formattedBytes)"
                        + (storage.isBudgeted ? " budget" : "")
                )
                .font(.system(size: 13.5))
                .foregroundStyle(Theme.textSecondary)
            }

            if let days = storage.daysRemaining {
                if days <= 2 {
                    WarningBanner(
                        title: days <= 1 ? "Storage is almost full" : "Storage is nearly full",
                        message: days <= 1
                            ? "Under a day of recording room remains."
                            : "About \(days) days of recording room remain.",
                        tint: days <= 1 ? Theme.critical : Theme.warn)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(15)
        .orionisCard()
        .accessibilityElement(children: .combine)
        .accessibilityLabel(storageAccessibilityLabel(storage))
    }

    /// Spoken form, so the bar is never the only way to read the number.
    private func storageAccessibilityLabel(_ storage: StorageStatus) -> String {
        var parts = ["Recording storage"]
        if let fraction = storage.usedFraction {
            parts.append("\(Int((fraction * 100).rounded())) percent used")
        }
        if let used = storage.recordingsUsed, let capacity = storage.recordingsCapacity {
            parts.append("\(used.formattedBytes) of \(capacity.formattedBytes)")
        } else if let used = storage.recordingsUsed {
            parts.append("\(used.formattedBytes) used")
        }
        if let days = storage.daysRemaining {
            parts.append(days <= 1 ? "under a day remaining" : "about \(days) days remaining")
        }
        return parts.joined(separator: ", ")
    }

    /// Secondary figures in one strip rather than four separate cards. Every
    /// entry is omitted when the gateway did not supply it.
    ///
    /// Assembled outside the view builder: a `@ViewBuilder` body cannot contain
    /// statements like `append`, whose `()` result is not a `View`.
    private func metricEntries(_ storage: StorageStatus) -> [MetricStrip.Metric] {
        var entries: [MetricStrip.Metric] = []
        if let daily = storage.dailyBytes, daily > 0 {
            entries.append(.init(value: daily.formattedBytes, label: "Per day"))
        }
        if let count = storage.fileCount {
            entries.append(.init(value: count.formattedCount, label: "Segments"))
        }
        if let oldest = storage.oldestRecordingAt {
            entries.append(
                .init(
                    value: oldest.formatted(date: .abbreviated, time: .omitted),
                    label: "Oldest footage"))
        }
        return entries
    }

    @ViewBuilder
    private func metrics(_ storage: StorageStatus) -> some View {
        let entries = metricEntries(storage)
        if !entries.isEmpty {
            MetricStrip(metrics: entries)
                .padding(15)
                .orionisCard()
        }
    }

    @ViewBuilder
    private func perCameraSection(_ cameras: [CameraStorageUsage]) -> some View {
        let peak = Double(cameras.map(\.bytes).max() ?? 1)
        DetailGroup("Storage by camera") {
            ForEach(Array(cameras.enumerated()), id: \.element.id) { index, camera in
                if index > 0 { SettingsDivider() }
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 10) {
                        Text(camera.displayName)
                            .font(.system(size: 14))
                            .foregroundStyle(Theme.textPrimary)
                            .lineLimit(1)
                        Spacer(minLength: 8)
                        Text(camera.bytes.formattedBytes)
                            .font(.system(size: 14, weight: .semibold).monospacedDigit())
                            .foregroundStyle(Theme.textSecondary)
                    }
                    GeometryReader { geometry in
                        Capsule()
                            .fill(Theme.accent.opacity(0.5))
                            .frame(
                                width: max(
                                    2,
                                    geometry.size.width
                                        * (peak > 0 ? Double(camera.bytes) / peak : 0)))
                    }
                    .frame(height: 3)
                    Text("\(camera.fileCount) segments")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.textTertiary)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .accessibilityElement(children: .combine)
                .accessibilityLabel(
                    "\(camera.displayName), \(camera.bytes.formattedBytes), \(camera.fileCount) segments"
                )
            }
        }
    }

    // MARK: Retention

    @ViewBuilder
    private func retentionSection(_ model: RecordingStorageModel) -> some View {
        if let retention = model.retention {
            DetailGroup("Retention") {
                DetailValueRow(
                    label: "Keeping footage for",
                    value: retention.appliedDays.map { "\($0) days" } ?? "Unknown")

                // A queued change has not happened yet. Saying so beats implying
                // the recorder already agreed.
                if retention.pending, let requested = retention.requestedDays {
                    SettingsDivider()
                    SettingsNoteRow(
                        text:
                            "Changing to \(requested) days — waiting for the recorder to apply it.",
                        systemImage: "clock.arrow.circlepath", tint: Theme.warn)
                }

                if canChange(retention) {
                    SettingsDivider()
                    SettingsMenuRow(
                        title: "Change to", selection: retentionBinding(retention)
                    ) {
                        ForEach(
                            choices.filter {
                                $0 >= retention.minDays && $0 <= retention.maxDays
                            }, id: \.self
                        ) { days in
                            Text("\(days) days").tag(days)
                        }
                    }
                    .disabled(model.isSaving)
                }

                if let saved = model.savedMessage {
                    SettingsDivider()
                    SettingsNoteRow(
                        text: saved, systemImage: "checkmark.circle.fill", tint: Theme.good)
                }
            }

            // The reason a control is absent is stated, rather than leaving an
            // unexplained gap where the picker would be.
            if !retention.changeable {
                SettingsHint("Retention is set on the server and cannot be changed from here.")
            } else if !canChange(retention) {
                SettingsHint("Changing retention needs administrator access.")
            } else {
                SettingsHint(
                    "Footage older than this is deleted automatically. Shortening it deletes existing footage sooner."
                )
            }
        } else {
            DetailGroup("Retention") {
                Text("Retention could not be read.")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textTertiary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
            }
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
