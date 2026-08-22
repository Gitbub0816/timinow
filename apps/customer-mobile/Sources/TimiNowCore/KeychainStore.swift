import Foundation
#if canImport(Security)
import Security
#endif

/// Stores the Clerk credential in the Keychain rather than UserDefaults.
///
/// UserDefaults is a plist any backup or file-browsing tool can read, and what
/// is kept here is a long-lived cookie that stands in for the account. The
/// Keychain is the only storage on the device that is encrypted at rest and
/// tied to this app.
///
/// Guarded with `#if canImport(Security)` and backed by an in-memory
/// dictionary otherwise, so TimiNowCore still compiles with the Apple-only
/// Keychain APIs stripped (e.g. under Skip Fuse on a non-Apple platform).
public final class KeychainStore: @unchecked Sendable {
    private let service = "solutions.clearkey.timinow"
    private let account = "clerk-session-token"

    public init() { }

    public func save(_ token: String) {
        #if canImport(Security)
        guard let data = token.data(using: .utf8) else { return }
        let query = baseQuery()
        SecItemDelete(query as CFDictionary)
        var attributes = query
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(attributes as CFDictionary, nil)
        #else
        InMemoryKeychainFallback.shared.value = token
        #endif
    }

    public func load() -> String? {
        #if canImport(Security)
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
        #else
        return InMemoryKeychainFallback.shared.value
        #endif
    }

    public func clear() {
        #if canImport(Security)
        SecItemDelete(baseQuery() as CFDictionary)
        #else
        InMemoryKeychainFallback.shared.value = nil
        #endif
    }

    #if canImport(Security)
    private func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
    }
    #endif
}

#if !canImport(Security)
private final class InMemoryKeychainFallback: @unchecked Sendable {
    static let shared = InMemoryKeychainFallback()
    var value: String?
}
#endif
