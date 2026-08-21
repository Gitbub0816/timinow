import Foundation

public enum DemoData {
    public static let pet = PetProfile(name: "Milo", species: .dog, breed: "German shepherd", weightLbs: 78, birthYear: 2020, colorToken: 0)

    public static let clinics: [ClinicLocation] = [
        clinic("loc_hearth", "tenant_hearth", "Hearth & Paw Urgent Care", "22418 Foothill Boulevard, Hayward, CA", 2.4, 15, 30, 5000, 12500, "urgent"),
        clinic("loc_bayview", "tenant_bayview", "Bayview Veterinary Emergency", "15655 Hesperian Boulevard, San Lorenzo, CA", 5.8, 35, 55, 7500, 17500, "emergency"),
        clinic("loc_redwood", "tenant_redwood", "Redwood Animal Hospital", "30212 Industrial Parkway, Union City, CA", 8.1, 20, 40, 0, 9500, "urgent"),
        clinic("loc_cedar", "tenant_cedar", "Cedar Grove Veterinary Urgent Care", "4027 Mowry Avenue, Fremont, CA", 13.4, 25, 45, 5000, 9500, "urgent"),
        clinic("loc_solano", "tenant_solano", "Solano Pet Emergency", "1850 Solano Avenue, Berkeley, CA", 22.1, 50, 90, 7500, 17500, "emergency")
    ]

    public static func search(for draft: CareDraft) -> CareSearch {
        let id = "demo_search_\(UUID().uuidString)"
        let offers = clinics.enumerated().map { index, clinic in
            CareOffer(
                id: "demo_offer_\(index + 1)", searchId: id, targetId: "demo_target_\(index + 1)", locationId: clinic.id,
                tenantId: clinic.tenantId, responseType: clinic.kind == "emergency" ? "emergency_intake" : "available_now", status: "active",
                availableAt: ISO8601DateFormatter().string(from: Date()), arrivalBy: ISO8601DateFormatter().string(from: Date().addingTimeInterval(Double(20 + index * 5) * 60)),
                waitMin: clinic.availability?.stableWaitMin, waitMax: clinic.availability?.stableWaitMax,
                clinicNote: clinic.availability?.note, policy: clinic.policy, depositAmountCents: clinic.policy?.depositAmountCents,
                baseExamFeeCents: clinic.baseExamFeeCents, offeredAt: ISO8601DateFormatter().string(from: Date()),
                expiresAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(300)), location: clinic
            )
        }
        return CareSearch(
            id: id, publicCode: "TIMI-DEMO", pet: PetProfilePayload(name: draft.pet.name, species: draft.pet.species.rawValue, breed: draft.pet.breed, ageYears: nil, weightLbs: draft.pet.weightLbs),
            owner: OwnerPayload(name: draft.ownerName, phone: draft.ownerPhone, email: draft.ownerEmail), concernCategory: "illness_or_injury",
            concernSummary: draft.summary, urgency: draft.urgency.rawValue, redFlags: draft.redFlags, status: "offers_ready", maxOffers: 5, targetLimit: 30,
            selectedOfferId: nil, selectedIntakeId: nil, requestedAt: ISO8601DateFormatter().string(from: Date()),
            collectionExpiresAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(90)), searchExpiresAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(390)),
            offers: offers, progress: SearchProgress(contacted: 5, awaiting: 0, declined: 0, offers: 5), demo: true
        )
    }

    private static func clinic(_ id: String, _ tenant: String, _ name: String, _ address: String, _ distance: Double, _ waitMin: Int, _ waitMax: Int, _ deposit: Int, _ exam: Int, _ kind: String) -> ClinicLocation {
        ClinicLocation(
            id: id, tenantId: tenant, name: name, kind: kind, address: address, phone: "(510) 555-01\(String(id.suffix(2)))",
            latitude: nil, longitude: nil, distanceMiles: distance, baseExamFeeCents: exam,
            capabilities: kind == "emergency" ? ["emergency", "imaging", "surgery"] : ["urgent", "same_day", "imaging"],
            availability: ClinicAvailability(intakeStatus: waitMin < 30 ? "available" : "limited", label: waitMin < 30 ? "Available now" : "Limited capacity", stableWaitMin: waitMin, stableWaitMax: waitMax, capacityCount: 2, acceptsCritical: kind == "emergency", source: "hospital", confidence: "high", note: kind == "emergency" ? "Emergency intake is open; every patient is triaged on arrival." : "The team can evaluate another stable urgent-care arrival.", reportedAt: ISO8601DateFormatter().string(from: Date()), expiresAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(1800))),
            policy: ClinicPolicy(id: "policy_\(id)", version: 1, depositRequired: deposit > 0, depositAmountCents: deposit, depositRefundable: true, freeCancelMinutes: 20, completedPlatformFeeCents: 2000, noShowPlatformFeeCents: 500)
        )
    }
}
