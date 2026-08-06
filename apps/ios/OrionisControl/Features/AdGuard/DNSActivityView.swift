import SwiftUI

/// DNS activity, rebuilt as a feed rather than a table of technical attributes.
///
/// The old screen was a stock `List` that gave the domain, the query type, the
/// client and the outcome roughly equal visual weight, so nothing could be
/// scanned. Here the domain leads, the outcome is a single unambiguous marker,
/// and everything else is supporting detail.
///
/// The navigation title stays "Query log" because that is what the underlying
/// AdGuard feature is called, while the screen reads as activity.
struct QueryLogView: View {
    @Bindable var model: AdGuardViewModel
    @AppStorage("adguard.watchedDomains") private var watchedDomainsRaw = "[]"
    @AppStorage("adguard.queryPageSize") private var queryPageSize = 250
    @State private var selected: DnsQuery?
    @State private var message: String?
    @State private var showInsights = false
    @Environment(\.horizontalSizeClass) private var sizeClass
    /// Measured, not assumed: Stage Manager and Slide Over change this without
    /// changing the device.
    @State private var availableWidth: CGFloat = 0

    var body: some View {
        // Regular width gets a real master/detail: inspecting a query should not
        // cover the feed you are reading it against.
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                header
                feed
            }
            .frame(maxWidth: isSplit ? masterWidth : .infinity)

            if isSplit {
                Rectangle().fill(Theme.hairline).frame(width: 1)
                detailPane
            }
        }
        .background {
            // GeometryReader rather than onGeometryChange: the latter is iOS 18
            // and this app deploys to 17.
            AppBackground()
                .overlay {
                    GeometryReader { geometry in
                        Color.clear
                            .preference(key: ActivityWidthKey.self, value: geometry.size.width)
                    }
                }
        }
        .onPreferenceChange(ActivityWidthKey.self) { width in
            availableWidth = width
        }
        .navigationTitle("Query log")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $model.querySearch, prompt: "Search domains or clients")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Picker("Queries per page", selection: $queryPageSize) {
                        Text("100 per page").tag(100)
                        Text("250 per page").tag(250)
                        Text("500 per page").tag(500)
                    }
                } label: {
                    Label("History size", systemImage: "list.number")
                }
            }
        }
        .task(id: "\(model.querySearch)|\(queryPageSize)") {
            // Debounce typing, while still reloading immediately when the view
            // first opens. Clearing search restores the full log without
            // requiring an extra keyboard submit.
            model.queryPageSize = min(500, max(100, queryPageSize))
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
        // Only the compact presentation uses a sheet; at regular width the same
        // content is already on screen in the detail pane.
        .sheet(item: sheetSelection) { query in
            QueryDetailSheet(
                query: query,
                isWatched: watchedBinding(for: query),
                addRule: applyRule)
        }
        .sheet(isPresented: $showInsights) {
            QueryInsightsSheet(queries: model.queries) { search in
                model.querySearch = search
            }
        }
    }

    // MARK: Split layout

    /// Split only when there is genuinely room for both columns. Driven by the
    /// measured width rather than the device, so Stage Manager and Slide Over
    /// collapse back to the compact feed correctly.
    private var isSplit: Bool { sizeClass == .regular && availableWidth >= 760 }

    /// Wide enough for a domain and its outcome, narrow enough to leave the
    /// detail the majority of the display.
    private var masterWidth: CGFloat { min(440, max(340, availableWidth * 0.36)) }

    /// The sheet is compact-only; binding to nil at regular width stops it
    /// presenting on top of the pane that already shows the same thing.
    private var sheetSelection: Binding<DnsQuery?> {
        Binding(
            get: { isSplit ? nil : selected },
            set: { newValue in if !isSplit { selected = newValue } })
    }

    @ViewBuilder
    private var detailPane: some View {
        Group {
            if let query = resolvedSelection {
                ScrollView {
                    QueryDetailContent(
                        query: query,
                        isWatched: watchedBinding(for: query),
                        addRule: applyRule)
                        .padding(16)
                }
            } else {
                // A deliberate resting state rather than auto-selecting a row
                // the user did not choose.
                VStack(spacing: 10) {
                    Image(systemName: "sidebar.right")
                        .font(.system(size: 30))
                        .foregroundStyle(Theme.textTertiary)
                    Text("Select a query")
                        .font(.headline)
                        .foregroundStyle(Theme.textSecondary)
                    Text(
                        "Choose an entry to inspect its request, client, response and filtering details."
                    )
                    .font(.footnote)
                    .foregroundStyle(Theme.textTertiary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 300)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(maxWidth: .infinity)
    }

    /// The selected query re-read from the current page.
    ///
    /// A refresh replaces the array, so holding the original value would show a
    /// detail for a row that is no longer in the feed. Re-resolving by id keeps
    /// the pane and the list describing the same thing, and yields nil — the
    /// empty state — once the query falls out of the loaded window.
    private var resolvedSelection: DnsQuery? {
        guard let selected else { return nil }
        return model.queries.first { $0.id == selected.id }
    }

    private func watchedBinding(for query: DnsQuery) -> Binding<Bool> {
        Binding(
            get: { WatchedDomainStore.contains(query.domain, in: watchedDomains) },
            set: { desiredValue in
                if desiredValue != WatchedDomainStore.contains(query.domain, in: watchedDomains) {
                    toggleWatched(query.domain)
                }
            })
    }

    /// Shared by both presentations so a rule added from the pane behaves
    /// exactly as one added from the sheet.
    private func applyRule(_ domain: String, _ kind: RuleKind) async -> APIError? {
        switch await model.addRule(domain, kind: kind) {
        case .success(let rule):
            message = "Added \(rule)."
            return nil
        case .failure(let error):
            return error
        }
    }

    // MARK: Header

    /// The compact control region: outcome filters, watched-domain pills, and a
    /// summary line that doubles as the way into Insights.
    private var header: some View {
        VStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(QueryLogFilter.allCases) { filter in
                        FilterChip(
                            title: filter.displayName,
                            isSelected: model.queryFilter == filter,
                            tint: tint(for: filter)
                        ) {
                            guard model.queryFilter != filter else { return }
                            model.queryFilter = filter
                            Task { await model.loadQueries() }
                        }
                    }

                    if !watchedDomains.isEmpty {
                        Divider().frame(height: 20).padding(.horizontal, 2)
                        // Watched domains were a separate Section above the feed,
                        // which pushed the activity down. As chips they act as
                        // one-tap filters instead.
                        ForEach(watchedDomains, id: \.self) { domain in
                            FilterChip(
                                title: domain, systemImage: "star.fill",
                                isSelected: model.querySearch == domain,
                                tint: Theme.warn
                            ) {
                                model.querySearch = model.querySearch == domain ? "" : domain
                            }
                            .contextMenu {
                                Button("Stop watching", role: .destructive) {
                                    toggleWatched(domain)
                                }
                            }
                        }
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
            }
            .sensoryFeedback(OrionisHaptic.filterChanged.feedback, trigger: model.queryFilter)

            if !model.queries.isEmpty {
                summaryLine
            }

            Rectangle().fill(Theme.hairline).frame(height: 1)
        }
        .background(.bar)
    }

    private var summaryLine: some View {
        HStack(spacing: 6) {
            Text("\(model.queries.count) loaded")
                .font(.system(size: 12, weight: .medium).monospacedDigit())
                .foregroundStyle(Theme.textSecondary)

            if blockedCount > 0 {
                Text("·").foregroundStyle(Theme.textTertiary)
                Text("\(blockRatePercent)% blocked")
                    .font(.system(size: 12, weight: .medium).monospacedDigit())
                    .foregroundStyle(Theme.textSecondary)
            }

            Spacer(minLength: 8)

            Button {
                showInsights = true
            } label: {
                Label("Insights", systemImage: "chart.bar.xaxis")
                    .font(.system(size: 12, weight: .semibold))
            }
            .disabled(model.queries.isEmpty)
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 9)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(model.queries.count) queries loaded, \(blockRatePercent) percent blocked")
    }

    private func tint(for filter: QueryLogFilter) -> Color {
        switch filter {
        case .all: Theme.accent
        case .blocked: Theme.accent
        case .allowed: Theme.good
        }
    }

    // MARK: Feed

    @ViewBuilder
    private var feed: some View {
        if model.isLoadingQueries && model.queries.isEmpty {
            // Skeleton rows keep the feed's geometry so nothing jumps.
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(0..<8, id: \.self) { _ in QueryRowSkeleton() }
                }
                .padding(.vertical, 6)
            }
            .scrollContentBackground(.hidden)
            .allowsHitTesting(false)
        } else if let error = model.queryError, model.queries.isEmpty {
            ErrorStateView(error: error, retry: { await model.loadQueries() })
        } else if model.queries.isEmpty {
            emptyFeed
        } else {
            ScrollView {
                LazyVStack(spacing: 0) {
                    if let message {
                        SettingsNoteRow(
                            text: message, systemImage: "checkmark.circle.fill", tint: Theme.good)
                    }
                    if let error = model.queryError {
                        WarningBanner(
                            title: "Couldn't refresh activity", message: error.message,
                            tint: Theme.warn
                        )
                        .padding(.horizontal, 14)
                        .padding(.bottom, 8)
                    }
                    if model.queryFilter == .all, blockedCount == model.queries.count {
                        WarningBanner(
                            title: "Every loaded result is blocked",
                            message:
                                "This is the most recent sample, not the all-time total.",
                            systemImage: "info.circle.fill", tint: Theme.accent
                        )
                        .padding(.horizontal, 14)
                        .padding(.bottom, 8)
                    }

                    ForEach(model.queries) { query in
                        let isSelected = isSplit && selected?.id == query.id
                        Button { selected = query } label: {
                            QueryRow(
                                query: query,
                                isWatched: WatchedDomainStore.contains(
                                    query.domain, in: watchedDomains))
                        }
                        .buttonStyle(.plain)
                        // An inset wash plus a leading accent rule, rather than
                        // inverting the row, so the outcome pill keeps its
                        // meaning while selected.
                        .background(alignment: .leading) {
                            if isSelected {
                                ZStack(alignment: .leading) {
                                    Theme.soft(Theme.accent)
                                    Rectangle().fill(Theme.accent).frame(width: 3)
                                }
                            }
                        }
                        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
                        SettingsDivider(inset: 46)
                    }

                    historyFooter
                }
            }
            .scrollContentBackground(.hidden)
            .refreshable { await model.loadQueries() }
        }
    }

    /// The end-of-feed history control. Deliberately not a list row: loading
    /// older activity is a distinct action, not another query.
    @ViewBuilder
    private var historyFooter: some View {
        if model.hasMoreQueries {
            VStack(spacing: 10) {
                Text("Older activity available")
                    .font(.footnote)
                    .foregroundStyle(Theme.textTertiary)
                Button {
                    Task { await model.loadOlderQueries() }
                } label: {
                    HStack(spacing: 7) {
                        if model.isLoadingMoreQueries {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "clock.arrow.circlepath")
                                .font(.system(size: 13, weight: .semibold))
                        }
                        Text(
                            model.isLoadingMoreQueries
                                ? "Loading…" : "Load older activity"
                        )
                        .font(.system(size: 14, weight: .semibold))
                    }
                    .foregroundStyle(Theme.accent)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 11)
                    .background(Theme.soft(Theme.accent), in: Capsule())
                }
                .buttonStyle(.plain)
                .disabled(model.isLoadingMoreQueries)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 22)
        } else {
            Text("End of loaded history")
                .font(.caption)
                .foregroundStyle(Theme.textTertiary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 22)
        }
    }

    @ViewBuilder
    private var emptyFeed: some View {
        VStack(spacing: 14) {
            EmptyStateView(
                title: model.hasMoreQueries ? "No matches yet" : "No activity",
                message: model.hasMoreQueries
                    ? "Nothing in this page matches. Older history is still available."
                    : model.querySearch.isEmpty
                        ? "The query log is empty for the selected filter."
                        : "No queries match “\(model.querySearch)”.",
                systemImage: "magnifyingglass"
            )
            if model.hasMoreQueries {
                Button {
                    Task { await model.loadOlderQueries() }
                } label: {
                    if model.isLoadingMoreQueries {
                        ProgressView()
                    } else {
                        Label("Search older activity", systemImage: "clock.arrow.circlepath")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.isLoadingMoreQueries)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: Derived

    private var watchedDomains: [String] { WatchedDomainStore.decode(watchedDomainsRaw) }
    private var blockedCount: Int { model.queries.filter { $0.status == .blocked }.count }
    private var blockRatePercent: Int {
        guard !model.queries.isEmpty else { return 0 }
        return Int((Double(blockedCount) / Double(model.queries.count) * 100).rounded())
    }

    private func toggleWatched(_ domain: String) {
        watchedDomainsRaw = WatchedDomainStore.encode(
            WatchedDomainStore.toggling(domain, in: watchedDomains))
    }
}

/// Carries the feed's measured width up so the split decision reacts to Stage
/// Manager and Slide Over, not just to the device idiom.
private struct ActivityWidthKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

// MARK: - Row

/// One DNS query, scannable in a glance.
///
/// Hierarchy is domain → outcome → client → time → technical detail. Blocking is
/// expected, successful behaviour, so it reads as a calm privacy state rather
/// than an error; only the domain is allowed to be visually loud.
struct QueryRow: View {
    let query: DnsQuery
    let isWatched: Bool

    private var presentation: (label: String, symbol: String, tint: Color) {
        switch query.status {
        case .allowed:
            ("Allowed", "checkmark.circle.fill", Theme.good)
        case .blocked:
            ("Blocked", "hand.raised.fill", Theme.accent)
        case .rewritten:
            ("Rewritten", "arrow.triangle.swap", Theme.warn)
        case .safeSearch:
            ("Safe Search", "checkmark.shield.fill", Theme.good)
        case .unknown:
            ("Unknown", "questionmark.circle.fill", Theme.textTertiary)
        }
    }

    var body: some View {
        let style = presentation
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: style.symbol)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(style.tint)
                .frame(width: 22)
                .padding(.top, 1)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(query.domain)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if isWatched {
                        Image(systemName: "star.fill")
                            .font(.system(size: 9))
                            .foregroundStyle(Theme.warn)
                            .accessibilityHidden(true)
                    }
                }

                Text(query.clientName ?? query.client)
                    .font(.system(size: 12.5))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)

                Text(technicalLine)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textTertiary)
                    .lineLimit(1)
            }

            Spacer(minLength: 6)

            VStack(alignment: .trailing, spacing: 4) {
                StatusPill(title: style.label, tint: style.tint)
                Text(query.at.formatted(date: .omitted, time: .shortened))
                    .font(.system(size: 11).monospacedDigit())
                    .foregroundStyle(Theme.textTertiary)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 11)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLine)
        .accessibilityAddTraits(.isButton)
    }

    /// Query type and, when the server explained itself, the reason.
    private var technicalLine: String {
        var parts = [query.type]
        if let rule = query.rule, !rule.isEmpty {
            parts.append(rule)
        } else if let reason = query.reason, !reason.isEmpty {
            parts.append(reason)
        }
        return parts.joined(separator: " · ")
    }

    private var accessibilityLine: String {
        var parts = [query.domain, presentation.label]
        parts.append("from \(query.clientName ?? query.client)")
        parts.append("at \(query.at.formatted(date: .omitted, time: .shortened))")
        if isWatched { parts.append("watched domain") }
        return parts.joined(separator: ", ")
    }
}

/// A feed-row-shaped placeholder, so loading does not collapse the layout.
struct QueryRowSkeleton: View {
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Circle().fill(Theme.inset).frame(width: 22, height: 22)
            VStack(alignment: .leading, spacing: 6) {
                SkeletonBlock(height: 13).frame(maxWidth: 190)
                SkeletonBlock(height: 10).frame(maxWidth: 120)
            }
            Spacer(minLength: 6)
            SkeletonBlock(height: 16, radius: 8).frame(width: 62)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }
}
