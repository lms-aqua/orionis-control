import Foundation
import Security

/// Keychain-backed secret storage.
///
/// Accessibility is `WhenUnlockedThisDeviceOnly`: tokens are unavailable while
/// the device is locked and never leave the device via backup or iCloud
/// keychain sync. This is deliberately the strictest practical setting — the
/// app has no background work that needs tokens while locked.
protocol SecretStoring: Sendable {
    func set(_ value: String, for key: SecretKey) throws
    func get(_ key: SecretKey) throws -> String?
    func remove(_ key: SecretKey) throws
    func removeAll() throws
}

enum SecretKey: String, CaseIterable, Sendable {
    case accessToken = "access-token"
    case refreshToken = "refresh-token"
    case accessTokenExpiry = "access-token-expiry"
    case sessionId = "session-id"
    case deviceId = "device-id"
    case pendingVerifier = "pending-pkce-verifier"
    case pendingState = "pending-oauth-state"
}

enum KeychainError: Error, Equatable {
    case unexpectedStatus(OSStatus)
    case invalidData

    var localizedDescription: String {
        switch self {
        case .unexpectedStatus(let status):
            "The secure enclave returned status \(status)."
        case .invalidData:
            "A stored secret could not be read."
        }
    }
}

struct KeychainStore: SecretStoring {
    private let service: String

    init(service: String = "com.lostmediastudios.orioniscontrol") {
        self.service = service
    }

    private func baseQuery(_ key: SecretKey) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key.rawValue,
        ]
    }

    func set(_ value: String, for key: SecretKey) throws {
        guard let data = value.data(using: .utf8) else { throw KeychainError.invalidData }

        var query = baseQuery(key)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]

        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else {
            throw KeychainError.unexpectedStatus(updateStatus)
        }

        query.merge(attributes) { current, _ in current }
        let addStatus = SecItemAdd(query as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw KeychainError.unexpectedStatus(addStatus)
        }
    }

    func get(_ key: SecretKey) throws -> String? {
        var query = baseQuery(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError.unexpectedStatus(status) }
        guard let data = item as? Data, let value = String(data: data, encoding: .utf8) else {
            throw KeychainError.invalidData
        }
        return value
    }

    func remove(_ key: SecretKey) throws {
        let status = SecItemDelete(baseQuery(key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.unexpectedStatus(status)
        }
    }

    /// Used on sign-out. Every secret goes, not just the tokens.
    func removeAll() throws {
        for key in SecretKey.allCases {
            try remove(key)
        }
    }
}

/// In-memory implementation for tests and previews.
final class InMemorySecretStore: SecretStoring, @unchecked Sendable {
    private var storage: [SecretKey: String] = [:]
    private let lock = NSLock()

    init(seed: [SecretKey: String] = [:]) { storage = seed }

    func set(_ value: String, for key: SecretKey) throws {
        lock.lock(); defer { lock.unlock() }
        storage[key] = value
    }

    func get(_ key: SecretKey) throws -> String? {
        lock.lock(); defer { lock.unlock() }
        return storage[key]
    }

    func remove(_ key: SecretKey) throws {
        lock.lock(); defer { lock.unlock() }
        storage[key] = nil
    }

    func removeAll() throws {
        lock.lock(); defer { lock.unlock() }
        storage.removeAll()
    }

    var isEmpty: Bool {
        lock.lock(); defer { lock.unlock() }
        return storage.isEmpty
    }
}
