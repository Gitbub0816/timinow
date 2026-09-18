/**
 * Telling search engines a URL exists, the moment it exists.
 *
 * A sitemap is a standing invitation: here is everything, come back whenever.
 * For a site that publishes a handful of times a month that is fine for
 * everything except the thing you just published, which sits unindexed for
 * days while a crawler works through its own schedule.
 *
 * IndexNow closes that gap. One POST naming the URLs that changed, and Bing,
 * Yandex, Seznam and Naver — which share the submission between them — know
 * within minutes rather than days. Google does not participate, and says it
 * is evaluating; its own discovery is fast enough that this is not where the
 * loss was.
 *
 * Bing matters here more than its search share suggests. Several assistants
 * read Bing's index, so "indexed by Bing within minutes" is the difference
 * between a post being quotable tonight and quotable next week. That is the
 * whole reason this is worth eighty lines.
 *
 * ── The key ──────────────────────────────────────────────────────────────
 *
 * IndexNow authenticates by asking the site to prove it controls itself: the
 * key is published as a text file at the site root, and a submission is
 * accepted only if the file is there and matches. It is therefore public by
 * design and is not a secret — it is a `var`, not a Worker secret, and
 * committing it is the intended use. Anybody who finds it can submit URLs on
 * this domain, which is the same thing they could do by editing the sitemap
 * they can already read.
 */

import { SITE } from "./seo.js";

const ENDPOINT = "https://api.indexnow.org/indexnow";

/** The host every Tími URL now lives on, since the blog moved under it. */
const HOST = new URL(SITE.customerOrigin).host;

export function indexNowKey(env) {
  const key = String(env?.INDEXNOW_KEY || "").trim();
  // The spec wants 8–128 hex characters. A malformed key is worse than none:
  // the submission is rejected and nothing says so.
  return /^[0-9a-fA-F]{8,128}$/.test(key) ? key : null;
}

/** The path the key file is served at, which the submission points back to. */
export function indexNowKeyPath(env) {
  const key = indexNowKey(env);
  return key ? `/${key}.txt` : null;
}

/**
 * Submit changed URLs.
 *
 * Awaited by the caller rather than fired and forgotten, because a Worker
 * that returns before its fetch resolves may have that fetch cancelled — and
 * a publish is an administrator pressing a button, not a request path where
 * 300ms matters. Bounded by a timeout and incapable of throwing: a search
 * engine being slow must never be the reason a post fails to publish.
 */
export async function submitToIndexNow(env, urls) {
  const key = indexNowKey(env);
  const list = [...new Set((urls || []).filter(Boolean))].slice(0, 100);
  if (!key || !list.length) return { submitted: false, reason: key ? "no urls" : "no key" };

  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        host: HOST,
        key,
        keyLocation: `${SITE.customerOrigin}${indexNowKeyPath(env)}`,
        urlList: list
      }),
      signal: AbortSignal.timeout(3000)
    });
    // 200 and 202 both mean accepted; 422 means a URL was not on this host,
    // which is a bug in the caller and worth seeing in a log.
    console.log(JSON.stringify({ event: "indexnow_submitted", status: response.status, count: list.length }));
    return { submitted: response.ok, status: response.status, count: list.length };
  } catch (error) {
    console.error(JSON.stringify({ event: "indexnow_failed", message: error.message, count: list.length }));
    return { submitted: false, reason: error.message };
  }
}

/** The canonical address of a published post, which is what gets submitted. */
export function postUrl(slug) {
  return `${SITE.blogBase}/p/${encodeURIComponent(slug)}`;
}
