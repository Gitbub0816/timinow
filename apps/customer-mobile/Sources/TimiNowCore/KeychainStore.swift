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
    private let service: String
    private let account: String

    public init() {
        service = "solutions.clearkey.timinow"
        account = "clerk-session-token"
    }

    /// For the self-test, which needs its own key so it never disturbs the
    /// credential actually in use.
    init(service: String, account: String) {
        self.service = service
        self.account = account
    }

    /// The last write that failed, as a Keychain OSStatus. `nil` means the
    /// last write succeeded.
    ///
    /// SecItemAdd's status was discarded. A Keychain that refuses the write —
    /// a provisioning profile without the app's keychain access group is the
    /// usual reason, and it reports errSecMissingEntitlement (-34018) — then
    /// produced an app that signed in perfectly, stored nothing, and asked for
    /// a password again at the next launch, with no message anywhere in the
    /// app, the console, or the Worker's logs saying why. Every explanation
    /// for that behaviour is somewhere else in the sign-in code, which is
    /// where the search goes instead.
    public private(set) var lastFailure: Int32?

    @discardableResult
    public func save(_ token: String) -> Bool {
        #if canImport(Security)
        guard let data = token.data(using: .utf8) else { lastFailure = -1; return false }
        let query = baseQuery()
        SecItemDelete(query as CFDictionary)
        var attributes = query
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(attributes as CFDictionary, nil)
        lastFailure = status == errSecSuccess ? nil : status
        return status == errSecSuccess
        #else
        InMemoryKeychainFallback.shared.value = token
        lastFailure = nil
        return true
        #endif
    }

    /// Whether this device can store a credential at all, decided by writing
    /// one and reading it back rather than by inspecting entitlements — the
    /// entitlements can be right and the write still refused.
    public func selfTest() -> Int32? {
        #if canImport(Security)
        let probe = KeychainStore(service: service, account: "\(account)-probe")
        defer { probe.clear() }
        guard probe.save("probe") else { return probe.lastFailure ?? -1 }
        return probe.load() == "probe" ? nil : -2
        #else
        return nil
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
