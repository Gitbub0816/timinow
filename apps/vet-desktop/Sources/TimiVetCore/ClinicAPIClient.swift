import Foundation

// Swift port of apps/vet-windows/src/TimiVet/Services/ClinicApiClient.cs.
//
// Skip rules honored here (see scripts/validate-native.mjs for the customer
// app's equivalent checks):
//   - URLSession never appears in a public initializer signature.
//   - ClinicAPIError is a plain `Error` enum with a `message` payload; it does
//     NOT adopt `LocalizedError` or define `errorDescription`, because Skip
//     cannot translate that Swift-only conformance to Kotlin.

public enum ClinicAPIError: Error, Sendable {
    case invalidConfiguration
    case signInRequired
    case server(String)
    case invalidResponse

    public var message: String {
        switch self {
        case .invalidConfiguration: return "Enter the HTTPS address of your Tími Worker in Settings."
        case .signInRequired: return "Sign in to Tími before contacting a production Worker."
        case .server(let message): return message
        case .invalidResponse: return "The Tími API returned a response it could not read."
        }
    }
}

/// Lets `ClinicAPIClient` attach a live Clerk session token without holding a
/// strong (or even a type-level) dependency on `AuthController` — avoids a
/// retain cycle and keeps the two types independently testable. AuthController
/// conforms to this in the same file it is declared.
public protocol ClinicSessionTokenProviding: AnyObject, Sendable {
    /// `async` because the real conformer (`AuthController`) is
    /// `@MainActor`-isolated; a plain synchronous requirement could not be
    /// satisfied by an actor-isolated computed property.
    var hasSession: Bool { get async }
    /// Returns the current token, minting or refreshing it first only if it is
    /// missing or near expiry.
    func ensureFreshToken() async throws -> String
    /// Unconditionally mints a new token — used once after a 401.
    func forceRefreshToken() async throws -> String
}

/// Talks to the veterinary console API (`/api/clinic/*`, `/api/session`,
/// `/api/config`, `/api/tenant/members`) or, when no HTTPS base URL is
/// configured, falls back to `DemoClinicData` exactly like the Windows client.
public final class ClinicAPIClient: @unchecked Sendable {
    private static let json = JSONEncoder()
    private static let decoder = JSONDecoder()
    private let session = URLSession.shared
    private let demo = DemoClinicData()
    private var settings: AppSettings

    /// Set once by `AuthController` after it constructs both objects. `weak`
    /// so the two types never form a retain cycle.
    public weak var tokenProvider: ClinicSessionTokenProviding?

    public init(settings: AppSettings) {
        self.settings = settings
    }

    /// True when no HTTPS Worker URL has been configured — the console runs on
    /// local fixture data, same as the Windows app's demo mode.
    public var isDemo: Bool {
        guard let url = URL(string: settings.apiBaseUrl), url.scheme == "https" else { return true }
        return false
    }

    public func updateSettings(_ settings: AppSettings) { self.settings = settings }

    // MARK: - Clinic dashboard

    public func getDashboard() async throws -> ClinicDashboard {
        if isDemo { return demo.dashboard() }
        return try await send("GET", "/api/clinic/dashboard")
    }

    public func publishAvailability(_ update: AvailabilityUpdate) async throws {
        if isDemo { demo.publish(update); return }
        try await sendVoid("POST", "/api/clinic/availability", body: update)
    }

    public func respond(to item: ClinicRequest, decision: DecisionPayload) async throws {
        if isDemo { try demo.decide(id: item.id, decision: decision); return }
        if item.searchTarget {
            let payload = SearchDecisionPayload(
                decision: decision.decision, responseType: decision.responseType, availableAt: decision.availableAt,
                arrivalWindowMinutes: decision.arrivalWindowMinutes, holdMinutes: decision.holdMinutes,
                waitMin: decision.waitMin, waitMax: decision.waitMax, note: decision.note
            )
            let path = "/api/clinic/search-targets/\(Self.escape(item.id))/decision"
            try await sendVoid("POST", path, body: payload)
        } else {
            let payload = IntakeDecisionPayload(
                decision: decision.decision == "offer" ? "accept" : "decline",
                arrivalWindowMinutes: decision.arrivalWindowMinutes, note: decision.note
            )
            let path = "/api/clinic/intakes/\(Self.escape(item.id))/decision"
            try await sendVoid("POST", path, body: payload)
        }
    }

    // MARK: - Session, config

    public func getSession() async throws -> SessionDescriptor? {
        let envelope: SessionEnvelope = try await send("GET", "/api/session")
        return envelope.session
    }

    /// The address actually in use, for an error to quote. A blank one is the
    /// most common cause of "could not reach Clerk" and the least visible.
    public var configuredAddress: String {
        let address = settings.apiBaseUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        return address.isEmpty ? "no Worker address" : address
    }

    public func getConfig() async throws -> AppConfig {
        try await send("GET", "/api/config")
    }

    // MARK: - Calling preferences

    public func getCallPreferences() async throws -> CallPreferences {
        if isDemo { return CallPreferences(callsEnabled: true, voicePhone: nil, locationPhone: "(510) 555-0194", quietHours: nil) }
        let envelope: CallPreferencesEnvelope = try await send("GET", "/api/clinic/call-preferences")
        return envelope.preferences
    }

    public func updateCallPreferences(_ update: CallPreferencesUpdate) async throws -> CallPreferences {
        if isDemo { return CallPreferences(callsEnabled: update.callsEnabled ?? true, voicePhone: update.voicePhone, locationPhone: "(510) 555-0194") }
        let envelope: CallPreferencesEnvelope = try await send("PATCH", "/api/clinic/call-preferences", body: update)
        return envelope.preferences
    }

    // MARK: - Payouts

    /// What Tími has transferred to this clinic and what Stripe has paid out.
    ///
    /// The tenant is never a parameter: the Worker takes it from the session,
    /// so there is no shape of this call that reads another clinic's money.
    public func getPayouts() async throws -> ClinicPayouts {
        if isDemo { return demo.payouts() }
        return try await send("GET", "/api/clinic/payouts")
    }

    // MARK: - Analytics

    /// Fire-and-forget beacon to `POST /api/analytics`.
    ///
    /// Deliberately not routed through `buildRequest`: the endpoint is public
    /// and cookieless, so the beacon must carry no session token, demo header,
    /// or any other identifier. Failures are swallowed whole and never awaited
    /// — a metrics beacon that can surface an error, or hold up an intake
    /// decision, in a clinic's console has its priorities backwards.
    public func trackEvent(_ name: String, meta: [String: String]? = nil) {
        guard !isDemo, let base = try? resolvedBase(),
              let url = URL(string: "api/analytics", relativeTo: base)?.absoluteURL else { return }
        guard let body = try? Self.json.encode(AnalyticsPayload(events: [AnalyticsEvent(name: name, meta: meta)])) else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        let session = self.session
        Task { _ = try? await session.data(for: request) }
    }

    // MARK: - Tenant people management

    public func getMembers() async throws -> TenantRoster {
        try await send("GET", "/api/tenant/members")
    }

    public func addMember(email: String, role: String) async throws {
        try await sendVoid("POST", "/api/tenant/members", body: AddMemberPayload(email: email, role: role))
    }

    public func changeMemberRole(clerkUserId: String, role: String) async throws {
        let path = "/api/tenant/members/\(Self.escape(clerkUserId))"
        try await sendVoid("PATCH", path, body: RolePayload(role: role))
    }

    public func removeMember(clerkUserId: String) async throws {
        let path = "/api/tenant/members/\(Self.escape(clerkUserId))"
        try await sendVoid("DELETE", path, data: nil)
    }

    public func revokeInvitation(id: String) async throws {
        let path = "/api/tenant/invitations/\(Self.escape(id))"
        try await sendVoid("DELETE", path, data: nil)
    }

    // MARK: - Transport

    private func send<Response: Decodable>(_ method: String, _ path: String) async throws -> Response {
        let data = try await requestData(method, path, data: nil)
        do { return try Self.decoder.decode(Response.self, from: data) }
        catch { throw ClinicAPIError.invalidResponse }
    }

    private func send<Response: Decodable, Body: Encodable>(_ method: String, _ path: String, body: Body) async throws -> Response {
        let data = try await requestData(method, path, data: try Self.json.encode(body))
        do { return try Self.decoder.decode(Response.self, from: data) }
        catch { throw ClinicAPIError.invalidResponse }
    }

    /// For endpoints whose success body carries nothing the caller needs — the
    /// response is still fetched and status-checked, just never decoded, so an
    /// empty (or unexpectedly shaped) success body never surfaces as an error.
    private func sendVoid(_ method: String, _ path: String, data: Data?) async throws {
        _ = try await requestData(method, path, data: data)
    }

    private func sendVoid<Body: Encodable>(_ method: String, _ path: String, body: Body) async throws {
        _ = try await requestData(method, path, data: try Self.json.encode(body))
    }

    /// Sends one request and, on a 401 while a live Clerk session exists,
    /// force-refreshes the token and retries exactly once — mirroring the
    /// Windows client's `SendAsync`. Demo headers (`x-demo-role` /
    /// `x-demo-tenant-id`) are only ever attached when there is no session
    /// AND the resolved host is loopback — never against a production HTTPS
    /// Worker, matching the same fix just made on the Windows side.
    private func requestData(_ method: String, _ path: String, data: Data?) async throws -> Data {
        let base = try resolvedBase()
        let url = URL(string: path.trimmingCharacters(in: CharacterSet(charactersIn: "/")), relativeTo: base)?.absoluteURL ?? base

        var request = try await buildRequest(url: url, method: method, data: data)
        let (firstData, firstResponse) = try await session.data(for: request)
        guard let firstHTTP = firstResponse as? HTTPURLResponse else { throw ClinicAPIError.invalidResponse }

        if firstHTTP.statusCode == 401, let tokenProvider, await tokenProvider.hasSession {
            let refreshed = try await tokenProvider.forceRefreshToken()
            request.setValue("Bearer \(refreshed)", forHTTPHeaderField: "Authorization")
            let (retryData, retryResponse) = try await session.data(for: request)
            guard let retryHTTP = retryResponse as? HTTPURLResponse else { throw ClinicAPIError.invalidResponse }
            guard (200..<300).contains(retryHTTP.statusCode) else {
                throw ClinicAPIError.server(Self.extractMessage(retryData, status: retryHTTP.statusCode))
            }
            return retryData
        }

        guard (200..<300).contains(firstHTTP.statusCode) else {
            throw ClinicAPIError.server(Self.extractMessage(firstData, status: firstHTTP.statusCode))
        }
        return firstData
    }

    private func resolvedBase() throws -> URL {
        guard let base = URL(string: settings.apiBaseUrl.isEmpty ? "" : settings.apiBaseUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/") else {
            throw ClinicAPIError.invalidConfiguration
        }
        return base
    }

    private func buildRequest(url: URL, method: String, data: Data?) async throws -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        if let tokenProvider, await tokenProvider.hasSession {
            let token = try await tokenProvider.ensureFreshToken()
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        } else if Self.isLoopback(url) {
            request.setValue("clinic", forHTTPHeaderField: "x-demo-role")
            request.setValue(settings.tenantId, forHTTPHeaderField: "x-demo-tenant-id")
        } else if !Self.isPublic(url) {
            throw ClinicAPIError.signInRequired
        }

        if let data {
            request.httpBody = data
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    /// Endpoints the Worker answers to anyone, and that the console must reach
    /// *before* it can sign in.
    ///
    /// `/api/config` is where the Clerk publishable key comes from, so
    /// requiring a session to fetch it is a deadlock: no config, no Clerk host,
    /// no sign-in, no session, no config. The console reported it as "Could not
    /// read https://providers.timinow.pet/api/config — Sign in to Tími before
    /// contacting a production Worker", which reads as a Worker or a Clerk
    /// problem and is neither; the request was never sent. The Windows client
    /// never hit this only because its ClerkAuthService fetches /api/config
    /// with its own HttpClient instead of going through the gated one.
    private static func isPublic(_ url: URL) -> Bool {
        url.path.hasSuffix("/api/config")
    }

    private static func isLoopback(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return false }
        return host == "localhost" || host == "127.0.0.1" || host == "::1"
    }

    /// The Worker's own words, when it sent any.
    ///
    /// This looked for `message` at the top level and for `error` as a string.
    /// The Worker sends neither: every failure is
    /// `{"error": {"code": …, "message": …}}`, with `error` an object. So the
    /// message was found by nothing and every failure in this console read
    /// "Tími API error 404." — a number, with no route, no reason, and no way
    /// to tell a missing endpoint from a missing clinic. That is how a route
    /// the desktop consoles could not reach at all survived: the server said
    /// exactly what was wrong on every attempt, and the client threw it away.
    private static func extractMessage(_ data: Data, status: Int) -> String {
        if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let envelope = object["error"] as? [String: Any] {
                let message = envelope["message"] as? String ?? ""
                let code = envelope["code"] as? String ?? ""
                if !message.isEmpty { return code.isEmpty ? message : "\(message) (\(code))" }
                if !code.isEmpty { return code }
            }
            if let message = object["message"] as? String, !message.isEmpty { return message }
            if let error = object["error"] as? String, !error.isEmpty { return error }
        }
        return "Tími API error \(status)."
    }

    private static func escape(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }
}

// MARK: - Wire payloads (private: never leaves the public bridge surface)

/// Only the fields being changed are sent — an absent one is left alone, so
/// two administrators editing different settings do not overwrite each other.
public struct CallPreferencesUpdate: Encodable, Sendable {
    public var callsEnabled: Bool?
    public var voicePhone: String?
    public var quietHours: QuietHours?
    public init(callsEnabled: Bool? = nil, voicePhone: String? = nil, quietHours: QuietHours? = nil) {
        self.callsEnabled = callsEnabled; self.voicePhone = voicePhone; self.quietHours = quietHours
    }
}

private struct SearchDecisionPayload: Encodable {
    var decision: String
    var responseType: String
    var availableAt: String?
    var arrivalWindowMinutes: Int
    var holdMinutes: Int
    var waitMin: Int
    var waitMax: Int
    var note: String
}

private struct IntakeDecisionPayload: Encodable {
    var decision: String
    var arrivalWindowMinutes: Int
    var note: String
}

private struct AddMemberPayload: Encodable { var email: String; var role: String }
private struct RolePayload: Encodable { var role: String }

/// The console-analytics contract (POST /api/analytics): {events: [{name,
/// path?, meta?}]}, at most 25 events, and — because the endpoint is
/// cookieless by design — nothing that identifies the operator or the tenant.
private struct AnalyticsEvent: Encodable { var name: String; var meta: [String: String]? }
private struct AnalyticsPayload: Encodable { var events: [AnalyticsEvent] }
