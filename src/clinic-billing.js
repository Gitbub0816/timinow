/**
 * The clinic side of the business: joining, pricing, proving a visit
 * happened, and being billed for it.
 *
 * Four things live here, in the order a clinic meets them.
 *
 * ## 1. The join portal
 *
 * A practice applies, a human reviews it, approval creates the tenant, its
 * location, and its pricing assignment in one place. It extends the existing
 * `provider_applications` table rather than opening a second one: that table
 * was already the lead form, and two application tables means two inboxes and
 * a practice that falls between them.
 *
 * ## 2. Pricing
 *
 * What a clinic pays is a row, not a constant — `clinicFeeFor` in
 * src/pricing.js answers it, and nothing in this file hardcodes $25. Founding
 * clinics pay $0 permanently while in good standing, expressed as a contract
 * on the assignment rather than as a special case in billing code.
 *
 * ## 3. Proving the visit
 *
 * A clinic-side fee cannot rest on "please tell us whether the patient came".
 * Neither can it rest on the clinic's own word alone: the party being paid is
 * the party asserting the fact. So signals accumulate from several sources —
 * the customer, the clinic, the device, the deposit, a practice-management
 * integration — and `evaluateVisitSignals` requires corroboration from at
 * least two independent sources before a visit is COMPLETED and billable.
 * One weak signal never overrides contradictory evidence; a no-show report
 * filed against a geofenced arrival and a captured deposit does not become a
 * no-show, it becomes a dispute.
 *
 * ## 4. Billing
 *
 * A receivable is created at verified completion and never before. Every
 * completed visit gets a row, including the free ones: a founding clinic's $0
 * carries reason FOUNDING_CLINIC_RATE and a sponsored visit's $0 carries
 * SPONSORED_VISIT. A waiver that leaves no row is indistinguishable from a
 * fee nobody remembered to bill, and six months later nobody can tell you
 * which it was.
 *
 * Collection defaults to a monthly invoice. The failure ladder is
 * DUE → RETRYING → PAST_DUE → RESTRICTED, and RESTRICTED stops new
 * availability acceptances rather than anything retroactive.
 *
 * One rule outranks every other in this file: **clinic debt never touches
 * restricted fund money.** Not as a set-off, not as a convenience, not for a
 * single accounting period. Contributions are held for a stated purpose;
 * paying a clinic's overdue invoice out of them would spend a donor's $2 on
 * something they did not agree to. `assertNoRestrictedOffset` refuses it
 * mechanically, because a rule this important should not depend on everyone
 * remembering it.
 */

import { hasDatabase } from "./db.js";
import { activePricingPolicy, clinicFeeFor } from "./pricing.js";
import { postTransaction, recordAudit, RESTRICTED_ACCOUNTS } from "./ledger.js";
import { insertTenant, slugify } from "./tenancy.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function json(data, init = {}) {
  return new Response(JSON.stringify(data), { ...init, headers: { ...JSON_HEADERS, ...(init.headers || {}) } });
}

function apiError(status, code, message, details) {
  return json({ error: { code, message, ...(details ? { details } : {}) } }, { status });
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function text(value, maxLength) {
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

/* ═══════════════════════════════════════════════════════════ join portal ═══ */

export const APPLICATION_STATUSES = Object.freeze(["SUBMITTED", "REVIEWING", "APPROVED", "DECLINED", "WITHDRAWN"]);

/**
 * The portal lifecycle mapped onto the legacy triage vocabulary the admin
 * console already reads. Both columns are written on every transition so
 * neither console shows a row stuck in a state it cannot explain.
 */
const LEGACY_STATUS_FOR = {
  SUBMITTED: "new",
  REVIEWING: "contacted",
  APPROVED: "closed",
  DECLINED: "closed",
  WITHDRAWN: "closed"
};

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_SHAPE = /^\+?[0-9().\-\s]{7,24}$/;
const LOCATION_KINDS = new Set(["general", "urgent", "emergency", "specialty"]);

/** How many submissions one submitter may make per hour, and per day by email. */
export const APPLICATION_RATE_LIMIT = Object.freeze({ perSubmitterPerHour: 3, perEmailPerDay: 2 });

/**
 * A coarse, day-scoped key for rate limiting the public form.
 *
 * A truncated hash of address + day + salt, never the address itself: this is
 * an unauthenticated endpoint, the row lives forever, and an IP address in it
 * would be personal data collected for no product reason. Same posture as
 * analytics_events.visitor_hash.
 */
export async function submitterHashFor(request, env) {
  const address = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown";
  const day = new Date().toISOString().slice(0, 10);
  const salt = env?.ANALYTICS_SALT || env?.SESSION_SECRET || "timinow";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${day}|${address}|${salt}`));
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function jsonArray(value, maxItems = 40) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => text(item, 60)).filter(Boolean).slice(0, maxItems);
}

/** Validate a join-portal submission. Refused over the limit, never truncated. */
export function validateClinicApplication(body) {
  const errors = [];
  const application = {
    practiceName: text(body?.practiceName, 120),
    contactName: text(body?.contactName, 120),
    email: text(body?.email, 160),
    phone: text(body?.phone, 24),
    addressLine1: text(body?.addressLine1, 160),
    city: text(body?.city, 120),
    region: text(body?.region ?? body?.state, 60),
    postalCode: text(body?.postalCode, 20),
    country: text(body?.country, 2).toUpperCase() || "US",
    website: text(body?.website, 200),
    licenseNumber: text(body?.licenseNumber, 60),
    licenseAuthority: text(body?.licenseAuthority, 120),
    licenseExpiresOn: text(body?.licenseExpiresOn, 10),
    accreditation: text(body?.accreditation, 200),
    kind: text(body?.kind, 20),
    species: jsonArray(body?.species),
    capabilities: jsonArray(body?.capabilities),
    hours: body?.hours && typeof body.hours === "object" && !Array.isArray(body.hours) ? body.hours : {},
    wantsFounding: Boolean(body?.wantsFounding),
    heardAbout: text(body?.heardAbout, 200),
    notes: text(body?.notes ?? body?.message, 1000)
  };

  if (!application.practiceName) errors.push("practiceName is required (at most 120 characters)");
  if (!application.contactName) errors.push("contactName is required (at most 120 characters)");
  if (!EMAIL_SHAPE.test(application.email)) errors.push("email is invalid");
  if (!PHONE_SHAPE.test(application.phone)) errors.push("phone is invalid");
  if (!application.city) errors.push("city is required");
  if (!application.region) errors.push("region is required");
  if (application.website && !/^https?:\/\//i.test(application.website)) errors.push("website must start with http:// or https://");
  if (application.kind && !LOCATION_KINDS.has(application.kind)) errors.push("kind must be general, urgent, emergency, or specialty");
  if (application.licenseExpiresOn && !/^\d{4}-\d{2}-\d{2}$/.test(application.licenseExpiresOn)) errors.push("licenseExpiresOn must be YYYY-MM-DD");
  // Deliberately not required: a practice that has not yet found its license
  // number should still be able to raise its hand. Verification is a human
  // step before approval, not a form validation.
  return { ok: errors.length === 0, errors, application };
}

/**
 * Record a join-portal submission.
 *
 * Public and unauthenticated, because the practices Tími most wants to hear
 * from have no account, no organization, and no tenant — that is what they
 * are applying for. Rate limited by a day-scoped submitter hash and by email,
 * which is what keeps an open form from becoming a mailbox somebody has to
 * clear by hand.
 */
export async function submitClinicApplication(env, { body, submitterHash = null } = {}) {
  if (!hasDatabase(env)) {
    return { ok: false, status: 503, code: "DATABASE_REQUIRED", message: "Tími cannot store applications right now. Please try again shortly." };
  }
  const { ok, errors, application } = validateClinicApplication(body);
  if (!ok) return { ok: false, status: 422, code: "VALIDATION_FAILED", message: "Review the application form.", details: errors };

  if (submitterHash) {
    const recent = await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM provider_applications
      WHERE submitter_hash = ? AND datetime(created_at) > datetime('now', '-1 hour')
    `).bind(submitterHash).first();
    if (Number(recent?.count || 0) >= APPLICATION_RATE_LIMIT.perSubmitterPerHour) {
      return { ok: false, status: 429, code: "RATE_LIMITED", message: "Too many applications from here just now. Try again shortly." };
    }
  }
  const byEmail = await env.DB.prepare(`
    SELECT COUNT(*) AS count FROM provider_applications
    WHERE lower(email) = lower(?) AND datetime(created_at) > datetime('now', '-1 day')
  `).bind(application.email).first();
  if (Number(byEmail?.count || 0) >= APPLICATION_RATE_LIMIT.perEmailPerDay) {
    return { ok: false, status: 429, code: "DUPLICATE_APPLICATION", message: "We already have a recent application from this address. We'll be in touch." };
  }

  const id = newId("application");
  await env.DB.prepare(`
    INSERT INTO provider_applications (
      id, practice_name, contact_name, email, phone, city, state, species, message, status,
      address_line1, postal_code, country, website, license_number, license_authority,
      license_expires_on, accreditation, species_json, capabilities_json, hours_json, kind,
      wants_founding, heard_about, notes, review_status, submitter_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SUBMITTED', ?)
  `).bind(
    id, application.practiceName, application.contactName, application.email, application.phone,
    application.city, application.region, application.species.join(", ") || null, application.notes || null,
    application.addressLine1 || null, application.postalCode || null, application.country,
    application.website || null, application.licenseNumber || null, application.licenseAuthority || null,
    application.licenseExpiresOn || null, application.accreditation || null,
    JSON.stringify(application.species), JSON.stringify(application.capabilities), JSON.stringify(application.hours),
    application.kind || null, application.wantsFounding ? 1 : 0, application.heardAbout || null,
    application.notes || null, submitterHash
  ).run();

  // Only the id and status go back. The applicant knows what they typed, and
  // echoing it would make a public endpoint a formatter for arbitrary text.
  return { ok: true, status: 201, application: { id, status: "SUBMITTED" } };
}

function applicationFromRow(row) {
  if (!row) return null;
  const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
  return {
    id: row.id,
    practiceName: row.practice_name,
    contactName: row.contact_name,
    email: row.email,
    phone: row.phone,
    addressLine1: row.address_line1 || null,
    city: row.city,
    region: row.state,
    postalCode: row.postal_code || null,
    country: row.country || "US",
    website: row.website || null,
    license: {
      number: row.license_number || null,
      authority: row.license_authority || null,
      expiresOn: row.license_expires_on || null,
      accreditation: row.accreditation || null
    },
    kind: row.kind || null,
    species: parse(row.species_json, []),
    capabilities: parse(row.capabilities_json, []),
    hours: parse(row.hours_json, {}),
    wantsFounding: Boolean(row.wants_founding),
    heardAbout: row.heard_about || null,
    notes: row.notes || row.message || null,
    status: row.review_status || "SUBMITTED",
    legacyStatus: row.status,
    reviewedBy: row.reviewed_by || null,
    reviewedAt: row.reviewed_at || null,
    reviewNote: row.review_note || null,
    declineReason: row.decline_reason || null,
    createdTenantId: row.created_tenant_id || null,
    createdLocationId: row.created_location_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** Applications for the review queue, newest first. */
export async function listClinicApplications(env, { status = null, limit = 100 } = {}) {
  if (!hasDatabase(env)) return [];
  const capped = Math.min(Math.max(Number(limit) || 100, 1), 200);
  const result = status
    ? await env.DB.prepare(`
        SELECT * FROM provider_applications WHERE review_status = ?
        ORDER BY datetime(created_at) DESC, rowid DESC LIMIT ?
      `).bind(status, capped).all()
    : await env.DB.prepare(`
        SELECT * FROM provider_applications
        ORDER BY datetime(created_at) DESC, rowid DESC LIMIT ?
      `).bind(capped).all();
  return result.results.map(applicationFromRow);
}

export async function getClinicApplication(env, applicationId) {
  if (!hasDatabase(env)) return null;
  const row = await env.DB.prepare("SELECT * FROM provider_applications WHERE id = ? LIMIT 1").bind(applicationId).first();
  return applicationFromRow(row);
}

async function setApplicationStatus(env, { applicationId, status, actorId, note = null, declineReason = null, tenantId = null, locationId = null }) {
  await env.DB.prepare(`
    UPDATE provider_applications
    SET review_status = ?, status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP,
        review_note = COALESCE(?, review_note), decline_reason = COALESCE(?, decline_reason),
        created_tenant_id = COALESCE(?, created_tenant_id), created_location_id = COALESCE(?, created_location_id),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(status, LEGACY_STATUS_FOR[status], actorId, note, declineReason, tenantId, locationId, applicationId).run();
}

/** Move an application into review. */
export async function reviewClinicApplication(env, { applicationId, actorId, note = null }) {
  if (!hasDatabase(env)) return { ok: false, status: 503, code: "DATABASE_REQUIRED", message: "D1 is required." };
  const application = await getClinicApplication(env, applicationId);
  if (!application) return { ok: false, status: 404, code: "APPLICATION_NOT_FOUND", message: "That application was not found." };
  if (["APPROVED", "DECLINED", "WITHDRAWN"].includes(application.status)) {
    return { ok: false, status: 409, code: "APPLICATION_CLOSED", message: `That application is already ${application.status}.` };
  }
  await setApplicationStatus(env, { applicationId, status: "REVIEWING", actorId, note });
  await recordAudit(env, {
    actorId, actorRole: "platform", action: "clinic_application.reviewing",
    subjectType: "provider_application", subjectId: applicationId,
    oldState: { status: application.status }, newState: { status: "REVIEWING" }, reason: note
  });
  return { ok: true, application: await getClinicApplication(env, applicationId) };
}

async function uniqueSlug(env, base) {
  let slug = slugify(base);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = attempt === 0 ? slug : `${slug}-${attempt + 1}`;
    const clash = await env.DB.prepare("SELECT id FROM tenants WHERE slug = ? LIMIT 1").bind(candidate).first();
    const locationClash = await env.DB.prepare("SELECT id FROM locations WHERE slug = ? LIMIT 1").bind(candidate).first();
    if (!clash && !locationClash) return candidate;
  }
  return `${slug}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Approve an application: create the tenant, optionally its first location,
 * and its pricing assignment, in that order.
 *
 * `plan` defaults to the applicant's own request only in the sense that a
 * founding rate must still be granted explicitly here — wanting one on a form
 * is not being given one, and a permanent $0 contract should be a decision
 * somebody's name is attached to.
 */
export async function approveClinicApplication(env, {
  applicationId,
  actorId,
  plan = "STANDARD",
  customFeeCents = null,
  contractId = null,
  clerkOrgId = null,
  tenantName = null,
  location = null,
  note = null
} = {}) {
  if (!hasDatabase(env)) return { ok: false, status: 503, code: "DATABASE_REQUIRED", message: "D1 is required." };
  const application = await getClinicApplication(env, applicationId);
  if (!application) return { ok: false, status: 404, code: "APPLICATION_NOT_FOUND", message: "That application was not found." };
  if (application.status === "APPROVED") {
    return { ok: true, duplicate: true, application, tenantId: application.createdTenantId, locationId: application.createdLocationId };
  }
  if (["DECLINED", "WITHDRAWN"].includes(application.status)) {
    return { ok: false, status: 409, code: "APPLICATION_CLOSED", message: `That application is ${application.status}.` };
  }

  const name = tenantName || application.practiceName;
  const tenantId = newId("ten");
  await insertTenant(env, {
    id: tenantId,
    clerkOrgId,
    name,
    slug: await uniqueSlug(env, name),
    contactEmail: application.email,
    createdBy: actorId
  });

  // A location needs coordinates and a street address; an application that
  // did not carry them approves the practice without a listing rather than
  // inventing a map pin, and the tenant console can add it.
  let locationId = null;
  const site = location || {};
  const addressLine1 = text(site.addressLine1 ?? application.addressLine1, 160);
  const latitude = Number(site.latitude);
  const longitude = Number(site.longitude);
  if (addressLine1 && Number.isFinite(latitude) && Number.isFinite(longitude)) {
    locationId = newId("loc");
    const kind = LOCATION_KINDS.has(site.kind || application.kind) ? (site.kind || application.kind) : "general";
    await env.DB.prepare(`
      INSERT INTO locations (
        id, tenant_id, name, slug, kind, address_line1, city, region, postal_code, phone,
        latitude, longitude, timezone, open_24_hours, accepts_walk_ins,
        species_json, capabilities_json, hours_json, active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).bind(
      locationId, tenantId, name, await uniqueSlug(env, `${name}-${application.city}`), kind,
      addressLine1, text(site.city ?? application.city, 120), text(site.region ?? application.region, 60),
      text(site.postalCode ?? application.postalCode, 20), text(site.phone ?? application.phone, 24),
      latitude, longitude, text(site.timezone, 60) || "America/Los_Angeles",
      site.open24Hours ? 1 : 0, site.acceptsWalkIns === false ? 0 : 1,
      JSON.stringify(application.species), JSON.stringify(application.capabilities), JSON.stringify(application.hours)
    ).run();
  }

  if (plan !== "STANDARD") {
    const assigned = await assignPricingPlan(env, { tenantId, plan, customFeeCents, contractId, actorId, reason: `Approved from application ${applicationId}` });
    if (!assigned.ok) return assigned;
  }

  await setApplicationStatus(env, { applicationId, status: "APPROVED", actorId, note, tenantId, locationId });
  await recordAudit(env, {
    actorId, actorRole: "platform", action: "clinic_application.approved",
    subjectType: "provider_application", subjectId: applicationId,
    oldState: { status: application.status },
    newState: { status: "APPROVED", tenantId, locationId, plan }, reason: note
  });

  return { ok: true, status: 200, tenantId, locationId, plan, application: await getClinicApplication(env, applicationId) };
}

/** Decline an application. The reason is required and is recorded. */
export async function declineClinicApplication(env, { applicationId, actorId, reason }) {
  if (!hasDatabase(env)) return { ok: false, status: 503, code: "DATABASE_REQUIRED", message: "D1 is required." };
  if (!reason) return { ok: false, status: 422, code: "REASON_REQUIRED", message: "A decline reason is required." };
  const application = await getClinicApplication(env, applicationId);
  if (!application) return { ok: false, status: 404, code: "APPLICATION_NOT_FOUND", message: "That application was not found." };
  if (application.status === "APPROVED") {
    return { ok: false, status: 409, code: "APPLICATION_APPROVED", message: "An approved application cannot be declined; suspend the tenant instead." };
  }
  await setApplicationStatus(env, { applicationId, status: "DECLINED", actorId, declineReason: reason });
  await recordAudit(env, {
    actorId, actorRole: "platform", action: "clinic_application.declined",
    subjectType: "provider_application", subjectId: applicationId,
    oldState: { status: application.status }, newState: { status: "DECLINED" }, reason
  });
  return { ok: true, application: await getClinicApplication(env, applicationId) };
}

/** A practice withdrawing its own application. */
export async function withdrawClinicApplication(env, { applicationId, actorId = null, reason = null }) {
  if (!hasDatabase(env)) return { ok: false, status: 503, code: "DATABASE_REQUIRED", message: "D1 is required." };
  const application = await getClinicApplication(env, applicationId);
  if (!application) return { ok: false, status: 404, code: "APPLICATION_NOT_FOUND", message: "That application was not found." };
  await setApplicationStatus(env, { applicationId, status: "WITHDRAWN", actorId, note: reason });
  return { ok: true, application: await getClinicApplication(env, applicationId) };
}

/* ══════════════════════════════════════════════════════════════ pricing ═══ */

export const CLINIC_PRICING_PLANS = Object.freeze(["STANDARD", "FOUNDING", "CUSTOM"]);

/**
 * Assign a clinic's pricing plan.
 *
 * FOUNDING is a permanent $0 clinic-side rate for the earliest partners, held
 * for the life of their participation and conditional only on good standing —
 * a contract, not a discount code, and certainly not a hack in the billing
 * path. CUSTOM must carry its own amount and a contract reference, because a
 * custom price nobody can point at an agreement for is an unexplained one.
 */
export async function assignPricingPlan(env, {
  tenantId, plan, customFeeCents = null, contractId = null, actorId = null, goodStanding = true, note = null, reason = null
} = {}) {
  if (!hasDatabase(env)) return { ok: false, status: 503, code: "DATABASE_REQUIRED", message: "D1 is required." };
  if (!CLINIC_PRICING_PLANS.includes(plan)) {
    return { ok: false, status: 422, code: "INVALID_PLAN", message: "Plan must be STANDARD, FOUNDING, or CUSTOM." };
  }
  if (plan === "CUSTOM") {
    const cents = Math.trunc(Number(customFeeCents));
    if (!Number.isFinite(cents) || cents < 0) {
      return { ok: false, status: 422, code: "CUSTOM_FEE_REQUIRED", message: "A custom plan requires customFeeCents." };
    }
    if (!contractId) {
      return { ok: false, status: 422, code: "CONTRACT_REQUIRED", message: "A custom plan requires a contract reference." };
    }
  }
  const tenant = await env.DB.prepare("SELECT id FROM tenants WHERE id = ? LIMIT 1").bind(tenantId).first();
  if (!tenant) return { ok: false, status: 404, code: "TENANT_NOT_FOUND", message: "That clinic was not found." };

  const previous = await env.DB.prepare("SELECT * FROM clinic_pricing_assignments WHERE tenant_id = ? LIMIT 1").bind(tenantId).first();
  const cents = plan === "CUSTOM" ? Math.trunc(Number(customFeeCents)) : null;
  await env.DB.prepare(`
    INSERT INTO clinic_pricing_assignments (tenant_id, plan, custom_fee_cents, contract_id, good_standing, standing_note, assigned_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(tenant_id) DO UPDATE SET
      plan = excluded.plan,
      custom_fee_cents = excluded.custom_fee_cents,
      contract_id = excluded.contract_id,
      good_standing = excluded.good_standing,
      standing_note = excluded.standing_note,
      assigned_by = excluded.assigned_by,
      updated_at = CURRENT_TIMESTAMP
  `).bind(tenantId, plan, cents, contractId, goodStanding ? 1 : 0, note, actorId).run();

  await recordAudit(env, {
    actorId, actorRole: "platform", action: "clinic_pricing.assigned",
    subjectType: "tenant", subjectId: tenantId,
    oldState: previous ? { plan: previous.plan, customFeeCents: previous.custom_fee_cents, goodStanding: Boolean(previous.good_standing) } : null,
    newState: { plan, customFeeCents: cents, contractId, goodStanding },
    reason: reason || note
  });
  return { ok: true, tenantId, plan, customFeeCents: cents, contractId, goodStanding };
}

/**
 * Move a founding clinic in or out of good standing.
 *
 * Prospective only. A clinic that loses founding status pays the standard fee
 * on visits completed from now on; nothing re-bills what was already waived,
 * because a retroactive invoice for a rate somebody was promised is how a
 * founding programme ends.
 */
export async function setFoundingGoodStanding(env, { tenantId, goodStanding, actorId = null, reason }) {
  if (!hasDatabase(env)) return { ok: false, status: 503, code: "DATABASE_REQUIRED", message: "D1 is required." };
  if (!reason) return { ok: false, status: 422, code: "REASON_REQUIRED", message: "Changing good standing requires a reason." };
  const row = await env.DB.prepare("SELECT * FROM clinic_pricing_assignments WHERE tenant_id = ? LIMIT 1").bind(tenantId).first();
  if (!row) return { ok: false, status: 404, code: "ASSIGNMENT_NOT_FOUND", message: "That clinic has no pricing assignment." };
  await env.DB.prepare(
    "UPDATE clinic_pricing_assignments SET good_standing = ?, standing_note = ?, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ?"
  ).bind(goodStanding ? 1 : 0, reason, tenantId).run();
  await recordAudit(env, {
    actorId, actorRole: "platform", action: "clinic_pricing.good_standing",
    subjectType: "tenant", subjectId: tenantId,
    oldState: { goodStanding: Boolean(row.good_standing) }, newState: { goodStanding: Boolean(goodStanding) }, reason
  });
  return { ok: true, tenantId, goodStanding: Boolean(goodStanding) };
}

/* ══════════════════════════════════════════════════ visit verification ═══ */

/** The happy path, in order. Position in this list is the progress measure. */
export const VISIT_STATES = Object.freeze([
  "MATCHED",
  "CUSTOMER_CONFIRMED",
  "CLINIC_REVEALED",
  "EN_ROUTE",
  "ARRIVED_SIGNAL",
  "CLINIC_CHECKIN_CONFIRMED",
  "SERVICE_CONFIRMED",
  "COMPLETED"
]);

export const TERMINAL_VISIT_STATES = Object.freeze(["CANCELLED", "NO_SHOW", "DISPUTED"]);

/**
 * What each signal is worth, and which state it can carry a visit to.
 *
 * The weights are the whole argument of this section. A clinic saying the
 * service happened is worth 2 — real evidence, and not enough on its own,
 * because the clinic is the party being paid. A practice-management system
 * event is worth 3: it is a record kept for the clinic's own purposes rather
 * than for Tími's invoice. A geofence ping is worth 1: phones are wrong about
 * where they are often enough that it cannot carry a fee by itself.
 */
export const SIGNAL_DEFINITIONS = Object.freeze({
  CUSTOMER_CONFIRMED: { source: "CUSTOMER", weight: 1, reaches: "CUSTOMER_CONFIRMED", evidence: false },
  // A clinic accepting is real, and it is not progress through *this*
  // machine: the machine tracks the patient's journey, and the clinic saying
  // yes moves nothing until the customer confirms.
  CLINIC_ACCEPTED: { source: "CLINIC", weight: 0, reaches: "MATCHED", evidence: false },
  CLINIC_REVEALED: { source: "SYSTEM", weight: 0, reaches: "CLINIC_REVEALED", evidence: false },
  EN_ROUTE: { source: "CUSTOMER", weight: 1, reaches: "EN_ROUTE", evidence: false },
  GEOFENCE_ARRIVAL: { source: "DEVICE", weight: 1, reaches: "ARRIVED_SIGNAL", evidence: true },
  CUSTOMER_CHECKIN: { source: "CUSTOMER", weight: 2, reaches: "ARRIVED_SIGNAL", evidence: true },
  CLINIC_CHECKIN: { source: "CLINIC", weight: 2, reaches: "CLINIC_CHECKIN_CONFIRMED", evidence: true },
  CLINIC_SERVICE_CONFIRMED: { source: "CLINIC", weight: 2, reaches: "SERVICE_CONFIRMED", evidence: true },
  CUSTOMER_SERVICE_CONFIRMED: { source: "CUSTOMER", weight: 2, reaches: "SERVICE_CONFIRMED", evidence: true },
  PMS_INTEGRATION_EVENT: { source: "INTEGRATION", weight: 3, reaches: "SERVICE_CONFIRMED", evidence: true },
  DEPOSIT_CAPTURED: { source: "PAYMENT", weight: 2, reaches: "ARRIVED_SIGNAL", evidence: true },
  DEPOSIT_REFUNDED: { source: "PAYMENT", weight: 0, reaches: null, evidence: false },
  CUSTOMER_CANCELLED: { source: "CUSTOMER", weight: 0, reaches: null, evidence: false },
  CLINIC_CANCELLED: { source: "CLINIC", weight: 0, reaches: null, evidence: false },
  NO_SHOW_REPORTED: { source: "CLINIC", weight: 0, reaches: null, evidence: false },
  DISPUTE_OPENED: { source: "SUPPORT", weight: 0, reaches: null, evidence: false },
  DISPUTE_RESOLVED: { source: "SUPPORT", weight: 0, reaches: null, evidence: false }
});

/**
 * The corroboration a visit needs before anybody is billed for it: enough
 * weight, and — the part that matters — evidence from at least two
 * independent sources. A clinic that checks a patient in and then confirms
 * the service has produced 4 points from one source, and one source is one
 * party's word about a payment owed to itself.
 */
export const COMPLETION_THRESHOLD = Object.freeze({ weight: 4, distinctSources: 2 });

/**
 * Read a pile of signals and say where the visit stands.
 *
 * Pure, so it can be reasoned about and tested without a database, and so
 * `visit_verifications` remains a cache that can be rebuilt from the log.
 */
export function evaluateVisitSignals(signals) {
  const rows = [...(signals || [])].sort((a, b) => String(a.occurredAt || "").localeCompare(String(b.occurredAt || "")));
  const seen = new Set(rows.map((row) => row.signal));

  const evidence = rows.filter((row) => SIGNAL_DEFINITIONS[row.signal]?.evidence);
  const weight = evidence.reduce((total, row) => total + (SIGNAL_DEFINITIONS[row.signal]?.weight || 0), 0);
  const sources = new Set(evidence.map((row) => SIGNAL_DEFINITIONS[row.signal]?.source));
  const corroborated = weight >= COMPLETION_THRESHOLD.weight && sources.size >= COMPLETION_THRESHOLD.distinctSources;

  let furthest = "MATCHED";
  for (const row of rows) {
    const reaches = SIGNAL_DEFINITIONS[row.signal]?.reaches;
    if (!reaches) continue;
    if (VISIT_STATES.indexOf(reaches) > VISIT_STATES.indexOf(furthest)) furthest = reaches;
  }

  const reasons = [];
  const serviceConfirmed = VISIT_STATES.indexOf(furthest) >= VISIT_STATES.indexOf("SERVICE_CONFIRMED");

  // A dispute outranks everything: it is precisely the case where the signals
  // disagree, and guessing between them is what a dispute process is for.
  const disputeOpen = seen.has("DISPUTE_OPENED") && !seen.has("DISPUTE_RESOLVED");
  if (disputeOpen) {
    return { state: "DISPUTED", weight, distinctSources: sources.size, corroborated, billable: false, reasons: ["DISPUTE_OPEN"] };
  }

  // A no-show report is one party's claim. Against a geofenced arrival, a
  // customer check-in, or a captured deposit it does not win — it contradicts
  // them, and the contradiction is the finding.
  if (seen.has("NO_SHOW_REPORTED")) {
    const arrivalEvidence = evidence.some((row) => ["GEOFENCE_ARRIVAL", "CUSTOMER_CHECKIN", "DEPOSIT_CAPTURED", "CLINIC_CHECKIN"].includes(row.signal));
    if (!arrivalEvidence) {
      return { state: "NO_SHOW", weight, distinctSources: sources.size, corroborated: false, billable: false, reasons: ["NO_SHOW_REPORTED"] };
    }
    return { state: "DISPUTED", weight, distinctSources: sources.size, corroborated, billable: false, reasons: ["NO_SHOW_CONTRADICTED_BY_ARRIVAL_EVIDENCE"] };
  }

  if ((seen.has("CUSTOMER_CANCELLED") || seen.has("CLINIC_CANCELLED")) && !serviceConfirmed) {
    return { state: "CANCELLED", weight, distinctSources: sources.size, corroborated: false, billable: false, reasons: ["CANCELLED_BEFORE_SERVICE"] };
  }

  if (serviceConfirmed && corroborated) {
    return { state: "COMPLETED", weight, distinctSources: sources.size, corroborated: true, billable: true, reasons: ["SERVICE_CONFIRMED_AND_CORROBORATED"] };
  }
  if (serviceConfirmed) reasons.push(sources.size < COMPLETION_THRESHOLD.distinctSources ? "SINGLE_SOURCE_ONLY" : "INSUFFICIENT_CORROBORATION");
  return { state: furthest, weight, distinctSources: sources.size, corroborated, billable: false, reasons };
}

function signalFromRow(row) {
  return {
    id: row.id,
    intakeId: row.intake_id,
    signal: row.signal,
    source: row.source,
    weight: Number(row.weight),
    occurredAt: row.occurred_at,
    recordedBy: row.recorded_by || null,
    payload: (() => { try { return JSON.parse(row.payload_json); } catch { return {}; } })()
  };
}

export async function listVisitSignals(env, intakeId) {
  if (!hasDatabase(env)) return [];
  const result = await env.DB.prepare(
    "SELECT * FROM visit_signals WHERE intake_id = ? ORDER BY datetime(occurred_at), rowid"
  ).bind(intakeId).all();
  return result.results.map(signalFromRow);
}

/**
 * Record one observation about a visit and re-derive its state.
 *
 * Signals are appended, never edited: the interesting artefact in a fee
 * dispute is the sequence of who said what and when, and an UPDATE destroys
 * exactly that.
 */
export async function recordVisitSignal(env, {
  intakeId, signal, source = null, occurredAt = null, payload = {}, actorId = null, tenantId = null
} = {}) {
  if (!hasDatabase(env)) return { ok: false, status: 503, code: "DATABASE_REQUIRED", message: "D1 is required." };
  const definition = SIGNAL_DEFINITIONS[signal];
  if (!definition) return { ok: false, status: 422, code: "UNKNOWN_SIGNAL", message: `Unknown visit signal "${signal}".` };

  await env.DB.prepare(`
    INSERT INTO visit_signals (id, intake_id, signal, source, weight, occurred_at, recorded_by, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    newId("vsig"), intakeId, signal, source || definition.source, definition.weight,
    occurredAt || new Date().toISOString(), actorId, JSON.stringify(payload || {})
  ).run();

  const evaluation = evaluateVisitSignals(await listVisitSignals(env, intakeId));
  await env.DB.prepare(`
    INSERT INTO visit_verifications (intake_id, tenant_id, state, corroboration, completed_at, entered_state_at, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(intake_id) DO UPDATE SET
      tenant_id = COALESCE(excluded.tenant_id, visit_verifications.tenant_id),
      state = excluded.state,
      corroboration = excluded.corroboration,
      completed_at = COALESCE(visit_verifications.completed_at, excluded.completed_at),
      entered_state_at = CASE WHEN visit_verifications.state = excluded.state
                              THEN visit_verifications.entered_state_at ELSE CURRENT_TIMESTAMP END,
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    intakeId, tenantId, evaluation.state, evaluation.weight,
    evaluation.state === "COMPLETED" ? (occurredAt || new Date().toISOString()) : null
  ).run();

  return { ok: true, ...evaluation };
}

/** The visit's current position, and the evidence behind it. */
export async function visitVerification(env, intakeId) {
  if (!hasDatabase(env)) return null;
  const row = await env.DB.prepare("SELECT * FROM visit_verifications WHERE intake_id = ? LIMIT 1").bind(intakeId).first();
  const signals = await listVisitSignals(env, intakeId);
  const evaluation = evaluateVisitSignals(signals);
  return {
    intakeId,
    state: row?.state || evaluation.state,
    completedAt: row?.completed_at || null,
    signals,
    ...evaluation
  };
}

/* ═════════════════════════════════════════════════ fees and receivables ═══ */

/**
 * Refuse any journal that would settle clinic debt against restricted money.
 *
 * The temptation is real and quiet: a clinic owes $75, the fund holds $4,000
 * in the same Stripe balance, and netting them makes a reconciliation tidy.
 * It also spends contributions given for sponsored access on an unpaid
 * invoice. This runs on every posting from this module rather than living in
 * a comment, because "never do X" enforced by memory is a thing that happens
 * on a Friday.
 */
export function assertNoRestrictedOffset(lines) {
  const accounts = (lines || []).map((line) => line.account);
  const restricted = accounts.filter((account) => RESTRICTED_ACCOUNTS.has(account));
  if (restricted.length) {
    throw new Error(
      `Clinic billing may not post to restricted account(s) ${restricted.join(", ")}: `
      + "clinic debt is never netted against Paw It Forward money."
    );
  }
  return true;
}

async function postClinicJournal(env, entry) {
  assertNoRestrictedOffset(entry.lines);
  return postTransaction(env, entry);
}

/**
 * Whether this visit is sponsored by the fund.
 *
 * The fund module owns the sponsorship record; this only needs to know not to
 * bill. An explicit boolean wins; otherwise it asks the fund's tables and
 * treats their absence as "not sponsored" rather than failing the billing
 * path on a module that may not be deployed yet.
 */
export async function isSponsoredVisit(env, intakeId, explicit) {
  if (typeof explicit === "boolean") return explicit;
  if (!hasDatabase(env) || !intakeId) return false;
  try {
    // Live states only: a reservation that was released or reversed means the
    // sponsorship did not happen, and the clinic's ordinary fee applies.
    const row = await env.DB.prepare(`
      SELECT 1 AS sponsored FROM fund_reservations
      WHERE intake_id = ? AND state IN ('RESERVED', 'COMPLETED_CONSUMED') LIMIT 1
    `).bind(intakeId).first();
    return Boolean(row);
  } catch {
    return false;
  }
}

/**
 * What this completed visit costs each side.
 *
 * A sponsored visit is $0 owner and $0 clinic — both, always. The clinic's
 * deposit and the veterinary bill are untouched by any of this; they were
 * never Tími's money.
 */
export async function visitFeeQuote(env, { tenantId, isSponsored = false } = {}) {
  const policy = await activePricingPolicy(env);
  const clinic = await clinicFeeFor(env, tenantId, policy);
  if (isSponsored) {
    return {
      pricingPolicyId: policy.id,
      pricingVersion: policy.version,
      currency: policy.currency,
      ownerFeeCents: 0,
      ownerFeeReason: "SPONSORED_VISIT",
      clinicFeeCents: 0,
      clinicPlan: clinic.plan,
      clinicFeeReason: "SPONSORED_VISIT",
      sponsored: true
    };
  }
  return {
    pricingPolicyId: policy.id,
    pricingVersion: policy.version,
    currency: policy.currency,
    ownerFeeCents: policy.ownerFeeCents,
    ownerFeeReason: "STANDARD_RATE",
    clinicFeeCents: clinic.feeCents,
    clinicPlan: clinic.plan,
    clinicFeeReason: clinic.reason,
    sponsored: false
  };
}

function receivableFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    intakeId: row.intake_id,
    tenantId: row.tenant_id,
    amountCents: Number(row.amount_cents),
    currency: row.currency,
    feePolicyId: row.fee_policy_id,
    feePolicyVersion: Number(row.fee_policy_version),
    plan: row.plan,
    reason: row.reason,
    state: row.state,
    completedAt: row.completed_at,
    invoiceId: row.invoice_id || null,
    attempts: Number(row.attempts || 0),
    lastError: row.last_error || null
  };
}

export async function getClinicFeeReceivable(env, intakeId) {
  if (!hasDatabase(env)) return null;
  const row = await env.DB.prepare("SELECT * FROM clinic_fee_receivables WHERE intake_id = ? LIMIT 1").bind(intakeId).first();
  return receivableFromRow(row);
}

/**
 * Create the clinic's fee for one visit — at verified completion, and only
 * then.
 *
 * Every completed visit produces a row. A founding clinic's is $0 with reason
 * FOUNDING_CLINIC_RATE and a sponsored visit's is $0 with SPONSORED_VISIT:
 * written explicitly, in state WAIVED, so the waiver is visible in the audit
 * trail instead of being an absence somebody has to interpret.
 *
 * No journal is posted for a $0 fee. A zero-value transaction is refused by
 * postTransaction by design — there is no money to record moving, and the
 * receivable row already carries the fact.
 */
export async function recordCompletedVisitFee(env, {
  intakeId, tenantId, isSponsored, actorId = null, occurredAt = null, requestId = null, skipVerification = false
} = {}) {
  if (!hasDatabase(env)) return { ok: false, status: 503, code: "DATABASE_REQUIRED", message: "D1 is required." };
  if (!intakeId || !tenantId) return { ok: false, status: 422, code: "INTAKE_AND_TENANT_REQUIRED", message: "intakeId and tenantId are required." };

  const existing = await getClinicFeeReceivable(env, intakeId);
  if (existing) return { ok: true, duplicate: true, receivable: existing };

  if (!skipVerification) {
    const verification = await visitVerification(env, intakeId);
    if (!verification || verification.state !== "COMPLETED") {
      return {
        ok: false, status: 409, code: "VISIT_NOT_VERIFIED",
        message: "A clinic fee is created only at verified completion.",
        state: verification?.state || "MATCHED",
        reasons: verification?.reasons || []
      };
    }
  }

  const sponsored = await isSponsoredVisit(env, intakeId, isSponsored);
  const quote = await visitFeeQuote(env, { tenantId, isSponsored: sponsored });
  const completedAt = occurredAt || new Date().toISOString();
  const id = newId("cfr");
  const state = quote.clinicFeeCents === 0 ? "WAIVED" : "DUE";

  await env.DB.prepare(`
    INSERT INTO clinic_fee_receivables (
      id, intake_id, tenant_id, amount_cents, currency, fee_policy_id, fee_policy_version,
      plan, reason, state, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, intakeId, tenantId, quote.clinicFeeCents, quote.currency, quote.pricingPolicyId,
    quote.pricingVersion, quote.clinicPlan, quote.clinicFeeReason, state, completedAt
  ).run();

  let transactionId = null;
  if (quote.clinicFeeCents > 0) {
    const posted = await postClinicJournal(env, {
      kind: "clinic_fee_earned",
      idempotencyKey: `clinic_fee_earned:${intakeId}`,
      intakeId,
      tenantId,
      currency: quote.currency,
      occurredAt: completedAt,
      memo: `Clinic platform fee, ${quote.clinicFeeReason}`,
      createdBy: actorId,
      lines: [
        { account: "clinic_fee_receivable", debit: quote.clinicFeeCents },
        { account: "clinic_platform_fee_revenue", credit: quote.clinicFeeCents }
      ]
    });
    transactionId = posted.transactionId;
  }

  await recordAudit(env, {
    actorId, actorRole: "system", action: "clinic_fee.recorded",
    subjectType: "intake_request", subjectId: intakeId,
    newState: { tenantId, amountCents: quote.clinicFeeCents, plan: quote.clinicPlan, reason: quote.clinicFeeReason, state },
    reason: quote.clinicFeeReason, requestId
  });

  return {
    ok: true,
    receivable: await getClinicFeeReceivable(env, intakeId),
    quote,
    transactionId,
    /** True when a row was written for a fee of nothing — which is the point. */
    waived: quote.clinicFeeCents === 0
  };
}

/** Reverse a fee after a successful clinic dispute. Prospective bookkeeping. */
export async function voidClinicFee(env, { intakeId, reason, actorId = null }) {
  if (!hasDatabase(env)) return { ok: false, status: 503, code: "DATABASE_REQUIRED", message: "D1 is required." };
  if (!reason) return { ok: false, status: 422, code: "REASON_REQUIRED", message: "Voiding a fee requires a reason." };
  const receivable = await getClinicFeeReceivable(env, intakeId);
  if (!receivable) return { ok: false, status: 404, code: "RECEIVABLE_NOT_FOUND", message: "No clinic fee for that visit." };
  if (receivable.state === "PAID") return { ok: false, status: 409, code: "ALREADY_PAID", message: "Refund a paid fee rather than voiding it." };
  if (receivable.state === "WAIVED") return { ok: true, duplicate: true, receivable };

  await env.DB.prepare(
    "UPDATE clinic_fee_receivables SET state = 'VOID', void_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).bind(reason, receivable.id).run();

  await postClinicJournal(env, {
    kind: "adjustment",
    idempotencyKey: `clinic_fee_void:${intakeId}`,
    intakeId,
    tenantId: receivable.tenantId,
    currency: receivable.currency,
    memo: `Clinic fee voided: ${reason}`,
    createdBy: actorId,
    lines: [
      { account: "clinic_platform_fee_revenue", debit: receivable.amountCents },
      { account: "clinic_fee_receivable", credit: receivable.amountCents }
    ]
  });

  await recordAudit(env, {
    actorId, actorRole: "platform", action: "clinic_fee.voided",
    subjectType: "intake_request", subjectId: intakeId,
    oldState: { state: receivable.state }, newState: { state: "VOID" }, reason
  });
  return { ok: true, receivable: await getClinicFeeReceivable(env, intakeId) };
}

/* ═════════════════════════════════════════════════════════════ invoices ═══ */

function invoiceFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    totalCents: Number(row.total_cents),
    lineCount: Number(row.line_count),
    currency: row.currency,
    stripeInvoiceId: row.stripe_invoice_id || null,
    status: row.status,
    sentAt: row.sent_at || null,
    paidAt: row.paid_at || null,
    attempts: Number(row.attempts || 0),
    lastError: row.last_error || null
  };
}

export async function getClinicInvoice(env, invoiceId) {
  if (!hasDatabase(env)) return null;
  const row = await env.DB.prepare("SELECT * FROM clinic_invoices WHERE id = ? LIMIT 1").bind(invoiceId).first();
  return invoiceFromRow(row);
}

/** The receivables an invoice for this period would contain. */
export async function invoiceableReceivables(env, { tenantId, periodStart, periodEnd }) {
  if (!hasDatabase(env)) return [];
  const result = await env.DB.prepare(`
    SELECT * FROM clinic_fee_receivables
    WHERE tenant_id = ?
      AND invoice_id IS NULL
      AND amount_cents > 0
      AND state IN ('DUE', 'RETRYING', 'PAST_DUE')
      AND datetime(completed_at) >= datetime(?)
      AND datetime(completed_at) < datetime(?)
    ORDER BY datetime(completed_at)
  `).bind(tenantId, periodStart, periodEnd).all();
  return result.results.map(receivableFromRow);
}

/**
 * Aggregate a month's completed visits into one statement.
 *
 * Monthly by default, as the spec recommends: one invoice costs less in
 * processor fees than a charge per visit and gives a practice manager one
 * thing to reconcile. Waived and voided rows are excluded — a $0 line on an
 * invoice invites a phone call about a bill that does not exist — but they
 * remain in `clinic_fee_receivables`, which is where the waiver is proved.
 */
export async function buildMonthlyInvoice(env, { tenantId, periodStart, periodEnd, actorId = null } = {}) {
  if (!hasDatabase(env)) return { ok: false, status: 503, code: "DATABASE_REQUIRED", message: "D1 is required." };
  if (!tenantId || !periodStart || !periodEnd) {
    return { ok: false, status: 422, code: "PERIOD_REQUIRED", message: "tenantId, periodStart and periodEnd are required." };
  }
  const existing = await env.DB.prepare(
    "SELECT * FROM clinic_invoices WHERE tenant_id = ? AND period_start = ? AND period_end = ? LIMIT 1"
  ).bind(tenantId, periodStart, periodEnd).first();
  if (existing) return { ok: true, duplicate: true, invoice: invoiceFromRow(existing) };

  const lines = await invoiceableReceivables(env, { tenantId, periodStart, periodEnd });
  if (!lines.length) return { ok: true, empty: true, invoice: null, lines: [] };

  const total = lines.reduce((sum, line) => sum + line.amountCents, 0);
  const invoiceId = newId("cinv");
  await env.DB.prepare(`
    INSERT INTO clinic_invoices (id, tenant_id, period_start, period_end, total_cents, line_count, currency, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?)
  `).bind(invoiceId, tenantId, periodStart, periodEnd, total, lines.length, lines[0].currency, actorId).run();

  await env.DB.batch(lines.map((line) => env.DB.prepare(
    "UPDATE clinic_fee_receivables SET invoice_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND invoice_id IS NULL"
  ).bind(invoiceId, line.id)));

  await recordAudit(env, {
    actorId, actorRole: "platform", action: "clinic_invoice.built",
    subjectType: "clinic_invoice", subjectId: invoiceId,
    newState: { tenantId, periodStart, periodEnd, totalCents: total, lineCount: lines.length }
  });

  return { ok: true, invoice: await getClinicInvoice(env, invoiceId), lines };
}

/** Mark an invoice sent, recording the Stripe invoice it became. */
export async function markInvoiceSent(env, { invoiceId, stripeInvoiceId = null, actorId = null }) {
  if (!hasDatabase(env)) return { ok: false, status: 503, code: "DATABASE_REQUIRED", message: "D1 is required." };
  await env.DB.prepare(`
    UPDATE clinic_invoices SET status = 'OPEN', stripe_invoice_id = COALESCE(?, stripe_invoice_id),
      sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status IN ('DRAFT', 'OPEN')
  `).bind(stripeInvoiceId, invoiceId).run();
  await recordAudit(env, {
    actorId, actorRole: "platform", action: "clinic_invoice.sent",
    subjectType: "clinic_invoice", subjectId: invoiceId, newState: { stripeInvoiceId }
  });
  return { ok: true, invoice: await getClinicInvoice(env, invoiceId) };
}

/**
 * An invoice paid.
 *
 * Cash arrives and the receivable is relieved: Dr processor_cash, Cr
 * clinic_fee_receivable. Note which accounts are *not* here — nothing
 * restricted, in either direction.
 */
export async function markInvoicePaid(env, { invoiceId, paidAt = null, stripeEventId = null, actorId = null }) {
  if (!hasDatabase(env)) return { ok: false, status: 503, code: "DATABASE_REQUIRED", message: "D1 is required." };
  const invoice = await getClinicInvoice(env, invoiceId);
  if (!invoice) return { ok: false, status: 404, code: "INVOICE_NOT_FOUND", message: "That invoice was not found." };
  if (invoice.status === "PAID") return { ok: true, duplicate: true, invoice };

  await env.DB.prepare(`
    UPDATE clinic_invoices SET status = 'PAID', paid_at = ?, last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).bind(paidAt || new Date().toISOString(), invoiceId).run();
  await env.DB.prepare(`
    UPDATE clinic_fee_receivables SET state = 'PAID', last_error = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE invoice_id = ? AND state <> 'VOID'
  `).bind(invoiceId).run();

  const posted = await postClinicJournal(env, {
    kind: "clinic_fee_collected",
    idempotencyKey: `clinic_invoice_paid:${invoiceId}`,
    tenantId: invoice.tenantId,
    currency: invoice.currency,
    occurredAt: paidAt || new Date().toISOString(),
    stripeEventId,
    memo: `Clinic invoice ${invoiceId} paid`,
    createdBy: actorId,
    lines: [
      { account: "processor_cash", debit: invoice.totalCents },
      { account: "clinic_fee_receivable", credit: invoice.totalCents }
    ]
  });

  await recordAudit(env, {
    actorId, actorRole: "system", action: "clinic_invoice.paid",
    subjectType: "clinic_invoice", subjectId: invoiceId, newState: { totalCents: invoice.totalCents }
  });
  return { ok: true, invoice: await getClinicInvoice(env, invoiceId), transactionId: posted.transactionId };
}

/** How many failures before the ladder's next rung. Configurable. */
export function collectionPolicy(env) {
  const number = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
  };
  return {
    retryAttempts: number(env?.CLINIC_FEE_RETRY_ATTEMPTS, 3),
    pastDueGraceDays: number(env?.CLINIC_FEE_PAST_DUE_DAYS, 14),
    restrictAfterDays: number(env?.CLINIC_FEE_RESTRICT_DAYS, 30)
  };
}

/** The next rung of DUE → RETRYING → PAST_DUE → RESTRICTED. */
export function nextFailureState(state, attempts, policy) {
  if (state === "DUE") return "RETRYING";
  if (state === "RETRYING") return attempts + 1 >= policy.retryAttempts ? "PAST_DUE" : "RETRYING";
  if (state === "PAST_DUE") return "PAST_DUE";
  return state;
}

/**
 * A failed collection attempt.
 *
 * Escalation is deliberately slow and always reversible by payment. The end
 * of the ladder stops *new* availability acceptances; it never cancels a
 * booking already made, because a patient in a car is not a collections
 * lever.
 */
export async function recordInvoiceFailure(env, { invoiceId, error = null, actorId = null }) {
  if (!hasDatabase(env)) return { ok: false, status: 503, code: "DATABASE_REQUIRED", message: "D1 is required." };
  const invoice = await getClinicInvoice(env, invoiceId);
  if (!invoice) return { ok: false, status: 404, code: "INVOICE_NOT_FOUND", message: "That invoice was not found." };
  const policy = collectionPolicy(env);

  const result = await env.DB.prepare("SELECT * FROM clinic_fee_receivables WHERE invoice_id = ? AND state NOT IN ('PAID', 'VOID', 'WAIVED')").bind(invoiceId).all();
  const statements = result.results.map((row) => {
    const next = nextFailureState(row.state, Number(row.attempts || 0), policy);
    return env.DB.prepare(
      "UPDATE clinic_fee_receivables SET state = ?, attempts = attempts + 1, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).bind(next, error, row.id);
  });
  statements.push(env.DB.prepare(
    "UPDATE clinic_invoices SET status = 'PAST_DUE', attempts = attempts + 1, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).bind(error, invoiceId));
  await env.DB.batch(statements);

  await recordAudit(env, {
    actorId, actorRole: "system", action: "clinic_invoice.failed",
    subjectType: "clinic_invoice", subjectId: invoiceId, newState: { attempts: invoice.attempts + 1 }, reason: error
  });
  return { ok: true, invoice: await getClinicInvoice(env, invoiceId) };
}

/**
 * Move long-overdue receivables to RESTRICTED.
 *
 * Time-based rather than attempt-based at this rung: the question is no
 * longer "did the card fail" but "has this been unresolved for a month".
 */
export async function escalateOverdueReceivables(env, { now = new Date(), actorId = null } = {}) {
  if (!hasDatabase(env)) return { restricted: 0 };
  const policy = collectionPolicy(env);
  const cutoff = new Date(now.getTime() - policy.restrictAfterDays * 86_400_000).toISOString();
  const result = await env.DB.prepare(`
    UPDATE clinic_fee_receivables SET state = 'RESTRICTED', updated_at = CURRENT_TIMESTAMP
    WHERE state = 'PAST_DUE' AND datetime(completed_at) < datetime(?)
  `).bind(cutoff).run();
  const changed = Number(result?.meta?.changes || 0);
  if (changed) {
    await recordAudit(env, {
      actorId, actorRole: "system", action: "clinic_fee.restricted",
      subjectType: "clinic_fee_receivable", subjectId: null, newState: { count: changed },
      reason: `Unpaid beyond ${policy.restrictAfterDays} days`
    });
  }
  return { restricted: changed };
}

/**
 * Whether this clinic may still accept new availability requests.
 *
 * Restriction is the last rung and applies only to accepting new work.
 */
export async function clinicBillingRestricted(env, tenantId) {
  if (!hasDatabase(env) || !tenantId) return { restricted: false, outstandingCents: 0, restrictedCount: 0 };
  const row = await env.DB.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN state IN ('DUE', 'RETRYING', 'PAST_DUE', 'RESTRICTED') THEN amount_cents ELSE 0 END), 0) AS outstanding,
      SUM(CASE WHEN state = 'RESTRICTED' THEN 1 ELSE 0 END) AS restricted_count
    FROM clinic_fee_receivables WHERE tenant_id = ?
  `).bind(tenantId).first();
  const restrictedCount = Number(row?.restricted_count || 0);
  return {
    restricted: restrictedCount > 0,
    restrictedCount,
    outstandingCents: Number(row?.outstanding || 0)
  };
}

/** One clinic's billing picture, for the tenant console's statement page. */
export async function clinicBillingSummary(env, tenantId) {
  if (!hasDatabase(env)) return { tenantId, receivables: [], invoices: [], outstandingCents: 0, restricted: false };
  const receivables = await env.DB.prepare(`
    SELECT * FROM clinic_fee_receivables WHERE tenant_id = ?
    ORDER BY datetime(completed_at) DESC LIMIT 200
  `).bind(tenantId).all();
  const invoices = await env.DB.prepare(`
    SELECT * FROM clinic_invoices WHERE tenant_id = ? ORDER BY datetime(period_start) DESC LIMIT 24
  `).bind(tenantId).all();
  const standing = await clinicBillingRestricted(env, tenantId);
  return {
    tenantId,
    receivables: receivables.results.map(receivableFromRow),
    invoices: invoices.results.map(invoiceFromRow),
    ...standing
  };
}

/* ═══════════════════════════════════════════════════════════ handlers ═══ */

/**
 * POST /api/clinic-applications — public, rate limited.
 *
 * Mount without authentication; everything below it expects a platform
 * operator and the router is responsible for proving that before calling.
 */
export async function handleClinicApplicationSubmit(request, env) {
  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    const code = error.message === "PAYLOAD_TOO_LARGE" ? "PAYLOAD_TOO_LARGE" : "JSON_REQUIRED";
    return apiError(code === "PAYLOAD_TOO_LARGE" ? 413 : 400, code, "A valid JSON request body is required.");
  }
  const submitterHash = await submitterHashFor(request, env);
  const result = await submitClinicApplication(env, { body, submitterHash });
  if (!result.ok) return apiError(result.status, result.code, result.message, result.details);
  return json({ application: result.application }, { status: 201 });
}

/** GET /api/admin/clinic-applications?status=SUBMITTED */
export async function handleClinicApplicationList(request, env) {
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  if (status && !APPLICATION_STATUSES.includes(status)) {
    return apiError(422, "INVALID_STATUS", `Status must be one of ${APPLICATION_STATUSES.join(", ")}.`);
  }
  return json({ applications: await listClinicApplications(env, { status, limit: url.searchParams.get("limit") }) });
}

/**
 * POST /api/admin/clinic-applications/:id — `{ action, ... }` where action is
 * review | approve | decline | withdraw.
 */
export async function handleClinicApplicationDecision(request, env, actor, applicationId) {
  let body;
  try {
    body = await readJson(request);
  } catch {
    return apiError(400, "JSON_REQUIRED", "A valid JSON request body is required.");
  }
  const actorId = actor?.userId || actor?.id || null;
  const action = text(body?.action, 20).toLowerCase();
  let result;
  if (action === "review") {
    result = await reviewClinicApplication(env, { applicationId, actorId, note: text(body?.note, 500) || null });
  } else if (action === "approve") {
    result = await approveClinicApplication(env, {
      applicationId,
      actorId,
      plan: text(body?.plan, 20) || "STANDARD",
      customFeeCents: body?.customFeeCents ?? null,
      contractId: text(body?.contractId, 80) || null,
      clerkOrgId: text(body?.clerkOrgId, 80) || null,
      tenantName: text(body?.tenantName, 120) || null,
      location: body?.location || null,
      note: text(body?.note, 500) || null
    });
  } else if (action === "decline") {
    result = await declineClinicApplication(env, { applicationId, actorId, reason: text(body?.reason, 500) });
  } else if (action === "withdraw") {
    result = await withdrawClinicApplication(env, { applicationId, actorId, reason: text(body?.reason, 500) || null });
  } else {
    return apiError(422, "INVALID_ACTION", "Action must be review, approve, decline, or withdraw.");
  }
  if (!result.ok) return apiError(result.status || 400, result.code, result.message, result.details);
  return json(result);
}

/** GET /api/clinic/billing — the tenant's own statement. */
export async function handleClinicBillingSummary(env, tenantId) {
  return json({ billing: await clinicBillingSummary(env, tenantId) });
}
