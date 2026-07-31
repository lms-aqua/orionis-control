import SwiftUI

/// Status presentation. Colour is always paired with a symbol and a label so
/// status is never conveyed by colour alone.
struct StatusBadge: View {
    let status: ServiceStatus
    var label: String?
    var compact = false

    private var tint: Color {
        switch status {
        case .healthy: .green
        case .warning: .orange
        case .critical: .red
        case .offline: .secondary
        case .unknown: .secondary
        }
    }

    var body: some View {
        Label {
            Text(label ?? status.displayName)
                .font(compact ? .caption : .subheadline)
                .fontWeight(.medium)
        } icon: {
            Image(systemName: status.symbolName)
                .foregroundStyle(tint)
        }
        .labelStyle(.titleAndIcon)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label ?? status.displayName), \(status.displayName)")
    }
}

struct CameraStatusBadge: View {
    let health: CameraHealth
    var compact = false

    private var status: ServiceStatus {
        switch health.status {
        case .online: .healthy
        case .degraded: .warning
        case .offline: .offline
        case .unknown: .unknown
        }
    }

    var body: some View {
        HStack(spacing: 8) {
            StatusBadge(
                status: status,
                label: health.status == .online ? "Online" : health.status.rawValue.capitalized,
                compact: compact)
            if health.recording {
                Label("Recording", systemImage: "record.circle")
                    .font(.caption)
                    .foregroundStyle(.red)
                    .labelStyle(.iconOnly)
                    .accessibilityLabel("Recording")
            }
            if health.privacyEnabled {
                Image(systemName: "eye.slash.fill")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Privacy mode on")
            }
        }
    }
}

// MARK: - Standard states

/// A designed loading state. Used instead of a bare spinner so the screen
/// keeps its shape while data arrives.
struct LoadingStateView: View {
    var message: String = "Loading…"

    var body: some View {
        VStack(spacing: 12) {
            ProgressView()
                .controlSize(.large)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(message)
    }
}

struct EmptyStateView: View {
    let title: String
    let message: String
    var systemImage: String = "tray"
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
        } description: {
            Text(message)
        } actions: {
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(.borderedProminent)
            }
        }
    }
}

/// The one error view the whole app uses.
///
/// It answers the four questions every failure should: what failed, whether
/// what you are looking at is stale, what you can do, and whether retrying is
/// safe. A retry button appears only when a retry could actually help.
struct ErrorStateView: View {
    let error: APIError
    var staleAsOf: Date?
    var retry: (() async -> Void)?
    var signIn: (() -> Void)?

    @State private var isRetrying = false

    private var symbol: String {
        switch error {
        case .offline: "wifi.slash"
        case .timedOut: "clock.badge.exclamationmark"
        case .insecureConnection: "lock.trianglebadge.exclamationmark"
        case .configuration: "gearshape.badge.checkmark"
        case .server(let code, _, _, _):
            switch code {
            case .insufficientRole, .forbidden: "hand.raised.fill"
            case .serviceNotConfigured: "cable.connector.slash"
            case .capabilityUnsupported: "slash.circle"
            case .cameraOffline: "video.slash.fill"
            default: "exclamationmark.triangle.fill"
            }
        default: "exclamationmark.triangle.fill"
        }
    }

    var body: some View {
        ContentUnavailableView {
            Label(error.title, systemImage: symbol)
        } description: {
            VStack(spacing: 8) {
                Text(error.message)
                if let suggestion = error.recoverySuggestion {
                    Text(suggestion)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if let staleAsOf {
                    Text(
                        "Showing information from \(staleAsOf.formatted(date: .omitted, time: .shortened))."
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }
                if let requestId = error.requestId {
                    Text("Reference \(requestId)")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .textSelection(.enabled)
                }
            }
        } actions: {
            VStack(spacing: 8) {
                if error.requiresReauthentication, let signIn {
                    Button("Sign in", action: signIn)
                        .buttonStyle(.borderedProminent)
                } else if error.isRetryable, let retry {
                    Button {
                        Task {
                            isRetrying = true
                            await retry()
                            isRetrying = false
                        }
                    } label: {
                        if isRetrying {
                            ProgressView()
                        } else {
                            Text("Try again")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(isRetrying)
                }
            }
        }
    }
}

/// Inline banner used when cached content is shown alongside a failure.
struct StaleDataBanner: View {
    let asOf: Date
    var reason: String?

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "clock.arrow.circlepath")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("Showing saved information")
                    .font(.footnote.weight(.medium))
                Text(reason ?? "Last updated \(asOf.formatted(.relative(presentation: .named))).")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .combine)
    }
}

/// Shown when a whole feature is unavailable because nobody has connected it.
struct NotConfiguredView: View {
    let feature: String
    let detail: String

    var body: some View {
        ContentUnavailableView {
            Label("\(feature) is not connected", systemImage: "cable.connector.slash")
        } description: {
            Text(detail)
        }
    }
}

/// A section header with a trailing refresh timestamp.
struct SectionHeader: View {
    let title: String
    var updatedAt: Date?

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
            Spacer()
            if let updatedAt {
                Text(updatedAt.formatted(date: .omitted, time: .shortened))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .accessibilityLabel(
                        "Updated at \(updatedAt.formatted(date: .omitted, time: .shortened))")
            }
        }
    }
}

/// A metric tile. Deliberately plain: readable at small Dynamic Type sizes and
/// legible in both appearances without relying on gradients or glass.
struct MetricTile: View {
    let title: String
    let value: String
    var caption: String?
    var systemImage: String?
    var tint: Color = .accentColor

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.caption)
                        .foregroundStyle(tint)
                }
                Text(title)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Text(value)
                .font(.title2.weight(.semibold))
                .monospacedDigit()
                .minimumScaleFactor(0.7)
                .lineLimit(1)
            if let caption {
                Text(caption)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title): \(value)\(caption.map { ". \($0)" } ?? "")")
    }
}

// MARK: - Formatting helpers

extension Double {
    var formattedBytes: String {
        ByteCountFormatter.string(fromByteCount: Int64(self), countStyle: .file)
    }
}

extension Int {
    var formattedCount: String {
        formatted(.number.notation(.compactName))
    }
}

extension Date {
    var relativeDescription: String {
        formatted(.relative(presentation: .named))
    }
}
