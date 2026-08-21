import { actorForRequest, roleAllows, signInRequired } from "./auth.js";
import { RED_FLAG_TERMS, VALID_INTAKE_STATUS, VALID_SPECIES, VALID_URGENCY } from "./catalog.js";
import {
  getClinicLocation,
  getIntake,
  getLocation,
  hasDatabase,
  listClinicIntakes,
  listLocations,
  normalizeIntakeRow,
  tenantIdForClerkOrg
} from "./db.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const SECURITY_HEADERS = {
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), payment=(self), geolocation=(self)"
};

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
    version: "1.0.0-mvp",
    signInRequired: signInRequired(env),
    clerkPublishableKey: signInRequired(env) ? (env.CLERK_PUBLISHABLE_KEY || null) : null,
    clerkJsUrl: signInRequired(env) ? (env.CLERK_JS_URL || "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/+esm") : null,
    stripePublishableKey: env.STRIPE_PUBLISHABLE_KEY || null,
    demoMode: env.DEMO_MODE === "true",
    database: hasDatabase(env) ? "d1" : "fixtures"
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

function validateIntake(body) {
  const pet = body.pet && typeof body.pet === "object" ? body.pet : {};
  const owner = body.owner && typeof body.owner === "object" ? body.owner : {};
  const species = cleanString(pet.species, 30).toLowerCase();
  const requestedUrgency = cleanString(body.urgency, 30).toLowerCase();
  const concernSummary = cleanString(body.concernSummary, 1200);
  const redFlags = redFlagsFrom(concernSummary, body.redFlags);
  const urgency = redFlags.length ? "emergency" : requestedUrgency;
  const errors = [];
  if (!cleanString(body.locationId, 80)) errors.push("locationId is required");
  if (!cleanString(pet.name, 80)) errors.push("pet.name is required");
  if (!VALID_SPECIES.has(species)) errors.push("pet.species is invalid");
  if (!cleanString(owner.name, 120)) errors.push("owner.name is required");
  if (!/^\+?[0-9().\-\s]{7,24}$/.test(cleanString(owner.phone, 30))) errors.push("owner.phone is invalid");
  if (!cleanString(body.concernCategory, 80)) errors.push("concernCategory is required");
  if (concernSummary.length < 5) errors.push("concernSummary must contain at least 5 characters");
  if (!VALID_URGENCY.has(urgency)) errors.push("urgency is invalid");
  if (body.consentToContact !== true) errors.push("consentToContact is required");
  return { errors, pet, owner, species, urgency, concernSummary, redFlags };
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
      concernSummary: validated.concernSummary,
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
      validated.concernSummary, validated.urgency, JSON.stringify(validated.redFlags), customerLatitude,
      customerLongitude, travelMinutes, status, now, decisionAt, isoAfter(requestTtl), arrivalBy,
      JSON.stringify(policy), policy.depositAmountCents || 0, paymentStatus
    ),
    env.DB.prepare(`
      INSERT INTO intake_events (id, intake_id, event_type, actor_type, actor_id, detail_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(eventId, intakeId, status === "accepted" ? "auto_accepted" : "requested", "customer", actor?.userId || null, JSON.stringify({ urgency: validated.urgency, redFlags: validated.redFlags })),
    env.DB.prepare(`
      INSERT INTO notification_outbox (id, tenant_id, intake_id, channel, template_key, payload_json, available_at)
      VALUES (?, ?, ?, 'dashboard', 'new_intake_request', ?, ?)
    `).bind(notificationId, location.tenantId, intakeId, JSON.stringify({ publicCode: code, petName: cleanString(validated.pet.name, 80), urgency: validated.urgency }), now)
  ]);

  const created = await getIntake(env, intakeId);
  return json({ intake: created, location: enrichLocation(location), requiresClinicConfirmation: status === "pending" }, { status: 201 });
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

async function clinicDashboard(env, tenantId) {
  const location = await getClinicLocation(env, tenantId);
  if (!location) return apiError(404, "CLINIC_NOT_FOUND", "No clinic is mapped to the active Clerk organization.");
  const requests = await listClinicIntakes(env, tenantId);
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

async function setClinicAvailability(request, env, actor, tenantId) {
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

async function decideIntake(request, env, actor, tenantId, intakeId) {
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
  if (statements.length) await env.DB.batch(statements);
  console.log(JSON.stringify({ event: "scheduled_expiry_complete", at: now, expired: expired.results.length, noShows: noShows.results.length }));
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (method === "GET" && path === "/api/health") return json({ ok: true, service: "timinow", version: "1.0.0-mvp", database: hasDatabase(env) });
  if (method === "GET" && path === "/api/config") return handleConfig(env);
  if (method === "GET" && path === "/api/locations") return handleLocationSearch(url, env);
  if (method === "GET" && path.startsWith("/api/locations/")) {
    const location = await getLocation(env, decodeURIComponent(path.slice("/api/locations/".length)));
    return location ? json({ location: enrichLocation(location) }) : apiError(404, "LOCATION_NOT_FOUND", "The hospital was not found.");
  }

  const actor = await authenticatedActor(request, env);
  if (signInRequired(env) && !actor) return authRequiredResponse();

  if (method === "POST" && path === "/api/intakes") return createIntake(request, env, actor);
  if (method === "POST" && path === "/api/observations") return recordObservation(request, env, actor);

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
