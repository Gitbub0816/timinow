/**
 * Native push notifications (APNs), the iOS-app equivalent of Feature B's
 * "close the page, we'll text you" SMS.
 *
 * notifyFirstOfferBySms (src/index.js) is the only way a backgrounded
 * customer app currently learns a clinic answered. This module is the other
 * half of that moment: a device that has registered a token gets woken with
 * a real push the instant the search's first offer exists, independent of
 * whatever the SMS side does — see sendPushForFirstOffer, called alongside
 * notifyFirstOfferBySms from respondToCareSearch in src/index.js.
 *
 * Registration (`POST/DELETE /api/push/register-device`) reuses whatever
 * actor src/index.js already resolved for the request — a verified Clerk
 * session or a guest session (src/guest-session.js) — exactly the way
 * createCareSearch/getCareSearch do, so a pet owner who never signed in can
 * still get pushed to.
 *
 * Everything here degrades to a safe no-op, never a thrown error, when
 * APNS_KEY_ID/APNS_TEAM_ID/APNS_AUTH_KEY_P8/APNS_BUNDLE_ID are not all set —
 * the same posture src/voice.js and src/search-links.js take toward their own
 * optional credentials (see TWILIO_MESSAGING_FROM's handling in src/voice.js
 * and SEARCH_LINK_SECRET's in src/search-links.js). A customer with the app
 * open in front of them must never have anything blocked by a push failure.
 */

import { hasDatabase } from "./db.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const ALLOWED_PLATFORMS = new Set(["ios"]);
// APNs allows a signed provider token to be reused for about an hour; refreshed
// well inside that so a Worker isolate kept warm across many requests never
// hands over one about to be rejected as stale.
const APNS_JWT_TTL_MS = 50 * 60 * 1000;

function json(data, init = {}) {
  return new Response(JSON.stringify(data), { ...init, headers: { ...JSON_HEADERS, ...(init.headers || {}) } });
}

function apiError(status, code, message) {
  return json({ error: { code, message } }, { status });
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function cleanString(value, maxLength = 240) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

async function readJson(request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 32_768) throw new Error("PAYLOAD_TOO_LARGE");
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new Error("JSON_REQUIRED");
  }
  return request.json();
}

/**
 * Which owner column a device token registers under. `actor.guest` is the
 * shape guestActor() in src/guest-session.js sets — never true for a Clerk
 * session — so this is a clean either/or, never both.
 */
function ownerColumns(actor) {
  if (!actor?.userId) return { customerUserId: null, guestSessionId: null };
  return actor.guest ? { customerUserId: null, guestSessionId: actor.userId } : { customerUserId: actor.userId, guestSessionId: null };
}

// ─────────────────────────────────────────────────────────────── registration ──

/** `POST /api/push/register-device` — `{ deviceToken, platform: "ios" }`. */
export async function registerPushDevice(request, env, actor) {
  const body = await readJson(request).catch(() => null);
  const deviceToken = cleanString(body?.deviceToken, 200);
  const platform = cleanString(body?.platform, 20) || "ios";
  if (!deviceToken) return apiError(422, "DEVICE_TOKEN_REQUIRED", "A device token is required.");
  if (!ALLOWED_PLATFORMS.has(platform)) {
    return apiError(422, "UNSUPPORTED_PLATFORM", `platform must be one of: ${[...ALLOWED_PLATFORMS].join(", ")}.`);
  }
  // Demo mode (no D1 bound) has nowhere to persist a token and no offers ever
  // actually arrive to push about — answer the same "nothing really
  // happened, and that is fine" shape createCareSearch's demo branch does.
  if (!hasDatabase(env)) return json({ registered: false, demo: true });
  const owner = ownerColumns(actor);
  // No Clerk session and no guest session (SIGN_IN_REQUIRED=false with
  // neither established) means there is no id to key a lookup on later —
  // recording the token anyway would write a row sendPushForFirstOffer could
  // never find again. Answered as a soft no-op, not an error: the app is not
  // doing anything wrong by trying.
  if (!owner.customerUserId && !owner.guestSessionId) return json({ registered: false });

  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO push_device_tokens (
      id, customer_user_id, guest_session_id, device_token, platform, created_at, last_seen_at, revoked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(device_token) DO UPDATE SET
      customer_user_id = excluded.customer_user_id,
      guest_session_id = excluded.guest_session_id,
      platform = excluded.platform,
      last_seen_at = excluded.last_seen_at,
      -- Re-registering revives a token APNs had previously reported as gone.
      -- iOS handing the same token back to the app is APNs' own signal that
      -- it is good again — this is not a guess.
      revoked_at = NULL
  `).bind(newId("push"), owner.customerUserId, owner.guestSessionId, deviceToken, platform, now, now).run();
  return json({ registered: true }, { status: 201 });
}

/** `DELETE /api/push/register-device` — e.g. on sign-out, `{ deviceToken }`. */
export async function unregisterPushDevice(request, env, actor) {
  const body = await readJson(request).catch(() => null);
  const deviceToken = cleanString(body?.deviceToken, 200);
  if (!deviceToken) return apiError(422, "DEVICE_TOKEN_REQUIRED", "A device token is required.");
  if (!hasDatabase(env)) return json({ unregistered: false, demo: true });
  const owner = ownerColumns(actor);
  if (!owner.customerUserId && !owner.guestSessionId) return json({ unregistered: false });
  const now = new Date().toISOString();
  // Scoped to the caller's own id on both sides — a guest cannot unregister a
  // signed-in customer's device by guessing its token, and vice versa.
  const result = await env.DB.prepare(`
    UPDATE push_device_tokens SET revoked_at = ?
    WHERE device_token = ? AND revoked_at IS NULL AND (customer_user_id = ? OR guest_session_id = ?)
  `).bind(now, deviceToken, owner.customerUserId, owner.guestSessionId).run();
  return json({ unregistered: Boolean(result.meta?.changes) });
}

async function revokeDeviceToken(env, deviceToken) {
  if (!hasDatabase(env)) return;
  await env.DB.prepare(
    "UPDATE push_device_tokens SET revoked_at = ? WHERE device_token = ? AND revoked_at IS NULL"
  ).bind(new Date().toISOString(), deviceToken).run();
}

// ────────────────────────────────────────────────────────────────────── APNs ──

/** Whether every credential a real APNs call needs is present. */
export function apnsConfigured(env) {
  return Boolean(env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_AUTH_KEY_P8 && env.APNS_BUNDLE_ID);
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The .p8 file's contents, however they arrived. Handles a value pasted as a
 * literal PEM block (real newlines) and one pasted as a single env-file line
 * with escaped `\n` — see .env.example's APNS_AUTH_KEY_P8 note — and strips
 * the PEM header/footer either way, leaving the base64 DER body for
 * importKey("pkcs8", ...).
 */
function pkcs8DerFromP8(raw) {
  const normalized = String(raw || "").replace(/\\n/g, "\n");
  const base64 = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function importApnsSigningKey(env) {
  const der = pkcs8DerFromP8(env.APNS_AUTH_KEY_P8);
  return crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

// Per-isolate cache, not shared across Workers or across a redeploy — that is
// fine, since a cold isolate simply signs its own on first use.
let cachedApnsJwt = null;

/**
 * A signed ES256 JWT for APNs' provider API: header `{alg, kid}`, claims
 * `{iss, iat}`. Web Crypto's ECDSA signature for a P-256 key is already the
 * raw r||s concatenation JWS (RFC 7518 §3.4) requires for ES256 — not the DER
 * form some other ECDSA APIs return — so the signature bytes go straight into
 * the token with no reformatting.
 */
async function signedApnsJwt(env) {
  if (cachedApnsJwt && cachedApnsJwt.keyId === env.APNS_KEY_ID && Date.now() - cachedApnsJwt.signedAtMs < APNS_JWT_TTL_MS) {
    return cachedApnsJwt.token;
  }
  const encoder = new TextEncoder();
  const header = { alg: "ES256", kid: env.APNS_KEY_ID };
  const claims = { iss: env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) };
  const signingInput = `${base64UrlEncode(encoder.encode(JSON.stringify(header)))}.${base64UrlEncode(encoder.encode(JSON.stringify(claims)))}`;
  const key = await importApnsSigningKey(env);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(signingInput));
  const token = `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
  cachedApnsJwt = { token, signedAtMs: Date.now(), keyId: env.APNS_KEY_ID };
  return token;
}

/**
 * Best-effort delivery to one device over APNs' token-based HTTP/2 Provider
 * API. Never throws — every failure is caught, logged, and returned as
 * `{ ok: false, ... }` so a caller doing `Promise.all` over several tokens
 * never has one push's failure take the others down with it.
 */
export async function sendApnsPush(env, deviceToken, payload) {
  if (!apnsConfigured(env)) {
    console.warn(JSON.stringify({ event: "apns_push_skipped", reason: "APNS_KEY_ID/APNS_TEAM_ID/APNS_AUTH_KEY_P8/APNS_BUNDLE_ID not fully configured" }));
    return { ok: false, skipped: true };
  }
  const token = cleanString(deviceToken, 200);
  if (!token) return { ok: false, skipped: true };

  let jwt;
  try {
    jwt = await signedApnsJwt(env);
  } catch (error) {
    console.error(JSON.stringify({ event: "apns_jwt_failed", message: error.message }));
    return { ok: false, error: "jwt_failed" };
  }

  const host = String(env.APNS_ENVIRONMENT || "").trim().toLowerCase() === "sandbox"
    ? "api.sandbox.push.apple.com"
    : "api.push.apple.com";
  try {
    // Workers' fetch negotiates HTTP/2 automatically against a host that
    // supports it, which is APNs' whole requirement here — no separate client.
    const response = await fetch(`https://${host}/3/device/${token}`, {
      method: "POST",
      headers: {
        "authorization": `bearer ${jwt}`,
        "apns-topic": env.APNS_BUNDLE_ID,
        "apns-push-type": "alert",
        "content-type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    if (response.ok) return { ok: true };
    const failure = await response.json().catch(() => ({}));
    const reason = failure?.reason || "";
    // A device that reinstalled, revoked notification permission at the OS
    // level, or was restored from a backup answers one of these two ways —
    // retrying it is pure waste from here on, so it is marked revoked rather
    // than tried again on the next offer.
    if (response.status === 410 || reason === "BadDeviceToken" || reason === "Unregistered") {
      await revokeDeviceToken(env, token).catch(() => {});
    }
    console.warn(JSON.stringify({ event: "apns_push_rejected", status: response.status, reason }));
    return { ok: false, status: response.status, reason };
  } catch (error) {
    console.error(JSON.stringify({ event: "apns_push_failed", message: error.message }));
    return { ok: false, error: error.message };
  }
}

/**
 * Feature B's native-push equivalent: one push, the first time a care search
 * gets an offer, to every device registered for that search's customer or
 * guest session. Mirrors notifyFirstOfferBySms's shape deliberately —
 * conditional UPDATE as the "only once" guarantee, everything after it
 * degrading silently — but keeps its own `push_notified_at` column
 * (migration 0026) rather than sharing SMS's `sms_notified_at`, precisely so
 * a push failure (or APNs simply not being configured) can never suppress
 * the text, and a carrier issue on the SMS side can never suppress the push.
 */
export async function sendPushForFirstOffer(env, searchId) {
  if (!hasDatabase(env)) return;
  const row = await env.DB.prepare(
    "SELECT id, customer_user_id, pet_name, push_notified_at FROM care_searches WHERE id = ?"
  ).bind(searchId).first();
  if (!row || row.push_notified_at) return;
  const ownerId = row.customer_user_id;
  if (!ownerId) return;

  const now = new Date().toISOString();
  const claim = await env.DB.prepare(
    "UPDATE care_searches SET push_notified_at = ? WHERE id = ? AND push_notified_at IS NULL"
  ).bind(now, searchId).run();
  if (!claim.meta?.changes) return; // another concurrent call already claimed this push

  if (!apnsConfigured(env)) {
    console.warn(JSON.stringify({ event: "push_first_offer_skipped", searchId, reason: "APNs not configured" }));
    return;
  }

  // `ownerId` is a Clerk user id for a signed-in customer and a guest session
  // id (src/guest-session.js) for an anonymous one — indistinguishable here
  // by design, the same way care_searches.customer_user_id holds both. Both
  // columns are checked so either kind of registration matches.
  const tokensResult = await env.DB.prepare(
    "SELECT device_token FROM push_device_tokens WHERE revoked_at IS NULL AND (customer_user_id = ? OR guest_session_id = ?)"
  ).bind(ownerId, ownerId).all();
  const tokens = (tokensResult.results || []).map((result) => result.device_token).filter(Boolean);
  if (!tokens.length) return;

  const petName = cleanString(row.pet_name, 80) || "your pet";
  const payload = {
    aps: {
      alert: { title: "Tími NOW", body: `We found a clinic for ${petName}. Open Tími to review the offer.` },
      sound: "default"
    },
    // Read by the app's notification-tap handler (Darwin/Sources/PushDelegate.swift)
    // to deep-link straight back into this search's tracker/offers screen.
    searchId
  };
  await Promise.all(tokens.map((deviceToken) => sendApnsPush(env, deviceToken, payload)));
}
