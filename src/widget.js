/**
 * The embeddable clinic availability widget.
 *
 * A clinic pastes `<script src=".../widget.js" data-timi-widget="TOKEN">`
 * onto its own public website (see public/widget.js and docs/WIDGET.md). The
 * token is the widget's entire authentication and its entire authorization:
 * it is a random, hashed-at-rest credential, and the one thing it can ever
 * be exchanged for is `GET /api/widget/:token/status` — a response built
 * from an explicit whitelist (see `WHITELIST_STATUSES` and
 * `buildStatusPayload` below), never from a blocklist. No name, no address,
 * no capacity numbers, no customer data, no financial data is ever assembled
 * into that response, by construction: the function that builds it has no
 * access to the location row's other fields.
 *
 * Token management (`handleCreateWidgetToken`, `handleListWidgetTokens`,
 * `handleRevokeWidgetToken`) is clinic-admin-only and lives behind the
 * ordinary `/api/clinic/*` auth gate in src/index.js and
 * apps/vet-web/src/index.js. `handlePublicWidgetStatus` is the one public,
 * unauthenticated surface here.
 */

import { getClinicLocation, getLocation, hasDatabase } from "./db.js";
import { isOrgAdmin } from "./auth.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

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

function timestampMs(value) {
  if (!value) return Number.NaN;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  return Date.parse(normalized);
}

async function readJson(request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 32_768) throw new Error("PAYLOAD_TOO_LARGE");
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new Error("JSON_REQUIRED");
  }
  return request.json();
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * 192 bits of randomness (comfortably over the 128-bit floor), base64url
 * encoded so it drops into a URL path segment with no escaping. Only the
 * SHA-256 hash is ever persisted — see widget_tokens.token_hash.
 */
async function generateWidgetToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = `wgt_${base64Url(bytes)}`;
  const hash = await sha256Hex(token);
  return { token, hash, prefix: token.slice(0, 12) };
}

function normalizeOrigin(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  try {
    const url = new URL(text);
    // HTTPS-only: a clinic's own site is expected to be served over TLS, and
    // an http:// entry here would be an Origin header no real browser sends
    // for a mixed-content embed anyway.
    if (url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function recordWidgetAudit(env, tenantId, tokenId, eventType, detail) {
  console.log(JSON.stringify({ event: `widget_${eventType}`, tenantId, tokenId }));
  if (!hasDatabase(env)) return;
  try {
    await env.DB.prepare(`
      INSERT INTO widget_audit_log (id, tenant_id, token_id, event_type, detail_json)
      VALUES (?, ?, ?, ?, ?)
    `).bind(newId("widgetaudit"), tenantId || null, tokenId || null, eventType, JSON.stringify(detail || {})).run();
  } catch (error) {
    console.warn(JSON.stringify({ event: "widget_audit_write_failed", message: error.message }));
  }
}

function rowToTokenSummary(row) {
  return {
    id: row.id,
    label: row.label || null,
    prefix: row.token_prefix,
    allowedOrigins: parseJsonArray(row.allowed_origins_json),
    status: row.status,
    createdAt: row.created_at,
    revokedAt: row.revoked_at || null,
    lastUsedAt: row.last_used_at || null
  };
}

/* -------------------------------------------------- clinic-admin routes --- */

export async function handleListWidgetTokens(env, tenantId) {
  if (!hasDatabase(env)) return json({ tokens: [] });
  const result = await env.DB.prepare(`
    SELECT id, label, token_prefix, allowed_origins_json, status, created_at, revoked_at, last_used_at
    FROM widget_tokens WHERE tenant_id = ? ORDER BY datetime(created_at) DESC
  `).bind(tenantId).all();
  return json({ tokens: result.results.map(rowToTokenSummary) });
}

export async function handleCreateWidgetToken(request, env, actor, tenantId) {
  if (!hasDatabase(env)) return apiError(503, "DATABASE_REQUIRED", "D1 is required to create a widget token.");
  if (!isOrgAdmin(actor)) return apiError(403, "ADMIN_REQUIRED", "Only a workspace administrator can create a widget token.");
  const body = await readJson(request).catch(() => null);
  const label = cleanString(body?.label, 80) || null;
  const rawOrigins = Array.isArray(body?.allowedOrigins) ? body.allowedOrigins.slice(0, 10) : [];
  const allowedOrigins = [...new Set(rawOrigins.map(normalizeOrigin).filter(Boolean))];
  if (rawOrigins.length && !allowedOrigins.length) {
    return apiError(422, "INVALID_ORIGINS", "Allowed origins must be full https:// site addresses, e.g. https://www.yourclinic.example.");
  }

  const location = await getClinicLocation(env, tenantId);
  const { token, hash, prefix } = await generateWidgetToken();
  const id = newId("widgettoken");
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO widget_tokens (id, tenant_id, location_id, label, token_hash, token_prefix, allowed_origins_json, status, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `).bind(id, tenantId, location?.id || null, label, hash, prefix, JSON.stringify(allowedOrigins), actor.userId || null, now).run();
  await recordWidgetAudit(env, tenantId, id, "token_created", { label, allowedOrigins });

  return json({
    token: {
      id, label, prefix, allowedOrigins, status: "active", createdAt: now, lastUsedAt: null,
      // The plaintext secret is returned exactly once, here. Tími stores
      // only its hash (see generateWidgetToken) — this response is the one
      // and only place it is ever visible again; losing it means revoking
      // this token and creating a new one.
      secret: token
    }
  }, { status: 201 });
}

export async function handleRevokeWidgetToken(env, actor, tenantId, tokenId) {
  if (!hasDatabase(env)) return apiError(503, "DATABASE_REQUIRED", "D1 is required to revoke a widget token.");
  if (!isOrgAdmin(actor)) return apiError(403, "ADMIN_REQUIRED", "Only a workspace administrator can revoke a widget token.");
  const now = new Date().toISOString();
  const result = await env.DB.prepare(`
    UPDATE widget_tokens SET status = 'revoked', revoked_at = ?, revoked_by = ?
    WHERE id = ? AND tenant_id = ? AND status = 'active'
  `).bind(now, actor.userId || null, tokenId, tenantId).run();
  if (!result.meta?.changes) return apiError(404, "WIDGET_TOKEN_NOT_FOUND", "That widget token was not found, or is already revoked.");
  await recordWidgetAudit(env, tenantId, tokenId, "token_revoked", {});
  return json({ revoked: tokenId });
}

/* ------------------------------------------------------------- rate limit --- */

/**
 * A fixed-window counter kept in this isolate's own memory rather than D1.
 *
 * `GET /api/widget/:token/status` is meant to be polled by an embed script
 * on every clinic's own public website, on every page view, worldwide — a
 * D1-backed counter would add a write to that hot path for every request on
 * every colo, purely to blunt scripted abuse of an endpoint that discloses
 * nothing sensitive in the first place (see buildStatusPayload). An
 * in-memory map does that job for free: it resets whenever this isolate
 * recycles and is never shared with any other isolate, so it is not a
 * precise global rate limit — a caller spread across enough edge locations
 * is not meaningfully slowed by it. What it does stop is the common case,
 * one script or tab hammering one token from one place, which is the
 * trade-off worth making here rather than a global one.
 */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_MAP_CAP = 5000;
const rateLimitBuckets = new Map();

function rateLimited(key) {
  if (rateLimitBuckets.size > RATE_LIMIT_MAP_CAP) rateLimitBuckets.clear();
  const now = Date.now();
  const bucket = rateLimitBuckets.get(key);
  if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitBuckets.set(key, { windowStart: now, count: 1 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT_MAX;
}

/* --------------------------------------------------------- public status --- */

/** The only three values this endpoint ever reports for `status`. */
function bucketFor(availability) {
  if (!availability || availability.stale) return "unavailable";
  if (["available", "limited"].includes(availability.intakeStatus)) return "accepting";
  if (availability.intakeStatus === "diverting") return "diverting";
  // closed, critical_only, confirm_first, and anything future and unrecognized
  // all read the same to a pet owner standing outside the building: this
  // clinic cannot take them right now.
  return "full";
}

function coarseFreshness(reportedAt) {
  if (!reportedAt) return null;
  const minutes = Math.max(0, Math.round((Date.now() - timestampMs(reportedAt)) / 60_000));
  if (minutes < 1) return "Updated moments ago";
  if (minutes === 1) return "Updated 1 minute ago";
  if (minutes < 60) return `Updated ${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  return `Updated ${hours} hour${hours === 1 ? "" : "s"} ago`;
}

function originAllowed(request, allowedOrigins) {
  const origin = request.headers.get("origin");
  if (origin) return allowedOrigins.includes(origin);
  const referer = request.headers.get("referer");
  if (referer) {
    try { return allowedOrigins.includes(new URL(referer).origin); } catch { return false; }
  }
  // Neither header present: most likely a non-browser caller (a server-side
  // fetch, curl) that an Origin/Referer check cannot see at all — a browser
  // loading the embed script on a real page sends one or the other. Letting
  // it through here is exactly what makes this check "best-effort": it stops
  // a copy-pasted embed from quietly working on a site the clinic never
  // listed, without pretending to be a hard boundary a direct caller cannot
  // walk around. That is also why the response never carries anything more
  // sensitive than buildStatusPayload's whitelist below.
  return true;
}

/**
 * The public-field whitelist. Deliberately built by naming every field that
 * goes in, not by naming what to leave out of the location row — there is no
 * step here that could "forget" to strip a new column the location table
 * gains later, because nothing from that row reaches this function except
 * the two fields it destructures.
 */
function buildStatusPayload({ availability }, link) {
  const status = bucketFor(availability);
  return {
    status,
    freshness: status === "unavailable" ? null : coarseFreshness(availability?.reportedAt),
    link,
    generatedAt: new Date().toISOString()
  };
}

export async function handlePublicWidgetStatus(request, env, rawToken) {
  const token = typeof rawToken === "string" ? rawToken.trim() : "";
  if (!token || token.length > 200) return apiError(404, "WIDGET_NOT_FOUND", "This widget link is no longer active.");

  if (rateLimited(token)) {
    await recordWidgetAudit(env, null, null, "rate_limited", { tokenPrefix: token.slice(0, 12) });
    return apiError(429, "RATE_LIMITED", "Too many requests. Try again shortly.");
  }
  if (!hasDatabase(env)) return apiError(503, "DATABASE_REQUIRED", "The widget service is not available on this deployment.");

  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(`
    SELECT * FROM widget_tokens WHERE token_hash = ? AND status = 'active' LIMIT 1
  `).bind(hash).first();
  // Unknown and revoked tokens answer identically — nothing here should let
  // a caller distinguish "never existed" from "was revoked".
  if (!row) return apiError(404, "WIDGET_NOT_FOUND", "This widget link is no longer active.");

  const allowedOrigins = parseJsonArray(row.allowed_origins_json);
  if (allowedOrigins.length && !originAllowed(request, allowedOrigins)) {
    await recordWidgetAudit(env, row.tenant_id, row.id, "origin_rejected", {
      origin: cleanString(request.headers.get("origin"), 200) || null,
      referer: cleanString(request.headers.get("referer"), 200) || null
    });
    return apiError(403, "ORIGIN_NOT_ALLOWED", "This widget is not configured for this site.");
  }

  const location = row.location_id ? await getLocation(env, row.location_id) : await getClinicLocation(env, row.tenant_id);
  const now = new Date().toISOString();
  const origin = new URL(request.url).origin;
  const link = `${origin}/?ref=widget_${row.id}&utm_source=widget&utm_medium=referral&utm_campaign=clinic_availability_widget`;

  // Best-effort presence stamp, throttled to at most once a minute so a busy
  // embedded page does not turn every status poll into a database write.
  await env.DB.prepare(`
    UPDATE widget_tokens SET last_used_at = ?
    WHERE id = ? AND (last_used_at IS NULL OR datetime(last_used_at) < datetime(?, '-60 seconds'))
  `).bind(now, row.id, now).run().catch((error) => {
    console.warn(JSON.stringify({ event: "widget_last_used_stamp_failed", message: error.message }));
  });

  return json(buildStatusPayload(location || {}, link));
}
