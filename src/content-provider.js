/**
 * A clinic writing on the blog.
 *
 * Clinics publish straight to the live site with no review from TímiNOW. That
 * is a deliberate product decision — a practice should not wait on us to write
 * about its own work — and everything here exists to make it a decision rather
 * than an exposure:
 *
 *   The byline says whose post it is. "From {Clinic}, a TímiNOW clinic", with
 *   a line beneath saying TímiNOW hosts it and does not endorse it. A reader
 *   can tell our words from a clinic's, which matters most when the subject is
 *   clinical.
 *
 *   The clinic decides who speaks for it. Not TímiNOW: a practice knows which
 *   of its people may publish under its name and an operator here does not.
 *   The grant is a flag on the membership, set by that clinic's own org:admin.
 *
 *   An operator can take any of it down, immediately, with the reason
 *   recorded. That is the backstop the immediacy rests on.
 *
 * Tenancy is enforced by the queries rather than by a check somebody has to
 * remember: every read and write is scoped to the tenant on the session, so a
 * guessed post id from another clinic returns nothing.
 */

import { hasDatabase } from "./db.js";
import { providerAuthorFor } from "./content.js";
import { createPost, listPostsForTenant, updatePost } from "./content-store.js";

/** Whether this person may publish for this clinic, and under what name. */
export async function describeProviderAuthor(env, actor, tenantId) {
  const author = await providerAuthorFor(env, actor, tenantId);
  return {
    canPublish: Boolean(author),
    byline: author ? `From ${author.providerName}, a TímiNOW clinic` : null,
    authorName: author?.name || null
  };
}

export async function listProviderPosts(env, tenantId) {
  return { ok: true, posts: await listPostsForTenant(env, tenantId) };
}

export async function createProviderPost(env, actor, tenantId, body) {
  const author = await providerAuthorFor(env, actor, tenantId);
  if (!author) {
    return {
      ok: false,
      status: 403,
      code: "POSTING_NOT_PERMITTED",
      message: "An administrator at your practice has to turn on posting for your account first."
    };
  }
  // `author.providerName` is the clinic's name as it stands today, frozen onto
  // the row at write time — a post should keep saying which practice published
  // it even after a rename or a change of ownership.
  return createPost(env, author, {
    title: body?.title,
    excerpt: body?.excerpt,
    bodyMarkdown: body?.bodyMarkdown,
    publish: body?.publish === true
  });
}

export async function updateProviderPost(env, actor, tenantId, postId, body) {
  const author = await providerAuthorFor(env, actor, tenantId);
  if (!author) {
    return { ok: false, status: 403, code: "POSTING_NOT_PERMITTED", message: "Your account is not set up to publish for this practice." };
  }
  // tenantScope is the boundary: the UPDATE simply will not match another
  // clinic's row, so a guessed id is a 404 and never somebody else's article.
  return updatePost(env, postId, body || {}, { tenantScope: tenantId });
}

/**
 * Turn posting on or off for one member of this practice.
 *
 * Caller must already have passed requireTenantAdmin — the same guard every
 * other member-administration route in this codebase runs behind.
 */
export async function setMemberPosting(env, tenantId, clerkUserId, canPublish) {
  if (!hasDatabase(env)) return { ok: false, status: 503, code: "DATABASE_REQUIRED", message: "D1 is required." };
  const result = await env.DB.prepare(
    "UPDATE tenant_members SET can_publish_posts = ?, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND clerk_user_id = ? AND status = 'active'"
  ).bind(canPublish ? 1 : 0, tenantId, clerkUserId).run();
  if (!(result.meta?.changes ?? 0)) {
    return { ok: false, status: 404, code: "MEMBER_NOT_FOUND", message: "That person is not an active member of this practice." };
  }
  return { ok: true, clerkUserId, canPublishPosts: Boolean(canPublish) };
}
