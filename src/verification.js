/**
 * Proving to Google and Bing that we own this site.
 *
 * Search Console and Bing Webmaster Tools will not show a single row —
 * not one query, not one impression, not one crawl error — until the
 * property is verified. Verification is not an optimisation; it is the
 * door. Everything in src/seo.js is guesswork without it, because
 * guesswork is all you have when nobody will tell you what people
 * actually typed.
 *
 * ── Why this is not a DNS record ─────────────────────────────────────
 *
 * Both engines accept a DNS TXT record, and for a *domain* property
 * (every subdomain, every scheme, forever) that is the only method
 * Google accepts. But every Tími hostname now resolves through a
 * Cloudflare Worker Custom Domain, the blog moved under
 * timinow.pet/blog, and a URL-prefix property rooted at
 * https://timinow.pet therefore covers the entire crawlable surface.
 * That property can be verified with a meta tag or a file — both of
 * which this Worker can serve itself, on deploy, with no zone edit and
 * nothing to get wrong at the registrar.
 *
 * The DNS route stays available and is documented in docs/SEO.md. It is
 * worth doing later, when there is a reason to want a domain-wide
 * property; it is not worth blocking on today.
 *
 * ── The tokens ───────────────────────────────────────────────────────
 *
 * Neither token is a secret. Both are published — that is the entire
 * mechanism: a token is proof of control precisely because only someone
 * who controls the site could have put it where the engine looks. They
 * are `vars` in wrangler.jsonc, committed, like INDEXNOW_KEY.
 *
 * GOOGLE_SITE_VERIFICATION accepts either of Google's two forms, and
 * tells them apart without being told which is which:
 *
 *   - `google1a2b3c4d5e6f7890.html` — the HTML-file method. Served at
 *     that exact path, containing the one line Google looks for.
 *   - anything else — the meta-tag method's `content` value, emitted
 *     into the home page's <head>.
 *
 * BING_SITE_VERIFICATION is one token used both ways at once, because
 * Bing uses the same value for its meta tag and its XML file, and there
 * is no cost to offering both.
 *
 * Bing can also simply import a verified Search Console property, which
 * is less work than either. This exists so that the import is a choice
 * rather than a dependency.
 */

const GOOGLE_FILE = /^google[0-9a-f]{8,32}\.html$/;

/** A var, trimmed, or null — an empty string must behave as "not set". */
function token(env, name) {
  const value = String(env?.[name] || "").trim();
  // Tokens from both engines are unpadded alphanumerics with - and _.
  // Anything else is a paste accident (a whole meta tag, a quote, a URL),
  // and a malformed token fails verification silently days later.
  return /^[A-Za-z0-9._-]{8,128}$/.test(value) ? value : null;
}

export function googleToken(env) {
  return token(env, "GOOGLE_SITE_VERIFICATION");
}

export function bingToken(env) {
  return token(env, "BING_SITE_VERIFICATION");
}

/**
 * The tags for the home page's <head>.
 *
 * Google's file-method token is deliberately not emitted as a meta tag:
 * the two tokens are different strings and pasting one into the other's
 * slot verifies nothing.
 */
export function verificationMetaTags(env) {
  const tags = [];
  const google = googleToken(env);
  if (google && !GOOGLE_FILE.test(google)) {
    tags.push(`<meta name="google-site-verification" content="${google}">`);
  }
  const bing = bingToken(env);
  if (bing) tags.push(`<meta name="msvalidate.01" content="${bing}">`);
  return tags.join("\n  ");
}

/**
 * The file-method responses, or null for a path this does not own.
 *
 * `path` arrives already normalised by the caller (no trailing slash).
 */
export function verificationFile(env, path) {
  const google = googleToken(env);
  if (google && GOOGLE_FILE.test(google) && path === `/${google}`) {
    // Google checks the body, not just the status. The line it wants is
    // the filename, prefixed — not the bare token.
    return { body: `google-site-verification: ${google}`, type: "text/plain; charset=utf-8" };
  }
  const bing = bingToken(env);
  if (bing && path === "/BingSiteAuth.xml") {
    return {
      body: `<?xml version="1.0"?>\n<users>\n  <user>${bing}</user>\n</users>\n`,
      type: "application/xml; charset=utf-8"
    };
  }
  return null;
}
