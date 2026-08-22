import { actorForRequest, isOrgAdmin, roleAllows, signInRequired } from "./auth.js";
import { describeSession } from "./session.js";
import {
  addMember,
  changeMemberRole,
  listMembers,
  removeMember,
  requireTenantAdmin,
  revokeInvitation
} from "./tenant-admin.js";
import { DEMO_LOCATIONS, RED_FLAG_TERMS, VALID_INTAKE_STATUS, VALID_SPECIES, VALID_URGENCY } from "./catalog.js";
import {
  getCareOffer,
  getCareSearch,
  getClinicSearchTarget,
  getClinicLocation,
  getIntake,
  getLocation,
  hasDatabase,
  listClinicSearchTargets,
  listClinicIntakes,
  listLocations,
  normalizeIntakeRow,
  tenantIdForClerkOrg
} from "./db.js";

const DEFAULT_MAP_STYLE = "mapbox://styles/calebowen2019/cmt3nci25004d01sya8qxcb4u";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const SECURITY_HEADERS = {
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), payment=(self), geolocation=(self)"
};
const VALID_SYMPTOMS = new Set(["vomiting_or_diarrhea", "breathing_or_coughing", "pain_or_limping", "not_eating_or_drinking", "urination_or_stool", "injury_or_bleeding", "energy_or_behavior", "eye_ear_or_skin", "other_observable"]);
const VALID_ONSETS = new Set(["within_hour", "today", "one_to_three_days", "more_than_three_days", "unknown"]);
const GENERIC_CONCERN = /^(?:(?:my|the)\s+(?:dog|cat|pet|animal)\s+)?(?:isn['’]?t|is not|doesn['’]?t seem|does not seem|hasn['’]?t been)?\s*(?:acting like (?:himself|herself|themself|themselves)|feeling (?:well|good)|doing (?:well|good)|right|normal|himself|herself|themselves|seems? off|sick|unwell|not okay|something(?: is|'s) wrong)[.! ]*$/i;
const OBSERVABLE_DETAIL = /\b(vomit|throw(?:ing)? up|diarrh|stool|feces|cough|wheez|breath|pant|limp|walk|stand|pain|cry|yelp|bleed|wound|swollen|lump|seiz|collaps|unconscious|urine|urinat|pee|drink|water|eat|food|appetite|eye|ear|skin|rash|itch|scratch|toxin|poison|chocol|medication|fever|temperature|discharge|shak|trembl|letharg|energy|sleep|hiding|aggress|abdomen|belly|leg|paw|mouth)\w*/i;
const DETAIL_MODIFIER = /\b(?:\d+|once|twice|three|four|several|every|hourly|constantly|repeatedly|since|minutes?|hours?|days?|today|yesterday|morning|tonight|won['’]?t|will not|can['’]?t|cannot|unable|refus|stopped|difficulty|struggl)\b/i;

function concernSpecificity(summary, symptoms, startedWhen) {
  const words = summary.match(/[a-z0-9'’]+/gi) || [];
  if (!symptoms.length) return "Select at least one observable symptom.";
  if (!VALID_ONSETS.has(startedWhen)) return "Choose when the concern started.";
  if (summary.length < 30 || words.length < 6) return "Describe what changed with at least 30 characters and six words.";
  if (GENERIC_CONCERN.test(summary) || (!OBSERVABLE_DETAIL.test(summary) && !DETAIL_MODIFIER.test(summary))) return "Describe an observable change, not only that the pet seems off.";
  if (symptoms.every((value) => ["energy_or_behavior", "other_observable"].includes(value)) && !OBSERVABLE_DETAIL.test(summary)) return "Behavior or energy concerns need a specific observable action.";
  return null;
}

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { ...JSON_HEADERS, ...SECURITY_HEADERS, ...(init.headers || {}) }
  });
}

function apiError(status, code, message, details) {
  return json({ error: { code, message, ...(details ? { details } : {}) } }, { status });
}

function cleanString(value, maxLength = 240) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function numberInRange(value, minimum, maximum, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : fallback;
}

async function readJson(request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 32_768) throw new Error("PAYLOAD_TOO_LARGE");
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new Error("JSON_REQUIRED");
  }
  return request.json();
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function publicCode() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(36).padStart(2, "0")).join("").toUpperCase();
}

function isoAfter(minutes) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function timestampMs(value) {
  if (!value) return Number.NaN;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  return Date.parse(normalized);
}

function redFlagsFrom(summary, suppliedFlags) {
  const normalized = summary.toLowerCase();
  const detected = RED_FLAG_TERMS.filter((term) => normalized.includes(term));
  const supplied = Array.isArray(suppliedFlags)
    ? suppliedFlags.map((value) => cleanString(value, 80)).filter(Boolean).slice(0, 8)
    : [];
  return [...new Set([...supplied, ...detected])];
}

function availabilityLabel(status) {
  return ({
    available: "Available now",
    limited: "Limited capacity",
    confirm_first: "Confirmation required",
    critical_only: "Critical patients only",
    diverting: "Diverting stable patients",
    closed: "Closed",
    unverified: "Current capacity unverified"
  })[status] || "Current capacity unverified";
}

function enrichLocation(location) {
  return {
    ...location,
    availability: {
      ...location.availability,
      label: availabilityLabel(location.availability.intakeStatus),
      ageSeconds: location.availability.reportedAt
        ? Math.max(0, Math.round((Date.now() - timestampMs(location.availability.reportedAt)) / 1000))
        : null
    }
  };
}

async function authenticatedActor(request, env) {
  const actor = await actorForRequest(request, env);
  if (!actor) return null;
  if (!actor.tenantId && actor.clerkOrgId) actor.tenantId = await tenantIdForClerkOrg(env, actor.clerkOrgId);
  return actor;
}

function authRequiredResponse() {
  return apiError(401, "AUTHENTICATION_REQUIRED", "Sign in is required to continue.");
}

async function handleConfig(env) {
  return json({
    appName: "Tími NOW",
    version: "1.1.0-multi-offer",
    signInRequired: signInRequired(env),
    clerkPublishableKey: signInRequired(env) ? (env.CLERK_PUBLISHABLE_KEY || null) : null,
    clerkJsUrl: signInRequired(env) ? (env.CLERK_JS_URL || "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/+esm") : null,
    stripePublishableKey: env.STRIPE_PUBLISHABLE_KEY || null,
    demoMode: env.DEMO_MODE === "true",
    database: hasDatabase(env) ? "d1" : "fixtures",
    surface: env.SURFACE || "customer",
    map: {
      /** Public Mapbox token. Never expose a secret (sk.) token here. */
      token: env.MAPBOX_PUBLIC_TOKEN || null,
      styleUrl: env.MAPBOX_STYLE_URL || DEFAULT_MAP_STYLE,
      /** The navigation UI reuses the same style so guidance matches the map. */
      navigationStyleUrl: env.MAPBOX_NAVIGATION_STYLE_URL || env.MAPBOX_STYLE_URL || DEFAULT_MAP_STYLE
    }
  });
}

async function handleLocationSearch(url, env) {
  const latitude = numberInRange(url.searchParams.get("lat"), -90, 90);
  const longitude = numberInRange(url.searchParams.get("lng"), -180, 180);
  const radiusMiles = numberInRange(url.searchParams.get("radius"), 1, 250, 50);
  const species = cleanString(url.searchParams.get("species"), 30).toLowerCase() || null;
  const care = cleanString(url.searchParams.get("care"), 30).toLowerCase() || "urgent";
  if (species && !VALID_SPECIES.has(species)) return apiError(400, "INVALID_SPECIES", "Choose a supported species.");
  if ((latitude === null) !== (longitude === null)) return apiError(400, "INVALID_LOCATION", "Latitude and longitude must be supplied together.");

  const locations = await listLocations(env, { latitude, longitude, radiusMiles, species, care });
  return json({
    generatedAt: new Date().toISOString(),
    query: { latitude, longitude, radiusMiles, species, care },
    locations: locations.map(enrichLocation)
  });
}

function humanizeOnset(value) {
  return ({ within_hour: "Started within the last hour", today: "Started today", one_to_three_days: "Started 1–3 days ago", more_than_three_days: "Started more than 3 days ago", unknown: "Onset unknown" })[value] || "Onset not reported";
}

function humanizeSymptom(value) {
  return ({ vomiting_or_diarrhea: "vomiting/diarrhea", breathing_or_coughing: "breathing/coughing", pain_or_limping: "pain/limping", not_eating_or_drinking: "not eating/drinking", urination_or_stool: "urination/stool", injury_or_bleeding: "injury/bleeding", energy_or_behavior: "energy/behavior", eye_ear_or_skin: "eye/ear/skin", other_observable: "other observable change" })[value] || value;
}

function validateIntake(body, { requireLocation = true } = {}) {
  const pet = body.pet && typeof body.pet === "object" ? body.pet : {};
  const owner = body.owner && typeof body.owner === "object" ? body.owner : {};
  const species = cleanString(pet.species, 30).toLowerCase();
  const requestedUrgency = cleanString(body.urgency, 30).toLowerCase();
  const concernSummary = cleanString(body.concernSummary, 1200);
  const symptoms = Array.isArray(body.symptoms) ? [...new Set(body.symptoms.map((value) => cleanString(value, 50)).filter((value) => VALID_SYMPTOMS.has(value)))].slice(0, 9) : [];
  const startedWhen = cleanString(body.startedWhen, 40);
  const redFlags = redFlagsFrom(concernSummary, body.redFlags);
  const urgency = redFlags.length ? "emergency" : requestedUrgency;
  const errors = [];
  if (requireLocation && !cleanString(body.locationId, 80)) errors.push("locationId is required");
  if (!cleanString(pet.name, 80)) errors.push("pet.name is required");
  if (!VALID_SPECIES.has(species)) errors.push("pet.species is invalid");
  if (!cleanString(owner.name, 120)) errors.push("owner.name is required");
  if (!/^\+?[0-9().\-\s]{7,24}$/.test(cleanString(owner.phone, 30))) errors.push("owner.phone is invalid");
  if (!cleanString(body.concernCategory, 80)) errors.push("concernCategory is required");
  const specificityError = concernSpecificity(concernSummary, symptoms, startedWhen);
  if (specificityError) errors.push(specificityError);
  if (!VALID_URGENCY.has(urgency)) errors.push("urgency is invalid");
  if (body.consentToContact !== true) errors.push("consentToContact is required");
  if (body.legalConsent !== true || cleanString(body.legalVersion, 20) !== "2026-08-21") errors.push("current terms and safety notice must be accepted");
  const clinicConcernSummary = `${humanizeOnset(startedWhen)} · ${symptoms.map(humanizeSymptom).join(", ")} · ${concernSummary}`;
  return { errors, pet, owner, species, urgency, concernSummary, clinicConcernSummary, symptoms, startedWhen, redFlags, legalVersion: "2026-08-21" };
}

async function createIntake(request, env, actor) {
  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    return apiError(error.message === "PAYLOAD_TOO_LARGE" ? 413 : 400, error.message, "A valid JSON request body is required.");
  }
  const validated = validateIntake(body);
  if (validated.errors.length) return apiError(422, "VALIDATION_FAILED", "Review the intake information.", validated.errors);

  const location = await getLocation(env, cleanString(body.locationId, 80));
  if (!location) return apiError(404, "LOCATION_NOT_FOUND", "That hospital is no longer available.");
  if (!location.species.includes(validated.species)) return apiError(409, "SPECIES_NOT_SUPPORTED", "This hospital does not list support for that species.");
  if (validated.urgency === "emergency" && location.kind !== "emergency" && !location.capabilities.includes("emergency")) {
    return apiError(409, "EMERGENCY_CAPABILITY_REQUIRED", "Select an emergency-capable hospital for these reported warning signs.");
  }
  if (["closed", "diverting"].includes(location.availability.intakeStatus) && validated.urgency !== "emergency") {
    return apiError(409, "NOT_ACCEPTING_STABLE_PATIENTS", "This hospital is not currently accepting stable arrivals.");
  }

  const now = new Date().toISOString();
  const requestTtl = validated.urgency === "emergency" ? 5 : validated.urgency === "urgent" ? 8 : 15;
  const canAutoAccept = location.autoAccept
    && ["available", "limited"].includes(location.availability.intakeStatus)
    && validated.urgency !== "emergency";
  const status = canAutoAccept ? "accepted" : "pending";
  const decisionAt = canAutoAccept ? now : null;
  const arrivalBy = canAutoAccept ? isoAfter(location.arrivalWindowMinutes) : null;
  const policy = location.policy || { depositRequired: false, depositAmountCents: 0 };
  const paymentStatus = policy.depositRequired ? "pending" : "not_required";
  const intakeId = newId(hasDatabase(env) ? "intake" : "demo");
  const code = publicCode();
  const eventId = newId("event");
  const notificationId = newId("notification");
  const ageYears = numberInRange(validated.pet.ageYears, 0, 80);
  const weightLbs = numberInRange(validated.pet.weightLbs, 0.1, 3000);
  const travelMinutes = numberInRange(body.travelMinutes, 1, 360);
  const customerLatitude = numberInRange(body.customerLatitude, -90, 90);
  const customerLongitude = numberInRange(body.customerLongitude, -180, 180);

  if (!hasDatabase(env)) {
    const intake = {
      id: intakeId,
      publicCode: code,
      locationId: location.id,
      tenantId: location.tenantId,
      customerUserId: actor?.userId || null,
      pet: {
        name: cleanString(validated.pet.name, 80),
        species: validated.species,
        breed: cleanString(validated.pet.breed, 120) || null,
        ageYears,
        weightLbs
      },
      owner: {
        name: cleanString(validated.owner.name, 120),
        phone: cleanString(validated.owner.phone, 30),
        email: cleanString(validated.owner.email, 160) || null
      },
      concernCategory: cleanString(body.concernCategory, 80),
      concernSummary: validated.clinicConcernSummary,
      urgency: validated.urgency,
      redFlags: validated.redFlags,
      travelMinutes,
      status,
      clinicNote: canAutoAccept ? "Demo confirmation: the veterinary team is ready for your arrival." : null,
      requestedAt: now,
      decisionAt,
      requestExpiresAt: isoAfter(requestTtl),
      arrivalBy,
      policy,
      depositAmountCents: policy.depositAmountCents || 0,
      paymentStatus,
      legalAcceptance: { version: validated.legalVersion, acceptedAt: now },
      createdAt: now,
      updatedAt: now,
      demo: true
    };
    return json({ intake, location: enrichLocation(location), requiresClinicConfirmation: status === "pending", demo: true }, { status: 201 });
  }

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO intake_requests (
        id, public_code, location_id, tenant_id, customer_user_id, pet_name, species, breed,
        age_years, weight_lbs, owner_name, owner_phone, owner_email, concern_category,
        concern_summary, urgency, red_flags_json, customer_latitude, customer_longitude,
        travel_minutes, status, requested_at, decision_at, request_expires_at, arrival_by,
        policy_snapshot_json, deposit_amount_cents, payment_status, consent_to_contact
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).bind(
      intakeId, code, location.id, location.tenantId, actor?.userId || null,
      cleanString(validated.pet.name, 80), validated.species, cleanString(validated.pet.breed, 120) || null,
      ageYears, weightLbs, cleanString(validated.owner.name, 120), cleanString(validated.owner.phone, 30),
      cleanString(validated.owner.email, 160) || null, cleanString(body.concernCategory, 80),
      validated.clinicConcernSummary, validated.urgency, JSON.stringify(validated.redFlags), customerLatitude,
      customerLongitude, travelMinutes, status, now, decisionAt, isoAfter(requestTtl), arrivalBy,
      JSON.stringify(policy), policy.depositAmountCents || 0, paymentStatus
    ),
    env.DB.prepare(`
      INSERT INTO intake_events (id, intake_id, event_type, actor_type, actor_id, detail_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(eventId, intakeId, status === "accepted" ? "auto_accepted" : "requested", "customer", actor?.userId || null, JSON.stringify({ urgency: validated.urgency, redFlags: validated.redFlags, symptoms: validated.symptoms, startedWhen: validated.startedWhen, legalVersion: validated.legalVersion, legalAcceptedAt: now })),
    env.DB.prepare(`
      INSERT INTO notification_outbox (id, tenant_id, intake_id, channel, template_key, payload_json, available_at)
      VALUES (?, ?, ?, 'dashboard', 'new_intake_request', ?, ?)
    `).bind(notificationId, location.tenantId, intakeId, JSON.stringify({ publicCode: code, petName: cleanString(validated.pet.name, 80), urgency: validated.urgency }), now)
  ]);

  const created = await getIntake(env, intakeId);
  return json({ intake: created, location: enrichLocation(location), requiresClinicConfirmation: status === "pending" }, { status: 201 });
}

function demoOffer(location, searchId, index) {
  const offeredAt = new Date().toISOString();
  const waitMin = location.availability.stableWaitMin;
  const waitMax = location.availability.stableWaitMax;
  return {
    id: `demo_offer_${index + 1}`,
    searchId,
    targetId: `demo_target_${index + 1}`,
    locationId: location.id,
    tenantId: location.tenantId,
    responseType: location.kind === "emergency" ? "emergency_intake" : "available_now",
    status: "active",
    availableAt: offeredAt,
    arrivalBy: isoAfter(location.arrivalWindowMinutes),
    waitMin,
    waitMax,
    clinicNote: location.availability.note,
    policy: location.policy,
    depositAmountCents: location.policy?.depositAmountCents || 0,
    baseExamFeeCents: location.baseExamFeeCents,
    offeredAt,
    expiresAt: isoAfter(5),
    location: enrichLocation(location)
  };
}

async function createCareSearch(request, env, actor) {
  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    return apiError(error.message === "PAYLOAD_TOO_LARGE" ? 413 : 400, error.message, "A valid JSON request body is required.");
  }
  const validated = validateIntake(body, { requireLocation: false });
  if (validated.errors.length) return apiError(422, "VALIDATION_FAILED", "Review the intake information.", validated.errors);

  const latitude = numberInRange(body.customerLatitude, -90, 90);
  const longitude = numberInRange(body.customerLongitude, -180, 180);
  if (latitude === null || longitude === null) return apiError(422, "LOCATION_REQUIRED", "Share a search location before contacting clinics.");
  const radiusMiles = numberInRange(body.radiusMiles, 1, 250, 50);
  const targetLimit = numberInRange(body.targetLimit, 1, 30, 30);
  const requestedLocationIds = Array.isArray(body.locationIds)
    ? new Set(body.locationIds.map((value) => cleanString(value, 80)).filter(Boolean).slice(0, 30))
    : null;
  let candidates = await listLocations(env, {
    latitude,
    longitude,
    radiusMiles,
    species: validated.species,
    care: validated.urgency === "emergency" ? "emergency" : "urgent"
  });
  if (requestedLocationIds?.size) candidates = candidates.filter((location) => requestedLocationIds.has(location.id));
  candidates = candidates
    .filter((location) => validated.urgency === "emergency" || !["closed", "diverting", "critical_only"].includes(location.availability.intakeStatus))
    .slice(0, targetLimit);
  if (!candidates.length) return apiError(409, "NO_MATCHING_CLINICS", "No participating clinic matches this search right now.");

  const searchId = newId(hasDatabase(env) ? "search" : "demo_search");
  const now = new Date().toISOString();
  const collectionExpiresAt = isoAfter(1.5);
  const searchExpiresAt = isoAfter(6.5);
  const ageYears = numberInRange(validated.pet.ageYears, 0, 80);
  const weightLbs = numberInRange(validated.pet.weightLbs, 0.1, 3000);

  if (!hasDatabase(env)) {
    const offers = candidates.slice(0, 5).map((location, index) => demoOffer(location, searchId, index));
    const search = {
      id: searchId,
      publicCode: publicCode(),
      customerUserId: actor?.userId || null,
      pet: { name: cleanString(validated.pet.name, 80), species: validated.species, breed: cleanString(validated.pet.breed, 120) || null, ageYears, weightLbs },
      owner: { name: cleanString(validated.owner.name, 120), phone: cleanString(validated.owner.phone, 30), email: cleanString(validated.owner.email, 160) || null },
      concernCategory: cleanString(body.concernCategory, 80),
      concernSummary: validated.clinicConcernSummary,
      urgency: validated.urgency,
      redFlags: validated.redFlags,
      customerLatitude: latitude,
      customerLongitude: longitude,
      radiusMiles,
      status: "offers_ready",
      maxOffers: 5,
      targetLimit,
      selectedOfferId: null,
      selectedIntakeId: null,
      requestedAt: now,
      collectionExpiresAt,
      searchExpiresAt,
      offers,
      progress: { contacted: candidates.length, awaiting: Math.max(0, candidates.length - offers.length), declined: 0, offers: offers.length },
      demo: true
    };
    return json({ search, demo: true }, { status: 201 });
  }

  const statements = [env.DB.prepare(`
    INSERT INTO care_searches (
      id, public_code, customer_user_id, pet_name, species, breed, age_years, weight_lbs,
      owner_name, owner_phone, owner_email, concern_category, concern_summary, urgency,
      red_flags_json, customer_latitude, customer_longitude, radius_miles, status,
      max_offers, target_limit, legal_version, legal_accepted_at, requested_at,
      collection_expires_at, search_expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'collecting', 5, ?, ?, ?, ?, ?, ?)
  `).bind(
    searchId, publicCode(), actor?.userId || null, cleanString(validated.pet.name, 80), validated.species,
    cleanString(validated.pet.breed, 120) || null, ageYears, weightLbs, cleanString(validated.owner.name, 120),
    cleanString(validated.owner.phone, 30), cleanString(validated.owner.email, 160) || null,
    cleanString(body.concernCategory, 80), validated.clinicConcernSummary, validated.urgency,
    JSON.stringify(validated.redFlags), latitude, longitude, radiusMiles, targetLimit,
    validated.legalVersion, now, now, collectionExpiresAt, searchExpiresAt
  )];

  candidates.forEach((location, rank) => {
    const targetId = newId("target");
    const travelMinutes = Math.max(5, Math.round((location.distanceMiles || 2) * 4));
    statements.push(
      env.DB.prepare(`
        INSERT INTO care_search_targets (
          id, search_id, location_id, tenant_id, rank, travel_minutes, status, contacted_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'awaiting_response', ?)
      `).bind(targetId, searchId, location.id, location.tenantId, rank + 1, travelMinutes, now),
      env.DB.prepare(`
        INSERT INTO notification_outbox (
          id, tenant_id, channel, template_key, payload_json, available_at
        ) VALUES (?, ?, 'dashboard', 'new_care_search', ?, ?)
      `).bind(newId("notification"), location.tenantId, JSON.stringify({ searchId, targetId, petName: cleanString(validated.pet.name, 80), urgency: validated.urgency }), now)
    );
  });
  await env.DB.batch(statements);
  return json({ search: await getCareSearch(env, searchId) }, { status: 201 });
}

export async function respondToCareSearch(request, env, actor, tenantId, targetId) {
  if (!hasDatabase(env)) return apiError(503, "DATABASE_REQUIRED", "D1 is required for multi-clinic offer responses.");
  const body = await readJson(request).catch(() => null);
  const decision = cleanString(body?.decision, 20);
  if (!new Set(["offer", "decline"]).has(decision)) return apiError(422, "INVALID_DECISION", "Choose offer or decline.");
  const target = await getClinicSearchTarget(env, targetId, tenantId);
  if (!target) return apiError(404, "SEARCH_TARGET_NOT_FOUND", "This clinic request was not found.");
  if (target.status !== "pending") return apiError(409, "ALREADY_DECIDED", "This clinic request has already been handled.");
  const search = await getCareSearch(env, target.searchId);
  const now = new Date().toISOString();
  if (!search || !["collecting", "offers_ready"].includes(search.status) || timestampMs(search.collectionExpiresAt || search.searchExpiresAt) <= Date.now()) {
    return apiError(409, "SEARCH_CLOSED", "The customer is no longer collecting clinic offers.");
  }

  if (decision === "decline") {
    const result = await env.DB.prepare(`
      UPDATE care_search_targets SET status = 'declined', responded_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND status IN ('contacting', 'awaiting_response')
    `).bind(now, now, target.id, tenantId).run();
    if (!result.meta?.changes) return apiError(409, "TARGET_CHANGED", "Another team member handled this request first.");
    return json({ target: { ...target, status: "declined", respondedAt: now } });
  }

  const responseType = cleanString(body?.responseType, 30) || (search.urgency === "emergency" ? "emergency_intake" : "available_now");
  if (!new Set(["available_now", "available_at", "emergency_intake"]).has(responseType)) return apiError(422, "INVALID_OFFER_TYPE", "Choose a supported availability offer.");
  const location = await getClinicLocation(env, tenantId);
  if (!location || location.id !== target.locationId) return apiError(409, "LOCATION_MISMATCH", "The active clinic cannot respond for this location.");
  const arrivalMinutes = numberInRange(body.arrivalWindowMinutes, 5, 360, location.arrivalWindowMinutes || 20);
  const suppliedAvailableAt = cleanString(body.availableAt, 40);
  if (responseType === "available_at" && !suppliedAvailableAt) return apiError(422, "AVAILABLE_TIME_REQUIRED", "Provide the time when this clinic can receive the patient.");
  const availableAtMs = suppliedAvailableAt ? Date.parse(suppliedAvailableAt) : Date.now();
  if (!Number.isFinite(availableAtMs) || availableAtMs < Date.now() - 60_000 || availableAtMs > Date.now() + 12 * 60 * 60_000) {
    return apiError(422, "INVALID_AVAILABLE_TIME", "Availability must be between now and 12 hours from now.");
  }
  const waitMin = numberInRange(body.waitMin, 0, 1440, location.availability.stableWaitMin);
  const waitMax = numberInRange(body.waitMax, 0, 1440, location.availability.stableWaitMax);
  if (waitMin !== null && waitMax !== null && waitMin > waitMax) return apiError(422, "INVALID_WAIT_RANGE", "Minimum wait cannot exceed maximum wait.");
  const offerId = newId("offer");
  const offerExpiresAt = isoAfter(numberInRange(body.holdMinutes, 2, 10, 5));
  const availableAt = new Date(availableAtMs).toISOString();
  const arrivalBy = new Date(availableAtMs + arrivalMinutes * 60_000).toISOString();
  const policy = location.policy || { depositRequired: false, depositAmountCents: 0 };
  const note = cleanString(body.note, 500) || null;

  const results = await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO care_offers (
        id, search_id, target_id, location_id, tenant_id, response_type, status,
        available_at, arrival_by, wait_min, wait_max, clinic_note, policy_snapshot_json,
        deposit_amount_cents, base_exam_fee_cents, offered_at, expires_at, created_by
      )
      SELECT ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE (SELECT COUNT(*) FROM care_offers WHERE search_id = ? AND status = 'active' AND datetime(expires_at) > datetime(?))
            < (SELECT max_offers FROM care_searches WHERE id = ?)
    `).bind(
      offerId, search.id, target.id, location.id, tenantId, responseType, availableAt, arrivalBy,
      waitMin, waitMax, note, JSON.stringify(policy), policy.depositAmountCents || 0,
      location.baseExamFeeCents, now, offerExpiresAt, actor.userId || null, search.id, now, search.id
    ),
    env.DB.prepare(`
      UPDATE care_search_targets
      SET status = CASE WHEN EXISTS (SELECT 1 FROM care_offers WHERE id = ?) THEN 'offered' ELSE 'released' END,
          responded_at = ?, released_at = CASE WHEN EXISTS (SELECT 1 FROM care_offers WHERE id = ?) THEN NULL ELSE ? END,
          updated_at = ?
      WHERE id = ? AND status IN ('contacting', 'awaiting_response')
    `).bind(offerId, now, offerId, now, now, target.id),
    env.DB.prepare(`
      UPDATE care_searches
      SET status = CASE
        WHEN (SELECT COUNT(*) FROM care_offers WHERE search_id = ? AND status = 'active' AND datetime(expires_at) > datetime(?)) >= max_offers THEN 'offers_ready'
        ELSE status END,
        updated_at = ?
      WHERE id = ? AND status IN ('collecting', 'offers_ready')
    `).bind(search.id, now, now, search.id),
    env.DB.prepare(`
      UPDATE care_search_targets
      SET status = 'released', released_at = ?, updated_at = ?
      WHERE search_id = ? AND status IN ('contacting', 'awaiting_response')
        AND (SELECT COUNT(*) FROM care_offers WHERE search_id = ? AND status = 'active' AND datetime(expires_at) > datetime(?))
            >= (SELECT max_offers FROM care_searches WHERE id = ?)
    `).bind(now, now, search.id, search.id, now, search.id)
  ]);
  if (!results[0]?.meta?.changes) return apiError(409, "OFFER_WINDOW_FULL", "The customer already has five active clinic offers.");
  return json({ search: await getCareSearch(env, search.id), offerId });
}

async function selectCareOffer(request, env, actor, searchId) {
  if (!hasDatabase(env)) return apiError(503, "DATABASE_REQUIRED", "D1 is required to confirm a clinic offer.");
  const body = await readJson(request).catch(() => null);
  const offerId = cleanString(body?.offerId, 100);
  if (!offerId) return apiError(422, "OFFER_REQUIRED", "Choose one clinic offer.");
  const search = await getCareSearch(env, searchId);
  if (!search) return apiError(404, "SEARCH_NOT_FOUND", "The care search was not found.");
  if (signInRequired(env) && search.customerUserId !== actor?.userId) return apiError(403, "SEARCH_ACCESS_DENIED", "This care search belongs to another account.");
  if (search.selectedIntakeId) return apiError(409, "OFFER_ALREADY_SELECTED", "A clinic has already been selected for this search.");
  if (!["collecting", "offers_ready"].includes(search.status)) return apiError(409, "SEARCH_CLOSED", "This care search is no longer accepting a selection.");
  if (timestampMs(search.searchExpiresAt) <= Date.now()) return apiError(409, "SEARCH_EXPIRED", "The clinic offers in this search have expired.");
  const offer = await getCareOffer(env, search.id, offerId);
  if (!offer || offer.status !== "active" || timestampMs(offer.expiresAt) <= Date.now()) return apiError(409, "OFFER_EXPIRED", "That clinic offer is no longer active.");
  const target = await env.DB.prepare("SELECT travel_minutes FROM care_search_targets WHERE id = ? AND search_id = ? LIMIT 1").bind(offer.targetId, search.id).first();
  const now = new Date().toISOString();
  const intakeId = newId("intake");
  const code = publicCode();
  const paymentStatus = offer.policy?.depositRequired && offer.depositAmountCents > 0 ? "pending" : "not_required";

  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE care_searches SET status = 'selected', selected_offer_id = ?, updated_at = ?
      WHERE id = ? AND selected_offer_id IS NULL AND status IN ('collecting', 'offers_ready')
    `).bind(offer.id, now, search.id),
    env.DB.prepare(`
      INSERT INTO intake_requests (
        id, public_code, location_id, tenant_id, customer_user_id, pet_name, species, breed,
        age_years, weight_lbs, owner_name, owner_phone, owner_email, concern_category,
        concern_summary, urgency, red_flags_json, customer_latitude, customer_longitude,
        travel_minutes, status, requested_at, decision_at, request_expires_at, arrival_by,
        clinic_note, policy_snapshot_json, deposit_amount_cents, payment_status, consent_to_contact,
        source_search_id, selected_offer_id
      )
      SELECT ?, ?, ?, ?, customer_user_id, pet_name, species, breed, age_years, weight_lbs,
             owner_name, owner_phone, owner_email, concern_category, concern_summary, urgency,
             red_flags_json, customer_latitude, customer_longitude, ?, 'accepted', requested_at,
             ?, ?, ?, ?, ?, ?, ?, 1, id, ?
      FROM care_searches
      WHERE id = ? AND selected_offer_id = ? AND selected_intake_id IS NULL
    `).bind(
      intakeId, code, offer.locationId, offer.tenantId, target?.travel_minutes || null, now,
      offer.expiresAt, offer.arrivalBy, offer.clinicNote, JSON.stringify(offer.policy || {}),
      offer.depositAmountCents, paymentStatus, offer.id, search.id, offer.id
    ),
    env.DB.prepare(`
      UPDATE care_searches SET selected_intake_id = ?, updated_at = ?
      WHERE id = ? AND selected_offer_id = ? AND selected_intake_id IS NULL
        AND EXISTS (SELECT 1 FROM intake_requests WHERE id = ?)
    `).bind(intakeId, now, search.id, offer.id, intakeId),
    env.DB.prepare(`
      UPDATE care_offers SET status = CASE WHEN id = ? THEN 'selected' ELSE 'released' END, updated_at = ?
      WHERE search_id = ? AND status = 'active'
        AND EXISTS (SELECT 1 FROM care_searches WHERE id = ? AND selected_offer_id = ?)
    `).bind(offer.id, now, search.id, search.id, offer.id),
    env.DB.prepare(`
      UPDATE care_search_targets SET
        status = CASE WHEN id = ? THEN 'selected' ELSE 'released' END,
        released_at = CASE WHEN id = ? THEN NULL ELSE ? END,
        updated_at = ?
      WHERE search_id = ? AND status IN ('contacting', 'awaiting_response', 'offered')
        AND EXISTS (SELECT 1 FROM care_searches WHERE id = ? AND selected_offer_id = ?)
    `).bind(offer.targetId, offer.targetId, now, now, search.id, search.id, offer.id),
    env.DB.prepare(`
      INSERT INTO intake_events (id, intake_id, event_type, actor_type, actor_id, detail_json)
      SELECT ?, ?, 'offer_selected', 'customer', ?, ?
      WHERE EXISTS (SELECT 1 FROM intake_requests WHERE id = ?)
    `).bind(newId("event"), intakeId, actor?.userId || null, JSON.stringify({ searchId: search.id, offerId: offer.id }), intakeId),
    env.DB.prepare(`
      INSERT INTO notification_outbox (id, tenant_id, intake_id, channel, recipient, template_key, payload_json, available_at)
      SELECT ?, ?, ?, 'dashboard', ?, 'offer_selected', ?, ?
      WHERE EXISTS (SELECT 1 FROM intake_requests WHERE id = ?)
    `).bind(newId("notification"), offer.tenantId, intakeId, search.owner.phone, JSON.stringify({ searchId: search.id, offerId: offer.id, publicCode: code }), now, intakeId),
    env.DB.prepare(`
      INSERT INTO notification_outbox (id, tenant_id, channel, template_key, payload_json, available_at)
      SELECT 'notification_' || lower(hex(randomblob(16))), tenant_id, 'dashboard', 'offer_released', ?, ?
      FROM care_search_targets
      WHERE search_id = ? AND id <> ?
        AND EXISTS (SELECT 1 FROM intake_requests WHERE id = ?)
    `).bind(JSON.stringify({ searchId: search.id, selectedOfferId: offer.id }), now, search.id, offer.targetId, intakeId)
  ]);
  if (!results[0]?.meta?.changes || !results[1]?.meta?.changes) return apiError(409, "SELECTION_RACE", "Another clinic offer was selected first. Refresh to continue.");
  const intake = await getIntake(env, intakeId);
  return json({ intake, location: enrichLocation(offer.location), search: await getCareSearch(env, search.id) }, { status: 201 });
}

async function cancelCareSearch(env, actor, searchId) {
  if (!hasDatabase(env)) return apiError(503, "DATABASE_REQUIRED", "D1 is required to cancel a care search.");
  const search = await getCareSearch(env, searchId);
  if (!search) return apiError(404, "SEARCH_NOT_FOUND", "The care search was not found.");
  if (signInRequired(env) && search.customerUserId !== actor?.userId) return apiError(403, "SEARCH_ACCESS_DENIED", "This care search belongs to another account.");
  if (!["collecting", "offers_ready"].includes(search.status)) return apiError(409, "SEARCH_CLOSED", "This care search can no longer be cancelled.");
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE care_searches SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('collecting', 'offers_ready')").bind(now, search.id),
    env.DB.prepare("UPDATE care_search_targets SET status = 'released', released_at = ?, updated_at = ? WHERE search_id = ? AND status IN ('contacting', 'awaiting_response', 'offered')").bind(now, now, search.id),
    env.DB.prepare("UPDATE care_offers SET status = 'released', updated_at = ? WHERE search_id = ? AND status = 'active'").bind(now, search.id)
  ]);
  return json({ search: await getCareSearch(env, search.id) });
}

async function updateCustomerIntakeStatus(request, env, actor, intakeId) {
  if (!hasDatabase(env)) return apiError(503, "DATABASE_REQUIRED", "D1 is required for intake updates.");
  const body = await readJson(request).catch(() => null);
  const requestedStatus = cleanString(body?.status, 30);
  const allowed = new Set(["cancelled", "en_route", "arrived"]);
  if (!allowed.has(requestedStatus)) return apiError(422, "INVALID_STATUS", "Customers may mark an intake cancelled, en route, or arrived.");
  const intake = await getIntake(env, intakeId);
  if (!intake) return apiError(404, "INTAKE_NOT_FOUND", "The intake request was not found.");
  if (signInRequired(env) && intake.customerUserId !== actor?.userId) return apiError(403, "INTAKE_ACCESS_DENIED", "This intake belongs to another account.");
  const transitions = {
    pending: new Set(["cancelled"]),
    accepted: new Set(["cancelled", "en_route", "arrived"]),
    en_route: new Set(["cancelled", "arrived"])
  };
  if (!transitions[intake.status]?.has(requestedStatus)) return apiError(409, "INVALID_TRANSITION", `A ${intake.status} intake cannot become ${requestedStatus}.`);

  const now = new Date().toISOString();
  const result = await env.DB.prepare("UPDATE intake_requests SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
    .bind(requestedStatus, now, intake.id, intake.status).run();
  if (!result.meta?.changes) return apiError(409, "INTAKE_CHANGED", "The intake changed while this action was processed. Refresh and try again.");
  await env.DB.prepare("INSERT INTO intake_events (id, intake_id, event_type, actor_type, actor_id, detail_json) VALUES (?, ?, ?, 'customer', ?, '{}')")
    .bind(newId("event"), intake.id, requestedStatus, actor?.userId || null).run();
  return json({ intake: await getIntake(env, intake.id) });
}

async function recordObservation(request, env, actor) {
  const body = await readJson(request).catch(() => null);
  const milestone = cleanString(body?.milestone, 40);
  const allowed = new Set(["arrived", "triaged", "seen", "departed", "staff_wait_quote"]);
  if (!allowed.has(milestone)) return apiError(422, "INVALID_MILESTONE", "Choose a valid care milestone.");
  const location = await getLocation(env, cleanString(body.locationId, 80));
  if (!location) return apiError(404, "LOCATION_NOT_FOUND", "The hospital was not found.");
  if (!hasDatabase(env)) return json({ recorded: true, observedAt: new Date().toISOString(), demo: true }, { status: 201 });
  const intake = body.intakeId ? await getIntake(env, cleanString(body.intakeId, 100)) : null;
  if (intake && signInRequired(env) && intake.customerUserId !== actor?.userId) return apiError(403, "INTAKE_ACCESS_DENIED", "This intake belongs to another account.");
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO customer_observations (id, intake_id, location_id, milestone, observed_at, wait_quote_min, wait_quote_max, anonymous_session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    newId("observation"), intake?.id || null, location.id, milestone, now,
    numberInRange(body.waitQuoteMin, 0, 1440), numberInRange(body.waitQuoteMax, 0, 1440),
    actor?.userId || cleanString(body.anonymousSessionId, 100) || null
  ).run();
  if (intake && ["arrived", "triaged", "seen"].includes(milestone)) {
    await env.DB.prepare("UPDATE intake_requests SET status = ?, updated_at = ? WHERE id = ?").bind(milestone, now, intake.id).run();
    await env.DB.prepare("INSERT INTO intake_events (id, intake_id, event_type, actor_type, actor_id, detail_json) VALUES (?, ?, ?, 'customer', ?, '{}')")
      .bind(newId("event"), intake.id, milestone, actor?.userId || null).run();
  }
  return json({ recorded: true, observedAt: now }, { status: 201 });
}

export async function clinicDashboard(env, tenantId) {
  const location = await getClinicLocation(env, tenantId);
  if (!location) return apiError(404, "CLINIC_NOT_FOUND", "No clinic is mapped to the active Clerk organization.");
  const [intakes, searchTargets] = await Promise.all([
    listClinicIntakes(env, tenantId),
    listClinicSearchTargets(env, tenantId)
  ]);
  const requests = [...searchTargets, ...intakes].sort((a, b) => {
    const pendingDifference = Number(b.status === "pending") - Number(a.status === "pending");
    return pendingDifference || timestampMs(b.requestedAt) - timestampMs(a.requestedAt);
  });
  let observations = [];
  if (hasDatabase(env)) {
    const result = await env.DB.prepare(`
      SELECT milestone, observed_at, wait_quote_min, wait_quote_max
      FROM customer_observations WHERE location_id = ?
      ORDER BY observed_at DESC LIMIT 20
    `).bind(location.id).all();
    observations = result.results;
  }
  const today = new Date().toISOString().slice(0, 10);
  return json({
    location: enrichLocation(location),
    requests,
    observations,
    metrics: {
      pending: requests.filter((item) => item.status === "pending").length,
      activeArrivals: requests.filter((item) => ["accepted", "en_route", "arrived", "triaged"].includes(item.status)).length,
      completedToday: requests.filter((item) => item.status === "completed" && item.updatedAt?.startsWith(today)).length,
      declinedToday: requests.filter((item) => item.status === "declined" && item.updatedAt?.startsWith(today)).length
    }
  });
}

export async function setClinicAvailability(request, env, actor, tenantId) {
  const location = await getClinicLocation(env, tenantId);
  if (!location) return apiError(404, "CLINIC_NOT_FOUND", "The clinic location was not found.");
  const body = await readJson(request).catch(() => null);
  const intakeStatus = cleanString(body?.intakeStatus, 40);
  if (!VALID_INTAKE_STATUS.has(intakeStatus)) return apiError(422, "INVALID_AVAILABILITY", "Choose a valid intake status.");
  const ttlMinutes = numberInRange(body.ttlMinutes, 5, 180, 30);
  const waitMin = numberInRange(body.stableWaitMin, 0, 1440);
  const waitMax = numberInRange(body.stableWaitMax, 0, 1440);
  if (waitMin !== null && waitMax !== null && waitMin > waitMax) return apiError(422, "INVALID_WAIT_RANGE", "Minimum wait cannot exceed maximum wait.");
  const now = new Date().toISOString();
  if (!hasDatabase(env)) {
    const demoLocation = {
      ...location,
      availability: {
        ...location.availability,
        intakeStatus,
        stableWaitMin: waitMin,
        stableWaitMax: waitMax,
        capacityCount: numberInRange(body.capacityCount, 0, 100),
        acceptsCritical: body.acceptsCritical !== false,
        source: "hospital",
        confidence: "high",
        note: cleanString(body.note, 500) || null,
        reportedAt: now,
        expiresAt: isoAfter(ttlMinutes)
      }
    };
    return json({ location: enrichLocation(demoLocation), demo: true }, { status: 201 });
  }
  await env.DB.prepare(`
    INSERT INTO availability_reports (
      id, location_id, intake_status, stable_wait_min, stable_wait_max, capacity_count,
      accepts_critical, source, confidence, note, reported_at, expires_at, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'hospital', 'high', ?, ?, ?, ?)
  `).bind(
    newId("availability"), location.id, intakeStatus, waitMin, waitMax,
    numberInRange(body.capacityCount, 0, 100), body.acceptsCritical === false ? 0 : 1,
    cleanString(body.note, 500) || null, now, isoAfter(ttlMinutes), actor.userId || null
  ).run();
  return json({ location: enrichLocation(await getLocation(env, location.id)) }, { status: 201 });
}

export async function decideIntake(request, env, actor, tenantId, intakeId) {
  const body = await readJson(request).catch(() => null);
  const decision = cleanString(body?.decision, 20);
  if (!new Set(["accept", "decline"]).has(decision)) return apiError(422, "INVALID_DECISION", "Choose accept or decline.");
  const intake = hasDatabase(env)
    ? await getIntake(env, intakeId)
    : (await listClinicIntakes(env, tenantId)).find((item) => item.id === intakeId);
  if (!intake || intake.tenantId !== tenantId) return apiError(404, "INTAKE_NOT_FOUND", "The intake request was not found for this clinic.");
  if (intake.status !== "pending") return apiError(409, "ALREADY_DECIDED", "This request has already been handled.");
  const location = await getLocation(env, intake.locationId);
  const now = new Date().toISOString();
  const nextStatus = decision === "accept" ? "accepted" : "declined";
  const arrivalMinutes = numberInRange(body.arrivalWindowMinutes, 5, 180, location?.arrivalWindowMinutes || 20);
  const arrivalBy = decision === "accept" ? isoAfter(arrivalMinutes) : null;
  const note = cleanString(body.note, 500) || null;
  if (!hasDatabase(env)) {
    return json({
      intake: {
        ...intake,
        status: nextStatus,
        decisionAt: now,
        arrivalBy,
        clinicNote: note,
        updatedAt: now,
        demo: true
      },
      demo: true
    });
  }
  const result = await env.DB.prepare(`
    UPDATE intake_requests
    SET status = ?, decision_at = ?, arrival_by = ?, clinic_note = ?, updated_at = ?
    WHERE id = ? AND tenant_id = ? AND status = 'pending'
  `).bind(nextStatus, now, arrivalBy, note, now, intake.id, tenantId).run();
  if (!result.meta?.changes) return apiError(409, "INTAKE_CHANGED", "Another team member handled this request first.");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO intake_events (id, intake_id, event_type, actor_type, actor_id, detail_json) VALUES (?, ?, ?, 'clinic', ?, ?)")
      .bind(newId("event"), intake.id, nextStatus, actor.userId || null, JSON.stringify({ arrivalWindowMinutes: arrivalMinutes, note })),
    env.DB.prepare("INSERT INTO notification_outbox (id, tenant_id, intake_id, channel, recipient, template_key, payload_json, available_at) VALUES (?, ?, ?, 'dashboard', ?, ?, ?, ?)")
      .bind(newId("notification"), tenantId, intake.id, intake.owner.phone, `intake_${nextStatus}`, JSON.stringify({ publicCode: intake.publicCode, arrivalBy }), now)
  ]);
  return json({ intake: await getIntake(env, intake.id) });
}

async function createPaymentIntent(env, intake) {
  if (!intake.policy?.depositRequired || intake.depositAmountCents <= 0) return { mode: "none", intake };
  if (intake.paymentStatus === "paid") return { mode: "paid", intake };
  if (!env.STRIPE_SECRET_KEY) {
    if (env.DEMO_MODE !== "true") throw new Error("PAYMENTS_NOT_CONFIGURED");
    const providerId = newId("demo_payment");
    await env.DB.prepare("UPDATE intake_requests SET payment_status = 'paid', payment_provider_id = ?, updated_at = ? WHERE id = ?")
      .bind(providerId, new Date().toISOString(), intake.id).run();
    return { mode: "demo", intake: await getIntake(env, intake.id) };
  }

  const form = new URLSearchParams();
  form.set("amount", String(intake.depositAmountCents));
  form.set("currency", "usd");
  form.set("automatic_payment_methods[enabled]", "true");
  form.set("description", `Tími arrival deposit ${intake.publicCode}`);
  form.set("metadata[intake_id]", intake.id);
  form.set("metadata[tenant_id]", intake.tenantId);
  const response = await fetch("https://api.stripe.com/v1/payment_intents", {
    method: "POST",
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "content-type": "application/x-www-form-urlencoded" },
    body: form.toString()
  });
  const payment = await response.json();
  if (!response.ok) throw new Error(payment.error?.message || "Stripe rejected the payment request");
  await env.DB.prepare("UPDATE intake_requests SET payment_status = 'requires_action', payment_provider_id = ?, updated_at = ? WHERE id = ?")
    .bind(payment.id, new Date().toISOString(), intake.id).run();
  return { mode: "stripe", clientSecret: payment.client_secret, paymentIntentId: payment.id, intake: await getIntake(env, intake.id) };
}

async function handlePayment(request, env, actor, intakeId) {
  if (!hasDatabase(env)) return apiError(503, "DATABASE_REQUIRED", "D1 is required for payments.");
  const intake = await getIntake(env, intakeId);
  if (!intake) return apiError(404, "INTAKE_NOT_FOUND", "The intake request was not found.");
  if (signInRequired(env) && intake.customerUserId !== actor?.userId) return apiError(403, "INTAKE_ACCESS_DENIED", "This intake belongs to another account.");
  if (!new Set(["accepted", "en_route"]).has(intake.status)) return apiError(409, "INTAKE_NOT_ACCEPTED", "The clinic must accept the intake before collecting a deposit.");
  try {
    return json(await createPaymentIntent(env, intake), { status: 201 });
  } catch (error) {
    const status = error.message === "PAYMENTS_NOT_CONFIGURED" ? 503 : 502;
    return apiError(status, error.message === "PAYMENTS_NOT_CONFIGURED" ? error.message : "PAYMENT_PROVIDER_ERROR", error.message);
  }
}

async function refreshPayment(env, actor, intakeId) {
  if (!hasDatabase(env)) return apiError(503, "DATABASE_REQUIRED", "D1 is required for payments.");
  const intake = await getIntake(env, intakeId);
  if (!intake) return apiError(404, "INTAKE_NOT_FOUND", "The intake request was not found.");
  if (signInRequired(env) && intake.customerUserId !== actor?.userId) return apiError(403, "INTAKE_ACCESS_DENIED", "This intake belongs to another account.");
  if (!intake.paymentProviderId || intake.paymentProviderId.startsWith("demo_") || !env.STRIPE_SECRET_KEY) return json({ intake });
  const response = await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(intake.paymentProviderId)}`, {
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` }
  });
  const payment = await response.json();
  if (!response.ok) return apiError(502, "PAYMENT_PROVIDER_ERROR", payment.error?.message || "Unable to verify payment.");
  const statusMap = { succeeded: "paid", processing: "processing", requires_payment_method: "failed", requires_action: "requires_action", canceled: "failed" };
  const paymentStatus = statusMap[payment.status] || intake.paymentStatus;
  if (paymentStatus !== intake.paymentStatus) {
    await env.DB.prepare("UPDATE intake_requests SET payment_status = ?, updated_at = ? WHERE id = ?")
      .bind(paymentStatus, new Date().toISOString(), intake.id).run();
  }
  return json({ intake: await getIntake(env, intake.id), providerStatus: payment.status });
}

async function expireStaleState(env) {
  if (!hasDatabase(env)) return;
  const now = new Date().toISOString();
  const expired = await env.DB.prepare("SELECT id, status FROM intake_requests WHERE status = 'pending' AND request_expires_at <= ? LIMIT 200").bind(now).all();
  const noShows = await env.DB.prepare("SELECT id, status FROM intake_requests WHERE status IN ('accepted', 'en_route') AND arrival_by IS NOT NULL AND datetime(arrival_by) <= datetime(?, '-15 minutes') LIMIT 200").bind(now).all();
  const closedCollections = await env.DB.prepare(`
    SELECT s.id,
      (SELECT COUNT(*) FROM care_offers o WHERE o.search_id = s.id AND o.status = 'active' AND datetime(o.expires_at) > datetime(?)) AS active_offers
    FROM care_searches s
    WHERE s.status = 'collecting' AND datetime(s.collection_expires_at) <= datetime(?)
    LIMIT 200
  `).bind(now, now).all();
  const expiredSearches = await env.DB.prepare("SELECT id FROM care_searches WHERE status IN ('collecting', 'offers_ready') AND datetime(search_expires_at) <= datetime(?) LIMIT 200").bind(now).all();
  const expiredOffers = await env.DB.prepare("SELECT id, search_id FROM care_offers WHERE status = 'active' AND datetime(expires_at) <= datetime(?) LIMIT 200").bind(now).all();
  const statements = [];
  for (const intake of expired.results) {
    statements.push(
      env.DB.prepare("UPDATE intake_requests SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'").bind(now, intake.id),
      env.DB.prepare("INSERT INTO intake_events (id, intake_id, event_type, actor_type, actor_id, detail_json) VALUES (?, ?, 'expired', 'system', NULL, ?)").bind(newId("event"), intake.id, JSON.stringify({ previousStatus: intake.status }))
    );
  }
  for (const intake of noShows.results) {
    statements.push(
      env.DB.prepare("UPDATE intake_requests SET status = 'no_show', updated_at = ? WHERE id = ? AND status = ?").bind(now, intake.id, intake.status),
      env.DB.prepare("INSERT INTO intake_events (id, intake_id, event_type, actor_type, actor_id, detail_json) VALUES (?, ?, 'no_show', 'system', NULL, ?)").bind(newId("event"), intake.id, JSON.stringify({ previousStatus: intake.status, reason: "arrival_window_elapsed" }))
    );
  }
  for (const offer of expiredOffers.results) {
    statements.push(
      env.DB.prepare("UPDATE care_offers SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'active'").bind(now, offer.id),
      env.DB.prepare("UPDATE care_search_targets SET status = 'expired', updated_at = ? WHERE id = (SELECT target_id FROM care_offers WHERE id = ?) AND status = 'offered'").bind(now, offer.id)
    );
  }
  for (const search of closedCollections.results) {
    statements.push(
      env.DB.prepare("UPDATE care_searches SET status = ?, updated_at = ? WHERE id = ? AND status = 'collecting'").bind(Number(search.active_offers) > 0 ? "offers_ready" : "expired", now, search.id),
      env.DB.prepare("UPDATE care_search_targets SET status = 'released', released_at = ?, updated_at = ? WHERE search_id = ? AND status IN ('contacting', 'awaiting_response')").bind(now, now, search.id)
    );
  }
  for (const search of expiredSearches.results) {
    statements.push(
      env.DB.prepare("UPDATE care_searches SET status = 'expired', updated_at = ? WHERE id = ? AND status IN ('collecting', 'offers_ready')").bind(now, search.id),
      env.DB.prepare("UPDATE care_search_targets SET status = 'expired', updated_at = ? WHERE search_id = ? AND status IN ('contacting', 'awaiting_response', 'offered')").bind(now, search.id),
      env.DB.prepare("UPDATE care_offers SET status = 'expired', updated_at = ? WHERE search_id = ? AND status = 'active'").bind(now, search.id)
    );
  }
  if (statements.length) await env.DB.batch(statements);
  console.log(JSON.stringify({ event: "scheduled_expiry_complete", at: now, expired: expired.results.length, noShows: noShows.results.length, closedCollections: closedCollections.results.length, expiredSearches: expiredSearches.results.length, expiredOffers: expiredOffers.results.length }));
}

/**
 * Workspace people management. Mounted on every Worker so the veterinary console
 * and the tenant view of the admin console share one implementation. Creating a
 * tenant is deliberately absent here — that is platform-operator only.
 */
async function handleTenantAdmin(request, env, actor, path, method) {
  const tenantId = actor?.tenantId || (actor?.clerkOrgId ? await tenantIdForClerkOrg(env, actor.clerkOrgId) : null);
  const guard = requireTenantAdmin(actor, tenantId);
  if (guard) return apiError(guard.status, guard.code, guard.message);

  const respond = (result) => (result.code
    ? apiError(result.status, result.code, result.message)
    : json(result.body, { status: result.status }));

  try {
    if (method === "GET" && path === "/api/tenant/members") return json(await listMembers(env, actor, tenantId));
    if (method === "POST" && path === "/api/tenant/members") {
      const body = await readJson(request).catch(() => null);
      return respond(await addMember(env, actor, tenantId, body || {}));
    }
    const memberMatch = path.match(/^\/api\/tenant\/members\/([^/]+)$/);
    if (memberMatch) {
      const memberId = decodeURIComponent(memberMatch[1]);
      if (method === "PATCH") {
        const body = await readJson(request).catch(() => null);
        return respond(await changeMemberRole(env, actor, tenantId, memberId, body || {}));
      }
      if (method === "DELETE") return respond(await removeMember(env, actor, tenantId, memberId));
    }
    const inviteMatch = path.match(/^\/api\/tenant\/invitations\/([^/]+)$/);
    if (method === "DELETE" && inviteMatch) {
      return respond(await revokeInvitation(env, actor, tenantId, decodeURIComponent(inviteMatch[1])));
    }
  } catch (error) {
    if (error.name === "ClerkError") return apiError(error.status >= 400 && error.status < 600 ? error.status : 502, "CLERK_REQUEST_FAILED", error.message);
    throw error;
  }
  return null;
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (method === "GET" && path === "/api/health") return json({ ok: true, service: "timinow", version: "1.1.0-multi-offer", database: hasDatabase(env) });
  if (method === "GET" && path === "/api/config") return handleConfig(env);
  if (method === "GET" && path === "/api/locations") return handleLocationSearch(url, env);
  if (method === "GET" && path.startsWith("/api/locations/")) {
    const location = await getLocation(env, decodeURIComponent(path.slice("/api/locations/".length)));
    return location ? json({ location: enrichLocation(location) }) : apiError(404, "LOCATION_NOT_FOUND", "The hospital was not found.");
  }

  const actor = await authenticatedActor(request, env);
  if (signInRequired(env) && !actor) return authRequiredResponse();

  if (method === "GET" && path === "/api/session") {
    const session = await describeSession(env, actor);
    return session ? json({ session }) : authRequiredResponse();
  }

  if (path.startsWith("/api/tenant/")) {
    const tenantResponse = await handleTenantAdmin(request, env, actor, path, method);
    if (tenantResponse) return tenantResponse;
  }

  if (method === "POST" && path === "/api/intakes") return createIntake(request, env, actor);
  if (method === "POST" && path === "/api/searches") return createCareSearch(request, env, actor);
  if (method === "POST" && path === "/api/observations") return recordObservation(request, env, actor);

  const searchMatch = path.match(/^\/api\/searches\/([^/]+)(?:\/(select-offer|status))?$/);
  if (searchMatch) {
    const searchId = decodeURIComponent(searchMatch[1]);
    const action = searchMatch[2] || null;
    if (method === "GET" && !action) {
      const search = await getCareSearch(env, searchId);
      if (!search) return apiError(404, "SEARCH_NOT_FOUND", "The care search was not found.");
      if (signInRequired(env) && search.customerUserId !== actor?.userId) return apiError(403, "SEARCH_ACCESS_DENIED", "This care search belongs to another account.");
      return json({ search });
    }
    if (method === "POST" && action === "select-offer") return selectCareOffer(request, env, actor, searchId);
    if (method === "POST" && action === "status") {
      const body = await readJson(request).catch(() => null);
      if (cleanString(body?.status, 20) !== "cancelled") return apiError(422, "INVALID_STATUS", "A care search may only be cancelled.");
      return cancelCareSearch(env, actor, searchId);
    }
  }

  const intakeMatch = path.match(/^\/api\/intakes\/([^/]+)(?:\/(status|payment|payment-status))?$/);
  if (intakeMatch) {
    const intakeId = decodeURIComponent(intakeMatch[1]);
    const action = intakeMatch[2] || null;
    if (method === "GET" && !action) {
      const intake = await getIntake(env, intakeId);
      if (!intake) return apiError(404, "INTAKE_NOT_FOUND", "The intake request was not found.");
      if (signInRequired(env) && intake.customerUserId !== actor?.userId) return apiError(403, "INTAKE_ACCESS_DENIED", "This intake belongs to another account.");
      return json({ intake });
    }
    if (method === "POST" && action === "status") return updateCustomerIntakeStatus(request, env, actor, intakeId);
    if (method === "POST" && action === "payment") return handlePayment(request, env, actor, intakeId);
    if (method === "GET" && action === "payment-status") return refreshPayment(env, actor, intakeId);
  }

  if (path.startsWith("/api/clinic/")) {
    if (!roleAllows(actor, ["clinic", "admin", "org:admin", "org:member"])) return apiError(403, "CLINIC_ACCESS_REQUIRED", "Clinic organization access is required.");
    const tenantId = actor.tenantId;
    if (!tenantId) return apiError(403, "TENANT_REQUIRED", "Choose an active Clerk organization mapped to a Tími tenant.");
    if (method === "GET" && path === "/api/clinic/dashboard") return clinicDashboard(env, tenantId);
    if (method === "POST" && path === "/api/clinic/availability") return setClinicAvailability(request, env, actor, tenantId);
    const decisionMatch = path.match(/^\/api\/clinic\/intakes\/([^/]+)\/decision$/);
    if (method === "POST" && decisionMatch) return decideIntake(request, env, actor, tenantId, decodeURIComponent(decisionMatch[1]));
    const searchDecisionMatch = path.match(/^\/api\/clinic\/search-targets\/([^/]+)\/decision$/);
    if (method === "POST" && searchDecisionMatch) return respondToCareSearch(request, env, actor, tenantId, decodeURIComponent(searchDecisionMatch[1]));
  }

  return apiError(404, "NOT_FOUND", "The requested API route does not exist.");
}

export default {
  async fetch(request, env) {
    const requestId = request.headers.get("cf-ray") || crypto.randomUUID();
    const startedAt = Date.now();
    try {
      const url = new URL(request.url);
      const response = url.pathname.startsWith("/api/")
        ? await handleApi(request, env)
        : await env.ASSETS.fetch(request);
      const headers = new Headers(response.headers);
      Object.entries(SECURITY_HEADERS).forEach(([key, value]) => headers.set(key, value));
      headers.set("x-request-id", requestId);
      console.log(JSON.stringify({ event: "request", requestId, method: request.method, path: url.pathname, status: response.status, durationMs: Date.now() - startedAt }));
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch (error) {
      console.error(JSON.stringify({ event: "request_error", requestId, message: error.message, stack: error.stack }));
      return apiError(500, "INTERNAL_ERROR", "Tími could not complete that request. Please try again.", { requestId });
    }
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(expireStaleState(env));
  }
};
