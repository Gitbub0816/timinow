import { DEMO_LOCATIONS } from "./catalog.js";

export function hasDatabase(env) {
  return Boolean(env.DB && typeof env.DB.prepare === "function");
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function bool(value) {
  return value === true || value === 1 || value === "1";
}

function timestampMs(value) {
  if (!value) return Number.NaN;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  return Date.parse(normalized);
}

export function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRadians = (degrees) => degrees * (Math.PI / 180);
  const earthRadiusMiles = 3958.8;
  const latitudeDelta = toRadians(lat2 - lat1);
  const longitudeDelta = toRadians(lon2 - lon1);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadiusMiles * Math.asin(Math.sqrt(a));
}

function availabilityFromRow(row) {
  const now = Date.now();
  const expiresAt = row.availability_expires_at || row.expires_at;
  const stale = !expiresAt || timestampMs(expiresAt) <= now;
  return {
    intakeStatus: stale ? "unverified" : (row.intake_status || "unverified"),
    stableWaitMin: row.stable_wait_min ?? null,
    stableWaitMax: row.stable_wait_max ?? null,
    capacityCount: row.capacity_count ?? null,
    acceptsCritical: bool(row.accepts_critical),
    source: stale ? "prediction" : (row.availability_source || row.source || "prediction"),
    confidence: stale ? "low" : (row.availability_confidence || row.confidence || "low"),
    note: row.availability_note || row.note || null,
    reportedAt: row.reported_at || null,
    expiresAt: expiresAt || null,
    stale
  };
}

function policyFromRow(row) {
  if (!row.policy_id) {
    return {
      id: null,
      version: 0,
      depositRequired: false,
      depositAmountCents: 0,
      depositRefundable: true,
      freeCancelMinutes: 0,
      completedPlatformFeeCents: 2000,
      noShowPlatformFeeCents: 500,
      details: {}
    };
  }
  return {
    id: row.policy_id,
    version: row.policy_version,
    depositRequired: bool(row.deposit_required),
    depositAmountCents: row.deposit_amount_cents || 0,
    depositRefundable: bool(row.deposit_refundable),
    freeCancelMinutes: row.free_cancel_minutes || 0,
    completedPlatformFeeCents: row.completed_platform_fee_cents || 0,
    noShowPlatformFeeCents: row.no_show_platform_fee_cents || 0,
    lateCancelPlatformFeeCents: row.late_cancel_platform_fee_cents || 0,
    details: parseJson(row.policy_json, {})
  };
}

function locationFromRow(row, coordinates) {
  const latitude = Number(row.latitude);
  const longitude = Number(row.longitude);
  const distanceMiles = coordinates
    ? haversineMiles(coordinates.latitude, coordinates.longitude, latitude, longitude)
    : null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    slug: row.slug,
    kind: row.kind,
    address: `${row.address_line1}, ${row.city}, ${row.region} ${row.postal_code}`,
    phone: row.phone,
    latitude,
    longitude,
    timezone: row.timezone,
    open24Hours: bool(row.open_24_hours),
    acceptsWalkIns: bool(row.accepts_walk_ins),
    autoAccept: bool(row.auto_accept),
    arrivalWindowMinutes: row.arrival_window_minutes || 20,
    species: parseJson(row.species_json, []),
    capabilities: parseJson(row.capabilities_json, []),
    hours: parseJson(row.hours_json, {}),
    baseExamFeeCents: row.base_exam_fee_cents,
    // Defaulted rather than assumed: a row written before the column existed
    // reads as null, and null must mean "a veterinarian", not "unknown", or
    // every existing provider silently acquires a technician notice.
    staffingLevel: row.staffing_level || "veterinarian",
    staffingNote: row.staffing_note || null,
    distanceMiles: distanceMiles === null ? null : Number(distanceMiles.toFixed(1)),
    availability: availabilityFromRow(row),
    policy: policyFromRow(row)
  };
}

const LOCATION_SELECT = `
  SELECT
    l.*,
    ar.intake_status,
    ar.stable_wait_min,
    ar.stable_wait_max,
    ar.capacity_count,
    ar.accepts_critical,
    ar.source AS availability_source,
    ar.confidence AS availability_confidence,
    ar.note AS availability_note,
    ar.reported_at,
    ar.expires_at AS availability_expires_at,
    p.id AS policy_id,
    p.version AS policy_version,
    p.deposit_required,
    p.deposit_amount_cents,
    p.deposit_refundable,
    p.free_cancel_minutes,
    p.completed_platform_fee_cents,
    p.no_show_platform_fee_cents,
    p.late_cancel_platform_fee_cents,
    p.policy_json
  FROM locations l
  LEFT JOIN availability_reports ar ON ar.id = (
    SELECT ar2.id FROM availability_reports ar2
    WHERE ar2.location_id = l.id
    ORDER BY datetime(ar2.reported_at) DESC, ar2.rowid DESC LIMIT 1
  )
  LEFT JOIN tenant_policies p ON p.id = (
    SELECT p2.id FROM tenant_policies p2
    WHERE p2.tenant_id = l.tenant_id AND p2.active = 1
    ORDER BY p2.version DESC LIMIT 1
  )
`;

export async function listLocations(env, filters = {}) {
  const coordinates = Number.isFinite(filters.latitude) && Number.isFinite(filters.longitude)
    ? { latitude: filters.latitude, longitude: filters.longitude }
    : null;

  let locations;
  if (!hasDatabase(env)) {
    locations = DEMO_LOCATIONS.map((location) => ({
      ...location,
      distanceMiles: coordinates
        ? Number(haversineMiles(coordinates.latitude, coordinates.longitude, location.latitude, location.longitude).toFixed(1))
        : null
    }));
  } else {
    const query = `${LOCATION_SELECT} WHERE l.active = 1 ORDER BY l.name`;
    const result = await env.DB.prepare(query).all();
    locations = result.results.map((row) => locationFromRow(row, coordinates));
  }

  if (filters.species) locations = locations.filter((location) => location.species.includes(filters.species));
  if (filters.care === "emergency") {
    locations = locations.filter((location) => location.kind === "emergency" || location.capabilities.includes("emergency"));
  } else if (filters.care === "urgent") {
    locations = locations.filter((location) => ["urgent", "emergency", "general"].includes(location.kind));
  }
  if (coordinates && Number.isFinite(filters.radiusMiles)) {
    locations = locations.filter((location) => location.distanceMiles <= filters.radiusMiles);
  }

  const statusRank = { available: 0, limited: 1, confirm_first: 2, critical_only: 3, unverified: 4, diverting: 5, closed: 6 };
  return locations.sort((a, b) => {
    const availabilityDifference = (statusRank[a.availability.intakeStatus] ?? 9) - (statusRank[b.availability.intakeStatus] ?? 9);
    if (availabilityDifference) return availabilityDifference;
    if (coordinates) return a.distanceMiles - b.distanceMiles;
    return a.name.localeCompare(b.name);
  });
}

export async function getLocation(env, locationId) {
  if (!hasDatabase(env)) return DEMO_LOCATIONS.find((location) => location.id === locationId) || null;
  const row = await env.DB.prepare(`${LOCATION_SELECT} WHERE l.id = ? AND l.active = 1 LIMIT 1`).bind(locationId).first();
  return row ? locationFromRow(row, null) : null;
}

export async function tenantIdForClerkOrg(env, clerkOrgId) {
  if (!clerkOrgId) return null;
  if (!hasDatabase(env)) {
    const location = DEMO_LOCATIONS.find((candidate) => candidate.tenantId === clerkOrgId || `org_demo_${candidate.tenantId.replace("tenant_", "")}` === clerkOrgId);
    return location?.tenantId || null;
  }
  const row = await env.DB.prepare("SELECT id FROM tenants WHERE clerk_org_id = ? LIMIT 1").bind(clerkOrgId).first();
  return row?.id || null;
}

export async function getClinicLocation(env, tenantId) {
  if (!tenantId) return null;
  if (!hasDatabase(env)) return DEMO_LOCATIONS.find((location) => location.tenantId === tenantId) || null;
  const row = await env.DB.prepare(`${LOCATION_SELECT} WHERE l.tenant_id = ? AND l.active = 1 ORDER BY l.created_at LIMIT 1`).bind(tenantId).first();
  return row ? locationFromRow(row, null) : null;
}

function normalizeCareSearchRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    publicCode: row.public_code,
    customerUserId: row.customer_user_id,
    pet: {
      name: row.pet_name,
      species: row.species,
      breed: row.breed,
      ageYears: row.age_years,
      weightLbs: row.weight_lbs,
      // Optional, owner-supplied, and null on every row written before the
      // column existed.
      medications: row.medications || null,
      allergies: row.allergies || null
    },
    owner: {
      name: row.owner_name,
      phone: row.owner_phone,
      email: row.owner_email
    },
    concernCategory: row.concern_category,
    concernSummary: row.concern_summary,
    urgency: row.urgency,
    redFlags: parseJson(row.red_flags_json, []),
    customerLatitude: row.customer_latitude,
    customerLongitude: row.customer_longitude,
    radiusMiles: row.radius_miles,
    status: row.status,
    maxOffers: row.max_offers,
    targetLimit: row.target_limit,
    selectedOfferId: row.selected_offer_id,
    selectedIntakeId: row.selected_intake_id,
    legalVersion: row.legal_version,
    legalAcceptedAt: row.legal_accepted_at,
    requestedAt: row.requested_at,
    collectionExpiresAt: row.collection_expires_at,
    searchExpiresAt: row.search_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeOfferRow(row, location, search) {
  const latitude = Number(search?.customerLatitude);
  const longitude = Number(search?.customerLongitude);
  const hasCoordinates = Number.isFinite(latitude) && Number.isFinite(longitude);
  const enrichedLocation = location && hasCoordinates
    ? { ...location, distanceMiles: Number(haversineMiles(latitude, longitude, location.latitude, location.longitude).toFixed(1)) }
    : location;
  return {
    id: row.id,
    searchId: row.search_id,
    targetId: row.target_id,
    locationId: row.location_id,
    tenantId: row.tenant_id,
    responseType: row.response_type,
    status: row.status,
    availableAt: row.available_at,
    arrivalBy: row.arrival_by,
    waitMin: row.wait_min,
    waitMax: row.wait_max,
    clinicNote: row.clinic_note,
    policy: parseJson(row.policy_snapshot_json, {}),
    depositAmountCents: row.deposit_amount_cents || 0,
    baseExamFeeCents: row.base_exam_fee_cents,
    offeredAt: row.offered_at,
    expiresAt: row.expires_at,
    location: enrichedLocation
  };
}

export async function getCareSearch(env, identifier) {
  if (!hasDatabase(env)) return null;
  const row = await env.DB.prepare("SELECT * FROM care_searches WHERE id = ? OR public_code = ? LIMIT 1").bind(identifier, identifier).first();
  const search = normalizeCareSearchRow(row);
  if (!search) return null;
  const offerResult = await env.DB.prepare(`
    SELECT * FROM care_offers
    WHERE search_id = ? AND status IN ('active', 'selected')
    ORDER BY
      CASE status WHEN 'selected' THEN 0 ELSE 1 END,
      CASE response_type WHEN 'available_now' THEN 0 WHEN 'emergency_intake' THEN 1 ELSE 2 END,
      COALESCE(wait_min, 9999), offered_at
    LIMIT ?
  `).bind(search.id, search.maxOffers).all();
  const offers = await Promise.all(offerResult.results.map(async (offer) => normalizeOfferRow(offer, await getLocation(env, offer.location_id), search)));
  const counts = await env.DB.prepare(`
    SELECT
      COUNT(*) AS contacted,
      SUM(CASE WHEN status IN ('contacting', 'awaiting_response') THEN 1 ELSE 0 END) AS awaiting,
      SUM(CASE WHEN status = 'declined' THEN 1 ELSE 0 END) AS declined
    FROM care_search_targets WHERE search_id = ?
  `).bind(search.id).first();
  return {
    ...search,
    offers,
    progress: {
      contacted: Number(counts?.contacted || 0),
      awaiting: Number(counts?.awaiting || 0),
      declined: Number(counts?.declined || 0),
      offers: offers.length
    }
  };
}

function normalizeClinicSearchTarget(row) {
  if (!row) return null;
  const status = ["contacting", "awaiting_response"].includes(row.target_status) ? "pending" : row.target_status;
  return {
    id: row.target_id,
    searchId: row.search_id,
    publicCode: row.public_code,
    locationId: row.location_id,
    tenantId: row.tenant_id,
    customerUserId: row.customer_user_id,
    pet: {
      name: row.pet_name,
      species: row.species,
      breed: row.breed,
      ageYears: row.age_years,
      weightLbs: row.weight_lbs,
      // Optional, owner-supplied, and null on every row written before the
      // column existed.
      medications: row.medications || null,
      allergies: row.allergies || null
    },
    owner: {
      name: row.owner_name,
      phone: row.owner_phone,
      email: row.owner_email
    },
    concernCategory: row.concern_category,
    concernSummary: row.concern_summary,
    urgency: row.urgency,
    redFlags: parseJson(row.red_flags_json, []),
    travelMinutes: row.travel_minutes,
    status,
    requestedAt: row.requested_at,
    requestExpiresAt: row.collection_expires_at || row.search_expires_at,
    respondedAt: row.responded_at,
    searchTarget: true,
    createdAt: row.target_created_at,
    updatedAt: row.target_updated_at
  };
}

const CLINIC_SEARCH_TARGET_SELECT = `
  SELECT
    t.id AS target_id, t.search_id, t.location_id, t.tenant_id,
    t.status AS target_status, t.travel_minutes, t.responded_at,
    t.created_at AS target_created_at, t.updated_at AS target_updated_at,
    s.public_code, s.customer_user_id, s.pet_name, s.species, s.breed,
    s.age_years, s.weight_lbs, s.owner_name, s.owner_phone, s.owner_email,
    s.concern_category, s.concern_summary, s.urgency, s.red_flags_json,
    s.requested_at, s.collection_expires_at, s.search_expires_at
  FROM care_search_targets t
  JOIN care_searches s ON s.id = t.search_id
`;

export async function listClinicSearchTargets(env, tenantId, limit = 50) {
  if (!hasDatabase(env)) return [];
  const result = await env.DB.prepare(`${CLINIC_SEARCH_TARGET_SELECT}
    WHERE t.tenant_id = ? AND s.status IN ('collecting', 'offers_ready')
    ORDER BY CASE t.status WHEN 'awaiting_response' THEN 0 WHEN 'contacting' THEN 1 ELSE 2 END,
             datetime(s.requested_at) DESC
    LIMIT ?
  `).bind(tenantId, limit).all();
  return result.results.map(normalizeClinicSearchTarget);
}

export async function getClinicSearchTarget(env, targetId, tenantId) {
  if (!hasDatabase(env)) return null;
  const row = await env.DB.prepare(`${CLINIC_SEARCH_TARGET_SELECT}
    WHERE t.id = ? AND t.tenant_id = ? LIMIT 1
  `).bind(targetId, tenantId).first();
  return normalizeClinicSearchTarget(row);
}

export async function getCareOffer(env, searchId, offerId) {
  if (!hasDatabase(env)) return null;
  const search = await getCareSearch(env, searchId);
  if (!search) return null;
  const row = await env.DB.prepare("SELECT * FROM care_offers WHERE id = ? AND search_id = ? LIMIT 1").bind(offerId, search.id).first();
  return row ? normalizeOfferRow(row, await getLocation(env, row.location_id), search) : null;
}

export function normalizeIntakeRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    publicCode: row.public_code,
    locationId: row.location_id,
    tenantId: row.tenant_id,
    customerUserId: row.customer_user_id,
    pet: {
      name: row.pet_name,
      species: row.species,
      breed: row.breed,
      ageYears: row.age_years,
      weightLbs: row.weight_lbs,
      // Optional, owner-supplied, and null on every row written before the
      // column existed.
      medications: row.medications || null,
      allergies: row.allergies || null
    },
    owner: {
      name: row.owner_name,
      phone: row.owner_phone,
      email: row.owner_email
    },
    concernCategory: row.concern_category,
    concernSummary: row.concern_summary,
    urgency: row.urgency,
    redFlags: parseJson(row.red_flags_json, []),
    travelMinutes: row.travel_minutes,
    status: row.status,
    clinicNote: row.clinic_note,
    requestedAt: row.requested_at,
    decisionAt: row.decision_at,
    requestExpiresAt: row.request_expires_at,
    arrivalBy: row.arrival_by,
    policy: parseJson(row.policy_snapshot_json, {}),
    depositAmountCents: row.deposit_amount_cents,
    paymentStatus: row.payment_status,
    paymentProviderId: row.payment_provider_id,
    sourceSearchId: row.source_search_id || null,
    selectedOfferId: row.selected_offer_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function getIntake(env, identifier) {
  if (!hasDatabase(env)) return null;
  const row = await env.DB.prepare("SELECT * FROM intake_requests WHERE id = ? OR public_code = ? LIMIT 1").bind(identifier, identifier).first();
  return normalizeIntakeRow(row);
}

export async function listClinicIntakes(env, tenantId, limit = 50) {
  if (!hasDatabase(env)) {
    if (tenantId !== "tenant_hearth") return [];
    const requestedAt = new Date(Date.now() - 2 * 60_000).toISOString();
    return [{
      id: "demo_clinic_request",
      publicCode: "TIMI-DEMO",
      locationId: "loc_hearth",
      tenantId: "tenant_hearth",
      customerUserId: "demo_customer",
      pet: { name: "Milo", species: "dog", breed: "German shepherd", ageYears: 6, weightLbs: 78 },
      owner: { name: "Avery Cole", phone: "(510) 555-0126", email: "avery@example.com" },
      concernCategory: "illness_or_injury",
      concernSummary: "Limping after a run and avoiding weight on the front paw.",
      urgency: "urgent",
      redFlags: [],
      travelMinutes: 11,
      status: "pending",
      clinicNote: null,
      requestedAt,
      decisionAt: null,
      requestExpiresAt: new Date(Date.now() + 6 * 60_000).toISOString(),
      arrivalBy: null,
      policy: DEMO_LOCATIONS.find((location) => location.id === "loc_hearth")?.policy || {},
      depositAmountCents: 5000,
      paymentStatus: "pending",
      createdAt: requestedAt,
      updatedAt: requestedAt,
      demo: true
    }].slice(0, limit);
  }
  const result = await env.DB.prepare(`
    SELECT * FROM intake_requests
    WHERE tenant_id = ?
    ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'accepted' THEN 1 WHEN 'en_route' THEN 2 WHEN 'arrived' THEN 3 ELSE 4 END,
             requested_at DESC
    LIMIT ?
  `).bind(tenantId, limit).all();
  return result.results.map(normalizeIntakeRow);
}
