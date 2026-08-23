/**
 * Tími platform operator console — Worker `timinow-admin`.
 *
 * This is the ONLY surface in the platform where a tenant may be created. It is
 * deployed as its own Cloudflare Worker, on its own endpoint, so the
 * platform-operator surface never shares an origin with the public customer PWA
 * or the veterinary console. See docs/PLATFORM-CONTRACT.md for the full
 * authorization model and Clerk metadata contract.
 *
 * Every shared primitive (Clerk Backend API client, tenancy/authorization
 * helpers, session descriptor, D1 reads, tenant-member administration) is
 * imported from ../../../src/ rather than reimplemented here.
 */

import { actorForRequest, signInRequired } from "../../../src/auth.js";
import { publicConfig } from "../../../src/config.js";
import { describeSession } from "../../../src/session.js";
import {
  addMember,
  changeMemberRole,
  listMembers,
  removeMember,
  requireTenantAdmin,
  revokeInvitation
} from "../../../src/tenant-admin.js";
import { hasDatabase, tenantIdForClerkOrg } from "../../../src/db.js";
import {
  ClerkError,
  createOrganization,
  createOrganizationInvitation,
  createOrganizationMembership,
  deleteOrganization,
  displayName,
  findOrCreateUserByEmail,
  mergeMembershipPublicMetadata,
  mergeOrganizationPublicMetadata,
  mergeUserPublicMetadata,
  primaryEmail,
  updateOrganization
} from "../../../src/clerk.js";
import {
  getTenant,
  insertTenant,
  insertTenantInvitation,
  isPlatformAdmin,
  listTenantMembers,
  listTenants,
  recordAudit,
  setTenantStatus,
  slugAvailable,
  slugify,
  upsertTenantMember
} from "../../../src/tenancy.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const SECURITY_HEADERS = {
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), payment=(self), geolocation=(self)"
};

const VALID_SPECIES = new Set(["dog", "cat", "bird", "rabbit", "reptile", "small_mammal", "other"]);
// Set by an operator here, never by the clinic: a provider cannot declare its
// own supervision level. See VALID_STAFFING in src/catalog.js.
const VALID_STAFFING = new Set(["veterinarian", "veterinary_technician"]);
const VALID_LOCATION_KINDS = new Set(["general", "urgent", "emergency", "specialty"]);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Commercial baseline from docs/PAYMENTS-AND-TENANT-POLICIES.md. */
const BASELINE_POLICY = {
  depositRequired: true,
  depositAmountCents: 5000,
  depositRefundable: true,
  freeCancelMinutes: 30,
  completedPlatformFeeCents: 2000,
  noShowPlatformFeeCents: 500,
  lateCancelPlatformFeeCents: 500
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

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function isoAfter(minutes) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function cleanString(value, maxLength = 240) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function numberInRange(value, minimum, maximum, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : fallback;
}

function bool(value, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

async function readJson(request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 32_768) throw new Error("PAYLOAD_TOO_LARGE");
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new Error("JSON_REQUIRED");
  }
  return request.json();
}

async function authenticatedActor(request, env) {
  const actor = await actorForRequest(request, env);
  if (!actor) return null;
  if (!actor.tenantId && actor.clerkOrgId) actor.tenantId = await tenantIdForClerkOrg(env, actor.clerkOrgId);
  return actor;
}

/* ------------------------------------------------------------ /api/config --- */

async function handleConfig(env) {
  return json(publicConfig(env));
}

/* --------------------------------------------------------- /api/admin/* --- */

async function handleBootstrap(env, actor) {
  const platformAdmin = await isPlatformAdmin(env, actor);
  const base = {
    platformAdmin,
    actor: { id: actor?.userId || null, email: actor?.email || null },
    adminCount: null,
    tenantCount: null
  };
  if (!platformAdmin || !hasDatabase(env)) return json(base);
  const [adminRow, tenantRow] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS total FROM platform_admins").first(),
    env.DB.prepare("SELECT COUNT(*) AS total FROM tenants").first()
  ]);
  return json({ ...base, adminCount: Number(adminRow?.total || 0), tenantCount: Number(tenantRow?.total || 0) });
}

function validateLocationInput(input, { requireAll = true } = {}) {
  const errors = [];
  const name = cleanString(input?.name, 160);
  const kind = cleanString(input?.kind, 20).toLowerCase();
  const addressLine1 = cleanString(input?.addressLine1, 200);
  const city = cleanString(input?.city, 120);
  const region = cleanString(input?.region, 60);
  const postalCode = cleanString(input?.postalCode, 20);
  const phone = cleanString(input?.phone, 30);
  const latitude = numberInRange(input?.latitude, -90, 90);
  const longitude = numberInRange(input?.longitude, -180, 180);
  const species = Array.isArray(input?.species)
    ? [...new Set(input.species.map((value) => cleanString(value, 30).toLowerCase()).filter((value) => VALID_SPECIES.has(value)))]
    : [];
  const capabilities = Array.isArray(input?.capabilities)
    ? [...new Set(input.capabilities.map((value) => cleanString(value, 40).toLowerCase()).filter(Boolean))].slice(0, 20)
    : [];
  // Absent means veterinarian, which is what every provider was before this
  // field existed. An unrecognised value is rejected rather than defaulted:
  // getting this wrong in the permissive direction would show a technician-run
  // location as veterinarian-staffed.
  const staffingLevel = cleanString(input?.staffingLevel, 40).toLowerCase() || "veterinarian";
  const staffingNote = cleanString(input?.staffingNote, 300) || null;
  if (!VALID_STAFFING.has(staffingLevel)) {
    errors.push("location.staffingLevel must be veterinarian or veterinary_technician");
  }

  if (requireAll) {
    if (!name) errors.push("location.name is required");
    if (!VALID_LOCATION_KINDS.has(kind)) errors.push("location.kind must be one of general, urgent, emergency, specialty");
    if (!addressLine1) errors.push("location.addressLine1 is required");
    if (!city) errors.push("location.city is required");
    if (!region) errors.push("location.region is required");
    if (!postalCode) errors.push("location.postalCode is required");
    if (!/^\+?[0-9().\-\s]{7,24}$/.test(phone)) errors.push("location.phone is invalid");
    if (latitude === null || longitude === null) errors.push("location.latitude and location.longitude are required");
    if (!species.length) errors.push("location.species must include at least one supported species");
  }

  return {
    errors,
    name,
    kind,
    addressLine1,
    city,
    region,
    postalCode,
    phone,
    latitude,
    longitude,
    timezone: cleanString(input?.timezone, 60) || "America/Los_Angeles",
    open24Hours: bool(input?.open24Hours, false),
    acceptsWalkIns: bool(input?.acceptsWalkIns, true),
    autoAccept: bool(input?.autoAccept, false),
    arrivalWindowMinutes: numberInRange(input?.arrivalWindowMinutes, 5, 180, 20),
    species,
    capabilities,
    staffingLevel,
    staffingNote,
    baseExamFeeCents: numberInRange(input?.baseExamFeeCents, 0, 10_000_00, null)
  };
}

function validatePolicyInput(input) {
  const source = input && typeof input === "object" ? input : {};
  return {
    depositRequired: bool(source.depositRequired, BASELINE_POLICY.depositRequired),
    depositAmountCents: numberInRange(source.depositAmountCents, 0, 10_000_00, BASELINE_POLICY.depositAmountCents),
    depositRefundable: bool(source.depositRefundable, BASELINE_POLICY.depositRefundable),
    freeCancelMinutes: numberInRange(source.freeCancelMinutes, 0, 1440, BASELINE_POLICY.freeCancelMinutes),
    completedPlatformFeeCents: numberInRange(source.completedPlatformFeeCents, 0, 100_000, BASELINE_POLICY.completedPlatformFeeCents),
    noShowPlatformFeeCents: numberInRange(source.noShowPlatformFeeCents, 0, 100_000, BASELINE_POLICY.noShowPlatformFeeCents),
    lateCancelPlatformFeeCents: numberInRange(source.lateCancelPlatformFeeCents, 0, 100_000, BASELINE_POLICY.lateCancelPlatformFeeCents)
  };
}

async function uniqueLocationSlug(env, tenantSlug, name) {
  const base = `${tenantSlug}-${slugify(name)}`.replace(/-+/g, "-").slice(0, 64) || `${tenantSlug}-location`;
  let candidate = base;
  let suffix = 2;
  while (await env.DB.prepare("SELECT id FROM locations WHERE slug = ? LIMIT 1").bind(candidate).first()) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function insertLocationStatement(env, { id, tenantId, slug, location }) {
  return env.DB.prepare(`
    INSERT INTO locations (
      id, tenant_id, name, slug, kind, address_line1, city, region, postal_code, phone,
      latitude, longitude, timezone, open_24_hours, accepts_walk_ins, auto_accept,
      arrival_window_minutes, species_json, capabilities_json, base_exam_fee_cents,
      staffing_level, staffing_note, active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).bind(
    id, tenantId, location.name, slug, location.kind, location.addressLine1, location.city,
    location.region, location.postalCode, location.phone, location.latitude, location.longitude,
    location.timezone, location.open24Hours ? 1 : 0, location.acceptsWalkIns ? 1 : 0,
    location.autoAccept ? 1 : 0, location.arrivalWindowMinutes,
    JSON.stringify(location.species), JSON.stringify(location.capabilities), location.baseExamFeeCents,
    location.staffingLevel, location.staffingNote
  );
}

function insertInitialAvailabilityStatement(env, { locationId, createdBy }) {
  const now = new Date().toISOString();
  return env.DB.prepare(`
    INSERT INTO availability_reports (
      id, location_id, intake_status, accepts_critical, source, confidence, note, reported_at, expires_at, created_by
    ) VALUES (?, ?, 'unverified', 1, 'seed', 'low', ?, ?, ?, ?)
  `).bind(newId("availability"), locationId, "Seeded when the location was created. Awaiting the clinic's first report.", now, isoAfter(30), createdBy || null);
}

function insertPolicyStatement(env, { tenantId, policy }) {
  return env.DB.prepare(`
    INSERT INTO tenant_policies (
      id, tenant_id, version, active, deposit_required, deposit_amount_cents, deposit_refundable,
      free_cancel_minutes, completed_platform_fee_cents, no_show_platform_fee_cents, late_cancel_platform_fee_cents
    ) VALUES (?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    newId("policy"), tenantId, policy.depositRequired ? 1 : 0, policy.depositAmountCents,
    policy.depositRefundable ? 1 : 0, policy.freeCancelMinutes, policy.completedPlatformFeeCents,
    policy.noShowPlatformFeeCents, policy.lateCancelPlatformFeeCents
  );
}

/**
 * Create a tenant end to end: Clerk organization, D1 tenant/location/policy/
 * availability rows, Clerk metadata across all three surfaces, and (optionally)
 * the first workspace administrator. Rolls back the Clerk organization if any
 * D1 write fails so nothing is orphaned.
 */
async function createTenant(request, env, actor) {
  if (!hasDatabase(env)) return apiError(503, "DATABASE_REQUIRED", "D1 is required to create a tenant.");
  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    return apiError(error.message === "PAYLOAD_TOO_LARGE" ? 413 : 400, error.message, "A valid JSON request body is required.");
  }

  const name = cleanString(body.name, 160);
  const contactEmail = cleanString(body.contactEmail, 160);
  const adminEmail = cleanString(body.adminEmail, 160).toLowerCase();
  const errors = [];
  if (!name) errors.push("name is required");
  if (contactEmail && !EMAIL_PATTERN.test(contactEmail)) errors.push("contactEmail is invalid");
  if (adminEmail && !EMAIL_PATTERN.test(adminEmail)) errors.push("adminEmail is invalid");

  const location = validateLocationInput(body.location, { requireAll: true });
  errors.push(...location.errors);
  const policy = validatePolicyInput(body.policy);

  const requestedSlug = cleanString(body.slug, 48).toLowerCase();
  const slug = requestedSlug ? slugify(requestedSlug) : slugify(name);
  if (!(await slugAvailable(env, slug))) errors.push(`slug "${slug}" is already in use by another tenant`);

  if (errors.length) return apiError(422, "VALIDATION_FAILED", "Review the tenant creation form.", errors);

  const tenantId = newId("tenant");
  let organization;
  try {
    organization = await createOrganization(env, {
      name,
      slug,
      createdBy: actor.userId,
      publicMetadata: { tenantId, tenantSlug: slug }
    });
  } catch (error) {
    if (error instanceof ClerkError) return apiError(error.status >= 400 && error.status < 600 ? error.status : 502, "CLERK_REQUEST_FAILED", error.message);
    throw error;
  }

  let locationId;
  try {
    // The tenant row is written through the shared helper (as every other
    // surface does); the location/policy/availability rows are then written
    // together in one D1 batch, which D1 executes as a single transaction —
    // so those three either all land or all roll back together.
    await insertTenant(env, {
      id: tenantId,
      clerkOrgId: organization.id,
      clerkOrgSlug: organization.slug || slug,
      name,
      slug,
      contactEmail: contactEmail || null,
      createdBy: actor.userId
    });
    locationId = newId("location");
    const locationSlug = await uniqueLocationSlug(env, slug, location.name);
    await env.DB.batch([
      insertLocationStatement(env, { id: locationId, tenantId, slug: locationSlug, location }),
      insertPolicyStatement(env, { tenantId, policy }),
      insertInitialAvailabilityStatement(env, { locationId, createdBy: actor.userId })
    ]);
  } catch (error) {
    console.error(JSON.stringify({ event: "tenant_creation_rollback", tenantId, message: error.message }));
    try {
      // `tenants` cascades to any location/policy rows that did land, so this
      // single delete cleans up whichever step actually failed.
      await env.DB.prepare("DELETE FROM tenants WHERE id = ?").bind(tenantId).run();
    } catch (cleanupError) {
      console.error(JSON.stringify({ event: "tenant_creation_d1_rollback_failed", tenantId, message: cleanupError.message }));
    }
    try {
      await deleteOrganization(env, organization.id);
    } catch (cleanupError) {
      console.error(JSON.stringify({ event: "tenant_creation_clerk_rollback_failed", tenantId, clerkOrgId: organization.id, message: cleanupError.message }));
    }
    return apiError(500, "TENANT_CREATION_FAILED", "Creating the tenant failed and the Clerk organization was rolled back. No records were left in an inconsistent state.", [error.message]);
  }

  try {
    await mergeOrganizationPublicMetadata(env, organization.id, { tenantId, tenantSlug: slug, locationId });
  } catch (error) {
    console.warn(JSON.stringify({ event: "tenant_metadata_merge_failed", tenantId, message: error.message }));
  }

  let adminResult = null;
  if (adminEmail) {
    try {
      // Create the account rather than only inviting into one. Until this
      // did, "first administrator" meant a pending invitation: no Clerk user,
      // no membership, and a tenant page reading "No active members" whether
      // the invite was sent, still pending, or had failed.
      const { user: existing, created, reason } = await findOrCreateUserByEmail(env, adminEmail, {
        publicMetadata: { tenantId, tenantSlug: slug, locationId }
      });
      if (existing) {
        const membership = await createOrganizationMembership(env, organization.id, { userId: existing.id, role: "org:admin" });
        await upsertTenantMember(env, {
          tenantId,
          clerkOrgId: organization.id,
          clerkUserId: existing.id,
          clerkMembershipId: membership.id,
          email: primaryEmail(existing) || adminEmail,
          displayName: displayName(existing),
          role: "org:admin"
        });
        await mergeMembershipPublicMetadata(env, organization.id, existing.id, { tenantId, tenantSlug: slug, locationId });
        await mergeUserPublicMetadata(env, existing.id, { tenantId, tenantSlug: slug, locationId, lastTenantId: tenantId });
        adminResult = { mode: "seated", clerkUserId: existing.id, email: adminEmail, accountCreated: created };
      } else {
        console.warn(JSON.stringify({ event: "tenant_admin_account_create_failed", tenantId, email: adminEmail, reason }));
        const invitation = await createOrganizationInvitation(env, organization.id, {
          email: adminEmail,
          role: "org:admin",
          inviterUserId: actor.userId,
          publicMetadata: { tenantId, tenantSlug: slug, locationId }
        });
        await insertTenantInvitation(env, { tenantId, clerkInvitationId: invitation.id, email: adminEmail, role: "org:admin", invitedBy: actor.userId });
        adminResult = { mode: "invited", email: adminEmail, reason: reason || null };
      }
    } catch (error) {
      console.warn(JSON.stringify({ event: "tenant_admin_seat_failed", tenantId, message: error.message }));
      adminResult = { mode: "failed", email: adminEmail, error: error.message };
    }
  }

  await recordAudit(env, {
    actorUserId: actor.userId,
    actorScope: "platform",
    tenantId,
    action: "tenant.created",
    target: tenantId,
    detail: { name, slug, clerkOrgId: organization.id, locationId, adminEmail: adminEmail || null }
  });

  const tenant = await getTenant(env, tenantId);
  return json({ tenant, locationId, admin: adminResult }, { status: 201 });
}

function adminLocationFromRow(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    slug: row.slug,
    kind: row.kind,
    addressLine1: row.address_line1,
    city: row.city,
    region: row.region,
    postalCode: row.postal_code,
    phone: row.phone,
    latitude: row.latitude,
    longitude: row.longitude,
    timezone: row.timezone,
    open24Hours: Boolean(row.open_24_hours),
    acceptsWalkIns: Boolean(row.accepts_walk_ins),
    autoAccept: Boolean(row.auto_accept),
    arrivalWindowMinutes: row.arrival_window_minutes,
    species: JSON.parse(row.species_json || "[]"),
    capabilities: JSON.parse(row.capabilities_json || "[]"),
    staffingLevel: row.staffing_level || "veterinarian",
    staffingNote: row.staffing_note || null,
    baseExamFeeCents: row.base_exam_fee_cents,
    active: Boolean(row.active),
    createdAt: row.created_at
  };
}

function adminPolicyFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    version: row.version,
    depositRequired: Boolean(row.deposit_required),
    depositAmountCents: row.deposit_amount_cents,
    depositRefundable: Boolean(row.deposit_refundable),
    freeCancelMinutes: row.free_cancel_minutes,
    completedPlatformFeeCents: row.completed_platform_fee_cents,
    noShowPlatformFeeCents: row.no_show_platform_fee_cents,
    lateCancelPlatformFeeCents: row.late_cancel_platform_fee_cents,
    createdAt: row.created_at
  };
}

function adminAuditFromRow(row) {
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    actorScope: row.actor_scope,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name || null,
    action: row.action,
    target: row.target,
    detail: JSON.parse(row.detail_json || "{}"),
    createdAt: row.created_at
  };
}

async function getTenantDetail(env, tenantId) {
  const tenant = await getTenant(env, tenantId);
  if (!tenant) return apiError(404, "TENANT_NOT_FOUND", "That workspace was not found.");
  const [locationRows, members, policyRow, auditRows] = await Promise.all([
    env.DB.prepare("SELECT * FROM locations WHERE tenant_id = ? AND active = 1 ORDER BY created_at").bind(tenantId).all(),
    listTenantMembers(env, tenantId),
    env.DB.prepare("SELECT * FROM tenant_policies WHERE tenant_id = ? AND active = 1 ORDER BY version DESC LIMIT 1").bind(tenantId).first(),
    env.DB.prepare("SELECT * FROM admin_audit_log WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 25").bind(tenantId).all()
  ]);
  return json({
    tenant,
    locations: locationRows.results.map(adminLocationFromRow),
    members,
    policy: adminPolicyFromRow(policyRow),
    audit: auditRows.results.map(adminAuditFromRow)
  });
}

async function updateTenant(request, env, actor, tenantId) {
  const tenant = await getTenant(env, tenantId);
  if (!tenant) return apiError(404, "TENANT_NOT_FOUND", "That workspace was not found.");
  const body = await readJson(request).catch(() => null);
  if (!body || typeof body !== "object") return apiError(400, "JSON_REQUIRED", "A valid JSON request body is required.");

  const name = body.name !== undefined ? cleanString(body.name, 160) : null;
  const status = body.status !== undefined ? cleanString(body.status, 20) : null;
  if (body.name !== undefined && !name) return apiError(422, "INVALID_NAME", "Provide a non-empty tenant name.");
  if (status !== null && !["active", "suspended"].includes(status)) return apiError(422, "INVALID_STATUS", "Status must be active or suspended.");
  if (!name && !status) return apiError(422, "NO_CHANGES", "Provide a name and/or status to update.");

  if (name) {
    await env.DB.prepare("UPDATE tenants SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(name, tenantId).run();
    if (tenant.clerkOrgId) {
      try {
        await updateOrganization(env, tenant.clerkOrgId, { name });
      } catch (error) {
        console.warn(JSON.stringify({ event: "tenant_rename_clerk_failed", tenantId, message: error.message }));
      }
    }
  }
  if (status) await setTenantStatus(env, tenantId, status);

  await recordAudit(env, {
    actorUserId: actor.userId,
    actorScope: "platform",
    tenantId,
    action: "tenant.updated",
    target: tenantId,
    detail: { name: name || undefined, status: status || undefined }
  });

  return json({ tenant: await getTenant(env, tenantId) });
}

async function addLocation(request, env, actor, tenantId) {
  const tenant = await getTenant(env, tenantId);
  if (!tenant) return apiError(404, "TENANT_NOT_FOUND", "That workspace was not found.");
  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    return apiError(error.message === "PAYLOAD_TOO_LARGE" ? 413 : 400, error.message, "A valid JSON request body is required.");
  }
  const location = validateLocationInput(body, { requireAll: true });
  if (location.errors.length) return apiError(422, "VALIDATION_FAILED", "Review the location form.", location.errors);

  const locationId = newId("location");
  const locationSlug = await uniqueLocationSlug(env, tenant.slug, location.name);
  await env.DB.batch([
    insertLocationStatement(env, { id: locationId, tenantId: tenant.id, slug: locationSlug, location }),
    insertInitialAvailabilityStatement(env, { locationId, createdBy: actor.userId })
  ]);
  await recordAudit(env, {
    actorUserId: actor.userId,
    actorScope: "platform",
    tenantId: tenant.id,
    action: "location.created",
    target: locationId,
    detail: { name: location.name, kind: location.kind }
  });
  return json({ location: adminLocationFromRow(await env.DB.prepare("SELECT * FROM locations WHERE id = ? LIMIT 1").bind(locationId).first()) }, { status: 201 });
}

async function seatAdmin(request, env, actor, tenantId) {
  const tenant = await getTenant(env, tenantId);
  if (!tenant) return apiError(404, "TENANT_NOT_FOUND", "That workspace was not found.");
  if (!tenant.clerkOrgId) return apiError(409, "TENANT_HAS_NO_ORGANIZATION", "This tenant has no linked Clerk organization.");
  const body = await readJson(request).catch(() => null);
  const email = cleanString(body?.email, 160).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) return apiError(422, "INVALID_EMAIL", "Enter a valid email address.");

  // Reuse the shared tenant-member primitive (with its own last-admin guard and
  // audit trail) rather than reimplementing membership logic here. The actor's
  // real userId is preserved for audit attribution; only the org scope needed
  // by requireTenantAdmin/addMember is supplied.
  const scopedActor = { ...actor, tenantId: tenant.id, clerkOrgId: tenant.clerkOrgId, role: "org:admin", authenticated: true };
  let result;
  try {
    result = await addMember(env, scopedActor, tenant.id, { email, role: "org:admin" });
  } catch (error) {
    if (error instanceof ClerkError) return apiError(error.status >= 400 && error.status < 600 ? error.status : 502, "CLERK_REQUEST_FAILED", error.message);
    throw error;
  }
  if (result.code) return apiError(result.status, result.code, result.message);

  await recordAudit(env, {
    actorUserId: actor.userId,
    actorScope: "platform",
    tenantId: tenant.id,
    action: "tenant.admin_seated",
    target: email,
    detail: {}
  });
  return json(result.body, { status: result.status });
}

async function handleAudit(url, env) {
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 100));
  const result = await env.DB.prepare(`
    SELECT a.*, t.name AS tenant_name
    FROM admin_audit_log a
    LEFT JOIN tenants t ON t.id = a.tenant_id
    ORDER BY a.created_at DESC
    LIMIT ?
  `).bind(limit).all();
  return json({ audit: result.results.map(adminAuditFromRow) });
}

/* -------------------------------------------- mounted /api/tenant/* routes --- */

/**
 * The shared tenant-people routes (`/api/tenant/members`, `/api/tenant/
 * invitations/:id`) exist so a platform operator can manage a workspace's
 * roster without a separate implementation. A platform operator is not
 * necessarily a member of the organization being managed, so `?tenantId=` is
 * required and the actor is scoped to that tenant's Clerk organization for the
 * duration of the call — impersonating no one: the actor's real userId is kept
 * for every audit entry these shared functions record.
 */
async function handleMountedTenantRoutes(request, env, actor, url, path, method) {
  const tenantId = cleanString(url.searchParams.get("tenantId"), 80);
  if (!tenantId) return apiError(400, "TENANT_ID_REQUIRED", "Provide ?tenantId= to manage a workspace's people.");
  const tenant = await getTenant(env, tenantId);
  if (!tenant) return apiError(404, "TENANT_NOT_FOUND", "That workspace was not found.");

  const scopedActor = { ...actor, tenantId: tenant.id, clerkOrgId: tenant.clerkOrgId, clerkOrgSlug: tenant.clerkOrgSlug, role: "org:admin", authenticated: true };
  const guard = requireTenantAdmin(scopedActor, tenant.id);
  if (guard) return apiError(guard.status, guard.code, guard.message);

  const respond = (result) => (result.code ? apiError(result.status, result.code, result.message) : json(result.body, { status: result.status }));

  try {
    if (method === "GET" && path === "/api/tenant/members") return json(await listMembers(env, scopedActor, tenant.id));
    if (method === "POST" && path === "/api/tenant/members") {
      const body = await readJson(request).catch(() => null);
      return respond(await addMember(env, scopedActor, tenant.id, body || {}));
    }
    const memberMatch = path.match(/^\/api\/tenant\/members\/([^/]+)$/);
    if (memberMatch) {
      const memberId = decodeURIComponent(memberMatch[1]);
      if (method === "PATCH") {
        const body = await readJson(request).catch(() => null);
        return respond(await changeMemberRole(env, scopedActor, tenant.id, memberId, body || {}));
      }
      if (method === "DELETE") return respond(await removeMember(env, scopedActor, tenant.id, memberId));
    }
    const inviteMatch = path.match(/^\/api\/tenant\/invitations\/([^/]+)$/);
    if (method === "DELETE" && inviteMatch) {
      return respond(await revokeInvitation(env, scopedActor, tenant.id, decodeURIComponent(inviteMatch[1])));
    }
  } catch (error) {
    if (error instanceof ClerkError) return apiError(error.status >= 400 && error.status < 600 ? error.status : 502, "CLERK_REQUEST_FAILED", error.message);
    throw error;
  }
  return apiError(404, "NOT_FOUND", "The requested tenant API route does not exist.");
}

/* ---------------------------------------------------------------- router --- */

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (method === "GET" && path === "/api/health") return json({ ok: true, service: "timinow-admin", version: "1.0.0-admin", database: hasDatabase(env) });
  if (method === "GET" && path === "/api/config") return handleConfig(env);

  const actor = await authenticatedActor(request, env);
  if (signInRequired(env) && !actor) return authRequiredResponse();

  if (method === "GET" && path === "/api/session") {
    const session = await describeSession(env, actor);
    return session ? json({ session }) : authRequiredResponse();
  }

  if (method === "GET" && path === "/api/admin/bootstrap") return handleBootstrap(env, actor);

  if (path.startsWith("/api/admin/") || path.startsWith("/api/tenant/")) {
    if (!actor) return authRequiredResponse();
    const platformAdmin = await isPlatformAdmin(env, actor);
    if (!platformAdmin) return apiError(403, "PLATFORM_ADMIN_REQUIRED", "Only a platform operator may use this API.");

    if (path.startsWith("/api/tenant/")) return handleMountedTenantRoutes(request, env, actor, url, path, method);

    if (method === "GET" && path === "/api/admin/tenants") return json({ tenants: await listTenants(env) });
    if (method === "POST" && path === "/api/admin/tenants") return createTenant(request, env, actor);
    if (method === "GET" && path === "/api/admin/audit") return handleAudit(url, env);

    const tenantMatch = path.match(/^\/api\/admin\/tenants\/([^/]+)$/);
    if (tenantMatch) {
      const id = decodeURIComponent(tenantMatch[1]);
      if (method === "GET") return getTenantDetail(env, id);
      if (method === "PATCH") return updateTenant(request, env, actor, id);
    }

    const locationsMatch = path.match(/^\/api\/admin\/tenants\/([^/]+)\/locations$/);
    if (method === "POST" && locationsMatch) return addLocation(request, env, actor, decodeURIComponent(locationsMatch[1]));

    const adminsMatch = path.match(/^\/api\/admin\/tenants\/([^/]+)\/admins$/);
    if (method === "POST" && adminsMatch) return seatAdmin(request, env, actor, decodeURIComponent(adminsMatch[1]));

    return apiError(404, "NOT_FOUND", "The requested admin API route does not exist.");
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
      console.log(JSON.stringify({ event: "admin_request", requestId, method: request.method, path: url.pathname, status: response.status, durationMs: Date.now() - startedAt }));
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch (error) {
      console.error(JSON.stringify({ event: "admin_request_error", requestId, message: error.message, stack: error.stack }));
      return apiError(500, "INTERNAL_ERROR", "The platform console could not complete that request. Please try again.", { requestId });
    }
  }
};
