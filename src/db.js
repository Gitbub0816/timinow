import { DEMO_LOCATIONS } from "./catalog.js";
import { assignAliases, maskedMatchCard, ratingModuleEnabled } from "./match-alias.js";

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
    // Null on every location assigned before migration 0024 — see
    // src/markets.js assignLocationToMarket.
    marketId: row.market_id || null,
    name: row.name,
    slug: row.slug,
    kind: row.kind,
    address: `${row.address_line1}, ${row.city}, ${row.region} ${row.postal_code}`,
    // Separate from the composed address above so a masked offer (see
    // maskedOfferLocation) can say roughly where a clinic is without saying
    // exactly where.
    city: row.city,
    region: row.region,
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
    // Null/0 on every row written before migration 0024 — see src/markets.js
    // resolveSearchMarket, called once at createCareSearch and never revisited.
    marketId: row.market_id || null,
    outOfMarket: row.out_of_market === 1 || row.out_of_market === true,
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
    // Staged wave routing (migration 0021 / src/routing.js). currentWave and
    // totalWaves let the customer UI say "we're expanding your search"
    // instead of a bare spinner; routingSnapshot is the frozen policy this
    // particular search is running under.
    currentWave: row.current_wave || 1,
    lastWaveActivatedAt: row.last_wave_activated_at,
    routingSnapshot: parseJson(row.routing_snapshot_json, null),
    firstOfferAt: row.first_offer_at,
    smsNotifiedAt: row.sms_notified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * What a customer sees for a clinic they have not chosen and have not paid
 * Tími's fee for: enough to compare and decide, nothing that lets the trip
 * happen without going through Tími.
 *
 * The card carries a temporary match alias — "Sequoia" — assigned per search
 * session, never permanently. A generic label like "Urgent care clinic in
 * Hayward" was the first attempt and gave up more than it looked: in a town
 * with one urgent-care clinic it is a name. The alias carries no information
 * about the clinic at all, and `maskedMatchCard` in src/match-alias.js is
 * what decides which fields survive — including keeping Google's rating in
 * its own attributed container, well away from Tími's own claims.
 */

function normalizeOfferRow(row, location, search, { revealLocation = true, alias = null, ratingsEnabled = false } = {}) {
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
    /**
     * The clinic id is deliberately absent from a masked offer: the whole
     * point is that the pre-confirmation payload cannot be resolved to a
     * business. The offer's own id is the token the client sends back on
     * selection, and the server resolves it.
     */
    locationId: revealLocation ? row.location_id : undefined,
    tenantId: revealLocation ? row.tenant_id : undefined,
    location: revealLocation
      ? enrichedLocation
      : maskedMatchCard(enrichedLocation, alias, {
          matchToken: row.id,
          travelMinutes: row.travel_minutes ?? null,
          ratingsEnabled
        })
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
  /**
   * Full clinic details reveal only for the offer the customer has actually
   * chosen. Everything still being compared wears a temporary match alias, so
   * a customer cannot shop the app for a free address and drive there without
   * going through Tími at all.
   *
   * The search's own id is the alias session id, which is what makes the
   * mapping stable: this endpoint is polled every few seconds while offers
   * arrive, and a card that renamed itself on every poll would be unusable as
   * well as untrustworthy. A different search gets different aliases even for
   * the same clinics.
   */
  const locations = await Promise.all(offerResult.results.map((offer) => getLocation(env, offer.location_id)));
  let aliases = { byClinicId: {} };
  try {
    aliases = await assignAliases(env, {
      searchSessionId: search.id,
      searchId: search.id,
      userId: search.customerUserId || null,
      clinicIds: offerResult.results.map((offer) => offer.location_id),
      // Screened against the offered clinics' own names so an alias can never
      // accidentally be the name of the clinic it is concealing.
      candidateNames: locations.filter(Boolean).map((location) => location.name)
    });
  } catch (error) {
    /**
     * A search must survive the alias table being unavailable, and it must
     * fail toward concealment rather than away from it: the card below is
     * built the same way either way, so a missing alias costs a friendly
     * label and nothing else. Reversing that — revealing the clinic because
     * naming it failed — would turn a cosmetic outage into a bypass.
     */
    console.warn(JSON.stringify({ event: "match_alias_assignment_failed", searchId: search.id, message: error.message }));
  }
  const ratingsEnabled = ratingModuleEnabled(env);
  const offers = offerResult.results.map((offer, index) =>
    normalizeOfferRow(offer, locations[index], search, {
      revealLocation: offer.status === "selected",
      alias: aliases.byClinicId?.[offer.location_id] || null,
      ratingsEnabled
    })
  );
  const counts = await env.DB.prepare(`
    SELECT
      COUNT(*) AS candidates,
      SUM(CASE WHEN wave_activated_at IS NOT NULL THEN 1 ELSE 0 END) AS contacted,
      SUM(CASE WHEN wave_activated_at IS NULL AND status IN ('contacting', 'awaiting_response') THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN status IN ('contacting', 'awaiting_response') THEN 1 ELSE 0 END) AS awaiting,
      SUM(CASE WHEN status = 'declined' THEN 1 ELSE 0 END) AS declined,
      MAX(wave_number) AS total_waves
    FROM care_search_targets WHERE search_id = ?
  `).bind(search.id).first();
  return {
    ...search,
    offers,
    totalWaves: Number(counts?.total_waves || 1),
    progress: {
      // "contacted" now means "actually notified" — a target sitting in a
      // future wave that has not activated yet is a candidate, not yet
      // contacted. See migration 0021: staged wave routing replaced the
      // single broadcast this count used to describe.
      candidates: Number(counts?.candidates || 0),
      contacted: Number(counts?.contacted || 0),
      queued: Number(counts?.queued || 0),
      awaiting: Number(counts?.awaiting || 0),
      declined: Number(counts?.declined || 0),
      offers: offers.length
    }
  };
}

/**
 * Masked owner identity for a clinic that has not yet been booked and paid.
 *
 * At most a first name and a last initial — never a phone number, never an
 * email, and "Pet owner" when there is nothing safe to show at all. See
 * migration 0021 and docs/MVP-ARCHITECTURE.md: full contact reveals only to
 * the winning clinic, only once the customer has selected it.
 */
function maskOwnerIdentity(fullName) {
  const trimmed = String(fullName || "").trim();
  if (!trimmed) return "Pet owner";
  const parts = trimmed.split(/\s+/).filter(Boolean);
  const first = parts[0];
  if (parts.length < 2) return first;
  const lastInitial = parts[parts.length - 1][0];
  return lastInitial ? `${first} ${lastInitial.toUpperCase()}.` : first;
}

function normalizeClinicSearchTarget(row) {
  if (!row) return null;
  const status = ["contacting", "awaiting_response"].includes(row.target_status) ? "pending" : row.target_status;
  // Full contact reveals to exactly one clinic: whichever target the
  // customer actually selected and booked. Every other target — still
  // pending, offered but not chosen, declined, released, or expired — gets
  // the masked identity. Never gated on payment status directly: a deposit
  // (if any) is collected against the accepted intake this selection just
  // created, and it is the selection itself — not the later payment webhook
  // — that is "this clinic is now the one seeing this patient", matching how
  // the rest of this codebase already treats a selected offer as the booking.
  const contactRevealed = row.target_status === "selected";
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
    owner: contactRevealed
      ? { name: row.owner_name, phone: row.owner_phone, email: row.owner_email }
      : { name: maskOwnerIdentity(row.owner_name), phone: null, email: null },
    /** Whether `owner` above carries real contact detail. Lets a console tell "no phone on file" apart from "not shown yet". */
    contactRevealed,
    concernCategory: row.concern_category,
    concernSummary: row.concern_summary,
    urgency: row.urgency,
    redFlags: parseJson(row.red_flags_json, []),
    travelMinutes: row.travel_minutes,
    status,
    waveNumber: row.wave_number,
    waveActivatedAt: row.wave_activated_at,
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
    t.wave_number, t.wave_activated_at,
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
      AND t.wave_activated_at IS NOT NULL
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
    // Frozen at settlement rather than recomputed. A tenant that edits its
    // policy afterwards must not retroactively change what a past visit was
    // worth, and `settlementOutcome` being non-null is what stops the
    // settlement sweep paying the same intake twice. Null on every row
    // written before migration 0008.
    settlementOutcome: row.settlement_outcome || null,
    settledAt: row.settled_at || null,
    clinicAmountCents: row.clinic_amount_cents ?? null,
    platformFeeCents: row.platform_fee_cents ?? null,
    refundAmountCents: row.refund_amount_cents ?? null,
    stripeTransferId: row.stripe_transfer_id || null,
    transferGroup: row.transfer_group || null,
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
