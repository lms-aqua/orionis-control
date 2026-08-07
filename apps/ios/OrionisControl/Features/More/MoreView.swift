import SwiftUI

/// The More hub.
///
/// This screen exists so UIKit's automatic "More" list never does. `RootTab` is
/// capped at five cases for that reason; everything past the four operational
/// surfaces (Home, Cameras, Network, System) is presented here, as a designed
/// destination rather than a system-generated table.
///
/// Nothing here invents state. The Events row reports what the gateway actually
/// says about detection capability, and the administration section appears only
/// when the signed-in user genuinely holds the permission behind it.
struct MoreView: View {
    let user: CurrentUser
    @Environment(AppEnvironment.self) private var environment
    @Environment(DeepLinkRouter.self) private var router

    var body: some View {
        @Bindable var router = router

        NavigationStack(path: $router.morePath) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    identityCard

                    SectionLabel("Activity")
                    SettingsGroup {
                        eventsRow
                    }

                    SectionLabel("App")
                    SettingsGroup {
                        SettingsNavRow(
                            title: "Settings",
                            subtitle: "Account, security, cameras, notifications & appearance",
                            systemImage: "gearshape.fill"
                        ) { SettingsView(embedsNavigationStack: false) }

                        SettingsDivider()

                        SettingsNavRow(
                            title: "Signed-in Devices",
                            subtitle: "Review and revoke sessions on your account",
                            systemImage: "person.crop.circle.fill",
                            tint: Theme.good
                        ) { DeviceSessionsView() }

                        SettingsDivider()

                        SettingsNavRow(
                            title: "Diagnostics",
                            subtitle: "Version, build and an exportable status report",
                            systemImage: "stethoscope",
                            tint: Theme.warn
                        ) { AboutSettingsView() }
                    }

                    if showsAdministration {
                        SectionLabel("Administration")
                        SettingsGroup {
                            if user.can(.infraView) {
                                SettingsNavRow(
                                    title: "Infrastructure",
                                    subtitle: "Hosts, containers and privileged configuration",
                                    systemImage: "cube.transparent.fill",
                                    tint: Theme.critical,
                                    chip: "Admin"
                                ) { InfrastructureView() }
                            }
                        }
                        SettingsHint(
                            "Administrative operations are re-checked by the gateway and recorded in the audit log."
                        )
                    }

                    versionFooter
                }
                .padding(16)
                // Keeps the hub a readable column instead of a few rows
                // stranded across a full iPad width.
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
            }
            .orionisScreen()
            .navigationTitle("More")
            .navigationDestination(for: MoreRoute.self) { route in
                destination(for: route)
            }
        }
    }

    // MARK: Identity

    private var identityCard: some View {
        HStack(spacing: 13) {
            Text(initials)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Theme.accent)
                .frame(width: 46, height: 46)
                .background(
                    Theme.soft(Theme.accent),
                    in: RoundedRectangle(cornerRadius: 13, style: .continuous))

            VStack(alignment: .leading, spacing: 3) {
                Text(user.name)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                Text(user.role.displayName)
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary)
            }

            Spacer(minLength: 8)

            // Connection state is derived from whether the gateway handshake
            // succeeded, not guessed from a timer.
            VStack(alignment: .trailing, spacing: 4) {
                HStack(spacing: 5) {
                    StatusDot(color: environment.meta == nil ? Theme.warn : Theme.good)
                    Text(environment.meta == nil ? "Offline" : "Connected")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Theme.textSecondary)
                }
                if let product = environment.meta?.product {
                    Text(product)
                        .font(.system(size: 10.5))
                        .foregroundStyle(Theme.textTertiary)
                        .lineLimit(1)
                }
            }
        }
        .padding(14)
        .orionisCard()
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "Signed in as \(user.name), \(user.role.displayName). "
                + (environment.meta == nil ? "Gateway offline." : "Gateway connected."))
    }

    private var initials: String {
        let parts = user.name.split(separator: " ").prefix(2)
        let letters = parts.compactMap { $0.first }.map(String.init).joined()
        return letters.isEmpty ? "?" : letters.uppercased()
    }

    // MARK: Rows

    /// Events carries an honest secondary line: if the gateway reports that it
    /// has no detection capability, the row says so instead of implying an
    /// empty-but-working feed.
    @ViewBuilder
    private var eventsRow: some View {
        if user.can(.eventsView) {
            let detectionOff = environment.meta?.capabilities.eventDetection == false
            SettingsNavRow(
                title: "Events & Activity",
                subtitle: detectionOff
                    ? "Detection unavailable on this server"
                    : "Camera detections and recent activity",
                systemImage: "bell.badge.fill",
                tint: detectionOff ? Theme.textTertiary : Theme.accent,
                statusColor: detectionOff ? Theme.warn : nil
            ) { EventsView(embedsNavigationStack: false) }
        } else {
            // Honest unavailable state rather than a row that dead-ends.
            HStack(spacing: 12) {
                SettingsIcon(systemImage: "bell.slash.fill", tint: Theme.textTertiary)
                SettingsRowLabel(
                    title: "Events & Activity",
                    subtitle: "Your account does not have permission to view events")
                Spacer(minLength: 8)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .opacity(0.6)
        }
    }

    private var showsAdministration: Bool {
        user.can(.infraView)
    }

    private var versionFooter: some View {
        Text("Orionis Control \(environment.configuration.version) (\(environment.configuration.build))")
            .font(.caption2)
            .foregroundStyle(Theme.textTertiary)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.top, 4)
    }

    /// Deep-link targets. `RootView` pushes these onto `router.morePath`.
    @ViewBuilder
    private func destination(for route: MoreRoute) -> some View {
        switch route {
        case .events: EventsView(embedsNavigationStack: false)
        case .settings: SettingsView(embedsNavigationStack: false)
        case .account: DeviceSessionsView()
        case .diagnostics, .about: AboutSettingsView()
        case .infrastructure: InfrastructureView()
        }
    }
}
