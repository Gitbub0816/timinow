import Foundation

public enum TimiAPIError: Error, Sendable {
    case invalidConfiguration
    case server(String)
    case invalidResponse

    public var message: String {
        switch self {
        case .invalidConfiguration: return "Enter the HTTPS address of your Tími Worker in Settings."
        case .server(let message): return message
        case .invalidResponse: return "Tími received a response it could not read."
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
        guard let baseURL else { throw TimiAPIError.invalidConfiguration }
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
        guard let baseURL else { throw TimiAPIError.invalidConfiguration }
        let envelope: IntakeEnvelope = try await send(baseURL.appendingPathComponent("api/intakes/\(id)"))
        return envelope.intake
    }

    public func updateIntake(_ id: String, status: String) async throws -> CareIntake {
        guard let baseURL else { throw TimiAPIError.invalidConfiguration }
        let envelope: IntakeEnvelope = try await send(baseURL.appendingPathComponent("api/intakes/\(id)/status"), method: "POST", body: StatusPayload(status: status))
        return envelope.intake
    }

    public func recordObservation(intake: CareIntake, milestone: String) async throws {
        guard let baseURL else { return }
        let _: ObservationEnvelope = try await send(baseURL.appendingPathComponent("api/observations"), method: "POST", body: ObservationPayload(intakeId: intake.id, locationId: intake.locationId, milestone: milestone))
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
        let (responseData, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw TimiAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let error = try? decoder.decode(APIErrorEnvelope.self, from: responseData)
            throw TimiAPIError.server(error?.message ?? error?.error ?? "Tími could not complete that request (\(http.statusCode)).")
        }
        do { return try decoder.decode(Response.self, from: responseData) }
        catch { throw TimiAPIError.invalidResponse }
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
