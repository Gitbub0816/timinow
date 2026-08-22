/**
 * Tími veterinary operations console Worker (timinow-vet).
 *
 * This is a thin router. It does not duplicate business logic: the four
 * `/api/clinic/*` handlers (`clinicDashboard`, `setClinicAvailability`,
 * `decideIntake`, `respondToCareSearch`) live in ../../../src/index.js and are
 * imported directly here — the only change made to that file was adding the
 * `export` keyword to those four function declarations. Authentication,
 * session description, and tenant member administration are imported the same
 * way from the shared src/*.js modules so this Worker never re-implements them.
 *
 * See docs/PLATFORM-CONTRACT.md for the full authorization model and the
 * shared API this Worker must serve identically to `timinow` and
 * `timinow-admin`.
 */

import { actorForRequest, roleAllows, signInRequired } from "../../../src/auth.js";
import { describeSession } from "../../../src/session.js";
import { hasDatabase, tenantIdForClerkOrg } from "../../../src/db.js";
import {
  clinicDashboard,
  decideIntake,
  respondToCareSearch,
  setClinicAvailability
} from "../../../src/index.js";
import {
  addMember,
  changeMemberRole,
  listMembers,
  removeMember,
  requireTenantAdmin,
  revokeInvitation
} from "../../../src/tenant-admin.js";

const DEFAULT_MAP_STYLE = "mapbox://styles/calebowen2019/cmt3nci25004d01sya8qxcb4u";
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

function authRequiredResponse() {
  return apiError(401, "AUTHENTICATION_REQUIRED", "Sign in is required to continue.");
}

async function readJson(request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 32_768) throw new Error("PAYLOAD_TOO_LARGE");
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new Error("JSON_REQUIRED");
  }
  return request.json();
}

/** Mirrors src/index.js `authenticatedActor` — resolves tenantId when only the Clerk org is known. */
async function authenticatedActor(request, env) {
  const actor = await actorForRequest(request, env);
  if (!actor) return null;
  if (!actor.tenantId && actor.clerkOrgId) actor.tenantId = await tenantIdForClerkOrg(env, actor.clerkOrgId);
  return actor;
}

async function handleConfig(env) {
  return json({
    appName: "Tími NOW",
    signInRequired: signInRequired(env),
    clerkPublishableKey: signInRequired(env) ? (env.CLERK_PUBLISHABLE_KEY || null) : null,
    clerkJsUrl: signInRequired(env) ? (env.CLERK_JS_URL || "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/+esm") : null,
    stripePublishableKey: env.STRIPE_PUBLISHABLE_KEY || null,
    demoMode: env.DEMO_MODE === "true",
    database: hasDatabase(env) ? "d1" : "fixtures",
    surface: env.SURFACE || "clinic",
    map: {
      /** Public Mapbox token. Never expose a secret (sk.) token here. */
      token: env.MAPBOX_PUBLIC_TOKEN || null,
      styleUrl: env.MAPBOX_STYLE_URL || DEFAULT_MAP_STYLE,
      navigationStyleUrl: env.MAPBOX_NAVIGATION_STYLE_URL || env.MAPBOX_STYLE_URL || DEFAULT_MAP_STYLE
    }
  });
}

/**
 * Workspace people management. Byte-for-byte the same guard flow as
 * src/index.js `handleTenantAdmin` — mounted here so the veterinary console
 * shares one implementation with the customer and admin Workers. Creating a
 * tenant is deliberately absent; that is platform-operator only.
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

  if (method === "GET" && path === "/api/health") return json({ ok: true, service: "timinow-vet", surface: "clinic", database: hasDatabase(env) });
  if (method === "GET" && path === "/api/config") return handleConfig(env);

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
  }

  // No `scheduled` handler: expiry of stale intake/search/offer state is owned
  // by the customer Worker's cron trigger against the same D1 database.
};
