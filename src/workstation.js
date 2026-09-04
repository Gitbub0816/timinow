/**
 * Shared clinic workstation sessions.
 *
 * Reception should not need an individual Clerk login to run the desk. A
 * tenant administrator (existing `org:admin` role — see `isOrgAdmin` in
 * src/auth.js) names a workstation ("Front desk 1") and receives a one-time
 * enrollment token; entering it on the reception computer opens a durable,
 * revocable session scoped to exactly the routine operations a front desk
 * needs — availability, capacity, and accepting or declining a request. See
 * `resolveClinicOperator` below for precisely which routes that covers.
 * Everything else (settings, payouts, call preferences, people, billing,
 * workstation administration itself) still requires an individually
 * signed-in org member.
 *
 * The enrollment token is shown once, at creation, and stored only hashed
 * (SHA-256) — the same posture as a password, because functionally that is
 * what it is: whoever holds it can act for the clinic until it is revoked. A
 * session established from it is a second, unrelated secret (a signed,
 * httpOnly cookie), so a leaked session cookie never also leaks the reusable
 * enrollment token, and revoking the workstation invalidates every session it
 * ever established without having to know which devices are still holding
 * one — see `verifyWorkstationSession`, which joins back to
 * `workstations.revoked_at` on every check.
 */

import { hasDatabase } from "./db.js";
import { isOrgAdmin, roleAllows } from "./auth.js";

const COOKIE_NAME = "__timi_workstation";
const PURPOSE = "timi.workstation.v1";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 90; // 90 days; re-enroll the device after that

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function cookieValue(cookieHeader, name) {
  if (!cookieHeader) return null;
  const prefix = `${name}=`;
  const item = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
  return item ? decodeURIComponent(item.slice(prefix.length)) : null;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** The enrollment token shown exactly once, at creation. High-entropy, url-safe. */
function newEnrollmentToken() {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function sessionSecretConfigured(env) {
  return Boolean(env.WORKSTATION_SESSION_SECRET);
}

async function signSessionId(env, sessionId) {
  const key = await hmacKey(env.WORKSTATION_SESSION_SECRET);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${PURPOSE}:${sessionId}`));
  return base64UrlEncode(new Uint8Array(signature));
}

function setCookieHeader(value, maxAgeSeconds) {
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearWorkstationSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function workstationRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    createdBy: row.created_by,
    createdAt: row.created_at,
    revokedAt: row.revoked_at || null,
    revokedBy: row.revoked_by || null
  };
}

/* --------------------------------------------------- admin (Clerk actor) --- */

/** Only a Clerk org admin of the tenant may create, list, or revoke a workstation. */
export function requireWorkstationAdmin(actor, tenantId) {
  // Mirrors requireTenantAdmin in src/tenant-admin.js: a demo actor (no live
  // Clerk session, SIGN_IN_REQUIRED=false) is also allowed through so the
  // zero-configuration demo can exercise this without a Worker secret.
  if (!actor?.authenticated && !actor?.demo) return { status: 401, code: "AUTHENTICATION_REQUIRED", message: "Sign in to continue." };
  if (!tenantId) return { status: 403, code: "TENANT_REQUIRED", message: "Choose an active Clerk organization mapped to a Tími tenant." };
  if (!isOrgAdmin(actor)) return { status: 403, code: "TENANT_ADMIN_REQUIRED", message: "Only a workspace administrator can manage workstations." };
  return null;
}

export async function listWorkstations(env, tenantId) {
  if (!hasDatabase(env)) return [];
  const result = await env.DB.prepare(
    "SELECT * FROM workstations WHERE tenant_id = ? ORDER BY revoked_at IS NOT NULL, created_at DESC"
  ).bind(tenantId).all();
  return result.results.map(workstationRow);
}

/**
 * Creates a workstation and returns its enrollment token exactly once.
 * Nothing after this call can recover it — only its hash is stored, so a lost
 * token means creating a new workstation and revoking the old one.
 */
export async function createWorkstation(env, actor, tenantId, name) {
  const cleanName = String(name || "").trim().slice(0, 80);
  if (!cleanName) return { ok: false, status: 422, code: "WORKSTATION_NAME_REQUIRED", message: "Name the workstation, e.g. \"Front desk 1\"." };
  if (!hasDatabase(env)) return { ok: false, status: 503, code: "DATABASE_REQUIRED", message: "D1 is required to create a workstation." };
  const token = newEnrollmentToken();
  const tokenHash = await sha256Hex(token);
  const id = newId("workstation");
  await env.DB.prepare(`
    INSERT INTO workstations (id, tenant_id, name, token_hash, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).bind(id, tenantId, cleanName, tokenHash, actor.userId).run();
  return { ok: true, workstation: { id, tenantId, name: cleanName, createdAt: new Date().toISOString(), revokedAt: null }, token };
}

/** Revoking a workstation invalidates every session it has ever established. */
export async function revokeWorkstation(env, actor, tenantId, workstationId) {
  if (!hasDatabase(env)) return { ok: false, status: 503, code: "DATABASE_REQUIRED", message: "D1 is required to revoke a workstation." };
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    "UPDATE workstations SET revoked_at = ?, revoked_by = ? WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL"
  ).bind(now, actor.userId, workstationId, tenantId).run();
  if (!result.meta?.changes) return { ok: false, status: 404, code: "WORKSTATION_NOT_FOUND", message: "That workstation was not found, or is already revoked." };
  return { ok: true, revoked: workstationId };
}

/* -------------------------------------------------- enrollment (device) --- */

/**
 * Redeems an enrollment token for a durable session. Necessarily public — the
 * device establishing one has no Clerk session at all — so the token itself,
 * compared only as its hash, is the entire authentication.
 */
export async function establishWorkstationSession(env, token, userAgent) {
  if (!hasDatabase(env)) return { ok: false, status: 503, code: "DATABASE_REQUIRED", message: "D1 is required to enroll a workstation." };
  if (!sessionSecretConfigured(env)) return { ok: false, status: 503, code: "WORKSTATION_SESSIONS_UNCONFIGURED", message: "Workstation sessions are not configured on this deployment." };
  const cleanToken = String(token || "").trim();
  if (!cleanToken) return { ok: false, status: 422, code: "TOKEN_REQUIRED", message: "Enter the workstation's enrollment code." };
  const tokenHash = await sha256Hex(cleanToken);
  const workstation = await env.DB.prepare(
    "SELECT * FROM workstations WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1"
  ).bind(tokenHash).first();
  if (!workstation) return { ok: false, status: 401, code: "WORKSTATION_TOKEN_INVALID", message: "That code is not valid, or the workstation has been revoked." };

  const sessionId = newId("wssession");
  await env.DB.prepare(`
    INSERT INTO workstation_sessions (id, workstation_id, user_agent)
    VALUES (?, ?, ?)
  `).bind(sessionId, workstation.id, String(userAgent || "").slice(0, 300) || null).run();

  const signature = await signSessionId(env, sessionId);
  return {
    ok: true,
    cookie: setCookieHeader(`${sessionId}.${signature}`, SESSION_MAX_AGE_SECONDS),
    workstation: { id: workstation.id, name: workstation.name, tenantId: workstation.tenant_id }
  };
}

/** Ends just this one device's session without touching the workstation or its other sessions. */
export async function endWorkstationSession(request, env) {
  const raw = cookieValue(request.headers.get("cookie"), COOKIE_NAME);
  const sessionId = raw?.split(".")[0];
  if (sessionId && hasDatabase(env)) {
    await env.DB.prepare("UPDATE workstation_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?").bind(sessionId).run();
  }
  return clearWorkstationSessionCookie();
}

/**
 * Verifies the workstation cookie on a request: the HMAC signature, then that
 * neither the session nor its workstation has since been revoked. Touches
 * `last_seen_at` so "which workstations are actually in use" is answerable
 * without a separate heartbeat endpoint.
 */
export async function verifyWorkstationSession(request, env) {
  if (!hasDatabase(env) || !sessionSecretConfigured(env)) return null;
  const raw = cookieValue(request.headers.get("cookie"), COOKIE_NAME);
  if (!raw) return null;
  const [sessionId, signature] = raw.split(".");
  if (!sessionId || !signature) return null;
  try {
    const expected = await signSessionId(env, sessionId);
    if (!timingSafeEqual(expected, signature)) return null;
  } catch {
    return null;
  }
  const row = await env.DB.prepare(`
    SELECT s.id AS session_id, s.workstation_id, w.tenant_id, w.name AS workstation_name
    FROM workstation_sessions s
    JOIN workstations w ON w.id = s.workstation_id
    WHERE s.id = ? AND s.revoked_at IS NULL AND w.revoked_at IS NULL
    LIMIT 1
  `).bind(sessionId).first();
  if (!row) return null;
  await env.DB.prepare("UPDATE workstation_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?").bind(sessionId).run();
  return { sessionId: row.session_id, workstationId: row.workstation_id, tenantId: row.tenant_id, workstationName: row.workstation_name };
}

export async function logWorkstationAction(env, workstationSessionId, action, detail = {}) {
  if (!hasDatabase(env) || !workstationSessionId) return;
  await env.DB.prepare(`
    INSERT INTO workstation_audit_log (id, workstation_session_id, action, detail_json)
    VALUES (?, ?, ?, ?)
  `).bind(newId("wsaudit"), workstationSessionId, action, JSON.stringify(detail || {})).run();
}

/* --------------------------------------------------- operator resolution --- */

/**
 * Who may run a *routine* clinic operation: an authenticated org member of
 * the tenant, or — for exactly the operations listed in
 * docs/PLATFORM-CONTRACT.md and enforced by the callers of this function —
 * a valid workstation session. Returns an operator context, or `null` when
 * neither applies.
 *
 * `actorUserId` is what callers should stamp into `intake_events.actor_id`
 * and `availability_reports.created_by` in place of `actor.userId`: a
 * workstation has no Clerk user behind it, so its actions are attributed to
 * the workstation itself (`workstation:<id>`) — which is what makes "clinic +
 * workstation + timestamp" reconstructable from those existing columns with
 * no schema change to every table an operator can write to. The finer
 * "which physical session, at which moment" grain lives in
 * `workstation_audit_log`, keyed by `workstationSessionId`.
 */
export async function resolveClinicOperator(request, env, actor) {
  if (roleAllows(actor, ["clinic", "admin", "org:admin", "org:member"]) && actor?.tenantId) {
    return { kind: "member", tenantId: actor.tenantId, actorUserId: actor.userId, workstationSessionId: null };
  }
  const workstation = await verifyWorkstationSession(request, env);
  if (workstation) {
    return {
      kind: "workstation",
      tenantId: workstation.tenantId,
      actorUserId: `workstation:${workstation.workstationId}`,
      workstationSessionId: workstation.sessionId,
      workstationName: workstation.workstationName
    };
  }
  return null;
}
