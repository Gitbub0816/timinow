/**
 * Everything a crawler, a search engine, or an answer engine reads.
 *
 * Three audiences, and they do not want the same thing:
 *
 *   A browser gets the app. It runs JavaScript, so a single-page shell that
 *   fills itself in from /api is fine, and that is what every Tími surface
 *   has always served.
 *
 *   A search crawler will usually run JavaScript too, eventually, on a second
 *   pass, if it feels like spending the budget. Googlebot renders; most of
 *   the rest render less, or later, or not at all.
 *
 *   An answer engine — the thing that decides whether Tími is the answer when
 *   somebody asks an assistant where to take a dog that is vomiting blood at
 *   one in the morning — very largely does NOT run JavaScript. It fetches the
 *   URL, reads the HTML that comes back, and moves on. A page whose entire
 *   content arrives by fetch() after boot is, to that reader, an empty
 *   document with a loading spinner in it.
 *
 * So the rule this module exists to enforce: every URL worth ranking answers
 * with its real content, its real title, and its real machine-readable
 * description in the FIRST response, before a line of JavaScript runs. The
 * app still hydrates over the top of it — see the `data-ssr` block each
 * surface injects, and the one line in each app.js that removes it.
 *
 * Nothing in here fetches anything or touches a database. It is string
 * building, so it can be unit-tested (scripts/seo-test.mjs) and cannot be the
 * reason a page is slow.
 */

import { escapeHtml } from "./markdown.js";

/**
 * The identity every surface declares. One copy, because an Organization
 * block that disagrees with itself across four subdomains is worse for an
 * entity graph than having none at all: the whole point is that a machine can
 * tell these are one company.
 */
export const SITE = {
  /** As written on the customer site's own title and wordmark. */
  name: "Tími NOW",
  /**
   * The spellings people actually type. The accent is the problem: somebody
   * who heard the name says "timi now", and a search engine that has never
   * seen the ASCII form written down has no reason to connect the two.
   */
  alternateNames: ["TímiNOW", "TimiNOW", "Timi NOW", "Timinow"],
  // Spelled as the legal notices spell it. An entity whose name is written
  // two ways across its own pages is two weaker entities to anything trying
  // to corroborate it.
  legalName: "ClearKey Solutions, LLC",
  /**
   * Where the company is, which is a fact the legal centre already states.
   * No street address: one that is not a real place of business is worse than
   * none, and locality/region is what actually helps a machine place a
   * California veterinary service in California.
   */
  address: { locality: "Hayward", region: "CA", country: "US" },
  customerOrigin: "https://timinow.pet",
  /**
   * The blog lives at timinow.pet/blog, not on its own subdomain.
   *
   * Subdomains are separate sites to a search engine. Everything a post earns
   * — links, citations, the standing that comes from being quoted — accrues
   * to blog.timinow.pet and reaches timinow.pet only weakly, and the reverse
   * is just as true: the main site's standing does not help a new post rank.
   * One domain, one pool. It is worth doing now and unpleasant to do later,
   * which is the whole argument for doing it with one post published rather
   * than fifty.
   *
   * blogOrigin is kept because the old host still exists and redirects to the
   * new one; nothing should build a link from it.
   */
  blogBase: "https://timinow.pet/blog",
  blogPath: "/blog",
  blogOrigin: "https://blog.timinow.pet",
  providerOrigin: "https://providers.timinow.pet",
  /**
   * One sentence, written to be quoted back by an assistant rather than to
   * win a headline. Concrete verbs, no adjectives a competitor could also
   * claim, and the distinguishing fact (capacity reported by the clinic,
   * now) in the first clause.
   */
  description:
    "Tími NOW shows which veterinary hospitals near you have said they can take another patient right now, "
    + "with the time each clinic reported it, so you know who can actually see your pet before you drive.",
  logo: "https://timinow.pet/assets/icons/icon-512.png",
  /** 1200×653. A real illustration from the site, not a generated card. */
  image: "https://timinow.pet/assets/art/find-care-hero.png",
  email: "hello@timinow.pet",
  /**
   * Deliberately empty. `sameAs` is how an entity is corroborated across the
   * web, and it is also the single easiest place to publish a link to an
   * account that does not exist. Add profiles here when they are real.
   */
  sameAs: []
};

/* ───────────────────────────────────────────────────────── small helpers ── */

/** Attribute-safe, and the only escaper used for anything interpolated. */
const attr = (value) => escapeHtml(value == null ? "" : String(value));

/**
 * Built from a string rather than written as a literal character class, so
 * this file contains no control characters itself. A source file with a NUL
 * in it is a file git and grep treat as binary and stop showing you — which
 * scripts/syntax.mjs catches, and did.
 */
const XML_ILLEGAL = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]", "g");

/**
 * XML, not HTML. A sitemap or a feed is parsed strictly: one stray `&` in a
 * post title and the whole document is rejected, which is a silent,
 * total loss of indexing rather than a visible bug.
 */
export function escapeXml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // Control characters are not legal in XML 1.0 at all, and a post body
    // pasted out of a word processor is where they come from.
    .replace(XML_ILLEGAL, "");
}

/**
 * Canonical form: origin + path, no query, no fragment, no trailing slash
 * except at the root.
 *
 * A canonical that varies by however the visitor arrived — a utm tag, a
 * trailing slash, an uppercase letter — splits one page's standing across
 * several URLs, which is the most common way a small site competes with
 * itself and loses.
 */
export function canonicalUrl(origin, path = "/") {
  const clean = String(path || "/").split("#")[0].split("?")[0];
  const normalized = clean === "/" ? "/" : "/" + clean.replace(/^\/+/, "").replace(/\/+$/, "");
  return String(origin).replace(/\/+$/, "") + normalized;
}

/**
 * A description that fits, cut at a word rather than mid-syllable.
 *
 * ~155 characters is where Google has historically truncated; the number
 * matters less than not handing an answer engine a sentence that stops in the
 * middle of a clinical instruction.
 */
export function metaDescription(text, maxLength = 155) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (flat.length <= maxLength) return flat;
  const cut = flat.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.\s]+$/, "") + "…";
}

/**
 * Markdown down to the words, for a description or a feed summary.
 *
 * Not a parser: it strips the marks that would otherwise show up as literal
 * asterisks in a search result. Anything it misses is cosmetic, and anything
 * it produces is escaped by the caller before it reaches a page.
 */
export function plainText(markdown) {
  return String(markdown || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** RFC-822, which is what RSS wants and ISO-8601 is not. */
export function rfc822(value) {
  const date = value ? new Date(value) : new Date();
  return (Number.isNaN(date.getTime()) ? new Date() : date).toUTCString();
}

/** W3C date for `lastmod`, tolerant of the several shapes D1 stores. */
export function isoDate(value) {
  if (!value) return null;
  const text = String(value);
  const date = new Date(text.includes("T") ? text : text.replace(" ", "T") + "Z");
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/* ─────────────────────────────────────────────────────────── structured ── */

/**
 * JSON-LD, serialised so it cannot end the script element that contains it.
 *
 * `</script>` inside a string is the classic escape, and `<!--` opens an HTML
 * comment that swallows the rest of the block. Escaping the three characters
 * as \u sequences is still valid JSON, still parsed identically by every
 * consumer, and closes both. This matters more here than on most sites: the
 * fields below carry titles typed by clinics and by the public.
 */
export function jsonLdScript(data) {
  const payload = JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
  return `<script type="application/ld+json">${payload}</script>`;
}

export function organizationSchema() {
  const organization = {
    "@type": "Organization",
    "@id": `${SITE.customerOrigin}/#organization`,
    name: SITE.name,
    alternateName: SITE.alternateNames,
    legalName: SITE.legalName,
    url: SITE.customerOrigin,
    logo: SITE.logo,
    description: SITE.description,
    email: SITE.email,
    address: {
      "@type": "PostalAddress",
      addressLocality: SITE.address.locality,
      addressRegion: SITE.address.region,
      addressCountry: SITE.address.country
    }
  };
  // Omitted rather than empty: an empty sameAs array is a claim that this
  // company has no presence anywhere, which is worse than saying nothing.
  if (SITE.sameAs.length) organization.sameAs = SITE.sameAs;
  return organization;
}

/**
 * The site itself, with the one thing that earns a sitelinks search box: a
 * real query endpoint. `/?q=` is the customer app's own search entry.
 */
export function websiteSchema() {
  return {
    "@type": "WebSite",
    "@id": `${SITE.customerOrigin}/#website`,
    url: SITE.customerOrigin,
    name: SITE.name,
    description: SITE.description,
    publisher: { "@id": `${SITE.customerOrigin}/#organization` },
    inLanguage: "en-US"
  };
}

export function breadcrumbSchema(items) {
  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: item.url
    }))
  };
}

/**
 * A question and its answer, in the shape an answer engine lifts verbatim.
 *
 * Every answer here has to be true and has to stand alone, because it will be
 * read without the page around it. No answer may imply Tími can tell somebody
 * their animal is fine.
 */
export function faqSchema(entries) {
  return {
    "@type": "FAQPage",
    mainEntity: entries.map((entry) => ({
      "@type": "Question",
      name: entry.question,
      acceptedAnswer: { "@type": "Answer", text: entry.answer }
    }))
  };
}

export function articleSchema({ url, headline, description, published, modified, authorName, authorCredentials = null, reviewer = null, image }) {
  const article = {
    "@type": "BlogPosting",
    "@id": `${url}#post`,
    mainEntityOfPage: url,
    url,
    headline,
    description,
    publisher: { "@id": `${SITE.customerOrigin}/#organization` },
    inLanguage: "en-US",
    isAccessibleForFree: true
  };
  if (published) article.datePublished = published;
  article.dateModified = modified || published || undefined;
  if (authorName) {
    article.author = { "@type": "Person", name: authorName };
    // honorificSuffix is where a credential belongs: "Ana Rivera, DVM" as a
    // name is a string, while the suffix is a fact a consumer can read.
    if (authorCredentials) article.author.honorificSuffix = authorCredentials;
  }
  /**
   * reviewedBy, for a health topic.
   *
   * This is the field that distinguishes a page somebody wrote from a page a
   * veterinarian stands behind, and on YMYL subjects that distinction is most
   * of the quality signal available. Emitted only from stored values — there
   * is no default and no inference, because a fabricated reviewer is a false
   * statement about a real, licensed person.
   */
  if (reviewer?.name) {
    article.reviewedBy = { "@type": "Person", name: reviewer.name };
    if (reviewer.credentials) article.reviewedBy.honorificSuffix = reviewer.credentials;
    if (reviewer.reviewedAt) article.lastReviewed = reviewer.reviewedAt;
  }
  if (image) article.image = image;
  return article;
}

/**
 * A forum thread, which is its own schema type and not an Article.
 *
 * Getting this right is most of why a thread can surface as a discussion
 * result rather than as a thin page: the type says "people talking", the
 * reply count says how much talking, and `comment` carries the answers that
 * are the reason anybody wanted the page.
 */
export function discussionSchema({ url, headline, text, published, authorName, replies = [] }) {
  const discussion = {
    "@type": "DiscussionForumPosting",
    "@id": `${url}#thread`,
    mainEntityOfPage: url,
    url,
    headline,
    text,
    inLanguage: "en-US",
    publisher: { "@id": `${SITE.customerOrigin}/#organization` }
  };
  if (published) discussion.datePublished = published;
  if (authorName) discussion.author = { "@type": "Person", name: authorName };
  discussion.interactionStatistic = {
    "@type": "InteractionCounter",
    interactionType: "https://schema.org/CommentAction",
    userInteractionCount: replies.length
  };
  if (replies.length) {
    discussion.comment = replies.map((reply) => ({
      "@type": "Comment",
      text: reply.text,
      datePublished: reply.published || undefined,
      author: { "@type": "Person", name: reply.authorName || "Member" }
    }));
  }
  return discussion;
}

/** Wraps any number of schema objects in one graph, which is the tidy form. */
export function graph(nodes) {
  return jsonLdScript({ "@context": "https://schema.org", "@graph": nodes.filter(Boolean) });
}

/* ───────────────────────────────────────────────────────────────── head ── */

/**
 * The tags that decide how a URL is titled, described, deduplicated and
 * previewed, everywhere.
 *
 * `canonical` is not optional and there is no default: a page that does not
 * say which URL it is gets one guessed for it.
 */
export function headTags({
  title,
  description,
  canonical,
  image = SITE.image,
  type = "website",
  robots = "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1",
  published = null,
  modified = null,
  feed = null,
  siteName = SITE.name
}) {
  const shortDescription = metaDescription(description);
  const tags = [
    `<title>${attr(title)}</title>`,
    `<meta name="description" content="${attr(shortDescription)}">`,
    `<link rel="canonical" href="${attr(canonical)}">`,
    `<meta name="robots" content="${attr(robots)}">`,
    // max-snippet:-1 above is the one that matters for answer engines: it
    // lifts the cap on how much of the page may be quoted in a result, which
    // is exactly the quoting an assistant does.
    `<meta property="og:type" content="${attr(type)}">`,
    `<meta property="og:title" content="${attr(title)}">`,
    `<meta property="og:description" content="${attr(shortDescription)}">`,
    `<meta property="og:url" content="${attr(canonical)}">`,
    `<meta property="og:site_name" content="${attr(siteName)}">`,
    `<meta property="og:locale" content="en_US">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${attr(title)}">`,
    `<meta name="twitter:description" content="${attr(shortDescription)}">`
  ];
  if (image) {
    tags.push(`<meta property="og:image" content="${attr(image)}">`);
    tags.push(`<meta name="twitter:image" content="${attr(image)}">`);
  }
  if (published) tags.push(`<meta property="article:published_time" content="${attr(published)}">`);
  if (modified) tags.push(`<meta property="article:modified_time" content="${attr(modified)}">`);
  if (feed) tags.push(`<link rel="alternate" type="application/rss+xml" title="${attr(siteName)}" href="${attr(feed)}">`);
  return tags.join("\n  ");
}

/* ──────────────────────────────────────────────────────────────── files ── */

/**
 * robots.txt.
 *
 * Two decisions worth stating rather than leaving to a default:
 *
 * The assistant crawlers are allowed, explicitly. GPTBot, ClaudeBot,
 * PerplexityBot, Google-Extended and Applebot-Extended are opt-OUT tokens —
 * saying nothing already permits them — so these lines change no behaviour
 * and exist to record that it is deliberate. Somebody will eventually propose
 * blocking them to "protect the content"; the content is a directory of which
 * veterinary hospitals can see a patient tonight, and being quoted by an
 * assistant at 1am is the product working.
 *
 * /api/ is disallowed everywhere. Not for secrecy — those endpoints enforce
 * their own authorisation and the public ones are public — but because a
 * crawler working through paginated JSON burns budget that should be spent on
 * pages, and JSON in an index is a result nobody can use.
 */
export function robotsTxt({ sitemaps = [], disallow = [], allowAll = true, host = null }) {
  const lines = [];
  if (allowAll) {
    lines.push("# Everything here is meant to be found, including by assistants.");
    lines.push("# See docs/SEO.md for why the answer-engine crawlers are welcome.");
    lines.push("");
    lines.push("User-agent: *");
    lines.push("Allow: /");
    for (const path of disallow) lines.push(`Disallow: ${path}`);
    lines.push("");
    lines.push("# Named only to record the decision; each of these is allowed by default.");
    for (const agent of ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-User", "PerplexityBot", "Perplexity-User", "Google-Extended", "Applebot-Extended", "Bingbot", "CCBot", "Amazonbot", "meta-externalagent"]) {
      lines.push(`User-agent: ${agent}`);
      lines.push("Allow: /");
      for (const path of disallow) lines.push(`Disallow: ${path}`);
      lines.push("");
    }
  } else {
    lines.push("# This surface is a console, not a publication. Nothing here is for search.");
    lines.push("");
    lines.push("User-agent: *");
    lines.push("Disallow: /");
    lines.push("");
  }
  for (const sitemap of sitemaps) lines.push(`Sitemap: ${sitemap}`);
  if (host) lines.push(`Host: ${host}`);
  return lines.join("\n") + "\n";
}

/**
 * A sitemap. Entries missing a `loc` are dropped rather than emitted empty,
 * because one malformed entry invalidates the document for some consumers and
 * a half-written sitemap is harder to notice than no sitemap.
 */
export function sitemapXml(entries) {
  const urls = entries
    .filter((entry) => entry && entry.loc)
    .map((entry) => {
      const parts = [`    <loc>${escapeXml(entry.loc)}</loc>`];
      if (entry.lastmod) parts.push(`    <lastmod>${escapeXml(entry.lastmod)}</lastmod>`);
      if (entry.changefreq) parts.push(`    <changefreq>${escapeXml(entry.changefreq)}</changefreq>`);
      if (entry.priority != null) parts.push(`    <priority>${Number(entry.priority).toFixed(1)}</priority>`);
      return `  <url>\n${parts.join("\n")}\n  </url>`;
    });
  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

/** A sitemap index, so one robots.txt can point at every surface. */
export function sitemapIndexXml(entries) {
  const maps = entries.filter((entry) => entry && entry.loc).map((entry) => {
    const parts = [`    <loc>${escapeXml(entry.loc)}</loc>`];
    if (entry.lastmod) parts.push(`    <lastmod>${escapeXml(entry.lastmod)}</lastmod>`);
    return `  <sitemap>\n${parts.join("\n")}\n  </sitemap>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${maps.join("\n")}\n</sitemapindex>\n`;
}

/**
 * RSS 2.0 rather than Atom, for the unglamorous reason that more readers,
 * aggregators and ingestion pipelines accept it without argument.
 */
export function rssXml({ title, link, description, feedUrl, items = [] }) {
  const entries = items.map((item) => [
    "    <item>",
    `      <title>${escapeXml(item.title)}</title>`,
    `      <link>${escapeXml(item.link)}</link>`,
    `      <guid isPermaLink="true">${escapeXml(item.link)}</guid>`,
    item.published ? `      <pubDate>${escapeXml(rfc822(item.published))}</pubDate>` : "",
    item.author ? `      <dc:creator>${escapeXml(item.author)}</dc:creator>` : "",
    `      <description>${escapeXml(item.description || "")}</description>`,
    "    </item>"
  ].filter(Boolean).join("\n"));

  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">\n`
    + `  <channel>\n`
    + `    <title>${escapeXml(title)}</title>\n`
    + `    <link>${escapeXml(link)}</link>\n`
    + `    <description>${escapeXml(description)}</description>\n`
    + `    <language>en-us</language>\n`
    + `    <lastBuildDate>${escapeXml(rfc822(items[0]?.published))}</lastBuildDate>\n`
    + `    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml"/>\n`
    + `${entries}\n`
    + `  </channel>\n`
    + `</rss>\n`;
}

/**
 * llms.txt — a plain-text map of the site for a model that arrived without a
 * crawl budget.
 *
 * Not a standard anybody is obliged to honour, and cheap enough to be worth
 * having anyway: it is one file that says, in the order a person would need
 * them, what this site is and which URLs answer which question. The rule for
 * writing it is the rule for the whole module — say what is true, name the
 * limits, and never imply this product can tell somebody their animal is
 * fine.
 */
export function llmsTxt({ title, summary, sections }) {
  const lines = [`# ${title}`, "", `> ${summary}`, ""];
  for (const section of sections) {
    lines.push(`## ${section.heading}`, "");
    if (section.note) lines.push(section.note, "");
    for (const link of section.links || []) {
      lines.push(`- [${link.title}](${link.url})${link.note ? `: ${link.note}` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/* ────────────────────────────────────────────────────────── shell injection ── */

/**
 * Put a server-rendered head and body into the single-page shell.
 *
 * The shell stays the one source of truth for the page's furniture — header,
 * footer, scripts — and this replaces the parts that must differ per URL. The
 * body content goes in as a `data-ssr` block that each app.js removes on boot,
 * so a browser sees it for one paint and a crawler sees it forever.
 *
 * Deliberately string surgery on known markers rather than a DOM library: a
 * Worker that pulls in an HTML parser to change a title has taken on a parser's
 * attack surface to do a `replace`. scripts/seo-test.mjs asserts each marker
 * still exists, so a shell edit that breaks one fails the build rather than
 * quietly shipping pages with no titles.
 */
export function renderIntoShell(shell, { head = "", body = "", hideViews = true }) {
  let html = shell;

  // <title> and the static description both get replaced outright; anything
  // left behind would be a second, contradictory answer to the same question.
  html = html.replace(/<title>[\s\S]*?<\/title>/, "");
  html = html.replace(/<meta\s+name="description"[^>]*>/i, "");
  html = html.replace("</head>", `  ${head}\n</head>`);

  if (body) {
    // `is-active`/absent-hidden is how each shell marks its default view. A
    // server-rendered page has already chosen a view, so every built-in one
    // starts hidden and app.js turns the right one back on.
    if (hideViews) {
      html = html.replace(/<section class="view" data-view="([a-z-]+)">/g,
        '<section class="view" data-view="$1" hidden>');
      html = html.replace(/<section class="screen ([a-z-]+) is-active"/g,
        '<section class="screen $1"');
    }
    html = html.replace(/<main([^>]*)>/, `<main$1>\n<div data-ssr>\n${body}\n</div>`);
  }
  return html;
}
