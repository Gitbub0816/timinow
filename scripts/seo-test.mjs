/**
 * The crawlable surface, tested.
 *
 * SEO work rots more quietly than anything else in a codebase. Nothing breaks,
 * no test goes red, no user complains — a marker in the shell gets renamed,
 * the injection silently stops matching, and six weeks later every page is
 * being served with no title to anybody who does not run JavaScript. The
 * failure has no symptom until traffic is gone.
 *
 * So the rules that have to hold are assertions rather than intentions:
 *
 *   - Every rendered page has exactly one title, one canonical, one meta
 *     description, and JSON-LD that parses.
 *   - The canonical is the URL the page is actually at.
 *   - The body content is in the HTML, not just promised by a script tag.
 *   - A post titled `</title><script>` cannot close the title or open a
 *     script — the crawlable surface takes content from clinics and from the
 *     public, so it is an injection surface like any other.
 *   - The XML documents are well-formed enough to survive a strict parser.
 *   - Pages that must never be indexed say so.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  SITE,
  canonicalUrl,
  escapeXml,
  graph,
  headTags,
  isoDate,
  jsonLdScript,
  llmsTxt,
  metaDescription,
  plainText,
  renderIntoShell,
  rfc822,
  robotsTxt,
  rssXml,
  sitemapIndexXml,
  sitemapXml
} from "../src/seo.js";

import {
  renderForum,
  renderNoIndex,
  renderNotFound,
  renderPost,
  renderPostList,
  renderThread
} from "../apps/blog/src/pages.js";

import { bylineFor } from "../src/content.js";
import { renderMarkdown } from "../src/markdown.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BLOG_SHELL = readFileSync(join(root, "apps/blog/public/index.html"), "utf8");

let checks = 0;
function assert(condition, message) {
  checks += 1;
  if (!condition) throw new Error(`SEO: ${message}`);
}
function assertEqual(actual, expected, message) {
  assert(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

/* ─────────────────────────────────────────────────────────────── helpers ── */

const countOf = (html, pattern) => (html.match(pattern) || []).length;

function jsonLdBlocks(html) {
  const blocks = [];
  const pattern = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let match;
  while ((match = pattern.exec(html))) blocks.push(JSON.parse(match[1]));
  return blocks;
}

/** Cheap well-formedness: tags balance, and nothing unescaped slipped in. */
function assertWellFormedXml(xml, label) {
  assert(xml.startsWith("<?xml "), `${label}: missing XML declaration`);
  const stack = [];
  const pattern = /<(\/?)([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let match;
  while ((match = pattern.exec(xml))) {
    const [, closing, name, , selfClosing] = match;
    if (closing) {
      assertEqual(stack.pop(), name, `${label}: mismatched </${name}>`);
    } else if (!selfClosing) {
      stack.push(name);
    }
  }
  assertEqual(stack.length, 0, `${label}: unclosed elements ${stack.join(",")}`);
  // A raw & that is not the start of an entity is the classic way a feed
  // becomes unparseable the first time somebody writes "Cats & Dogs".
  const stripped = xml.replace(/<\?xml[\s\S]*?\?>/g, "");
  assert(!/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(stripped), `${label}: raw ampersand`);
}

/* ─────────────────────────────────────────────────────── the primitives ── */

assertEqual(canonicalUrl("https://blog.timinow.pet/", "/p/thing/"), "https://blog.timinow.pet/p/thing", "canonical strips the trailing slash");
assertEqual(canonicalUrl("https://timinow.pet", "/"), "https://timinow.pet/", "canonical keeps the root slash");
assertEqual(canonicalUrl("https://timinow.pet", "/a?b=c#d"), "https://timinow.pet/a", "canonical drops query and fragment");

assert(metaDescription("a".repeat(400)).length <= 156, "description is capped");
assert(metaDescription("short").endsWith("short"), "a short description is left alone");
assert(!/\s…$/.test(metaDescription("word ".repeat(80))), "the ellipsis follows a word, not a space");

assertEqual(plainText("## Heading\n\n**bold** and [a link](https://x.test)"), "Heading bold and a link", "markdown reduces to words");

assertEqual(escapeXml("Cats & Dogs <3"), "Cats &amp; Dogs &lt;3", "xml entities are escaped");
const NUL = String.fromCharCode(0);
assert(!escapeXml("bad" + NUL + "null").includes(NUL), "control characters are stripped from XML");
assertEqual(escapeXml("bad" + NUL + "null"), "badnull", "the illegal character is removed, not replaced");

assert(rfc822("2026-09-18T10:00:00Z").includes("2026"), "rfc822 keeps the year");
assertEqual(isoDate("2026-09-18 10:00:00"), "2026-09-18T10:00:00.000Z", "D1's space-separated timestamps parse");
assertEqual(isoDate("nonsense"), null, "an unparseable date is null, not Invalid Date");

/* JSON-LD must not be able to end its own script element. */
{
  const hostile = jsonLdScript({ name: "</script><img src=x onerror=alert(1)>", note: "<!--", amp: "a & b" });
  assert(!hostile.toLowerCase().includes("</script><img"), "json-ld cannot close its script element");
  assertEqual(countOf(hostile, /<\/script>/g), 1, "json-ld has exactly one closing tag");
  assert(!hostile.includes("<!--"), "json-ld cannot open an HTML comment");
  const parsed = JSON.parse(hostile.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, ""));
  assertEqual(parsed.name, "</script><img src=x onerror=alert(1)>", "escaping is reversible — the value survives");
}

/* ──────────────────────────────────────────────────────────── the files ── */

{
  const xml = sitemapXml([
    { loc: "https://blog.timinow.pet/", changefreq: "daily", priority: 0.9 },
    { loc: "https://blog.timinow.pet/p/cats-&-dogs", lastmod: "2026-09-18T00:00:00.000Z" },
    { loc: null, lastmod: "ignored" }
  ]);
  assertWellFormedXml(xml, "sitemap");
  assertEqual(countOf(xml, /<url>/g), 2, "an entry with no loc is dropped rather than emitted empty");
  assert(xml.includes("cats-&amp;-dogs"), "a slug with an ampersand is escaped");
}

assertWellFormedXml(sitemapIndexXml([{ loc: "https://timinow.pet/sitemap.xml", lastmod: "2026-09-18T00:00:00.000Z" }]), "sitemap index");

{
  const xml = rssXml({
    title: "Notes — Tími NOW",
    link: SITE.blogOrigin,
    feedUrl: `${SITE.blogOrigin}/feed.xml`,
    description: "Cats & dogs",
    items: [{ title: "A <post> & a title", link: `${SITE.blogOrigin}/p/x`, published: "2026-09-18T00:00:00Z", author: "Caleb Owen", description: "Body" }]
  });
  assertWellFormedXml(xml, "rss");
  assert(xml.includes("<atom:link"), "rss declares its own address");
  assert(xml.includes("A &lt;post&gt; &amp; a title"), "rss escapes item titles");
  assert(xml.includes("<pubDate>"), "rss items carry a date");
}

{
  const robots = robotsTxt({ sitemaps: ["https://blog.timinow.pet/sitemap.xml"], disallow: ["/api/"], host: "blog.timinow.pet" });
  assert(robots.includes("Sitemap: https://blog.timinow.pet/sitemap.xml"), "robots points at the sitemap");
  assert(robots.includes("Disallow: /api/"), "robots keeps crawlers out of the JSON");
  // The whole point of this pass: the assistants are welcome.
  for (const agent of ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended", "Applebot-Extended"]) {
    assert(robots.includes(`User-agent: ${agent}`), `robots names ${agent}`);
  }
  assert(!/User-agent: \*\s*\nDisallow: \/\s*$/m.test(robots), "the public robots does not disallow everything");

  const console_ = robotsTxt({ allowAll: false, sitemaps: [] });
  assert(/User-agent: \*\n\s*Disallow: \/\n/.test(console_), "a console's robots disallows everything");
  assert(!console_.includes("GPTBot"), "a console does not invite assistants in");
}

{
  const text = llmsTxt({
    title: "Tími NOW",
    summary: "What it is.",
    sections: [{ heading: "Start here", links: [{ title: "Home", url: "https://timinow.pet", note: "the app" }] }]
  });
  assert(text.startsWith("# Tími NOW"), "llms.txt opens with an H1");
  assert(text.includes("> What it is."), "llms.txt carries the blockquote summary");
  assert(text.includes("- [Home](https://timinow.pet): the app"), "llms.txt links are markdown");
}

/* ───────────────────────────────────────────────── the shell, and drift ── */

/**
 * These markers are the contract between the HTML files and renderIntoShell.
 * If somebody reformats the shell, this is the assertion that tells them what
 * they just disconnected — rather than production quietly serving pages with
 * two titles or none.
 */
assert(/<title>[\s\S]*?<\/title>/.test(BLOG_SHELL), "the blog shell still has a <title> to replace");
assert(/<meta\s+name="description"[^>]*>/i.test(BLOG_SHELL), "the blog shell still has a description to replace");
assert(/<main[^>]*>/.test(BLOG_SHELL), "the blog shell still has a <main> to render into");
assert(BLOG_SHELL.includes("</head>"), "the blog shell still has a </head>");
assert(/<section class="view" data-view="posts">/.test(BLOG_SHELL), "the blog shell's default view is still unhidden markup");
assert(readFileSync(join(root, "apps/blog/public/app.js"), "utf8").includes('querySelector("[data-ssr]")'),
  "the blog app still removes the server-rendered block when it takes over");

/* ────────────────────────────────────────────────────── the blog pages ── */

const post = {
  id: "post_1",
  slug: "grapes-and-dogs",
  title: "What to do if your dog ate grapes",
  excerpt: "Grapes and raisins can cause kidney failure in dogs. What to do, and how fast.",
  authorKind: "platform",
  authorName: "Caleb Owen",
  providerName: null,
  publishedAt: "2026-09-10 12:00:00",
  updatedAt: "2026-09-12 08:00:00",
  bodyMarkdown: "## Act quickly\n\nCall a veterinarian **now**. Do not wait for symptoms."
};
post.byline = bylineFor(post);

function assertPageBasics(html, { canonical, label, ssr = true }) {
  assertEqual(countOf(html, /<title>/g), 1, `${label}: exactly one title`);
  assertEqual(countOf(html, /<link rel="canonical"/g), 1, `${label}: exactly one canonical`);
  assertEqual(countOf(html, /<meta name="description"/g), 1, `${label}: exactly one description`);
  assert(html.includes(`<link rel="canonical" href="${canonical}">`), `${label}: canonical is ${canonical}`);
  assert(html.includes('<meta property="og:title"'), `${label}: has Open Graph`);
  assert(html.includes('<meta name="twitter:card"'), `${label}: has a Twitter card`);
  // Blog pages are injected into the app shell and carry the marker the app
  // removes on boot; the landing documents are whole pages and have no shell
  // to inject into. Either way the content is in the first response.
  if (ssr) assert(html.includes("<div data-ssr>"), `${label}: server-rendered body is present`);
  const blocks = jsonLdBlocks(html);
  assert(blocks.length >= 1, `${label}: has JSON-LD`);
  for (const block of blocks) assertEqual(block["@context"], "https://schema.org", `${label}: JSON-LD declares its context`);
}

{
  const html = renderPostList(BLOG_SHELL, [post]);
  assertPageBasics(html, { canonical: "https://blog.timinow.pet/", label: "post list" });
  assert(html.includes(post.title), "post list shows the post title in the HTML");
  assert(html.includes('href="/p/grapes-and-dogs"'), "post list links to the post");
  assert(html.includes('rel="alternate" type="application/rss+xml"'), "post list advertises the feed");
  const list = jsonLdBlocks(html)[0]["@graph"].find((node) => node["@type"] === "CollectionPage");
  assertEqual(list.mainEntity.itemListElement[0].name, post.title, "the item list names the post");
  // Every built-in view starts hidden so the server-rendered one is what shows.
  assert(!/<section class="view" data-view="posts">/.test(html), "the app's own default view is hidden on a rendered page");
}

{
  const html = renderPost(BLOG_SHELL, post, { html: renderMarkdown(post.bodyMarkdown), comments: [
    { authorName: "A reader", body: "Thank you, we went in.", createdAt: "2026-09-11 09:00:00" }
  ] });
  assertPageBasics(html, { canonical: "https://blog.timinow.pet/p/grapes-and-dogs", label: "post" });
  assert(html.includes("Act quickly"), "the post body is in the served HTML");
  assert(html.includes("Call a veterinarian"), "the post body is rendered, not summarised");
  assert(html.includes("Thank you, we went in."), "comments are in the served HTML");
  assert(html.includes("not veterinary advice"), "the advice notice travels with the words it qualifies");
  assert(html.includes('<meta property="og:type" content="article">'), "a post is an article");
  const article = jsonLdBlocks(html)[0]["@graph"].find((node) => node["@type"] === "BlogPosting");
  assertEqual(article.headline, post.title, "BlogPosting headline matches");
  assertEqual(article.datePublished, "2026-09-10T12:00:00.000Z", "BlogPosting carries the publish date");
  assertEqual(article.author.name, "Caleb Owen", "BlogPosting names the author");
  const crumbs = jsonLdBlocks(html)[0]["@graph"].find((node) => node["@type"] === "BreadcrumbList");
  assertEqual(crumbs.itemListElement.length, 2, "a post has two breadcrumbs");
}

/* A clinic's post must carry its non-endorsement into the crawlable copy. */
{
  const clinicPost = {
    ...post, slug: "clinic-post", authorKind: "provider", providerName: "Bayview Animal Hospital", authorName: "Dr. Rivera"
  };
  clinicPost.byline = bylineFor(clinicPost);
  const html = renderPost(BLOG_SHELL, clinicPost, { html: renderMarkdown(clinicPost.bodyMarkdown), comments: [] });
  assert(html.includes("Bayview Animal Hospital"), "the clinic is named");
  assert(html.includes("does not review or endorse"), "the non-endorsement is in the served HTML");
}

/* Injection: the title and body come from clinics and from the public. */
{
  const hostile = {
    ...post,
    slug: "hostile",
    title: '</title><script>alert(1)</script><img src=x onerror=alert(2)>',
    excerpt: '"><script>alert(3)</script>',
    bodyMarkdown: "<script>alert(4)</script>\n\n[x](javascript:alert(5))"
  };
  hostile.byline = bylineFor(hostile);
  const html = renderPost(BLOG_SHELL, hostile, { html: renderMarkdown(hostile.bodyMarkdown), comments: [
    { authorName: "<script>alert(6)</script>", body: "<script>alert(7)</script>", createdAt: "2026-09-11 09:00:00" }
  ] });
  assertEqual(countOf(html, /<script>alert\(/g), 0, "no injected script survives anywhere on the page");
  assertEqual(countOf(html, /<title>/g), 1, "a hostile title cannot open a second title element");
  // The text may still read `onerror=` — escaped, as words. What must not
  // exist is a tag: an assertion on the substring alone would pass for a page
  // that renders the attack and fail for one that correctly prints it.
  assert(!/<img[^>]*onerror/i.test(html), "no injected event handler survives as an attribute");
  assert(html.includes("&lt;img src=x onerror=alert(2)&gt;"), "the attack renders as visible text instead");
  assert(!/href="javascript:/i.test(html), "a javascript: link is not rendered as a link");
  // The only scripts on the page are the ones the shell and this module put there.
  for (const tag of html.match(/<script[^>]*>/g) || []) {
    assert(/type="application\/ld\+json"/.test(tag) || /src="\/app\.js"/.test(tag), `unexpected script tag: ${tag}`);
  }
}

{
  const thread = {
    thread: {
      id: "t1", slug: "is-this-an-emergency", kind: "question",
      title: "Is a limp after a walk an emergency?",
      body: "He is putting weight on it but favouring the left back leg.",
      authorName: "Sam", authorKind: "member", replyCount: 1, createdAt: "2026-09-14 18:00:00"
    },
    replies: [{ id: "r1", body: "If he is bearing weight it can usually wait for morning.", authorName: "Dr. Rivera", authorKind: "provider", providerName: "Bayview Animal Hospital", createdAt: "2026-09-14 19:00:00" }]
  };
  const html = renderThread(BLOG_SHELL, thread);
  assertPageBasics(html, { canonical: "https://blog.timinow.pet/t/is-this-an-emergency", label: "thread" });
  assert(html.includes("favouring the left back leg"), "the thread body is in the served HTML");
  assert(html.includes("bearing weight it can usually wait"), "replies are in the served HTML — they are the answer");
  const discussion = jsonLdBlocks(html)[0]["@graph"].find((node) => node["@type"] === "DiscussionForumPosting");
  assertEqual(discussion.comment.length, 1, "the discussion carries its replies");
  assertEqual(discussion.interactionStatistic.userInteractionCount, 1, "the reply count is declared");
  assertEqual(discussion.comment[0].author.name, "Dr. Rivera", "a reply names its author");
}

{
  const html = renderForum(BLOG_SHELL, [{ slug: "a", kind: "question", title: "A question", authorName: "Sam", replyCount: 0, createdAt: "2026-09-14 18:00:00" }]);
  assertPageBasics(html, { canonical: "https://blog.timinow.pet/forum", label: "forum" });
  assert(html.includes('href="/t/a"'), "the forum links to its threads");
}

{
  const html = renderNotFound(BLOG_SHELL, { path: "/p/nothing-here" });
  assert(html.includes('content="noindex, follow"'), "a missing page is not indexed");
  assert(html.includes("Not found"), "a missing page says so");
}

{
  const html = renderNoIndex(BLOG_SHELL, { path: "/subscribe/confirm", title: "Confirming", description: "..." });
  assert(html.includes('content="noindex, nofollow"'), "a tokened page is neither indexed nor followed");
}

/* ─────────────────────────────────────────────────────────── head tags ── */

{
  const head = headTags({ title: "T", description: "D", canonical: "https://x.test/a" });
  assert(head.includes("max-snippet:-1"), "snippets are uncapped, which is what an answer engine quotes");
  assert(head.includes("max-image-preview:large"), "image previews are allowed at full size");
  const hostile = headTags({ title: '"><script>x</script>', description: "d", canonical: "https://x.test/a" });
  assert(!hostile.includes("<script>"), "a hostile title cannot break out of a meta attribute");
}

{
  const nodes = jsonLdBlocks(graph([{ "@type": "Thing", name: "x" }, null]))[0]["@graph"];
  assertEqual(nodes.length, 1, "graph drops empty nodes");
}

console.log(`SEO tests passed: ${checks} assertions across canonical URLs, descriptions, JSON-LD escaping, sitemaps, feeds, robots, llms.txt, shell markers, and every rendered blog page including a hostile post and a clinic's non-endorsement.`);

/* ────────────────────────────────────────── the Worker, end to end ── */

/**
 * The renderers above are unit-tested; this is the wiring. A page that renders
 * perfectly and is never routed to is the same outcome as no page at all —
 * and that is the precise failure this repository has already shipped once,
 * when `run_worker_first` meant the Worker never ran for a page request.
 *
 * No database: content-store returns empty lists without one, so this
 * exercises routing, status codes, headers and the XML documents rather than
 * the content, which the sections above cover.
 */
{
  const { default: worker } = await import("../apps/blog/src/index.js");
  const env = {
    SURFACE: "blog",
    ASSETS: { fetch: async () => new Response(BLOG_SHELL, { headers: { "content-type": "text/html" } }) }
  };
  const get = (path) => worker.fetch(new Request(`https://blog.timinow.pet${path}`), env);

  const home = await get("/");
  assertEqual(home.status, 200, "the blog root is served by the Worker");
  assertEqual(home.headers.get("content-type"), "text/html; charset=utf-8", "the root is HTML");
  assert(home.headers.get("content-security-policy"), "a rendered page still carries the CSP");
  const homeHtml = await home.text();
  assert(homeHtml.includes('<link rel="canonical" href="https://blog.timinow.pet/">'), "the root declares its canonical");
  assert(homeHtml.includes("<div data-ssr>"), "the root is server-rendered");

  const robots = await get("/robots.txt");
  assertEqual(robots.status, 200, "robots.txt is served");
  assert((await robots.text()).includes("Sitemap: https://blog.timinow.pet/sitemap.xml"), "robots.txt points at the sitemap");

  const map = await get("/sitemap.xml");
  assertEqual(map.headers.get("content-type"), "application/xml; charset=utf-8", "the sitemap is XML");
  const mapBody = await map.text();
  assertWellFormedXml(mapBody, "served sitemap");
  assert(mapBody.includes("<loc>https://blog.timinow.pet/forum</loc>"), "the sitemap lists the forum");

  const rss = await get("/feed.xml");
  assertWellFormedXml(await rss.text(), "served feed");

  const llms = await get("/llms.txt");
  assert((await llms.text()).includes("blog.timinow.pet/feed.xml"), "llms.txt points at the feed");

  const missing = await get("/p/nothing-here");
  assertEqual(missing.status, 404, "an unknown post is a real 404, not a soft one");
  assert((await missing.text()).includes("noindex"), "an unknown post is not indexed");

  const missingThread = await get("/t/nothing-here");
  assertEqual(missingThread.status, 404, "an unknown thread is a real 404");

  // Anything the Worker does not claim still reaches the assets untouched.
  const asset = await get("/styles.css");
  assertEqual(asset.status, 200, "assets still fall through to the asset binding");

  const posted = await worker.fetch(new Request("https://blog.timinow.pet/", { method: "POST" }), env);
  assert(posted.status !== 200 || !(await posted.text()).includes("data-ssr"), "a POST is not answered with a rendered page");
}

console.log("SEO integration: the blog Worker serves rendered pages, robots.txt, sitemap.xml, feed.xml and llms.txt, and answers 404 for content that does not exist.");

/* ───────────────────────────────────────────── the landing documents ── */

/**
 * The five pages that exist because the app routes on the hash and a fragment
 * is not a URL. Each has to be a complete document, say true things, and keep
 * saying the same prices as src/pricing.js.
 */
{
  const { LANDING_PAGES, renderLandingPage } = await import("../src/landing.js");
  const { FALLBACK_PRICING } = await import("../src/pricing.js");

  const paths = Object.keys(LANDING_PAGES);
  assertEqual(paths.length, 5, "five landing pages");
  const titles = new Set();
  const descriptions = new Set();

  for (const path of paths) {
    const html = renderLandingPage(path);
    const canonical = `https://timinow.pet${path}`;
    assert(html.startsWith("<!doctype html>"), `${path}: is a whole document`);
    assert(html.includes('<html lang="en">'), `${path}: declares its language`);
    assertPageBasics(html, { canonical, label: path, ssr: false });
    assertEqual(countOf(html, /<h1>/g), 1, `${path}: exactly one h1`);

    // Distinct titles and descriptions, or these pages compete with each other
    // instead of with anybody else.
    const title = /<title>([^<]*)<\/title>/.exec(html)[1];
    const description = /<meta name="description" content="([^"]*)"/.exec(html)[1];
    assert(!titles.has(title), `${path}: title is unique`);
    assert(!descriptions.has(description), `${path}: description is unique`);
    titles.add(title);
    descriptions.add(description);
    assert(title.length <= 75, `${path}: title fits a result (${title.length} chars)`);

    // Every page reaches the app and the other pages: an orphan ranks alone.
    assert(html.includes('href="/#find"'), `${path}: links into the app`);
    assert(html.includes('href="/"'), `${path}: links home`);
    assert(html.includes("blog.timinow.pet"), `${path}: links to the blog`);

    // No script at all. These are documents; a marketing page that boots a
    // single-page app to show a paragraph fights its own router.
    assertEqual(countOf(html, /<script(?! type="application\/ld\+json")/g), 0, `${path}: ships no JavaScript`);

    const nodes = jsonLdBlocks(html)[0]["@graph"];
    assert(nodes.some((node) => node["@type"] === "Organization"), `${path}: declares the organisation`);
    assert(nodes.some((node) => node["@type"] === "Service"), `${path}: declares the service`);
    const faq = nodes.find((node) => node["@type"] === "FAQPage");
    assert(faq && faq.mainEntity.length >= 4, `${path}: carries at least four questions`);
    for (const question of faq.mainEntity) {
      // An answer is read without the page around it, so it has to be a
      // sentence rather than a fragment that only makes sense in place.
      assert(question.acceptedAnswer.text.length > 60, `${path}: "${question.name}" has a standalone answer`);
      // Every visible question is also in the markup — FAQ structured data
      // that does not match the page is the definition of a manual action.
      assert(html.includes(question.name.replace(/&/g, "&amp;")), `${path}: "${question.name}" is visible on the page`);
    }
  }

  // The prices on the page are the prices the product charges.
  const pricingHtml = renderLandingPage("/pricing");
  assert(pricingHtml.includes(`$${FALLBACK_PRICING.ownerFeeCents / 100}`), "the pricing page quotes the owner fee from src/pricing.js");
  assert(pricingHtml.includes(`$${FALLBACK_PRICING.clinicFeeCents / 100}`), "the pricing page quotes the clinic fee from src/pricing.js");

  // Claims this repository must never make.
  for (const path of paths) {
    const html = renderLandingPage(path).toLowerCase();
    assert(!/\bnationwide\b|\banywhere in the (us|country)\b/.test(html), `${path}: makes no coverage claim the network cannot keep`);
    assert(!/soc 2/.test(html), `${path}: does not mention an audit opinion nobody has issued`);
    assert(!/\bseamless\b|\beffortless\b|\brevolutioni|\bgame.changer\b|\bcutting.edge\b|\bsupercharge\b|\ball-in-one\b|\bnext-generation\b|\bunleash\b/.test(html),
      `${path}: none of the marketing words CLAUDE.md rule 8 bans`);
  }

  // A contrast regression that a test can hold: `.landing-main a` without the
  // :not(.button) outranks .button-primary's own colour (class+element beats
  // class) and repaints the coral call-to-action blue — 1.9:1, a plain WCAG
  // 1.4.3 failure. It shipped that way once and a screenshot caught it.
  const css = readFileSync(join(root, "public/styles.css"), "utf8");
  assert(css.includes(".landing-main a:not(.button)"), "landing link colour still excludes buttons");
  assert(!/\.landing-main a \{/.test(css), "no unqualified .landing-main a rule has crept back in");

  // The page that exists for the worst moment says the right thing first.
  const emergency = renderLandingPage("/emergency-vet");
  assert(/If it looks bad, go now/i.test(emergency), "the emergency page leads with going, not with the product");
  assert(emergency.includes("is not a veterinarian"), "the emergency page says what Tími is not");

  // The fund page must not be readable as a charity or as a bill-payer.
  const bills = renderLandingPage("/help-with-vet-bills");
  assert(bills.includes("not tax-deductible") || bills.includes("not represented"), "the fund page disclaims deductibility");
  assert(/does not pay for veterinary treatment/i.test(bills), "the fund page says what it does not cover");
  assert(/not a (registered )?charity/i.test(bills), "the fund page says plainly that it is not a charity");
  // "Donation" is the word the legal centre deliberately avoids: it implies a
  // charitable gift, and this is a for-profit company's discretionary
  // programme. Every mention on the page is a contribution.
  assert(!/\bdonate\b|\bdonation/i.test(bills), "the fund page says contribution, never donation");
}

/* ─────────────────────────────────── the customer Worker, end to end ── */

{
  const { default: worker } = await import("../src/index.js");
  const shell = readFileSync(join(root, "public/index.html"), "utf8");
  const env = {
    SURFACE: "customer",
    ASSETS: { fetch: async (request) => new Response(new URL(request.url).pathname.endsWith(".css") ? "body{}" : shell, { headers: { "content-type": "text/html" } }) }
  };
  const get = (path) => worker.fetch(new Request(`https://timinow.pet${path}`), env, { waitUntil() {} });

  const robots = await (await get("/robots.txt")).text();
  assert(robots.includes("Sitemap: https://timinow.pet/sitemap.xml"), "the customer robots points at its own sitemap");
  assert(robots.includes("Sitemap: https://blog.timinow.pet/sitemap.xml"), "and at the blog's, so one file finds both");

  const map = await (await get("/sitemap.xml")).text();
  assertWellFormedXml(map, "customer sitemap");
  const { LANDING_PAGES } = await import("../src/landing.js");
  for (const path of Object.keys(LANDING_PAGES)) {
    assert(map.includes(`<loc>https://timinow.pet${path}</loc>`), `the sitemap lists ${path}`);
    const response = await get(path);
    assertEqual(response.status, 200, `${path} is served`);
    assert((await response.text()).includes("<h1>"), `${path} has content`);
  }

  const home = await get("/");
  assertEqual(home.status, 200, "the root is served");
  const homeHtml = await home.text();
  assert(homeHtml.includes('<link rel="canonical" href="https://timinow.pet/">'), "the root declares its canonical");
  assertEqual(countOf(homeHtml, /<title>/g), 1, "the root has exactly one title");
  // The app's own home screen is the root's body and must survive untouched.
  assert(homeHtml.includes('data-screen="home"'), "the root still ships the app");
  assert(homeHtml.includes("Who can see"), "the root still shows its own headline");

  const llms = await (await get("/llms.txt")).text();
  assert(llms.includes("not a veterinary practice"), "llms.txt tells a summariser what Tími is not");
  assert(llms.includes("not nationwide"), "llms.txt states the coverage limit");
}

console.log("SEO landing pages: five documents, each with unique titles, standalone FAQ answers matching the visible page, prices read from the pricing module, and no claim this product cannot keep.");

/* ───────────────────────────────────────────────── consoles stay out ── */

/**
 * The three surfaces that must never rank.
 *
 * Before this pass none of them had a robots.txt, so a crawler's only
 * instruction was the absence of one. They are consoles and a demo gallery:
 * indexing them competes with timinow.pet/for-veterinarians for the same
 * readers and wins nothing.
 */
{
  const consoles = [
    ["../apps/vet-web/src/index.js", "https://providers.timinow.pet", "veterinary console"],
    ["../apps/admin-console/src/index.js", "https://admin.timinow.pet", "platform console"],
    ["../apps/widget-demo/src/index.js", "https://widget-demo.timinow.pet", "widget gallery"]
  ];
  for (const [module, origin, label] of consoles) {
    const { default: worker } = await import(module);
    const response = await worker.fetch(new Request(`${origin}/robots.txt`), { ASSETS: { fetch: async () => new Response("", { status: 404 }) } });
    assertEqual(response.status, 200, `${label}: serves robots.txt`);
    const body = await response.text();
    assert(/User-agent: \*\n\s*Disallow: \/\n/.test(body), `${label}: tells every crawler to stay out`);
    assert(!body.includes("Sitemap:"), `${label}: offers no sitemap`);
  }

  for (const shell of ["apps/vet-web/public/index.html", "apps/admin-console/public/index.html"]) {
    const html = readFileSync(join(root, shell), "utf8");
    assert(/<meta name="robots" content="noindex/.test(html), `${shell}: says noindex in the markup too`);
  }
}

console.log("SEO consoles: the veterinary console, the platform console and the widget gallery all refuse indexing, in robots.txt and in their markup.");

/* ─────────────────────────────── the routing config, which code cannot see ── */

/**
 * Every path a Worker claims must actually reach that Worker.
 *
 * This is the assertion that was missing, and it cost a production bug in the
 * same pass that wrote it: the console robots.txt handlers were correct, the
 * unit tests passed because they stub the asset binding, and
 * providers.timinow.pet/robots.txt served index.html to crawlers because
 * `run_worker_first` in wrangler.vet.jsonc did not name it. A Worker's code
 * cannot see its own routing table; this reads the table.
 *
 * The same mechanism has now produced three separate outages in this
 * repository — pages with no security headers, a blog with no rendered
 * content, and a referral link that silently did nothing. It gets a test.
 */
{
  const stripComments = (text) => text.replace(/^\s*\/\/.*$/gm, "");
  const config = (file) => JSON.parse(stripComments(readFileSync(join(root, file), "utf8")));

  /** wrangler's globs: `*` matches within a path segment and across them. */
  const matches = (glob, path) =>
    new RegExp("^" + glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$").test(path);

  const { LANDING_PAGES } = await import("../src/landing.js");
  const surfaces = [
    ["wrangler.jsonc", ["/", "/robots.txt", "/sitemap.xml", "/llms.txt", "/r/abc", ...Object.keys(LANDING_PAGES)]],
    ["wrangler.blog.jsonc", ["/", "/forum", "/robots.txt", "/sitemap.xml", "/feed.xml", "/llms.txt", "/p/a-slug", "/t/a-slug", "/subscribe/confirm"]],
    ["wrangler.vet.jsonc", ["/robots.txt"]],
    ["wrangler.admin.jsonc", ["/robots.txt"]]
  ];

  for (const [file, claimed] of surfaces) {
    const assets = config(file).assets;
    const first = assets.run_worker_first || [];
    for (const path of claimed) {
      const reachable = first.some((glob) => matches(glob, path)) || assets.not_found_handling === "none";
      assert(reachable, `${file}: ${path} is rendered by the Worker but the asset layer answers first`);
    }
  }

  // And the reverse: a fallback that hands back the app shell with a 200 for
  // an address that does not exist is an unbounded supply of soft 404s.
  for (const file of ["wrangler.jsonc", "wrangler.blog.jsonc"]) {
    assertEqual(config(file).assets.not_found_handling, "none",
      `${file}: public surfaces answer unknown paths themselves, not with a 200 and the shell`);
  }
}

console.log("SEO routing: every path each Worker renders is reachable past the asset layer, and the two public surfaces answer their own 404s.");
