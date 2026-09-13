/**
 * Blog, forum and subscription tests.
 *
 * The things worth testing here are the ones that cost something when they are
 * wrong: a byline that misattributes a clinic's opinion to TímiNOW, a renderer
 * that lets an author inject a tag, a tenancy check that lets one practice edit
 * another's post, and a mailing list that sends to an address nobody confirmed.
 */

import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { bylineFor, slugify, NON_ENDORSEMENT, NOT_ADVICE } from "../src/content.js";
import { renderMarkdown, escapeHtml, excerptFrom } from "../src/markdown.js";
import { normalizeEmail } from "../src/blog-subscriptions.js";
import { createPost, updatePost, listPostsForTenant, addComment, reportContent } from "../src/content-store.js";

let failures = 0;
const results = [];
function assert(condition, message) {
  if (!condition) { failures += 1; console.error(`FAIL: ${message}`); }
}
function assertEqual(actual, expected, message) {
  if (actual !== expected) { failures += 1; console.error(`FAIL: ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
const record = (what) => results.push(what);

/* --------------------------------------------------------------- bylines --- */
{
  assertEqual(bylineFor({ authorKind: "platform", authorName: "Caleb Owen" }).line, "TímiNOW post by Caleb Owen", "an operator's post is TímiNOW's own");
  assertEqual(bylineFor({ authorKind: "contributor", authorName: "John Doe" }).line, "TímiNOW post by contributor John Doe", "a contributor is disclosed as one");

  const clinic = bylineFor({ authorKind: "provider", providerName: "Cedar Animal Hospital" });
  assertEqual(clinic.line, "From Cedar Animal Hospital, a TímiNOW clinic", "a clinic's post names the clinic");
  assertEqual(clinic.endorsed, false, "and is explicitly not endorsed");
  assertEqual(clinic.notice, NON_ENDORSEMENT, "and carries the non-endorsement line");
  assert(!/sponsor/i.test(clinic.line), "and never says sponsored — that implies TímiNOW paid for it or vouches for it");

  const withAuthor = bylineFor({ authorKind: "provider", providerName: "Cedar Animal Hospital", authorName: "Dr. Reyes" });
  assertEqual(withAuthor.line, "From Cedar Animal Hospital, a TímiNOW clinic · by Dr. Reyes", "an optional author rides beside the clinic");

  // The failure this guards: a provider post that reads as TímiNOW's is a
  // veterinary claim this company did not make.
  for (const kind of ["platform", "contributor"]) {
    assertEqual(bylineFor({ authorKind: kind, authorName: "X" }).endorsed, true, `${kind} posts are TímiNOW's own`);
  }
  assert(NOT_ADVICE.includes("veterinarian-client-patient"), "the standing notice names the actual legal concept, not a vague disclaimer");
  record("bylines separate TímiNOW's word from a clinic's");
}

/* -------------------------------------------------------------- markdown --- */
{
  const attacks = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "<iframe src=//evil></iframe>",
    "[x](javascript:alert(1))",
    "[x](JaVaScRiPt:alert(1))",
    "[x](data:text/html,<script>alert(1)</script>)",
    "[x](vbscript:msgbox)",
    "<svg onload=alert(1)>",
    "<a href=\"x\" onmouseover=\"alert(1)\">y</a>"
  ];
  // The invariant, not the absence of a scary word: escaped text legitimately
  // CONTAINS "onerror" — as the five characters &lt; then "img src=x
  // onerror..." — and a test that greps for the word fails on output that is
  // perfectly safe. What must be true is that every tag the renderer emits is
  // one it chose, carrying only attributes it chose.
  const ALLOWED_TAGS = new Set(["p", "h2", "h3", "strong", "em", "code", "pre", "ul", "ol", "li", "blockquote", "hr", "a"]);
  const ALLOWED_ATTRIBUTES = new Set(["href", "rel", "target"]);
  for (const attack of attacks) {
    const html = renderMarkdown(attack);
    for (const [tag, name, rest] of html.matchAll(/<\/?([a-z0-9]+)((?:\s[^>]*)?)>/gi)) {
      assert(ALLOWED_TAGS.has(name.toLowerCase()), `renderMarkdown emitted <${name}> from: ${attack}`);
      for (const [, attribute] of String(rest).matchAll(/([a-z-]+)\s*=/gi)) {
        assert(ALLOWED_ATTRIBUTES.has(attribute.toLowerCase()), `renderMarkdown emitted ${attribute}= from: ${attack}`);
      }
      void tag;
    }
    assert(!/href\s*=\s*"(?!https?:|mailto:|\/)/i.test(html), `renderMarkdown emitted an unsafe href from: ${attack}`);
  }
  assertEqual(escapeHtml('<a href="x">&'), "&lt;a href=&quot;x&quot;&gt;&amp;", "every dangerous character is escaped");

  // Still a usable renderer, not merely a safe one.
  assert(renderMarkdown("**bold**").includes("<strong>bold</strong>"), "bold still works");
  assert(renderMarkdown("## Head").includes("<h2>Head</h2>"), "headings start at h2, below the page title");
  assert(!renderMarkdown("# Head").includes("<h1>"), "a post body can never emit a second h1");
  const link = renderMarkdown("[ok](https://example.com)");
  assert(link.includes('href="https://example.com"'), "http links survive");
  assert(link.includes('rel="ugc nofollow noopener"'), "and are marked ugc/nofollow — this site publishes strangers' links");
  assertEqual(excerptFrom("## Title\n\nSome **body** text here."), "Title Some body text here.", "excerpts strip markup");
  record("the renderer escapes first and marks up second, so no author input becomes a tag");
}

/* ----------------------------------------------------------------- slugs --- */
{
  const first = slugify("Winter paw care");
  const second = slugify("Winter paw care");
  assert(first.startsWith("winter-paw-care-"), "slugs are readable");
  assert(first !== second, "and unique, so two posts with one title both work");
  assert(/^[a-z0-9-]+$/.test(slugify("Café naïve — año!")), "and always URL-safe");
  record("slugs are readable, unique and URL-safe");
}

/* ----------------------------------------------------------------- email --- */
{
  assertEqual(normalizeEmail("  Caleb@Example.COM "), "caleb@example.com", "addresses are trimmed and lowered");
  for (const bad of ["", "nope", "a@b", "@example.com", "a b@example.com", "x".repeat(300)]) {
    assertEqual(normalizeEmail(bad), null, `rejects ${JSON.stringify(bad.slice(0, 20))}`);
  }
  record("email normalisation rejects what could not be an address");
}

/* -------------------------------------------------------------- tenancy --- */
{
  // A real database, because the tenancy boundary is enforced by the SQL and
  // testing it against a mock would test the mock.
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE blog_posts (
      id TEXT PRIMARY KEY, slug TEXT UNIQUE, author_kind TEXT, tenant_id TEXT, author_user_id TEXT,
      author_name TEXT, provider_name TEXT, title TEXT, excerpt TEXT, body_markdown TEXT,
      status TEXT, published_at TEXT, removed_at TEXT, removed_by TEXT, removed_reason TEXT,
      created_at TEXT, updated_at TEXT);
    CREATE TABLE blog_comments (
      id TEXT PRIMARY KEY, post_id TEXT, author_user_id TEXT, author_name TEXT, body TEXT,
      status TEXT, removed_at TEXT, removed_by TEXT, removed_reason TEXT, created_at TEXT);
    CREATE TABLE content_reports (
      id TEXT PRIMARY KEY, subject_type TEXT, subject_id TEXT, reporter_user_id TEXT, reason TEXT,
      detail TEXT, status TEXT, resolved_by TEXT, resolved_at TEXT, created_at TEXT,
      UNIQUE(subject_type, subject_id, reporter_user_id));
  `);

  const env = { DB: d1(database) };
  const cedar = { kind: "provider", userId: "user_a", name: "Dr. Reyes", tenantId: "tenant_cedar", providerName: "Cedar Animal Hospital" };
  const solano = { kind: "provider", userId: "user_b", name: "Dr. Lin", tenantId: "tenant_solano", providerName: "Solano Pet Care" };

  const made = await createPost(env, cedar, { title: "Winter paw care", bodyMarkdown: "Salt burns are common in January and worth knowing about.", publish: true });
  assert(made.ok, "a permitted clinic can publish");
  assertEqual(made.post.byline.line, "From Cedar Animal Hospital, a TímiNOW clinic · by Dr. Reyes", "and the byline is theirs");

  const mine = await listPostsForTenant(env, "tenant_cedar");
  assertEqual(mine.length, 1, "a clinic sees its own post");
  assertEqual((await listPostsForTenant(env, "tenant_solano")).length, 0, "and never another clinic's");

  // The one that matters: a guessed id from another practice.
  const stolen = await updatePost(env, made.post.id, { title: "Hijacked" }, { tenantScope: solano.tenantId });
  assertEqual(stolen.ok, false, "another clinic cannot edit this post");
  assertEqual(stolen.code, "POST_NOT_FOUND", "and is told it does not exist rather than that it is forbidden");
  assertEqual(database.prepare("SELECT title FROM blog_posts WHERE id = ?").get(made.post.id).title, "Winter paw care", "and nothing changed");

  const own = await updatePost(env, made.post.id, { title: "Winter paw care, revisited" }, { tenantScope: cedar.tenantId });
  assert(own.ok, "the clinic that wrote it can edit it");

  // Removed content stays removed, whoever asks.
  database.prepare("UPDATE blog_posts SET status = 'removed' WHERE id = ?").run(made.post.id);
  const revive = await updatePost(env, made.post.id, { publish: true }, { tenantScope: cedar.tenantId });
  assertEqual(revive.ok, false, "an author cannot edit their way back onto the site after a takedown");
  assertEqual(revive.code, "POST_REMOVED", "and is told why");

  // Comments need a published post and a signed-in person.
  database.prepare("UPDATE blog_posts SET status = 'published' WHERE id = ?").run(made.post.id);
  assertEqual((await addComment(env, null, made.post.id, "hi")).code, "SIGN_IN_REQUIRED", "commenting needs an account");
  assert((await addComment(env, { userId: "u1", name: "Reader" }, made.post.id, "Useful, thanks.")).ok, "a signed-in reader can comment");
  assertEqual((await addComment(env, { userId: "u1" }, "post_nope", "hi")).code, "POST_NOT_FOUND", "on a post that exists");

  // One report per person per thing.
  await reportContent(env, { userId: "u1" }, { subjectType: "post", subjectId: made.post.id, reason: "wrong" });
  await reportContent(env, { userId: "u1" }, { subjectType: "post", subjectId: made.post.id, reason: "wrong" });
  assertEqual(database.prepare("SELECT COUNT(*) AS n FROM content_reports").get().n, 1,
    "pressing report twice is one report, so one upset reader is not a pile-on");
  record("tenancy holds: a clinic reads and edits only its own posts");
}

/* ------------------------------------------------------- schema contract --- */
{
  const migration = await readFile("migrations/0031_blog_and_forum.sql", "utf8");
  assert(/CREATE TABLE IF NOT EXISTS content_contributors/.test(migration), "contributors have their own table");
  // Prose stripped first: this file explains at length why contributors are
  // not an operator role, and a grep for the table name hits that explanation.
  const statements = migration.split("\n").filter((line) => !/^\s*--/.test(line)).join("\n");
  assert(!/admin_role_assignments/.test(statements),
    "and are NOT an operator role — rolesFor() ignores anyone who is not a platform admin, so that would mean making every guest writer one");
  assert(/status.*CHECK.*'pending', 'confirmed', 'unsubscribed'/s.test(migration), "subscribers carry a confirmation state");
  assert(/unsubscribe_token TEXT NOT NULL/.test(migration), "and every one has an unsubscribe token, so leaving needs no account");
  record("the schema keeps contributors out of the operator role table");
}

if (failures) {
  console.error(`\n${failures} blog assertion(s) failed.`);
  process.exit(1);
}
console.log(`Blog tests passed (${results.length} groups): ${results.join("; ")}.`);

/* ------------------------------------------------------------- D1 shim --- */

/** The smallest thing that answers the D1 calls these modules make. */
function d1(database) {
  return {
    prepare(sql) {
      return {
        bind(...values) { return this._with(values); },
        _with(values) {
          return {
            async first() {
              try { return database.prepare(sql).get(...values) ?? null; } catch { return null; }
            },
            async all() {
              try { return { results: database.prepare(sql).all(...values) }; } catch { return { results: [] }; }
            },
            async run() {
              const outcome = database.prepare(sql).run(...values);
              return { meta: { changes: Number(outcome.changes || 0) } };
            }
          };
        },
        async first() { return database.prepare(sql).get() ?? null; },
        async all() { return { results: database.prepare(sql).all() }; },
        async run() { const outcome = database.prepare(sql).run(); return { meta: { changes: Number(outcome.changes || 0) } }; }
      };
    },
    async batch(statements) { return Promise.all(statements.map((statement) => statement.run())); }
  };
}
