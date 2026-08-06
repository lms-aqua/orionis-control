import SwiftUI

/// The focused screens behind each Settings category.
///
/// Each one owns a single area, so a person who taps "Cameras & Streaming" sees
/// only camera controls. Every control here came from the previous single-`Form`
/// Settings screen; the wording of the explanatory footers is unchanged.

// MARK: - Account

struct AccountSettingsView: View {
    @Environment(AppEnvironment.self) private var environment

    var body: some View {
        SettingsScreen(title: "Account") {
            if let user = environment.auth.state.user {
                SectionLabel("Signed in")
                SettingsGroup {
                    SettingsValueRow(title: "Name", value: user.name)
                    if let email = user.email {
                        SettingsDivider()
                        SettingsValueRow(title: "Email", value: email)
                    }
                    SettingsDivider()
                    SettingsValueRow(title: "Role", value: user.role.displayName)
                    if !user.groups.isEmpty {
                        SettingsDivider()
                        SettingsValueRow(
                            title: "Groups", value: user.groups.joined(separator: ", "))
                    }
                }

                SectionLabel("Session")
                SettingsGroup {
                    SettingsNavRow(
                        title: "Signed-in devices",
                        subtitle: "Review and revoke this account's devices",
                        value: "Manage"
                    ) { DeviceSessionsView() }

                    SettingsDivider()

                    SettingsButtonRow(
                        title: "Sign in again",
                        subtitle: "Refresh your session without signing out",
                        systemImage: "arrow.clockwise"
                    ) {
                        Task { await environment.auth.beginSignIn() }
                    }
                }
            } else {
                SettingsHint("You are not signed in.")
            }
        }
    }
}

// MARK: - Security & Privacy

struct SecuritySettingsView: View {
    @Environment(AppEnvironment.self) private var environment

    var body: some View {
        @Bindable var preferences = environment.preferences
        let biometrics = environment.biometrics.availability

        SettingsScreen(title: "Security & Privacy") {
            SectionLabel("Unlocking")
            SettingsGroup {
                SettingsToggleRow(
                    title: "Require \(biometrics.displayName)",
                    isOn: $preferences.requireBiometricUnlock,
                    isEnabled: biometrics.isAvailable)

                if preferences.requireBiometricUnlock {
                    SettingsDivider()
                    SettingsMenuRow(
                        title: "Lock after",
                        selection: $preferences.autoLockMinutes
                    ) {
                        Text("Immediately").tag(0)
                        Text("1 minute").tag(1)
                        Text("5 minutes").tag(5)
                        Text("15 minutes").tag(15)
                        Text("1 hour").tag(60)
                    }
                }

                SettingsDivider()

                SettingsToggleRow(
                    title: "Confirm privileged actions",
                    isOn: $preferences.requireBiometricForAdminActions,
                    isEnabled: biometrics.isAvailable)
            }

            if biometrics.isAvailable {
                SettingsHint(
                    "Privileged actions include pausing DNS filtering, restarting a camera and running system operations. These are always checked by the server as well."
                )
            } else {
                SettingsHint(
                    "Biometric options are unavailable because this device has no passcode or enrolled biometrics."
                )
            }

            SectionLabel("Privacy")
            SettingsGroup {
                SettingsToggleRow(
                    title: "Hide previews in the app switcher",
                    subtitle: "Covers live video when you leave the app",
                    isOn: $preferences.hidePreviewsInAppSwitcher)
            }
        }
    }
}

// MARK: - Cameras & Streaming

struct CameraSettingsView: View {
    @Environment(AppEnvironment.self) private var environment

    var body: some View {
        @Bindable var preferences = environment.preferences

        SettingsScreen(title: "Cameras & Streaming") {
            SectionLabel("Live view")
            SettingsGroup {
                SettingsMenuRow(
                    title: "Default quality",
                    selection: $preferences.defaultStreamQuality
                ) {
                    ForEach(StreamQuality.allCases) { quality in
                        Text(quality.displayName).tag(quality)
                    }
                }

                SettingsDivider()

                SettingsSegmentRow(title: "Grid size", selection: $preferences.gridColumns) {
                    Text("Large").tag(1)
                    Text("Medium").tag(2)
                    Text("Compact").tag(3)
                }

                SettingsDivider()

                SettingsToggleRow(
                    title: "Start live view automatically",
                    isOn: $preferences.autoplayLiveView)

                SettingsDivider()

                SettingsToggleRow(title: "Start muted", isOn: $preferences.startMuted)

                SettingsDivider()

                SettingsToggleRow(
                    title: "Reduce quality on cellular",
                    subtitle: "Saves data on 5G and LTE",
                    isOn: $preferences.limitQualityOnCellular)
            }

            if environment.auth.state.user?.can(.recordingsView) == true {
                SectionLabel("Storage")
                SettingsGroup {
                    SettingsNavRow(
                        title: "Recordings",
                        subtitle: "Storage and retention",
                        systemImage: "externaldrive.fill",
                        tint: Theme.accent
                    ) { RecordingStorageView() }
                }
            }
        }
    }
}

// MARK: - Appearance

struct AppearanceSettingsView: View {
    @Environment(AppEnvironment.self) private var environment

    var body: some View {
        @Bindable var preferences = environment.preferences

        SettingsScreen(title: "Appearance") {
            SectionLabel("Theme")
            SettingsGroup {
                SettingsSegmentRow(title: "Theme", selection: $preferences.appearance) {
                    ForEach(AppearanceSetting.allCases) { setting in
                        Text(setting.displayName).tag(setting)
                    }
                }
            }
            SettingsHint("Orionis Control is designed for dark; light follows the same palette.")
        }
    }
}

// MARK: - Server & Connection

struct ServerConnectionView: View {
    @Environment(AppEnvironment.self) private var environment
    @State private var connectionTest: ConnectionTestResult?
    @State private var isTestingConnection = false

    private enum ConnectionTestResult {
        case success(GatewayMeta)
        case failure(APIError)
    }

    var body: some View {
        SettingsScreen(title: "Server & Connection") {
            SectionLabel("Gateway")
            SettingsGroup {
                SettingsValueRow(
                    title: "Address",
                    value: environment.preferences.serverURLString,
                    monospaced: true,
                    truncatesInMiddle: true)

                if let meta = environment.meta {
                    SettingsDivider()
                    SettingsValueRow(title: "Server version", value: meta.serverVersion)
                    SettingsDivider()
                    SettingsValueRow(title: "API version", value: meta.apiVersion)
                    SettingsDivider()
                    SettingsValueRow(
                        title: "Environment", value: meta.environment.capitalized)
                }
            }
            SettingsHint("Orionis Control connects only to this address, over HTTPS.")

            SectionLabel("Reachability")
            SettingsGroup {
                SettingsButtonRow(
                    title: "Test connection",
                    systemImage: "antenna.radiowaves.left.and.right",
                    isBusy: isTestingConnection
                ) {
                    Task { await testConnection() }
                }

                switch connectionTest {
                case .success(let meta):
                    SettingsDivider()
                    SettingsNoteRow(
                        text: "Connected to \(meta.product) \(meta.serverVersion)",
                        systemImage: "checkmark.circle.fill",
                        tint: Theme.good)
                case .failure(let error):
                    SettingsDivider()
                    ErrorSummary(error: error)
                        .padding(14)
                case nil:
                    EmptyView()
                }
            }
        }
    }

    private func testConnection() async {
        isTestingConnection = true
        connectionTest = nil
        defer { isTestingConnection = false }
        do {
            connectionTest = .success(try await environment.service.meta())
        } catch let error as APIError {
            connectionTest = .failure(error)
        } catch {
            connectionTest = .failure(.unexpectedStatus(0, requestId: nil))
        }
    }
}

// MARK: - About & Diagnostics

struct AboutSettingsView: View {
    @Environment(AppEnvironment.self) private var environment
    @State private var diagnosticsReport: String?

    var body: some View {
        SettingsScreen(title: "About & Diagnostics") {
            SectionLabel("This app")
            SettingsGroup {
                SettingsValueRow(
                    title: "Version",
                    value: "\(environment.configuration.version) (\(environment.configuration.build))")
                SettingsDivider()
                SettingsValueRow(
                    title: "Build", value: environment.configuration.environment.displayName)
            }

            SectionLabel("Support")
            SettingsGroup {
                SettingsButtonRow(
                    title: "Export diagnostic report",
                    systemImage: "square.and.arrow.up"
                ) {
                    diagnosticsReport = DiagnosticsReport.build(environment: environment)
                }
            }
            SettingsHint(
                "The report contains no tokens, passwords, cookies or personal information. You can read it before sharing it."
            )
        }
        .sheet(
            item: Binding(
                get: { diagnosticsReport.map { DiagnosticsPayload(text: $0) } },
                set: { if $0 == nil { diagnosticsReport = nil } }
            )
        ) { payload in
            DiagnosticsSheet(report: payload.text)
        }
    }
}

private struct DiagnosticsPayload: Identifiable {
    let text: String
    var id: String { text }
}

struct DiagnosticsSheet: View {
    let report: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                Text(report)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
            }
            .orionisScreen()
            .navigationTitle("Diagnostics")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .topBarLeading) {
                    ShareLink(item: report) { Label("Share", systemImage: "square.and.arrow.up") }
                }
            }
        }
    }
}
