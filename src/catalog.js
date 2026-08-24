export const DEMO_LOCATIONS = [
  {
    id: "loc_bayview",
    tenantId: "tenant_bayview",
    name: "Bayview Veterinary Emergency",
    kind: "emergency",
    address: "2211 Shoreline Drive, Hayward, CA 94545",
    phone: "(510) 555-0138",
    latitude: 37.6536,
    longitude: -122.1197,
    open24Hours: true,
    acceptsWalkIns: true,
    autoAccept: false,
    arrivalWindowMinutes: 20,
    species: ["dog", "cat", "bird", "rabbit"],
    capabilities: ["emergency", "urgent", "surgery", "oxygen", "toxin", "imaging", "overnight"],
    baseExamFeeCents: 18500,
    availability: {
      intakeStatus: "limited",
      stableWaitMin: 75,
      stableWaitMax: 135,
      capacityCount: 2,
      acceptsCritical: true,
      source: "hospital",
      confidence: "high",
      note: "Critical patients are always triaged on arrival.",
      reportedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString()
    },
    policy: { id: "policy_bayview_v1", version: 1, depositRequired: true, depositAmountCents: 7500, depositRefundable: true, freeCancelMinutes: 15, completedPlatformFeeCents: 2000, noShowPlatformFeeCents: 500 }
  },
  {
    id: "loc_hearth",
    tenantId: "tenant_hearth",
    name: "Hearth & Paw Urgent Care",
    kind: "urgent",
    address: "1555 B Street, Hayward, CA 94541",
    phone: "(510) 555-0194",
    latitude: 37.6718,
    longitude: -122.0824,
    open24Hours: false,
    acceptsWalkIns: true,
    autoAccept: true,
    arrivalWindowMinutes: 25,
    species: ["dog", "cat"],
    capabilities: ["urgent", "minor_injury", "vomiting", "same_day", "imaging"],
    baseExamFeeCents: 8900,
    availability: {
      intakeStatus: "available",
      stableWaitMin: 15,
      stableWaitMax: 35,
      capacityCount: 3,
      acceptsCritical: false,
      source: "hospital",
      confidence: "high",
      note: "Accepting stable urgent-care arrivals.",
      reportedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString()
    },
    policy: { id: "policy_hearth_v1", version: 1, depositRequired: true, depositAmountCents: 5000, depositRefundable: true, freeCancelMinutes: 30, completedPlatformFeeCents: 2000, noShowPlatformFeeCents: 500 }
  },
  {
    id: "loc_juniper",
    tenantId: "tenant_juniper",
    name: "Juniper Animal Care",
    kind: "general",
    address: "3100 Castro Valley Boulevard, Castro Valley, CA 94546",
    phone: "(510) 555-0161",
    latitude: 37.6944,
    longitude: -122.0868,
    open24Hours: false,
    acceptsWalkIns: true,
    autoAccept: false,
    arrivalWindowMinutes: 30,
    species: ["dog", "cat"],
    capabilities: ["same_day", "wellness", "minor_injury", "vaccines"],
    baseExamFeeCents: 7200,
    availability: {
      intakeStatus: "confirm_first",
      stableWaitMin: 30,
      stableWaitMax: 60,
      capacityCount: 1,
      acceptsCritical: false,
      source: "timi_request",
      confidence: "medium",
      note: "Call-ahead confirmation required.",
      reportedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString()
    },
    policy: { id: "policy_juniper_v1", version: 1, depositRequired: false, depositAmountCents: 0, depositRefundable: true, freeCancelMinutes: 0, completedPlatformFeeCents: 2000, noShowPlatformFeeCents: 500 }
  },
  {
    id: "loc_cedar",
    tenantId: "tenant_cedar",
    name: "Cedar Grove Veterinary Urgent Care",
    kind: "urgent",
    address: "4027 Mowry Avenue, Fremont, CA 94538",
    phone: "(510) 555-0172",
    latitude: 37.5485,
    longitude: -121.9886,
    open24Hours: false,
    acceptsWalkIns: true,
    autoAccept: false,
    arrivalWindowMinutes: 35,
    species: ["dog", "cat"],
    capabilities: ["urgent", "same_day", "minor_injury", "vomiting", "imaging"],
    baseExamFeeCents: 9500,
    availability: {
      intakeStatus: "available",
      stableWaitMin: 20,
      stableWaitMax: 40,
      capacityCount: 2,
      acceptsCritical: false,
      source: "hospital",
      confidence: "high",
      note: "Two urgent-care arrivals currently available.",
      reportedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString()
    },
    policy: { id: "policy_cedar_v1", version: 1, depositRequired: true, depositAmountCents: 5000, depositRefundable: true, freeCancelMinutes: 20, completedPlatformFeeCents: 2000, noShowPlatformFeeCents: 500 }
  },
  {
    id: "loc_solano",
    tenantId: "tenant_solano",
    name: "Solano Pet Emergency",
    kind: "emergency",
    address: "1850 Solano Avenue, Berkeley, CA 94707",
    phone: "(510) 555-0186",
    latitude: 37.8918,
    longitude: -122.2811,
    open24Hours: true,
    acceptsWalkIns: true,
    autoAccept: false,
    arrivalWindowMinutes: 25,
    species: ["dog", "cat", "rabbit"],
    capabilities: ["emergency", "urgent", "surgery", "oxygen", "imaging", "overnight"],
    baseExamFeeCents: 17500,
    availability: {
      intakeStatus: "limited",
      stableWaitMin: 50,
      stableWaitMax: 90,
      capacityCount: 2,
      acceptsCritical: true,
      source: "hospital",
      confidence: "high",
      note: "Emergency intake is open; all patients are triaged on arrival.",
      reportedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString()
    },
    policy: { id: "policy_solano_v1", version: 1, depositRequired: true, depositAmountCents: 7500, depositRefundable: true, freeCancelMinutes: 15, completedPlatformFeeCents: 2000, noShowPlatformFeeCents: 500 }
  }
];

export const RED_FLAG_TERMS = [
  "not breathing",
  "can't breathe",
  "cannot breathe",
  "struggling to breathe",
  "unconscious",
  "collapsed",
  "seizure",
  "poison",
  "toxin",
  "hit by car",
  "heavy bleeding",
  "uncontrolled bleeding",
  "bloated abdomen"
];

export const VALID_SPECIES = new Set(["dog", "cat", "bird", "rabbit", "reptile", "small_mammal", "other"]);
export const VALID_URGENCY = new Set(["routine", "same_day", "urgent", "emergency"]);

/**
 * Which credential staffs a location.
 *
 * Not a self-declared field: it is set by a platform operator when the provider
 * is created. A veterinary technician works under a veterinarian's supervision
 * and, in every US state, may not diagnose, prognose, prescribe, or perform
 * surgery — so which one is on the floor changes what an offer can mean, and a
 * customer comparing offers has to be able to see it.
 */
export const VALID_STAFFING = new Set(["veterinarian", "veterinary_technician"]);

/**
 * The standard notice for a technician-staffed provider, worded once here so
 * every surface says the same thing. An operator's own note is shown alongside
 * it, never instead of it.
 */
export const TECHNICIAN_NOTICE =
  "Staffed by a veterinary technician, not a veterinarian. Technicians work under veterinarian supervision and cannot diagnose, prognose, prescribe, or perform surgery. Suitable for minor concerns; anything that may need a diagnosis or treatment decision should go to a veterinarian.";

/**
 * The terms and safety notice a care request is accepted against.
 *
 * One constant, because the Worker rejects anything that does not match it
 * exactly and it used to be a literal repeated across the Worker, the web
 * client, the iOS client and four test files — eight places to keep in step,
 * with a 422 on the last screen of the flow as the only warning when they fell
 * out of it.
 *
 * 2026-08-22 adds the optional medications and allergies an owner may record,
 * and the veterinary-technician staffing notice.
 *
 * 2026-08-24 adds the service-fee disclosure: Tími's $50 fee per completed
 * intake, the standard $25 customer share, and the required checkout notice
 * when a clinic passes the whole fee to the customer. See the fee constants
 * below and `fees` on /api/config.
 */
export const LEGAL_VERSION = "2026-08-24";
export const VALID_INTAKE_STATUS = new Set(["available", "limited", "confirm_first", "critical_only", "diverting", "closed", "unverified"]);

/**
 * Tími's service fee is $50 per completed intake. The standard arrangement
 * charges the customer $25 at the time of service and deducts the remainder
 * from the clinic payout; a clinic may elect to pass the entire $50 to the
 * customer, which must then be disclosed at checkout.
 *
 * Constants rather than tenant policy fields, because this is Tími's own
 * price: the same on every surface, served by /api/config so no client
 * carries a copy that can drift from what is actually charged.
 */
export const TIMI_CUSTOMER_FEE_CENTS = 2500;
export const TIMI_TOTAL_SERVICE_FEE_CENTS = 5000;
