/**
 * The operator console's side of the blog: writing, moderating, and deciding
 * who else may write.
 *
 * Two different grants are made from the Operators screen, and keeping them
 * distinct is the point of this module:
 *
 *   An operator role — SUPPORT_ADMIN through SUPER_ADMIN — is authority over
 *   the platform. It requires the person already be a platform administrator,
 *   and it is what lets somebody waive a fee or move restricted money.
 *
 *   Contributor is authority over one thing: writing a post that carries
 *   TímiNOW's name. It confers no console access whatsoever. A guest writer
 *   should not be able to read the ledger, and before this existed the only
 *   way to let somebody write for us was to make them an administrator.
 *
 * The console now asks which of the two is being granted, rather than having
 * one button that meant the larger of them.
 */

import { hasDatabase } from "./db.js";
import { ADMIN_ROLES, authorizeAdminAction } from "./admin-roles.js";
import { findUserByEmail } from "./clerk.js";
import { platformAuthorFor } from "./content.js";
import {
  createPost,
  dismissReport,
  listAllPosts,
  listOpenReports,
  removeContent,
  updatePost
} from "./content-store.js";
import { announcePost } from "./blog-subscriptions.js";

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function clean(value, maxLength) {
  return String(value == null ? "" : value).trim().slice(0, maxLength);
}

/** What the console offers in its permission picker. */
export const GRANTABLE_PERMISSIONS = Object.freeze([
  { key: "SUPPORT_ADMIN", kind: "operator", label: "Support operator", note: "Reads everything. Changes nothing that matters." },
  { key: "CLINIC_OPERATIONS_ADMIN", kind: "operator", label: "Clinic operations", note: "Clinic profiles, deposit elections, applications." },
  { key: "FINANCE_ADMIN", kind: "operator", label: "Finance", note: "Ledger adjustments, treasury releases, reconciliation." },
  { key: "COMPLIANCE_ADMIN", kind: "operator", label: "Compliance", note: "Lifecycle, revocations for cause, and content takedowns." },
  { key: "SUPER_ADMIN", kind: "operator", label: "Super administrator", note: "Everything, including commercial terms. Grant sparingly." },
  { key: "CONTRIBUTOR", kind: "contributor", label: "Blog contributor", note: "Writes posts as \"TímiNOW post by contributor …\". No console access at all." }
]);

/* ──────────────────────────────────────────────────────── contributors ── */

export async function listContributors(env) {
  if (!hasDatabase(env)) return [];
  const rows = await env.DB.prepare(
    "SELECT id, clerk_user_id, display_name, granted_at FROM content_contributors WHERE revoked_at IS NULL ORDER BY granted_at DESC"
  ).all().catch(() => ({ results: [] }));
  return rows.results.map((row) => ({
    id: row.id,
    clerkUserId: row.clerk_user_id,
    displayName: row.display_name,
    grantedAt: row.granted_at
  }));
}

/**
 * Let somebody write for TímiNOW.
 *
 * The display name is recorded here rather than read from Clerk at render
 * time, because a byline is an editorial decision: an old post should keep
 * saying who wrote it, and not silently re-attribute itself because somebody
 * edited their profile years later.
 */
export async function grantContributor(env, actor, { email, displayName }) {
  const decision = await authorizeAdminAction(env, actor, "content.contributor.grant");
  if (!decision.allowed) return { ok: false, code: decision.code, message: decision.message, status: 403 };
  if (!hasDatabase(env)) return { ok: false, code: "DATABASE_REQUIRED", message: "D1 is required.", status: 503 };
  if (!env.CLERK_SECRET_KEY) return { ok: false, code: "CLERK_NOT_CONFIGURED", message: "Clerk is not configured on this Worker, so the account cannot be resolved.", status: 503 };

  const address = clean(email, 160).toLowerCase();
  const name = clean(displayName, 80);
  if (!address) return { ok: false, code: "EMAIL_REQUIRED", message: "An email address is required.", status: 422 };
  if (!name) return { ok: false, code: "NAME_REQUIRED", message: "A byline name is required — it is what readers will see.", status: 422 };

  const user = await findUserByEmail(env, address).catch(() => null);
  if (!user?.id) return { ok: false, code: "USER_NOT_FOUND", message: "No account with that address. They need to sign in once first.", status: 404 };

  // Re-granting somebody previously revoked reinstates them rather than
  // failing on the unique key, and updates the byline while it is at it.
  await env.DB.prepare(`
    INSERT INTO content_contributors (id, clerk_user_id, display_name, granted_by, granted_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(clerk_user_id) DO UPDATE SET
      display_name = excluded.display_name,
      granted_by = excluded.granted_by,
      granted_at = CURRENT_TIMESTAMP,
      revoked_at = NULL,
      revoked_by = NULL
  `).bind(newId("contrib"), user.id, name, actor?.userId || null).run();

  return { ok: true, contributor: { clerkUserId: user.id, displayName: name } };
}

export async function revokeContributor(env, actor, clerkUserId) {
  const decision = await authorizeAdminAction(env, actor, "content.contributor.grant");
  if (!decision.allowed) return { ok: false, code: decision.code, message: decision.message, status: 403 };
  if (!hasDatabase(env)) return { ok: false, code: "DATABASE_REQUIRED", message: "D1 is required.", status: 503 };
  // Revoked, not deleted. Posts they wrote keep their byline, and who could
  // write on TímiNOW's behalf, and when, stays answerable.
  await env.DB.prepare(
    "UPDATE content_contributors SET revoked_at = CURRENT_TIMESTAMP, revoked_by = ? WHERE clerk_user_id = ? AND revoked_at IS NULL"
  ).bind(actor?.userId || null, clerkUserId).run();
  return { ok: true };
}

/* ───────────────────────────────────────────────────── operator roles ── */

export async function listOperatorRoles(env) {
  if (!hasDatabase(env)) return [];
  const rows = await env.DB.prepare(
    "SELECT clerk_user_id, role, granted_at FROM admin_role_assignments WHERE revoked_at IS NULL ORDER BY granted_at DESC"
  ).all().catch(() => ({ results: [] }));
  return rows.results.map((row) => ({ clerkUserId: row.clerk_user_id, role: row.role, grantedAt: row.granted_at }));
}

/**
 * Grant an operator role.
 *
 * SUPER_ADMIN only, because this is the action that hands out every other
 * action. Note what it does not do: it does not make anybody a platform
 * administrator. rolesFor() ignores a row for someone who is not one already,
 * so a role granted to a stranger is inert — which is the safe direction.
 */
export async function grantOperatorRole(env, actor, { clerkUserId, role }) {
  const decision = await authorizeAdminAction(env, actor, "operator.role.grant");
  if (!decision.allowed) return { ok: false, code: decision.code, message: decision.message, status: 403 };
  if (!hasDatabase(env)) return { ok: false, code: "DATABASE_REQUIRED", message: "D1 is required.", status: 503 };
  if (!ADMIN_ROLES.includes(role)) return { ok: false, code: "ROLE_INVALID", message: "That is not a role.", status: 422 };
  const userId = clean(clerkUserId, 120);
  if (!userId) return { ok: false, code: "USER_REQUIRED", message: "Name the operator.", status: 422 };

  await env.DB.prepare(
    "INSERT OR IGNORE INTO admin_role_assignments (id, clerk_user_id, role, granted_by, granted_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)"
  ).bind(newId("role"), userId, role, actor?.userId || null).run();
  return { ok: true };
}

export async function revokeOperatorRole(env, actor, { clerkUserId, role }) {
  const decision = await authorizeAdminAction(env, actor, "operator.role.grant");
  if (!decision.allowed) return { ok: false, code: decision.code, message: decision.message, status: 403 };
  if (!hasDatabase(env)) return { ok: false, code: "DATABASE_REQUIRED", message: "D1 is required.", status: 503 };
  await env.DB.prepare(
    "UPDATE admin_role_assignments SET revoked_at = CURRENT_TIMESTAMP, revoked_by = ? WHERE clerk_user_id = ? AND role = ? AND revoked_at IS NULL"
  ).bind(actor?.userId || null, clerkUserId, role).run();
  return { ok: true };
}

/* ────────────────────────────────────────────────────────────── posts ── */

export async function adminListPosts(env) {
  return { ok: true, posts: await listAllPosts(env) };
}

/**
 * Write a post from the console.
 *
 * `onBehalfOf` names a contributor: an operator can paste in a guest's piece
 * and have it carry that guest's byline rather than the operator's. The
 * contributor must actually hold the grant — an operator cannot invent a
 * byline for somebody who never agreed to have one.
 */
export async function adminCreatePost(env, actor, body) {
  if (!hasDatabase(env)) return { ok: false, code: "DATABASE_REQUIRED", message: "D1 is required.", status: 503 };

  let author = await platformAuthorFor(env, actor, { isAdmin: true, adminName: body?.authorName || actor?.name });
  const onBehalfOf = clean(body?.onBehalfOf, 120);
  if (onBehalfOf) {
    const row = await env.DB.prepare(
      "SELECT clerk_user_id, display_name FROM content_contributors WHERE clerk_user_id = ? AND revoked_at IS NULL LIMIT 1"
    ).bind(onBehalfOf).first();
    if (!row) return { ok: false, code: "CONTRIBUTOR_NOT_FOUND", message: "That contributor does not hold a current grant.", status: 404 };
    author = { kind: "contributor", userId: row.clerk_user_id, name: row.display_name };
  }

  const result = await createPost(env, author, {
    title: body?.title,
    excerpt: body?.excerpt,
    bodyMarkdown: body?.bodyMarkdown,
    publish: body?.publish === true
  });
  return result;
}

export async function adminUpdatePost(env, actor, postId, body) {
  return updatePost(env, postId, body || {}, { tenantScope: null });
}

/**
 * Email a published post to confirmed subscribers.
 *
 * A separate, deliberate act rather than something publishing does on its own.
 * Publishing is reversible in a minute; a send is not, and "I hit publish to
 * see the preview" should not put a draft in five thousand inboxes.
 */
export async function adminAnnouncePost(env, actor, postId, { blogOrigin }) {
  if (!hasDatabase(env)) return { ok: false, code: "DATABASE_REQUIRED", message: "D1 is required.", status: 503 };
  const row = await env.DB.prepare("SELECT id, slug, title, excerpt, status FROM blog_posts WHERE id = ? LIMIT 1").bind(postId).first();
  if (!row) return { ok: false, code: "POST_NOT_FOUND", message: "That post was not found.", status: 404 };
  if (row.status !== "published") return { ok: false, code: "POST_NOT_PUBLISHED", message: "Publish it before sending it.", status: 422 };
  const outcome = await announcePost(env, row, {
    postURL: `${blogOrigin}/p/${row.slug}`,
    unsubscribeBase: `${blogOrigin}/unsubscribe`
  });
  return { ok: true, ...outcome };
}

/* ───────────────────────────────────────────────────────── moderation ── */

export async function adminListReports(env) {
  return { ok: true, reports: await listOpenReports(env) };
}

/**
 * Take content down.
 *
 * The control that makes immediate publishing survivable: a clinic posts
 * without waiting on us, a member comments without waiting on us, and anything
 * that turns out to be wrong stops being public the moment somebody here says
 * so. Reason recorded; row kept.
 */
export async function adminRemoveContent(env, actor, { subjectType, subjectId, reason }) {
  const decision = await authorizeAdminAction(env, actor, "content.moderate");
  if (!decision.allowed) return { ok: false, code: decision.code, message: decision.message, status: 403 };
  return removeContent(env, { subjectType, subjectId, operatorId: actor?.userId, reason });
}

export async function adminDismissReport(env, actor, reportId) {
  const decision = await authorizeAdminAction(env, actor, "content.moderate");
  if (!decision.allowed) return { ok: false, code: decision.code, message: decision.message, status: 403 };
  return dismissReport(env, reportId, actor?.userId);
}
