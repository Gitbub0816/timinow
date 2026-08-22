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

public final class TimiGateway: @unchecked Sendable {
    public var baseURL: URL?
    public var bearerToken: String?
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

    public func locations(latitude: Double, longitude: Double, species: PetSpecies) async throws -> [ClinicLocation] {
        guard let baseURL else { return DemoData.clinics }
        var components = URLComponents(url: baseURL.appendingPathComponent("api/locations"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "latitude", value: String(latitude)), URLQueryItem(name: "longitude", value: String(longitude)),
            URLQueryItem(name: "radiusMiles", value: "50"), URLQueryItem(name: "species", value: species.rawValue), URLQueryItem(name: "care", value: "urgent")
        ]
        let envelope: LocationsEnvelope = try await send(components.url!)
        return envelope.locations
    }

    public func startSearch(_ draft: CareDraft, locationIds: [String]) async throws -> CareSearch {
        guard let baseURL else { return DemoData.search(for: draft) }
        let payload = StartSearchPayload(
            locationIds: locationIds, targetLimit: 30, radiusMiles: 50,
            pet: PetPayload(name: draft.pet.name, species: draft.pet.species.rawValue, breed: draft.pet.breed, weightLbs: draft.pet.weightLbs),
            owner: OwnerPayload(name: draft.ownerName, phone: draft.ownerPhone, email: draft.ownerEmail.isEmpty ? nil : draft.ownerEmail),
            concernCategory: draft.urgency == .emergency ? "possible_emergency" : "illness_or_injury", concernSummary: draft.summary,
            symptoms: draft.symptomKeys, startedWhen: draft.startedWhen, urgency: draft.urgency.rawValue, redFlags: draft.redFlags,
            customerLatitude: draft.latitude, customerLongitude: draft.longitude, consentToContact: draft.contactConsent,
            legalConsent: draft.legalConsent, legalVersion: "2026-08-21"
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

    /// `GET /api/config` → `map`: the Mapbox public token and the style URL,
    /// per docs/PLATFORM-CONTRACT.md. Returns `nil` in demo mode so callers
    /// keep the compiled-in `MapDefaults.styleURL`.
    public func fetchMapConfig() async throws -> MapConfig? {
        guard let baseURL else { return nil }
        let envelope: AppConfigEnvelope = try await send(baseURL.appendingPathComponent("api/config"))
        return envelope.map
    }

    private func send<Response: Decodable>(_ url: URL, method: String = "GET") async throws -> Response {
        try await send(url, method: method, data: nil)
    }

    private func send<Response: Decodable, Body: Encodable>(_ url: URL, method: String, body: Body) async throws -> Response {
        try await send(url, method: method, data: try encoder.encode(body))
    }

    private func send<Response: Decodable>(_ url: URL, method: String, data: Data?) async throws -> Response {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let data { request.httpBody = data; request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let bearerToken, !bearerToken.isEmpty { request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization") }
        let path = url.path
        let responseData: Data
        let response: URLResponse
        do {
            (responseData, response) = try await session.data(for: request)
        } catch {
            // A URLError reaching the UI unwrapped reads as "The operation
            // couldn't be completed" with no host and no reason, which is the
            // same dead end as before. Wrapped, it says which address failed
            // and how.
            throw TimiAPIError.transport(reason: error.localizedDescription, path: url.absoluteString)
        }
        guard let http = response as? HTTPURLResponse else { throw TimiAPIError.invalidResponse(path: path) }
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

private struct PetPayload: Encodable { var name: String; var species: String; var breed: String; var weightLbs: Double? }
private struct StartSearchPayload: Encodable {
    var locationIds: [String]; var targetLimit: Int; var radiusMiles: Int; var pet: PetPayload; var owner: OwnerPayload
    var concernCategory: String; var concernSummary: String; var symptoms: [String]; var startedWhen: String; var urgency: String
    var redFlags: [String]; var customerLatitude: Double; var customerLongitude: Double; var consentToContact: Bool; var legalConsent: Bool; var legalVersion: String
}
private struct OfferSelectionPayload: Encodable { var offerId: String }
private struct StatusPayload: Encodable { var status: String }
private struct ObservationPayload: Encodable { var intakeId: String; var locationId: String; var milestone: String }
private struct ObservationEnvelope: Decodable { var recorded: Bool }
