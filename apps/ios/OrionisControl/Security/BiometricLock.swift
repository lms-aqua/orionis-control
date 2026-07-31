import Foundation
import LocalAuthentication

/// Face ID / Touch ID gating for app unlock and privileged actions.
///
/// Biometrics here are a *local* control: they decide whether this device will
/// use the session it already holds. They never substitute for the server's
/// authorisation checks.
@MainActor
@Observable
final class BiometricLock {
    enum Availability: Equatable {
        case faceID
        case touchID
        case opticID
        case passcodeOnly
        case unavailable(String)

        var isAvailable: Bool {
            if case .unavailable = self { return false }
            return true
        }

        var displayName: String {
            switch self {
            case .faceID: "Face ID"
            case .touchID: "Touch ID"
            case .opticID: "Optic ID"
            case .passcodeOnly: "device passcode"
            case .unavailable: "biometrics"
            }
        }

        var symbolName: String {
            switch self {
            case .faceID: "faceid"
            case .touchID: "touchid"
            case .opticID: "opticid"
            case .passcodeOnly, .unavailable: "lock.fill"
            }
        }
    }

    enum Outcome: Equatable {
        case success
        case cancelled
        case failed(String)
        case unavailable(String)
    }

    private(set) var availability: Availability = .unavailable("Not checked yet.")
    private(set) var isUnlocked = false

    private var contextFactory: () -> LAContext

    init(contextFactory: @escaping () -> LAContext = { LAContext() }) {
        self.contextFactory = contextFactory
        refreshAvailability()
    }

    func refreshAvailability() {
        let context = contextFactory()
        var error: NSError?

        if context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) {
            switch context.biometryType {
            case .faceID: availability = .faceID
            case .touchID: availability = .touchID
            case .opticID: availability = .opticID
            default: availability = .passcodeOnly
            }
            return
        }

        // Fall back to passcode: still a meaningful local gate.
        if context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) {
            availability = .passcodeOnly
            return
        }

        availability = .unavailable(
            error?.localizedDescription
                ?? "This device has no passcode or biometrics configured.")
    }

    /// Prompts the user. `reason` is shown in the system sheet, so it must
    /// state plainly what is about to happen.
    func authenticate(reason: String) async -> Outcome {
        guard availability.isAvailable else {
            if case .unavailable(let detail) = availability { return .unavailable(detail) }
            return .unavailable("Biometric authentication is not available.")
        }

        let context = contextFactory()
        context.localizedCancelTitle = "Cancel"

        // Biometrics first, with the system's own passcode fallback.
        let policy: LAPolicy = .deviceOwnerAuthentication

        do {
            let success = try await context.evaluatePolicy(policy, localizedReason: reason)
            if success {
                isUnlocked = true
                return .success
            }
            return .failed("Authentication was not successful.")
        } catch let error as LAError {
            switch error.code {
            case .userCancel, .appCancel, .systemCancel:
                return .cancelled
            case .userFallback:
                return .cancelled
            case .biometryLockout:
                return .failed(
                    "Too many failed attempts. Unlock the device with its passcode, then try again."
                )
            case .biometryNotEnrolled:
                return .unavailable("No biometrics are enrolled on this device.")
            case .passcodeNotSet:
                return .unavailable("This device has no passcode set.")
            default:
                return .failed(error.localizedDescription)
            }
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    func lock() { isUnlocked = false }
}
