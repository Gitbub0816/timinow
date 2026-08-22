/**
 * Tenant-scoped member administration.
 *
 * A tenant administrator may invite, re-role, and remove people inside the one
 * organization their session is scoped to — and nothing else. Creating a tenant
 * is not reachable from here; it lives only in the platform admin console.
 */

import { isOrgAdmin } from "./auth.js";
import {
  createOrganizationInvitation,
  createOrganizationMembership,
  deleteOrganizationMembership,
  displayName,
  findUserByEmail,
  listOrganizationInvitations,
  listOrganizationMemberships,
  primaryEmail,
  revokeOrganizationInvitation,
  updateOrganizationMembership
} from "./clerk.js";
import {
  countTenantAdmins,
  getTenant,
  insertTenantInvitation,
  listTenantInvitations,
  markTenantMemberRemoved,
  recordAudit,
  setInvitationStatus,
  upsertTenantMember
} from "./tenancy.js";

const VALID_ROLES = new Set(["org:admin", "org:member"]);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeRole(value) {
  const role = String(value || "").trim().toLowerCase();
  if (VALID_ROLES.has(role)) return role;
  if (role === "admin") return "org:admin";
  if (role === "member" || role === "") return "org:member";
  return null;
}

/**
 * Read the live roster from Clerk and reconcile the D1 mirror in the same pass,
 * so the console never shows a member who was removed in the Clerk dashboard.
 */
export async function listMembers(env, actor, tenantId) {
  const tenant = await getTenant(env, tenantId);
  const memberships = await listOrganizationMemberships(env, actor.clerkOrgId);
  const members = memberships.map((membership) => {
    const user = membership.public_user_data || {};
    return {
      clerkUserId: user.user_id,
      clerkMembershipId: membership.id,
      email: user.identifier || null,
      name: [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || user.identifier || user.user_id,
      imageUrl: user.image_url || null,
      role: membership.role,
      isSelf: user.user_id === actor.userId,
      createdAt: membership.created_at ? new Date(membership.created_at).toISOString() : null
    };
  });

  for (const member of members) {
    await upsertTenantMember(env, {
      tenantId,
      clerkOrgId: actor.clerkOrgId,
      clerkUserId: member.clerkUserId,
      clerkMembershipId: member.clerkMembershipId,
      email: member.email,
      displayName: member.name,
      role: normalizeRole(member.role) || "org:member"
    });
  }

  const clerkInvitations = await listOrganizationInvitations(env, actor.clerkOrgId).catch(() => []);
  const invitations = clerkInvitations.map((invitation) => ({
    id: invitation.id,
    email: invitation.email_address,
    role: invitation.role,
    status: invitation.status,
    createdAt: invitation.created_at ? new Date(invitation.created_at).toISOString() : null
  }));

  return {
    tenant: tenant ? { id: tenant.id, name: tenant.name, slug: tenant.slug, status: tenant.status } : null,
    members,
    invitations,
    mirroredInvitations: await listTenantInvitations(env, tenantId)
  };
}

/**
 * Add someone to the workspace. An existing Clerk user is added directly so they
 * can sign in immediately; anyone else receives an organization invitation.
 */
export async function addMember(env, actor, tenantId, body) {
  const email = String(body?.email || "").trim().toLowerCase();
  const role = normalizeRole(body?.role);
  if (!EMAIL_PATTERN.test(email)) return { status: 422, code: "INVALID_EMAIL", message: "Enter a valid work email address." };
  if (!role) return { status: 422, code: "INVALID_ROLE", message: "Choose either the administrator or member role." };

  const existing = await findUserByEmail(env, email);
  if (existing) {
    const membership = await createOrganizationMembership(env, actor.clerkOrgId, { userId: existing.id, role });
    await upsertTenantMember(env, {
      tenantId,
      clerkOrgId: actor.clerkOrgId,
      clerkUserId: existing.id,
      clerkMembershipId: membership.id,
      email: primaryEmail(existing) || email,
      displayName: displayName(existing),
      role
    });
    await recordAudit(env, {
      actorUserId: actor.userId,
      actorScope: "tenant",
      tenantId,
      action: "member.added",
      target: existing.id,
      detail: { email, role }
    });
    return { status: 201, body: { added: { clerkUserId: existing.id, email, role }, invited: null } };
  }

  const invitation = await createOrganizationInvitation(env, actor.clerkOrgId, {
    email,
    role,
    inviterUserId: actor.userId,
    redirectUrl: env.VET_APP_URL || undefined,
    publicMetadata: { tenantId }
  });
  await insertTenantInvitation(env, {
    tenantId,
    clerkInvitationId: invitation.id,
    email,
    role,
    invitedBy: actor.userId
  });
  await recordAudit(env, {
    actorUserId: actor.userId,
    actorScope: "tenant",
    tenantId,
    action: "member.invited",
    target: email,
    detail: { role, invitationId: invitation.id }
  });
  return { status: 201, body: { added: null, invited: { id: invitation.id, email, role } } };
}

export async function changeMemberRole(env, actor, tenantId, clerkUserId, body) {
  const role = normalizeRole(body?.role);
  if (!role) return { status: 422, code: "INVALID_ROLE", message: "Choose either the administrator or member role." };
  if (clerkUserId === actor.userId && role !== "org:admin") {
    return { status: 409, code: "LAST_ADMIN_GUARD", message: "Ask another administrator to change your own role." };
  }
  if (role === "org:member" && (await countTenantAdmins(env, tenantId)) <= 1) {
    return { status: 409, code: "LAST_ADMIN_GUARD", message: "A workspace must keep at least one administrator." };
  }
  await updateOrganizationMembership(env, actor.clerkOrgId, { userId: clerkUserId, role });
  await upsertTenantMember(env, { tenantId, clerkOrgId: actor.clerkOrgId, clerkUserId, role });
  await recordAudit(env, {
    actorUserId: actor.userId,
    actorScope: "tenant",
    tenantId,
    action: "member.role_changed",
    target: clerkUserId,
    detail: { role }
  });
  return { status: 200, body: { clerkUserId, role } };
}

export async function removeMember(env, actor, tenantId, clerkUserId) {
  if (clerkUserId === actor.userId) {
    return { status: 409, code: "SELF_REMOVAL_BLOCKED", message: "Ask another administrator to remove your access." };
  }
  const memberships = await listOrganizationMemberships(env, actor.clerkOrgId);
  const target = memberships.find((membership) => membership.public_user_data?.user_id === clerkUserId);
  if (!target) return { status: 404, code: "MEMBER_NOT_FOUND", message: "That person is not in this workspace." };
  if (normalizeRole(target.role) === "org:admin" && (await countTenantAdmins(env, tenantId)) <= 1) {
    return { status: 409, code: "LAST_ADMIN_GUARD", message: "A workspace must keep at least one administrator." };
  }
  await deleteOrganizationMembership(env, actor.clerkOrgId, clerkUserId);
  await markTenantMemberRemoved(env, tenantId, clerkUserId);
  await recordAudit(env, {
    actorUserId: actor.userId,
    actorScope: "tenant",
    tenantId,
    action: "member.removed",
    target: clerkUserId,
    detail: {}
  });
  return { status: 200, body: { removed: clerkUserId } };
}

export async function revokeInvitation(env, actor, tenantId, invitationId) {
  await revokeOrganizationInvitation(env, actor.clerkOrgId, invitationId, actor.userId);
  const mirrored = await listTenantInvitations(env, tenantId);
  const match = mirrored.find((invitation) => invitation.clerkInvitationId === invitationId);
  if (match) await setInvitationStatus(env, match.id, "revoked");
  await recordAudit(env, {
    actorUserId: actor.userId,
    actorScope: "tenant",
    tenantId,
    action: "invitation.revoked",
    target: invitationId,
    detail: {}
  });
  return { status: 200, body: { revoked: invitationId } };
}

/** Guard used by both the veterinary Worker and the admin Worker. */
export function requireTenantAdmin(actor, tenantId) {
  if (!actor?.authenticated && !actor?.demo) return { code: "AUTHENTICATION_REQUIRED", status: 401, message: "Sign in to continue." };
  if (!tenantId) return { code: "TENANT_REQUIRED", status: 403, message: "Select the workspace you administer." };
  if (!actor.clerkOrgId) return { code: "ORGANIZATION_REQUIRED", status: 403, message: "Select an active organization." };
  if (!isOrgAdmin(actor)) return { code: "TENANT_ADMIN_REQUIRED", status: 403, message: "Only a workspace administrator can manage people." };
  return null;
}
