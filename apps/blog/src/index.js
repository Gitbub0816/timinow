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
  SITE,
  canonicalUrl,
  isoDate,
  llmsTxt,
  metaDescription,
  plainText,
  robotsTxt,
  rssXml,
  sitemapXml
} from "../../../src/seo.js";
import {
  renderForum,
  renderNoIndex,
  renderNotFound,
  renderPost,
  renderPostList,
  renderThread
} from "./pages.js";
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
  // clerk.timinow.pet is in script-src because the browser now loads clerk-js
  // *from* the Frontend API domain: Clerk proxies the same build a CDN would
  // serve at <issuer>/npm/@clerk/clerk-js@5/headless/+esm, and it is the one
  // host sign-in cannot work without anyway. It is in connect-src for the
  // session calls that follow. See defaultClerkJsUrl in src/config.js.
  //
  // The comment that stood here said the headless build was "only a loader"
  // that injects a second <script> from this host. That was wrong, and it was
  // wrong because it was reasoned out from a bug report instead of watched:
  // driving this exact policy in a browser shows the headless build is the
  // whole SDK, and that it starts its session worker from a blob: URL, which
  // is what worker-src is really for.
  //
  // The policy reached no page at all for as long as
  // `run_worker_first: ["/api/*"]` meant this Worker never ran for one;
  // enforcing it (the _headers fix) is what surfaced the missing host, on all
  // four surfaces at once.
  // Cloudflare Web Analytics. The beacon is injected at the edge by the
  // zone's own Web Analytics setting, not by any markup in this repository —
  // so leaving it out of the policy did not stop it being added, it only made
  // every page log a CSP refusal and the analytics silently not work. It is
  // cookieless, carries no personal data, and goes to Cloudflare, which
  // already serves and stores everything here. To stop it, turn Web Analytics
  // off for the zone in the Cloudflare dashboard and delete these two hosts
  // (docs/SUBPROCESSORS.md moves with them — see rule 3).
  "script-src 'self' https://clerk.timinow.pet https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline'",
  // blob: and img.clerk.com because Clerk renders avatars from both. This
  // surface shows none today, but it is the one Clerk-bearing CSP that
  // differed from the three that work, and a page CSP has only been enforced
  // at all since the _headers fix — so "it was fine before" proves nothing
  // about any of these directives.
  "img-src 'self' data: blob: https://img.clerk.com",
  "font-src 'self' data:",
  "connect-src 'self' https://clerk.timinow.pet https://cloudflareinsights.com",
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

/* ═══════════════════════════════════════════ the crawlable surface ═══ */

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  // Short enough that a correction to a post is live in minutes, long enough
  // that a crawler working through an index does not re-render every page
  // against D1. These pages are identical for every reader — the signed-in
  // parts arrive with app.js — so there is nothing personal to leak into a
  // shared cache.
  "cache-control": "public, max-age=60, s-maxage=300, stale-while-revalidate=86400"
};

const TEXT_HEADERS = { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" };
const XML_HEADERS = { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=900" };

function page(html, { status = 200 } = {}) {
  return new Response(html, { status, headers: { ...HTML_HEADERS, ...SECURITY_HEADERS } });
}

/**
 * The single-page shell, fetched from the asset binding so it stays the one
 * place the page's furniture is defined.
 *
 * `/index.html` explicitly rather than `/`: asking the asset binding for the
 * root path goes back through not_found_handling and can return the shell for
 * a path this Worker is in the middle of rendering, which is a loop that ends
 * in a stack overflow rather than an error anybody can read.
 */
async function shellFor(env, url) {
  if (!env.ASSETS) return null;
  const response = await env.ASSETS.fetch(new Request(new URL("/index.html", url), { method: "GET" }));
  if (!response.ok) return null;
  return response.text();
}

/**
 * Posts and threads, as a sitemap.
 *
 * Drawn from D1 on request rather than written at deploy time, because the
 * whole point of a blog that clinics can post to is that its URLs appear
 * between deploys. A sitemap generated at build time would list what existed
 * when somebody last shipped code.
 */
async function sitemap(env) {
  const [posts, threads] = await Promise.all([
    listPublishedPosts(env, { limit: 1000 }).catch(() => []),
    listThreads(env, { limit: 1000 }).catch(() => [])
  ]);
  const entries = [
    { loc: canonicalUrl(SITE.blogOrigin, "/"), changefreq: "daily", priority: 0.9 },
    { loc: canonicalUrl(SITE.blogOrigin, "/forum"), changefreq: "hourly", priority: 0.8 }
  ];
  for (const post of posts) {
    entries.push({
      loc: canonicalUrl(SITE.blogOrigin, `/p/${post.slug}`),
      lastmod: isoDate(post.updatedAt || post.publishedAt),
      changefreq: "monthly",
      priority: 0.8
    });
  }
  for (const thread of threads) {
    entries.push({
      loc: canonicalUrl(SITE.blogOrigin, `/t/${thread.slug}`),
      lastmod: isoDate(thread.lastActivityAt || thread.createdAt),
      changefreq: "weekly",
      priority: 0.6
    });
  }
  return sitemapXml(entries);
}

async function feed(env) {
  const posts = await listPublishedPosts(env, { limit: 50 }).catch(() => []);
  return rssXml({
    title: "Notes — Tími NOW",
    link: SITE.blogOrigin,
    feedUrl: `${SITE.blogOrigin}/feed.xml`,
    description: "Writing from Tími NOW and from the veterinary clinics on it.",
    items: posts.map((post) => ({
      title: post.title,
      link: canonicalUrl(SITE.blogOrigin, `/p/${post.slug}`),
      published: post.publishedAt,
      author: post.authorName || post.providerName || SITE.name,
      description: post.excerpt || ""
    }))
  });
}

/**
 * Routes that answer with real content, before any JavaScript runs.
 *
 * Returns null for anything it does not handle, so the asset pipeline below
 * keeps serving styles, scripts and images untouched.
 */
async function handlePage(request, env, url) {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/robots.txt") {
    return new Response(robotsTxt({
      sitemaps: [`${SITE.blogOrigin}/sitemap.xml`],
      // /api/ is JSON for the app; /subscribe/ carries single-use tokens out
      // of confirmation emails and must never be fetched by anything but the
      // person who received it.
      disallow: ["/api/", "/subscribe/"],
      host: "blog.timinow.pet"
    }), { headers: { ...TEXT_HEADERS, ...SECURITY_HEADERS } });
  }

  if (path === "/sitemap.xml") {
    return new Response(await sitemap(env), { headers: { ...XML_HEADERS, ...SECURITY_HEADERS } });
  }

  if (path === "/feed.xml") {
    return new Response(await feed(env), { headers: { ...XML_HEADERS, ...SECURITY_HEADERS } });
  }

  if (path === "/llms.txt") {
    return new Response(llmsTxt({
      title: "Tími NOW — notes and community",
      summary: "Writing about getting a pet seen by a veterinarian, from Tími NOW and from the clinics on it, "
        + "plus a forum where owners ask questions and clinics answer. Nothing here is veterinary advice.",
      sections: [
        {
          heading: "Start here",
          links: [
            { title: "All notes", url: `${SITE.blogOrigin}/`, note: "every published post, newest first" },
            { title: "Community", url: `${SITE.blogOrigin}/forum`, note: "questions for clinics and discussion between owners" },
            { title: "RSS", url: `${SITE.blogOrigin}/feed.xml` },
            { title: "Sitemap", url: `${SITE.blogOrigin}/sitemap.xml` }
          ]
        },
        {
          heading: "The product these notes come from",
          note: SITE.description,
          links: [{ title: "Tími NOW", url: SITE.customerOrigin }]
        },
        {
          heading: "If you are quoting this site",
          note: "Posts marked as written by a clinic are that clinic's own words; Tími NOW hosts them and does not "
            + "review or endorse them. No page here establishes a veterinarian-client-patient relationship, and an "
            + "animal in distress needs a veterinarian, not a search result."
        }
      ]
    }), { headers: { ...TEXT_HEADERS, ...SECURITY_HEADERS } });
  }

  const shell = await shellFor(env, url);
  if (!shell) return null;

  if (path === "/") {
    return page(renderPostList(shell, await listPublishedPosts(env, { limit: 30 }).catch(() => [])));
  }

  if (path === "/forum") {
    return page(renderForum(shell, await listThreads(env, { limit: 50 }).catch(() => [])));
  }

  const postMatch = path.match(/^\/p\/([^/]+)$/);
  if (postMatch) {
    const post = await getPublishedPost(env, decodeURIComponent(postMatch[1])).catch(() => null);
    if (!post) return page(renderNotFound(shell, { path }), { status: 404 });
    const comments = await listComments(env, post.id).catch(() => []);
    return page(renderPost(shell, post, { html: renderMarkdown(post.bodyMarkdown), comments }));
  }

  const threadMatch = path.match(/^\/t\/([^/]+)$/);
  if (threadMatch) {
    const found = await getThread(env, decodeURIComponent(threadMatch[1])).catch(() => null);
    if (!found) return page(renderNotFound(shell, { path }), { status: 404 });
    return page(renderThread(shell, found));
  }

  if (path === "/subscribe/confirm") {
    return page(renderNoIndex(shell, {
      path,
      title: "Confirming your subscription — Tími NOW",
      description: "Completing an email subscription confirmation."
    }));
  }

  return null;
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

    // Content routes answer with their content. Anything this does not claim
    // falls through to the assets below exactly as before.
    try {
      const rendered = await handlePage(request, env, url);
      if (rendered) return rendered;
    } catch (error) {
      // A rendering failure must not take the page down: fall through to the
      // shell, which still works in a browser. The log is how this gets
      // noticed, since the visitor sees a working site either way.
      console.error(JSON.stringify({ event: "blog_render_failed", path: url.pathname, message: error.message }));
    }

    // Everything else is the single-page app: assets, and the shell for any
    // route rendered in the browser. `not_found_handling` in
    // wrangler.blog.jsonc serves the shell for unmatched paths, and this is
    // the fallback for a deployment without the assets binding.
    if (!env.ASSETS) return new Response("Not found", { status: 404, headers: SECURITY_HEADERS });
    const response = await env.ASSETS.fetch(request);

    // `not_found_handling` is "none", so an address that is not an asset and
    // not a route arrives here as a 404 rather than as the shell with a 200.
    // Render the real page for it, because a 404 somebody reads is still a
    // page and should say where to go.
    if (response.status === 404 && (request.method === "GET" || request.method === "HEAD")) {
      const shell = await shellFor(env, url).catch(() => null);
      if (shell) {
        return new Response(renderNotFound(shell, { path: url.pathname }), {
          status: 404,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS }
        });
      }
    }

    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
    return new Response(response.body, { status: response.status, headers });
  },

};
