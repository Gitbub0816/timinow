import Foundation

/// Every case carries enough to act on: which address, which path, which
/// status, which code.
///
/// Not `LocalizedError` — Skip cannot translate it, and there is a guard that
/// says so. That matters, because `error.localizedDescription` on a plain
/// Swift error gives "The operation couldn't be completed.
/// (TimiNowCore.TimiAPIError error 0.)", where 0 is the case's position in
/// this declaration and nothing else. So callers must read `.message`
/// instead — see AppStore.describe, which every catch block goes through.
public enum TimiAPIError: Error, Sendable {
    /// The configured Worker address, or empty when there is none.
    case invalidConfiguration(String)
    /// The Worker answered, and said no.
    case server(status: Int, code: String?, message: String, path: String)
    /// The Worker answered with something that is not the expected shape.
    case invalidResponse(path: String)
    /// The Worker was never reached: offline, DNS, TLS, timeout.
    case transport(reason: String, path: String)

    public var message: String {
        switch self {
        case .invalidConfiguration(let address):
            return address.isEmpty
                ? "No Tími Worker address is set. Add one in Settings."
                : "\(address) is not a usable address. It must start with https:// and name a host."
        case .server(let status, let code, let message, let path):
            let label = code.map { " [\($0)]" } ?? ""
            return "\(message) (\(status)\(label) from \(path))"
        case .invalidResponse(let path):
            return "Tími could not read the response from \(path)."
        case .transport(let reason, let path):
            return "Could not reach \(path): \(reason)"
        }
    }

}

/// Lets the gateway mint a live Clerk token for every request without holding
/// a type-level dependency on `AuthController`.
///
/// `async` because the real conformer is `@MainActor`-isolated, and spelled
/// `get async` because Skip transpiles the requirement to a suspend function —
/// a plain getter would leave the Kotlin class with an unimplemented member.
public protocol TimiSessionTokenProviding: AnyObject, Sendable {
    var hasSession: Bool { get async }
    /// The current token, re-minted first if it is missing or near expiry.
    func ensureFreshToken() async throws -> String
    /// Unconditionally mints a new one — used once, after a 401.
    func forceRefreshToken() async throws -> String
}

public final class TimiGateway: @unchecked Sendable {
    public var baseURL: URL?
    public var bearerToken: String?
    /// Set by `AppStore` once both objects exist. `weak`, so the two never
    /// form a retain cycle.
    public weak var tokenProvider: TimiSessionTokenProviding?
    private let session: URLSession
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(baseURL: URL? = nil, bearerToken: String? = nil) {
        self.baseURL = baseURL; self.bearerToken = bearerToken; self.session = .shared
    }

    public var isDemo: Bool { baseURL == nil }

    /// What the gateway was actually pointed at, for an error to quote. The
    /// address the user typed is held by AppStore; this is what survived
    /// validation, which is the one that matters when a call fails.
    public var configuredAddress: String { baseURL?.absoluteString ?? "" }

    /// `lat`, `lng`, `radius` — the names the Worker reads.
    ///
    /// This sent `latitude`, `longitude` and `radiusMiles`, none of which
    /// `handleLocationSearch` looks for, so it received no coordinates at all:
    /// no distance on any clinic, no radius filter, and the list sorted
    /// alphabetically by name. The phone app has never once shown the nearest
    /// hospital. The web client (public/app.js) has used the right names all
    /// along.
    public func locations(latitude: Double, longitude: Double, species: PetSpecies, care: String = "urgent", radiusMiles: Int = 50) async throws -> [ClinicLocation] {
        guard let baseURL else { return DemoData.clinics }
        var components = URLComponents(url: baseURL.appendingPathComponent("api/locations"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "lat", value: String(latitude)), URLQueryItem(name: "lng", value: String(longitude)),
            URLQueryItem(name: "radius", value: String(radiusMiles)), URLQueryItem(name: "species", value: species.rawValue),
            URLQueryItem(name: "care", value: care)
        ]
        let envelope: LocationsEnvelope = try await send(components.url!)
        return envelope.locations
    }

    /// Emergency-capable hospitals near a point — Tími's own and everyone
    /// else's.
    ///
    /// This asked `/api/locations?care=emergency`, which is the Tími network
    /// and only the Tími network. In a city with three partners that is a list
    /// of three, and the nearest actual emergency hospital is not on it. The
    /// Worker now merges map data, so the answer is the hospitals that exist
    /// rather than the ones we have signed.
    public func emergencyPlaces(latitude: Double, longitude: Double, species: PetSpecies) async throws -> EmergencyPlacesEnvelope {
        guard let baseURL else {
            return EmergencyPlacesEnvelope(notice: nil, places: DemoData.clinics.prefix(3).map { clinic in
                EmergencyPlace(id: clinic.id, source: "timi", partner: true, name: clinic.name, address: clinic.address, phone: clinic.phone, latitude: clinic.latitude, longitude: clinic.longitude, distanceMiles: clinic.distanceMiles, emergencyNamed: true)
            })
        }
        var components = URLComponents(url: baseURL.appendingPathComponent("api/emergency-nearby"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "lat", value: String(latitude)), URLQueryItem(name: "lng", value: String(longitude)),
            URLQueryItem(name: "radius", value: "60"), URLQueryItem(name: "species", value: species.rawValue)
        ]
        return try await send(components.url!)
    }

    public func startSearch(_ draft: CareDraft, locationIds: [String]) async throws -> CareSearch {
        guard let baseURL else { return DemoData.search(for: draft) }
        let payload = StartSearchPayload(
            locationIds: locationIds, targetLimit: 30, radiusMiles: 50,
            pet: PetPayload(
                name: draft.pet.name, species: draft.pet.species.rawValue, breed: draft.pet.breed, weightLbs: draft.pet.weightLbs,
                medications: draft.pet.medications.isEmpty ? nil : draft.pet.medications,
                allergies: draft.pet.allergies.isEmpty ? nil : draft.pet.allergies
            ),
            owner: OwnerPayload(name: draft.ownerName, phone: draft.ownerPhone, email: draft.ownerEmail.isEmpty ? nil : draft.ownerEmail),
            concernCategory: draft.urgency == .emergency ? "possible_emergency" : "illness_or_injury", concernSummary: draft.summary,
            symptoms: draft.symptomKeys, startedWhen: draft.startedWhen, urgency: draft.urgency.rawValue, redFlags: draft.redFlags,
            customerLatitude: draft.latitude, customerLongitude: draft.longitude, consentToContact: draft.contactConsent,
            legalConsent: draft.legalConsent, legalVersion: TimiLegal.version
        )
        let envelope: CareSearchEnvelope = try await send(baseURL.appendingPathComponent("api/searches"), method: "POST", body: payload)
        return envelope.search
    }

    public func refreshSearch(_ id: String) async throws -> CareSearch {
        guard let baseURL else { throw TimiAPIError.invalidConfiguration(configuredAddress) }
        let envelope: CareSearchEnvelope = try await send(baseURL.appendingPathComponent("api/searches/\(id)"))
        return envelope.search
    }

    public func selectOffer(search: CareSearch, offer: CareOffer) async throws -> IntakeEnvelope {
        guard let baseURL else {
            let now = ISO8601DateFormatter().string(from: Date())
            let intake = CareIntake(id: "demo_intake_\(UUID().uuidString)", publicCode: search.publicCode, locationId: offer.locationId, tenantId: offer.tenantId, pet: search.pet, owner: search.owner, concernSummary: search.concernSummary, urgency: search.urgency, redFlags: search.redFlags, status: "accepted", clinicNote: offer.clinicNote, requestedAt: search.requestedAt, decisionAt: now, requestExpiresAt: offer.expiresAt, arrivalBy: offer.arrivalBy, policy: offer.policy, depositAmountCents: offer.depositAmountCents, paymentStatus: (offer.depositAmountCents ?? 0) > 0 ? "pending" : "not_required", sourceSearchId: search.id, selectedOfferId: offer.id, location: offer.location)
            var updated = search; updated.status = "selected"; updated.selectedOfferId = offer.id; updated.selectedIntakeId = intake.id
            return IntakeEnvelope(intake: intake, location: offer.location, search: updated)
        }
        return try await send(baseURL.appendingPathComponent("api/searches/\(search.id)/select-offer"), method: "POST", body: OfferSelectionPayload(offerId: offer.id))
    }

    public func refreshIntake(_ id: String) async throws -> CareIntake {
        guard let baseURL else { throw TimiAPIError.invalidConfiguration(configuredAddress) }
        let envelope: IntakeEnvelope = try await send(baseURL.appendingPathComponent("api/intakes/\(id)"))
        return envelope.intake
    }

    public func updateIntake(_ id: String, status: String) async throws -> CareIntake {
        guard let baseURL else { throw TimiAPIError.invalidConfiguration(configuredAddress) }
        let envelope: IntakeEnvelope = try await send(baseURL.appendingPathComponent("api/intakes/\(id)/status"), method: "POST", body: StatusPayload(status: status))
        return envelope.intake
    }

    public func recordObservation(intake: CareIntake, milestone: String) async throws {
        guard let baseURL else { return }
        let _: ObservationEnvelope = try await send(baseURL.appendingPathComponent("api/observations"), method: "POST", body: ObservationPayload(intakeId: intake.id, locationId: intake.locationId, milestone: milestone))
    }

    /// The terms and safety notice this build accepts against.
///
/// The Worker rejects a care request whose `legalVersion` is not exactly its
/// own — `LEGAL_VERSION` in src/catalog.js — so a version bumped in one place
/// and not the other is a 422 on the last screen of the flow with no
/// explanation attached to the notice that changed.
/// What goes to the Worker when something fails. Never rendered.
public struct ClientErrorReport: Encodable, Sendable {
    public var surface: String
    public var appVersion: String?
    public var path: String?
    public var status: Int?
    public var code: String?
    public var message: String?
    public var reference: String?
    public var clerkUserId: String?
    public var detail: [String: String]?

    public init(surface: String = "customer_ios", appVersion: String? = nil, path: String? = nil, status: Int? = nil, code: String? = nil, message: String? = nil, reference: String? = nil, clerkUserId: String? = nil, detail: [String: String]? = nil) {
        self.surface = surface; self.appVersion = appVersion; self.path = path; self.status = status
        self.code = code; self.message = message; self.reference = reference
        self.clerkUserId = clerkUserId; self.detail = detail
    }
}

public enum TimiLegal {
    public static let version = "2026-08-22"
}

/// `GET /api/config` → `map`: the Mapbox public token and the style URL,
    /// per docs/PLATFORM-CONTRACT.md. Returns `nil` in demo mode so callers
    /// keep the compiled-in `MapDefaults.styleURL`.
    public func fetchMapConfig() async throws -> MapConfig? {
        guard let baseURL else { return nil }
        let envelope: AppConfigEnvelope = try await send(baseURL.appendingPathComponent("api/config"))
        return envelope.map
    }

    /// Sends a failure report and forgets about it.
    ///
    /// Deliberately fire-and-forget and deliberately unauthenticated: the
    /// reports worth having most are from somebody who could not sign in, and
    /// a reporter that can itself fail visibly would just be a second thing
    /// to go wrong on a screen that has already gone wrong.
    public func reportFailure(_ report: ClientErrorReport) async {
        guard let baseURL else { return }
        guard let body = try? encoder.encode(report) else { return }
        var request = URLRequest(url: baseURL.appendingPathComponent("api/client-errors"))
        request.httpMethod = "POST"
        request.timeoutInterval = 8
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        _ = try? await session.data(for: request)
    }

    /// The whole config, for sign-in. `fetchMapConfig` reads the same
    /// response; this returns the rest of it rather than fetching twice.
    public func fetchAppConfig() async throws -> AppConfigEnvelope {
        guard let baseURL else { throw TimiAPIError.invalidConfiguration(configuredAddress) }
        return try await send(baseURL.appendingPathComponent("api/config"))
    }

    private func send<Response: Decodable>(_ url: URL, method: String = "GET") async throws -> Response {
        try await send(url, method: method, data: nil)
    }

    private func send<Response: Decodable, Body: Encodable>(_ url: URL, method: String, body: Body) async throws -> Response {
        try await send(url, method: method, data: try encoder.encode(body))
    }

    private func send<Response: Decodable>(_ url: URL, method: String, data: Data?, retried: Bool = false) async throws -> Response {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let data { request.httpBody = data; request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        // Minted here, per request, rather than whenever somebody remembered
        // to call ensureFreshToken. A Clerk session token lives about a
        // minute; two callers out of seven refreshed, so anything done more
        // than sixty seconds after signing in — marking yourself en route,
        // saying you arrived, choosing an offer — went out with a dead token
        // and came back 401 AUTHENTICATION_REQUIRED. It read as being signed
        // out, and it was not.
        if let tokenProvider, await tokenProvider.hasSession,
           let fresh = try? await tokenProvider.ensureFreshToken(), !fresh.isEmpty {
            request.setValue("Bearer \(fresh)", forHTTPHeaderField: "Authorization")
        } else if let bearerToken, !bearerToken.isEmpty {
            request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        }
        let path = url.path
        let responseData: Data
        let response: URLResponse
        do {
            (responseData, response) = try await session.data(for: request)
        } catch {
            // Cancelling is not failing. SwiftUI cancels the search screen's
            // polling task the moment that screen goes away, which cancels the
            // request in flight, and URLSession reports that as an error whose
            // description is the single word "cancelled" — so pressing Cancel
            // put "Could not reach …/api/searches/search_7af97a9e: cancelled"
            // on screen as though something had gone wrong.
            if Task.isCancelled { throw CancellationError() }
            // A URLError reaching the UI unwrapped reads as "The operation
            // couldn't be completed" with no host and no reason, which is the
            // same dead end as before. Wrapped, it says which address failed
            // and how.
            throw TimiAPIError.transport(reason: error.localizedDescription, path: url.absoluteString)
        }
        guard let http = response as? HTTPURLResponse else { throw TimiAPIError.invalidResponse(path: path) }
        // One retry on a 401, with a token minted from scratch. A token can
        // expire between being minted and arriving, and a clock a few seconds
        // fast is enough to do it — retrying once costs a round trip and saves
        // a person being told to sign in while they are signed in.
        if http.statusCode == 401, !retried, let tokenProvider, await tokenProvider.hasSession,
           let minted = try? await tokenProvider.forceRefreshToken(), !minted.isEmpty {
            return try await send(url, method: method, data: data, retried: true)
        }
        guard (200..<300).contains(http.statusCode) else {
            let envelope = try? decoder.decode(APIErrorEnvelope.self, from: responseData)
            let failure = envelope?.error
            let detail = (failure?.details?.isEmpty == false) ? " " + (failure?.details ?? []).joined(separator: " ") : ""
            throw TimiAPIError.server(
                status: http.statusCode,
                code: failure?.code,
                message: (failure?.message ?? "Tími could not complete that request.") + detail,
                path: path
            )
        }
        do { return try decoder.decode(Response.self, from: responseData) }
        catch { throw TimiAPIError.invalidResponse(path: path) }
    }
}

private struct PetPayload: Encodable {
    var name: String; var species: String; var breed: String; var weightLbs: Double?
    /// Omitted when blank rather than sent as "": a clinic reading an empty
    /// allergies line has been told something, and it is not true.
    var medications: String?
    var allergies: String?
}
private struct StartSearchPayload: Encodable {
    var locationIds: [String]; var targetLimit: Int; var radiusMiles: Int; var pet: PetPayload; var owner: OwnerPayload
    var concernCategory: String; var concernSummary: String; var symptoms: [String]; var startedWhen: String; var urgency: String
    var redFlags: [String]; var customerLatitude: Double; var customerLongitude: Double; var consentToContact: Bool; var legalConsent: Bool; var legalVersion: String
}
private struct OfferSelectionPayload: Encodable { var offerId: String }
private struct StatusPayload: Encodable { var status: String }
private struct ObservationPayload: Encodable { var intakeId: String; var locationId: String; var milestone: String }
private struct ObservationEnvelope: Decodable { var recorded: Bool }
