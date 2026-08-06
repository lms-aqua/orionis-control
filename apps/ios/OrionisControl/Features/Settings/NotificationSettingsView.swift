import SwiftUI

/// Notification preferences, served by the gateway rather than stored locally.
///
/// Split out of the old single Settings `Form` and restyled onto the Command
/// Deck surfaces; the load/save behaviour is unchanged, including the "saved,
/// but you have newer changes" case.
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
        SettingsScreen(title: "Notifications") {
            if let error {
                SettingsGroup { ErrorSummary(error: error).padding(14) }
            }

            if let saveConfirmation {
                SettingsGroup {
                    SettingsNoteRow(
                        text: saveConfirmation,
                        systemImage: "checkmark.circle.fill",
                        tint: Theme.good)
                }
            }

            if !pushConfigured && !isLoading {
                SettingsGroup {
                    SettingsNoteRow(
                        text:
                            "Push notifications are not configured on this gateway. Preferences are saved but nothing will be delivered.",
                        systemImage: "bell.slash",
                        tint: Theme.warn)
                }
            }

            SectionLabel("Delivery")
            SettingsGroup {
                SettingsToggleRow(title: "Enable notifications", isOn: $preferences.enabled)
                SettingsDivider()
                SettingsMenuRow(
                    title: "Minimum severity", selection: $preferences.minimumSeverity
                ) {
                    ForEach(EventSeverity.allCases, id: \.self) { severity in
                        Text(severity.displayName).tag(severity)
                    }
                }
            }

            SectionLabel("Quiet hours")
            SettingsGroup {
                SettingsToggleRow(title: "Enabled", isOn: $preferences.quietHours.enabled)

                if preferences.quietHours.enabled {
                    SettingsDivider()
                    stepperRow(
                        "From \(minuteLabel(preferences.quietHours.startMinute))",
                        value: $preferences.quietHours.startMinute)
                    SettingsDivider()
                    stepperRow(
                        "Until \(minuteLabel(preferences.quietHours.endMinute))",
                        value: $preferences.quietHours.endMinute)
                    SettingsDivider()
                    SettingsToggleRow(
                        title: "Allow critical alerts through",
                        isOn: $preferences.criticalBypassesQuietHours)
                }
            }

            if !availableKinds.isEmpty {
                SectionLabel("Alert types")
                SettingsGroup {
                    ForEach(Array(availableKinds.enumerated()), id: \.element) { index, kind in
                        if index > 0 { SettingsDivider() }
                        SettingsToggleRow(
                            title: kindLabel(kind),
                            isOn: Binding(
                                get: { preferences.kinds[kind] ?? true },
                                set: { preferences.kinds[kind] = $0 }
                            ))
                    }
                }
            }
        }
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

    private func stepperRow(_ title: String, value: Binding<Int>) -> some View {
        Stepper(value: value, in: 0...1439, step: 30) {
            SettingsRowLabel(title: title)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
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
        let submitted = preferences
        isSaving = true
        error = nil
        saveConfirmation = nil
        defer { isSaving = false }
        do {
            try await environment.service.updateNotificationPreferences(submitted)
            // The controls remain editable while the request is in flight. Mark
            // only the exact payload the server accepted as saved, so a newer
            // local edit does not silently lose its dirty state.
            savedPreferences = submitted
            saveConfirmation =
                preferences == submitted
                ? "Notification preferences saved."
                : "Saved. You have newer changes that still need saving."
        } catch let apiError as APIError {
            error = apiError
        } catch {
            self.error = .unexpectedStatus(0, requestId: nil)
        }
    }
}
