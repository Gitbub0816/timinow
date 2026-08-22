/**
 * Tími voice gateway Worker (timinow-voice).
 *
 * Drains the `notification_outbox` rows with `channel = 'voice'` that
 * `createCareSearch` (in ../../../src/index.js) enqueues per clinic, places an
 * automated Twilio call, and lets the clinic answer with a two-question
 * touch-tone tree: press 1 to take the patient, 2 to decline.
 *
 * ACCEPT-PATH DRIFT WARNING — read this before touching `acceptSearchTargetByPhone`:
 * pressing "1" must have the identical effect as a clinic staffer clicking
 * "accept" in the console, which is implemented by `respondToCareSearch` in
 * ../../../src/index.js. That function is already exported and already
 * imported directly by ../vet-web/src/index.js — but it expects an
 * authenticated `actor` and a JSON request body, neither of which exists on a
 * Twilio webhook, and this Worker was asked not to edit src/index.js. So
 * `acceptSearchTargetByPhone`/`declineSearchTargetByPhone` below are a
 * deliberate re-implementation of the same guards and the same D1 statements,
 * using the same defaults `respondToCareSearch` would apply for an empty
 * request body (default `responseType`, the location's own
 * `arrivalWindowMinutes`/stable wait range, a 5-minute offer hold). If
 * `respondToCareSearch` changes, these two functions must change with it —
 * there is no shared code path enforcing that today. See the session report
 * for the exact statement-by-statement comparison.
 */

import { actorForRequest, roleAllows, signInRequired } from "../../../src/auth.js";
import { publicConfig } from "../../../src/config.js";
import {
  getCareSearch,
  getClinicLocation,
  getClinicSearchTarget,
  getLocation,
  hasDatabase,
  tenantIdForClerkOrg
} from "../../../src/db.js";
import { isPlatformAdmin } from "../../../src/tenancy.js";
import {
  acceptedTwiml,
  alreadyFilledTwiml,
  buildCallScript,
  declinedTwiml,
  errorTwiml,
  noResponseTwiml,
  normalizePhone,
  outboundTwiml,
  placeCall,
  repeatTwiml,
  signAttemptToken,
  verifyAttemptToken,
  verifyTwilioSignature,
  withinQuietHours
} from "../../../src/voice.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const TWIML_HEADERS = { "content-type": "text/xml; charset=utf-8", "cache-control": "no-store" };
const SECURITY_HEADERS = {
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), payment=(self), geolocation=(self)"
};

/** How many times the IVR replays the prompt after silence before it gives up and hangs up. */
const VOICE_MAX_REPEATS = 2;
/** How many minutes an offer created from a phone acceptance stays open for the customer to select, mirroring `respondToCareSearch`'s default `holdMinutes`. */
const PHONE_OFFER_HOLD_MINUTES = 5;

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { ...JSON_HEADERS, ...SECURITY_HEADERS, ...(init.headers || {}) }
  });
}

function apiError(status, code, message, details) {
  return json({ error: { code, message, ...(details ? { details } : {}) } }, { status });
}

function xmlResponse(twiml, init = {}) {
  return new Response(twiml, { ...init, headers: { ...TWIML_HEADERS, ...SECURITY_HEADERS, ...(init.headers || {}) } });
}

function forbiddenTwilio() {
  return apiError(403, "SIGNATURE_INVALID", "This request could not be verified as coming from Twilio.");
}

function authRequiredResponse() {
  return apiError(401, "AUTHENTICATION_REQUIRED", "Sign in is required to continue.");
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function isoAfter(minutes) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function timestampMs(value) {
  if (!value) return Number.NaN;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  return Date.parse(normalized);
}

function bool(value) {
  return value === true || value === 1 || value === "1";
}

async function authenticatedActor(request, env) {
  const actor = await actorForRequest(request, env);
  if (!actor) return null;
  if (!actor.tenantId && actor.clerkOrgId) actor.tenantId = await tenantIdForClerkOrg(env, actor.clerkOrgId);
  return actor;
}

/* ------------------------------------------------------------- Twilio URLs --- */

function voiceOrigin(env, request) {
  const configured = String(env.VOICE_PUBLIC_URL || "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  if (request) return new URL(request.url).origin;
  throw new Error("VOICE_PUBLIC_URL must be configured so the cron drain can build Twilio callback URLs");
}

function payloadQuery(payloadLike) {
  return {
    loc: payloadLike.locationName || "",
    sc: payloadLike.spokenConcern || "",
    tm: String(payloadLike.travelMinutes ?? ""),
    ur: payloadLike.urgency || ""
  };
}

function outboundUrlFor(origin, targetId, attemptId, token, payloadLike) {
  const params = new URLSearchParams({ attempt: attemptId, tok: token, ...payloadQuery(payloadLike) });
  return `${origin}/api/voice/outbound/${encodeURIComponent(targetId)}?${params.toString()}`;
}

function gatherUrlFor(origin, targetId, attemptId, token, payloadLike, repeatCount) {
  const params = new URLSearchParams({ attempt: attemptId, tok: token, n: String(repeatCount), ...payloadQuery(payloadLike) });
  return `${origin}/api/voice/gather/${encodeURIComponent(targetId)}?${params.toString()}`;
}

function statusUrlFor(origin, attemptId, token) {
  const params = new URLSearchParams({ tok: token });
  return `${origin}/api/voice/status/${encodeURIComponent(attemptId)}?${params.toString()}`;
}

function scriptFromUrl(url) {
  return buildCallScript({
    locationName: url.searchParams.get("loc") || "your clinic",
    spokenConcern: url.searchParams.get("sc") || "an urgent concern",
    travelMinutes: url.searchParams.get("tm") || "a few",
    urgency: url.searchParams.get("ur") || "urgent"
  });
}

function payloadLikeFromUrl(url) {
  return {
    locationName: url.searchParams.get("loc"),
    spokenConcern: url.searchParams.get("sc"),
    travelMinutes: url.searchParams.get("tm"),
    urgency: url.searchParams.get("ur")
  };
}

/** Verifies both the Twilio HMAC over this exact request, and the per-attempt anti-replay token. Every webhook route calls this before touching the database. */
async function verifyWebhook(request, env, url) {
  const bodyText = await request.text();
  const formParams = Object.fromEntries(new URLSearchParams(bodyText));
  const signature = request.headers.get("x-twilio-signature");
  const signatureOk = await verifyTwilioSignature(env.TWILIO_AUTH_TOKEN, request.url, formParams, signature);
  if (!signatureOk) return { ok: false, formParams };
  const attemptId = url.searchParams.get("attempt");
  const tok = url.searchParams.get("tok");
  const tokenOk = attemptId && (await verifyAttemptToken(env.TWILIO_AUTH_TOKEN, attemptId, tok));
  return { ok: Boolean(tokenOk), formParams, attemptId };
}

async function getAttempt(env, attemptId) {
  if (!attemptId) return null;
  return env.DB.prepare("SELECT * FROM clinic_call_attempts WHERE id = ? LIMIT 1").bind(attemptId).first();
}

async function recordAttemptOutcome(env, attemptId, digits, outcome, { terminal = true } = {}) {
  const now = new Date().toISOString();
  if (terminal) {
    await env.DB.prepare(`
      UPDATE clinic_call_attempts
      SET digits = ?, outcome = ?, status = 'completed', completed_at = COALESCE(completed_at, ?), updated_at = ?
      WHERE id = ?
    `).bind(digits, outcome, now, now, attemptId).run();
  } else {
    await env.DB.prepare("UPDATE clinic_call_attempts SET digits = ?, updated_at = ? WHERE id = ?").bind(digits, now, attemptId).run();
  }
}

/* ------------------------------------------------------- accept / decline --- */
/**
 * Mirrors `respondToCareSearch`'s decline branch exactly: same table, same
 * SET list, same WHERE clause (status must still be contacting/awaiting_response,
 * tenant-scoped). See src/index.js lines ~523-529 at the time this was written.
 */
async function declineSearchTargetByPhone(env, tenantId, targetId) {
  const target = await getClinicSearchTarget(env, targetId, tenantId);
  if (!target) return { ok: false, reason: "not_found" };
  if (target.status !== "pending") {
    return { ok: target.status === "declined", reason: target.status === "declined" ? "already_declined" : "unavailable" };
  }
  const search = await getCareSearch(env, target.searchId);
  if (!search || !["collecting", "offers_ready"].includes(search.status) || timestampMs(search.collectionExpiresAt || search.searchExpiresAt) <= Date.now()) {
    return { ok: false, reason: "search_closed" };
  }
  const now = new Date().toISOString();
  const result = await env.DB.prepare(`
    UPDATE care_search_targets SET status = 'declined', responded_at = ?, updated_at = ?
    WHERE id = ? AND tenant_id = ? AND status IN ('contacting', 'awaiting_response')
  `).bind(now, now, target.id, tenantId).run();
  if (!result.meta?.changes) return { ok: false, reason: "target_changed" };
  return { ok: true };
}

/**
 * Mirrors `respondToCareSearch`'s accept branch (decision === "offer") using
 * the same defaults it would apply for a bare `{ decision: "offer" }` body:
 * `responseType` defaults from the search's urgency, `arrivalWindowMinutes`
 * from the location, `availableAt` is "now", wait range from the location's
 * current availability report, and a 5-minute offer hold. Same four
 * statements in the same order: insert-if-room, flip the target, tighten the
 * search status, and release any siblings once the cap is hit. See
 * src/index.js lines ~532-591 at the time this was written.
 */
async function acceptSearchTargetByPhone(env, tenantId, targetId) {
  const target = await getClinicSearchTarget(env, targetId, tenantId);
  if (!target) return { ok: false, reason: "not_found" };
  if (target.status !== "pending") {
    return { ok: target.status === "offered", reason: target.status === "offered" ? "already_offered" : "unavailable" };
  }
  const search = await getCareSearch(env, target.searchId);
  if (!search || !["collecting", "offers_ready"].includes(search.status) || timestampMs(search.collectionExpiresAt || search.searchExpiresAt) <= Date.now()) {
    return { ok: false, reason: "search_closed" };
  }
  const location = await getClinicLocation(env, tenantId);
  if (!location || location.id !== target.locationId) return { ok: false, reason: "location_mismatch" };

  const now = new Date().toISOString();
  const responseType = search.urgency === "emergency" ? "emergency_intake" : "available_now";
  const arrivalMinutes = location.arrivalWindowMinutes || 20;
  const availableAtMs = Date.now();
  const availableAt = new Date(availableAtMs).toISOString();
  const arrivalBy = new Date(availableAtMs + arrivalMinutes * 60_000).toISOString();
  const waitMin = location.availability?.stableWaitMin ?? null;
  const waitMax = location.availability?.stableWaitMax ?? null;
  const policy = location.policy || { depositRequired: false, depositAmountCents: 0 };
  const offerId = newId("offer");
  const offerExpiresAt = isoAfter(PHONE_OFFER_HOLD_MINUTES);
  const note = "Confirmed by automated phone call.";

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
      location.baseExamFeeCents, now, offerExpiresAt, null, search.id, now, search.id
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
  if (!results[0]?.meta?.changes) return { ok: false, reason: "offer_window_full" };
  return { ok: true, offerId };
}

/* ----------------------------------------------------------------- webhooks --- */

async function handleVoiceOutbound(request, env, targetId, url) {
  const { ok, attemptId } = await verifyWebhook(request, env, url);
  if (!ok) return forbiddenTwilio();

  const attempt = await getAttempt(env, attemptId);
  if (!attempt || attempt.target_id !== targetId) return forbiddenTwilio();

  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE clinic_call_attempts SET status = 'in_progress', answered_at = COALESCE(answered_at, ?), updated_at = ? WHERE id = ?")
    .bind(now, now, attemptId).run();

  const target = await getClinicSearchTarget(env, targetId, attempt.tenant_id);
  const script = scriptFromUrl(url);
  if (!target || target.status !== "pending") return xmlResponse(alreadyFilledTwiml());

  const origin = voiceOrigin(env, request);
  const tok = url.searchParams.get("tok");
  const gatherUrl = gatherUrlFor(origin, targetId, attemptId, tok, payloadLikeFromUrl(url), 0);
  return xmlResponse(outboundTwiml({ script, gatherActionUrl: gatherUrl, repeatActionUrl: gatherUrl }));
}

async function handleVoiceGather(request, env, targetId, url) {
  const { ok, formParams, attemptId } = await verifyWebhook(request, env, url);
  if (!ok) return forbiddenTwilio();

  const attempt = await getAttempt(env, attemptId);
  if (!attempt || attempt.target_id !== targetId) return forbiddenTwilio();

  const digits = String(formParams.Digits || "").trim();
  const repeatCount = Number(url.searchParams.get("n") || 0);
  const script = scriptFromUrl(url);
  const origin = voiceOrigin(env, request);
  const tok = url.searchParams.get("tok");
  const payloadLike = payloadLikeFromUrl(url);

  if (digits === "1") {
    const result = await acceptSearchTargetByPhone(env, attempt.tenant_id, targetId);
    const accepted = result.ok || result.reason === "already_offered";
    await recordAttemptOutcome(env, attemptId, digits, accepted ? "accepted" : "error");
    return xmlResponse(accepted ? acceptedTwiml(script) : alreadyFilledTwiml());
  }
  if (digits === "2") {
    const result = await declineSearchTargetByPhone(env, attempt.tenant_id, targetId);
    const declined = result.ok || result.reason === "already_declined";
    await recordAttemptOutcome(env, attemptId, digits, declined ? "declined" : "error");
    return xmlResponse(declined ? declinedTwiml(script) : alreadyFilledTwiml());
  }
  if (digits === "9") {
    const gatherUrl = gatherUrlFor(origin, targetId, attemptId, tok, payloadLike, repeatCount);
    await recordAttemptOutcome(env, attemptId, digits, null, { terminal: false });
    return xmlResponse(repeatTwiml({ script, gatherActionUrl: gatherUrl, repeatActionUrl: gatherUrl }));
  }
  if (repeatCount < VOICE_MAX_REPEATS) {
    const gatherUrl = gatherUrlFor(origin, targetId, attemptId, tok, payloadLike, repeatCount + 1);
    return xmlResponse(repeatTwiml({ script, gatherActionUrl: gatherUrl, repeatActionUrl: gatherUrl }));
  }
  await recordAttemptOutcome(env, attemptId, digits || null, "no_response");
  return xmlResponse(noResponseTwiml(script));
}

const TWILIO_STATUS_MAP = {
  queued: "queued",
  ringing: "ringing",
  "in-progress": "in_progress",
  completed: "completed",
  busy: "busy",
  failed: "failed",
  "no-answer": "no_answer",
  canceled: "canceled"
};

async function handleVoiceStatus(request, env, callId, url) {
  const { ok, formParams } = await verifyWebhook(request, env, url);
  if (!ok) return forbiddenTwilio();

  const attempt = await getAttempt(env, callId);
  if (!attempt) return apiError(404, "ATTEMPT_NOT_FOUND", "No matching call attempt.");

  const twilioStatus = String(formParams.CallStatus || "").toLowerCase();
  const mapped = TWILIO_STATUS_MAP[twilioStatus];
  if (!mapped) return json({ ok: true, ignored: true });

  const now = new Date().toISOString();
  const terminal = ["completed", "busy", "failed", "no-answer", "canceled"].includes(twilioStatus);
  const outcomeForTerminal = attempt.outcome
    ? attempt.outcome
    : (twilioStatus === "no-answer" || twilioStatus === "busy" || twilioStatus === "canceled" ? "no_response" : twilioStatus === "failed" ? "error" : null);

  await env.DB.prepare(`
    UPDATE clinic_call_attempts
    SET status = ?,
        provider_call_sid = COALESCE(provider_call_sid, ?),
        started_at = COALESCE(started_at, CASE WHEN ? IN ('ringing', 'in-progress', 'completed') THEN ? ELSE NULL END),
        answered_at = COALESCE(answered_at, CASE WHEN ? IN ('in-progress', 'completed') THEN ? ELSE NULL END),
        completed_at = CASE WHEN ? = 1 THEN COALESCE(completed_at, ?) ELSE completed_at END,
        outcome = COALESCE(outcome, ?),
        error_message = COALESCE(error_message, ?),
        updated_at = ?
    WHERE id = ?
  `).bind(
    mapped, formParams.CallSid || null, twilioStatus, now, twilioStatus, now,
    terminal ? 1 : 0, now, outcomeForTerminal, twilioStatus === "failed" ? (formParams.ErrorMessage || "Call failed") : null,
    now, callId
  ).run();

  return json({ ok: true });
}

/* --------------------------------------------------------------- cron drain --- */

async function processOutboxRow(env, row, nowIso) {
  const cancel = async (reason) => {
    await env.DB.prepare("UPDATE notification_outbox SET status = 'cancelled', last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'queued'")
      .bind(reason, row.id).run();
  };

  let payload;
  try {
    payload = JSON.parse(row.payload_json || "{}");
  } catch {
    return cancel("Malformed voice outbox payload");
  }
  const { targetId, searchId, locationId } = payload;
  const tenantId = row.tenant_id;
  if (!tenantId || !targetId || !searchId || !locationId) return cancel("Malformed voice outbox payload");

  const tenant = await env.DB.prepare("SELECT voice_calls_enabled, voice_quiet_hours_json FROM tenants WHERE id = ? LIMIT 1").bind(tenantId).first();
  if (!tenant || !bool(tenant.voice_calls_enabled)) return cancel("Tenant has voice calling disabled");

  const location = await env.DB.prepare("SELECT phone, voice_phone, voice_calls_enabled FROM locations WHERE id = ? AND active = 1 LIMIT 1").bind(locationId).first();
  if (!location || !bool(location.voice_calls_enabled)) return cancel("Location has voice calling disabled");

  const toNumber = normalizePhone(location.voice_phone || location.phone);
  if (!toNumber) return cancel("No usable phone number for this location");

  let quietHours = {};
  try {
    quietHours = JSON.parse(tenant.voice_quiet_hours_json || "{}");
  } catch {
    quietHours = {};
  }
  if (withinQuietHours(nowIso, quietHours)) return cancel("Tenant is inside its configured quiet hours");

  const targetRow = await env.DB.prepare("SELECT status FROM care_search_targets WHERE id = ? LIMIT 1").bind(targetId).first();
  if (!targetRow || targetRow.status !== "awaiting_response") return cancel("Search target is no longer awaiting a response");

  const attemptNumber = Number(row.attempts || 0) + 1;
  const attemptId = newId("attempt");

  try {
    const origin = voiceOrigin(env);
    const token = await signAttemptToken(env.TWILIO_AUTH_TOKEN, attemptId);
    const outboundUrl = outboundUrlFor(origin, targetId, attemptId, token, payload);
    const statusUrl = statusUrlFor(origin, attemptId, token);

    if (env.DEMO_MODE === "true" || !env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
      // Demo mode (or an unconfigured Twilio account): log the intent to call without spending real telephony minutes.
      await env.DB.batch([
        env.DB.prepare(`
          INSERT INTO clinic_call_attempts (id, outbox_id, search_id, target_id, tenant_id, location_id, to_number, from_number, provider, status, attempt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'twilio', 'queued', ?)
        `).bind(attemptId, row.id, searchId, targetId, tenantId, locationId, toNumber, env.TWILIO_FROM_NUMBER || null, attemptNumber),
        env.DB.prepare("UPDATE notification_outbox SET status = 'sent', sent_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(nowIso, row.id)
      ]);
      return;
    }

    const call = await placeCall(env, { to: toNumber, url: outboundUrl, statusCallback: statusUrl });
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO clinic_call_attempts (id, outbox_id, search_id, target_id, tenant_id, location_id, to_number, from_number, provider, provider_call_sid, status, attempt, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'twilio', ?, 'queued', ?, ?)
      `).bind(attemptId, row.id, searchId, targetId, tenantId, locationId, toNumber, env.TWILIO_FROM_NUMBER || null, call.sid, attemptNumber, nowIso),
      env.DB.prepare("UPDATE notification_outbox SET status = 'sent', sent_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(nowIso, row.id)
    ]);
  } catch (error) {
    const maxAttempts = Number(env.VOICE_MAX_ATTEMPTS || 2);
    const nextAttempts = Number(row.attempts || 0) + 1;
    await env.DB.prepare(`
      INSERT INTO clinic_call_attempts (id, outbox_id, search_id, target_id, tenant_id, location_id, to_number, from_number, provider, status, outcome, attempt, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'twilio', 'failed', 'error', ?, ?)
    `).bind(attemptId, row.id, searchId, targetId, tenantId, locationId, toNumber, env.TWILIO_FROM_NUMBER || null, attemptNumber, error.message).run();

    if (nextAttempts >= maxAttempts) {
      await env.DB.prepare("UPDATE notification_outbox SET status = 'failed', attempts = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(nextAttempts, error.message, row.id).run();
    } else {
      const availableAt = new Date(Date.now() + 2 * nextAttempts * 60_000).toISOString();
      await env.DB.prepare("UPDATE notification_outbox SET attempts = ?, last_error = ?, available_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(nextAttempts, error.message, availableAt, row.id).run();
    }
  }
}

export async function drainVoiceQueue(env) {
  if (!hasDatabase(env)) return;
  const nowIso = new Date().toISOString();
  const rows = await env.DB.prepare(`
    SELECT * FROM notification_outbox WHERE channel = 'voice' AND status = 'queued' AND available_at <= ?
    ORDER BY available_at LIMIT 20
  `).bind(nowIso).all();

  for (const row of rows.results) {
    try {
      await processOutboxRow(env, row, nowIso);
    } catch (error) {
      // A single malformed row must never stop the rest of the tick from draining.
      console.error(JSON.stringify({ event: "voice_drain_row_error", outboxId: row.id, message: error.message }));
    }
  }
  console.log(JSON.stringify({ event: "voice_drain_complete", at: nowIso, processed: rows.results.length }));
}

/* -------------------------------------------------------------- attempts API --- */

function attemptFromRow(row) {
  return {
    id: row.id,
    searchId: row.search_id,
    targetId: row.target_id,
    tenantId: row.tenant_id,
    locationId: row.location_id,
    toNumber: row.to_number,
    provider: row.provider,
    providerCallSid: row.provider_call_sid,
    status: row.status,
    digits: row.digits,
    outcome: row.outcome,
    attempt: row.attempt,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    answeredAt: row.answered_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function handleListAttempts(request, env, actor, url) {
  const searchId = url.searchParams.get("searchId");
  if (!searchId) return apiError(422, "SEARCH_ID_REQUIRED", "Provide a searchId to list call attempts.");

  const platformAdmin = await isPlatformAdmin(env, actor);
  if (!platformAdmin) {
    if (!roleAllows(actor, ["clinic", "admin", "org:admin", "org:member"])) {
      return apiError(403, "CLINIC_ACCESS_REQUIRED", "Clinic organization access is required.");
    }
    if (!actor.tenantId) return apiError(403, "TENANT_REQUIRED", "Choose an active Clerk organization mapped to a Tími tenant.");
  }

  const result = platformAdmin
    ? await env.DB.prepare("SELECT * FROM clinic_call_attempts WHERE search_id = ? ORDER BY created_at DESC").bind(searchId).all()
    : await env.DB.prepare("SELECT * FROM clinic_call_attempts WHERE search_id = ? AND tenant_id = ? ORDER BY created_at DESC").bind(searchId, actor.tenantId).all();

  return json({ attempts: result.results.map(attemptFromRow) });
}

/* ------------------------------------------------------------------- routes --- */

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (method === "GET" && path === "/api/health") {
    return json({
      ok: true,
      service: "timinow-voice",
      database: hasDatabase(env),
      twilioConfigured: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER)
    });
  }
  if (method === "GET" && path === "/api/config") return json(publicConfig(env));

  const outboundMatch = path.match(/^\/api\/voice\/outbound\/([^/]+)$/);
  if (method === "POST" && outboundMatch) {
    try {
      return await handleVoiceOutbound(request, env, decodeURIComponent(outboundMatch[1]), url);
    } catch (error) {
      console.error(JSON.stringify({ event: "voice_outbound_error", message: error.message }));
      return xmlResponse(errorTwiml());
    }
  }

  const gatherMatch = path.match(/^\/api\/voice\/gather\/([^/]+)$/);
  if (method === "POST" && gatherMatch) {
    try {
      return await handleVoiceGather(request, env, decodeURIComponent(gatherMatch[1]), url);
    } catch (error) {
      console.error(JSON.stringify({ event: "voice_gather_error", message: error.message }));
      return xmlResponse(errorTwiml());
    }
  }

  const statusMatch = path.match(/^\/api\/voice\/status\/([^/]+)$/);
  if (method === "POST" && statusMatch) {
    try {
      return await handleVoiceStatus(request, env, decodeURIComponent(statusMatch[1]), url);
    } catch (error) {
      console.error(JSON.stringify({ event: "voice_status_error", message: error.message }));
      return json({ ok: false }, { status: 500 });
    }
  }

  if (method === "GET" && path === "/api/voice/attempts") {
    const actor = await authenticatedActor(request, env);
    if (signInRequired(env) && !actor) return authRequiredResponse();
    return handleListAttempts(request, env, actor, url);
  }

  if (path.startsWith("/api/")) return apiError(404, "NOT_FOUND", "The requested API route does not exist.");
  return null;
}

export default {
  async fetch(request, env) {
    const requestId = request.headers.get("cf-ray") || crypto.randomUUID();
    const startedAt = Date.now();
    try {
      const url = new URL(request.url);
      const response = url.pathname.startsWith("/api/")
        ? (await handleApi(request, env)) || apiError(404, "NOT_FOUND", "The requested API route does not exist.")
        : await env.ASSETS.fetch(request);
      const headers = new Headers(response.headers);
      Object.entries(SECURITY_HEADERS).forEach(([key, value]) => headers.set(key, value));
      headers.set("x-request-id", requestId);
      console.log(JSON.stringify({ event: "request", requestId, method: request.method, path: url.pathname, status: response.status, durationMs: Date.now() - startedAt }));
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch (error) {
      console.error(JSON.stringify({ event: "request_error", requestId, message: error.message, stack: error.stack }));
      return apiError(500, "INTERNAL_ERROR", "Tími voice gateway could not complete that request.", { requestId });
    }
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(drainVoiceQueue(env));
  }
};
