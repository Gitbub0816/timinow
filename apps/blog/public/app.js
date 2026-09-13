/**
 * The blog and community front end.
 *
 * Routing is by path so every post and thread has a real, shareable URL —
 * `not_found_handling: single-page-application` in wrangler.blog.jsonc returns
 * this shell for any path, and this decides what to draw.
 *
 * Every piece of text that came from a person is inserted with textContent,
 * never innerHTML. The one exception is a post body, which arrives as HTML the
 * Worker rendered through src/markdown.js — the renderer that escapes first
 * and marks up second, so what it returns contains no tag any author typed.
 * Nothing else on this page is allowed to be HTML, and the rule is worth
 * stating because this site publishes words written by strangers.
 */

const state = {
  config: null,
  actor: null,
  filter: "",
  post: null,
  thread: null
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/* ─────────────────────────────────────────────────────────────── plumbing ── */

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers["content-type"] = "application/json";
  const token = await sessionToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(path, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || "That did not work.");
  return payload;
}

/**
 * The reader's Clerk session, when there is one.
 *
 * Clerk is loaded lazily and only if configured: reading the blog must not
 * wait on an auth SDK, and most visits never sign in at all.
 */
let clerk = null;
async function loadClerk() {
  if (clerk !== null) return clerk;
  const key = state.config?.clerkPublishableKey;
  if (!key) { clerk = false; return clerk; }
  try {
    const module = await import(state.config.clerkJsUrl);
    const Clerk = module.Clerk || module.default;
    clerk = new Clerk(key);
    await clerk.load();
    return clerk;
  } catch {
    clerk = false;
    return clerk;
  }
}

async function sessionToken() {
  const instance = await loadClerk();
  if (!instance || !instance.session) return null;
  try {
    return await instance.session.getToken({ template: state.config?.clerkTokenTemplate || "timinow" });
  } catch {
    return null;
  }
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

/* ─────────────────────────────────────────────────────────────── rendering ── */

function showView(name) {
  $$("[data-view]").forEach((section) => { section.hidden = section.dataset.view !== name; });
  $$("[data-nav]").forEach((link) => {
    link.classList.toggle("is-on", (name === "posts" || name === "post") ? link.dataset.nav === "posts" : link.dataset.nav === "forum");
  });
  window.scrollTo(0, 0);
}

function renderPostList(posts) {
  const list = $("[data-post-list]");
  list.textContent = "";
  if (!posts.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Nothing published yet.";
    list.append(empty);
    return;
  }
  for (const post of posts) {
    const card = document.createElement("a");
    card.className = "post-card";
    card.href = `/p/${post.slug}`;

    const byline = document.createElement("p");
    byline.className = "eyebrow";
    // The byline comes from the Worker (src/content.js). A provider post says
    // so, and must never be restyled here into something that reads as ours.
    byline.textContent = post.byline.line;
    if (!post.byline.endorsed) byline.classList.add("is-provider");

    const title = document.createElement("h2");
    title.textContent = post.title;

    const excerpt = document.createElement("p");
    excerpt.className = "excerpt";
    excerpt.textContent = post.excerpt || "";

    const meta = document.createElement("p");
    meta.className = "post-meta";
    const count = post.commentCount || 0;
    meta.textContent = `${formatDate(post.publishedAt)}${count ? ` · ${count} comment${count === 1 ? "" : "s"}` : ""}`;

    card.append(byline, title, excerpt, meta);
    list.append(card);
  }
}

function renderPost(payload) {
  state.post = payload.post;
  $("[data-post-byline]").textContent = payload.post.byline.line;
  $("[data-post-byline]").classList.toggle("is-provider", !payload.post.byline.endorsed);
  $("[data-post-title]").textContent = payload.post.title;
  $("[data-post-meta]").textContent = formatDate(payload.post.publishedAt);

  const notice = $("[data-post-notice]");
  notice.hidden = !payload.post.byline.notice;
  notice.textContent = payload.post.byline.notice || "";

  // The only innerHTML on this page, and only for what src/markdown.js
  // produced — see the note at the top of this file.
  $("[data-post-body]").innerHTML = payload.html;

  renderComments(payload.comments || []);
  const signedIn = Boolean(state.actor);
  $("[data-comment-form]").hidden = !signedIn;
  $("[data-comment-signin]").hidden = signedIn;
  showView("post");
  document.title = `${payload.post.title} · TímiNOW`;
}

function renderComments(comments) {
  const list = $("[data-comment-list]");
  list.textContent = "";
  if (!comments.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No comments yet.";
    list.append(empty);
    return;
  }
  for (const comment of comments) {
    const item = document.createElement("li");
    item.className = "comment";

    const head = document.createElement("p");
    head.className = "comment-head";
    head.textContent = `${comment.authorName} · ${formatDate(comment.createdAt)}`;

    const body = document.createElement("p");
    body.className = "comment-body";
    body.textContent = comment.body;

    const report = document.createElement("button");
    report.className = "link-button";
    report.type = "button";
    report.textContent = "Report";
    report.addEventListener("click", () => reportThing("comment", comment.id));

    item.append(head, body, report);
    list.append(item);
  }
}

function badgeFor(kind, providerName) {
  if (kind === "provider") return providerName ? `${providerName} · TímiNOW clinic` : "TímiNOW clinic";
  if (kind === "platform") return "TímiNOW";
  if (kind === "contributor") return "TímiNOW contributor";
  return null;
}

function renderThreadList(threads) {
  const list = $("[data-thread-list]");
  list.textContent = "";
  if (!threads.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No threads yet. Start one.";
    list.append(empty);
    return;
  }
  for (const thread of threads) {
    const card = document.createElement("a");
    card.className = "thread-card";
    card.href = `/t/${thread.slug}`;

    const kind = document.createElement("span");
    kind.className = `kind kind-${thread.kind}`;
    kind.textContent = thread.kind === "question" ? "Question" : "Discussion";

    const title = document.createElement("h2");
    title.textContent = thread.title;

    const meta = document.createElement("p");
    meta.className = "post-meta";
    const badge = badgeFor(thread.authorKind, thread.providerName);
    meta.textContent = `${thread.authorName}${badge ? ` · ${badge}` : ""} · ${thread.replyCount} repl${thread.replyCount === 1 ? "y" : "ies"}`;

    card.append(kind, title, meta);
    list.append(card);
  }
}

function renderThread(payload) {
  state.thread = payload.thread;
  $("[data-thread-kind]").textContent = payload.thread.kind === "question" ? "QUESTION" : "DISCUSSION";
  $("[data-thread-title]").textContent = payload.thread.title;
  const badge = badgeFor(payload.thread.authorKind, payload.thread.providerName);
  $("[data-thread-meta]").textContent = `${payload.thread.authorName}${badge ? ` · ${badge}` : ""} · ${formatDate(payload.thread.createdAt)}`;
  // Thread bodies are plain text, not Markdown: a forum post is somebody
  // typing, and giving every reply a rendering pipeline is more surface than
  // the feature is worth.
  $("[data-thread-body]").textContent = payload.thread.body;

  const list = $("[data-reply-list]");
  list.textContent = "";
  for (const reply of payload.replies) {
    const item = document.createElement("li");
    item.className = "comment";

    const head = document.createElement("p");
    head.className = "comment-head";
    const replyBadge = badgeFor(reply.authorKind, reply.providerName);
    head.textContent = `${reply.authorName}${replyBadge ? ` · ${replyBadge}` : ""} · ${formatDate(reply.createdAt)}`;
    if (reply.authorKind === "provider") head.classList.add("is-provider");

    const body = document.createElement("p");
    body.className = "comment-body";
    body.textContent = reply.body;

    const report = document.createElement("button");
    report.className = "link-button";
    report.type = "button";
    report.textContent = "Report";
    report.addEventListener("click", () => reportThing("reply", reply.id));

    item.append(head, body, report);
    list.append(item);
  }

  const signedIn = Boolean(state.actor);
  $("[data-reply-form]").hidden = !signedIn;
  $("[data-reply-signin]").hidden = signedIn;
  showView("thread");
  document.title = `${payload.thread.title} · TímiNOW`;
}

function showMessage(title, body) {
  $("[data-message-title]").textContent = title;
  $("[data-message-body]").textContent = body;
  showView("message");
}

/* ───────────────────────────────────────────────────────────────── actions ── */

async function reportThing(subjectType, subjectId) {
  if (!state.actor) { showMessage("Sign in first", "Reporting needs an account, so we can tell one report from many."); return; }
  const reason = window.prompt("What's wrong with it? (a word or two)");
  if (reason === null) return;
  try {
    await api("/api/reports", { method: "POST", body: JSON.stringify({ subjectType, subjectId, reason }) });
    window.alert("Thanks — an operator will look at it.");
  } catch (error) {
    window.alert(error.message);
  }
}

/* ───────────────────────────────────────────────────────────────── routing ── */

async function route() {
  const path = window.location.pathname;

  if (path.startsWith("/p/")) {
    try {
      renderPost(await api(`/api/posts/${encodeURIComponent(path.slice(3))}`));
    } catch {
      showMessage("Not found", "That post does not exist, or it was taken down.");
    }
    return;
  }

  if (path.startsWith("/t/")) {
    try {
      renderThread(await api(`/api/threads/${encodeURIComponent(path.slice(3))}`));
    } catch {
      showMessage("Not found", "That thread does not exist, or it was taken down.");
    }
    return;
  }

  if (path === "/forum") {
    const query = state.filter ? `?kind=${state.filter}` : "";
    renderThreadList((await api(`/api/threads${query}`)).threads);
    $("[data-forum-signin]").hidden = Boolean(state.actor);
    showView("forum");
    document.title = "Community · TímiNOW";
    return;
  }

  if (path === "/subscribe/confirm") {
    const token = new URLSearchParams(window.location.search).get("token");
    const result = await api("/api/subscribe/confirm", { method: "POST", body: JSON.stringify({ token }) }).catch(() => ({ ok: false }));
    showMessage(
      result.ok ? "You're subscribed" : "That link has expired",
      result.ok
        ? "We'll email you when something new goes up. Every email has a one-click unsubscribe."
        : "Confirmation links are single-use. Subscribe again from the blog and we'll send a fresh one."
    );
    return;
  }

  if (path === "/unsubscribe") {
    const token = new URLSearchParams(window.location.search).get("token");
    await api("/api/unsubscribe", { method: "POST", body: JSON.stringify({ token }) }).catch(() => ({}));
    // Always the same answer: somebody unsubscribing wants to be told they
    // are off the list, not shown an error that makes them wonder.
    showMessage("You're unsubscribed", "That address will not receive any more posts. Nothing else changes.");
    return;
  }

  renderPostList((await api("/api/posts")).posts);
  showView("posts");
  document.title = "Notes · TímiNOW";
}

function go(path) {
  window.history.pushState({}, "", path);
  route();
}

/* ───────────────────────────────────────────────────────────────── startup ── */

function wire() {
  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[href^='/']");
    if (!link || link.target === "_blank" || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    go(link.getAttribute("href"));
  });
  window.addEventListener("popstate", route);

  $("[data-subscribe-form]").addEventListener("submit", async (event) => {
    event.preventDefault();
    const note = $("[data-subscribe-note]");
    const email = new FormData(event.currentTarget).get("email");
    try {
      const result = await api("/api/subscribe", { method: "POST", body: JSON.stringify({ email }) });
      note.textContent = result.message;
      event.currentTarget.reset();
    } catch (error) {
      note.textContent = error.message;
    }
  });

  $("[data-comment-form]").addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = new FormData(event.currentTarget).get("body");
    try {
      await api("/api/comments", { method: "POST", body: JSON.stringify({ postId: state.post.id, body }) });
      event.currentTarget.reset();
      renderPost(await api(`/api/posts/${encodeURIComponent(state.post.slug)}`));
    } catch (error) {
      window.alert(error.message);
    }
  });

  $("[data-action='new-thread']").addEventListener("click", () => {
    if (!state.actor) { $("[data-forum-signin]").hidden = false; return; }
    $("[data-thread-form]").hidden = false;
  });
  $("[data-action='cancel-thread']").addEventListener("click", () => { $("[data-thread-form]").hidden = true; });

  $("[data-thread-form]").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const result = await api("/api/threads", {
        method: "POST",
        body: JSON.stringify({ kind: form.get("kind"), title: form.get("title"), body: form.get("body") })
      });
      event.currentTarget.reset();
      $("[data-thread-form]").hidden = true;
      go(`/t/${result.thread.slug}`);
    } catch (error) {
      window.alert(error.message);
    }
  });

  $("[data-reply-form]").addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = new FormData(event.currentTarget).get("body");
    try {
      await api("/api/replies", { method: "POST", body: JSON.stringify({ threadId: state.thread.id, body }) });
      event.currentTarget.reset();
      renderThread(await api(`/api/threads/${encodeURIComponent(state.thread.slug)}`));
    } catch (error) {
      window.alert(error.message);
    }
  });

  $$("[data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter;
      $$("[data-filter]").forEach((other) => other.classList.toggle("is-on", other === button));
      route();
    });
  });

  $("[data-action='sign-in']").addEventListener("click", async () => {
    const instance = await loadClerk();
    if (instance) instance.openSignIn({ afterSignInUrl: window.location.pathname });
  });
}

async function start() {
  $("[data-year]").textContent = String(new Date().getFullYear());
  state.config = await api("/api/config").catch(() => ({}));
  $("[data-not-advice]").textContent = state.config.notAdvice || "";

  const instance = await loadClerk();
  if (instance && instance.user) {
    state.actor = { name: instance.user.fullName || instance.user.primaryEmailAddress?.emailAddress || "You" };
    const who = $("[data-who]");
    who.textContent = state.actor.name;
    who.hidden = false;
  } else if (instance) {
    $("[data-action='sign-in']").hidden = false;
  }

  wire();
  await route();
}

start();
