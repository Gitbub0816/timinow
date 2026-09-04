/**
 * Anonymous guest sessions.
 *
 * A pet owner must be able to search, get offers, pay, and book with nothing
 * more than a phone number typed into the intake form — no Clerk account, no
 * sign-in. Every production Worker sets `SIGN_IN_REQUIRED=true`
 * (docs/PLATFORM-CONTRACT.md), and until this module existed that meant the
 * blanket gate in `src/index.js` 401'd every one of those requests: the only
 * actor it ever recognized was a verified Clerk session.
 *
 * A guest session is a random, unguessable id minted the first time an
 * anonymous visitor reaches the API, carried in an httpOnly, signed cookie so
 * it survives a reload without ever being readable or forgeable by page
 * script. The id becomes the actor's `userId` everywhere a Clerk user id
 * would otherwise go — `care_searches.customer_user_id`,
 * `intake_requests.customer_user_id`, `pets.clerk_user_id`, the `actor_id` on
 * an intake event. Every ownership check already written against those
 * columns (`search.customerUserId !== actor.userId`, `WHERE clerk_user_id =
 * ?`) therefore scopes a guest's data correctly with no special-casing, and a
 * second visitor who never received this cookie can never read or write rows
 * that are not theirs — see `guestActor` below.
 *
 * Deliberately stateless: nothing is written to D1 to mint or verify one, so
 * an anonymous page view costs nothing. The only place a guest id is ever
 * persisted is in the rows it comes to own, and — once, idempotently — in
 * `account_adoptions` when a guest converts to a real account. See
 * `src/account-adoption.js`.
 */

const COOKIE_NAME = "__timi_guest";
const PURPOSE = "timi.guest.v1";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 180; // 180 days

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  return Uint8Array.from(atob(normalized + padding), (character) => character.charCodeAt(0));
}

function cookieValue(cookieHeader, name) {
  if (!cookieHeader) return null;
  const prefix = `${name}=`;
  const item = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
  return item ? decodeURIComponent(item.slice(prefix.length)) : null;
}

/** Constant-time so a response's timing cannot leak how much of a signature matched. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

function newGuestId() {
  return `guest_${crypto.randomUUID().replaceAll("-", "")}`;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** Whether this Worker can sign (and therefore persist) a guest session. */
export function guestSessionsConfigured(env) {
  return Boolean(env.GUEST_SESSION_SECRET);
}

async function sign(env, payloadB64) {
  const key = await hmacKey(env.GUEST_SESSION_SECRET);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${PURPOSE}:${payloadB64}`));
  return base64UrlEncode(new Uint8Array(signature));
}

async function issueToken(env, guestId, issuedAt) {
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ i: guestId, t: issuedAt })));
  return `${payloadB64}.${await sign(env, payloadB64)}`;
}

function setCookieHeader(token, maxAgeSeconds) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

/** Clears the guest cookie — called once a guest's rows have been adopted into a real account. */
export function clearGuestSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * Reads and verifies the guest cookie on a request. `null` if there is none,
 * it is malformed, the signature does not match, or it has aged past
 * `MAX_AGE_SECONDS` — the caller treats any of those exactly like a
 * first-ever visit.
 */
export async function readGuestSession(request, env) {
  if (!guestSessionsConfigured(env)) return null;
  const token = cookieValue(request.headers.get("cookie"), COOKIE_NAME);
  if (!token) return null;
  const [payloadB64, signatureB64] = token.split(".");
  if (!payloadB64 || !signatureB64) return null;
  try {
    const expected = await sign(env, payloadB64);
    if (!timingSafeEqual(expected, signatureB64)) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)));
    if (typeof payload.i !== "string" || !payload.i.startsWith("guest_")) return null;
    if (!Number.isFinite(payload.t) || Date.now() / 1000 - payload.t > MAX_AGE_SECONDS) return null;
    return { guestId: payload.i, issuedAt: payload.t };
  } catch {
    return null;
  }
}

/** Mints a brand-new, persistable guest session and the Set-Cookie header that carries it. */
export async function mintGuestSession(env) {
  const guestId = newGuestId();
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await issueToken(env, guestId, issuedAt);
  return { guestId, cookie: setCookieHeader(token, MAX_AGE_SECONDS) };
}

/**
 * The actor shape a guest session presents to every route that reads
 * `actor`. `role: "guest"` deliberately matches nothing `roleAllows` grants
 * (see src/auth.js) and fails `isOrgAdmin` — a guest can never pass as clinic
 * or tenant staff, only as the customer who owns whatever rows carry its id.
 */
export function guestActor(guestId) {
  return {
    authenticated: false,
    guest: true,
    userId: guestId,
    tenantId: null,
    clerkOrgId: null,
    clerkOrgSlug: null,
    locationId: null,
    role: "guest",
    email: null,
    permissions: [],
    userMetadata: {},
    orgMetadata: {}
  };
}

/**
 * Resolves the guest actor for a request that reached here with no Clerk
 * session: reuses an existing guest cookie when one verifies, otherwise mints
 * a new one. When `GUEST_SESSION_SECRET` is not configured, still returns a
 * usable (but unpersisted, single-request) guest actor rather than blocking
 * the visitor — booking must never depend on an operator having remembered to
 * set a secret, even though every production deployment should set one so the
 * session actually survives a reload.
 */
export async function resolveGuestActor(request, env) {
  const existing = await readGuestSession(request, env);
  if (existing) return { actor: guestActor(existing.guestId), cookie: null };
  if (!guestSessionsConfigured(env)) {
    if (!resolveGuestActor.warned) {
      resolveGuestActor.warned = true;
      console.warn(JSON.stringify({ event: "guest_session_secret_missing", detail: "GUEST_SESSION_SECRET is not set; guest sessions will not persist across requests." }));
    }
    return { actor: guestActor(newGuestId()), cookie: null };
  }
  const minted = await mintGuestSession(env);
  return { actor: guestActor(minted.guestId), cookie: minted.cookie };
}

/**
 * Paths where an anonymous visitor is worth minting a session for. Excludes
 * clinic, tenant, and platform-admin surfaces — a guest cookie there would
 * only ever be wasted, since `roleAllows`/`isOrgAdmin` never grant a `role:
 * "guest"` actor anything on those routes.
 */
export function isGuestEligiblePath(path) {
  return !path.startsWith("/api/clinic/") && !path.startsWith("/api/tenant/") && !path.startsWith("/api/admin/");
}
