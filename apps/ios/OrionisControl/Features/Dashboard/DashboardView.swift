import SwiftUI

/// Home. An operational summary, not a landing page.
///
/// Every section degrades on its own: a failing upstream produces an inline
/// explanation in that card while the rest of the screen stays useful.
@MainActor
@Observable
final class DashboardViewModel {
    enum LoadState {
        case idle
        case loading
        case loaded(DashboardSnapshot)
        case failed(APIError)
    }

    private(set) var state: LoadState = .idle
    private(set) var lastLoadedAt: Date?
    private(set) var cached: DashboardSnapshot?

    private let service: any SystemServicing
    private var loadGeneration = 0

    init(service: any SystemServicing) {
        self.service = service
    }

    var snapshot: DashboardSnapshot? {
        if case .loaded(let snapshot) = state { return snapshot }
        return cached
    }

    var isStale: Bool {
        if case .failed = state { return cached != nil }
        return false
    }

    func load(showSpinner: Bool = true) async {
        loadGeneration &+= 1
        let generation = loadGeneration
        if showSpinner, cached == nil { state = .loading }
        do {
            let snapshot = try await service.dashboard()
            guard generation == loadGeneration else { return }
            cached = snapshot
            lastLoadedAt = Date()
            state = .loaded(snapshot)
        } catch let error as APIError {
            guard generation == loadGeneration else { return }
            state = .failed(error)
        } catch {
            guard generation == loadGeneration else { return }
            state = .failed(.unexpectedStatus(0, requestId: nil))
        }
    }
}

struct DashboardView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(DeepLinkRouter.self) private var router
    @State private var model: DashboardViewModel?

    var body: some View {
        NavigationStack {
            Group {
                if let model {
                    content(model)
                } else {
                    LoadingStateView(message: "Preparing…")
                }
            }
            .navigationTitle("Home")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    if let lastLoadedAt = model?.lastLoadedAt {
                        Text(lastLoadedAt.formatted(date: .omitted, time: .shortened))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .accessibilityLabel(
                                "Last refreshed \(lastLoadedAt.formatted(date: .omitted, time: .shortened))"
                            )
                    }
                }
            }
        }
        .task {
            if model == nil {
                model = DashboardViewModel(service: environment.service)
            }
            await model?.load()
        }
    }

    @ViewBuilder
    private func content(_ model: DashboardViewModel) -> some View {
        switch model.state {
        case .idle, .loading:
            LoadingStateView(message: "Loading your system…")

        case .failed(let error) where model.snapshot == nil:
            ErrorStateView(
                error: error,
                retry: { await model.load() },
                signIn: { Task { await environment.auth.signOut(reason: .sessionExpired) } }
            )

        case .loaded, .failed:
            ScrollView {
                LazyVStack(spacing: 16) {
                    if case .failed(let error) = model.state, let lastLoadedAt = model.lastLoadedAt {
                        StaleDataBanner(
                            asOf: lastLoadedAt,
                            reason: "\(error.title). \(error.message)")
                    }

                    if let snapshot = model.snapshot {
                        camerasCard(snapshot)
                        protectionCard(snapshot)
                        eventsCard(snapshot)
                        storageCard(snapshot)
                        servicesCard(snapshot)
                    }
                }
                .padding(16)
            }
            .refreshable { await model.load(showSpinner: false) }
        }
    }

    // MARK: Cards

    @ViewBuilder
    private func camerasCard(_ snapshot: DashboardSnapshot) -> some View {
        DashboardCard(title: "Cameras", systemImage: "video.fill") {
            if let counts = snapshot.cameras.data {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 110), spacing: 12)], spacing: 12) {
                    MetricTile(
                        title: "Online", value: "\(counts.online)",
                        caption: counts.total > 0 ? "of \(counts.total)" : nil,
                        systemImage: "checkmark.circle.fill", tint: .green)
                    MetricTile(
                        title: "Offline", value: "\(counts.offline)",
                        systemImage: "video.slash.fill",
                        tint: counts.offline > 0 ? .red : .secondary)
                    MetricTile(
                        title: "Recording", value: "\(counts.recording)",
                        systemImage: "record.circle", tint: .red)
                }
                Button("View all cameras") { router.selectedTab = .cameras }
                    .font(.subheadline)
                    .padding(.top, 4)
            } else {
                SectionUnavailable(section: snapshot.cameras.apiError, feature: "Cameras")
            }
        }
    }

    @ViewBuilder
    private func protectionCard(_ snapshot: DashboardSnapshot) -> some View {
        DashboardCard(title: "Network filtering", systemImage: "shield.lefthalf.filled") {
            if let status = snapshot.adguard.status.data {
                if !status.protectionEnabled {
                    ProtectionPausedBanner(status: status)
                }
                if let stats = snapshot.adguard.stats.data {
                    LazyVGrid(
                        columns: [GridItem(.adaptive(minimum: 110), spacing: 12)], spacing: 12
                    ) {
                        MetricTile(
                            title: "Queries today", value: stats.totalQueries.formattedCount,
                            systemImage: "arrow.left.arrow.right")
                        MetricTile(
                            title: "Blocked", value: stats.blockedQueries.formattedCount,
                            caption: String(format: "%.1f%%", stats.blockedPercent),
                            systemImage: "hand.raised.fill", tint: .orange)
                        MetricTile(
                            title: "Avg response",
                            value: String(format: "%.0f ms", stats.averageProcessingMs),
                            systemImage: "timer")
                    }
                } else {
                    SectionUnavailable(
                        section: snapshot.adguard.stats.apiError, feature: "Statistics")
                }
                Button("Open network") { router.selectedTab = .adGuard }
                    .font(.subheadline)
                    .padding(.top, 4)
            } else {
                SectionUnavailable(
                    section: snapshot.adguard.status.apiError, feature: "Network filtering")
            }
        }
    }

    @ViewBuilder
    private func eventsCard(_ snapshot: DashboardSnapshot) -> some View {
        DashboardCard(title: "Recent events", systemImage: "bell.fill") {
            if let events = snapshot.events.data {
                if events.items.isEmpty {
                    Text("No events recorded recently.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    if events.unacknowledged > 0 {
                        Label(
                            "\(events.unacknowledged) unacknowledged",
                            systemImage: "exclamationmark.circle.fill"
                        )
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(.orange)
                    }
                    VStack(spacing: 0) {
                        ForEach(events.items.prefix(4)) { event in
                            EventRow(event: event, compact: true)
                            if event.id != events.items.prefix(4).last?.id { Divider() }
                        }
                    }
                    Button("View all events") { router.selectedTab = .events }
                        .font(.subheadline)
                        .padding(.top, 4)
                }
            } else {
                SectionUnavailable(section: snapshot.events.apiError, feature: "Events")
            }
        }
    }

    @ViewBuilder
    private func storageCard(_ snapshot: DashboardSnapshot) -> some View {
        DashboardCard(title: "Recording storage", systemImage: "internaldrive.fill") {
            if let storage = snapshot.storage.data {
                if let fraction = storage.usedFraction {
                    VStack(alignment: .leading, spacing: 10) {
                        ProgressView(value: fraction)
                            .tint(fraction > 0.9 ? .red : fraction > 0.75 ? .orange : .accentColor)

                        // Recordings against their budget, not the whole disk:
                        // the filesystem is shared with everything else on the
                        // host, so its free space says nothing about how much
                        // room recordings actually have.
                        HStack(alignment: .firstTextBaseline) {
                            Text((storage.recordingsUsed ?? 0).formattedBytes)
                                .font(.title3.weight(.semibold))
                            if let capacity = storage.recordingsCapacity {
                                Text("of \(capacity.formattedBytes)")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text("\(Int((fraction * 100).rounded()))%")
                                .font(.subheadline.monospacedDigit())
                                .foregroundStyle(.secondary)
                        }

                        // Facts worth showing only when the gateway measured them.
                        VStack(alignment: .leading, spacing: 3) {
                            if let daily = storage.dailyBytes, daily > 0 {
                                storageDetail(
                                    "Recording about \(daily.formattedBytes) a day")
                            }
                            if let days = storage.daysRemaining {
                                storageDetail(
                                    days <= 1
                                        ? "Under a day of room left at that rate"
                                        : "About \(days) days of room left at that rate")
                            }
                            if let retention = storage.retentionDays {
                                storageDetail(
                                    "Footage is kept for \(retention) day\(retention == 1 ? "" : "s")")
                            }
                            if let oldest = storage.oldestRecordingAt {
                                storageDetail(
                                    "Oldest footage \(oldest.formatted(date: .abbreviated, time: .shortened))")
                            }
                        }

                        if let cameras = storage.perCamera, !cameras.isEmpty {
                            Divider()
                            ForEach(cameras) { camera in
                                HStack {
                                    Text(camera.displayName)
                                        .font(.caption)
                                        .lineLimit(1)
                                    Spacer()
                                    Text(camera.bytes.formattedBytes)
                                        .font(.caption.monospacedDigit())
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }

                        if fraction > 0.9 {
                            Label(
                                storage.isBudgeted
                                    ? "The recording budget is nearly full. The oldest footage will be removed to stay inside it."
                                    : "Storage is nearly full. Older recordings will be removed sooner than the retention setting suggests.",
                                systemImage: "exclamationmark.triangle.fill"
                            )
                            .font(.caption)
                            .foregroundStyle(.orange)
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(storageAccessibilityLabel(storage, fraction: fraction))
                } else {
                    Text("The gateway did not report how much space recordings are using.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            } else {
                SectionUnavailable(section: snapshot.storage.apiError, feature: "Storage")
            }
        }
    }

    private func storageDetail(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.secondary)
    }

    private func storageAccessibilityLabel(_ storage: StorageStatus, fraction: Double) -> String {
        var parts = ["Recordings using \(Int((fraction * 100).rounded())) percent of available space"]
        if let used = storage.recordingsUsed, let capacity = storage.recordingsCapacity {
            parts.append("\(used.formattedBytes) of \(capacity.formattedBytes)")
        }
        if let days = storage.daysRemaining { parts.append("about \(days) days of room left") }
        return parts.joined(separator: ", ")
    }

    @ViewBuilder
    private func servicesCard(_ snapshot: DashboardSnapshot) -> some View {
        DashboardCard(title: "Services", systemImage: "server.rack") {
            if let counts = snapshot.services.data {
                HStack(spacing: 16) {
                    ServiceCountPill(
                        count: counts.healthy, label: "Healthy", status: .healthy)
                    if counts.degraded > 0 {
                        ServiceCountPill(
                            count: counts.degraded, label: "Warning", status: .warning)
                    }
                    if counts.failing > 0 {
                        ServiceCountPill(
                            count: counts.failing, label: "Failing", status: .critical)
                    }
                    if counts.unknown > 0 {
                        ServiceCountPill(
                            count: counts.unknown, label: "Unknown", status: .unknown)
                    }
                }
                Button("Open system") { router.selectedTab = .system }
                    .font(.subheadline)
                    .padding(.top, 4)
            } else {
                SectionUnavailable(section: snapshot.services.apiError, feature: "Service health")
            }
        }
    }
}

// MARK: - Building blocks

struct DashboardCard<Content: View>: View {
    let title: String
    let systemImage: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(title, systemImage: systemImage)
                .font(.headline)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 16))
    }
}

/// Explains why one card has no data, without turning the whole screen into an
/// error.
struct SectionUnavailable: View {
    let section: APIError?
    let feature: String

    var body: some View {
        let error = section
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: error?.isNotConfigured == true ? "cable.connector.slash" : "exclamationmark.triangle.fill")
                .foregroundStyle(error?.isNotConfigured == true ? Color.secondary : Color.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text(error?.title ?? "\(feature) unavailable")
                    .font(.subheadline.weight(.medium))
                Text(error?.message ?? "The gateway did not return this section.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

struct ServiceCountPill: View {
    let count: Int
    let label: String
    let status: ServiceStatus

    private var tint: Color {
        switch status {
        case .healthy: .green
        case .warning: .orange
        case .critical, .offline: .red
        case .unknown: .secondary
        }
    }

    var body: some View {
        VStack(spacing: 4) {
            Image(systemName: status.symbolName)
                .foregroundStyle(tint)
            Text("\(count)")
                .font(.title3.weight(.semibold))
                .monospacedDigit()
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(count) \(label)")
    }
}

struct ProtectionPausedBanner: View {
    let status: AdGuardStatus

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("DNS filtering is paused", systemImage: "shield.slash.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.red)

            if let override = status.override {
                Text(
                    "Paused by \(override.disabledBy) \(override.disabledAt.relativeDescription)."
                )
                .font(.caption)
                if let resumeAt = override.resumeAt {
                    Text(
                        "Resumes automatically at \(resumeAt.formatted(date: .omitted, time: .shortened))."
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                if let reason = override.reason {
                    Text("Reason: \(reason)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else {
                Text("Devices on this network are not being filtered.")
                    .font(.caption)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(.red.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .combine)
    }
}
