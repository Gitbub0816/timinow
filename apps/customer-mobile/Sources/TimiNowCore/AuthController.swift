import Foundation
import Observation

// Custom-UI Clerk sign-in, driven directly against Clerk's Frontend API
// (`/v1/client/...`) as docs/PLATFORM-CONTRACT.md's "Authentication UI rule"
// requires — no `@clerk/clerk-js` mount, no Clerk-hosted screen.
//
// A port of the veterinary console's AuthController, which signs in against
// this same Clerk instance today. What is deliberately absent: the workspace
// picker, because a pet owner belongs to no organization, and the OAuth and
// passkey paths, which need Apple-only frameworks that Skip cannot transpile.
//
// What is deliberately added: sign-up. The console assumes an account exists
// because a clinic was invited to one. A pet owner arrives without one, and
// being told "we couldn't find your account" with no way forward is the end of
// the road. So one email field serves both: sign in if Clerk knows the
// address, create an account if it does not, and a single code screen finishes
// either.

public enum AuthStage: String, Sendable {
    case identifier
    case strategyPicker
    case password
    case code
    case signedIn
}

public struct AuthFactorOption: Identifiable, Hashable, Sendable {
    public var strategy: String
    public var label: String
    public var id: String { strategy }
}

@MainActor @Observable public final class AuthController: @unchecked Sendable {
    public var stage: AuthStage = .identifier
    public var identifierText = ""
    public var passwordText = ""
    public var codeText = ""
    public var factorOptions: [AuthFactorOption] = []
    public var selectedFactor: AuthFactorOption?
    public var isBusy = false
    public var errorMessage: String?
    /// True once Clerk has a session and a Worker token has been minted from
    /// it. The Worker is the thing that has to accept the token, so nothing
    /// here claims success before one exists.
    public var isSignedIn = false
    /// Set from `/api/config`. A deployment with sign-in switched off should
    /// not show a wall, so the gate reads this rather than assuming.
    public var signInRequired = true
    /// The address being signed in with, for the code screen to name.
    public var pendingIdentifier = ""
    /// Whether the code on screen will create an account or open an existing
    /// one — the wording differs and guessing it is worse than tracking it.
    public var isCreatingAccount = false

    private let gateway: TimiGateway
    private let keychain = KeychainStore()

    private var publishableKey: String?
    private var frontendAPIHost: String?
    private var tokenTemplate: String?
    private var pendingSignInId: String?
    private var pendingSignUpId: String?
    private var pendingFactors: [ClerkWireFactor] = []
    private var activeSessionId: String?
    private var workerToken: String?
    private var workerTokenExpiresAt: Date?

    private static let clerkDecoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }()

    public init(gateway: TimiGateway) {
        self.gateway = gateway
    }

    // MARK: - Launch

    /// Resolves the Clerk instance from `/api/config`, then resumes a stored
    /// session with no interaction. This is what makes signing in a one-time
    /// event rather than something that greets you at every launch.
    public func start() async {
        isBusy = true
        defer { isBusy = false }

        do {
            let config = try await gateway.fetchAppConfig()
            publishableKey = config.clerkPublishableKey
            tokenTemplate = config.clerkTokenTemplate
            signInRequired = config.signInRequired ?? true
            if let key = publishableKey { frontendAPIHost = Self.decodeFrontendAPIHost(key) }
        } catch {
            // Offline, or the Worker is unreachable. Sign-in waits rather than
            // claiming the account is at fault.
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
            guard let sessionId = activeSessionId,
                  (client.sessions ?? []).contains(where: { $0.id == sessionId && $0.status == "active" }) else {
                signOutLocally()
                return
            }
            _ = try await ensureFreshToken()
            markSignedIn()
        } catch {
            signOutLocally()
        }
    }

    // MARK: - Email or phone

    public func submitIdentifier() async {
        let identifier = identifierText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !identifier.isEmpty else { errorMessage = "Enter your email or mobile number."; return }
        guard frontendAPIHost != nil else {
            errorMessage = "Tími could not reach the sign-in service. Check your connection and try again."
            return
        }
        isBusy = true; errorMessage = nil
        pendingIdentifier = identifier
        defer { isBusy = false }
        do {
            let data = try await clerkRequest(path: "/v1/client/sign_ins", method: "POST", form: [("identifier", identifier)])
            let signIn = try Self.clerkDecoder.decode(ClerkWireSignIn.self, from: data)
            isCreatingAccount = false
            track(signIn)
            if signIn.status == "complete" { try await completeIfNeeded(signIn); return }
            factorOptions = Self.labelFactors(pendingFactors)
            if factorOptions.isEmpty {
                errorMessage = "This account has no supported sign-in method."
            } else if factorOptions.count == 1, let only = factorOptions.first {
                await choose(only)
            } else {
                stage = .strategyPicker
            }
        } catch let error as TimiAPIError {
            // No account yet is the normal case for a pet owner, not an error
            // to report. Creating one is the same two screens.
            if Self.looksLikeUnknownAccount(error) {
                await beginSignUp(identifier: identifier)
            } else {
                errorMessage = error.message
            }
        } catch {
            errorMessage = "Tími could not start sign-in. Check your connection and try again."
        }
    }

    /// Creates the account and sends a code. Reached only when Clerk says it
    /// does not know the address.
    private func beginSignUp(identifier: String) async {
        errorMessage = nil
        isCreatingAccount = true
        let isEmail = identifier.contains("@")
        do {
            let data = try await clerkRequest(
                path: "/v1/client/sign_ups", method: "POST",
                form: [(isEmail ? "email_address" : "phone_number", identifier)]
            )
            let signUp = try Self.clerkDecoder.decode(ClerkWireSignUp.self, from: data)
            pendingSignUpId = signUp.id
            if signUp.status == "complete" { try await completeSignUpIfNeeded(signUp); return }
            guard let signUpId = signUp.id else {
                errorMessage = "Tími could not create that account."
                return
            }
            let strategy = isEmail ? "email_code" : "phone_code"
            _ = try await clerkRequest(
                path: "/v1/client/sign_ups/\(signUpId)/prepare_verification", method: "POST",
                form: [("strategy", strategy)]
            )
            selectedFactor = AuthFactorOption(strategy: strategy, label: isEmail ? "Email code" : "Text message code")
            stage = .code
        } catch let error as TimiAPIError {
            errorMessage = error.message
        } catch {
            errorMessage = "Tími could not create an account for that address."
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
        } catch let error as TimiAPIError {
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
        } catch let error as TimiAPIError {
            errorMessage = error.message
        } catch {
            errorMessage = "That password was not accepted."
        }
    }

    public func submitCode() async {
        let code = codeText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard code.count >= 4 else { errorMessage = "Enter the code we sent you."; return }
        guard let strategy = selectedFactor?.strategy else { return }
        isBusy = true; errorMessage = nil
        defer { isBusy = false }
        do {
            if isCreatingAccount, let signUpId = pendingSignUpId {
                let data = try await clerkRequest(
                    path: "/v1/client/sign_ups/\(signUpId)/attempt_verification", method: "POST",
                    form: [("strategy", strategy), ("code", code)]
                )
                let signUp = try Self.clerkDecoder.decode(ClerkWireSignUp.self, from: data)
                try await completeSignUpIfNeeded(signUp)
            } else if let signInId = pendingSignInId {
                let data = try await clerkRequest(
                    path: "/v1/client/sign_ins/\(signInId)/attempt_first_factor", method: "POST",
                    form: [("strategy", strategy), ("code", code)]
                )
                let signIn = try Self.clerkDecoder.decode(ClerkWireSignIn.self, from: data)
                try await completeIfNeeded(signIn)
            }
        } catch let error as TimiAPIError {
            errorMessage = error.message
        } catch {
            errorMessage = "That code was not accepted."
        }
    }

    public func startOver() {
        pendingSignInId = nil; pendingSignUpId = nil; pendingFactors = []
        factorOptions = []; selectedFactor = nil
        passwordText = ""; codeText = ""
        isCreatingAccount = false
        errorMessage = nil
        stage = .identifier
    }

    // MARK: - Completion

    private func completeIfNeeded(_ signIn: ClerkWireSignIn) async throws {
        track(signIn)
        guard signIn.status == "complete", let sessionId = signIn.createdSessionId else {
            errorMessage = "Additional verification is required for this account."
            return
        }
        try await finish(sessionId: sessionId)
    }

    private func completeSignUpIfNeeded(_ signUp: ClerkWireSignUp) async throws {
        pendingSignUpId = signUp.id
        guard signUp.status == "complete", let sessionId = signUp.createdSessionId else {
            errorMessage = "That account needs another step before it can be used."
            return
        }
        try await finish(sessionId: sessionId)
    }

    private func finish(sessionId: String) async throws {
        activeSessionId = sessionId
        try await mintWorkerToken()
        saveCredential()
        markSignedIn()
    }

    private func markSignedIn() {
        gateway.bearerToken = workerToken
        isSignedIn = activeSessionId != nil && workerToken != nil
        stage = isSignedIn ? .signedIn : .identifier
        if isSignedIn { passwordText = ""; codeText = "" }
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
        pendingSignInId = nil; pendingSignUpId = nil; pendingFactors = []
        keychain.clear()
        gateway.bearerToken = nil
        identifierText = ""; passwordText = ""; codeText = ""
        pendingIdentifier = ""; isCreatingAccount = false
        factorOptions = []; selectedFactor = nil
        isSignedIn = false
        stage = .identifier
    }

    /// A Worker token, minted fresh when the one in hand is close to expiring.
    /// Ten seconds of headroom so a request in flight does not land expired.
    @discardableResult
    public func ensureFreshToken() async throws -> String {
        guard activeSessionId != nil else { throw TimiAPIError.invalidConfiguration("") }
        if let token = workerToken, let expiry = workerTokenExpiresAt, expiry > Date().addingTimeInterval(10) {
            gateway.bearerToken = token
            return token
        }
        try await mintWorkerToken()
        saveCredential()
        guard let token = workerToken else { throw TimiAPIError.invalidConfiguration("") }
        gateway.bearerToken = token
        return token
    }

    // MARK: - Clerk Frontend API

    private func track(_ signIn: ClerkWireSignIn) {
        pendingSignInId = signIn.id
        pendingFactors = signIn.supportedFirstFactors ?? []
    }

    private func getClient() async throws -> ClerkWireClient {
        let data = try await clerkRequest(path: "/v1/client")
        return try Self.clerkDecoder.decode(ClerkWireClient.self, from: data)
    }

    private func mintWorkerToken() async throws {
        guard let sessionId = activeSessionId else { throw TimiAPIError.invalidConfiguration("") }
        let template = tokenTemplate ?? "timinow"
        if let token = try? await mintToken(sessionId: sessionId, template: template) {
            workerToken = token.jwt
        } else if let token = try? await mintToken(sessionId: sessionId, template: nil) {
            workerToken = token.jwt
        } else {
            throw TimiAPIError.server(status: 0, code: "CLERK_NO_TOKEN", message: "Clerk did not return a session token.", path: "/v1/client/sessions")
        }
        workerTokenExpiresAt = workerToken.flatMap(Self.parseJWTExpiry) ?? Date().addingTimeInterval(60)
    }

    private func mintToken(sessionId: String, template: String?) async throws -> ClerkWireToken {
        let path = template.map { "/v1/client/sessions/\(sessionId)/tokens/\($0)" } ?? "/v1/client/sessions/\(sessionId)/tokens"
        let data = try await clerkRequest(path: path, method: "POST", form: [])
        return try Self.clerkDecoder.decode(ClerkWireToken.self, from: data)
    }

    /// One request against Clerk's Frontend API. Every call carries
    /// `_clerk_js_version=5` (matching the headless `@clerk/clerk-js@5` the web
    /// surfaces load) and unwraps FAPI's `{ "response": ... }` envelope.
    private func clerkRequest(path: String, method: String = "GET", form: [(String, String?)]? = nil) async throws -> Data {
        guard let host = frontendAPIHost else { throw TimiAPIError.invalidConfiguration("") }
        guard var components = URLComponents(string: "https://\(host)\(path)") else {
            throw TimiAPIError.invalidResponse(path: path)
        }
        var query = components.queryItems ?? []
        query.append(URLQueryItem(name: "_clerk_js_version", value: "5"))
        components.queryItems = query
        guard let url = components.url else { throw TimiAPIError.invalidResponse(path: path) }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpShouldHandleCookies = true
        if let form {
            request.httpBody = Self.encodeForm(form)
            request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw TimiAPIError.transport(reason: error.localizedDescription, path: "https://\(host)\(path)")
        }
        guard let http = response as? HTTPURLResponse else { throw TimiAPIError.invalidResponse(path: path) }
        guard (200..<300).contains(http.statusCode) else {
            throw TimiAPIError.server(status: http.statusCode, code: Self.extractClerkCode(data), message: Self.extractClerkError(data), path: path)
        }
        return Self.unwrapResponse(data)
    }

    /// Clerk reports an unrecognised identifier as a 422 whose code is
    /// `form_identifier_not_found`. That is not a failure for a consumer app —
    /// it is a new customer.
    private static func looksLikeUnknownAccount(_ error: TimiAPIError) -> Bool {
        if case .server(_, let code, let message, _) = error {
            if let code, code.contains("identifier_not_found") { return true }
            return message.lowercased().contains("couldn't find your account")
                || message.lowercased().contains("could not find your account")
        }
        return false
    }

    private static func unwrapResponse(_ data: Data) -> Data {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let inner = object["response"] else { return data }
        return (try? JSONSerialization.data(withJSONObject: inner)) ?? data
    }

    private static func firstClerkError(_ data: Data) -> [String: Any]? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let errors = object["errors"] as? [[String: Any]] else { return nil }
        return errors.first
    }

    private static func extractClerkError(_ data: Data) -> String {
        guard let first = firstClerkError(data) else { return "Sign-in failed." }
        if let long = first["long_message"] as? String, !long.isEmpty { return long }
        if let message = first["message"] as? String, !message.isEmpty { return message }
        return "Sign-in failed."
    }

    private static func extractClerkCode(_ data: Data) -> String? {
        firstClerkError(data)?["code"] as? String
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

    /// `pk_(test|live)_` + base64("<host>$"). The same algorithm Clerk's own JS
    /// SDK uses, which is why one key is enough to find the instance.
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
            case "email_code": label = "Email me a code"
            case "phone_code": label = "Text me a code"
            case "reset_password_email_code": label = "Reset password by email"
            default: label = factor.strategy.replacingOccurrences(of: "_", with: " ").capitalized
            }
            options.append(AuthFactorOption(strategy: factor.strategy, label: label))
        }
        return options
    }

    // MARK: - Persistence

    /// The Clerk `__client` cookie is the long-lived credential; the Worker
    /// token is short-lived and re-minted from it. One JSON blob, one Keychain
    /// item.
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

// MARK: - Clerk Frontend API wire model (implementation detail only)

private struct ClerkWireFactor: Decodable {
    var strategy: String
    var emailAddressId: String?
    var phoneNumberId: String?
    var safeIdentifier: String?
}

private struct ClerkWireSignIn: Decodable {
    var id: String?
    var status: String?
    var supportedFirstFactors: [ClerkWireFactor]?
    var createdSessionId: String?
}

private struct ClerkWireSignUp: Decodable {
    var id: String?
    var status: String?
    var createdSessionId: String?
}

private struct ClerkWireSession: Decodable {
    var id: String
    var status: String?
}

private struct ClerkWireClient: Decodable {
    var sessions: [ClerkWireSession]?
    var lastActiveSessionId: String?
}

private struct ClerkWireToken: Decodable { var jwt: String }
