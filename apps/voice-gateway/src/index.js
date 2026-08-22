/**
 * Tími voice gateway Worker (timinow-voice).
 *
 * Drains the `notification_outbox` rows with `channel = 'voice'` that
 * `createCareSearch` (in ../../../src/index.js) enqueues per clinic, places an
 * automated Twilio call, and lets the clinic answer with a two-question
 * touch-tone tree: press 1 to take the patient, 2 to decline.
 *
 * Pressing "1" has the identical effect as a clinic staffer clicking "accept"
 * in the console: both call `applyCareSearchDecision` in ../../../src/index.js,
 * which exists as a plain-value function precisely so a Twilio webhook — with
 * no JSON body and no Clerk actor — can share it rather than carry a copy of
 * the offer SQL that drifts out of step.
 */

import { actorForRequest, roleAllows, signInRequired } from "../../../src/auth.js";
import { publicConfig } from "../../../src/config.js";
import { applyCareSearchDecision } from "../../../src/index.js";
import {
  getCareSearch,
  getClinicLocation,
  getClinicSearchTarget,
  getLocation,
  hasDatabase,
  tenantIdForClerkOrg
} from "../../../src/db.js";
import { isPlatformAdmin } from "../../../src/tenancy.js";
import { geminiConfigured, geminiModel, geminiVoice, synthesizeSpeech } from "../../../src/gemini-tts.js";
import {
  acceptedTwiml,
  alreadyFilledTwiml,
  buildCallScript,
  declinedTwiml,
  errorTwiml,
  inboundFallbackTwiml,
  inboundTwiml,
  noResponseTwiml,
  normalizePhone,
  outboundTwiml,
  placeCall,
  sayVoice,
  repeatTwiml,
  signAttemptToken,
  verifyAttemptToken,
  verifyTwilioSignature,
  withinQuietHours
} from "../../../src/voice.js";

const TEST_SCRIPT_INPUT = {
  locationName: "your clinic",
  spokenConcern: "a dog that has vomited three times since this morning",
  travelMinutes: 12,
  urgency: "urgent"
};

/** How the line should be read. Gemini's TTS models take direction in the
 *  prompt itself, and a clinic answering the phone at 2am should not be read
 *  to brightly. */
const CALL_STYLE = "Read this warmly and calmly, at an unhurried pace, as a real person calling a veterinary clinic. Do not sound cheerful or promotional.";

/**
 * Audio for one line, cached on its own URL.
 *
 * Every fixed line — the prompt, the acceptance, the decline — is identical on
 * every call, so the first synthesis pays for all of them. The cache is keyed
 * by the request URL, which already carries the part and the voice, so nothing
 * else has to be invented to key it.
 */
async function cachedSpeech(request, env, text) {
  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) return hit;
  const { wav } = await synthesizeSpeech(env, { text, style: CALL_STYLE });
  const response = new Response(wav, {
    headers: {
      "content-type": "audio/wav",
      "content-length": String(wav.length),
      "cache-control": "public, max-age=86400"
    }
  });
  await cache.put(request, response.clone());
  return response;
}

/** Twilio voice names are letters, digits, dots and dashes. Constrained at the
 * door rather than escaped downstream: this value becomes a TwiML attribute,
 * and a name Twilio does not recognise fails the call at answer time. */
function cleanVoiceName(value) {
  const name = String(value ?? "").trim();
  return /^[A-Za-z0-9.\-]{1,64}$/.test(name) ? name : "";
}

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

  /**
   * Twilio signs the URL string it was handed, which this Worker built from
   * VOICE_PUBLIC_URL. That is normally byte-identical to what Cloudflare
   * reports as `request.url`, but a custom domain in front of a workers.dev
   * origin — or a proxy that rewrites the host — makes them differ, and the
   * failure mode is silent and total: every clinic call 403s and nobody is
   * ever reached. Checking the configured origin as well costs one extra HMAC
   * and removes that class of outage. Both candidates are still real
   * signatures over real URLs; neither weakens the check.
   */
  const candidates = [request.url];
  const configured = String(env.VOICE_PUBLIC_URL || "").trim().replace(/\/+$/, "");
  if (configured) {
    const rebuilt = `${configured}${url.pathname}${url.search}`;
    if (rebuilt !== request.url) candidates.push(rebuilt);
  }
  let signatureOk = false;
  for (const candidate of candidates) {
    if (await verifyTwilioSignature(env.TWILIO_AUTH_TOKEN, candidate, formParams, signature)) {
      signatureOk = true;
      break;
    }
  }
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
 * A clinic answering the phone must do exactly what a clinic clicking the
 * console button does. Rather than reimplement the offer SQL here — the kind of
 * duplicate that drifts silently until phone acceptances quietly stop creating
 * offers — both paths call `applyCareSearchDecision`, which takes plain values
 * precisely so a webhook with no JSON body and no Clerk actor can use it.
 *
 * The reason codes below exist only to choose which sentence the caller hears.
 */
async function decideByPhone(env, tenantId, targetId, decision) {
  const target = await getClinicSearchTarget(env, targetId, tenantId);
  const settled = decision === "offer" ? "offered" : "declined";
  // Pressing the same key twice should sound like confirmation, not an error.
  if (target && target.status === settled) return { ok: true, reason: "already_settled" };

  const result = await applyCareSearchDecision(env, { targetId, tenantId, decision });
  if (result.ok) return { ok: true };
  return { ok: false, reason: result.code };
}


/* ------------------------------------------------------------- inbound --- */

/**
 * Find the clinic a caller belongs to, and the request they still have open.
 *
 * Matched on caller ID, which is a hint rather than proof — so this only ever
 * *offers* a decision. Actually recording one still goes through the signed
 * gather step below.
 */
async function openRequestForCaller(env, fromNumber) {
  const normalized = normalizePhone(fromNumber);
  if (!normalized || !hasDatabase(env)) return null;

  const location = await env.DB.prepare(`
    SELECT id, name, tenant_id FROM locations
    WHERE active = 1 AND (voice_phone = ? OR phone = ?
      OR REPLACE(REPLACE(REPLACE(REPLACE(phone, '(', ''), ')', ''), '-', ''), ' ', '') = ?)
    LIMIT 1
  `).bind(normalized, normalized, normalized.replace(/^\+1/, "")).first();
  if (!location) return null;

  const now = new Date().toISOString();
  const target = await env.DB.prepare(`
    SELECT t.id AS target_id, t.travel_minutes, o.payload_json
    FROM care_search_targets t
    JOIN care_searches s ON s.id = t.search_id
    LEFT JOIN notification_outbox o ON o.channel = 'voice'
      AND json_extract(o.payload_json, '$.targetId') = t.id
    WHERE t.location_id = ? AND t.status = 'awaiting_response'
      AND s.status IN ('collecting', 'offers_ready')
      AND datetime(s.search_expires_at) > datetime(?)
    ORDER BY t.created_at DESC LIMIT 1
  `).bind(location.id, now).first();

  if (!target) return { location, target: null };
  let payload = {};
  try {
    payload = JSON.parse(target.payload_json || "{}");
  } catch {
    payload = {};
  }
  return {
    location,
    target: {
      id: target.target_id,
      travelMinutes: target.travel_minutes,
      spokenConcern: payload.spokenConcern || null
    }
  };
}

/**
 * The number's Request URL. A clinic calling the number back reaches this.
 *
 * An unverifiable signature degrades to the neutral greeting rather than a 403,
 * because a real clinic on the phone should never hear a failure caused by a
 * configuration mismatch. Nothing here changes state — the accept and decline
 * live behind the signed gather below.
 */
async function handleVoiceInbound(request, env, url) {
  const bodyText = await request.text();
  const params = Object.fromEntries(new URLSearchParams(bodyText));
  const signature = request.headers.get("x-twilio-signature");
  const origin = voiceOrigin(env, request);
  const signed = await verifyTwilioSignature(env.TWILIO_AUTH_TOKEN, request.url, params, signature)
    || await verifyTwilioSignature(env.TWILIO_AUTH_TOKEN, `${origin}${url.pathname}${url.search}`, params, signature);

  const found = signed ? await openRequestForCaller(env, params.From) : null;
  console.log(JSON.stringify({
    event: "voice_inbound",
    signed,
    from: params.From || null,
    matchedLocation: found?.location?.id || null,
    openTarget: found?.target?.id || null
  }));

  if (!found?.target?.spokenConcern) {
    return xmlResponse(inboundTwiml({ locationName: found?.location?.name }));
  }

  const token = await signAttemptToken(env.TWILIO_AUTH_TOKEN, found.target.id);
  const gatherActionUrl = `${origin}/api/voice/inbound/gather`
    + `?target=${encodeURIComponent(found.target.id)}&tok=${encodeURIComponent(token)}`;
  return xmlResponse(inboundTwiml({
    locationName: found.location.name,
    spokenConcern: found.target.spokenConcern,
    travelMinutes: found.target.travelMinutes,
    gatherActionUrl
  }));
}

/** The keypad answer from an inbound call. Signed, because it changes state. */
async function handleVoiceInboundGather(request, env, url) {
  const bodyText = await request.text();
  const params = Object.fromEntries(new URLSearchParams(bodyText));
  const signature = request.headers.get("x-twilio-signature");
  const origin = voiceOrigin(env, request);
  const signed = await verifyTwilioSignature(env.TWILIO_AUTH_TOKEN, request.url, params, signature)
    || await verifyTwilioSignature(env.TWILIO_AUTH_TOKEN, `${origin}${url.pathname}${url.search}`, params, signature);
  if (!signed) return forbiddenTwilio();

  const targetId = url.searchParams.get("target");
  const tok = url.searchParams.get("tok");
  if (!targetId || !(await verifyAttemptToken(env.TWILIO_AUTH_TOKEN, targetId, tok))) return forbiddenTwilio();

  const row = await env.DB.prepare("SELECT tenant_id FROM care_search_targets WHERE id = ? LIMIT 1").bind(targetId).first();
  if (!row) return xmlResponse(alreadyFilledTwiml({ voice: sayVoice(env) }));

  const digits = String(params.Digits || "").trim();
  if (digits === "1") {
    const result = await decideByPhone(env, row.tenant_id, targetId, "offer");
    return xmlResponse(result.ok
      ? acceptedTwiml(buildCallScript({ locationName: "", spokenConcern: "", travelMinutes: null, urgency: "urgent" }), { voice: sayVoice(env) })
      : alreadyFilledTwiml());
  }
  if (digits === "2") {
    const result = await decideByPhone(env, row.tenant_id, targetId, "decline");
    return xmlResponse(result.ok
      ? declinedTwiml(buildCallScript({ locationName: "", spokenConcern: "", travelMinutes: null, urgency: "urgent" }), { voice: sayVoice(env) })
      : alreadyFilledTwiml());
  }
  return xmlResponse(inboundFallbackTwiml());
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
  if (!target || target.status !== "pending") return xmlResponse(alreadyFilledTwiml({ voice: sayVoice(env) }));

  const origin = voiceOrigin(env, request);
  const tok = url.searchParams.get("tok");
  const gatherUrl = gatherUrlFor(origin, targetId, attemptId, tok, payloadLikeFromUrl(url), 0);
  return xmlResponse(outboundTwiml({ script, gatherActionUrl: gatherUrl, repeatActionUrl: gatherUrl, voice: sayVoice(env) }));
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
    const result = await decideByPhone(env, attempt.tenant_id, targetId, "offer");
    const accepted = result.ok;
    await recordAttemptOutcome(env, attemptId, digits, accepted ? "accepted" : "error");
    return xmlResponse(accepted ? acceptedTwiml(script, { voice: sayVoice(env) }) : alreadyFilledTwiml());
  }
  if (digits === "2") {
    const result = await decideByPhone(env, attempt.tenant_id, targetId, "decline");
    const declined = result.ok;
    await recordAttemptOutcome(env, attemptId, digits, declined ? "declined" : "error");
    return xmlResponse(declined ? declinedTwiml(script, { voice: sayVoice(env) }) : alreadyFilledTwiml());
  }
  if (digits === "9") {
    const gatherUrl = gatherUrlFor(origin, targetId, attemptId, tok, payloadLike, repeatCount);
    await recordAttemptOutcome(env, attemptId, digits, null, { terminal: false });
    return xmlResponse(repeatTwiml({ script, gatherActionUrl: gatherUrl, repeatActionUrl: gatherUrl, voice: sayVoice(env) }));
  }
  if (repeatCount < VOICE_MAX_REPEATS) {
    const gatherUrl = gatherUrlFor(origin, targetId, attemptId, tok, payloadLike, repeatCount + 1);
    return xmlResponse(repeatTwiml({ script, gatherActionUrl: gatherUrl, repeatActionUrl: gatherUrl, voice: sayVoice(env) }));
  }
  await recordAttemptOutcome(env, attemptId, digits || null, "no_response");
  return xmlResponse(noResponseTwiml(script, { voice: sayVoice(env) }));
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
    await env.DB.prepare("UPDATE notification_outbox SET status = 'cancelled', last_error = ? WHERE id = ? AND status = 'queued'")
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
  /**
   * Cancelled rather than deferred, deliberately. A care search stops collecting
   * offers after 90 seconds and expires entirely at six and a half minutes, so a
   * call held until quiet hours end would ring a clinic about a pet whose owner
   * was seen — or gave up — hours earlier. The tenant's quiet hours stay
   * authoritative even for an emergency search: a vendor that decides on a
   * clinic's behalf when its phone may ring at 3am does not stay a vendor.
   */
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
        env.DB.prepare("UPDATE notification_outbox SET status = 'sent', sent_at = ? WHERE id = ?").bind(nowIso, row.id)
      ]);
      return;
    }

    const call = await placeCall(env, { to: toNumber, url: outboundUrl, statusCallback: statusUrl });
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO clinic_call_attempts (id, outbox_id, search_id, target_id, tenant_id, location_id, to_number, from_number, provider, provider_call_sid, status, attempt, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'twilio', ?, 'queued', ?, ?)
      `).bind(attemptId, row.id, searchId, targetId, tenantId, locationId, toNumber, env.TWILIO_FROM_NUMBER || null, call.sid, attemptNumber, nowIso),
      env.DB.prepare("UPDATE notification_outbox SET status = 'sent', sent_at = ? WHERE id = ?").bind(nowIso, row.id)
    ]);
  } catch (error) {
    const maxAttempts = Number(env.VOICE_MAX_ATTEMPTS || 2);
    const nextAttempts = Number(row.attempts || 0) + 1;
    await env.DB.prepare(`
      INSERT INTO clinic_call_attempts (id, outbox_id, search_id, target_id, tenant_id, location_id, to_number, from_number, provider, status, outcome, attempt, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'twilio', 'failed', 'error', ?, ?)
    `).bind(attemptId, row.id, searchId, targetId, tenantId, locationId, toNumber, env.TWILIO_FROM_NUMBER || null, attemptNumber, error.message).run();

    if (nextAttempts >= maxAttempts) {
      await env.DB.prepare("UPDATE notification_outbox SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?")
        .bind(nextAttempts, error.message, row.id).run();
    } else {
      const availableAt = new Date(Date.now() + 2 * nextAttempts * 60_000).toISOString();
      await env.DB.prepare("UPDATE notification_outbox SET attempts = ?, last_error = ?, available_at = ? WHERE id = ?")
        .bind(nextAttempts, error.message, availableAt, row.id).run();
    }
  }
}

export async function drainVoiceQueue(env) {
  if (!hasDatabase(env)) return 0;
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
  return rows.results.length;
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

  /**
   * Internal drain, invoked by the customer Worker the moment a care search
   * fans out — a cron tick is too slow for this queue. A search stops
   * collecting offers after ninety seconds, so waiting up to a minute for a
   * scheduler would spend most of the window before the first phone rings.
   *
   * Reachable over a service binding, and over the public hostname only with
   * VOICE_DRAIN_TOKEN. The endpoint is idempotent and no-ops on an empty queue,
   * so the token is a courtesy rather than the thing standing between a caller
   * and a clinic — that remains the Twilio signature on the webhooks.
   */
  if (method === "POST" && path === "/api/voice/drain") {
    const expected = env.VOICE_DRAIN_TOKEN || "";
    const supplied = request.headers.get("x-timi-drain-token") || "";
    if (expected && supplied !== expected) return apiError(403, "DRAIN_FORBIDDEN", "Not permitted.");
    const processed = await drainVoiceQueue(env);
    return json({ drained: true, processed: processed ?? null });
  }

  /*
   * Ring one number with the real clinic script.
   *
   * Everything else in this Worker needs a care search, a clinic row with a
   * phone number, and a queued outbox entry before a phone rings — which is a
   * lot of production state to arrange when the question is only "do the
   * Twilio credentials work and does the wording sound right". This places one
   * call, writes nothing, and speaks exactly what a clinic hears.
   *
   * Behind VOICE_DRAIN_TOKEN, the same key the drain uses. It costs real
   * telephony minutes, so it is not open.
   */
  if (method === "POST" && path === "/api/voice/test-call") {
    const expected = env.VOICE_DRAIN_TOKEN || "";
    const supplied = request.headers.get("x-timi-drain-token") || "";
    // Three different problems, and one message for all three sends you off to
    // check the wrong one. None of these tells an attacker anything they could
    // use: the token itself is never echoed, and knowing that a Worker has no
    // token configured does not produce one.
    if (!expected) {
      return apiError(403, "TEST_CALL_NO_TOKEN", "This Worker has no VOICE_DRAIN_TOKEN set, so the test endpoint stays closed. Put one in your env file and run scripts/bootstrap.sh again.");
    }
    if (!supplied) {
      return apiError(403, "TEST_CALL_NO_HEADER", "No x-timi-drain-token header was sent.");
    }
    if (supplied !== expected) {
      return apiError(403, "TEST_CALL_TOKEN_MISMATCH", `The x-timi-drain-token sent does not match this Worker's VOICE_DRAIN_TOKEN (sent ${supplied.length} characters, expected ${expected.length}).`);
    }
    if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM_NUMBER) {
      return apiError(409, "TWILIO_NOT_CONFIGURED", "Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER first.");
    }
    let body = {};
    try { body = await request.json(); } catch { body = {}; }
    const to = normalizePhone(body.to);
    if (!to) return apiError(422, "INVALID_NUMBER", "Provide `to` in E.164, for example +14155550123.");
    const origin = voiceOrigin(env, request);
    try {
      const voice = cleanVoiceName(body.voice) || sayVoice(env);
      const call = await placeCall(env, { to, url: `${origin}/api/voice/test-script?voice=${encodeURIComponent(voice)}` });
      console.log(JSON.stringify({ event: "voice_test_voice", voice }));
      console.log(JSON.stringify({ event: "voice_test_call", to, callSid: call.sid || null }));
      return json({ calling: to, callSid: call.sid || null, voice });
    } catch (error) {
      console.error(JSON.stringify({ event: "voice_test_call_failed", message: error.message }));
      return apiError(502, "CALL_FAILED", error.message);
    }
  }

  /*
   * Try one synthesis and report exactly what happened.
   *
   * A call that comes out in Twilio's voice has already fallen back, and the
   * reason is in a Worker log nobody is watching. This runs the same code path
   * the call does and hands back Google's own words — no key, wrong key, wrong
   * voice name, wrong model, or a working one with a byte count to prove it.
   */
  if (method === "POST" && path === "/api/voice/tts-check") {
    const expected = env.VOICE_DRAIN_TOKEN || "";
    const supplied = request.headers.get("x-timi-drain-token") || "";
    if (!expected || supplied !== expected) return apiError(403, "TTS_CHECK_FORBIDDEN", "Not permitted.");
    if (!geminiConfigured(env)) {
      return json({
        ok: false,
        reason: "GEMINI_API_KEY is not set on this Worker, so every call falls back to Twilio's voice.",
        speaking: sayVoice(env)
      }, { status: 200 });
    }
    let body = {};
    try { body = await request.json(); } catch { body = {}; }
    const voice = String(body.voice || "").trim() || geminiVoice(env);
    try {
      const result = await synthesizeSpeech(env, { text: "Tee-mee test.", voice, style: CALL_STYLE });
      return json({ ok: true, voice: result.voice, model: result.model, wavBytes: result.wav.length });
    } catch (error) {
      return json({
        ok: false,
        voice,
        model: geminiModel(env),
        reason: error.message,
        speaking: sayVoice(env)
      }, { status: 200 });
    }
  }

  // What the test call says. Twilio fetches this, so it answers GET too.
  if ((method === "POST" || method === "GET") && path === "/api/voice/test-script") {
    const origin = voiceOrigin(env, request);
    const script = buildCallScript(TEST_SCRIPT_INPUT);
    const voice = cleanVoiceName(url.searchParams.get("voice")) || sayVoice(env);
    // Synthesised here rather than left for Twilio to fetch blind: if Gemini
    // is going to fail, it fails now, while there is still a <Say> to fall
    // back to. Once the phone is ringing a missing file is silence.
    //
    // All lines or none. A call that opens in a custom voice and answers in
    // Polly is worse than one that is consistently either.
    let audio = {};
    if (geminiConfigured(env)) {
      try {
        const base = `${origin}/api/voice/test-audio?voice=${encodeURIComponent(geminiVoice(env))}`;
        await Promise.all([
          cachedSpeech(new Request(`${base}&part=intro`), env, script.intro),
          cachedSpeech(new Request(`${base}&part=prompt`), env, script.prompt)
        ]);
        audio = { intro: `${base}&part=intro`, prompt: `${base}&part=prompt` };
      } catch (error) {
        console.warn(JSON.stringify({ event: "voice_tts_fallback", message: error.message }));
      }
    }
    return xmlResponse(outboundTwiml({
      script,
      gatherActionUrl: `${origin}/api/voice/test-gather?voice=${encodeURIComponent(voice)}`,
      repeatActionUrl: `${origin}/api/voice/test-script?voice=${encodeURIComponent(voice)}`,
      voice,
      audio
    }));
  }

  // The audio itself. Twilio fetches this from <Play>, so it is a plain GET
  // with no signature — it returns a fixed sample sentence and nothing else.
  if (method === "GET" && path === "/api/voice/test-audio") {
    if (!geminiConfigured(env)) return apiError(409, "TTS_NOT_CONFIGURED", "GEMINI_API_KEY is not set.");
    const script = buildCallScript(TEST_SCRIPT_INPUT);
    const text = script[url.searchParams.get("part")];
    if (!text) return apiError(422, "UNKNOWN_PART", "Ask for intro, prompt, repeat, accepted, declined or goodbye.");
    try {
      return await cachedSpeech(request, env, text);
    } catch (error) {
      console.error(JSON.stringify({ event: "voice_tts_failed", message: error.message }));
      return apiError(502, "TTS_FAILED", error.message);
    }
  }

  // The keypad answer. Says what a real acceptance or decline says, and — this
  // being a test — changes nothing anywhere.
  if (method === "POST" && path === "/api/voice/test-gather") {
    const params = Object.fromEntries(new URLSearchParams(await request.text()));
    const script = buildCallScript(TEST_SCRIPT_INPUT);
    const digit = String(params.Digits || "");
    const voice = cleanVoiceName(url.searchParams.get("voice")) || sayVoice(env);
    const part = digit === "1" ? "accepted" : digit === "2" ? "declined" : "goodbye";
    let audioUrl;
    if (geminiConfigured(env)) {
      const candidate = `${voiceOrigin(env, request)}/api/voice/test-audio?voice=${encodeURIComponent(geminiVoice(env))}&part=${part}`;
      try {
        await cachedSpeech(new Request(candidate), env, script[part]);
        audioUrl = candidate;
      } catch (error) {
        console.warn(JSON.stringify({ event: "voice_tts_fallback", message: error.message }));
      }
    }
    if (digit === "1") return xmlResponse(acceptedTwiml(script, { voice, audioUrl }));
    if (digit === "2") return xmlResponse(declinedTwiml(script, { voice, audioUrl }));
    return xmlResponse(noResponseTwiml(script, { voice, audioUrl }));
  }

  // The phone number's own Voice configuration points here. See
  // docs/PRODUCTION-SETUP.md for the exact three fields Twilio asks for.
  if (method === "POST" && path === "/api/voice/inbound") {
    try {
      return await handleVoiceInbound(request, env, url);
    } catch (error) {
      console.error(JSON.stringify({ event: "voice_inbound_error", message: error.message }));
      return xmlResponse(inboundFallbackTwiml());
    }
  }

  if (method === "POST" && path === "/api/voice/inbound/gather") {
    try {
      return await handleVoiceInboundGather(request, env, url);
    } catch (error) {
      console.error(JSON.stringify({ event: "voice_inbound_gather_error", message: error.message }));
      return xmlResponse(errorTwiml(undefined, { voice: sayVoice(env) }));
    }
  }

  // Twilio's fallback, called when the request URL above errors or times out.
  // Static by design: it touches nothing that could already be broken, and it
  // answers on GET as well because Twilio retries a fallback either way.
  if ((method === "POST" || method === "GET") && path === "/api/voice/inbound-fallback") {
    return xmlResponse(inboundFallbackTwiml());
  }

  // Number-level status callback: no attempt id in the path, so it is a log
  // sink rather than a state transition. The per-call callback that does update
  // an attempt is /api/voice/status/:callId below.
  if (method === "POST" && path === "/api/voice/status") {
    const params = Object.fromEntries(new URLSearchParams(await request.text()));
    console.log(JSON.stringify({
      event: "voice_number_status",
      callSid: params.CallSid || null,
      callStatus: params.CallStatus || null,
      from: params.From || null,
      to: params.To || null,
      duration: params.CallDuration || null
    }));
    return new Response(null, { status: 204 });
  }

  const outboundMatch = path.match(/^\/api\/voice\/outbound\/([^/]+)$/);
  if (method === "POST" && outboundMatch) {
    try {
      return await handleVoiceOutbound(request, env, decodeURIComponent(outboundMatch[1]), url);
    } catch (error) {
      console.error(JSON.stringify({ event: "voice_outbound_error", message: error.message }));
      return xmlResponse(errorTwiml(undefined, { voice: sayVoice(env) }));
    }
  }

  const gatherMatch = path.match(/^\/api\/voice\/gather\/([^/]+)$/);
  if (method === "POST" && gatherMatch) {
    try {
      return await handleVoiceGather(request, env, decodeURIComponent(gatherMatch[1]), url);
    } catch (error) {
      console.error(JSON.stringify({ event: "voice_gather_error", message: error.message }));
      return xmlResponse(errorTwiml(undefined, { voice: sayVoice(env) }));
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
