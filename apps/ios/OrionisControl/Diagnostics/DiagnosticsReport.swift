import Foundation
import UIKit

/// Builds a shareable diagnostic report.
///
/// The redaction rules are the point of this type: the report is designed to be
/// pasted into a support thread, so it must never carry a token, a cookie, a
/// password, a private URL or anything identifying about the person using it.
enum DiagnosticsReport {
    /// Patterns that must never survive into a report.
    private static let secretPatterns: [(NSRegularExpression, String)] = {
        let definitions: [(String, String)] = [
            (#"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+"#, "[token removed]"),
            (#"(?i)bearer\s+[A-Za-z0-9._~+/-]+=*"#, "[token removed]"),
            (#"(?i)(password|passphrase|secret|api[_-]?key|client[_-]?secret)\s*[:=]\s*\S+"#,
                "$1: [removed]"),
            (#"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"#,
                "[private key removed]"),
            (#"(?i)cookie\s*[:=]\s*\S+"#, "cookie: [removed]"),
            // IPv4 addresses — private topology.
            (#"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b"#, "[address removed]"),
            // Email addresses.
            (#"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"#, "[email removed]"),
        ]
        return definitions.compactMap { pattern, replacement in
            guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
            return (regex, replacement)
        }
    }()

    /// Applies every redaction rule. Exposed so it can be unit-tested directly.
    static func redact(_ input: String) -> String {
        var output = input
        for (regex, replacement) in secretPatterns {
            output = regex.stringByReplacingMatches(
                in: output,
                range: NSRange(output.startIndex..., in: output),
                withTemplate: replacement
            )
        }
        return output
    }

    /// Reduces a gateway URL to scheme + TLD shape, so the report proves the
    /// connection is HTTPS without publishing where it points.
    static func redactHost(_ raw: String) -> String {
        guard let url = URL(string: raw), let host = url.host() else { return "[not set]" }
        let parts = host.split(separator: ".")
        guard parts.count >= 2 else { return "\(url.scheme ?? "?")://[host removed]" }
        return "\(url.scheme ?? "?")://[host removed].\(parts.suffix(1).joined())"
    }

    @MainActor
    static func build(environment: AppEnvironment) -> String {
        let config = environment.configuration
        let device = UIDevice.current
        let auth = environment.auth.state

        var lines: [String] = []
        lines.append("Orionis Control diagnostic report")
        lines.append("Generated: \(Date().formatted(date: .abbreviated, time: .standard))")
        lines.append("")

        lines.append("== Application ==")
        lines.append("Version:      \(config.version) (\(config.build))")
        lines.append("Environment:  \(config.environment.displayName)")
        lines.append("Bundle:       \(Bundle.main.bundleIdentifier ?? "unknown")")
        lines.append("")

        lines.append("== Device ==")
        lines.append("Model:        \(device.model)")
        lines.append("System:       \(device.systemName) \(device.systemVersion)")
        // An app-scoped random identifier, not a hardware fingerprint.
        lines.append("App install:  \(environment.auth.deviceId.prefix(8))…")
        lines.append("")

        lines.append("== Connection ==")
        lines.append("Gateway:      \(redactHost(environment.preferences.serverURLString))")
        if let meta = environment.meta {
            lines.append("Server:       \(meta.serverVersion)")
            lines.append("API:          \(meta.apiVersion)")
            lines.append("Cameras:      \(meta.capabilities.cameras ? "connected" : "not configured")")
            lines.append("AdGuard:      \(meta.capabilities.adguard ? "connected" : "not configured")")
            lines.append("Push:         \(meta.capabilities.push ? "connected" : "not configured")")
            lines.append("Sign-in:      \(meta.authentication.configured ? "configured" : "not configured")")
        } else if let error = environment.metaError {
            lines.append("Server:       unreachable (\(error.title))")
        } else {
            lines.append("Server:       not contacted this session")
        }
        lines.append("")

        lines.append("== Session ==")
        switch auth {
        case .signedIn: lines.append("State:        signed in")
        case .locked: lines.append("State:        locked")
        case .authenticating: lines.append("State:        signing in")
        case .signedOut: lines.append("State:        signed out")
        case .needsServer: lines.append("State:        no gateway configured")
        case .initialising: lines.append("State:        starting")
        }
        // Role is operationally useful and not sensitive; identity is omitted.
        if let role = auth.user?.role {
            lines.append("Role:         \(role.displayName)")
        }
        lines.append("")

        lines.append("== Security settings ==")
        lines.append("Biometric lock:      \(environment.preferences.requireBiometricUnlock)")
        lines.append("Confirm privileged:  \(environment.preferences.requireBiometricForAdminActions)")
        lines.append("Privacy shield:      \(environment.preferences.hidePreviewsInAppSwitcher)")
        lines.append("Biometrics:          \(environment.biometrics.availability.displayName)")
        lines.append("")

        lines.append("== Preferences ==")
        lines.append("Default quality:     \(environment.preferences.defaultStreamQuality.rawValue)")
        lines.append("Cellular limit:      \(environment.preferences.limitQualityOnCellular)")
        lines.append("Grid columns:        \(environment.preferences.gridColumns)")
        lines.append("Favourites:          \(environment.preferences.favouriteCameraIds.count)")
        lines.append("")

        lines.append(
            "This report is redacted automatically: no tokens, passwords, cookies, addresses or personal details are included."
        )

        // Belt and braces: run the whole thing through redaction, in case a
        // future field carries something it should not.
        return redact(lines.joined(separator: "\n"))
    }
}
