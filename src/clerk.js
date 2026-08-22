/**
 * Clerk Backend API client shared by the customer, veterinary, and admin Workers.
 *
 * Every call needs CLERK_SECRET_KEY as a Worker secret. Nothing in this module is
 * ever reachable from a browser: the three Workers each decide, before calling in,
 * whether the caller is a platform operator or a tenant administrator.
 */

const CLERK_API = "https://api.clerk.com/v1";

export class ClerkError extends Error {
  constructor(status, message, errors) {
    super(message);
    this.name = "ClerkError";
    this.status = status;
    this.errors = errors || [];
  }
}

function requireSecret(env) {
  const secret = env.CLERK_SECRET_KEY;
  if (!secret) throw new ClerkError(500, "CLERK_SECRET_KEY is not configured on this Worker.");
  return secret;
}

async function clerkFetch(env, path, { method = "GET", body, query } = {}) {
  const url = new URL(`${CLERK_API}${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${requireSecret(env)}`,
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const errors = Array.isArray(payload.errors) ? payload.errors : [];
    const message = errors[0]?.long_message || errors[0]?.message || `Clerk request failed (${response.status})`;
    throw new ClerkError(response.status, message, errors);
  }
  return payload;
}

/* ---------------------------------------------------------------- users --- */

export function primaryEmail(user) {
  if (!user) return null;
  const identifier = user.primary_email_address_id;
  const addresses = Array.isArray(user.email_addresses) ? user.email_addresses : [];
  const primary = addresses.find((address) => address.id === identifier) || addresses[0];
  return primary?.email_address || null;
}

export function displayName(user) {
  if (!user) return null;
  const full = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return full || user.username || primaryEmail(user) || user.id;
}

export function getUser(env, userId) {
  return clerkFetch(env, `/users/${encodeURIComponent(userId)}`);
}

export async function findUserByEmail(env, email) {
  const results = await clerkFetch(env, "/users", { query: { email_address: email, limit: 1 } });
  const list = Array.isArray(results) ? results : results.data || [];
  return list[0] || null;
}

/**
 * Merge-patch a user's public metadata. Clerk replaces the whole object, so the
 * caller's keys are merged over whatever is already stored.
 */
export async function mergeUserPublicMetadata(env, userId, patch) {
  const user = await getUser(env, userId);
  const merged = { ...(user.public_metadata || {}), ...patch };
  return clerkFetch(env, `/users/${encodeURIComponent(userId)}/metadata`, {
    method: "PATCH",
    body: { public_metadata: merged }
  });
}

/* -------------------------------------------------------- organizations --- */

export function createOrganization(env, { name, slug, createdBy, publicMetadata, privateMetadata }) {
  return clerkFetch(env, "/organizations", {
    method: "POST",
    body: {
      name,
      slug,
      created_by: createdBy,
      public_metadata: publicMetadata || {},
      private_metadata: privateMetadata || {}
    }
  });
}

export function getOrganization(env, organizationId) {
  return clerkFetch(env, `/organizations/${encodeURIComponent(organizationId)}`);
}

export async function mergeOrganizationPublicMetadata(env, organizationId, patch) {
  const organization = await getOrganization(env, organizationId);
  const merged = { ...(organization.public_metadata || {}), ...patch };
  return clerkFetch(env, `/organizations/${encodeURIComponent(organizationId)}`, {
    method: "PATCH",
    body: { public_metadata: merged }
  });
}

export function updateOrganization(env, organizationId, body) {
  return clerkFetch(env, `/organizations/${encodeURIComponent(organizationId)}`, { method: "PATCH", body });
}

export function deleteOrganization(env, organizationId) {
  return clerkFetch(env, `/organizations/${encodeURIComponent(organizationId)}`, { method: "DELETE" });
}

export async function listOrganizations(env, { limit = 100, offset = 0 } = {}) {
  const payload = await clerkFetch(env, "/organizations", { query: { limit, offset } });
  return Array.isArray(payload) ? payload : payload.data || [];
}

/* ----------------------------------------------------------- membership --- */

export async function listOrganizationMemberships(env, organizationId, { limit = 100, offset = 0 } = {}) {
  const payload = await clerkFetch(env, `/organizations/${encodeURIComponent(organizationId)}/memberships`, {
    query: { limit, offset }
  });
  return Array.isArray(payload) ? payload : payload.data || [];
}

export function createOrganizationMembership(env, organizationId, { userId, role = "org:member" }) {
  return clerkFetch(env, `/organizations/${encodeURIComponent(organizationId)}/memberships`, {
    method: "POST",
    body: { user_id: userId, role }
  });
}

export function updateOrganizationMembership(env, organizationId, { userId, role }) {
  return clerkFetch(env, `/organizations/${encodeURIComponent(organizationId)}/memberships/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    body: { role }
  });
}

export function deleteOrganizationMembership(env, organizationId, userId) {
  return clerkFetch(env, `/organizations/${encodeURIComponent(organizationId)}/memberships/${encodeURIComponent(userId)}`, {
    method: "DELETE"
  });
}

/**
 * Membership public metadata is what the desktop clients read to resolve their
 * tenant without an extra API call, because Clerk copies it into the `o.pmd`
 * claim of the session token when the organization is active.
 */
export async function mergeMembershipPublicMetadata(env, organizationId, userId, patch) {
  const memberships = await listOrganizationMemberships(env, organizationId);
  const membership = memberships.find((item) => item.public_user_data?.user_id === userId);
  const merged = { ...(membership?.public_metadata || {}), ...patch };
  return clerkFetch(env, `/organizations/${encodeURIComponent(organizationId)}/memberships/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    body: { public_metadata: merged }
  });
}

/* ---------------------------------------------------------- invitations --- */

export function createOrganizationInvitation(env, organizationId, { email, role = "org:member", inviterUserId, redirectUrl, publicMetadata }) {
  return clerkFetch(env, `/organizations/${encodeURIComponent(organizationId)}/invitations`, {
    method: "POST",
    body: {
      email_address: email,
      role,
      inviter_user_id: inviterUserId,
      redirect_url: redirectUrl,
      public_metadata: publicMetadata || {}
    }
  });
}

export async function listOrganizationInvitations(env, organizationId, { status = "pending" } = {}) {
  const payload = await clerkFetch(env, `/organizations/${encodeURIComponent(organizationId)}/invitations`, {
    query: { status, limit: 100 }
  });
  return Array.isArray(payload) ? payload : payload.data || [];
}

export function revokeOrganizationInvitation(env, organizationId, invitationId, requestingUserId) {
  return clerkFetch(env, `/organizations/${encodeURIComponent(organizationId)}/invitations/${encodeURIComponent(invitationId)}/revoke`, {
    method: "POST",
    body: { requesting_user_id: requestingUserId }
  });
}
