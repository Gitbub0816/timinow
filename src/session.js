/**
 * Session resolution and Clerk metadata backfill.
 *
 * The desktop and native clients read `tenantId` straight off their Clerk session
 * token. That only works if the organization, the membership, and the user all
 * carry the right public metadata. Rather than depend on an operator remembering
 * to set it by hand, every authenticated call to `/api/session` reconciles the
 * three metadata surfaces against D1 and repairs whatever drifted.
 */

import { getClinicLocation, hasDatabase, tenantIdForClerkOrg } from "./db.js";
import {
  displayName,
  mergeMembershipPublicMetadata,
  mergeOrganizationPublicMetadata,
  mergeUserPublicMetadata,
  primaryEmail,
  getUser
} from "./clerk.js";
import { getTenant, isPlatformAdmin, upsertTenantMember } from "./tenancy.js";

function canBackfill(env) {
  return Boolean(env.CLERK_SECRET_KEY) && hasDatabase(env);
}

/**
 * Resolve the tenant for an actor, preferring the session-token claim and
 * falling back to the organization mapping in D1.
 */
export async function resolveTenantId(env, actor) {
  if (!actor) return null;
  if (actor.tenantId) return actor.tenantId;
  if (actor.clerkOrgId) return tenantIdForClerkOrg(env, actor.clerkOrgId);
  return null;
}

/**
 * Write `tenantId`/`locationId` onto the Clerk organization, the caller's
 * membership, and the caller's user record when any of them is missing or stale.
 * Returns the list of surfaces that were actually repaired.
 */
export async function backfillClerkMetadata(env, actor, { tenantId, tenantSlug, locationId }) {
  if (!canBackfill(env) || !actor?.clerkOrgId || !tenantId) return [];
  const repaired = [];
  const desired = { tenantId, tenantSlug: tenantSlug || null, locationId: locationId || null };

  const orgMetadata = actor.orgMetadata || {};
  if (orgMetadata.tenantId !== tenantId || (locationId && orgMetadata.locationId !== locationId)) {
    await mergeOrganizationPublicMetadata(env, actor.clerkOrgId, desired);
    repaired.push("organization");
  }

  try {
    await mergeMembershipPublicMetadata(env, actor.clerkOrgId, actor.userId, desired);
    repaired.push("membership");
  } catch (error) {
    console.warn(JSON.stringify({ event: "membership_metadata_skipped", message: error.message }));
  }

  const userMetadata = actor.userMetadata || {};
  if (userMetadata.tenantId !== tenantId) {
    await mergeUserPublicMetadata(env, actor.userId, { ...desired, lastTenantId: tenantId });
    repaired.push("user");
  }
  return repaired;
}

/**
 * Build the descriptor every client (web, Windows, macOS, iOS) asks for right
 * after sign-in. Side effect: repairs Clerk metadata and refreshes the
 * `tenant_members` mirror so tenant consoles show an accurate roster.
 */
export async function describeSession(env, actor, { repair = true } = {}) {
  if (!actor) return null;
  const tenantId = await resolveTenantId(env, actor);
  const tenant = tenantId ? await getTenant(env, tenantId) : null;
  const location = tenantId ? await getClinicLocation(env, tenantId) : null;
  const platformAdmin = await isPlatformAdmin(env, actor);

  let repairedMetadata = [];
  let profile = null;
  if (repair && actor.authenticated && actor.clerkOrgId && tenantId && env.CLERK_SECRET_KEY) {
    try {
      repairedMetadata = await backfillClerkMetadata(env, actor, {
        tenantId,
        tenantSlug: tenant?.slug,
        locationId: location?.id
      });
      profile = await getUser(env, actor.userId);
      await upsertTenantMember(env, {
        tenantId,
        clerkOrgId: actor.clerkOrgId,
        clerkUserId: actor.userId,
        email: primaryEmail(profile) || actor.email,
        displayName: displayName(profile),
        role: String(actor.role || "").startsWith("org:") ? actor.role : `org:${actor.role === "admin" ? "admin" : "member"}`
      });
    } catch (error) {
      console.warn(JSON.stringify({ event: "session_repair_failed", message: error.message }));
    }
  }

  return {
    authenticated: Boolean(actor.authenticated),
    demo: Boolean(actor.demo),
    user: {
      id: actor.userId,
      email: primaryEmail(profile) || actor.email || null,
      name: profile ? displayName(profile) : null,
      role: actor.role || "customer",
      permissions: actor.permissions || []
    },
    organization: actor.clerkOrgId
      ? { id: actor.clerkOrgId, slug: actor.clerkOrgSlug || tenant?.clerkOrgSlug || null }
      : null,
    tenant: tenant ? { id: tenant.id, name: tenant.name, slug: tenant.slug, status: tenant.status } : null,
    location: location ? { id: location.id, name: location.name, address: location.address, phone: location.phone } : null,
    platformAdmin,
    /** Which console the caller is entitled to open. Clients use this for routing. */
    surfaces: {
      customer: true,
      clinic: Boolean(tenantId),
      admin: platformAdmin
    },
    repairedMetadata
  };
}
