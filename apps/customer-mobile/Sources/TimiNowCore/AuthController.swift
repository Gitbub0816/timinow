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
    /// Only reached when the address is new. Clerk's instance requires a phone
    /// number, the app wants a name to greet people by, and the intake form
    /// asks for all three every single time it is opened — so they are
    /// collected once, here, instead of on every care request.
    case profile
    case strategyPicker
    case password
    case code
    case signedIn
}

/// What sign-in learned about the person, for the rest of the app to stop
/// asking. Handed over the moment a session exists.
public struct AuthProfile: Sendable, Equatable {
    public var name: String
    public var email: String
    public var phone: String
    public init(name: String, email: String, phone: String) {
        self.name = name; self.email = email; self.phone = phone
    }
    public var isEmpty: Bool { name.isEmpty && email.isEmpty && phone.isEmpty }
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
    /// Collected on the sign-up screen. Prefilled from whatever was typed on
    /// the first screen, so nobody enters the same address twice.
    public var signUpName = ""
    public var signUpEmail = ""
    public var signUpPhone = ""
    /// Which field the code on screen is verifying, so the copy can name it.
    public var verifyingField = ""
    /// Called once a session exists, with everything known about the person.
    /// The store writes it into the intake defaults; nothing here reaches into
    /// the store, so the two stay independently testable.
    /// Non-optional with a no-op default: an optional closure on a
    /// Skip-bridged type generates a bridge that does not compile.
    public var onProfileResolved: (AuthProfile) -> Void = { _ in }

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
    /// Clerk's native client JWT, handed back in the `Authorization` response
    /// header and replayed in the request header — the native equivalent of
    /// the `__client` cookie a browser would carry.
    private var clerkDeviceToken: String?
    /// Native Frontend API mode (`_is_native=true`). Flipped off for the rest
    /// of the launch if the instance answers `native_api_disabled`, so an
    /// instance without the toggle still signs in the old cookie way.
    private var clerkNativeMode = true

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
        if let token = stored.clerkDeviceToken, !token.isEmpty {
            clerkDeviceToken = token
        } else if let cookie = stored.clientCookie, !cookie.isEmpty {
            // Saved before native mode existed. Resume it the way it was
            // written — a native `/v1/client` with no device token would be
            // handed a brand-new empty client and sign this person out for no
            // reason. `signOutLocally()` puts native mode back.
            clerkNativeMode = false
            restoreCookie(cookie, host: host)
        }
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
        let identifier = Self.normalizeIdentifier(identifierText)
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
                beginProfileEntry(identifier: identifier)
            } else {
                errorMessage = error.message
            }
        } catch {
            errorMessage = "Tími could not start sign-in. Check your connection and try again."
        }
    }

    /// No account yet. Ask for the rest before creating one.
    ///
    /// This used to POST /v1/client/sign_ups with the single address that had
    /// been typed. On this instance that can never complete — a phone number
    /// is required — and the app then asked for a name, a phone and an email
    /// again on every care request, having had a perfectly good place to keep
    /// them.
    private func beginProfileEntry(identifier: String) {
        errorMessage = nil
        isCreatingAccount = true
        if identifier.contains("@") {
            signUpEmail = identifier
            signUpPhone = ""
        } else {
            signUpPhone = identifier
            signUpEmail = ""
        }
        stage = .profile
    }

    /// Creates the account from the profile screen and sends the first code.
    public func submitProfile() async {
        let name = signUpName.trimmingCharacters(in: .whitespacesAndNewlines)
        let email = signUpEmail.trimmingCharacters(in: .whitespacesAndNewlines)
        let phone = Self.normalizeIdentifier(signUpPhone)
        guard !name.isEmpty else { errorMessage = "Enter your name so clinics know who to expect."; return }
        guard !email.isEmpty, email.contains("@") else { errorMessage = "Enter an email address."; return }
        guard phone.hasPrefix("+") else { errorMessage = "Enter a mobile number a clinic can reach you on."; return }
        signUpPhone = phone
        isBusy = true; errorMessage = nil
        defer { isBusy = false }
        do {
            let (first, last) = Self.splitName(name)
            let data = try await clerkRequest(
                path: "/v1/client/sign_ups", method: "POST",
                form: [
                    ("email_address", email),
                    ("phone_number", phone),
                    ("first_name", first),
                    ("last_name", last)
                ]
            )
            let signUp = try Self.clerkDecoder.decode(ClerkWireSignUp.self, from: data)
            pendingSignUpId = signUp.id
            if signUp.status == "complete" { try await completeSignUpIfNeeded(signUp); return }
            guard signUp.id != nil else {
                errorMessage = "Tími could not create that account."
                return
            }
            // `missing_fields` is what the instance still requires and this
            // screen cannot supply — distinct from `unverified_fields`, which
            // is just the code we are about to send. Sending a code that leads
            // to a dead end is worse than saying so now: the code arrives, it
            // is accepted, and the account still does not exist.
            if let blocker = Self.signUpBlocker(signUp.missingFields ?? []) {
                errorMessage = blocker
                return
            }
            try await prepareNextVerification(signUp)
        } catch let error as TimiAPIError {
            // Clerk's own wording for the CAPTCHA rejection is "Authentication
            // unsuccessful due to failed security validations. Please refresh
            // the page" — advice for a browser, on a screen that has no page to
            // refresh, naming nothing anyone can act on.
            errorMessage = Self.looksLikeCaptchaRequired(error)
                ? "Tími could not create the account. Clerk's bot protection is asking for a CAPTCHA this app cannot show — enable the Native API for this instance in the Clerk dashboard."
                : error.message
        } catch {
            errorMessage = "Tími could not create an account for those details."
        }
    }

    /// Clerk verifies each identifier separately, so a sign-up carrying both an
    /// email and a phone needs two codes. Rather than assume one, this asks
    /// Clerk what is still unverified and sends the next code — which also
    /// means an instance that only wants one is finished after one.
    private func prepareNextVerification(_ signUp: ClerkWireSignUp) async throws {
        let unverified = signUp.unverifiedFields ?? []
        let field = unverified.first(where: { $0 == "phone_number" }) ?? unverified.first
        guard let field else {
            errorMessage = "That account needs another step before it can be used."
            return
        }
        let strategy = field == "phone_number" ? "phone_code" : "email_code"
        guard let signUpId = pendingSignUpId else { return }
        _ = try await clerkRequest(
            path: "/v1/client/sign_ups/\(signUpId)/prepare_verification", method: "POST",
            form: [("strategy", strategy)]
        )
        verifyingField = field == "phone_number" ? signUpPhone : signUpEmail
        selectedFactor = AuthFactorOption(strategy: strategy, label: field == "phone_number" ? "Text message code" : "Email code")
        codeText = ""
        stage = .code
    }

    private static func splitName(_ name: String) -> (String, String) {
        let parts = name.split(separator: " ").map(String.init).filter { !$0.isEmpty }
        if parts.isEmpty { return ("", "") }
        if parts.count == 1 { return (parts[0], "") }
        return (parts[0], parts.dropFirst().joined(separator: " "))
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
        signUpName = ""; signUpEmail = ""; signUpPhone = ""; verifyingField = ""
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
            // Clerk has already said exactly what is left. If it is another
            // identifier to verify, send that code rather than stopping.
            if let blocker = Self.signUpBlocker(signUp.missingFields ?? []) {
                errorMessage = blocker
                return
            }
            if !(signUp.unverifiedFields ?? []).isEmpty {
                try await prepareNextVerification(signUp)
                return
            }
            errorMessage = "That account needs another step before it can be used."
            return
        }
        try await finish(sessionId: sessionId)
    }

    /// Turns Clerk's `missing_fields` into something a person can act on, or
    /// nil when nothing is in the way.
    private static func signUpBlocker(_ missing: [String]) -> String? {
        if missing.isEmpty { return nil }
        if missing.contains("password") {
            return "This Clerk instance requires a password to create an account, and Tími signs people in with a code instead. Make password optional under Configure → Email, phone, username."
        }
        if missing.contains("phone_number") {
            return "Tími needs a mobile number to create your account. Go back and enter your phone number instead of an email address."
        }
        if missing.contains("email_address") {
            return "Tími needs an email address to create your account. Go back and enter your email instead of a phone number."
        }
        return "Clerk needs \(missing.joined(separator: ", ")) before this account can be created, and Tími does not ask for that."
    }

    private func finish(sessionId: String) async throws {
        activeSessionId = sessionId
        try await mintWorkerToken()
        saveCredential()
        markSignedIn()
        await publishProfile()
    }

    /// Hands the rest of the app a name, an email and a phone number so it
    /// stops asking for them. For a new account they were just typed; for an
    /// existing one they come from Clerk, which is the only way somebody who
    /// signed up before this screen existed ever gets a prefilled intake form.
    private func publishProfile() async {
        var profile = AuthProfile(
            name: signUpName.trimmingCharacters(in: .whitespacesAndNewlines),
            email: signUpEmail.trimmingCharacters(in: .whitespacesAndNewlines),
            phone: signUpPhone.trimmingCharacters(in: .whitespacesAndNewlines)
        )
        if let user = try? await currentUser() {
            let full = [user.firstName ?? "", user.lastName ?? ""].filter { !$0.isEmpty }.joined(separator: " ")
            if !full.isEmpty { profile.name = full }
            if let email = (user.emailAddresses ?? []).first?.emailAddress, !email.isEmpty { profile.email = email }
            if let phone = (user.phoneNumbers ?? []).first?.phoneNumber, !phone.isEmpty { profile.phone = phone }
        }
        guard !profile.isEmpty else { return }
        onProfileResolved(profile)
    }

    private func currentUser() async throws -> ClerkWireUser? {
        let client = try await getClient()
        let sessions = client.sessions ?? []
        let match = sessions.first(where: { $0.id == activeSessionId }) ?? sessions.first
        return match?.user
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
        clerkDeviceToken = nil
        // Back to native for the next attempt, so a session resumed the old
        // cookie way does not leave sign-up stuck behind the CAPTCHA.
        clerkNativeMode = true
        pendingSignInId = nil; pendingSignUpId = nil; pendingFactors = []
        keychain.clear()
        gateway.bearerToken = nil
        identifierText = ""; passwordText = ""; codeText = ""
        signUpName = ""; signUpEmail = ""; signUpPhone = ""; verifyingField = ""
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

    /// One request against Clerk's Frontend API, in native mode.
    ///
    /// Native mode is what Clerk's own iOS SDK does: `_is_native=true` on every
    /// URL, the client JWT carried in the `Authorization` header instead of a
    /// `__client` cookie — and, the reason this app needs it, no bot
    /// protection. A browser clears Clerk's sign-up CAPTCHA by rendering a
    /// Turnstile widget; an app has no widget to render, so a web-mode
    /// `/v1/client/sign_ups` is rejected with `captcha_missing_token` and a
    /// pet owner without an account can never create one.
    ///
    /// If the instance has not enabled the Native API this falls back to the
    /// cookie path once and stays there — sign-in keeps working, only sign-up
    /// hits the CAPTCHA it hit before.
    private func clerkRequest(path: String, method: String = "GET", form: [(String, String?)]? = nil) async throws -> Data {
        do {
            return try await performClerkRequest(path: path, method: method, form: form)
        } catch let error as TimiAPIError {
            guard clerkNativeMode, Self.looksLikeNativeAPIDisabled(error) else { throw error }
            // Clerk rejects the request outright, before touching any state, so
            // replaying it web-style cannot double up a sign-in or a code.
            clerkNativeMode = false
            clerkDeviceToken = nil
            return try await performClerkRequest(path: path, method: method, form: form)
        }
    }

    private func performClerkRequest(path: String, method: String, form: [(String, String?)]?) async throws -> Data {
        guard let host = frontendAPIHost else { throw TimiAPIError.invalidConfiguration("") }
        guard var components = URLComponents(string: "https://\(host)\(path)") else {
            throw TimiAPIError.invalidResponse(path: path)
        }
        var query = components.queryItems ?? []
        if clerkNativeMode {
            query.append(URLQueryItem(name: "_is_native", value: "true"))
        } else {
            // `_clerk_js_version=5` matches the headless `@clerk/clerk-js@5`
            // the web surfaces load.
            query.append(URLQueryItem(name: "_clerk_js_version", value: "5"))
        }
        components.queryItems = query
        guard let url = components.url else { throw TimiAPIError.invalidResponse(path: path) }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        // Clerk refuses a request carrying both `Origin` and `Authorization`,
        // and treats the cookie jar as the browser path. Native mode is one or
        // the other, never a mix.
        request.httpShouldHandleCookies = !clerkNativeMode
        if clerkNativeMode, let token = clerkDeviceToken, !token.isEmpty {
            request.setValue(token, forHTTPHeaderField: "Authorization")
        }
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
        // Before the status check, not after: Clerk issues the client JWT on
        // failure responses too, and the sign-up flow reaches `/sign_ups` only
        // by way of the 422 that `/sign_ins` returns for an unknown address. A
        // token absorbed only from 2xx would leave that request unauthenticated.
        if clerkNativeMode { absorbDeviceToken(http) }
        guard (200..<300).contains(http.statusCode) else {
            throw TimiAPIError.server(status: http.statusCode, code: Self.extractClerkCode(data), message: Self.extractClerkError(data), path: path)
        }
        return Self.unwrapResponse(data)
    }

    /// An absent header means "unchanged"; an empty one, or a bare `Bearer`,
    /// means Clerk dropped the client and we must too.
    private func absorbDeviceToken(_ response: HTTPURLResponse) {
        guard let header = response.value(forHTTPHeaderField: "Authorization") else { return }
        let trimmed = header.trimmingCharacters(in: .whitespacesAndNewlines)
        clerkDeviceToken = (trimmed.isEmpty || trimmed.lowercased() == "bearer") ? nil : trimmed
    }

    /// Clerk wants a phone number in E.164. Typed the way anybody says it —
    /// "4152123721", "(415) 212-3721" — it is rejected as not a valid phone
    /// number, and the message describes a format rather than the fix. Email
    /// addresses and numbers already written with a country code pass through.
    private static func normalizeIdentifier(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.contains("@") { return trimmed }
        let punctuation = "+()-. "
        guard trimmed.allSatisfy({ $0.isNumber || punctuation.contains($0) }) else { return trimmed }
        let digits = trimmed.filter { $0.isNumber }
        if digits.isEmpty { return trimmed }
        if trimmed.hasPrefix("+") { return "+" + digits }
        if digits.count == 10 { return "+1" + digits }
        if digits.count == 11 && digits.hasPrefix("1") { return "+" + digits }
        return trimmed
    }

    private static func looksLikeCaptchaRequired(_ error: TimiAPIError) -> Bool {
        if case .server(_, let code, _, _) = error, let code { return code.contains("captcha") }
        return false
    }

    private static func looksLikeNativeAPIDisabled(_ error: TimiAPIError) -> Bool {
        if case .server(_, let code, let message, _) = error {
            if let code, code.contains("native_api_disabled") { return true }
            return message.lowercased().contains("native api is disabled")
        }
        return false
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
        // Clerk returns the password-reset strategies alongside the real ones.
        // Offering "Reset password by text" next to "Text me a code" turns a
        // one-tap sign-in into a choice between two things that read the same,
        // one of which is not sign-in at all — and it is what stopped a
        // phone-only account, whose single real factor is phone_code, from
        // being sent straight to the code screen.
        let usable = factors.filter { !$0.strategy.hasPrefix("reset_password") }
        for factor in (usable.isEmpty ? factors : usable) {
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
        /// Web-mode credential. Optional because a native sign-in never
        /// produces one, and because blobs written before native mode existed
        /// carry nothing else.
        var clientCookie: String?
        /// Native-mode credential — Clerk's client JWT.
        var clerkDeviceToken: String?
        var activeSessionId: String?
        var workerToken: String?
        var workerTokenExpiresAt: Date?
    }

    private func loadCredential() -> StoredAuthCredential? {
        guard let raw = keychain.load(), let data = raw.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(StoredAuthCredential.self, from: data)
    }

    private func saveCredential() {
        guard let host = frontendAPIHost else { return }
        let cookie = clerkNativeMode ? nil : extractClientCookie(host: host)
        // Nothing to resume from is worse than no Keychain item at all: it
        // would restore a host and a session id that no credential can renew.
        guard cookie != nil || clerkDeviceToken != nil else { return }
        let credential = StoredAuthCredential(
            frontendAPIHost: host, clientCookie: cookie, clerkDeviceToken: clerkDeviceToken,
            activeSessionId: activeSessionId,
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
    /// What the instance still requires. Not the same as `unverifiedFields`,
    /// which is only the codes still to be sent.
    var missingFields: [String]?
    var unverifiedFields: [String]?
}

private struct ClerkWireEmailAddress: Decodable { var emailAddress: String? }
private struct ClerkWirePhoneNumber: Decodable { var phoneNumber: String? }

private struct ClerkWireUser: Decodable {
    var firstName: String?
    var lastName: String?
    var emailAddresses: [ClerkWireEmailAddress]?
    var phoneNumbers: [ClerkWirePhoneNumber]?
}

private struct ClerkWireSession: Decodable {
    var id: String
    var status: String?
    var user: ClerkWireUser?
}

private struct ClerkWireClient: Decodable {
    var sessions: [ClerkWireSession]?
    var lastActiveSessionId: String?
}

private struct ClerkWireToken: Decodable { var jwt: String }
