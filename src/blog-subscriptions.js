/**
 * The blog's mailing list: confirm first, and always let people leave.
 *
 * Double opt-in is not a nicety here. Anyone can type anyone's address into a
 * public form, so a list built on submission alone is partly a list of people
 * who never asked — which is a complaint, then a spam report, and eventually a
 * sending reputation that takes down the transactional mail this product
 * actually depends on. Nothing is ever sent to an address that has not
 * followed a link proving it wanted this.
 *
 * The same reasoning drives the unsubscribe token: leaving takes one click and
 * no account. A subscription that is hard to escape is reported rather than
 * cancelled, and the report costs the same domain that sends a customer their
 * booking confirmation.
 *
 * MailerSend, same provider and the same HTTP shape as
 * src/alert-notifications.js. Its own API key and sender by default, because
 * a marketing list and an incident alert should not share a credential: the
 * blog list is the one that will eventually be exported, rotated, or handed to
 * a vendor, and the alerting key is the one that has to work at 3am.
 */

import { hasDatabase } from "./db.js";

/** Local, matching every other module here — see src/push.js. */
function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

const SEND_ENDPOINT = "https://api.mailersend.com/v1/email";
const DEFAULT_FROM = "blog@timinow.pet";

function cleanEnvString(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** The blog's own key if there is one, else the alerting key. */
function apiKey(env) {
  return cleanEnvString(env?.BLOG_EMAIL_API_KEY) || cleanEnvString(env?.ALERT_EMAIL_API_KEY);
}

function fromAddress(env) {
  return cleanEnvString(env?.BLOG_EMAIL_FROM) || DEFAULT_FROM;
}

export function blogEmailConfigured(env) {
  return Boolean(apiKey(env));
}

/**
 * Whether this is plausibly an email address.
 *
 * Deliberately loose. The confirmation step is the real check — an address
 * that does not exist never confirms, and no amount of regular expression
 * settles what RFC 5322 actually permits. This only rejects what could not
 * possibly be one.
 */
export function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (email.length < 6 || email.length > 254) return null;
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) return null;
  return email;
}

/** A token nobody can guess and nothing else reuses. */
function token() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Start a subscription, or re-send the confirmation for one that never
 * finished.
 *
 * The answer to the caller is the same whatever the address's history:
 * subscribed, already subscribed, previously unsubscribed, or never seen. A
 * form that says "you are already on this list" is a form that tells a
 * stranger who is on the list.
 */
export async function requestSubscription(env, { email: raw, source = null, confirmURL }) {
  const email = normalizeEmail(raw);
  if (!email) return { ok: false, code: "EMAIL_INVALID", message: "That does not look like an email address." };
  if (!hasDatabase(env)) return { ok: false, code: "DATABASE_REQUIRED", message: "Subscriptions are not available on this deployment." };

  const existing = await env.DB.prepare("SELECT id, status, unsubscribe_token FROM blog_subscribers WHERE email = ? LIMIT 1")
    .bind(email).first();

  // Already confirmed: do nothing at all, and say the same thing as every
  // other outcome. Re-sending a confirmation to a confirmed subscriber is a
  // way to mail somebody who did not ask, on demand, from a public form.
  if (existing?.status === "confirmed") return { ok: true, pending: false };

  const confirmToken = token();
  const unsubscribeToken = existing?.unsubscribe_token || token();
  const now = new Date().toISOString();

  if (existing) {
    await env.DB.prepare(
      "UPDATE blog_subscribers SET status = 'pending', confirm_token = ?, unsubscribe_token = ?, source = COALESCE(?, source), updated_at = ? WHERE id = ?"
    ).bind(confirmToken, unsubscribeToken, source, now, existing.id).run();
  } else {
    await env.DB.prepare(
      "INSERT INTO blog_subscribers (id, email, status, confirm_token, unsubscribe_token, source, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)"
    ).bind(newId("blogsub"), email, confirmToken, unsubscribeToken, source, now, now).run();
  }

  const link = `${confirmURL}?token=${encodeURIComponent(confirmToken)}`;
  const sent = await sendBlogEmail(env, {
    to: email,
    subject: "Confirm your TímiNOW subscription",
    text: [
      "Someone asked to subscribe this address to the TímiNOW blog.",
      "",
      "If that was you, confirm here:",
      link,
      "",
      "If it wasn't, ignore this email — nothing else will be sent, and the address is not on any list until it is confirmed."
    ].join("\n")
  });
  // A send failure is not told to the caller either. The row is pending, the
  // token is valid, and a second attempt re-sends — but reporting "we could
  // not reach that address" would answer the same question the silence above
  // exists to avoid.
  return { ok: true, pending: true, delivered: sent.ok };
}

/** Complete a subscription. The token is single-use and cleared on success. */
export async function confirmSubscription(env, rawToken) {
  const value = String(rawToken || "").trim();
  if (!value || !hasDatabase(env)) return { ok: false };
  const row = await env.DB.prepare("SELECT id FROM blog_subscribers WHERE confirm_token = ? AND status = 'pending' LIMIT 1")
    .bind(value).first();
  if (!row) return { ok: false };
  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE blog_subscribers SET status = 'confirmed', confirm_token = NULL, confirmed_at = ?, updated_at = ? WHERE id = ?"
  ).bind(now, now, row.id).run();
  return { ok: true };
}

/**
 * Leave the list.
 *
 * Idempotent, and succeeds for an unknown token as well: someone clicking
 * unsubscribe twice, or on a link from an address already removed, wants to be
 * told they are off the list, not shown an error that makes them wonder.
 */
export async function unsubscribe(env, rawToken) {
  const value = String(rawToken || "").trim();
  if (!value || !hasDatabase(env)) return { ok: true };
  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE blog_subscribers SET status = 'unsubscribed', unsubscribed_at = ?, updated_at = ? WHERE unsubscribe_token = ? AND status <> 'unsubscribed'"
  ).bind(now, now, value).run();
  return { ok: true };
}

/**
 * One send, the only shape this module knows — same reasoning as
 * sendAlertEmail: swapping providers means changing this function and nothing
 * above it.
 *
 * Never throws. Email is a courtesy on top of a web request that has already
 * succeeded, and a provider outage must not turn a successful subscription
 * into a 500 the reader sees.
 */
export async function sendBlogEmail(env, { to, subject, text, unsubscribeURL = null }) {
  if (!blogEmailConfigured(env)) return { ok: false, skipped: true, reason: "BLOG_EMAIL_NOT_CONFIGURED" };
  try {
    const body = {
      from: { email: fromAddress(env), name: "TímiNOW" },
      to: [{ email: to }],
      subject,
      text
    };
    // List-Unsubscribe is what makes a mail client show its own one-click
    // unsubscribe. A reader who can leave from the client's own button does
    // that instead of pressing "spam", and those two actions have very
    // different consequences for every other email this domain sends.
    if (unsubscribeURL) {
      body.headers = [
        { name: "List-Unsubscribe", value: `<${unsubscribeURL}>` },
        { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" }
      ];
    }
    const response = await fetch(SEND_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey(env)}`, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      // The address is never logged: a subscriber list is personal data, and a
      // log line is the easiest place for it to end up somewhere it should not.
      console.error(JSON.stringify({ event: "blog_email_failed", status: response.status, detail: detail.slice(0, 300) }));
      return { ok: false, status: response.status };
    }
    return { ok: true };
  } catch (error) {
    console.error(JSON.stringify({ event: "blog_email_error", message: error.message }));
    return { ok: false, error: error.message };
  }
}

/**
 * Tell confirmed subscribers a post is live.
 *
 * Sent one at a time rather than as one message with many recipients, so no
 * subscriber ever sees another's address, and each carries its own unsubscribe
 * link. Capped per invocation because a Worker has a wall-clock budget and a
 * partially-sent announcement is better than a request that dies halfway with
 * no record of how far it got.
 */
export async function announcePost(env, post, { postURL, unsubscribeBase, limit = 200 }) {
  if (!hasDatabase(env) || !blogEmailConfigured(env)) return { sent: 0, skipped: true };
  const result = await env.DB.prepare(
    "SELECT email, unsubscribe_token FROM blog_subscribers WHERE status = 'confirmed' ORDER BY created_at ASC LIMIT ?"
  ).bind(limit).all().catch(() => ({ results: [] }));

  let sent = 0;
  for (const row of result.results) {
    const unsubscribeURL = `${unsubscribeBase}?token=${encodeURIComponent(row.unsubscribe_token)}`;
    const outcome = await sendBlogEmail(env, {
      to: row.email,
      subject: post.title,
      text: [post.title, "", post.excerpt || "", "", postURL, "", `Unsubscribe: ${unsubscribeURL}`].join("\n"),
      unsubscribeURL
    });
    if (outcome.ok) sent += 1;
  }
  return { sent };
}
