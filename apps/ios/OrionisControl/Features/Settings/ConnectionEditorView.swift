import SwiftUI

/// Add or edit a camera source.
///
/// The form is built from the provider's own field descriptions rather than
/// hard-coded per provider, so a provider added on the gateway appears here —
/// with its labels, help text and validation — without an app release.
///
/// Two rules the gateway also enforces, reflected here so the screen never
/// promises something the server will refuse:
///
///   1. A stored credential is never sent to the app. An existing secret shows
///      as "Saved" and is left alone unless something is typed over it.
///   2. The identifier is fixed at creation. Renaming is cosmetic; it cannot
///      move the cameras this source has already contributed.
struct ConnectionEditorView: View {
    let providers: [ProviderDescriptor]
    /// Nil when adding; the existing connection when editing.
    let existing: ConnectionSummary?
    let onSaved: () async -> Void

    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss

    @State private var selectedProviderId: String?
    @State private var name = ""
    @State private var values: [String: String] = [:]
    @State private var flags: [String: Bool] = [:]
    @State private var enabled = true
    @State private var isSaving = false
    @State private var error: APIError?

    private var descriptor: ProviderDescriptor? {
        providers.first { $0.id == selectedProviderId }
    }

    private var isEditing: Bool { existing != nil }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if let error {
                        SettingsGroup { ErrorSummary(error: error).padding(14) }
                    }

                    if isEditing || descriptor != nil {
                        detailsForm
                    } else {
                        providerPicker
                    }
                }
                .padding(16)
            }
            .orionisScreen()
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                if descriptor != nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(isEditing ? "Save" : "Add") { Task { await save() } }
                            .disabled(!canSave || isSaving)
                    }
                }
            }
            .overlay {
                if isSaving {
                    // Creating also probes the upstream server-side, which can
                    // take a few seconds; say so rather than looking hung.
                    ProgressView(isEditing ? "Saving…" : "Adding and checking…")
                        .padding()
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                }
            }
            .task { prime() }
        }
    }

    private var title: String {
        if isEditing { return "Edit source" }
        return descriptor == nil ? "Add a source" : (descriptor?.displayName ?? "Add a source")
    }

    // MARK: Choosing a provider

    private var providerPicker: some View {
        Group {
            SectionLabel("What are you connecting?")
            SettingsGroup {
                ForEach(Array(providers.enumerated()), id: \.element.id) { index, provider in
                    if index > 0 { SettingsDivider(inset: 56) }
                    Button {
                        select(provider)
                    } label: {
                        HStack(spacing: 12) {
                            SettingsIcon(systemImage: provider.symbolName, tint: Theme.accent)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(provider.displayName)
                                    .font(.system(size: 15, weight: .medium))
                                    .foregroundStyle(Theme.textPrimary)
                                Text(provider.summary)
                                    .font(.caption)
                                    .foregroundStyle(Theme.textSecondary)
                                    .fixedSize(horizontal: false, vertical: true)
                                Text(provider.capabilities.summaryLine)
                                    .font(.caption2)
                                    .foregroundStyle(Theme.textTertiary)
                            }
                            Spacer(minLength: 8)
                            Image(systemName: "chevron.right")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(Theme.textTertiary)
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 12)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            SettingsHint(
                "Each kind is honest about what it can do — some sources only offer live view, because that is all the manufacturer exposes."
            )
        }
    }

    // MARK: Filling it in

    @ViewBuilder
    private var detailsForm: some View {
        if let descriptor {
            SectionLabel("Name")
            SettingsGroup {
                labelledField("Name", text: $name, placeholder: descriptor.displayName)
            }
            SettingsHint(
                isEditing
                    ? "Renaming is safe: the identifier this source's cameras use (\(existing?.slug ?? "")) never changes."
                    : "Shown on the camera wall to tell this source's cameras apart."
            )

            SectionLabel("Settings")
            SettingsGroup {
                ForEach(Array(descriptor.fields.enumerated()), id: \.element.id) { index, field in
                    if index > 0 { SettingsDivider() }
                    fieldRow(field)
                }
            }

            SectionLabel("Availability")
            SettingsGroup {
                SettingsToggleRow(
                    title: "Enabled",
                    subtitle: "Disabled sources keep their settings but contribute no cameras.",
                    isOn: $enabled)
            }

            if descriptor.capabilities.interactiveAuth && !isEditing {
                SettingsHint(
                    "After adding this source you will be asked to sign in, and the service will send a verification code."
                )
            }
        }
    }

    @ViewBuilder
    private func fieldRow(_ field: ProviderField) -> some View {
        switch field.type {
        case .boolean:
            SettingsToggleRow(
                title: field.label,
                subtitle: field.help,
                isOn: Binding(
                    get: { flags[field.key] ?? false },
                    set: { flags[field.key] = $0 }
                ))
        case .secret:
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(field.label)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(Theme.textPrimary)
                    Spacer()
                    if existing?.hasSecret(field.key) == true {
                        SettingsChip(text: "Saved", tint: Theme.good)
                    }
                }
                SecureField(
                    existing?.hasSecret(field.key) == true ? "Leave blank to keep" : "Required",
                    text: binding(for: field)
                )
                .textContentType(.password)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(.system(size: 15))
                if let help = field.help {
                    Text(help)
                        .font(.caption2)
                        .foregroundStyle(Theme.textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
        default:
            VStack(alignment: .leading, spacing: 6) {
                Text(field.label)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Theme.textPrimary)
                TextField(field.placeholder ?? "", text: binding(for: field), axis: .vertical)
                    .lineLimit(1...4)
                    .keyboardType(field.type == .number ? .numberPad : .URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.system(size: 15))
                if let help = field.help {
                    Text(help)
                        .font(.caption2)
                        .foregroundStyle(Theme.textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
        }
    }

    private func labelledField(
        _ label: String, text: Binding<String>, placeholder: String
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Theme.textPrimary)
            TextField(placeholder, text: text)
                .font(.system(size: 15))
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }

    private func binding(for field: ProviderField) -> Binding<String> {
        Binding(
            get: { values[field.key] ?? "" },
            set: { values[field.key] = $0 }
        )
    }

    // MARK: State

    private func select(_ provider: ProviderDescriptor) {
        selectedProviderId = provider.id
        if name.isEmpty { name = provider.displayName }
        applyDefaults(provider)
    }

    private func applyDefaults(_ provider: ProviderDescriptor) {
        for field in provider.fields {
            guard let value = field.defaultValue else { continue }
            if field.type == .boolean {
                flags[field.key] = flags[field.key] ?? value.boolValue
            } else if (values[field.key] ?? "").isEmpty {
                values[field.key] = value.stringValue
            }
        }
    }

    /// Loads an existing connection's settings into the form. Credentials are
    /// not loaded because the gateway does not send them.
    private func prime() {
        guard let existing else { return }
        selectedProviderId = existing.provider
        name = existing.name
        enabled = existing.enabled
        for (key, value) in existing.settings {
            if case .boolean(let flag) = value {
                flags[key] = flag
            } else {
                values[key] = value.stringValue
            }
        }
    }

    private var canSave: Bool {
        guard let descriptor, !name.trimmingCharacters(in: .whitespaces).isEmpty else { return false }
        // A required credential only has to be typed when there is not already
        // one stored.
        return descriptor.fields.filter(\.required).allSatisfy { field in
            switch field.type {
            case .boolean: return true
            case .secret:
                return existing?.hasSecret(field.key) == true
                    || !(values[field.key] ?? "").trimmingCharacters(in: .whitespaces).isEmpty
            default:
                return !(values[field.key] ?? "").trimmingCharacters(in: .whitespaces).isEmpty
            }
        }
    }

    private func save() async {
        guard let descriptor else { return }
        isSaving = true
        error = nil
        defer { isSaving = false }

        var settings: [String: SettingValue] = [:]
        var secrets: [String: String] = [:]
        for field in descriptor.fields {
            switch field.type {
            case .secret:
                let typed = values[field.key] ?? ""
                // Only send what was typed: an untouched field must not blank
                // the credential the server already holds.
                if !typed.isEmpty { secrets[field.key] = typed }
            case .boolean:
                settings[field.key] = .boolean(flags[field.key] ?? false)
            case .number:
                let raw = values[field.key] ?? ""
                if let number = Double(raw) { settings[field.key] = .number(number) }
            default:
                let raw = (values[field.key] ?? "").trimmingCharacters(in: .whitespaces)
                if !raw.isEmpty { settings[field.key] = .string(raw) }
            }
        }

        do {
            if let existing {
                _ = try await environment.service.updateConnection(
                    id: existing.id,
                    ConnectionUpdateRequest(
                        name: name.trimmingCharacters(in: .whitespaces),
                        settings: settings,
                        secrets: secrets.isEmpty ? nil : secrets,
                        enabled: enabled
                    ))
            } else {
                _ = try await environment.service.createConnection(
                    ConnectionCreateRequest(
                        provider: descriptor.id,
                        name: name.trimmingCharacters(in: .whitespaces),
                        settings: settings,
                        secrets: secrets,
                        enabled: enabled
                    ))
            }
            await onSaved()
            dismiss()
        } catch let apiError as APIError {
            error = apiError
        } catch {
            self.error = .unexpectedStatus(0, requestId: nil)
        }
    }
}
