/**
 * The analytics beacon every surface POSTs to, and nothing else.
 *
 * The privacy rules live here as code, not as policy prose somewhere else:
 * no raw IP address, no raw user agent, no cookie, and no client-supplied
 * identifier is ever written to a row. The only visitor notion is a truncated
 * sha256(UTC date + ip + user agent) — the date is inside the hash, so the
 * value a person hashes to today cannot be joined to the value they hash to
 * tomorrow, and nothing is stored on their device. That is what lets the
 * pages carry no consent banner; see migrations/0010_provider_analytics.sql
 * for the table's side of the same contract.
 *
 * Fail-soft on purpose: a broken beacon must never break a page, so a body
 * that cannot be parsed, a missing database, or a failed insert all answer
 * 202 and are dropped. The only refusals are the two that mean a client bug
 * worth hearing about — too many events in one batch, or an event name that
 * is not a name.
 */

import { hasDatabase } from "./db.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

const MAX_EVENTS = 25;
const MAX_META_KEYS = 10;
const EVENT_NAME = /^[a-z0-9_.:-]{1,40}$/i;

function json(data, init = {}) {
  return new Response(JSON.stringify(data), { ...init, headers: { ...JSON_HEADERS, ...(init.headers || {}) } });
}

function apiError(status, code, message) {
  return json({ error: { code, message } }, { status });
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** The pathname only. Stripped before anything else looks at the value,
 * because the query string is where an email address or a token lands in a
 * URL, and the table must never hold one. */
function cleanPath(value) {
  if (typeof value !== "string") return null;
  const path = value.split(/[?#]/)[0].trim().slice(0, 120);
  return path || null;
}

/** A flat string map, clamped rather than argued with: at most ten keys, each
 * value at most eighty characters, anything that is not a string dropped. */
function cleanMeta(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const meta = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string" || !key) continue;
    meta[String(key).slice(0, 40)] = entry.slice(0, 80);
    if (Object.keys(meta).length >= MAX_META_KEYS) break;
  }
  return meta;
}

/** Two values, deliberately. "Which layout do people use" is the product
 * question; anything finer is a fingerprint with no question attached. */
function coarseDevice(userAgent) {
  if (!userAgent) return null;
  return /Mobi|Android|iPhone|iPad|iPod/i.test(userAgent) ? "mobile" : "desktop";
}

/**
 * The day-scoped visitor value. The raw ip and user agent exist only as the
 * input to this digest — they are never bound into a row — and the UTC date
 * inside the hash is what makes the output expire: the same person is the
 * same 16 hex characters all day and an unlinkable different 16 tomorrow.
 */
async function visitorHash(ip, userAgent) {
  const utcDate = new Date().toISOString().slice(0, 10);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${utcDate}|${ip}|${userAgent}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

/** POST /api/analytics — body `{ events: [{ name, path?, meta? }] }`. */
export async function recordAnalyticsEvents(request, env) {
  const body = await request.json().catch(() => null);
  const events = Array.isArray(body?.events) ? body.events : [];
  if (!events.length) return json({}, { status: 202 });
  if (events.length > MAX_EVENTS) {
    return apiError(422, "TOO_MANY_EVENTS", `Send at most ${MAX_EVENTS} events per batch.`);
  }
  for (const event of events) {
    if (!EVENT_NAME.test(String(event?.name ?? ""))) {
      return apiError(422, "INVALID_EVENT_NAME", "Event names are at most 40 characters of letters, digits, _ . : or -.");
    }
  }

  // No database is a deployment state, not a client mistake: acknowledge and
  // drop, exactly as the row-insert failure below does.
  if (!hasDatabase(env)) return json({}, { status: 202 });

  const now = new Date().toISOString();
  // The surface is the server's own identity, never the client's claim.
  const surface = env.SURFACE || "customer";
  const country = request.cf?.country || null;
  const userAgent = request.headers.get("user-agent") || "";
  const ip = request.headers.get("cf-connecting-ip") || "";
  const visitor = await visitorHash(ip, userAgent);
  const device = coarseDevice(userAgent);

  try {
    // One batch, so a 25-event page load is one D1 round trip and either all
    // lands or none does.
    await env.DB.batch(events.map((event) => env.DB.prepare(`
      INSERT INTO analytics_events (id, occurred_at, surface, name, path, visitor_hash, country, device, meta_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      newId("analytics"), now, surface, String(event.name), cleanPath(event.path),
      visitor, country, device, JSON.stringify(cleanMeta(event.meta))
    )));
  } catch (error) {
    // Dropped counts are a better failure than an erroring page.
    console.warn(JSON.stringify({ event: "analytics_insert_failed", message: error.message }));
  }
  return json({}, { status: 202 });
}
