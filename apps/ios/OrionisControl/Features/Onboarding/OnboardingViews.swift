import SwiftUI

/// First launch: explain, collect the gateway address, test it, then hand off
/// to Authelia. Nothing here asks for a username or password — by design.
struct ServerSetupView: View {
    @Environment(AppEnvironment.self) private var environment

    @State private var address = ""
    @State private var phase: Phase = .welcome
    @State private var isTesting = false
    @State private var error: APIError?
    @State private var meta: GatewayMeta?

    private enum Phase { case welcome, address, confirmed }

    var body: some View {
        NavigationStack {
            Group {
                switch phase {
                case .welcome: welcome
                case .address: addressEntry
                case .confirmed: confirmation
                }
            }
            .padding(.horizontal, 24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .navigationTitle(phase == .welcome ? "" : "Connect")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    // MARK: Welcome

    private var welcome: some View {
        VStack(spacing: 28) {
            Spacer()

            Image(systemName: "shield.lefthalf.filled.badge.checkmark")
                .font(.system(size: 64))
                .foregroundStyle(.tint)
                .accessibilityHidden(true)

            VStack(spacing: 12) {
                Text("Orionis Control")
                    .font(.largeTitle.weight(.bold))
                Text(
                    "One place for your cameras, your DNS filtering, and the services keeping them online."
                )
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            }

            VStack(alignment: .leading, spacing: 16) {
                onboardingPoint(
                    "lock.shield",
                    "You sign in through your own identity provider",
                    "Orionis Control never asks for your password. It opens your real sign-in page, including any multi-factor step you already use."
                )
                onboardingPoint(
                    "network.badge.shield.half.filled",
                    "It connects only to your gateway",
                    "This app talks to one address that you control. Nothing is sent anywhere else."
                )
                onboardingPoint(
                    "eye.slash",
                    "No analytics, no tracking",
                    "There is no advertising or analytics code in this app."
                )
            }
            .padding(.vertical, 8)

            Spacer()

            Button("Get started") { phase = .address }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .frame(maxWidth: .infinity)
                .padding(.bottom, 32)
        }
    }

    private func onboardingPoint(_ symbol: String, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: symbol)
                .font(.title3)
                .foregroundStyle(.tint)
                .frame(width: 28)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.subheadline.weight(.semibold))
                Text(detail).font(.footnote).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: Address

    private var addressEntry: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Gateway address")
                    .font(.title2.weight(.semibold))
                Text(
                    "Enter the address of your Orionis Control gateway. Your administrator can provide it."
                )
                .font(.subheadline)
                .foregroundStyle(.secondary)
            }
            .padding(.top, 12)

            TextField("gateway.example.com", text: $address)
                .textFieldStyle(.roundedBorder)
                .textContentType(.URL)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .onSubmit { Task { await test() } }
                .accessibilityLabel("Gateway address")

            Label(
                "HTTPS is required. Orionis Control will not connect over an unencrypted link.",
                systemImage: "lock.fill"
            )
            .font(.footnote)
            .foregroundStyle(.secondary)

            if let error {
                ErrorSummary(error: error)
            }

            Button {
                Task { await test() }
            } label: {
                if isTesting {
                    ProgressView().frame(maxWidth: .infinity)
                } else {
                    Text("Test connection").frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(address.trimmingCharacters(in: .whitespaces).isEmpty || isTesting)

            Spacer()
        }
    }

    // MARK: Confirmation

    @ViewBuilder
    private var confirmation: some View {
        if let meta {
            VStack(alignment: .leading, spacing: 20) {
                Label("Connected", systemImage: "checkmark.circle.fill")
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(.green)
                    .padding(.top, 12)

                VStack(alignment: .leading, spacing: 10) {
                    detailRow("Gateway version", meta.serverVersion)
                    detailRow("API version", meta.apiVersion)
                    detailRow("Environment", meta.environment.capitalized)
                    detailRow(
                        "Sign-in",
                        meta.authentication.configured
                            ? "Ready" : "Not configured on the gateway")
                }
                .padding(16)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))

                if !meta.unconfigured.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Label("Some features are not connected yet", systemImage: "info.circle")
                            .font(.subheadline.weight(.medium))
                        Text(
                            "\(meta.unconfigured.map(featureName).formatted(.list(type: .and))) will show an explanation instead of data until an administrator connects \(meta.unconfigured.count == 1 ? "it" : "them")."
                        )
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    }
                    .padding(14)
                    .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
                }

                Spacer()

                Button("Continue to sign in") {
                    environment.completeSetup()
                    Task {
                        await environment.auth.restore(hasConfiguredServer: true)
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .frame(maxWidth: .infinity)
                .disabled(!meta.authentication.configured)

                if !meta.authentication.configured {
                    Text(
                        "Sign-in is unavailable because the gateway has no identity provider configured. An administrator must complete that first."
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }

                Button("Use a different address") { phase = .address }
                    .frame(maxWidth: .infinity)
                    .padding(.bottom, 24)
            }
        }
    }

    private func featureName(_ raw: String) -> String {
        switch raw {
        case "orionis": "Cameras"
        case "adguard": "Network filtering"
        case "push": "Notifications"
        case "authentication": "Sign-in"
        default: raw.capitalized
        }
    }

    private func detailRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value).fontWeight(.medium)
        }
        .font(.subheadline)
        .accessibilityElement(children: .combine)
    }

    private func test() async {
        isTesting = true
        error = nil
        defer { isTesting = false }

        do {
            meta = try await environment.connect(to: address)
            phase = .confirmed
        } catch let apiError as APIError {
            error = apiError
        } catch {
            self.error = .unexpectedStatus(0, requestId: nil)
        }
    }
}

/// Compact inline error, used where a full ContentUnavailableView is too heavy.
struct ErrorSummary: View {
    let error: APIError

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(error.title, systemImage: "exclamationmark.triangle.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.orange)
            Text(error.message)
                .font(.footnote)
            if let suggestion = error.recoverySuggestion {
                Text(suggestion)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Sign in

struct SignInView: View {
    let reason: SignedOutReason?
    var isAuthenticating = false

    @Environment(AppEnvironment.self) private var environment

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            Image(systemName: "shield.lefthalf.filled.badge.checkmark")
                .font(.system(size: 56))
                .foregroundStyle(.tint)
                .accessibilityHidden(true)

            VStack(spacing: 8) {
                Text("Sign in")
                    .font(.title.weight(.bold))
                Text("Orionis Control opens your identity provider's own sign-in page.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding(.horizontal, 32)

            if let message = reason?.message {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(14)
                    .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
                    .padding(.horizontal, 24)
            }

            Button {
                Task { await environment.auth.beginSignIn() }
            } label: {
                if isAuthenticating {
                    ProgressView().frame(maxWidth: .infinity)
                } else {
                    Text("Continue").frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .padding(.horizontal, 32)
            .disabled(isAuthenticating)

            Spacer()

            VStack(spacing: 4) {
                Text(environment.preferences.serverURLString)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Button("Change gateway") {
                    environment.preferences.hasCompletedSetup = false
                    Task { await environment.auth.restore(hasConfiguredServer: false) }
                }
                .font(.caption)
            }
            .padding(.bottom, 32)
        }
    }
}
