/**
 * Tenancy and platform-authorization helpers shared by every Worker.
 *
 * Tenant creation is deliberately asymmetric: only a platform operator may create
 * a tenant, while a tenant administrator may only manage members inside the one
 * organization their session is currently scoped to.
 */

import { hasDatabase } from "./db.js";
import { getUser, primaryEmail } from "./clerk.js";

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function allowlist(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "tenant";
}

/**
 * A platform operator is named either by the PLATFORM_ADMIN_USER_IDS /
 * PLATFORM_ADMIN_EMAILS Worker variables or by a row in `platform_admins`.
 * The env allowlist exists so the very first operator can bootstrap the table.
 */
export async function isPlatformAdmin(env, actor) {
  if (!actor?.userId) return false;

  const userIds = allowlist(env.PLATFORM_ADMIN_USER_IDS);
  if (userIds.includes(String(actor.userId).toLowerCase())) return true;

  const emails = allowlist(env.PLATFORM_ADMIN_EMAILS);
  if (actor.email && emails.includes(String(actor.email).toLowerCase())) return true;

  if (hasDatabase(env)) {
    const row = await env.DB.prepare("SELECT clerk_user_id FROM platform_admins WHERE clerk_user_id = ? LIMIT 1")
      .bind(actor.userId)
      .first();
    if (row) return true;
  }

  // Bootstrap path. The email claim only reaches us once the `timinow` JWT
  // template exists, so the very first operator would otherwise be locked out of
  // the console they need in order to finish setting Clerk up. Resolve the
  // address from the Backend API instead — only when an email allowlist is
  // configured and nothing cheaper has already answered.
  if (emails.length && !actor.email && env.CLERK_SECRET_KEY) {
    try {
      const email = primaryEmail(await getUser(env, actor.userId));
      if (email && emails.includes(email.toLowerCase())) return true;
    } catch (error) {
      console.warn(JSON.stringify({ event: "platform_admin_lookup_failed", message: error.message }));
    }
  }

  return false;
}

export async function recordAudit(env, { actorUserId, actorScope, tenantId = null, action, target = null, detail = {} }) {
  if (!hasDatabase(env)) return;
  await env.DB.prepare(`
    INSERT INTO admin_audit_log (id, actor_user_id, actor_scope, tenant_id, action, target, detail_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(newId("audit"), actorUserId, actorScope, tenantId, action, target, JSON.stringify(detail)).run();
}

export function tenantFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    clerkOrgId: row.clerk_org_id,
    clerkOrgSlug: row.clerk_org_slug || null,
    name: row.name,
    slug: row.slug,
    status: row.status || "active",
    contactEmail: row.contact_email || null,
    createdBy: row.created_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    locationCount: row.location_count ?? null,
    memberCount: row.member_count ?? null
  };
}

export async function listTenants(env) {
  if (!hasDatabase(env)) return [];
  const result = await env.DB.prepare(`
    SELECT t.*,
      (SELECT COUNT(*) FROM locations l WHERE l.tenant_id = t.id AND l.active = 1) AS location_count,
      (SELECT COUNT(*) FROM tenant_members m WHERE m.tenant_id = t.id AND m.status = 'active') AS member_count
    FROM tenants t
    ORDER BY t.created_at DESC
  `).all();
  return result.results.map(tenantFromRow);
}

export async function getTenant(env, tenantId) {
  if (!hasDatabase(env)) return null;
  const row = await env.DB.prepare(`
    SELECT t.*,
      (SELECT COUNT(*) FROM locations l WHERE l.tenant_id = t.id AND l.active = 1) AS location_count,
      (SELECT COUNT(*) FROM tenant_members m WHERE m.tenant_id = t.id AND m.status = 'active') AS member_count
    FROM tenants t WHERE t.id = ? LIMIT 1
  `).bind(tenantId).first();
  return tenantFromRow(row);
}

export async function slugAvailable(env, slug) {
  if (!hasDatabase(env)) return true;
  const row = await env.DB.prepare("SELECT id FROM tenants WHERE slug = ? LIMIT 1").bind(slug).first();
  return !row;
}

export async function insertTenant(env, { id, clerkOrgId, clerkOrgSlug, name, slug, contactEmail, createdBy }) {
  await env.DB.prepare(`
    INSERT INTO tenants (id, clerk_org_id, name, slug, status, clerk_org_slug, contact_email, created_by)
    VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
  `).bind(id, clerkOrgId, name, slug, clerkOrgSlug || null, contactEmail || null, createdBy || null).run();
}

export async function setTenantStatus(env, tenantId, status) {
  await env.DB.prepare("UPDATE tenants SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(status, tenantId)
    .run();
}

/* ------------------------------------------------------------- members --- */

export function memberFromRow(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    clerkUserId: row.clerk_user_id,
    clerkOrgId: row.clerk_org_id,
    clerkMembershipId: row.clerk_membership_id || null,
    email: row.email || null,
    displayName: row.display_name || null,
    role: row.role,
    status: row.status,
    lastSeenAt: row.last_seen_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function listTenantMembers(env, tenantId) {
  if (!hasDatabase(env)) return [];
  const result = await env.DB.prepare(
    "SELECT * FROM tenant_members WHERE tenant_id = ? AND status = 'active' ORDER BY role, display_name"
  ).bind(tenantId).all();
  return result.results.map(memberFromRow);
}

export async function upsertTenantMember(env, { tenantId, clerkOrgId, clerkUserId, clerkMembershipId, email, displayName, role }) {
  if (!hasDatabase(env)) return;
  await env.DB.prepare(`
    INSERT INTO tenant_members (id, tenant_id, clerk_user_id, clerk_org_id, clerk_membership_id, email, display_name, role, status, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP)
    ON CONFLICT(tenant_id, clerk_user_id) DO UPDATE SET
      clerk_org_id = excluded.clerk_org_id,
      clerk_membership_id = COALESCE(excluded.clerk_membership_id, tenant_members.clerk_membership_id),
      email = COALESCE(excluded.email, tenant_members.email),
      display_name = COALESCE(excluded.display_name, tenant_members.display_name),
      role = excluded.role,
      status = 'active',
      last_seen_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    newId("member"), tenantId, clerkUserId, clerkOrgId, clerkMembershipId || null,
    email || null, displayName || null, role || "org:member"
  ).run();
}

export async function markTenantMemberRemoved(env, tenantId, clerkUserId) {
  if (!hasDatabase(env)) return;
  await env.DB.prepare(
    "UPDATE tenant_members SET status = 'removed', updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND clerk_user_id = ?"
  ).bind(tenantId, clerkUserId).run();
}

export async function countTenantAdmins(env, tenantId) {
  if (!hasDatabase(env)) return 0;
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM tenant_members WHERE tenant_id = ? AND status = 'active' AND role = 'org:admin'"
  ).bind(tenantId).first();
  return Number(row?.total || 0);
}

/* --------------------------------------------------------- invitations --- */

export async function listTenantInvitations(env, tenantId) {
  if (!hasDatabase(env)) return [];
  const result = await env.DB.prepare(
    "SELECT * FROM tenant_invitations WHERE tenant_id = ? AND status = 'pending' ORDER BY created_at DESC"
  ).bind(tenantId).all();
  return result.results.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    clerkInvitationId: row.clerk_invitation_id,
    email: row.email,
    role: row.role,
    status: row.status,
    invitedBy: row.invited_by,
    createdAt: row.created_at
  }));
}

export async function insertTenantInvitation(env, { tenantId, clerkInvitationId, email, role, invitedBy }) {
  if (!hasDatabase(env)) return null;
  const id = newId("invite");
  await env.DB.prepare(`
    INSERT INTO tenant_invitations (id, tenant_id, clerk_invitation_id, email, role, status, invited_by)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).bind(id, tenantId, clerkInvitationId || null, email, role || "org:member", invitedBy || null).run();
  return id;
}

export async function setInvitationStatus(env, invitationId, status) {
  if (!hasDatabase(env)) return;
  await env.DB.prepare("UPDATE tenant_invitations SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(status, invitationId)
    .run();
}

export { newId as newTenancyId };
