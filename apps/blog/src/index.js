/**
 * TímiNOW blog and community Worker (timinow-blog), served at
 * blog.timinow.pet.
 *
 * A thin router, like the veterinary and admin Workers: the rules about who
 * may write what, and whose name goes on it, live in ../../../src/content.js
 * and ../../../src/content-store.js and are shared with every other surface.
 * This file decides routes, headers and what is public.
 *
 * What is public and what is not:
 *
 *   Reading   — posts, comments, threads and replies are readable by anyone,
 *               signed in or not. A blog behind a login is not a blog.
 *   Writing   — every write needs a Clerk session. Comments and forum posts
 *               appear immediately, which is only survivable because every
 *               piece of content is attributable, reportable, and removable
 *               by an operator.
 *   Subscribe — open, because asking someone to make an account to receive an
 *               email is how a mailing list stays empty. Double opt-in is what
 *               makes an open form safe; see src/blog-subscriptions.js.
 *
 * The forum carries two kinds of thread — open discussion and questions for
 * clinics — and both sit under the same notice: nothing here is veterinary
 * advice and reading it makes nobody anybody's patient. That notice is not
 * decoration on a site where the readership is people with a sick animal
 * deciding what to do tonight.
 */

import { actorForRequest } from "../../../src/auth.js";
import { publicConfig } from "../../../src/config.js";
import { hasDatabase, tenantIdForClerkOrg } from "../../../src/db.js";
import { isPlatformAdmin } from "../../../src/tenancy.js";
import { NOT_ADVICE, platformAuthorFor, providerAuthorFor } from "../../../src/content.js";
import { renderMarkdown } from "../../../src/markdown.js";
import {
  addComment,
  addReply,
  createThread,
  getPublishedPost,
  getThread,
  listComments,
  listPublishedPosts,
  listThreads,
  reportContent
} from "../../../src/content-store.js";
import { confirmSubscription, requestSubscription, unsubscribe } from "../../../src/blog-subscriptions.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

// Kept in step with docs/SUBPROCESSORS.md by scripts/check-subprocessors.mjs
// — see the identical comment in src/index.js (the customer Worker).
//
// No image host beyond this origin and data:. A blog that renders images from
// wherever an author names is a blog whose readers' addresses are logged by
// whoever the author names, and on this site the reader is somebody looking up
// a symptom.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
    // clerk.timinow.pet is in script-src because the headless clerk-js loaded
  // from jsDelivr is only a loader: it injects a <script> for the real bundle,
  // served from the Frontend API domain
  // (https://clerk.timinow.pet/npm/@clerk/clerk-js@5.x/dist/clerk.browser.js,
  // which answers 200). Without it clerk.load() fails with "Unable to load
  // Clerk" and nobody can sign in.
  //
  // This was missing from every Worker and did not matter for as long as no
  // page had a CSP at all — `run_worker_first: ["/api/*"]` meant the policy
  // only ever reached /api/* responses. Enforcing it on pages (the _headers
  // fix) is what surfaced it, on all four surfaces at once.
  "script-src 'self' https://clerk.timinow.pet https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline'",
  // blob: and img.clerk.com because Clerk renders avatars from both. This
  // surface shows none today, but it is the one Clerk-bearing CSP that
  // differed from the three that work, and a page CSP has only been enforced
  // at all since the _headers fix — so "it was fine before" proves nothing
  // about any of these directives.
  "img-src 'self' data: blob: https://img.clerk.com",
  "font-src 'self' data:",
  "connect-src 'self' https://clerk.timinow.pet",
  // clerk-js keeps a session alive from a Worker built out of a blob URL.
  // Chromium allowed it under this CSP when I tested the mechanism directly,
  // so this is parity with the working surfaces rather than the fix for the
  // failure at hand — Safari and Firefox are stricter about blob: workers
  // than Chromium is, and this page is being used on Safari.
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

export const SECURITY_HEADERS = {
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), payment=(), geolocation=()",
  "content-security-policy": CONTENT_SECURITY_POLICY
};

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { ...JSON_HEADERS, ...SECURITY_HEADERS, ...(init.headers || {}) }
  });
}

function apiError(status, code, message) {
  return json({ error: { code, message } }, { status });
}

async function readJson(request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 64_000) throw new Error("PAYLOAD_TOO_LARGE");
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new Error("JSON_REQUIRED");
  }
  return request.json();
}

/** The one place a result object becomes an HTTP answer. */
function respond(result, { status = 200 } = {}) {
  if (!result?.ok) {
    const code = result?.code || "REQUEST_FAILED";
    const httpStatus = code === "SIGN_IN_REQUIRED" ? 401
      : code === "DATABASE_REQUIRED" ? 503
      : /NOT_FOUND/.test(code) ? 404
      : code === "NOT_AUTHORIZED" ? 403
      : 422;
    return apiError(httpStatus, code, result?.message || "That did not work.");
  }
  return json(result, { status });
}

/**
 * Who this person is when they write in the forum.
 *
 * Resolved from the session on every write, never read from the request. A
 * member claiming to be a clinic, in a thread about whether an animal needs to
 * be seen tonight, is the single worst thing this forum could allow — so the
 * badge comes from the same membership row that governs whether they may post
 * for that clinic at all.
 */
async function forumIdentity(env, request, actor) {
  if (!actor?.userId) return null;
  const admin = await isPlatformAdmin(env, actor);
  const platform = await platformAuthorFor(env, actor, { isAdmin: admin, adminName: actor.name });
  if (platform) return platform;
  const tenantId = actor.tenantId || (actor.clerkOrgId ? await tenantIdForClerkOrg(env, actor.clerkOrgId) : null);
  if (tenantId) {
    const provider = await providerAuthorFor(env, actor, tenantId);
    if (provider) return provider;
  }
  return { kind: "member", userId: actor.userId, name: actor.name || actor.email || "Member" };
}

async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method.toUpperCase();
  const actor = await actorForRequest(request, env).catch(() => null);

  /* ── reading: open to everyone ── */

  // Every Worker answers this; the deploy workflow curls all of them.
  if (method === "GET" && path === "/api/health") {
    return json({ ok: true, service: "timinow-blog", build: env.GIT_SHA || null, database: hasDatabase(env) });
  }

  if (method === "GET" && path === "/api/config") {
    return json({ ...(await publicConfig(env)), notAdvice: NOT_ADVICE });
  }

  if (method === "GET" && path === "/api/posts") {
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));
    return json({ posts: await listPublishedPosts(env, { limit, before: url.searchParams.get("before") }) });
  }

  const postMatch = path.match(/^\/api\/posts\/([^/]+)$/);
  if (method === "GET" && postMatch) {
    const post = await getPublishedPost(env, decodeURIComponent(postMatch[1]));
    if (!post) return apiError(404, "POST_NOT_FOUND", "That post was not found.");
    return json({
      post,
      // Rendered here rather than in the browser: the sanitiser is the one
      // thing between a clinic's post and every reader, and it belongs on the
      // server where it cannot be skipped by a client that failed to load it.
      html: renderMarkdown(post.bodyMarkdown),
      comments: await listComments(env, post.id),
      notAdvice: NOT_ADVICE
    });
  }

  if (method === "GET" && path === "/api/threads") {
    const kind = url.searchParams.get("kind");
    return json({ threads: await listThreads(env, { kind: kind === "question" || kind === "discussion" ? kind : null }) });
  }

  const threadMatch = path.match(/^\/api\/threads\/([^/]+)$/);
  if (method === "GET" && threadMatch) {
    const found = await getThread(env, decodeURIComponent(threadMatch[1]));
    if (!found) return apiError(404, "THREAD_NOT_FOUND", "That thread was not found.");
    return json({ ...found, notAdvice: NOT_ADVICE });
  }

  /* ── subscriptions: open, because double opt-in is the gate ── */

  if (method === "POST" && path === "/api/subscribe") {
    const body = await readJson(request).catch(() => ({}));
    const result = await requestSubscription(env, {
      email: body?.email,
      source: "blog",
      confirmURL: `${url.origin}/subscribe/confirm`
    });
    if (!result.ok) return apiError(422, result.code, result.message);
    // Deliberately the same answer whether the address was new, pending or
    // already confirmed — see requestSubscription. A form that distinguishes
    // them is a form that discloses who is on the list.
    return json({ ok: true, message: "Check that inbox for a confirmation link." });
  }

  if (method === "POST" && path === "/api/subscribe/confirm") {
    const body = await readJson(request).catch(() => ({}));
    return json(await confirmSubscription(env, body?.token));
  }

  if (method === "POST" && path === "/api/unsubscribe") {
    const body = await readJson(request).catch(() => ({}));
    return json(await unsubscribe(env, body?.token));
  }

  /* ── writing: signed in, every time ── */

  if (!actor?.userId) {
    const writes = ["/api/comments", "/api/threads", "/api/replies", "/api/reports"];
    if (method === "POST" && writes.some((prefix) => path === prefix)) {
      return apiError(401, "SIGN_IN_REQUIRED", "Sign in to take part.");
    }
  }

  if (method === "POST" && path === "/api/comments") {
    const body = await readJson(request).catch(() => ({}));
    return respond(await addComment(env, actor, body?.postId, body?.body), { status: 201 });
  }

  if (method === "POST" && path === "/api/threads") {
    const body = await readJson(request).catch(() => ({}));
    const identity = await forumIdentity(env, request, actor);
    return respond(await createThread(env, actor, body || {}, { identity }), { status: 201 });
  }

  if (method === "POST" && path === "/api/replies") {
    const body = await readJson(request).catch(() => ({}));
    const identity = await forumIdentity(env, request, actor);
    return respond(await addReply(env, actor, body?.threadId, body?.body, { identity }), { status: 201 });
  }

  if (method === "POST" && path === "/api/reports") {
    const body = await readJson(request).catch(() => ({}));
    return respond(await reportContent(env, actor, body || {}), { status: 202 });
  }

  return apiError(404, "NOT_FOUND", "No such endpoint.");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (error) {
        if (error.message === "PAYLOAD_TOO_LARGE") return apiError(413, "PAYLOAD_TOO_LARGE", "That is too long.");
        if (error.message === "JSON_REQUIRED") return apiError(415, "JSON_REQUIRED", "Send JSON.");
        console.error(JSON.stringify({ event: "blog_error", path: url.pathname, message: error.message }));
        return apiError(500, "INTERNAL_ERROR", "Something went wrong.");
      }
    }

    // Everything else is the single-page app. Its own routes (/p/:slug,
    // /forum, /subscribe/confirm) are resolved in the browser, so any path
    // that is not an asset returns the shell — the `not_found_handling`
    // setting in wrangler.blog.jsonc does that, and this is the fallback for
    // a deployment without the assets binding.
    if (!env.ASSETS) return new Response("Not found", { status: 404, headers: SECURITY_HEADERS });
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
    return new Response(response.body, { status: response.status, headers });
  },

};
