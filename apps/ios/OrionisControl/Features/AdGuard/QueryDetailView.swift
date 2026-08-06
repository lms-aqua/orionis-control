import SwiftUI

/// Query detail, in the two contexts it is presented from.
///
/// `QueryDetailContent` holds every group, action and confirmation. The iPhone
/// sheet and the regular-width detail pane both render it, so there is one
/// implementation and two presentations rather than two copies that drift.

/// The iPhone presentation: the shared content inside its own stack.
struct QueryDetailSheet: View {
    let query: DnsQuery
    @Binding var isWatched: Bool
    let addRule: (String, RuleKind) async -> APIError?

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                QueryDetailContent(
                    query: query, isWatched: $isWatched, addRule: addRule,
                    // A successful rule change closes the sheet, as before.
                    onRuleApplied: { dismiss() }
                )
                .padding(16)
            }
            .orionisScreen()
            .navigationTitle("Query")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
    }
}

/// Everything about one query. Rendered by the sheet and by the iPad detail
/// pane, which is why it owns no navigation chrome of its own.
struct QueryDetailContent: View {
    let query: DnsQuery
    @Binding var isWatched: Bool
    let addRule: (String, RuleKind) async -> APIError?
    /// Called after a rule is accepted. The sheet dismisses; the split view
    /// keeps the query selected, because the row it came from is history and
    /// does not change retroactively.
    var onRuleApplied: () -> Void = {}

    @Environment(AppEnvironment.self) private var environment
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
        VStack(alignment: .leading, spacing: 16) {
            Group {
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
        .frame(maxWidth: .infinity, alignment: .leading)
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
            onRuleApplied()
        }
    }
}
