/**
 * Signed links back to an in-progress care search.
 *
 * Feature B's SMS ("close the page, we'll text you") has to hand the
 * customer a URL that resolves to their search without asking them to sign
 * back in. A raw `care_searches.id` would work mechanically — GET
 * `/api/searches/:id` already accepts one — but a bare internal id in a text
 * message is a bearer credential with no expiry: it can be forwarded,
 * logged by a carrier or an SMS gateway, or simply guessed at low volume,
 * and whoever holds it can read someone else's pet, symptoms, and (once the
 * clinic-masking window has closed) the offer their real address sits
 * behind. This module wraps the id in a short-lived, tamper-evident token
 * instead: HMAC-signed, carrying its own expiry, verified without a
 * database round trip.
 *
 * Not a JWT — there is exactly one claim, so a fixed-format token is
 * simpler to read than a library earns here.
 */

const TEXT_ENCODER = new TextEncoder();

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** The secret this signs with. Falls back to SESSION_SECRET, the same pattern src/match-alias.js uses. */
export function searchLinkSecret(env) {
  const secret = env?.SEARCH_LINK_SECRET || env?.SESSION_SECRET;
  return secret ? String(secret) : null;
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey("raw", TEXT_ENCODER.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, TEXT_ENCODER.encode(message)));
}

/**
 * A signed, expiring token that resolves to `searchId`. Returns null when no
 * secret is configured — callers must treat that as "cannot build a link"
 * and skip sending one rather than fall back to an unsigned id.
 */
export async function signSearchToken(env, searchId, { ttlMinutes = 60 * 24 } = {}) {
  const secret = searchLinkSecret(env);
  if (!secret || !searchId) return null;
  const expiresAtMs = Date.now() + Math.max(1, ttlMinutes) * 60_000;
  const payload = `${searchId}.${expiresAtMs}`;
  const signature = await hmac(secret, payload);
  return `${toBase64Url(TEXT_ENCODER.encode(payload))}.${toBase64Url(signature)}`;
}

/** Constant-time comparison, matching src/voice.js's timingSafeEqual. */
function timingSafeEqualBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Verifies and decodes a token from signSearchToken. Returns `{ searchId }` or null — expired, malformed, and unsigned tokens all return null, indistinguishably. */
export async function verifySearchToken(env, token) {
  const secret = searchLinkSecret(env);
  if (!secret || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  let payloadBytes;
  let signatureBytes;
  try {
    payloadBytes = fromBase64Url(parts[0]);
    signatureBytes = fromBase64Url(parts[1]);
  } catch {
    return null;
  }
  const payload = new TextDecoder().decode(payloadBytes);
  const expectedSignature = await hmac(secret, payload);
  if (!timingSafeEqualBytes(expectedSignature, signatureBytes)) return null;
  const [searchId, expiresAtRaw] = payload.split(".");
  const expiresAtMs = Number(expiresAtRaw);
  if (!searchId || !Number.isFinite(expiresAtMs) || Date.now() > expiresAtMs) return null;
  return { searchId };
}
