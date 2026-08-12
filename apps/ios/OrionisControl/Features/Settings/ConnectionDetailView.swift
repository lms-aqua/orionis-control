import SwiftUI

/// One camera source: whether it is working, what it can do, and how to fix it.
///
/// The screen leads with health because that is the question being asked when
/// someone opens it — a camera is missing from the wall, and this says whether
/// the source is reachable, when that was last checked, and what the upstream
/// said if it is not.
struct ConnectionDetailView: View {
    let connectionId: String
    let providers: [ProviderDescriptor]
    /// Whether the gateway has a host-side applier behind it.
    var canProvision = false

    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss

    @State private var connection: ConnectionSummary?
    @State private var isLoading = true
    @State private var isProbing = false
    @State private var isSigningIn = false
    @State private var isProvisioning = false
    @State private var error: APIError?
    @State private var challenge: AuthChallenge?
    @State private var signInNotice: String?
    @State private var isEditing = false
    @State private var confirmingRemoval = false
    /// Reconciled with the host, so it is fresher than the copy on the record.
    @State private var provisioning: ConnectionProvisioning?

    private var descriptor: ProviderDescriptor? {
        providers.first { $0.id == connection?.provider }
    }

    private var canManage: Bool {
        environment.auth.state.user?.can(.connectionsManage) == true
    }

    /// Whether offering to build a bridge would do anything.
    private var canOfferBridge: Bool {
        canManage && canProvision && descriptor?.bridge != nil
            && (provisioning == nil || provisioning?.state == .failed)
    }

    var body: some View {
        SettingsScreen(title: connection?.name ?? "Source") {
            if let error {
                SettingsGroup { ErrorSummary(error: error).padding(14) }
            }

            if let connection {
                healthCard(connection)
                bridgeCard
                if let notice = signInNotice {
                    SettingsGroup {
                        SettingsNoteRow(
                            text: notice, systemImage: "checkmark.circle.fill", tint: Theme.good)
                    }
                }
                capabilitiesSection
                settingsSection(connection)
                actionsSection(connection)
            } else if isLoading {
                LoadingStateView(message: "Loading source…")
            }
        }
        .toolbar {
            if canManage, connection != nil {
                ToolbarItem(placement: .primaryAction) {
                    Button("Edit") { isEditing = true }
                }
            }
        }
        .task {
            await load()
            // Picks the poll back up when the screen is opened on a bridge that
            // was still being built when it was last closed.
            await followProvisioning()
        }
        .refreshable { await load() }
        .sheet(isPresented: $isEditing) {
            if let connection {
                ConnectionEditorView(
                    providers: providers, canProvision: canProvision, existing: connection
                ) {
                    await load()
                }
            }
        }
        .sheet(item: $challenge) { challenge in
            ConnectionChallengeView(connectionId: connectionId, challenge: challenge) { message in
                signInNotice = message
                // Owned by this screen, not the sheet that is on its way out, so
                // the bridge card reports the progress and any failure lands in
                // the error summary above it.
                Task {
                    await load()
                    await maybeProvisionAfterSignIn()
                }
            }
        }
        .confirmationDialog(
            "Remove this source?",
            isPresented: $confirmingRemoval,
            titleVisibility: .visible
        ) {
            Button("Remove", role: .destructive) { Task { await remove() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                provisioning == nil
                    ? "Its cameras disappear from the app and its stored credentials are deleted. Nothing on the camera system itself is changed."
                    : "Its cameras disappear from the app, its stored credentials are deleted, and the bridge Orionis started for it is stopped. Nothing on the camera system itself is changed, and no recorded data is deleted."
            )
        }
    }

    // MARK: Sections

    @ViewBuilder
    private func healthCard(_ connection: ConnectionSummary) -> some View {
        let health = connection.health
        let colour = statusColour(connection)

        HStack(spacing: 13) {
            StatusDot(color: colour, pulsing: health?.status == .healthy && connection.enabled)
            VStack(alignment: .leading, spacing: 3) {
                Text(statusTitle(connection))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.textPrimary)
                if let message = health?.message {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let checkedAt = health?.checkedAt {
                    Text("Checked \(checkedAt.formatted(.relative(presentation: .named)))")
                        .font(.caption2)
                        .foregroundStyle(Theme.textTertiary)
                }
            }
            Spacer(minLength: 6)
            if isProbing { ProgressView() }
        }
        .padding(15)
        .orionisCard()
        .accessibilityElement(children: .combine)
    }

    /// The state of the helper service Orionis was asked to run.
    ///
    /// Deliberately its own card above capabilities rather than folded into
    /// health: "still being set up" and "the upstream did not answer" are
    /// different facts with different actions, and merging them is how a source
    /// that is working perfectly ends up with a red dot for a minute.
    @ViewBuilder
    private var bridgeCard: some View {
        if let provisioning {
            HStack(spacing: 13) {
                if provisioning.isInFlight {
                    ProgressView().controlSize(.small)
                } else {
                    Image(
                        systemName: provisioning.state == .failed
                            ? "exclamationmark.triangle.fill" : "shippingbox.fill"
                    )
                    .font(.system(size: 15))
                    .foregroundStyle(provisioning.state == .failed ? Theme.critical : Theme.good)
                    .accessibilityHidden(true)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(provisioning.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.textPrimary)
                    if let message = provisioning.message {
                        // Verbatim from the host, including the last line the
                        // container printed. That line is usually the entire
                        // diagnosis, and paraphrasing it would lose it.
                        Text(message)
                            .font(.caption)
                            .foregroundStyle(Theme.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 6)
            }
            .padding(15)
            .orionisCard()
            .accessibilityElement(children: .combine)
        }
    }

    @ViewBuilder
    private var capabilitiesSection: some View {
        if let descriptor {
            SectionLabel("What this source provides")
            SettingsGroup {
                capabilityRow("Live view", descriptor.capabilities.liveStream)
                SettingsDivider()
                capabilityRow("Snapshots", descriptor.capabilities.snapshots)
                SettingsDivider()
                capabilityRow("Events", descriptor.capabilities.events)
                SettingsDivider()
                capabilityRow("Recordings", descriptor.capabilities.recordings)
            }
            SettingsHint(descriptor.summary)
        }
    }

    private func capabilityRow(_ title: String, _ available: Bool) -> some View {
        HStack(spacing: 12) {
            Image(systemName: available ? "checkmark.circle.fill" : "minus.circle")
                .font(.system(size: 15))
                .foregroundStyle(available ? Theme.good : Theme.textTertiary)
                .accessibilityHidden(true)
            Text(title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(available ? Theme.textPrimary : Theme.textSecondary)
            Spacer()
            Text(available ? "Yes" : "No")
                .font(.footnote)
                .foregroundStyle(Theme.textTertiary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        // "Live view, Yes" reads as a fragment; spelling it out is what a
        // sighted reader gets from the tick.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title): \(available ? "supported" : "not supported")")
    }

    @ViewBuilder
    private func settingsSection(_ connection: ConnectionSummary) -> some View {
        SectionLabel("Configuration")
        SettingsGroup {
            SettingsValueRow(title: "Kind", value: descriptor?.displayName ?? connection.provider)
            SettingsDivider()
            // The prefix on every camera ID this source contributes. Shown
            // because it is what a saved favourite or a deep link is built from.
            SettingsValueRow(title: "Identifier", value: connection.slug, monospaced: true)

            if let descriptor {
                ForEach(descriptor.fields.filter { $0.type != .secret }) { field in
                    if let value = connection.settings[field.key], !value.stringValue.isEmpty {
                        SettingsDivider()
                        SettingsValueRow(
                            title: field.label,
                            value: value.stringValue,
                            monospaced: field.type == .url,
                            truncatesInMiddle: field.type == .url)
                    }
                }
                ForEach(descriptor.fields.filter { $0.type == .secret }) { field in
                    SettingsDivider()
                    SettingsValueRow(
                        title: field.label,
                        value: connection.hasSecret(field.key) ? "Saved" : "Not set")
                }
            }
        }
        SettingsHint("Stored credentials are encrypted on the gateway and never sent back to the app.")
    }

    @ViewBuilder
    private func actionsSection(_ connection: ConnectionSummary) -> some View {
        SectionLabel("Actions")
        SettingsGroup {
            SettingsButtonRow(
                title: "Check now",
                subtitle: "Ask this source whether it is reachable",
                systemImage: "arrow.clockwise",
                isBusy: isProbing
            ) {
                Task { await probe() }
            }

            if canOfferBridge, let bridge = descriptor?.bridge {
                SettingsDivider()
                SettingsButtonRow(
                    title: provisioning?.state == .failed
                        ? "Try setting up the bridge again" : "Set up its bridge",
                    subtitle: bridge.summary,
                    systemImage: "shippingbox",
                    isBusy: isProvisioning
                ) {
                    Task { await provisionBridge() }
                }
            }

            if descriptor?.capabilities.interactiveAuth == true, canManage {
                SettingsDivider()
                SettingsButtonRow(
                    title: "Sign in",
                    subtitle: "The service will send a verification code",
                    systemImage: "person.badge.key.fill",
                    isBusy: isSigningIn
                ) {
                    Task { await beginSignIn() }
                }
            }

            if canManage {
                SettingsDivider()
                SettingsButtonRow(
                    title: connection.enabled ? "Disable this source" : "Enable this source",
                    subtitle: connection.enabled
                        ? "Keeps its settings; contributes no cameras"
                        : "Its cameras return to the camera wall",
                    systemImage: connection.enabled ? "pause.circle" : "play.circle",
                    tint: Theme.warn
                ) {
                    Task { await setEnabled(!connection.enabled) }
                }

                SettingsDivider()

                SettingsButtonRow(
                    title: "Remove this source",
                    systemImage: "trash",
                    tint: Theme.critical
                ) {
                    confirmingRemoval = true
                }
            }
        }
    }

    // MARK: Status wording

    private func statusColour(_ connection: ConnectionSummary) -> Color {
        guard connection.enabled else { return Theme.textSecondary }
        switch connection.health?.status {
        case .healthy: return Theme.good
        case .degraded: return Theme.warn
        case .unreachable: return Theme.critical
        default: return Theme.textSecondary
        }
    }

    private func statusTitle(_ connection: ConnectionSummary) -> String {
        guard connection.enabled else { return "Disabled" }
        switch connection.health?.status {
        case .healthy:
            if let count = connection.health?.cameraCount {
                return "Connected · \(count) camera\(count == 1 ? "" : "s")"
            }
            return "Connected"
        case .degraded: return "Partly reachable"
        case .unreachable: return "Not reachable"
        default: return "Not checked yet"
        }
    }

    // MARK: Work

    private func load() async {
        defer { isLoading = false }
        do {
            let loaded = try await environment.service.connection(id: connectionId)
            connection = loaded
            // The record carries the last known state; this asks the gateway to
            // read whatever the host has said since. Only when there is
            // something to reconcile — an ordinary source must not pay for a
            // filesystem read it will never use.
            provisioning =
                loaded.provisioning == nil
                ? nil : try? await environment.service.connectionProvisioning(id: connectionId)
            error = nil
        } catch let apiError as APIError {
            error = apiError
        } catch {
            self.error = .unexpectedStatus(0, requestId: nil)
        }
    }

    /// Polls while a bridge is being built, and stops the moment it settles.
    ///
    /// Bounded rather than open-ended: an applier that never answers must not
    /// leave a phone polling until the screen is closed. Two minutes is longer
    /// than any of the templates take and short enough to notice.
    private func followProvisioning() async {
        var elapsed = 0
        while provisioning?.isInFlight == true, elapsed < 120, !Task.isCancelled {
            try? await Task.sleep(for: .seconds(3))
            elapsed += 3
            guard !Task.isCancelled else { return }
            guard let next = try? await environment.service.connectionProvisioning(id: connectionId)
            else { continue }
            provisioning = next
            if !next.isInFlight {
                // The addresses have just been filled in, so the settings shown
                // on this screen — and the health it reports — are both stale.
                await load()
                switch next.state {
                case .ready:
                    await probe()
                case .failed:
                    // The bridge card on its own was too quiet: it sits below the
                    // health card and reads as status, so a setup that failed
                    // looked like one that had merely stopped moving. Report it
                    // the way every other failure on this screen is reported,
                    // carrying whatever the host actually said.
                    error = .server(
                        code: .upstreamError,
                        message: next.message ?? "The bridge could not be started.",
                        recoverable: true, requestId: nil)
                default:
                    break
                }
                return
            }
        }

        guard !Task.isCancelled else { return }
        // Falling out of the loop still in flight means the two-minute bound was
        // hit. Stopping silently left "Setting up…" on screen for good, with
        // nothing to say whether it was still working or had died.
        if provisioning?.isInFlight == true {
            error = .server(
                code: .upstreamError,
                message: """
                    The bridge is still being set up after two minutes. It may yet \
                    finish — pull down to refresh and check again.
                    """,
                recoverable: true, requestId: nil)
        }
    }

    private func provisionBridge() async {
        isProvisioning = true
        defer { isProvisioning = false }
        do {
            provisioning = try await environment.service.provisionConnectionBridge(id: connectionId)
            await followProvisioning()
        } catch let apiError as APIError {
            error = apiError
        } catch {
            self.error = .unexpectedStatus(0, requestId: nil)
        }
    }

    /// Stands the bridge up automatically once a sign-in has succeeded, so the
    /// user does not have to find a second button. The gateway only permits it
    /// now that a verified session exists; before sign-in the bridge is
    /// deliberately not created, which is what stopped the repeated verification
    /// codes. No-op for a source that needs no bridge or already has one.
    private func maybeProvisionAfterSignIn() async {
        guard canProvision, descriptor?.bridge != nil else { return }
        guard provisioning == nil || provisioning?.state == .failed else { return }
        await provisionBridge()
    }

    private func probe() async {
        isProbing = true
        defer { isProbing = false }
        do {
            _ = try await environment.service.probeConnection(id: connectionId)
            await load()
        } catch let apiError as APIError {
            error = apiError
        } catch {
            self.error = .unexpectedStatus(0, requestId: nil)
        }
    }

    private func beginSignIn() async {
        isSigningIn = true
        signInNotice = nil
        defer { isSigningIn = false }
        do {
            switch try await environment.service.beginConnectionAuth(id: connectionId) {
            case .complete(let message):
                // Some accounts are already trusted and skip the code entirely.
                signInNotice = message
                await load()
                await maybeProvisionAfterSignIn()
            case .challenge(let received):
                challenge = received
            case .failed(let message):
                error = .server(
                    code: .upstreamError, message: message, recoverable: true, requestId: nil)
            }
        } catch let apiError as APIError {
            error = apiError
        } catch {
            self.error = .unexpectedStatus(0, requestId: nil)
        }
    }

    private func setEnabled(_ value: Bool) async {
        do {
            connection = try await environment.service.updateConnection(
                id: connectionId, ConnectionUpdateRequest(enabled: value))
        } catch let apiError as APIError {
            error = apiError
        } catch {
            self.error = .unexpectedStatus(0, requestId: nil)
        }
    }

    private func remove() async {
        do {
            try await environment.service.removeConnection(id: connectionId)
            dismiss()
        } catch let apiError as APIError {
            error = apiError
        } catch {
            self.error = .unexpectedStatus(0, requestId: nil)
        }
    }
}

// MARK: - Second-factor prompt

extension AuthChallenge: Identifiable {
    var id: String { challengeId }
}

/// The code an upstream sent out of band.
///
/// Modelled as its own step rather than a settings field because that is what
/// the service actually does — it will not issue a token until the code comes
/// back, and pasting a "2FA secret" into a text box would not work at all.
struct ConnectionChallengeView: View {
    let connectionId: String
    let challenge: AuthChallenge
    /// Deliberately synchronous: the follow-on work outlives this sheet, so it
    /// must not be awaited while the sheet is still up.
    let onCompleted: (String) -> Void

    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss

    @State private var code = ""
    @State private var isSubmitting = false
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(challenge.prompt)
                            .font(.callout.weight(.semibold))
                            .foregroundStyle(Theme.textPrimary)
                        if let sentTo = challenge.sentTo {
                            Text("Sent to \(sentTo)")
                                .font(.footnote)
                                .foregroundStyle(Theme.textSecondary)
                        }
                        if let expiresAt = challenge.expiresAt {
                            Text("Expires \(expiresAt.formatted(.relative(presentation: .named)))")
                                .font(.caption)
                                .foregroundStyle(Theme.textTertiary)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(15)
                    .orionisCard()

                    SettingsGroup {
                        TextField("Verification code", text: $code)
                            .keyboardType(.numberPad)
                            .textContentType(.oneTimeCode)
                            .font(.system(.title2, design: .monospaced).weight(.semibold))
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 16)
                    }

                    if let failure {
                        SettingsGroup {
                            SettingsNoteRow(
                                text: failure,
                                systemImage: "exclamationmark.triangle.fill",
                                tint: Theme.critical)
                        }
                    }

                    SettingsHint(
                        "The code is used once to prove this gateway may connect. It is never stored."
                    )
                }
                .padding(16)
            }
            .orionisScreen()
            .navigationTitle("Verify")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Verify") { Task { await submit() } }
                        .disabled(code.count < 3 || isSubmitting)
                }
            }
            .overlay {
                if isSubmitting { BusyOverlay(message: "Verifying…") }
            }
        }
    }

    private func submit() async {
        isSubmitting = true
        failure = nil
        defer { isSubmitting = false }
        do {
            let result = try await environment.service.completeConnectionAuth(
                id: connectionId, challengeId: challenge.challengeId, code: code)
            switch result {
            case .complete(let message):
                // Verification ends the moment the gateway accepts the code.
                // Standing the bridge up is the *next* step and belongs to the
                // detail screen: holding this sheet open across it kept
                // "Verifying…" on screen for the whole provisioning poll — up to
                // two minutes — and then dismissed onto a failure the user never
                // saw being reported. Hand the message up and get out of the way.
                onCompleted(message)
                dismiss()
            case .failed(let message):
                failure = message
            case .challenge:
                // A second challenge in a row is not a flow this screen models;
                // saying so beats looping silently.
                failure = "This service asked for another verification step, which is not supported yet."
            }
        } catch let apiError as APIError {
            failure = apiError.message
        } catch {
            failure = "The code could not be checked."
        }
    }
}
