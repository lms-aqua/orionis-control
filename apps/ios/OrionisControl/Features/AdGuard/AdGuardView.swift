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
                limit: 100,
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
                limit: 100,
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
            Form {
                if status.protectionEnabled {
                    Section {
                        Picker("Pause for", selection: $duration) {
                            ForEach(durations, id: \.1) { label, seconds in
                                Text(label).tag(seconds)
                            }
                        }
                        TextField("Reason (optional)", text: $reason, axis: .vertical)
                            .lineLimit(2...3)
                    } header: {
                        Text("Pause DNS filtering")
                    } footer: {
                        Text(
                            "Every device on this network will resolve DNS unfiltered until protection resumes. Filtering restores automatically when the timer ends. This action is recorded against your account."
                        )
                    }

                    Section {
                        Button(role: .destructive) {
                            Task { await submit(enabled: false) }
                        } label: {
                            if isSubmitting {
                                ProgressView()
                            } else {
                                Text("Pause protection")
                            }
                        }
                        .disabled(isSubmitting)
                    }
                } else {
                    Section {
                        Button {
                            Task { await submit(enabled: true) }
                        } label: {
                            if isSubmitting {
                                ProgressView()
                            } else {
                                Text("Resume protection now")
                            }
                        }
                        .disabled(isSubmitting)
                    } header: {
                        Text("Protection is paused")
                    } footer: {
                        if let override = status.override, let resumeAt = override.resumeAt {
                            Text(
                                "Scheduled to resume at \(resumeAt.formatted(date: .omitted, time: .shortened))."
                            )
                        }
                    }
                }

                if let error {
                    Section { ErrorSummary(error: error) }
                }
            }
            .navigationTitle("Protection")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
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

// MARK: - Query log

struct QueryLogView: View {
    @Bindable var model: AdGuardViewModel
    @Environment(AppEnvironment.self) private var environment
    @State private var selected: DnsQuery?
    @State private var message: String?

    var body: some View {
        List {
            if let message {
                Section { Text(message).font(.footnote).foregroundStyle(.secondary) }
            }
            if let error = model.queryError {
                Section { ErrorSummary(error: error) }
            }
            if !model.queries.isEmpty {
                Section {
                    Text("Latest \(model.queries.count) loaded results")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    HStack {
                        Label("\(allowedCount) allowed", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                        Spacer()
                        Label("\(blockedCount) blocked", systemImage: "hand.raised.circle.fill")
                            .foregroundStyle(.red)
                        if otherCount > 0 {
                            Spacer()
                            Label("\(otherCount) other", systemImage: "questionmark.circle.fill")
                                .foregroundStyle(.secondary)
                        }
                    }
                    .font(.subheadline.weight(.medium))
                    if model.queryFilter == .all && blockedCount == model.queries.count {
                        Label(
                            "Every loaded result is blocked. This is a recent sample, not the all-time total.",
                            systemImage: "info.circle"
                        )
                        .font(.caption)
                        .foregroundStyle(.orange)
                    }
                }
            }
            if model.isLoadingQueries && model.queries.isEmpty {
                Section { ProgressView("Loading query activity...") }
            } else if model.queries.isEmpty && model.queryError == nil {
                Section {
                    EmptyStateView(
                        title: "No queries",
                        message: model.querySearch.isEmpty
                            ? "The query log is empty for the selected filter."
                            : "No queries match “\(model.querySearch)”.",
                        systemImage: "magnifyingglass"
                    )
                }
            } else {
                ForEach(model.queries) { query in
                    Button { selected = query } label: { QueryRow(query: query) }
                        .buttonStyle(.plain)
                }
                if model.hasMoreQueries {
                    Button {
                        Task { await model.loadOlderQueries() }
                    } label: {
                        HStack {
                            Spacer()
                            if model.isLoadingMoreQueries {
                                ProgressView()
                            } else {
                                Label("Load 100 older queries", systemImage: "clock.arrow.circlepath")
                            }
                            Spacer()
                        }
                    }
                    .disabled(model.isLoadingMoreQueries)
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle("Query log")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $model.querySearch, prompt: "Search domain or client")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Picker("Filter", selection: $model.queryFilter) {
                    ForEach(QueryLogFilter.allCases) { filter in
                        Text(filter.displayName).tag(filter)
                    }
                }
                .onChange(of: model.queryFilter) { _, _ in Task { await model.loadQueries() } }
            }
        }
        .refreshable { await model.loadQueries() }
        .task(id: model.querySearch) {
            // Debounce typing, while still reloading immediately when the view
            // first opens. Clearing search now restores the full log without
            // requiring an extra keyboard submit.
            if !model.querySearch.isEmpty {
                do {
                    try await Task.sleep(for: .milliseconds(300))
                } catch {
                    return
                }
            }
            guard !Task.isCancelled else { return }
            await model.loadQueries()
        }
        .sheet(item: $selected) { query in
            QueryDetailSheet(query: query) { domain, kind in
                let result = await model.addRule(domain, kind: kind)
                switch result {
                case .success(let rule):
                    message = "Added \(rule)."
                    return nil
                case .failure(let error):
                    return error
                }
            }
        }
    }

    private var blockedCount: Int { model.queries.filter { $0.status == .blocked }.count }
    private var allowedCount: Int { model.queries.filter { $0.status == .allowed }.count }
    private var otherCount: Int { model.queries.count - blockedCount - allowedCount }
}

struct QueryRow: View {
    let query: DnsQuery

    private var presentation: (label: String, symbol: String, tint: Color) {
        switch query.status {
        case .allowed:
            ("ALLOWED", "checkmark.circle.fill", .green)
        case .blocked:
            ("BLOCKED", "hand.raised.fill", .red)
        case .rewritten:
            ("REWRITTEN", "arrow.triangle.swap", .blue)
        case .safeSearch:
            ("SAFE SEARCH", "checkmark.shield.fill", .indigo)
        case .unknown:
            ("UNKNOWN", "questionmark.circle.fill", .secondary)
        }
    }

    var body: some View {
        let style = presentation
        HStack(spacing: 10) {
            Image(systemName: style.symbol)
            .font(.caption)
            .foregroundStyle(style.tint)
            .frame(width: 20)

            VStack(alignment: .leading, spacing: 2) {
                Text(query.domain)
                    .font(.subheadline)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(
                    "\(query.clientName ?? query.client) · \(query.at.formatted(date: .omitted, time: .standard))"
                )
                .font(.caption2)
                .foregroundStyle(.secondary)
            }

            Spacer(minLength: 0)

            VStack(alignment: .trailing, spacing: 3) {
                Text(style.label)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(style.tint)
                Text(query.type)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(query.domain), \(query.status.displayName), from \(query.clientName ?? query.client)"
        )
    }
}

struct QueryDetailSheet: View {
    let query: DnsQuery
    let addRule: (String, RuleKind) async -> APIError?

    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @State private var error: APIError?
    @State private var isSubmitting = false
    @State private var confirming: RuleKind?

    var body: some View {
        NavigationStack {
            Form {
                Section("Query") {
                    LabeledContent("Domain") {
                        Text(query.domain).textSelection(.enabled)
                    }
                    LabeledContent("Client", value: query.clientName ?? query.client)
                    LabeledContent("Type", value: query.type)
                    LabeledContent("Result", value: query.status.displayName)
                    if let reason = query.reason, !reason.isEmpty {
                        LabeledContent("AdGuard reason", value: reason)
                    }
                    LabeledContent(
                        "Time", value: query.at.formatted(date: .abbreviated, time: .standard))
                    if let ms = query.processingMs {
                        LabeledContent("Processing", value: String(format: "%.2f ms", ms))
                    }
                    if let upstream = query.upstream {
                        LabeledContent("Upstream", value: upstream)
                    }
                }

                if let rule = query.rule {
                    Section("Matching rule") {
                        Text(rule).font(.caption.monospaced()).textSelection(.enabled)
                    }
                }

                Section {
                    ShareLink(item: query.domain) {
                        Label("Share domain", systemImage: "square.and.arrow.up")
                    }
                }

                if environment.auth.state.user?.can(.adguardRulesWrite) == true {
                    Section {
                        Button("Block this domain", role: .destructive) { confirming = .block }
                        Button("Always allow this domain") { confirming = .allow }
                    } footer: {
                        Text("Rule changes apply network-wide and are recorded in the audit log.")
                    }
                    .disabled(isSubmitting)
                }

                if let error { Section { ErrorSummary(error: error) } }
            }
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
