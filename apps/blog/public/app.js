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
  thread: null,
  returnTo: null
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
/**
 * Which step failed, from which host, and what it said — not just a message.
 *
 * This used to hold the raw error, and one line of it reached the screen. That
 * was not enough to diagnose anything: "could not load Clerk" is true of a
 * blocked CDN, a mistyped key, an origin Clerk does not recognise and a build
 * whose exports moved, and those have four different fixes. What the reader
 * can report is now the step and the host.
 */
let clerkFailure = null;

/** Just the host, for a message that has to fit on a phone. */
function hostOf(url) {
  try { return new URL(url).host; } catch { return String(url || "").slice(0, 60); }
}

async function loadClerk() {
  if (clerk !== null) return clerk;
  const key = state.config?.clerkPublishableKey;
  const url = state.config?.clerkJsUrl;
  if (!key || !url) {
    // Remember "there is no Clerk here" only once the config has actually
    // arrived. api() asks for a session token on every call — including the
    // very first one, which is the call that fetches the config — so the
    // first question is always asked before the answer exists. Caching that
    // answer is what made sign-in impossible on this page for the whole life
    // of the tab: the button opened a form, the form could never reach
    // Clerk, and starting a thread or leaving a comment failed the same way.
    // No CSP, CDN or Clerk setting could have fixed it.
    if (state.config) clerk = false;
    return false;
  }
  // Named steps rather than a single try: see clerkFailure above.
  let step = "download";
  try {
    const module = await import(/* @vite-ignore */ url);
    step = "read";
    // Same resolution as every other surface: the +esm build has moved its
    // export shape between versions, and a bare `module.Clerk` is how this
    // silently became undefined.
    const Clerk = module.Clerk || module.default?.Clerk || module.default;
    if (typeof Clerk !== "function") throw new Error("no Clerk constructor in the module");
    step = "start";
    clerk = new Clerk(key);
    await clerk.load();
    // Re-render on sign-in and sign-out, so the page stops saying "sign in to
    // take part" the moment somebody has.
    clerk.addListener(() => { syncActor(); route(); });
    return clerk;
  } catch (error) {
    // Logged AND kept, rather than swallowed. Silence here is what made an
    // unusable page look like a working one, and nobody diagnoses a sign-in
    // problem from a phone with no console.
    console.error(`Clerk failed at step "${step}" loading ${url}`, error);
    clerkFailure = { step, host: hostOf(url), error };
    clerk = false;
    return clerk;
  }
}

/** Read the signed-in person out of Clerk and reflect them in the header. */
function syncActor() {
  const user = clerk && clerk.user;
  state.actor = user
    ? { name: user.fullName || user.primaryEmailAddress?.emailAddress || "You" }
    : null;
  const who = $("[data-who]");
  who.textContent = state.actor?.name || "";
  who.hidden = !state.actor;
  // Shown whenever nobody is signed in — including when Clerk failed to load,
  // because a button that explains itself beats a page with no way in.
  $("[data-action='sign-in']").hidden = Boolean(state.actor);
  $("[data-action='sign-out']").hidden = !state.actor;
}

async function sessionToken() {
  // Reading the blog needs no token, and nothing can be signed before the
  // config that names the Clerk instance has loaded — see loadClerk().
  if (!state.config) return null;
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
  if (!state.actor) { showSignIn(); return; }
  const reason = window.prompt("What's wrong with it? (a word or two)");
  if (reason === null) return;
  try {
    await api("/api/reports", { method: "POST", body: JSON.stringify({ subjectType, subjectId, reason }) });
    window.alert("Thanks — an operator will look at it.");
  } catch (error) {
    window.alert(error.message);
  }
}

/* ───────────────────────────────────────────────────────────── sign in ── */

/**
 * One-time code sign-in, built here.
 *
 * The headless Clerk build ships no UI at all — no openSignIn, no components —
 * which is the whole reason this page could not be used: calling a method that
 * does not exist threw inside a catch, so every write path said "sign in to
 * take part" and offered no way to do it. Every other Tími web surface builds
 * this same form, and offers codes only: no passwords, no passkeys, no OAuth.
 */
let signInAttempt = null;

function showSignIn(afterPath = window.location.pathname) {
  state.returnTo = afterPath;
  $("[data-signin-identifier]").hidden = false;
  $("[data-signin-code]").hidden = true;
  $("[data-signin-note]").textContent = "";
  showView("sign-in");
}

/**
 * What to say when the sign-in provider itself will not load.
 *
 * The reason is included deliberately. This is not a message a reader can act
 * on either way, but it is the only thing that makes the failure reportable:
 * the surface is a phone, there is no console on it, and "try again in a
 * moment" is what a page says when nobody knows what is wrong. Clerk's own
 * errors name the cause — an origin it does not recognise, a key for another
 * instance, a network it could not reach.
 */
function signInUnavailableText() {
  if (!clerkFailure) return "Sign-in is not configured on this deployment.";
  const { step, host, error } = clerkFailure;
  const detail = (error?.message || String(error) || "").slice(0, 160);
  const what = {
    download: `the browser could not fetch the sign-in code from ${host}`,
    read: `${host} answered with something that is not the sign-in code`,
    start: `the sign-in code loaded from ${host} but would not start`
  }[step] || `sign-in failed at ${host}`;
  return `Sign-in could not start: ${what}. ${detail}`;
}

function signInMessage(error) {
  // Clerk puts the useful sentence in errors[0].longMessage; its top-level
  // message is a generic wrapper.
  return error?.errors?.[0]?.longMessage || error?.errors?.[0]?.message || error?.message || "That did not work.";
}

function wireSignIn() {
  $("[data-action='sign-in']").addEventListener("click", () => showSignIn());
  // The inline prompts on a post, a thread and the forum are the same button.
  $$("[data-action='sign-in-inline']").forEach((button) => {
    button.addEventListener("click", () => showSignIn());
  });

  $("[data-action='sign-out']").addEventListener("click", async () => {
    if (clerk) await clerk.signOut();
    syncActor();
    route();
  });

  $("[data-signin-identifier]").addEventListener("submit", async (event) => {
    event.preventDefault();
    const note = $("[data-signin-note]");
    const identifier = new FormData(event.currentTarget).get("identifier")?.toString().trim();
    if (!identifier) return;
    const instance = await loadClerk();
    if (!instance) { note.textContent = signInUnavailableText(); return; }
    note.textContent = "Sending…";
    try {
      signInAttempt = await instance.client.signIn.create({ identifier });
      const factor = (signInAttempt.supportedFirstFactors || []).find((f) => f.strategy === "email_code");
      if (!factor) throw new Error("That account has no email address that can receive a code.");
      await signInAttempt.prepareFirstFactor({ strategy: "email_code", emailAddressId: factor.emailAddressId });
      $("[data-signin-identifier]").hidden = true;
      $("[data-signin-code]").hidden = false;
      note.textContent = `We emailed a code to ${identifier}.`;
    } catch (error) {
      note.textContent = signInMessage(error);
    }
  });

  $("[data-signin-code]").addEventListener("submit", async (event) => {
    event.preventDefault();
    const note = $("[data-signin-note]");
    const code = new FormData(event.currentTarget).get("code")?.toString().trim();
    if (!code || !signInAttempt) return;
    note.textContent = "Checking…";
    try {
      const result = await signInAttempt.attemptFirstFactor({ strategy: "email_code", code });
      if (result.status !== "complete") throw new Error("That code was not accepted.");
      await clerk.setActive({ session: result.createdSessionId });
      signInAttempt = null;
      syncActor();
      go(state.returnTo || "/");
    } catch (error) {
      note.textContent = signInMessage(error);
    }
  });

  $("[data-signin-restart]").addEventListener("click", () => {
    signInAttempt = null;
    showSignIn(state.returnTo);
  });
}

/* ───────────────────────────────────────────────────────────────── routing ── */

/**
 * Where this app is mounted.
 *
 * It answers at timinow.pet/blog now — one domain, so a post's standing and
 * the main site's are the same pool rather than two. The server renders every
 * URL with that prefix; this strips it once so the route table below stays
 * about routes rather than about mounting.
 */
const BASE = window.location.pathname.startsWith("/blog") ? "/blog" : "";

async function route() {
  const path = window.location.pathname.slice(BASE.length) || "/";

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
  // Callers pass app-relative paths ("/t/slug"); the address bar needs the
  // mount point in front of them.
  window.history.pushState({}, "", path.startsWith(BASE) ? path : BASE + path);
  route();
}

/* ───────────────────────────────────────────────────────────────── startup ── */

function wire() {
  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[href^='/']");
    if (!link || link.target === "_blank" || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    // Hrefs in the server-rendered markup already carry the base; go() leaves
    // one that does alone.
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
    // Somewhere to go, rather than a sentence telling them to do something the
    // page gave them no way to do.
    if (!state.actor) { showSignIn("/forum"); return; }
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

  // No sign-in handler here: wireSignIn() owns that button. This one called
  // clerk.openSignIn(), which the headless build does not define — it was
  // left behind when the one-time-code form replaced Clerk's hosted modal,
  // and every click ran both handlers.
}

async function start() {
  // The server rendered this page's content before sending it — see
  // apps/blog/src/pages.js. That block exists for crawlers, for assistants
  // that never run this file, and for the first paint; from here the app owns
  // the DOM, so it goes.
  document.querySelector("[data-ssr]")?.remove();
  $("[data-year]").textContent = String(new Date().getFullYear());
  state.config = await api("/api/config").catch(() => ({}));
  $("[data-not-advice]").textContent = state.config.notAdvice || "";

  await loadClerk();
  syncActor();

  wire();
  wireSignIn();
  await route();
}

start();
