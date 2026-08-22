import Foundation
import Observation
#if canImport(AuthenticationServices)
import AuthenticationServices
#endif
#if canImport(AppKit)
import AppKit
#endif

// Custom-UI Clerk sign-in, driven directly against Clerk's Frontend API
// (`/v1/client/...`) exactly as docs/PLATFORM-CONTRACT.md's "Authentication
// UI rule" requires — no `@clerk/clerk-js` mount, no Clerk-hosted screen.
// This is a from-scratch Swift port of the same flow the sibling Windows app
// implements in Services/ClerkAuthService.cs + Services/CredentialStore.cs:
// same endpoints, same request/response shapes, same "client cookie is the
// long-lived credential, the Worker token is short-lived and re-minted from
// it" persistence model — translated to Apple idioms (URLSession's cookie
// storage instead of a CookieContainer, Keychain instead of DPAPI,
// ASWebAuthenticationSession + a custom URL scheme instead of a loopback
// HTTP listener for the OAuth browser round trip). Passkey sign-in is not
// wired up in this build — see `beginPasskey()` below for why.

// MARK: - Public surface

public enum AuthStage: String, Sendable {
    case identifier
    case strategyPicker
    case password
    case code
    case workspacePicker
    case signedIn
}

public struct AuthFactorOption: Identifiable, Hashable, Sendable {
    public var strategy: String
    public var label: String
    public var id: String { strategy }
}

public struct AuthWorkspaceOption: Identifiable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var slug: String?
}

@MainActor @Observable public final class AuthController: ClinicSessionTokenProviding, @unchecked Sendable {
    public var stage: AuthStage = .identifier
    public var identifierText = ""
    public var passwordText = ""
    public var codeText = ""
    public var factorOptions: [AuthFactorOption] = []
    public var selectedFactor: AuthFactorOption?
    public var workspaces: [AuthWorkspaceOption] = []
    public var isBusy = false
    public var errorMessage: String?
    public var session: SessionDescriptor?

    public var isSignedIn: Bool { stage == .signedIn && session?.authenticated == true }
    /// The OAuth buttons only make sense once the Clerk Frontend API
    /// host is known; the identifier field works with just a Worker URL.
    public var canUseExternalMethods: Bool { frontendAPIHost != nil }

    private let apiClient: ClinicAPIClient
    private let keychain = KeychainStore()

    private var publishableKey: String?
    private var frontendAPIHost: String?
    private var pendingSignInId: String?
    private var pendingFactors: [ClerkWireFactor] = []
    private var activeSessionId: String?
    private var workerToken: String?
    private var workerTokenExpiresAt: Date?

    #if canImport(AuthenticationServices) && canImport(AppKit)
    private var webAuthSession: ASWebAuthenticationSession?
    private let presentationProvider = OAuthPresentationProvider()
    #endif

    private static let clerkDecoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }()

    public init(apiClient: ClinicAPIClient) {
        self.apiClient = apiClient
        apiClient.tokenProvider = self
    }

    // MARK: - Bootstrap / session restore

    /// Called once at launch: resolves the Clerk Frontend API host from
    /// `/api/config`, then tries to resume a previously persisted session
    /// with no user interaction, exactly like the Windows client's
    /// `TryRestoreAsync`.
    public func start() async {
        isBusy = true
        defer { isBusy = false }

        do {
            let config = try await apiClient.getConfig()
            publishableKey = config.clerkPublishableKey
            if let explicitHost = config.clerkFrontendApi, !explicitHost.isEmpty {
                frontendAPIHost = explicitHost
            } else if let key = publishableKey {
                frontendAPIHost = Self.decodeFrontendAPIHost(key)
            }
        } catch {
            // Offline, or the Worker URL in Settings is not reachable yet.
            // Sign-in stays on the identifier screen until it is.
        }

        guard let host = frontendAPIHost, let stored = loadCredential(), stored.frontendAPIHost == host else {
            stage = .identifier
            return
        }
        restoreCookie(stored.clientCookie, host: host)
        activeSessionId = stored.activeSessionId
        workerToken = stored.workerToken
        workerTokenExpiresAt = stored.workerTokenExpiresAt

        do {
            let client = try await getClient()
            guard let sessionId = activeSessionId, (client.sessions ?? []).contains(where: { $0.id == sessionId && $0.status == "active" }) else {
                signOutLocally()
                return
            }
            _ = try await ensureFreshToken()
            await refreshSession()
        } catch {
            signOutLocally()
        }
    }

    // MARK: - Identifier -> first factor

    public func submitIdentifier() async {
        let identifier = identifierText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !identifier.isEmpty else { errorMessage = "Enter your work email or phone number."; return }
        guard frontendAPIHost != nil else { errorMessage = "Tími could not reach Clerk. Check the Worker connection in Settings."; return }
        isBusy = true; errorMessage = nil
        defer { isBusy = false }
        do {
            let data = try await clerkRequest(path: "/v1/client/sign_ins", method: "POST", form: [("identifier", identifier)])
            let signIn = try Self.clerkDecoder.decode(ClerkWireSignIn.self, from: data)
            track(signIn)
            if signIn.status == "complete" { try await completeIfNeeded(signIn); return }
            factorOptions = Self.labelFactors(pendingFactors)
            if factorOptions.isEmpty {
                errorMessage = "This account has no supported sign-in method configured."
            } else if factorOptions.count == 1, let only = factorOptions.first {
                await choose(only)
            } else {
                stage = .strategyPicker
            }
        } catch let error as ClinicAPIError {
            errorMessage = error.message
        } catch {
            errorMessage = "Tími could not start sign-in. Check your connection and try again."
        }
    }

    public func choose(_ factor: AuthFactorOption) async {
        selectedFactor = factor
        errorMessage = nil
        if factor.strategy == "password" { stage = .password; return }
        guard let signInId = pendingSignInId else { return }
        guard let wire = pendingFactors.first(where: { $0.strategy == factor.strategy }) else { stage = .strategyPicker; return }
        isBusy = true
        defer { isBusy = false }
        do {
            let data = try await clerkRequest(
                path: "/v1/client/sign_ins/\(signInId)/prepare_first_factor", method: "POST",
                form: [("strategy", factor.strategy), ("email_address_id", wire.emailAddressId), ("phone_number_id", wire.phoneNumberId)]
            )
            let signIn = try Self.clerkDecoder.decode(ClerkWireSignIn.self, from: data)
            track(signIn)
            stage = .code
        } catch let error as ClinicAPIError {
            errorMessage = error.message
        } catch {
            errorMessage = "Could not send a verification code. Try again."
        }
    }

    public func submitPassword() async {
        guard let signInId = pendingSignInId else { return }
        guard !passwordText.isEmpty else { errorMessage = "Enter your password."; return }
        isBusy = true; errorMessage = nil
        defer { isBusy = false }
        do {
            let data = try await clerkRequest(
                path: "/v1/client/sign_ins/\(signInId)/attempt_first_factor", method: "POST",
                form: [("strategy", "password"), ("password", passwordText)]
            )
            let signIn = try Self.clerkDecoder.decode(ClerkWireSignIn.self, from: data)
            try await completeIfNeeded(signIn)
        } catch let error as ClinicAPIError {
            errorMessage = error.message
        } catch {
            errorMessage = "That password was not accepted."
        }
    }

    public func submitCode() async {
        guard let signInId = pendingSignInId, let strategy = selectedFactor?.strategy else { return }
        let code = codeText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard code.count >= 4 else { errorMessage = "Enter the code Clerk sent you."; return }
        isBusy = true; errorMessage = nil
        defer { isBusy = false }
        do {
            let data = try await clerkRequest(
                path: "/v1/client/sign_ins/\(signInId)/attempt_first_factor", method: "POST",
                form: [("strategy", strategy), ("code", code)]
            )
            let signIn = try Self.clerkDecoder.decode(ClerkWireSignIn.self, from: data)
            try await completeIfNeeded(signIn)
        } catch let error as ClinicAPIError {
            errorMessage = error.message
        } catch {
            errorMessage = "That code was not accepted."
        }
    }

    // MARK: - Completing sign-in / workspace selection

    private func completeIfNeeded(_ signIn: ClerkWireSignIn) async throws {
        track(signIn)
        guard signIn.status == "complete", let sessionId = signIn.createdSessionId else {
            errorMessage = "Additional verification is required for this account."
            return
        }
        activeSessionId = sessionId
        try await mintWorkerToken()
        saveCredential()
        await proceedAfterSignIn()
    }

    /// After a session exists: if the person belongs to more than one Clerk
    /// organization, show the custom workspace picker (never
    /// `mountOrganizationSwitcher`); otherwise activate the one organization
    /// automatically and finish through `/api/session`.
    private func proceedAfterSignIn() async {
        do {
            let memberships = try await getOrganizationMemberships()
            if memberships.count > 1 {
                workspaces = memberships.compactMap { membership in
                    guard let org = membership.organization else { return nil }
                    return AuthWorkspaceOption(id: org.id, name: org.name, slug: org.slug)
                }
                stage = .workspacePicker
                return
            }
            if let only = memberships.first?.organization {
                try await activateOrganization(only.id)
            }
        } catch {
            // Fall through — /api/session still resolves whatever Clerk's
            // default active organization already is, if any.
        }
        await refreshSession()
    }

    public func selectWorkspace(_ workspace: AuthWorkspaceOption) async {
        isBusy = true; errorMessage = nil
        defer { isBusy = false }
        do {
            try await activateOrganization(workspace.id)
            await refreshSession()
        } catch let error as ClinicAPIError {
            errorMessage = error.message
        } catch {
            errorMessage = "Could not open that workspace."
        }
    }

    /// Activates an organization on the current session via `/touch` — the
    /// Frontend API's non-UI equivalent of `clerk.setActive({ organization })`.
    private func activateOrganization(_ organizationId: String) async throws {
        guard let sessionId = activeSessionId else { throw ClinicAPIError.invalidResponse }
        // Never send an empty/null value here: with "force organization
        // selection" enabled, Clerk keeps whatever organization was already
        // active rather than clearing it — harmless for us since
        // `organizationId` is always a real id from the caller.
        _ = try await clerkRequest(path: "/v1/client/sessions/\(sessionId)/touch", method: "POST", form: [("active_organization_id", organizationId)])
        try await mintWorkerToken()
        saveCredential()
    }

    public func refreshSession() async {
        do {
            session = try await apiClient.getSession()
            stage = (session?.authenticated == true) ? .signedIn : .identifier
        } catch {
            // A stale/expired token should not lock the console out silently —
            // fall back to asking for the identifier again.
            stage = .identifier
        }
    }

    /// Clerk's Frontend API returns a WebAuthn challenge for
    /// `strategy=passkey`, not a browser redirect URL — the identifier-less
    /// path OAuth uses does not apply here, so this is not routed through
    /// `beginOAuth`. A real passkey ceremony needs
    /// `ASAuthorizationPlatformPublicKeyCredentialProvider` +
    /// `ASAuthorizationController` plus a `webcredentials:` associated-domain
    /// entitlement and a hosted `apple-app-site-association` file, none of
    /// which can be verified without a Mac and a live Clerk passkey
    /// configuration — see this app's README. Rather than ship a button that
    /// silently fails, this surfaces the same "use the web console instead"
    /// message the Windows client shows for the strategies it cannot
    /// complete either.
    public func beginPasskey() async {
        errorMessage = "Passkeys aren't available in this build yet — sign in with the Tími web console, or use email, phone, password, Google, or Apple here."
    }

    public func signOut() async {
        isBusy = true
        defer { isBusy = false }
        // `/v1/client/sessions/{id}` is GET-only in Clerk's Frontend API —
        // ending a session is POST .../end, not DELETE.
        if let sessionId = activeSessionId {
            _ = try? await clerkRequest(path: "/v1/client/sessions/\(sessionId)/end", method: "POST")
        }
        signOutLocally()
    }

    private func signOutLocally() {
        activeSessionId = nil; workerToken = nil; workerTokenExpiresAt = nil
        pendingSignInId = nil; pendingFactors = []
        keychain.clear()
        session = nil
        identifierText = ""; passwordText = ""; codeText = ""
        factorOptions = []; workspaces = []
        stage = .identifier
    }

    // MARK: - ClinicSessionTokenProviding

    // Spelled `get async` to match ClinicSessionTokenProviding's requirement
    // exactly. Swift lets a @MainActor synchronous property satisfy an async
    // requirement — the hop supplies the await — but Skip transpiles the
    // requirement to `suspend fun hasSession()` and a plain getter to a
    // non-suspend one, so Kotlin sees an unimplemented abstract member.
    public var hasSession: Bool {
        get async { activeSessionId != nil && workerToken != nil }
    }

    public func ensureFreshToken() async throws -> String {
        guard activeSessionId != nil else { throw ClinicAPIError.invalidResponse }
        if let token = workerToken, let expiry = workerTokenExpiresAt, expiry > Date().addingTimeInterval(10) {
            return token
        }
        try await mintWorkerToken()
        saveCredential()
        guard let token = workerToken else { throw ClinicAPIError.invalidResponse }
        return token
    }

    public func forceRefreshToken() async throws -> String {
        try await mintWorkerToken()
        saveCredential()
        guard let token = workerToken else { throw ClinicAPIError.invalidResponse }
        return token
    }

    // MARK: - Clerk Frontend API plumbing

    private func track(_ signIn: ClerkWireSignIn) {
        pendingSignInId = signIn.id
        pendingFactors = signIn.supportedFirstFactors ?? []
    }

    private func getClient() async throws -> ClerkWireClient {
        let data = try await clerkRequest(path: "/v1/client")
        return try Self.clerkDecoder.decode(ClerkWireClient.self, from: data)
    }

    private func getOrganizationMemberships() async throws -> [ClerkWireOrganizationMembership] {
        let data = try await clerkRequest(path: "/v1/me/organization_memberships")
        if let array = try? Self.clerkDecoder.decode([ClerkWireOrganizationMembership].self, from: data) { return array }
        if let wrapped = try? Self.clerkDecoder.decode(ClerkWireListEnvelope<ClerkWireOrganizationMembership>.self, from: data) { return wrapped.data ?? [] }
        return []
    }

    private func mintWorkerToken() async throws {
        guard let sessionId = activeSessionId else { throw ClinicAPIError.invalidResponse }
        if let token = try? await mintToken(sessionId: sessionId, template: "timinow") {
            workerToken = token.jwt
        } else if let token = try? await mintToken(sessionId: sessionId, template: nil) {
            workerToken = token.jwt
        } else {
            throw ClinicAPIError.server("Clerk did not return a session token for this Worker.")
        }
        workerTokenExpiresAt = workerToken.flatMap(Self.parseJWTExpiry) ?? Date().addingTimeInterval(60)
    }

    private func mintToken(sessionId: String, template: String?) async throws -> ClerkWireToken {
        let path = template.map { "/v1/client/sessions/\(sessionId)/tokens/\($0)" } ?? "/v1/client/sessions/\(sessionId)/tokens"
        let data = try await clerkRequest(path: path, method: "POST", form: [])
        return try Self.clerkDecoder.decode(ClerkWireToken.self, from: data)
    }

    /// One request against the Clerk Frontend API. Every call carries
    /// `_clerk_js_version=5` (matching the headless `@clerk/clerk-js@5` the
    /// web surfaces load) and unwraps FAPI's `{ "response": ... }` envelope.
    private func clerkRequest(path: String, method: String = "GET", form: [(String, String?)]? = nil) async throws -> Data {
        guard let host = frontendAPIHost else { throw ClinicAPIError.invalidConfiguration }
        guard var components = URLComponents(string: "https://\(host)\(path)") else { throw ClinicAPIError.invalidResponse }
        var query = components.queryItems ?? []
        query.append(URLQueryItem(name: "_clerk_js_version", value: "5"))
        components.queryItems = query
        guard let url = components.url else { throw ClinicAPIError.invalidResponse }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpShouldHandleCookies = true
        if let form {
            request.httpBody = Self.encodeForm(form)
            request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        }

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ClinicAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw ClinicAPIError.server(Self.extractClerkError(data))
        }
        return Self.unwrapResponse(data)
    }

    private static func unwrapResponse(_ data: Data) -> Data {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let inner = object["response"] else { return data }
        return (try? JSONSerialization.data(withJSONObject: inner)) ?? data
    }

    private static func extractClerkError(_ data: Data) -> String {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let errors = object["errors"] as? [[String: Any]], let first = errors.first else {
            return "Clerk sign-in failed."
        }
        if let long = first["long_message"] as? String, !long.isEmpty { return long }
        if let message = first["message"] as? String, !message.isEmpty { return message }
        return "Clerk sign-in failed."
    }

    private static func encodeForm(_ fields: [(String, String?)]) -> Data {
        let pairs = fields.compactMap { key, value -> String? in
            guard let value else { return nil }
            return "\(percentEncode(key))=\(percentEncode(value))"
        }
        return pairs.joined(separator: "&").data(using: .utf8) ?? Data()
    }

    private static func percentEncode(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-_.~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    // MARK: - Frontend API host derivation

    /// Decodes the Clerk Frontend API host from a publishable key:
    /// `pk_(test|live)_` + base64("<host>$"). Same algorithm as the Windows
    /// client's `ResolveFrontendApiHost` and Clerk's own JS SDK.
    static func decodeFrontendAPIHost(_ publishableKey: String) -> String? {
        let prefixes = ["pk_test_", "pk_live_"]
        guard let prefix = prefixes.first(where: publishableKey.hasPrefix) else { return nil }
        var encoded = String(publishableKey.dropFirst(prefix.count))
        while encoded.count % 4 != 0 { encoded += "=" }
        guard let data = Data(base64Encoded: encoded), var decoded = String(data: data, encoding: .utf8) else { return nil }
        if decoded.hasSuffix("$") { decoded.removeLast() }
        return decoded.isEmpty ? nil : decoded
    }

    private static func parseJWTExpiry(_ jwt: String) -> Date? {
        let parts = jwt.split(separator: ".")
        guard parts.count >= 2, let payload = base64URLDecode(String(parts[1])) else { return nil }
        guard let object = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] else { return nil }
        guard let seconds = object["exp"] as? Double else { return nil }
        return Date(timeIntervalSince1970: seconds)
    }

    private static func base64URLDecode(_ value: String) -> Data? {
        var base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while base64.count % 4 != 0 { base64 += "=" }
        return Data(base64Encoded: base64)
    }

    private static func labelFactors(_ factors: [ClerkWireFactor]) -> [AuthFactorOption] {
        var seen = Set<String>()
        var options: [AuthFactorOption] = []
        for factor in factors {
            guard seen.insert(factor.strategy).inserted else { continue }
            let label: String
            switch factor.strategy {
            case "password": label = "Password"
            case "email_code": label = "Email code"
            case "phone_code": label = "Text message code"
            case "reset_password_email_code": label = "Reset password by email"
            default: label = factor.strategy.replacingOccurrences(of: "_", with: " ").capitalized
            }
            options.append(AuthFactorOption(strategy: factor.strategy, label: label))
        }
        return options
    }

    // MARK: - Credential persistence (Keychain, not settings.json)

    /// Mirrors the Windows client's `StoredCredential`/`CredentialStore`: the
    /// Clerk `__client` cookie is the long-lived credential; the Worker token
    /// is short-lived and re-minted from it. Stored as one JSON blob under a
    /// single Keychain item — never in settings.json.
    private struct StoredAuthCredential: Codable {
        var frontendAPIHost: String
        var clientCookie: String
        var activeSessionId: String?
        var workerToken: String?
        var workerTokenExpiresAt: Date?
    }

    private func loadCredential() -> StoredAuthCredential? {
        guard let raw = keychain.load(), let data = raw.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(StoredAuthCredential.self, from: data)
    }

    private func saveCredential() {
        guard let host = frontendAPIHost, let cookie = extractClientCookie(host: host) else { return }
        let credential = StoredAuthCredential(
            frontendAPIHost: host, clientCookie: cookie, activeSessionId: activeSessionId,
            workerToken: workerToken, workerTokenExpiresAt: workerTokenExpiresAt
        )
        guard let data = try? JSONEncoder().encode(credential), let text = String(data: data, encoding: .utf8) else { return }
        keychain.save(text)
    }

    private func extractClientCookie(host: String) -> String? {
        guard let url = URL(string: "https://\(host)") else { return nil }
        return HTTPCookieStorage.shared.cookies(for: url)?.first(where: { $0.name == "__client" })?.value
    }

    private func restoreCookie(_ value: String, host: String) {
        guard !value.isEmpty else { return }
        let properties: [HTTPCookiePropertyKey: Any] = [.name: "__client", .value: value, .domain: host, .path: "/", .secure: "TRUE"]
        guard let cookie = HTTPCookie(properties: properties) else { return }
        HTTPCookieStorage.shared.setCookie(cookie)
    }
}

// MARK: - OAuth via the system browser (macOS only)
//
// The window ASWebAuthenticationSession opens is Safari's shared web
// credential UI — the *system* browser, not a Clerk-branded modal — which is
// exactly what satisfies the platform contract's "no mounted Clerk UI" rule
// while still letting every screen inside this app stay Tími-designed.

#if canImport(AuthenticationServices) && canImport(AppKit)
extension AuthController {
    public func beginOAuth(provider: String) async {
        guard frontendAPIHost != nil else { errorMessage = "Tími could not reach Clerk. Check the Worker connection in Settings."; return }
        isBusy = true; errorMessage = nil
        defer { isBusy = false }
        do {
            let callbackURLString = "timivet://auth-callback"
            let data = try await clerkRequest(path: "/v1/client/sign_ins", method: "POST", form: [("strategy", provider), ("redirect_url", callbackURLString)])
            let signIn = try Self.clerkDecoder.decode(ClerkWireSignIn.self, from: data)
            track(signIn)
            guard let redirect = signIn.firstFactorVerification?.externalVerificationRedirectUrl, let redirectURL = URL(string: redirect) else {
                errorMessage = "Clerk did not return a browser sign-in link for that method in this configuration."
                return
            }
            _ = try await presentExternalSession(url: redirectURL, callbackScheme: "timivet")
            try await pollAfterExternalVerification()
        } catch let error as ClinicAPIError {
            errorMessage = error.message
        } catch is CancellationError {
            // The person closed the browser sheet — not an error worth showing.
        } catch {
            let name = provider.replacingOccurrences(of: "oauth_", with: "").capitalized
            errorMessage = "Sign-in with \(name) did not complete."
        }
    }

    private func presentExternalSession(url: URL, callbackScheme: String) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) { callbackURL, error in
                if let callbackURL { continuation.resume(returning: callbackURL) }
                else { continuation.resume(throwing: error ?? ClinicAPIError.invalidResponse) }
            }
            session.presentationContextProvider = presentationProvider
            session.prefersEphemeralWebBrowserSession = false
            webAuthSession = session
            session.start()
        }
    }

    private func pollAfterExternalVerification() async throws {
        for _ in 0..<20 {
            let client = try await getClient()
            let sessionId = client.lastActiveSessionId ?? client.sessions?.first(where: { $0.status == "active" })?.id
            if let sessionId {
                activeSessionId = sessionId
                try await mintWorkerToken()
                saveCredential()
                await proceedAfterSignIn()
                return
            }
            try await Task.sleep(for: .milliseconds(500))
        }
        throw ClinicAPIError.server("Sign-in did not complete in time. Try again.")
    }
}

@MainActor private final class OAuthPresentationProvider: NSObject, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        NSApp.keyWindow ?? NSApp.windows.first ?? ASPresentationAnchor()
    }
}
#else
extension AuthController {
    public func beginOAuth(provider: String) async {
        errorMessage = "Sign-in with that method is not available in this build."
    }
}
#endif

// MARK: - Clerk Frontend API wire model (private: implementation detail only)

private struct ClerkWireFactor: Decodable {
    var strategy: String
    var emailAddressId: String?
    var phoneNumberId: String?
    var safeIdentifier: String?
}

private struct ClerkWireVerification: Decodable {
    var status: String?
    var strategy: String?
    var externalVerificationRedirectUrl: String?
}

private struct ClerkWireSignIn: Decodable {
    var id: String?
    var status: String?
    var supportedFirstFactors: [ClerkWireFactor]?
    var createdSessionId: String?
    var firstFactorVerification: ClerkWireVerification?
}

private struct ClerkWireSession: Decodable {
    var id: String
    var status: String?
    var lastActiveOrganizationId: String?
}

private struct ClerkWireClient: Decodable {
    var sessions: [ClerkWireSession]?
    var lastActiveSessionId: String?
}

private struct ClerkWireToken: Decodable { var jwt: String }

private struct ClerkWireOrganization: Decodable {
    var id: String
    var name: String
    var slug: String?
}

private struct ClerkWireOrganizationMembership: Decodable {
    var id: String?
    var organization: ClerkWireOrganization?
    var role: String?
}

private struct ClerkWireListEnvelope<T: Decodable>: Decodable { var data: [T]? }
