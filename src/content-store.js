/**
 * Reading and writing posts, comments, threads and replies.
 *
 * Everything a surface needs, with the two rules that matter enforced here
 * rather than at each call site:
 *
 *   Tenancy. A provider post belongs to one clinic. A clinic may read, edit
 *   and withdraw its own and no other's, and every write takes the tenant from
 *   the session rather than from the request body — the same rule the rest of
 *   this codebase follows, and for the same reason.
 *
 *   Removal is not deletion. A post, comment or reply that an operator takes
 *   down keeps its row with who removed it and why. Someone asks, months
 *   later, what happened to a post; "it is gone" is not an answer a platform
 *   that hosts clinics' words can give.
 */

import { hasDatabase } from "./db.js";
import { postUrl, submitToIndexNow } from "./indexnow.js";
import { bylineFor, slugify } from "./content.js";

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function nowIso() {
  return new Date().toISOString();
}

function clean(value, maxLength) {
  return String(value == null ? "" : value).trim().slice(0, maxLength);
}

/* ─────────────────────────────────────────────────────────────── posts ── */

export function normalizePost(row, { includeBody = false } = {}) {
  if (!row) return null;
  const post = {
    id: row.id,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt || null,
    authorKind: row.author_kind,
    authorName: row.author_name || null,
    providerName: row.provider_name || null,
    tenantId: row.tenant_id || null,
    status: row.status,
    publishedAt: row.published_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    commentCount: row.comment_count == null ? undefined : Number(row.comment_count)
  };
  // The byline is attached server-side for the same reason the console's
  // status label is: four surfaces would otherwise each format it, and the
  // one that gets a provider post wrong publishes a veterinary claim in
  // TímiNOW's name. See src/content.js.
  post.byline = bylineFor(post);
  if (includeBody) post.bodyMarkdown = row.body_markdown;
  return post;
}

/** Published posts, newest first. The public list. */
export async function listPublishedPosts(env, { limit = 20, before = null } = {}) {
  if (!hasDatabase(env)) return [];
  const rows = before
    ? await env.DB.prepare(`
        SELECT p.*, (SELECT COUNT(*) FROM blog_comments c WHERE c.post_id = p.id AND c.status = 'visible') AS comment_count
        FROM blog_posts p WHERE p.status = 'published' AND p.published_at < ?
        ORDER BY p.published_at DESC LIMIT ?`).bind(before, limit).all()
    : await env.DB.prepare(`
        SELECT p.*, (SELECT COUNT(*) FROM blog_comments c WHERE c.post_id = p.id AND c.status = 'visible') AS comment_count
        FROM blog_posts p WHERE p.status = 'published'
        ORDER BY p.published_at DESC LIMIT ?`).bind(limit).all();
  return rows.results.map((row) => normalizePost(row));
}

export async function getPublishedPost(env, slug) {
  if (!hasDatabase(env)) return null;
  const row = await env.DB.prepare("SELECT * FROM blog_posts WHERE slug = ? AND status = 'published' LIMIT 1")
    .bind(String(slug || "")).first();
  return normalizePost(row, { includeBody: true });
}

/** Every post this clinic has written, whatever its state. Tenant-scoped. */
export async function listPostsForTenant(env, tenantId, { limit = 50 } = {}) {
  if (!hasDatabase(env) || !tenantId) return [];
  const rows = await env.DB.prepare(
    "SELECT * FROM blog_posts WHERE tenant_id = ? ORDER BY COALESCE(published_at, created_at) DESC LIMIT ?"
  ).bind(tenantId, limit).all();
  return rows.results.map((row) => normalizePost(row));
}

/** Everything, for the operator console — including what has been taken down. */
export async function listAllPosts(env, { limit = 100 } = {}) {
  if (!hasDatabase(env)) return [];
  const rows = await env.DB.prepare(
    "SELECT * FROM blog_posts ORDER BY COALESCE(published_at, created_at) DESC LIMIT ?"
  ).bind(limit).all();
  return rows.results.map((row) => normalizePost(row));
}

/**
 * Write a post.
 *
 * `author` comes from platformAuthorFor or providerAuthorFor in
 * src/content.js — never from the request. It carries the kind, which decides
 * the byline, and the tenant for a provider post.
 */
export async function createPost(env, author, { title, excerpt, bodyMarkdown, publish = false }) {
  if (!hasDatabase(env)) return { ok: false, code: "DATABASE_REQUIRED", message: "D1 is required to publish." };
  if (!author?.kind) return { ok: false, code: "NOT_AUTHORIZED", message: "You are not set up to publish posts." };

  const cleanTitle = clean(title, 160);
  const body = clean(bodyMarkdown, 60_000);
  if (cleanTitle.length < 3) return { ok: false, code: "TITLE_REQUIRED", message: "Give the post a title." };
  if (body.length < 20) return { ok: false, code: "BODY_REQUIRED", message: "The post needs a body." };

  const id = newId("post");
  const now = nowIso();
  await env.DB.prepare(`
    INSERT INTO blog_posts (
      id, slug, author_kind, tenant_id, author_user_id, author_name, provider_name,
      title, excerpt, body_markdown, status, published_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, slugify(cleanTitle), author.kind, author.tenantId || null, author.userId,
    author.name || null, author.providerName || null,
    cleanTitle, clean(excerpt, 400) || null, body,
    publish ? "published" : "draft", publish ? now : null, now, now
  ).run();

  const row = await env.DB.prepare("SELECT * FROM blog_posts WHERE id = ? LIMIT 1").bind(id).first();
  const post = normalizePost(row, { includeBody: true });
  // Announced here rather than by the caller, because there are two callers —
  // an operator in the admin console and a clinic in the veterinary console —
  // and a post that is announced from one path and not the other is the kind
  // of gap nobody notices until they wonder why half the posts index slowly.
  if (post.status === "published") await submitToIndexNow(env, [postUrl(post.slug)]);
  return { ok: true, post };
}

/**
 * Edit or publish a post.
 *
 * `scope` is the tenancy boundary: a clinic passes its own tenant id and the
 * UPDATE simply will not match another clinic's row, so a guessed post id gets
 * a 404 and not somebody else's article. An operator passes null and may touch
 * any of them.
 */
export async function updatePost(env, postId, { title, excerpt, bodyMarkdown, publish }, { tenantScope = null } = {}) {
  if (!hasDatabase(env)) return { ok: false, code: "DATABASE_REQUIRED", message: "D1 is required." };
  const existing = tenantScope
    ? await env.DB.prepare("SELECT * FROM blog_posts WHERE id = ? AND tenant_id = ? LIMIT 1").bind(postId, tenantScope).first()
    : await env.DB.prepare("SELECT * FROM blog_posts WHERE id = ? LIMIT 1").bind(postId).first();
  if (!existing) return { ok: false, code: "POST_NOT_FOUND", message: "That post was not found." };
  // A removed post is an operator's decision. Its author does not get to edit
  // their way back onto the site.
  if (existing.status === "removed") return { ok: false, code: "POST_REMOVED", message: "That post was removed by TímiNOW." };

  const now = nowIso();
  const nextTitle = title === undefined ? existing.title : clean(title, 160);
  const nextBody = bodyMarkdown === undefined ? existing.body_markdown : clean(bodyMarkdown, 60_000);
  const nextExcerpt = excerpt === undefined ? existing.excerpt : (clean(excerpt, 400) || null);
  let status = existing.status;
  let publishedAt = existing.published_at;
  if (publish === true) {
    status = "published";
    // First publication sets the date; a later edit does not re-date the post.
    publishedAt = existing.published_at || now;
  } else if (publish === false && existing.status === "published") {
    status = "withdrawn";
  }

  await env.DB.prepare(
    "UPDATE blog_posts SET title = ?, excerpt = ?, body_markdown = ?, status = ?, published_at = ?, updated_at = ? WHERE id = ?"
  ).bind(nextTitle, nextExcerpt, nextBody, status, publishedAt, now, postId).run();
  const row = await env.DB.prepare("SELECT * FROM blog_posts WHERE id = ? LIMIT 1").bind(postId).first();
  const updated = normalizePost(row, { includeBody: true });
  // On every edit of a live post, not only on first publish: a correction is
  // a change to a URL a search engine already holds, and telling it so is the
  // difference between the fix being visible today and next week.
  if (updated.status === "published") await submitToIndexNow(env, [postUrl(updated.slug)]);
  return { ok: true, post: updated };
}

/**
 * Take something down, as an operator.
 *
 * The one control that makes immediate provider publishing safe: a clinic can
 * post without waiting for us, and anything that turns out to be wrong stops
 * being public the moment somebody here says so. Reason recorded, row kept.
 */
export async function removeContent(env, { subjectType, subjectId, operatorId, reason }) {
  if (!hasDatabase(env)) return { ok: false, code: "DATABASE_REQUIRED", message: "D1 is required." };
  const table = { post: "blog_posts", comment: "blog_comments", thread: "forum_threads", reply: "forum_replies" }[subjectType];
  if (!table) return { ok: false, code: "SUBJECT_INVALID", message: "Unknown content type." };
  const now = nowIso();
  const result = await env.DB.prepare(
    `UPDATE ${table} SET status = 'removed', removed_at = ?, removed_by = ?, removed_reason = ? WHERE id = ?`
  ).bind(now, operatorId || null, clean(reason, 400) || null, subjectId).run();
  if (!(result.meta?.changes ?? 0)) return { ok: false, code: "NOT_FOUND", message: "That content was not found." };
  // Reports about it are resolved by the same act, so the queue does not keep
  // showing an operator something they have already dealt with.
  await env.DB.prepare(
    "UPDATE content_reports SET status = 'actioned', resolved_by = ?, resolved_at = ? WHERE subject_type = ? AND subject_id = ? AND status = 'open'"
  ).bind(operatorId || null, now, subjectType, subjectId).run();
  return { ok: true };
}

/* ──────────────────────────────────────────────────────────── comments ── */

export async function listComments(env, postId, { limit = 200 } = {}) {
  if (!hasDatabase(env)) return [];
  const rows = await env.DB.prepare(
    "SELECT id, author_name, body, created_at FROM blog_comments WHERE post_id = ? AND status = 'visible' ORDER BY created_at ASC LIMIT ?"
  ).bind(postId, limit).all();
  return rows.results.map((row) => ({
    id: row.id,
    authorName: row.author_name,
    body: row.body,
    createdAt: row.created_at
  }));
}

/**
 * Leave a comment. Signed-in only, and live immediately.
 *
 * The author's id is kept although only the name is shown: a comment nobody
 * can attribute is a comment nobody can be asked about, and moderation of an
 * anonymous pile-on is guesswork.
 */
export async function addComment(env, actor, postId, body) {
  if (!hasDatabase(env)) return { ok: false, code: "DATABASE_REQUIRED", message: "D1 is required." };
  if (!actor?.userId) return { ok: false, code: "SIGN_IN_REQUIRED", message: "Sign in to comment." };
  const text = clean(body, 4_000);
  if (text.length < 2) return { ok: false, code: "COMMENT_EMPTY", message: "Write something first." };

  const post = await env.DB.prepare("SELECT id FROM blog_posts WHERE id = ? AND status = 'published' LIMIT 1")
    .bind(postId).first();
  if (!post) return { ok: false, code: "POST_NOT_FOUND", message: "That post was not found." };

  const id = newId("comment");
  await env.DB.prepare(
    "INSERT INTO blog_comments (id, post_id, author_user_id, author_name, body, status, created_at) VALUES (?, ?, ?, ?, ?, 'visible', ?)"
  ).bind(id, postId, actor.userId, clean(actor.name || actor.email || "Member", 80), text, nowIso()).run();
  return { ok: true, comment: { id, authorName: clean(actor.name || "Member", 80), body: text, createdAt: nowIso() } };
}

/* ─────────────────────────────────────────────────────────────── forum ── */

export function normalizeThread(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    kind: row.kind,
    title: row.title,
    body: row.body,
    authorName: row.author_name,
    authorKind: row.author_kind,
    providerName: row.provider_name || null,
    status: row.status,
    replyCount: Number(row.reply_count || 0),
    answeredReplyId: row.answered_reply_id || null,
    lastActivityAt: row.last_activity_at,
    createdAt: row.created_at
  };
}

export async function listThreads(env, { kind = null, limit = 30 } = {}) {
  if (!hasDatabase(env)) return [];
  const rows = kind
    ? await env.DB.prepare("SELECT * FROM forum_threads WHERE status <> 'removed' AND kind = ? ORDER BY last_activity_at DESC LIMIT ?").bind(kind, limit).all()
    : await env.DB.prepare("SELECT * FROM forum_threads WHERE status <> 'removed' ORDER BY last_activity_at DESC LIMIT ?").bind(limit).all();
  return rows.results.map(normalizeThread);
}

export async function getThread(env, slug) {
  if (!hasDatabase(env)) return null;
  const row = await env.DB.prepare("SELECT * FROM forum_threads WHERE slug = ? AND status <> 'removed' LIMIT 1").bind(String(slug || "")).first();
  if (!row) return null;
  const replies = await env.DB.prepare(
    "SELECT * FROM forum_replies WHERE thread_id = ? AND status = 'visible' ORDER BY created_at ASC LIMIT 500"
  ).bind(row.id).all();
  return {
    thread: normalizeThread(row),
    replies: replies.results.map((reply) => ({
      id: reply.id,
      body: reply.body,
      authorName: reply.author_name,
      authorKind: reply.author_kind,
      providerName: reply.provider_name || null,
      createdAt: reply.created_at
    }))
  };
}

/**
 * Start a thread.
 *
 * `authorKind` is resolved from the session, never sent by the client: a
 * member claiming to be a clinic in a thread about whether to go to the vet
 * tonight is the exact failure this forum must not have.
 */
export async function createThread(env, actor, { kind, title, body }, { identity = null } = {}) {
  if (!hasDatabase(env)) return { ok: false, code: "DATABASE_REQUIRED", message: "D1 is required." };
  if (!actor?.userId) return { ok: false, code: "SIGN_IN_REQUIRED", message: "Sign in to post." };
  const threadKind = kind === "question" ? "question" : "discussion";
  const cleanTitle = clean(title, 160);
  const text = clean(body, 20_000);
  if (cleanTitle.length < 3) return { ok: false, code: "TITLE_REQUIRED", message: "Give it a title." };
  if (text.length < 2) return { ok: false, code: "BODY_REQUIRED", message: "Write something first." };

  const id = newId("thread");
  const now = nowIso();
  await env.DB.prepare(`
    INSERT INTO forum_threads (id, slug, kind, title, body, author_user_id, author_name, author_kind, tenant_id, provider_name, status, last_activity_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
  `).bind(
    id, slugify(cleanTitle), threadKind, cleanTitle, text, actor.userId,
    clean(identity?.name || actor.name || actor.email || "Member", 80),
    identity?.kind || "member", identity?.tenantId || null, identity?.providerName || null, now, now
  ).run();
  const row = await env.DB.prepare("SELECT * FROM forum_threads WHERE id = ? LIMIT 1").bind(id).first();
  return { ok: true, thread: normalizeThread(row) };
}

export async function addReply(env, actor, threadId, body, { identity = null } = {}) {
  if (!hasDatabase(env)) return { ok: false, code: "DATABASE_REQUIRED", message: "D1 is required." };
  if (!actor?.userId) return { ok: false, code: "SIGN_IN_REQUIRED", message: "Sign in to reply." };
  const text = clean(body, 20_000);
  if (text.length < 2) return { ok: false, code: "BODY_REQUIRED", message: "Write something first." };

  const thread = await env.DB.prepare("SELECT id, status FROM forum_threads WHERE id = ? LIMIT 1").bind(threadId).first();
  if (!thread || thread.status === "removed") return { ok: false, code: "THREAD_NOT_FOUND", message: "That thread was not found." };
  if (thread.status === "locked") return { ok: false, code: "THREAD_LOCKED", message: "That thread is closed to new replies." };

  const id = newId("reply");
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO forum_replies (id, thread_id, body, author_user_id, author_name, author_kind, tenant_id, provider_name, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'visible', ?)
    `).bind(id, threadId, text, actor.userId, clean(identity?.name || actor.name || actor.email || "Member", 80),
      identity?.kind || "member", identity?.tenantId || null, identity?.providerName || null, now),
    // Counted rather than derived, so a thread list does not run one COUNT per
    // row to sort a page of thirty.
    env.DB.prepare("UPDATE forum_threads SET reply_count = reply_count + 1, last_activity_at = ? WHERE id = ?").bind(now, threadId)
  ]);
  return { ok: true, replyId: id };
}

/* ───────────────────────────────────────────────────────────── reports ── */

/**
 * Report something.
 *
 * INSERT OR IGNORE against the unique key, so pressing report twice is one
 * report — without it a single determined reader looks like a pile-on, and the
 * queue an operator works is sorted by how upset one person is.
 */
export async function reportContent(env, actor, { subjectType, subjectId, reason, detail }) {
  if (!hasDatabase(env)) return { ok: false, code: "DATABASE_REQUIRED", message: "D1 is required." };
  if (!actor?.userId) return { ok: false, code: "SIGN_IN_REQUIRED", message: "Sign in to report." };
  if (!["post", "comment", "thread", "reply"].includes(subjectType)) {
    return { ok: false, code: "SUBJECT_INVALID", message: "Unknown content type." };
  }
  await env.DB.prepare(
    "INSERT OR IGNORE INTO content_reports (id, subject_type, subject_id, reporter_user_id, reason, detail, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)"
  ).bind(newId("report"), subjectType, subjectId, actor.userId, clean(reason, 60) || "other", clean(detail, 1_000) || null, nowIso()).run();
  return { ok: true };
}

/** The operator queue: what is reported and not yet dealt with. */
export async function listOpenReports(env, { limit = 100 } = {}) {
  if (!hasDatabase(env)) return [];
  const rows = await env.DB.prepare(
    "SELECT * FROM content_reports WHERE status = 'open' ORDER BY created_at DESC LIMIT ?"
  ).bind(limit).all();
  return rows.results.map((row) => ({
    id: row.id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    reason: row.reason,
    detail: row.detail || null,
    createdAt: row.created_at
  }));
}

export async function dismissReport(env, reportId, operatorId) {
  if (!hasDatabase(env)) return { ok: false };
  await env.DB.prepare(
    "UPDATE content_reports SET status = 'dismissed', resolved_by = ?, resolved_at = ? WHERE id = ? AND status = 'open'"
  ).bind(operatorId || null, nowIso(), reportId).run();
  return { ok: true };
}
