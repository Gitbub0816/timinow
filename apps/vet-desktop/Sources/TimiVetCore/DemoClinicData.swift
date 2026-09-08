import Foundation

// Swift port of apps/vet-windows/src/TimiVet/Services/DemoClinicData.cs.
// Backs the console when no Worker HTTPS URL is configured, exactly like the
// Windows app's DemoClinicData and the customer app's DemoData.

final class DemoClinicData: @unchecked Sendable {
    private var requests: [ClinicRequest]
    private var availability: ClinicAvailability
    /// Backs both `dashboard()` and `updateSettings(_:)` — a single stored
    /// value so a facility-settings save in the demo is visible on the next
    /// dashboard read, the same round-trip the real Worker gives.
    private var location: ClinicLocationSummary
    private var widgetTokenStore: [WidgetToken]
    private let referral = ReferralLink(id: "demo_referral", slug: "hearth-paw", status: "active", clickCount: 12, createdAt: DemoClinicData.iso(Date()), updatedAt: DemoClinicData.iso(Date()))

    init() {
        let now = Date()
        availability = ClinicAvailability(
            intakeStatus: "available", label: "Available now", stableWaitMin: 15, stableWaitMax: 35, capacityCount: 3,
            acceptsCritical: true, source: "hospital", confidence: "high", note: "Accepting stable urgent-care arrivals.",
            reportedAt: Self.iso(now), expiresAt: Self.iso(now.addingTimeInterval(30 * 60))
        )
        location = ClinicLocationSummary(
            id: "loc_hearth", tenantId: "tenant_hearth", name: "Hearth & Paw Urgent Care",
            address: "22418 Foothill Boulevard, Hayward, CA", phone: "(510) 555-0148", kind: "urgent",
            species: ["dog", "cat"], capabilities: ["surgery", "oxygen", "same_day", "vaccines"],
            hours: ClinicHours(note: "Mon–Fri 8am–8pm, Sat 9am–4pm. Closed major holidays."),
            open24Hours: false, acceptsWalkIns: true, arrivalWindowMinutes: 20,
            staffingLevel: "veterinarian", staffingNote: nil, baseExamFeeCents: 18500,
            availability: availability,
            policy: ClinicPolicy(version: 1, depositRequired: true, depositAmountCents: 5000, freeCancelMinutes: 20, completedPlatformFeeCents: 2000, noShowPlatformFeeCents: 500)
        )
        widgetTokenStore = [
            WidgetToken(id: "demo_widget_1", label: "Front page badge", prefix: "wgt_demo1234", allowedOrigins: ["https://www.hearthandpaw.example"], status: "active", createdAt: Self.iso(now.addingTimeInterval(-86400 * 9)), revokedAt: nil, lastUsedAt: Self.iso(now.addingTimeInterval(-3600)))
        ]
        requests = [
            ClinicRequest(
                id: "demo_search_1", searchId: "search_demo", publicCode: "TIMI-7K3Q", locationId: "loc_hearth", tenantId: "tenant_hearth",
                pet: PetSummary(name: "Milo", species: "dog", breed: "German shepherd", weightLbs: 78),
                owner: OwnerSummary(name: "Avery Cole", phone: "(510) 555-0126", email: "avery@example.com"),
                concernSummary: "Vomited three times since 7 AM and will not drink water.", urgency: "urgent", redFlags: [],
                travelMinutes: 11, status: "pending", requestedAt: Self.iso(now.addingTimeInterval(-2 * 60)),
                requestExpiresAt: Self.iso(now.addingTimeInterval(4 * 60)), searchTarget: true
            ),
            ClinicRequest(
                id: "demo_search_2", searchId: "search_demo_2", publicCode: "TIMI-2D9R", locationId: "loc_hearth", tenantId: "tenant_hearth",
                pet: PetSummary(name: "Juniper", species: "cat", breed: "Domestic shorthair", weightLbs: 9),
                owner: OwnerSummary(name: "Morgan Lee", phone: "(510) 555-0192"),
                concernSummary: "Open-mouth breathing at rest with blue-tinged gums for ten minutes.", urgency: "emergency",
                redFlags: ["breathing_difficulty"], travelMinutes: 17, status: "pending",
                requestedAt: Self.iso(now.addingTimeInterval(-1 * 60)), requestExpiresAt: Self.iso(now.addingTimeInterval(5 * 60)), searchTarget: true
            ),
            ClinicRequest(
                id: "demo_direct_1", publicCode: "TIMI-8M4P", locationId: "loc_hearth", tenantId: "tenant_hearth",
                pet: PetSummary(name: "Otis", species: "dog", breed: "Golden retriever", weightLbs: 72),
                owner: OwnerSummary(name: "Sam Rivera", phone: "(510) 555-0181"),
                concernSummary: "Limping after a run and avoiding weight on the left front paw.", urgency: "same_day", redFlags: [],
                travelMinutes: 8, status: "pending", requestedAt: Self.iso(now.addingTimeInterval(-4 * 60)),
                requestExpiresAt: Self.iso(now.addingTimeInterval(3 * 60)), searchTarget: false
            )
        ]
    }

    func dashboard() -> ClinicDashboard {
        let visible = requests.sorted { lhs, rhs in
            if (lhs.status == "pending") != (rhs.status == "pending") { return lhs.status == "pending" }
            return (lhs.requestedAt ?? "") > (rhs.requestedAt ?? "")
        }
        location.availability = availability
        let metrics = ClinicMetrics(
            pending: visible.filter { $0.status == "pending" }.count,
            activeArrivals: visible.filter { ["accepted", "en_route", "arrived", "triaged"].contains($0.status) }.count,
            completedToday: visible.filter { $0.status == "completed" }.count,
            declinedToday: visible.filter { $0.status == "declined" }.count
        )
        return ClinicDashboard(location: location, requests: visible, metrics: metrics)
    }

    /// Demo counterpart of `POST /api/clinic/settings` — merges the change
    /// straight into the stored `location` and hands it back, matching the
    /// real Worker's `{location: enrichLocation(updated)}` response shape.
    func updateSettings(_ update: ClinicSettingsUpdate) -> ClinicLocationSummary {
        location.kind = update.kind
        location.species = update.species
        location.capabilities = update.capabilities
        location.open24Hours = update.open24Hours
        location.acceptsWalkIns = update.acceptsWalkIns
        location.arrivalWindowMinutes = update.arrivalWindowMinutes
        if let baseExamFeeCents = update.baseExamFeeCents { location.baseExamFeeCents = baseExamFeeCents }
        location.hours = ClinicHours(note: update.hoursNote)
        location.staffingLevel = update.staffingLevel
        location.staffingNote = update.staffingNote.isEmpty ? nil : update.staffingNote
        return location
    }

    // MARK: - Overflow tools

    func referralLink() -> ReferralLink? { referral }

    func widgetTokens() -> [WidgetToken] { widgetTokenStore }

    func createWidgetToken(label: String, allowedOrigins: [String]) -> WidgetToken {
        let trimmedLabel = label.trimmingCharacters(in: .whitespaces)
        let token = WidgetToken(
            id: "demo_widget_\(widgetTokenStore.count + 1)",
            label: trimmedLabel.isEmpty ? nil : trimmedLabel,
            prefix: "wgt_demo\(widgetTokenStore.count + 1)xyz",
            allowedOrigins: allowedOrigins, status: "active", createdAt: Self.iso(Date()), revokedAt: nil, lastUsedAt: nil,
            // Only ever present on this creation response, matching the real
            // Worker's one-time secret.
            secret: "wgt_demo_\(UUID().uuidString.prefix(20).lowercased())"
        )
        widgetTokenStore.insert(token, at: 0)
        return token
    }

    func revokeWidgetToken(id: String) {
        guard let index = widgetTokenStore.firstIndex(where: { $0.id == id }) else { return }
        widgetTokenStore[index].status = "revoked"
        widgetTokenStore[index].revokedAt = Self.iso(Date())
    }

    func publish(_ update: AvailabilityUpdate) {
        let now = Date()
        availability = ClinicAvailability(
            intakeStatus: update.intakeStatus, label: Self.label(update.intakeStatus), stableWaitMin: update.stableWaitMin,
            stableWaitMax: update.stableWaitMax, capacityCount: update.capacityCount, acceptsCritical: update.acceptsCritical,
            source: "hospital", confidence: "high", note: update.note, reportedAt: Self.iso(now),
            expiresAt: Self.iso(now.addingTimeInterval(Double(update.ttlMinutes) * 60))
        )
    }

    func decide(id: String, decision: DecisionPayload) throws {
        guard let index = requests.firstIndex(where: { $0.id == id }) else {
            throw ClinicAPIError.server("The demo request no longer exists.")
        }
        requests[index].status = decision.decision == "decline" ? "declined" : "accepted"
        requests[index].updatedAt = Self.iso(Date())
    }

    /// Numbers that add up, so somebody demonstrating the console can point at
    /// the arithmetic: two transfers of the baseline $50 deposit less the $20
    /// completed fee, one of which Stripe has already paid out.
    func payouts() -> ClinicPayouts {
        let now = Date()
        return ClinicPayouts(
            earnings: ClinicEarnings(
                transferredCents: 6000,
                paidOutCents: 3000,
                awaitingPayoutCents: 3000,
                transfers: [
                    ClinicLedgerEntry(id: "demo_tr_2", occurredAt: Self.iso(now.addingTimeInterval(-3600)), kind: "clinic_transfer", amountCents: 3000, status: "created", stripeObjectId: "tr_demo_2", intakeId: "demo_clinic_request"),
                    ClinicLedgerEntry(id: "demo_tr_1", occurredAt: Self.iso(now.addingTimeInterval(-90000)), kind: "clinic_transfer", amountCents: 3000, status: "created", stripeObjectId: "tr_demo_1", intakeId: "demo_clinic_request")
                ],
                payouts: [
                    ClinicLedgerEntry(id: "demo_po_1", occurredAt: Self.iso(now.addingTimeInterval(-43200)), kind: "clinic_payout", amountCents: 3000, status: "paid", stripeObjectId: "po_demo_1")
                ]
            ),
            connect: ClinicConnectStatus(onboardingStatus: "complete", transfersEnabled: true, payoutsEnabled: true)
        )
    }

    private static func iso(_ date: Date) -> String { ISO8601DateFormatter().string(from: date) }
    private static func label(_ status: String) -> String {
        switch status {
        case "available": return "Available now"
        case "limited": return "Limited capacity"
        case "confirm_first": return "Confirm first"
        case "critical_only": return "Critical only"
        case "diverting": return "Diverting"
        case "closed": return "Closed"
        default: return "Unverified"
        }
    }
}
