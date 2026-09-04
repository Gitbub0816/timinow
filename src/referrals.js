/**
 * A clinic's stable overflow referral link.
 *
 * When a clinic is at capacity, front-desk staff hand a pet owner somewhere
 * else to look rather than nothing — a link, read out on a voicemail greeting
 * or sent as an SMS auto-reply, that leads into Tími's own search rather than
 * naming a specific competitor (see the wording snippets rendered in
 * apps/vet-web/public/app.js). One slug per tenant, auto-provisioned the
 * first time the clinic console asks for it, redirecting through
 * `GET /r/:slug` (mounted in src/index.js, the customer Worker, since that is
 * the one surface a pet owner's browser ever reaches) into the customer app
 * with the slug captured as attribution — see migrations/0022 and
 * public/app.js's boot-time attribution capture.
 */

import { getTenant, slugify } from "./tenancy.js";
import { hasDatabase } from "./db.js";

const SLUG_PATTERN = /^[a-z0-9-]{3,64}$/;

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function randomSuffix() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return [...bytes].map((byte) => (byte % 36).toString(36)).join("");
}

function rowToReferralLink(row) {
  return {
    id: row.id,
    slug: row.slug,
    status: row.status,
    clickCount: Number(row.click_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * The tenant's one active referral link, created on first request.
 *
 * Any signed-in clinic member may fetch it — it is display-only, not a
 * capability grant, so there is nothing here worth gating behind
 * `isOrgAdmin` the way widget-token and call-preference changes are.
 */
export async function getOrCreateReferralLink(env, actor, tenantId) {
  if (!hasDatabase(env)) return null;
  const existing = await env.DB.prepare(
    "SELECT * FROM referral_links WHERE tenant_id = ? AND status = 'active' ORDER BY datetime(created_at) LIMIT 1"
  ).bind(tenantId).first();
  if (existing) return rowToReferralLink(existing);

  const tenant = await getTenant(env, tenantId);
  const base = slugify(tenant?.slug || tenant?.name || tenantId).slice(0, 40) || "clinic";
  let slug = base;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${randomSuffix()}`;
    // Bounded to 6 tries; a handful of sequential lookups is cheaper here
    // than a batch for what is, in practice, almost always one round trip.
    const taken = await env.DB.prepare("SELECT id FROM referral_links WHERE slug = ? LIMIT 1").bind(candidate).first();
    if (!taken) { slug = candidate; break; }
    slug = `${base}-${randomSuffix()}`;
  }

  const id = newId("referral");
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(`
      INSERT INTO referral_links (id, tenant_id, slug, status, click_count, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 'active', 0, ?, ?, ?)
    `).bind(id, tenantId, slug, actor?.userId || null, now, now).run();
  } catch (error) {
    // Lost a race with another tab provisioning the same tenant's link at
    // the same moment — read back whichever one won rather than error.
    const raced = await env.DB.prepare(
      "SELECT * FROM referral_links WHERE tenant_id = ? AND status = 'active' ORDER BY datetime(created_at) LIMIT 1"
    ).bind(tenantId).first();
    if (raced) return rowToReferralLink(raced);
    throw error;
  }
  return rowToReferralLink({ id, tenant_id: tenantId, slug, status: "active", click_count: 0, created_at: now, updated_at: now });
}

/**
 * `GET /r/:slug` — the link a pet owner actually taps. Always redirects into
 * the customer app; a slug that is missing, malformed, or revoked still
 * sends the owner into Tími's search rather than a dead end, it just carries
 * no `ref` (or a generic one) since there is nothing meaningful to attribute.
 */
export async function resolveReferralRedirect(env, request, rawSlug) {
  const url = new URL(request.url);
  const slug = String(rawSlug || "").toLowerCase().slice(0, 64);
  const valid = SLUG_PATTERN.test(slug);

  if (valid && hasDatabase(env)) {
    try {
      await env.DB.prepare(
        "UPDATE referral_links SET click_count = click_count + 1, updated_at = CURRENT_TIMESTAMP WHERE slug = ? AND status = 'active'"
      ).bind(slug).run();
    } catch (error) {
      // A missed click count must never turn into a broken redirect.
      console.warn(JSON.stringify({ event: "referral_click_count_failed", message: error.message }));
    }
  }

  const target = new URL("/", url.origin);
  if (valid) {
    target.searchParams.set("ref", `clinic_${slug}`);
    target.searchParams.set("utm_source", "referral");
    target.searchParams.set("utm_medium", "clinic_overflow");
  }
  return Response.redirect(target.toString(), 302);
}
