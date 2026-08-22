function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(normalized + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeJsonPart(value) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

function cookieValue(cookieHeader, name) {
  if (!cookieHeader) return null;
  const prefix = `${name}=`;
  const item = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
  return item ? decodeURIComponent(item.slice(prefix.length)) : null;
}

function getBearerToken(request) {
  const authorization = request.headers.get("authorization") || "";
  if (authorization.startsWith("Bearer ")) return authorization.slice(7).trim();
  return cookieValue(request.headers.get("cookie"), "__session");
}

/**
 * Clerk's publishable key encodes the instance's Frontend API host: the part
 * after `pk_test_` / `pk_live_` is base64 of `<host>$`.
 *
 * Deriving it is more reliable than trusting a hand-set CLERK_ISSUER, because
 * the two can disagree and the failure is silent — a development key with a
 * production issuer fetches JWKS from a host that does not serve it, and every
 * signed-in request simply 401s with nothing in the logs pointing at the cause.
 * The key is always self-consistent with the instance it belongs to.
 */
export function frontendApiFromPublishableKey(publishableKey) {
  const key = String(publishableKey || "");
  const encoded = key.replace(/^pk_(?:test|live)_/, "");
  if (encoded === key || !encoded) return null;
  try {
    const decoded = atob(encoded).replace(/\$+$/, "").trim();
    return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/** Every issuer this instance may legitimately claim. */
function acceptableIssuers(env) {
  const issuers = [];
  const configured = String(env.CLERK_ISSUER || "").replace(/\/$/, "");
  if (configured) issuers.push(configured);
  const derived = frontendApiFromPublishableKey(env.CLERK_PUBLISHABLE_KEY);
  if (derived) issuers.push(`https://${derived}`);
  return issuers;
}

async function fetchJwk(env, keyId) {
  // Explicit override first, then the key-derived host, then CLERK_ISSUER. The
  // derived host outranks CLERK_ISSUER because it cannot be stale.
  const derived = frontendApiFromPublishableKey(env.CLERK_PUBLISHABLE_KEY);
  const issuer = String(env.CLERK_ISSUER || "").replace(/\/$/, "");
  const jwksUrl = env.CLERK_JWKS_URL
    || (derived ? `https://${derived}/.well-known/jwks.json` : "")
    || (issuer ? `${issuer}/.well-known/jwks.json` : "");
  if (!jwksUrl) throw new Error("CLERK_JWKS_URL, CLERK_PUBLISHABLE_KEY, or CLERK_ISSUER is required");

  const response = await fetch(jwksUrl, {
    headers: { accept: "application/json" },
    cf: { cacheEverything: true, cacheTtl: 3600 }
  });
  if (!response.ok) throw new Error(`Unable to retrieve Clerk JWKS (${response.status})`);
  const body = await response.json();
  const key = Array.isArray(body.keys) ? body.keys.find((candidate) => candidate.kid === keyId) : null;
  if (!key) throw new Error("The Clerk signing key was not found");
  return key;
}

async function verifyClerkToken(token, env, request) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed session token");
  const header = decodeJsonPart(parts[0]);
  const claims = decodeJsonPart(parts[1]);
  if (header.alg !== "RS256" || !header.kid) throw new Error("Unsupported Clerk token algorithm");

  const jwk = await fetchJwk(env, header.kid);
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const input = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const validSignature = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    decodeBase64Url(parts[2]),
    input
  );
  if (!validSignature) throw new Error("Invalid Clerk session signature");

  const now = Math.floor(Date.now() / 1000);
  if (!claims.sub || !claims.exp || claims.exp <= now) throw new Error("Expired Clerk session");
  if (claims.nbf && claims.nbf > now + 5) throw new Error("Clerk session is not active yet");
  const issuers = acceptableIssuers(env);
  if (issuers.length && !issuers.includes(String(claims.iss || "").replace(/\/$/, ""))) {
    throw new Error(`Unexpected Clerk issuer ${claims.iss}; expected one of ${issuers.join(", ")}`);
  }
  const allowedOrigins = String(env.AUTHORIZED_PARTIES || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const requestOrigin = request.headers.get("origin");
  if (allowedOrigins.length && requestOrigin && !allowedOrigins.includes(requestOrigin)) {
    throw new Error("Unauthorized request origin");
  }
  if (allowedOrigins.length && claims.azp && !allowedOrigins.includes(claims.azp)) {
    throw new Error("Unauthorized Clerk party");
  }

  const organization = claims.o && typeof claims.o === "object" ? claims.o : {};
  const userMetadata = claims.public_metadata || claims.metadata || claims.pmd || {};
  const orgMetadata = organization.pmd || claims.org_public_metadata || {};
  const permissions = claims.org_permissions || organization.per || [];
  return {
    authenticated: true,
    userId: claims.sub,
    sessionId: claims.sid || null,
    email: claims.email || claims.email_address || userMetadata.email || null,
    username: claims.username || null,
    clerkOrgId: claims.org_id || organization.id || null,
    clerkOrgSlug: claims.org_slug || organization.slg || null,
    role: claims.role || claims.org_role || organization.rol || "customer",
    permissions: Array.isArray(permissions) ? permissions : String(permissions).split(",").filter(Boolean),
    userMetadata,
    orgMetadata,
    /**
     * Set by the Clerk JWT template (or by the metadata backfill in
     * `src/session.js`) so desktop and native clients resolve their tenant
     * straight from the session token instead of a second round trip.
     */
    tenantId: claims.tenant_id || orgMetadata.tenantId || userMetadata.tenantId || null,
    locationId: claims.location_id || orgMetadata.locationId || userMetadata.locationId || null,
    claims
  };
}

export function signInRequired(env) {
  return env.SIGN_IN_REQUIRED === "true";
}

export async function actorForRequest(request, env) {
  if (!signInRequired(env)) {
    return {
      authenticated: false,
      userId: request.headers.get("x-demo-user-id") || "demo_customer",
      tenantId: request.headers.get("x-demo-tenant-id") || "tenant_hearth",
      role: request.headers.get("x-demo-role") || "customer",
      email: request.headers.get("x-demo-email") || null,
      permissions: [],
      userMetadata: {},
      orgMetadata: {},
      clerkOrgId: null,
      clerkOrgSlug: null,
      locationId: null,
      demo: true
    };
  }

  const token = getBearerToken(request);
  if (!token) return null;
  try {
    return await verifyClerkToken(token, env, request);
  } catch (error) {
    console.warn(JSON.stringify({ event: "auth_rejected", message: error.message }));
    return null;
  }
}

export function roleAllows(actor, allowedRoles) {
  if (!actor) return false;
  const normalized = String(actor.role || "").toLowerCase();
  if (allowedRoles.includes(normalized)) return true;
  if (allowedRoles.includes("clinic") && (normalized.includes("admin") || normalized.includes("member"))) return true;
  return false;
}


/**
 * Platform operators may hold `org:admin` inside a tenant while still being
 * denied tenant creation; that check lives in `src/tenancy.js`. This helper only
 * answers whether the actor administers the organization the session is scoped to.
 */
export function isOrgAdmin(actor) {
  if (!actor) return false;
  const role = String(actor.role || "").toLowerCase();
  return role === "org:admin" || role === "admin";
}
