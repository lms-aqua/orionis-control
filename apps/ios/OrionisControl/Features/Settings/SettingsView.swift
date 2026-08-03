import SwiftUI

struct SettingsView: View {
    @Environment(AppEnvironment.self) private var environment
    @State private var showSignOutConfirmation = false
    @State private var diagnosticsReport: String?
    @State private var connectionTest: ConnectionTestResult?
    @State private var isTestingConnection = false

    private enum ConnectionTestResult {
        case success(GatewayMeta)
        case failure(APIError)
    }

    var body: some View {
        @Bindable var preferences = environment.preferences

        NavigationStack {
            Form {
                accountSection
                connectionSection
                securitySection($preferences)
                camerasSection($preferences)
                infrastructureSection
                notificationsSection
                appearanceSection($preferences)
                diagnosticsSection
                signOutSection
            }
            .navigationTitle("Settings")
            .sheet(item: Binding(
                get: { diagnosticsReport.map { DiagnosticsPayload(text: $0) } },
                set: { if $0 == nil { diagnosticsReport = nil } }
            )) { payload in
                DiagnosticsSheet(report: payload.text)
            }
            .confirmationDialog(
                "Sign out of Orionis Control?",
                isPresented: $showSignOutConfirmation,
                titleVisibility: .visible
            ) {
                Button("Sign out", role: .destructive) {
                    Task { await environment.signOutAndForget() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(
                    "Your saved session is removed from this device and this device's push registration is cancelled."
                )
            }
        }
    }

    // MARK: Sections

    @ViewBuilder
    private var accountSection: some View {
        if let user = environment.auth.state.user {
            Section("Account") {
                LabeledContent("Signed in as", value: user.name)
                if let email = user.email {
                    LabeledContent("Email", value: email)
                }
                LabeledContent("Role", value: user.role.displayName)
                if !user.groups.isEmpty {
                    LabeledContent("Groups") {
                        Text(user.groups.joined(separator: ", "))
                            .multilineTextAlignment(.trailing)
                            .font(.caption)
                    }
                }
                Button("Sign in again") {
                    Task { await environment.auth.beginSignIn() }
                }
                NavigationLink {
                    DeviceSessionsView()
                } label: {
                    LabeledContent("Signed-in devices", value: "Manage")
                }
            }
        }
    }

    @ViewBuilder
    private var connectionSection: some View {
        Section {
            LabeledContent("Gateway") {
                Text(environment.preferences.serverURLString)
                    .font(.caption)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            if let meta = environment.meta {
                LabeledContent("Server version", value: meta.serverVersion)
                LabeledContent("API version", value: meta.apiVersion)
                LabeledContent("Environment", value: meta.environment.capitalized)
            }

            Button {
                Task { await testConnection() }
            } label: {
                HStack {
                    Text("Test connection")
                    Spacer()
                    if isTestingConnection { ProgressView() }
                }
            }
            .disabled(isTestingConnection)

            switch connectionTest {
            case .success(let meta):
                Label(
                    "Connected to \(meta.product) \(meta.serverVersion)",
                    systemImage: "checkmark.circle.fill"
                )
                .font(.caption)
                .foregroundStyle(.green)
            case .failure(let error):
                ErrorSummary(error: error)
            case nil:
                EmptyView()
            }
        } header: {
            Text("Server connection")
        } footer: {
            Text("Orionis Control connects only to this address, over HTTPS.")
        }
    }

    @ViewBuilder
    private func securitySection(_ preferences: Bindable<Preferences>) -> some View {
        Section {
            Toggle(
                "Require \(environment.biometrics.availability.displayName)",
                isOn: preferences.requireBiometricUnlock
            )
            .disabled(!environment.biometrics.availability.isAvailable)

            if preferences.wrappedValue.requireBiometricUnlock {
                Picker("Lock after", selection: preferences.autoLockMinutes) {
                    Text("Immediately").tag(0)
                    Text("1 minute").tag(1)
                    Text("5 minutes").tag(5)
                    Text("15 minutes").tag(15)
                    Text("1 hour").tag(60)
                }
            }

            Toggle(
                "Confirm privileged actions",
                isOn: preferences.requireBiometricForAdminActions
            )
            .disabled(!environment.biometrics.availability.isAvailable)

            Toggle("Hide previews in the app switcher", isOn: preferences.hidePreviewsInAppSwitcher)
        } header: {
            Text("Security")
        } footer: {
            if environment.biometrics.availability.isAvailable {
                Text(
                    "Privileged actions include pausing DNS filtering, restarting a camera and running system operations. These are always checked by the server as well."
                )
            } else {
                Text(
                    "Biometric options are unavailable because this device has no passcode or enrolled biometrics."
                )
            }
        }
    }

    @ViewBuilder
    private func camerasSection(_ preferences: Bindable<Preferences>) -> some View {
        Section("Cameras") {
            Picker("Default quality", selection: preferences.defaultStreamQuality) {
                ForEach(StreamQuality.allCases) { quality in
                    Text(quality.displayName).tag(quality)
                }
            }
            Picker("Grid size", selection: preferences.gridColumns) {
                Text("Large").tag(1)
                Text("Medium").tag(2)
                Text("Compact").tag(3)
            }
            Toggle("Start live view automatically", isOn: preferences.autoplayLiveView)
            Toggle("Start muted", isOn: preferences.startMuted)
            Toggle("Reduce quality on cellular", isOn: preferences.limitQualityOnCellular)

            if environment.auth.state.user?.can(.recordingsView) == true {
                NavigationLink {
                    RecordingStorageView()
                } label: {
                    LabeledContent("Recordings", value: "Storage and retention")
                }
            }
        }
    }

    /// Administrator-only, and gated on the same role the gateway enforces.
    @ViewBuilder
    private var infrastructureSection: some View {
        if environment.auth.state.user?.role == .administrator {
            Section {
                NavigationLink {
                    InfrastructureView()
                } label: {
                    LabeledContent("Caddy and Authelia", value: "Manage")
                }
            } header: {
                Text("Infrastructure")
            } footer: {
                Text("Affects every site on the server and everyone's ability to sign in.")
            }
        }
    }

    @ViewBuilder
    private var notificationsSection: some View {
        Section {
            NavigationLink("Notification preferences") { NotificationSettingsView() }
        } header: {
            Text("Notifications")
        } footer: {
            if environment.meta?.capabilities.push == false {
                Text(
                    "Push notifications are not configured on this gateway, so nothing will be delivered yet. Your preferences are still saved."
                )
            }
        }
    }

    @ViewBuilder
    private func appearanceSection(_ preferences: Bindable<Preferences>) -> some View {
        Section("Appearance") {
            Picker("Theme", selection: preferences.appearance) {
                ForEach(AppearanceSetting.allCases) { setting in
                    Text(setting.displayName).tag(setting)
                }
            }
            .pickerStyle(.segmented)
        }
    }

    @ViewBuilder
    private var diagnosticsSection: some View {
        Section {
            LabeledContent(
                "Version",
                value: "\(environment.configuration.version) (\(environment.configuration.build))")
            LabeledContent("Build", value: environment.configuration.environment.displayName)
            Button("Export diagnostic report") {
                diagnosticsReport = DiagnosticsReport.build(environment: environment)
            }
        } header: {
            Text("Diagnostics")
        } footer: {
            Text(
                "The report contains no tokens, passwords, cookies or personal information. You can read it before sharing it."
            )
        }
    }

    @ViewBuilder
    private var signOutSection: some View {
        Section {
            Button("Sign out", role: .destructive) { showSignOutConfirmation = true }
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

struct NotificationSettingsView: View {
    @Environment(AppEnvironment.self) private var environment
    @State private var preferences = NotificationPreferences.default
    @State private var availableKinds: [String] = []
    @State private var pushConfigured = false
    @State private var isLoading = true
    @State private var isSaving = false
    @State private var error: APIError?
    @State private var savedPreferences = NotificationPreferences.default
    @State private var saveConfirmation: String?

    var body: some View {
        Form {
            if let error { Section { ErrorSummary(error: error) } }

            if let saveConfirmation {
                Section {
                    Label(saveConfirmation, systemImage: "checkmark.circle.fill")
                        .font(.footnote)
                        .foregroundStyle(.green)
                }
            }

            if !pushConfigured && !isLoading {
                Section {
                    Label(
                        "Push notifications are not configured on this gateway. Preferences are saved but nothing will be delivered.",
                        systemImage: "bell.slash"
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }
            }

            Section {
                Toggle("Enable notifications", isOn: $preferences.enabled)
                Picker("Minimum severity", selection: $preferences.minimumSeverity) {
                    ForEach(EventSeverity.allCases, id: \.self) { severity in
                        Text(severity.displayName).tag(severity)
                    }
                }
            }

            Section("Quiet hours") {
                Toggle("Enabled", isOn: $preferences.quietHours.enabled)
                if preferences.quietHours.enabled {
                    Stepper(
                        "From \(minuteLabel(preferences.quietHours.startMinute))",
                        value: $preferences.quietHours.startMinute, in: 0...1439, step: 30)
                    Stepper(
                        "Until \(minuteLabel(preferences.quietHours.endMinute))",
                        value: $preferences.quietHours.endMinute, in: 0...1439, step: 30)
                    Toggle(
                        "Allow critical alerts through",
                        isOn: $preferences.criticalBypassesQuietHours)
                }
            }

            if !availableKinds.isEmpty {
                Section("Alert types") {
                    ForEach(availableKinds, id: \.self) { kind in
                        Toggle(
                            kindLabel(kind),
                            isOn: Binding(
                                get: { preferences.kinds[kind] ?? true },
                                set: { preferences.kinds[kind] = $0 }
                            ))
                    }
                }
            }
        }
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { Task { await save() } }
                    .disabled(isLoading || isSaving || preferences == savedPreferences)
            }
        }
        .task { await load() }
        .onChange(of: preferences) { _, updated in
            if updated != savedPreferences { saveConfirmation = nil }
        }
        .overlay {
            if isLoading {
                LoadingStateView()
            } else if isSaving {
                ProgressView("Saving…")
                    .padding()
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
            }
        }
    }

    private func minuteLabel(_ minute: Int) -> String {
        String(format: "%02d:%02d", minute / 60, minute % 60)
    }

    private func kindLabel(_ raw: String) -> String {
        raw.replacingOccurrences(of: ".", with: " ").capitalized
    }

    private func load() async {
        defer { isLoading = false }
        do {
            let response = try await environment.service.notificationPreferences()
            preferences = response.preferences
            savedPreferences = response.preferences
            availableKinds = response.availableKinds
            pushConfigured = response.pushConfigured
            error = nil
        } catch let apiError as APIError {
            error = apiError
        } catch {
            self.error = .unexpectedStatus(0, requestId: nil)
        }
    }

    private func save() async {
        guard preferences != savedPreferences, !isSaving else { return }
        isSaving = true
        error = nil
        saveConfirmation = nil
        defer { isSaving = false }
        do {
            try await environment.service.updateNotificationPreferences(preferences)
            savedPreferences = preferences
            saveConfirmation = "Notification preferences saved."
        } catch let apiError as APIError {
            error = apiError
        } catch {
            error = .unexpectedStatus(0, requestId: nil)
        }
    }
}
