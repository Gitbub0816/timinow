/**
 * The blog, rendered on the server.
 *
 * Every URL here previously answered with the same empty single-page shell.
 * A browser filled it in from /api a moment later and nobody noticed, because
 * everybody testing it was a browser. To a crawler — and much more so to an
 * assistant answering "what should I do if my dog ate a grape", which mostly
 * does not run JavaScript at all — blog.timinow.pet/p/anything was a page with
 * a loading message on it. Every post this company writes was invisible to the
 * exact readership it was written for.
 *
 * So each route below renders its real content into the shell before the
 * response leaves the Worker: the title, the byline, the body, the comments,
 * the replies, the notice. `app.js` removes the `[data-ssr]` block on boot and
 * takes over, so the interactive behaviour is unchanged and the served HTML is
 * complete on its own.
 *
 * Two rules for anything added here:
 *
 *   The server-rendered copy is the same copy. Not a summary, not a teaser
 *   with "open the app to read" under it. A page that shows a crawler
 *   something other than what it shows a person is cloaking, and search
 *   engines treat it as such.
 *
 *   The advice notice ships inside the rendered body, not bolted on by
 *   script. It is the sentence most likely to be quoted out of context by an
 *   assistant summarising a post about a sick animal, and it has to travel
 *   with the words it qualifies.
 */

import { NOT_ADVICE } from "../../../src/content.js";
import { escapeHtml, renderMarkdown } from "../../../src/markdown.js";
import {
  SITE,
  articleSchema,
  breadcrumbSchema,
  canonicalUrl,
  discussionSchema,
  graph,
  headTags,
  isoDate,
  metaDescription,
  organizationSchema,
  plainText,
  renderIntoShell,
  websiteSchema
} from "../../../src/seo.js";

/**
 * Canonical base for every blog URL. Absolute for canonicals and schema,
 * `SITE.blogPath` for in-page hrefs — the two must agree or a crawler follows
 * a link to one address and is told the page lives at another.
 */
const BLOG = SITE.blogBase;
const P = SITE.blogPath;

/** Human dates, in the one format the rest of the site uses. */
function formatDate(value) {
  const iso = isoDate(value);
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

/** `<time>` rather than a bare string: the machine-readable half is free. */
function timeTag(value) {
  const iso = isoDate(value);
  if (!iso) return "";
  return `<time datetime="${escapeHtml(iso)}">${escapeHtml(formatDate(value))}</time>`;
}

/**
 * The blog's own identity, repeated on every page in the graph.
 *
 * `Blog` rather than `WebSite`: this is a publication that belongs to the
 * organisation on timinow.pet, and saying so is how the two entities are
 * connected rather than competing.
 */
function blogSchema() {
  return {
    "@type": "Blog",
    "@id": `${BLOG}/#blog`,
    url: BLOG,
    name: "Notes — Tími NOW",
    description: "Writing from Tími NOW and from the veterinary clinics on it, plus a community forum for pet owners.",
    publisher: { "@id": `${SITE.customerOrigin}/#organization` },
    inLanguage: "en-US"
  };
}

const SITE_NODES = [organizationSchema(), websiteSchema(), blogSchema()];

/** The notice, as markup, in the body where it belongs. */
function adviceNotice() {
  return `<p class="advice-strip" role="note">${escapeHtml(NOT_ADVICE)}</p>`;
}

/* ──────────────────────────────────────────────────────────── post list ── */

function postCard(post) {
  const url = `${BLOG}/p/${encodeURIComponent(post.slug)}`;
  const byline = post.byline?.line || "";
  const excerpt = post.excerpt || "";
  return [
    `<article class="post-card">`,
    `  <h2><a href="${P}/p/${escapeHtml(post.slug)}">${escapeHtml(post.title)}</a></h2>`,
    byline ? `  <p class="eyebrow">${escapeHtml(byline)}</p>` : "",
    post.publishedAt ? `  <p class="post-meta">${timeTag(post.publishedAt)}</p>` : "",
    excerpt ? `  <p>${escapeHtml(excerpt)}</p>` : "",
    `  <p><a href="${P}/p/${escapeHtml(post.slug)}">Read ${escapeHtml(post.title)}</a></p>`,
    `</article>`,
    // The absolute URL appears nowhere a reader sees it; it is here so the
    // itemListElement below and the visible link cannot drift apart.
    `<!-- ${escapeHtml(url)} -->`
  ].filter(Boolean).join("\n");
}

export function renderPostList(shell, posts) {
  const canonical = canonicalUrl(BLOG, "/");
  const title = "Notes on veterinary care — Tími NOW";
  const description =
    "Plain writing about getting a pet seen: what counts as an emergency, what a clinic needs to know when you arrive, "
    + "and what it costs. Written by Tími NOW and by the veterinary clinics on it.";

  const body = [
    `<div class="masthead">`,
    `  <h1>Notes</h1>`,
    `  <p>${escapeHtml(description)}</p>`,
    `</div>`,
    adviceNotice(),
    posts.length
      ? `<div class="post-list">\n${posts.map(postCard).join("\n")}\n</div>`
      : `<p class="empty">No posts published yet.</p>`,
    `<p><a href="${P}/forum">Community — questions for clinics, and talk between owners</a></p>`,
    `<p><a href="${P}/feed.xml">Subscribe by RSS</a> · <a href="${escapeHtml(SITE.customerOrigin)}">Find veterinary care that is open now</a></p>`
  ].join("\n");

  const head = headTags({
    title,
    description,
    canonical,
    type: "website",
    feed: `${BLOG}/feed.xml`
  }) + "\n  " + graph([
    ...SITE_NODES,
    {
      "@type": "CollectionPage",
      "@id": `${canonical}#page`,
      url: canonical,
      name: title,
      description: metaDescription(description),
      isPartOf: { "@id": `${BLOG}/#blog` },
      mainEntity: {
        "@type": "ItemList",
        itemListElement: posts.map((post, index) => ({
          "@type": "ListItem",
          position: index + 1,
          url: `${BLOG}/p/${encodeURIComponent(post.slug)}`,
          name: post.title
        }))
      }
    }
  ]);

  return renderIntoShell(shell, { head, body });
}

/* ──────────────────────────────────────────────────────────── one post ── */

function commentList(comments) {
  if (!comments.length) return "";
  const items = comments.map((comment) => [
    `  <li>`,
    `    <p class="comment-meta">${escapeHtml(comment.authorName || "Member")}${comment.createdAt ? ` · ${timeTag(comment.createdAt)}` : ""}</p>`,
    `    <p>${escapeHtml(comment.body)}</p>`,
    `  </li>`
  ].join("\n")).join("\n");
  return `<section class="comments">\n  <h2>Comments</h2>\n  <ol class="comment-list">\n${items}\n  </ol>\n</section>`;
}

/**
 * "Reviewed by Dr. Ana Rivera, DVM, on 12 September 2026", or nothing.
 *
 * Rendered from stored fields only — never inferred, never defaulted. This
 * one line is a statement that a named, licensed person read a page about a
 * sick animal and stands behind it, and there is no version of inventing it
 * that is acceptable.
 */
function reviewLine(post) {
  if (!post?.reviewer?.name) return "";
  const who = post.reviewer.credentials
    ? `${post.reviewer.name}, ${post.reviewer.credentials}`
    : post.reviewer.name;
  const when = post.reviewer.reviewedAt ? ` on ${formatDate(post.reviewer.reviewedAt)}` : "";
  return `  <p class="review-line">Reviewed by ${escapeHtml(who)}${escapeHtml(when)}.</p>`;
}

export function renderPost(shell, post, { html, comments = [] }) {
  const canonical = canonicalUrl(BLOG, `/p/${post.slug}`);
  const byline = post.byline?.line || "";
  const description = metaDescription(post.excerpt || plainText(post.bodyMarkdown));
  const published = isoDate(post.publishedAt);
  const modified = isoDate(post.updatedAt);

  const body = [
    `<nav class="breadcrumb" aria-label="Breadcrumb"><a href="${P}/">Notes</a> › <span>${escapeHtml(post.title)}</span></nav>`,
    `<article class="post">`,
    byline ? `  <p class="eyebrow">${escapeHtml(byline)}</p>` : "",
    `  <h1>${escapeHtml(post.title)}</h1>`,
    post.publishedAt ? `  <p class="post-meta">Published ${timeTag(post.publishedAt)}</p>` : "",
    // A clinic's post carries the non-endorsement beside the byline, exactly
    // as the interactive page shows it. Dropping it from the crawlable copy
    // would leave the quotable version of the page making a claim in Tími's
    // name that the page itself does not make.
    post.byline?.notice ? `  <p class="provider-notice">${escapeHtml(post.byline.notice)}</p>` : "",
    reviewLine(post),
    adviceNotice(),
    `  <div class="prose">${html}</div>`,
    `</article>`,
    commentList(comments),
    `<p><a href="${P}/">More notes</a> · <a href="${escapeHtml(SITE.customerOrigin)}">Find a clinic that can see your pet now</a></p>`
  ].filter(Boolean).join("\n");

  const head = headTags({
    title: `${post.title} — Tími NOW`,
    description,
    canonical,
    type: "article",
    published,
    modified,
    feed: `${BLOG}/feed.xml`
  }) + "\n  " + graph([
    ...SITE_NODES,
    articleSchema({
      url: canonical,
      headline: post.title,
      description,
      published,
      modified,
      authorName: post.authorName || (post.authorKind === "provider" ? post.providerName : SITE.name),
      authorCredentials: post.authorCredentials,
      // Normalised here, like every other date on the page: D1 stores
      // "2026-09-12 09:00:00" and schema.org wants a date a parser accepts.
      reviewer: post.reviewer ? { ...post.reviewer, reviewedAt: isoDate(post.reviewer.reviewedAt) } : null,
      image: SITE.image
    }),
    breadcrumbSchema([
      { name: "Notes", url: `${BLOG}/` },
      { name: post.title, url: canonical }
    ])
  ]);

  return renderIntoShell(shell, { head, body });
}

/* ─────────────────────────────────────────────────────────────── forum ── */

const KIND_LABEL = { question: "Question for clinics", discussion: "Discussion" };

function threadCard(thread) {
  return [
    `<article class="thread-card">`,
    `  <p class="eyebrow">${escapeHtml(KIND_LABEL[thread.kind] || "Discussion")}</p>`,
    `  <h2><a href="${P}/t/${escapeHtml(thread.slug)}">${escapeHtml(thread.title)}</a></h2>`,
    `  <p class="post-meta">${escapeHtml(thread.authorName || "Member")}`,
    thread.createdAt ? ` · ${timeTag(thread.createdAt)}` : "",
    ` · ${thread.replyCount} ${thread.replyCount === 1 ? "reply" : "replies"}</p>`,
    `</article>`
  ].join("");
}

export function renderForum(shell, threads) {
  const canonical = canonicalUrl(BLOG, "/forum");
  const title = "Community — ask a vet, or talk to other owners | Tími NOW";
  const description =
    "Questions answered by veterinary clinics on Tími NOW, and discussion between pet owners. "
    + "Reading is open to everyone; posting needs an account so a name sits behind every answer.";

  const body = [
    `<nav class="breadcrumb" aria-label="Breadcrumb"><a href="${P}/">Notes</a> › <span>Community</span></nav>`,
    `<div class="masthead">`,
    `  <h1>Community</h1>`,
    `  <p>${escapeHtml(description)}</p>`,
    `</div>`,
    adviceNotice(),
    threads.length
      ? `<div class="thread-list">\n${threads.map(threadCard).join("\n")}\n</div>`
      : `<p class="empty">No threads yet.</p>`,
    `<p><a href="${P}/">Notes from Tími NOW and its clinics</a> · <a href="${escapeHtml(SITE.customerOrigin)}">Find care that is open now</a></p>`
  ].join("\n");

  const head = headTags({ title, description, canonical, type: "website" }) + "\n  " + graph([
    ...SITE_NODES,
    breadcrumbSchema([{ name: "Notes", url: `${BLOG}/` }, { name: "Community", url: canonical }]),
    {
      "@type": "CollectionPage",
      "@id": `${canonical}#page`,
      url: canonical,
      name: title,
      description: metaDescription(description),
      isPartOf: { "@id": `${BLOG}/#blog` },
      mainEntity: {
        "@type": "ItemList",
        itemListElement: threads.map((thread, index) => ({
          "@type": "ListItem",
          position: index + 1,
          url: `${BLOG}/t/${encodeURIComponent(thread.slug)}`,
          name: thread.title
        }))
      }
    }
  ]);

  return renderIntoShell(shell, { head, body });
}

/* ────────────────────────────────────────────────────────── one thread ── */

export function renderThread(shell, { thread, replies = [] }) {
  const canonical = canonicalUrl(BLOG, `/t/${thread.slug}`);
  const description = metaDescription(plainText(thread.body));
  const published = isoDate(thread.createdAt);

  const replyMarkup = replies.map((reply) => [
    `  <li>`,
    `    <p class="comment-meta">${escapeHtml(reply.authorName || "Member")}`,
    reply.providerName ? ` · ${escapeHtml(reply.providerName)}` : "",
    reply.createdAt ? ` · ${timeTag(reply.createdAt)}` : "",
    `</p>`,
    `    <div class="prose">${renderMarkdown(reply.body)}</div>`,
    `  </li>`
  ].join("")).join("\n");

  const body = [
    `<nav class="breadcrumb" aria-label="Breadcrumb"><a href="${P}/">Notes</a> › <a href="${P}/forum">Community</a> › <span>${escapeHtml(thread.title)}</span></nav>`,
    `<article class="thread">`,
    `  <p class="eyebrow">${escapeHtml(KIND_LABEL[thread.kind] || "Discussion")}</p>`,
    `  <h1>${escapeHtml(thread.title)}</h1>`,
    `  <p class="post-meta">${escapeHtml(thread.authorName || "Member")}${thread.createdAt ? ` · ${timeTag(thread.createdAt)}` : ""}</p>`,
    adviceNotice(),
    `  <div class="prose">${renderMarkdown(thread.body)}</div>`,
    `</article>`,
    replies.length
      ? `<section class="replies"><h2>${replies.length} ${replies.length === 1 ? "reply" : "replies"}</h2><ol class="reply-list">\n${replyMarkup}\n</ol></section>`
      : `<p class="empty">No replies yet.</p>`,
    `<p><a href="${P}/forum">More from the community</a> · <a href="${escapeHtml(SITE.customerOrigin)}">Find a clinic that can see your pet now</a></p>`
  ].join("\n");

  const head = headTags({
    title: `${thread.title} — Tími NOW community`,
    description,
    canonical,
    type: "article",
    published
  }) + "\n  " + graph([
    ...SITE_NODES,
    discussionSchema({
      url: canonical,
      headline: thread.title,
      text: plainText(thread.body),
      published,
      authorName: thread.authorName,
      replies: replies.map((reply) => ({
        text: plainText(reply.body),
        published: isoDate(reply.createdAt),
        authorName: reply.authorName
      }))
    }),
    breadcrumbSchema([
      { name: "Notes", url: `${BLOG}/` },
      { name: "Community", url: `${BLOG}/forum` },
      { name: thread.title, url: canonical }
    ])
  ]);

  return renderIntoShell(shell, { head, body });
}

/* ─────────────────────────────────────────────────────── the other ones ── */

/**
 * Anything with no content behind it: a slug that does not exist, or a page
 * whose only purpose is to complete a flow.
 *
 * The status code is the point. Returning 200 with a shell for
 * /p/whatever-somebody-guessed is a soft 404 — the crawler indexes an empty
 * page, keeps checking it, and learns that this site answers 200 for URLs
 * that mean nothing, which it then applies to the real ones.
 */
export function renderNotFound(shell, { path }) {
  const canonical = canonicalUrl(BLOG, path);
  const head = headTags({
    title: "Not found — Tími NOW",
    description: "That page does not exist. The notes index lists everything published.",
    canonical,
    robots: "noindex, follow"
  });
  const body = [
    `<div class="message-card">`,
    `  <h1>Not found</h1>`,
    `  <p>There is nothing at this address. Everything published is listed on the notes index.</p>`,
    `  <p><a href="${P}/">All notes</a> · <a href="${P}/forum">Community</a></p>`,
    `</div>`
  ].join("\n");
  return renderIntoShell(shell, { head, body });
}

/**
 * A page that exists but must never be indexed — the confirmation landing for
 * a mail subscription, which is reached from a link in an email and carries a
 * single-use token in its URL.
 */
export function renderNoIndex(shell, { path, title, description }) {
  const head = headTags({
    title,
    description,
    canonical: canonicalUrl(BLOG, path),
    robots: "noindex, nofollow"
  });
  return renderIntoShell(shell, { head, body: "", hideViews: false });
}
