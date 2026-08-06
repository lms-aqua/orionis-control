import Charts
import SwiftUI

@MainActor
@Observable
final class AdGuardViewModel {
    private(set) var status: AdGuardStatus?
    private(set) var stats: AdGuardStats?
    private(set) var queries: [DnsQuery] = []
    private(set) var error: APIError?
    private(set) var isLoading = false
    private(set) var lastLoadedAt: Date?
    private(set) var actionMessage: String?
    private(set) var isLoadingQueries = false
    private(set) var isLoadingMoreQueries = false
    private(set) var hasMoreQueries = false
    private(set) var queryError: APIError?

    var range: AdGuardRange = .today
    var queryFilter: QueryLogFilter = .all
    var querySearch = ""
    var queryPageSize = 250

    private let service: any AdGuardServicing
    private var loadGeneration = 0
    private var queryGeneration = 0
    private var nextQueryCursor: String?

    init(service: any AdGuardServicing) {
        self.service = service
    }

    func load(showSpinner: Bool = true) async {
        loadGeneration &+= 1
        let generation = loadGeneration
        if showSpinner && status == nil { isLoading = true }
        defer {
            if generation == loadGeneration { isLoading = false }
        }
        async let statsTask = service.adGuardStats(range: range)
        do {
            // Protection state is operationally important; a chart/statistics
            // failure must not hide whether filtering is actually enabled.
            let loadedStatus = try await service.adGuardStatus()
            let loadedStats = try? await statsTask
            guard generation == loadGeneration else { return }
            status = loadedStatus
            if let loadedStats { stats = loadedStats }
            lastLoadedAt = Date()
            error = nil
        } catch let apiError as APIError {
            guard generation == loadGeneration else { return }
            error = apiError
        } catch {
            guard generation == loadGeneration else { return }
            self.error = .unexpectedStatus(0, requestId: nil)
        }
    }

    func loadQueries() async {
        queryGeneration &+= 1
        let generation = queryGeneration
        isLoadingQueries = true
        defer {
            if generation == queryGeneration { isLoadingQueries = false }
        }
        do {
            let page = try await service.queryLog(
                search: querySearch.isEmpty ? nil : querySearch,
                status: queryFilter,
                client: nil,
                limit: queryPageSize,
                olderThan: nil
            )
            guard generation == queryGeneration else { return }
            var seen = Set<String>()
            queries = page.items.filter { seen.insert($0.id).inserted }
            nextQueryCursor = page.page.nextCursor
            hasMoreQueries = page.page.hasMore && nextQueryCursor != nil
            queryError = nil
        } catch let apiError as APIError {
            guard generation == queryGeneration else { return }
            queryError = apiError
        } catch {
            guard generation == queryGeneration else { return }
            queryError = .unexpectedStatus(0, requestId: nil)
        }
    }

    func loadOlderQueries() async {
        guard let cursor = nextQueryCursor, hasMoreQueries, !isLoadingMoreQueries else { return }
        queryGeneration &+= 1
        let generation = queryGeneration
        isLoadingMoreQueries = true
        defer {
            if generation == queryGeneration { isLoadingMoreQueries = false }
        }
        do {
            let page = try await service.queryLog(
                search: querySearch.isEmpty ? nil : querySearch,
                status: queryFilter,
                client: nil,
                limit: queryPageSize,
                olderThan: cursor
            )
            guard generation == queryGeneration else { return }
            var seen = Set(queries.map(\.id))
            queries.append(contentsOf: page.items.filter { seen.insert($0.id).inserted })
            nextQueryCursor = page.page.nextCursor
            hasMoreQueries = page.page.hasMore && nextQueryCursor != nil
            queryError = nil
        } catch let apiError as APIError {
            guard generation == queryGeneration else { return }
            queryError = apiError
        } catch {
            guard generation == queryGeneration else { return }
            queryError = .unexpectedStatus(0, requestId: nil)
        }
    }

    func setProtection(enabled: Bool, durationSeconds: Int?, reason: String?) async -> APIError? {
        loadGeneration &+= 1
        isLoading = false
        do {
            status = try await service.setProtection(
                ProtectionChangeRequest(
                    enabled: enabled,
                    durationSeconds: durationSeconds,
                    until: nil,
                    reason: reason))
            actionMessage =
                enabled
                ? "Protection is on." : "Protection is paused."
            return nil
        } catch let apiError as APIError {
            return apiError
        } catch {
            return .unexpectedStatus(0, requestId: nil)
        }
    }

    func addRule(_ domain: String, kind: RuleKind) async -> Result<String, APIError> {
        do {
            let result = try await service.addRule(domain, kind: kind)
            return .success(result.rule)
        } catch let error as APIError {
            return .failure(error)
        } catch {
            return .failure(.unexpectedStatus(0, requestId: nil))
        }
    }
}

struct AdGuardView: View {
    @Environment(AppEnvironment.self) private var environment
    @State private var model: AdGuardViewModel?
    @State private var showProtectionSheet = false

    var body: some View {
        NavigationStack {
            Group {
                if let model { content(model) } else { LoadingStateView() }
            }
            .navigationTitle("Network")
            .sheet(isPresented: $showProtectionSheet) {
                if let model, let status = model.status {
                    ProtectionSheet(status: status) { enabled, duration, reason in
                        await model.setProtection(
                            enabled: enabled, durationSeconds: duration, reason: reason)
                    }
                }
            }
        }
        .task {
            if model == nil { model = AdGuardViewModel(service: environment.service) }
            await model?.load()
        }
    }

    @ViewBuilder
    private func content(_ model: AdGuardViewModel) -> some View {
        @Bindable var model = model

        if model.isLoading {
            LoadingStateView(message: "Loading network status…")
        } else if let error = model.error, model.status == nil {
            if error.isNotConfigured {
                NotConfiguredView(feature: "Network filtering", detail: error.message)
            } else {
                ErrorStateView(error: error, retry: { await model.load() })
            }
        } else if let status = model.status {
            ScrollView {
                VStack(spacing: 16) {
                    protectionCard(status, model: model)
                    if let stats = model.stats {
                        rangePicker(model)
                        statsCard(stats)
                        chartCard(stats)
                        topListsCard(stats)
                    }
                    NavigationLink {
                        QueryLogView(model: model)
                    } label: {
                        Label("Query log", systemImage: "list.bullet.rectangle")
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(16)
                            .background(
                                .background.secondary, in: RoundedRectangle(cornerRadius: 16))
                    }
                    .buttonStyle(.plain)
                }
                .padding(16)
            }
            .refreshable { await model.load(showSpinner: false) }
        }
    }

    private func protectionCard(_ status: AdGuardStatus, model: AdGuardViewModel) -> some View {
        DashboardCard(
            title: "Protection",
            systemImage: status.protectionEnabled ? "shield.fill" : "shield.slash.fill"
        ) {
            if status.protectionEnabled {
                StatusBadge(status: .healthy, label: "Filtering active")
            } else {
                ProtectionPausedBanner(status: status)
            }

            if let version = status.version {
                Text("AdGuard Home \(version)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if environment.auth.state.user?.can(.adguardProtectionPause) == true {
                Button(status.protectionEnabled ? "Pause protection" : "Resume protection") {
                    showProtectionSheet = true
                }
                .buttonStyle(.bordered)
                .tint(status.protectionEnabled ? .orange : .green)
            } else {
                Text("Your role cannot change protection.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func rangePicker(_ model: AdGuardViewModel) -> some View {
        @Bindable var model = model
        return Picker("Range", selection: $model.range) {
            ForEach(AdGuardRange.allCases) { range in
                Text(range.displayName).tag(range)
            }
        }
        .pickerStyle(.segmented)
        .onChange(of: model.range) { _, _ in Task { await model.load(showSpinner: false) } }
    }

    private func statsCard(_ stats: AdGuardStats) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 110), spacing: 12)], spacing: 12) {
            MetricTile(
                title: "Queries", value: stats.totalQueries.formattedCount,
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
    }

    @ViewBuilder
    private func chartCard(_ stats: AdGuardStats) -> some View {
        if stats.series.count > 1 {
            DashboardCard(title: "Query volume", systemImage: "chart.bar.fill") {
                Chart {
                    ForEach(stats.series) { point in
                        BarMark(
                            x: .value("Time", point.at),
                            y: .value("Allowed", max(0, point.queries - point.blocked))
                        )
                        .foregroundStyle(by: .value("Result", "Allowed"))

                        BarMark(
                            x: .value("Time", point.at),
                            y: .value("Blocked", point.blocked)
                        )
                        .foregroundStyle(by: .value("Result", "Blocked"))
                    }
                }
                .chartForegroundStyleScale(["Allowed": Color.accentColor, "Blocked": Color.orange])
                .chartLegend(position: .bottom)
                .frame(height: 180)
                .accessibilityLabel(
                    "Query volume chart. \(stats.totalQueries) queries, \(stats.blockedQueries) blocked."
                )
            }
        }
    }

    private func topListsCard(_ stats: AdGuardStats) -> some View {
        DashboardCard(title: "Top activity", systemImage: "list.number") {
            topList("Most blocked", stats.topBlockedDomains)
            if !stats.topClients.isEmpty {
                Divider().padding(.vertical, 4)
                topList("Busiest clients", stats.topClients)
            }
        }
    }

    @ViewBuilder
    private func topList(_ title: String, _ items: [NameCount]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.subheadline.weight(.medium))
            if items.isEmpty {
                Text("Nothing recorded in this period.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(items.prefix(5)) { item in
                    HStack {
                        Text(item.name).font(.caption).lineLimit(1)
                        Spacer()
                        Text(item.count.formattedCount)
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Protection sheet

/// Pausing protection is deliberately effortful: a duration is required, a
/// reason is invited, and the confirmation states the consequence plainly.
struct ProtectionSheet: View {
    let status: AdGuardStatus
    let apply: (Bool, Int?, String?) async -> APIError?

    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss

    @State private var duration = 900
    @State private var reason = ""
    @State private var isSubmitting = false
    @State private var error: APIError?

    private let durations: [(String, Int)] = [
        ("5 minutes", 300), ("15 minutes", 900), ("30 minutes", 1800),
        ("1 hour", 3600), ("4 hours", 14400), ("8 hours", 28800),
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if status.protectionEnabled {
                        pauseFlow
                    } else {
                        resumeFlow
                    }

                    if let error {
                        WarningBanner(
                            title: error.title, message: error.message, tint: Theme.critical)
                    }
                }
                .padding(16)
            }
            .orionisScreen()
            .navigationTitle("Protection")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    // MARK: Pause

    private var pauseFlow: some View {
        VStack(alignment: .leading, spacing: 16) {
            // The consequence leads. Everything below is how long and why.
            VStack(alignment: .leading, spacing: 8) {
                Image(systemName: "shield.slash.fill")
                    .font(.system(size: 30, weight: .semibold))
                    .foregroundStyle(Theme.critical)
                Text("Pause network protection?")
                    .font(.system(size: 22, weight: .bold))
                    .foregroundStyle(Theme.textPrimary)
                Text("DNS filtering will stop for every device on this network.")
                    .font(.subheadline)
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 4)

            SectionLabel("Pause for")
            // A wrapping grid rather than a Picker: every option is visible, so
            // the shortest safe duration is as easy to choose as the longest.
            LazyVGrid(
                columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 3), spacing: 8
            ) {
                ForEach(durations, id: \.1) { label, seconds in
                    Button {
                        duration = seconds
                    } label: {
                        Text(label)
                            .font(.system(size: 13, weight: duration == seconds ? .semibold : .medium))
                            .foregroundStyle(duration == seconds ? .white : Theme.textSecondary)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 11)
                            .background(
                                duration == seconds ? Theme.critical : Theme.inset,
                                in: RoundedRectangle(cornerRadius: 11, style: .continuous)
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: 11, style: .continuous)
                                    .strokeBorder(
                                        duration == seconds ? .clear : Theme.hairline, lineWidth: 1)
                            )
                            .contentShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(duration == seconds ? [.isButton, .isSelected] : .isButton)
                }
            }

            SectionLabel("Reason")
            TextField("Optional — recorded in the audit log", text: $reason, axis: .vertical)
                .lineLimit(2...3)
                .font(.system(size: 15))
                .padding(12)
                .background(Theme.inset, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 11, style: .continuous)
                        .strokeBorder(Theme.hairline, lineWidth: 1))

            DestructiveActionButton(
                title: "Pause Protection", systemImage: "shield.slash.fill", isBusy: isSubmitting
            ) {
                Task { await submit(enabled: false) }
            }
            .padding(.top, 2)

            Text(
                "Filtering restores automatically when the timer ends. This action is recorded against your account."
            )
            .font(.caption)
            .foregroundStyle(Theme.textTertiary)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: Resume

    private var resumeFlow: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 8) {
                Image(systemName: "shield.lefthalf.filled.slash")
                    .font(.system(size: 30, weight: .semibold))
                    .foregroundStyle(Theme.warn)
                Text("Protection is paused")
                    .font(.system(size: 22, weight: .bold))
                    .foregroundStyle(Theme.textPrimary)
                // The scheduled resume is the single most useful fact here, so
                // it is stated prominently rather than as a footnote.
                if let override = status.override, let resumeAt = override.resumeAt {
                    Text(
                        "Resumes automatically at \(resumeAt.formatted(date: .omitted, time: .shortened))."
                    )
                    .font(.subheadline)
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 4)

            Button {
                Task { await submit(enabled: true) }
            } label: {
                HStack(spacing: 8) {
                    if isSubmitting {
                        ProgressView().tint(.white)
                    } else {
                        Image(systemName: "shield.fill").font(.system(size: 15, weight: .semibold))
                    }
                    Text("Resume Protection Now")
                        .font(.system(size: 16, weight: .semibold))
                }
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(Theme.good, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(isSubmitting)
        }
    }

    private func submit(enabled: Bool) async {
        // A local biometric confirmation on top of the server's role check.
        if environment.preferences.requireBiometricForAdminActions {
            let outcome = await environment.biometrics.authenticate(
                reason: enabled
                    ? "Confirm resuming DNS filtering."
                    : "Confirm pausing DNS filtering for the whole network.")
            guard outcome == .success else { return }
        }

        isSubmitting = true
        error = nil
        defer { isSubmitting = false }

        let failure = await apply(
            enabled,
            enabled ? nil : duration,
            reason.trimmingCharacters(in: .whitespaces).isEmpty ? nil : reason)

        if let failure {
            error = failure
        } else {
            dismiss()
        }
    }
}

// MARK: - Query detail

struct QueryDetailSheet: View {
    let query: DnsQuery
    @Binding var isWatched: Bool
    let addRule: (String, RuleKind) async -> APIError?

    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @State private var error: APIError?
    @State private var isSubmitting = false
    @State private var confirming: RuleKind?

    /// Outcome presentation, matching the activity feed exactly so a query
    /// looks the same in the list and in its detail.
    private var outcome: (label: String, tint: Color) {
        switch query.status {
        case .allowed: ("Allowed", Theme.good)
        case .blocked: ("Blocked", Theme.accent)
        case .rewritten: ("Rewritten", Theme.warn)
        case .safeSearch: ("Safe Search", Theme.good)
        case .unknown: ("Unknown", Theme.textTertiary)
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    SheetHero(
                        title: query.domain,
                        subtitle: query.clientName ?? query.client,
                        caption: query.at.formatted(date: .abbreviated, time: .standard),
                        badge: outcome.label,
                        badgeTint: outcome.tint,
                        monospacedTitle: true)

                    DetailGroup("Request") {
                        DetailValueRow(label: "Type", value: query.type, monospaced: true)
                        SettingsDivider()
                        DetailValueRow(label: "Client", value: query.clientName ?? query.client)
                        if let ms = query.processingMs {
                            SettingsDivider()
                            DetailValueRow(
                                label: "Processing", value: String(format: "%.2f ms", ms),
                                monospaced: true)
                        }
                        if let upstream = query.upstream {
                            SettingsDivider()
                            DetailValueRow(
                                label: "Upstream", value: upstream, monospaced: true)
                        }
                        if let code = query.responseCode, !code.isEmpty {
                            SettingsDivider()
                            DetailValueRow(label: "Response", value: code, monospaced: true)
                        }
                    }

                    // Only shown when AdGuard actually explained itself; an
                    // empty "Filtering" group would imply missing information.
                    if hasFilteringDetail {
                        DetailGroup("Filtering") {
                            DetailValueRow(
                                label: "Result", value: query.status.displayName,
                                tint: outcome.tint)
                            if let reason = query.reason, !reason.isEmpty {
                                SettingsDivider()
                                DetailValueRow(label: "Reason", value: reason)
                            }
                            if let rule = query.rule, !rule.isEmpty {
                                SettingsDivider()
                                DetailValueRow(
                                    label: "Matching rule", value: rule, monospaced: true)
                            }
                        }
                    }

                    if !query.answers.isEmpty {
                        DetailGroup("Answers") {
                            ForEach(Array(query.answers.enumerated()), id: \.offset) { index, answer in
                                if index > 0 { SettingsDivider() }
                                DetailValueRow(
                                    label: "Record \(index + 1)", value: answer, monospaced: true)
                            }
                        }
                    }

                    DetailGroup {
                        SettingsButtonRow(
                            title: isWatched ? "Stop Watching Domain" : "Watch Domain",
                            systemImage: isWatched ? "star.slash" : "star",
                            tint: Theme.warn
                        ) { isWatched.toggle() }
                        SettingsDivider()
                        ShareLink(item: query.domain) {
                            HStack(spacing: 12) {
                                Image(systemName: "square.and.arrow.up")
                                    .font(.system(size: 14, weight: .semibold))
                                    .foregroundStyle(Theme.accent)
                                    .frame(width: 22)
                                Text("Share Domain")
                                    .font(.system(size: 15, weight: .medium))
                                    .foregroundStyle(Theme.accent)
                                Spacer(minLength: 8)
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 12)
                            .contentShape(Rectangle())
                        }
                    }

                    // Network-wide changes are kept visually separate from the
                    // per-device actions above, because their blast radius is
                    // every device on the network.
                    if environment.auth.state.user?.can(.adguardRulesWrite) == true {
                        DetailGroup("Network-wide") {
                            SettingsButtonRow(
                                title: "Block This Domain",
                                subtitle: "Blocks it for every device",
                                systemImage: "hand.raised.fill",
                                tint: Theme.critical,
                                isEnabled: !isSubmitting
                            ) { confirming = .block }
                            SettingsDivider()
                            SettingsButtonRow(
                                title: "Always Allow This Domain",
                                subtitle: "Bypasses every filter list",
                                systemImage: "checkmark.shield.fill",
                                tint: Theme.good,
                                isEnabled: !isSubmitting
                            ) { confirming = .allow }
                        }
                        SettingsHint(
                            "Rule changes apply network-wide and are recorded in the audit log.")
                    }

                    if let error {
                        WarningBanner(
                            title: error.title, message: error.message, tint: Theme.critical)
                    }
                }
                .padding(16)
            }
            .orionisScreen()
            .navigationTitle("Query")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .confirmationDialog(
                confirming == .block ? "Block \(query.domain)?" : "Allow \(query.domain)?",
                isPresented: Binding(
                    get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
                titleVisibility: .visible
            ) {
                Button(confirming == .block ? "Block" : "Allow", role: confirming == .block ? .destructive : nil) {
                    if let kind = confirming { Task { await submit(kind) } }
                    confirming = nil
                }
                Button("Cancel", role: .cancel) { confirming = nil }
            } message: {
                Text(
                    confirming == .block
                        ? "Every device on this network will be blocked from resolving this domain."
                        : "This domain will bypass all filter lists for every device on this network."
                )
            }
        }
    }

    private var hasFilteringDetail: Bool {
        query.status != .allowed
            || (query.reason.map { !$0.isEmpty } ?? false)
            || (query.rule.map { !$0.isEmpty } ?? false)
    }

    private func submit(_ kind: RuleKind) async {
        isSubmitting = true
        error = nil
        defer { isSubmitting = false }
        if let failure = await addRule(query.domain, kind) {
            error = failure
        } else {
            dismiss()
        }
    }
}

struct QueryInsightsSheet: View {
    let queries: [DnsQuery]
    let applySearch: (String) -> Void

    @Environment(\.dismiss) private var dismiss

    private var insights: DnsQueryInsights { DnsQueryInsights(queries: queries) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    // The sample size leads, because every number below it is
                    // only true of the rows currently loaded.
                    SheetHero(
                        title: "\(insights.total.formatted()) queries",
                        subtitle: "Loaded activity",
                        caption: insights.blockRate.map { String(format: "%.1f%% blocked", $0) })

                    DetailGroup("Outcome mix") {
                        VStack(alignment: .leading, spacing: 12) {
                            OutcomeMixBar(segments: [
                                .init(
                                    label: "Allowed", count: insights.allowed, tint: Theme.good),
                                .init(
                                    label: "Blocked", count: insights.blocked, tint: Theme.accent),
                                .init(
                                    label: "Other", count: insights.other,
                                    tint: Theme.textTertiary),
                            ])
                        }
                        .padding(14)
                    }

                    // This disclaimer is load-bearing: these are not AdGuard's
                    // all-time statistics and must never be read as such.
                    SettingsHint(
                        "Insights describe only the query rows currently loaded on this device, not all DNS history."
                    )

                    rankedGroup("Top domains", items: insights.topDomains, tint: Theme.accent)
                    rankedGroup("Top clients", items: insights.topClients, tint: Theme.good)

                    if let average = insights.averageProcessingMs {
                        DetailGroup("Performance") {
                            DetailValueRow(
                                label: "Average processing",
                                value: String(format: "%.2f ms", average), monospaced: true)
                            if let domain = insights.slowestDomain,
                                let duration = insights.slowestProcessingMs
                            {
                                SettingsDivider()
                                Button { choose(domain) } label: {
                                    VStack(alignment: .leading, spacing: 3) {
                                        HStack {
                                            Text("Slowest query")
                                                .font(.system(size: 14))
                                                .foregroundStyle(Theme.textSecondary)
                                            Spacer(minLength: 10)
                                            Text(String(format: "%.2f ms", duration))
                                                .font(
                                                    .system(size: 13, design: .monospaced))
                                                .foregroundStyle(Theme.textPrimary)
                                        }
                                        Text(domain)
                                            .font(.system(size: 12, design: .monospaced))
                                            .foregroundStyle(Theme.textTertiary)
                                            .lineLimit(1)
                                            .truncationMode(.middle)
                                    }
                                    .padding(.horizontal, 14)
                                    .padding(.vertical, 11)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .accessibilityHint("Filters DNS activity to this domain")
                            }
                        }
                    }

                    DetailGroup {
                        ShareLink(item: insights.shareText) {
                            HStack(spacing: 12) {
                                Image(systemName: "square.and.arrow.up")
                                    .font(.system(size: 14, weight: .semibold))
                                    .foregroundStyle(Theme.accent)
                                    .frame(width: 22)
                                Text("Share Activity Summary")
                                    .font(.system(size: 15, weight: .medium))
                                    .foregroundStyle(Theme.accent)
                                Spacer(minLength: 8)
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 12)
                            .contentShape(Rectangle())
                        }
                    }
                }
                .padding(16)
            }
            .orionisScreen()
            .navigationTitle("DNS insights")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    /// A ranked list whose bars are scaled against the largest item, so the
    /// rows compare with each other rather than implying an absolute ceiling.
    @ViewBuilder
    private func rankedGroup(_ title: String, items: [NameCount], tint: Color) -> some View {
        if !items.isEmpty {
            let peak = Double(items.map(\.count).max() ?? 1)
            DetailGroup(title) {
                ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                    if index > 0 { SettingsDivider() }
                    RankedActivityRow(
                        name: item.name,
                        count: item.count,
                        fraction: peak > 0 ? Double(item.count) / peak : 0,
                        tint: tint
                    ) { choose(item.name) }
                }
            }
        }
    }

    private func choose(_ search: String) {
        applySearch(search)
        dismiss()
    }
}
