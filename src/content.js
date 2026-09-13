/**
 * The blog and the forum: who may write, and whose name goes on it.
 *
 * The byline is the load-bearing part of this file. Three kinds of author sit
 * behind these posts and they carry three different levels of endorsement:
 *
 *   platform    TímiNOW said this. Written by a named operator, and the
 *               company stands behind it.
 *   contributor Someone writing on TímiNOW's behalf who is not an operator.
 *               Still TímiNOW's post; the name is disclosed because a reader
 *               is entitled to know it was not written in-house.
 *   provider    A clinic's own post, hosted here. TímiNOW publishes it and
 *               does not endorse it — the clinic is identified as one of ours
 *               so a reader knows the relationship, and the post is plainly
 *               theirs so a reader does not read it as our clinical opinion.
 *
 * That last distinction is the reason this is derived in one place rather than
 * formatted per surface. A clinic post that reads as a TímiNOW post is a
 * veterinary claim this company did not make and cannot stand behind, and
 * getting it wrong on one surface out of four is exactly how that happens.
 */

import { hasDatabase } from "./db.js";

/* ───────────────────────────────────────────────────────────── bylines ── */

/**
 * How a post signs itself, as the line to print and the parts behind it.
 *
 * Returns `line` for display and the components beside it, so a surface that
 * wants to style the clinic's name differently from the rest can, without
 * re-deciding the wording.
 */
export function bylineFor(post) {
  const author = cleanName(post?.authorName);
  const provider = cleanName(post?.providerName);

  if (post?.authorKind === "provider") {
    // Short, and clear about two things at once: this clinic is on TímiNOW,
    // and these are the clinic's words. "Sponsored" was the obvious phrasing
    // and the wrong one — it implies TímiNOW paid for the post or vouches for
    // it, and a clinic publishes here without our review.
    const clinic = provider || "a TímiNOW clinic";
    const base = provider ? `From ${clinic}, a TímiNOW clinic` : "From a TímiNOW clinic";
    return {
      line: author ? `${base} · by ${author}` : base,
      kind: "provider",
      endorsed: false,
      /** Printed beneath a provider post. See NON_ENDORSEMENT below. */
      notice: NON_ENDORSEMENT
    };
  }

  if (post?.authorKind === "contributor") {
    return {
      line: author ? `TímiNOW post by contributor ${author}` : "TímiNOW post by a contributor",
      kind: "contributor",
      endorsed: true,
      notice: null
    };
  }

  return {
    line: author ? `TímiNOW post by ${author}` : "TímiNOW post",
    kind: "platform",
    endorsed: true,
    notice: null
  };
}

/**
 * The one sentence that separates hosting a clinic's post from agreeing with
 * it.
 *
 * Clinics publish here without TímiNOW reading it first, which is what the
 * product wants — a practice should not wait on us to write about its own
 * work. The cost of that choice is that a post can be wrong, or commercial,
 * or clinically contentious, before anyone here has seen it. This line is what
 * makes that honest to the reader, and operators can take a post down.
 */
export const NON_ENDORSEMENT = "Written by the clinic. TímiNOW hosts this post and does not review or endorse it.";

/**
 * The notice every post and every thread carries.
 *
 * This is a veterinary site: a reader arriving on an article about a sick
 * animal is frequently a person deciding whether to go to a clinic tonight.
 * Nothing published here is a diagnosis, and reading it does not make anyone
 * a patient of anyone — which in California, as in every state, is a
 * veterinarian-client-patient relationship, and that is established in
 * practice and not in a comment thread (see the veterinary-practice-act
 * notice in public/index.html#legal, drafted against the same statute).
 *
 * Flagged for counsel alongside the Paw It Forward question: a forum where
 * verified clinic staff answer members' questions about specific animals sits
 * closer to that line than an article does, and the safe reading is that it
 * must never become triage. No attorney has reviewed this wording.
 */
export const NOT_ADVICE = "General information, not veterinary advice. Reading it does not create a veterinarian-client-patient relationship. If your pet may be in danger, contact a veterinarian now.";

function cleanName(value) {
  const trimmed = String(value || "").trim().replace(/\s+/g, " ");
  return trimmed.slice(0, 80);
}

/* ─────────────────────────────────────────────────────────── authorship ── */

/**
 * Whether this signed-in person may publish on TímiNOW's own behalf, and as
 * what.
 *
 * Returns null when they may not. `kind` decides the byline, so this is also
 * the thing that stops a contributor publishing a post that reads as though
 * an operator wrote it.
 */
export async function platformAuthorFor(env, actor, { isAdmin = false, adminName = null } = {}) {
  if (!actor?.userId) return null;
  if (isAdmin) {
    return { kind: "platform", userId: actor.userId, name: cleanName(adminName || actor.name || actor.email || "TímiNOW") };
  }
  if (!hasDatabase(env)) return null;
  const row = await env.DB.prepare(
    "SELECT display_name FROM content_contributors WHERE clerk_user_id = ? AND revoked_at IS NULL LIMIT 1"
  ).bind(actor.userId).first().catch(() => null);
  if (!row) return null;
  return { kind: "contributor", userId: actor.userId, name: cleanName(row.display_name) };
}

/**
 * Whether this person may publish for this clinic.
 *
 * The grant lives on the membership and is made by that clinic's own
 * org:admin. TímiNOW deliberately has no say in it: a practice knows which of
 * its people speak for it, and an operator here does not.
 */
export async function providerAuthorFor(env, actor, tenantId) {
  if (!actor?.userId || !tenantId || !hasDatabase(env)) return null;
  const row = await env.DB.prepare(`
    SELECT m.display_name, m.can_publish_posts, m.role, t.name AS tenant_name
    FROM tenant_members m JOIN tenants t ON t.id = m.tenant_id
    WHERE m.tenant_id = ? AND m.clerk_user_id = ? AND m.status = 'active' LIMIT 1
  `).bind(tenantId, actor.userId).first().catch(() => null);
  if (!row) return null;
  // An org:admin may always publish for their own clinic — they are the person
  // who would otherwise be granting themselves the flag.
  const permitted = Number(row.can_publish_posts) === 1 || row.role === "org:admin";
  if (!permitted) return null;
  return {
    kind: "provider",
    userId: actor.userId,
    name: cleanName(row.display_name),
    tenantId,
    providerName: cleanName(row.tenant_name)
  };
}

/* ────────────────────────────────────────────────────────────── slugs ── */

/**
 * A readable, stable URL for a title.
 *
 * Suffixed with a short random tail rather than a counter: two posts called
 * "Winter paw care" a year apart should both work, and a counter means reading
 * the table before writing and racing anybody else doing the same.
 */
export function slugify(title, randomTail = null) {
  const base = String(title || "")
    .toLowerCase()
    .normalize("NFKD")
    // Escaped rather than written literally: the literal form is a run of
    // combining marks that every editor renders as a stray accent on the
    // bracket, which is unreadable and easy to corrupt in a later edit.
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "post";
  const tail = randomTail || Math.random().toString(36).slice(2, 8);
  return `${base}-${tail}`;
}
