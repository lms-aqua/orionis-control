import CryptoKit
import Foundation

/// RFC 7636 Proof Key for Code Exchange.
///
/// The app runs its own PKCE leg against the gateway. The gateway runs a
/// separate one against Authelia. Neither verifier ever crosses the boundary.
struct PKCEPair: Equatable, Sendable {
    let verifier: String
    let challenge: String
    let method = "S256"

    /// RFC 7636 §4.1: 43–128 characters from the unreserved set.
    /// 32 random bytes base64url-encoded gives exactly 43.
    static func generate() -> PKCEPair {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        precondition(status == errSecSuccess, "The system random number generator failed.")
        let verifier = Data(bytes).base64URLEncodedString()
        return PKCEPair(verifier: verifier, challenge: Self.challenge(for: verifier))
    }

    static func challenge(for verifier: String) -> String {
        let digest = SHA256.hash(data: Data(verifier.utf8))
        return Data(digest).base64URLEncodedString()
    }

    static func isValidVerifier(_ verifier: String) -> Bool {
        guard (43...128).contains(verifier.count) else { return false }
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        return verifier.unicodeScalars.allSatisfy(allowed.contains)
    }
}

/// An opaque, high-entropy value used for OAuth `state`.
enum OAuthState {
    static func generate() -> String {
        var bytes = [UInt8](repeating: 0, count: 24)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        precondition(status == errSecSuccess, "The system random number generator failed.")
        return Data(bytes).base64URLEncodedString()
    }

    /// Constant-time comparison so a returned state cannot be probed byte by byte.
    static func matches(_ lhs: String, _ rhs: String) -> Bool {
        let a = Array(lhs.utf8)
        let b = Array(rhs.utf8)
        guard a.count == b.count else { return false }
        var difference: UInt8 = 0
        for index in a.indices { difference |= a[index] ^ b[index] }
        return difference == 0
    }
}

extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
