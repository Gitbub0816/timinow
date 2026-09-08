/**
 * Delivery for metrics_alert_thresholds breaches.
 *
 * src/metrics.js `checkAlerts` already computes the structured answer to "is
 * something wrong right now" — GET /api/admin/alerts polls it on demand, and
 * that stays exactly as it was; this module is additive. What it adds is a
 * cron caller (`notifyAlertBreaches`, called from `scheduled()` in
 * src/index.js) and actual delivery: an email through a provider-agnostic
 * HTTP call shaped for MailerSend, and — for the most severe breach category
 * only — an SMS through the Twilio integration src/voice.js already has.
 *
 * Both channels degrade silently when unconfigured, the same way every other
 * optional integration in this codebase does (see GEMINI_API_KEY in
 * src/gemini-tts.js, DIDIT_API_KEY in src/hardship/providers.js): a missing
 * env var means the alert is still computed and still logged, just not
 * emailed or texted. Nothing here ever throws out of `notifyAlertBreaches`
 * for a delivery failure — a Twilio outage must not stop the next metric
 * from being checked, still less crash the cron sweep that also expires
 * offers and advances search waves.
 *
 * ─────────────────────────────────────────────────────────────── dedupe ───
 *
 * The cron sweep runs every five minutes; a threshold that stays breached
 * stays breached for hours sometimes. Paging somebody every five minutes for
 * one ongoing problem is how alerts get muted. `alert_notifications_sent`
 * (migration 0025) remembers the last time each named breach was actually
 * notified and whether the most recent check still found it breaching. A
 * breach is renotified only after `ALERT_NOTIFICATION_COOLDOWN_MINUTES` has
 * passed since the last notification, *or* immediately if it had cleared and
 * has now recurred — a fresh incident must not be silenced by a cooldown left
 * over from an unrelated past one.
 */

import { hasDatabase } from "./db.js";
import { checkAlerts } from "./metrics.js";
import { dispatchVoiceCalls } from "./voice.js";

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

const DEFAULT_COOLDOWN_MINUTES = 60;

/**
 * How severe each breach category is, for the one decision severity affects:
 * whether it earns an SMS in addition to email. `checkAlerts` itself carries
 * no notion of severity — these are the two metrics that mean the
 * marketplace itself is failing customers right now (no offers coming back
 * at all), as opposed to the two that mean it is running slower or losing
 * more clinics than the platform operator wants, which are real problems but
 * not the kind that justifies waking somebody up.
 */
const CRITICAL_METRICS = new Set(["searchToOfferRatePct", "noResultRatePct"]);

function severityOf(metric) {
  return CRITICAL_METRICS.has(metric) ? "critical" : "warning";
}

function cleanEnvString(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** Comma-separated env values, same convention as PLATFORM_ADMIN_EMAILS / AUTHORIZED_PARTIES. */
function splitList(value) {
  return cleanEnvString(value).split(",").map((entry) => entry.trim()).filter(Boolean);
}

export function alertEmailConfigured(env) {
  return Boolean(cleanEnvString(env?.ALERT_EMAIL_API_KEY) && cleanEnvString(env?.ALERT_EMAIL_FROM) && splitList(env?.ALERT_EMAIL_TO).length);
}

export function alertSmsConfigured(env) {
  return Boolean(splitList(env?.ALERT_SMS_TO).length);
}

function breachLines(breaches) {
  return breaches.map((breach) => {
    const direction = breach.direction === "below" ? "below the minimum" : "above the maximum";
    return `- ${breach.metric}: ${breach.value} is ${direction} of ${breach.threshold}`;
  }).join("\n");
}

/**
 * One HTTP call to MailerSend's send endpoint. Deliberately the only shape
 * this module knows — swapping providers later means changing this function,
 * not the caller, which is what "provider-agnostic HTTP API shape" means in
 * practice for a single-provider deployment.
 *
 * Never throws: a delivery failure is logged and reported back as
 * `{ ok: false }` so the caller can decide whether that also blocks the SMS,
 * without a network hiccup here taking down the whole cron tick.
 */
export async function sendAlertEmail(env, { subject, text }) {
  if (!alertEmailConfigured(env)) return { ok: false, skipped: true, reason: "ALERT_EMAIL_NOT_CONFIGURED" };
  const recipients = splitList(env.ALERT_EMAIL_TO).map((email) => ({ email }));
  try {
    const response = await fetch("https://api.mailersend.com/v1/email", {
      method: "POST",
      headers: {
        authorization: `Bearer ${cleanEnvString(env.ALERT_EMAIL_API_KEY)}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        from: { email: cleanEnvString(env.ALERT_EMAIL_FROM), name: "TímiNOW alerts" },
        to: recipients,
        subject,
        text
      })
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(JSON.stringify({ event: "alert_email_failed", status: response.status, body: body.slice(0, 500) }));
      return { ok: false, status: response.status };
    }
    return { ok: true };
  } catch (error) {
    console.error(JSON.stringify({ event: "alert_email_error", message: error.message }));
    return { ok: false, error: error.message };
  }
}

/**
 * Best-effort SMS, routed the same way every other outbound text in this
 * codebase is: enqueued to `notification_outbox` with `channel = 'sms'`, then
 * a poke asking the voice gateway Worker to drain it — never a direct Twilio
 * call from here. Twilio credentials live only in that Worker (see
 * dispatchVoiceCalls in src/voice.js and apps/voice-gateway/README.md); this
 * Worker never needs its own copy of them just to send an alert text. Every
 * destination in ALERT_SMS_TO gets its own row, so one bad number can't
 * cancel the others.
 */
export async function sendAlertSms(env, { body }) {
  if (!hasDatabase(env)) return { ok: false, skipped: true, reason: "DATABASE_REQUIRED" };
  const destinations = splitList(env?.ALERT_SMS_TO);
  if (!destinations.length) return { ok: false, skipped: true, reason: "ALERT_SMS_TO_NOT_CONFIGURED" };
  const now = new Date().toISOString();
  for (const to of destinations) {
    await env.DB.prepare(`
      INSERT INTO notification_outbox (id, channel, recipient, template_key, payload_json, available_at)
      VALUES (?, 'sms', ?, 'alert_breach_sms', ?, ?)
    `).bind(newId("notification"), to, JSON.stringify({ body }), now).run();
  }
  // Best effort: even if the poke itself fails (network hiccup, VOICE binding
  // unavailable), the rows are queued and the gateway's own sweep picks them
  // up — see dispatchVoiceCalls's docstring.
  await dispatchVoiceCalls(env);
  return { ok: true, queued: destinations.length };
}

/**
 * Decide, for one breach, whether it should be (re)notified right now, and
 * record that decision. Returns `true` when this call is the one that should
 * actually send — never both an email decision and a separate SMS decision
 * per breach, so the two channels stay in lockstep for a given incident.
 */
async function shouldNotify(env, alertKey, { now, cooldownMinutes }) {
  const row = await env.DB.prepare("SELECT * FROM alert_notifications_sent WHERE alert_key = ?").bind(alertKey).first();
  if (!row) return true;
  if (row.cleared_at) return true; // resolved since the last notification, then recurred — treat as new
  const lastSentMs = Date.parse(row.last_sent_at);
  if (!Number.isFinite(lastSentMs)) return true;
  return Date.now() - lastSentMs >= cooldownMinutes * 60_000;
}

async function recordNotified(env, alertKey, now) {
  await env.DB.prepare(`
    INSERT INTO alert_notifications_sent (alert_key, last_sent_at, last_breach_at, cleared_at, notify_count, updated_at)
    VALUES (?, ?, ?, NULL, 1, ?)
    ON CONFLICT(alert_key) DO UPDATE SET
      last_sent_at = excluded.last_sent_at,
      last_breach_at = excluded.last_breach_at,
      cleared_at = NULL,
      notify_count = alert_notifications_sent.notify_count + 1,
      updated_at = excluded.updated_at
  `).bind(alertKey, now, now, now).run();
}

async function recordStillBreachingButSkipped(env, alertKey, now) {
  await env.DB.prepare(`
    INSERT INTO alert_notifications_sent (alert_key, last_sent_at, last_breach_at, cleared_at, notify_count, updated_at)
    VALUES (?, ?, ?, NULL, 0, ?)
    ON CONFLICT(alert_key) DO UPDATE SET
      last_breach_at = excluded.last_breach_at,
      updated_at = excluded.updated_at
  `).bind(alertKey, now, now, now).run();
}

/**
 * The cron entry point. Runs `checkAlerts`, clears any tracked key that is no
 * longer breaching, and for each current breach either sends (subject to
 * cooldown/recurrence, see `shouldNotify`) or records that it is still
 * breaching without re-sending. Returns a small summary for the sweep's log
 * line; never throws.
 */
export async function notifyAlertBreaches(env, { now = new Date().toISOString() } = {}) {
  if (!hasDatabase(env)) return { breaches: 0, notified: 0, emailSent: 0, smsSent: 0 };
  let result;
  try {
    result = await checkAlerts(env);
  } catch (error) {
    console.error(JSON.stringify({ event: "alert_breach_check_failed", message: error.message }));
    return { breaches: 0, notified: 0, emailSent: 0, smsSent: 0, error: error.message };
  }
  const breaches = result.breaches || [];
  const cooldownMinutes = Number(env?.ALERT_NOTIFICATION_COOLDOWN_MINUTES) > 0
    ? Number(env.ALERT_NOTIFICATION_COOLDOWN_MINUTES)
    : DEFAULT_COOLDOWN_MINUTES;

  // A key tracked as active but absent from this check's breaches has
  // resolved. Clearing it here — not merely leaving it stale — is what lets
  // a later recurrence bypass the cooldown instead of inheriting one from an
  // incident that already ended.
  const currentKeys = new Set(breaches.map((breach) => breach.metric));
  const tracked = await env.DB.prepare("SELECT alert_key FROM alert_notifications_sent WHERE cleared_at IS NULL").all();
  const toClear = (tracked.results || []).map((row) => row.alert_key).filter((key) => !currentKeys.has(key));
  if (toClear.length) {
    await env.DB.batch(toClear.map((key) =>
      env.DB.prepare("UPDATE alert_notifications_sent SET cleared_at = ? WHERE alert_key = ?").bind(now, key)
    ));
  }

  if (!breaches.length) return { breaches: 0, notified: 0, emailSent: 0, smsSent: 0 };

  const toNotify = [];
  for (const breach of breaches) {
    if (await shouldNotify(env, breach.metric, { now, cooldownMinutes })) {
      toNotify.push(breach);
      await recordNotified(env, breach.metric, now);
    } else {
      await recordStillBreachingButSkipped(env, breach.metric, now);
    }
  }

  let emailSent = 0;
  let smsSent = 0;
  if (toNotify.length) {
    const subject = `TímiNOW alert: ${toNotify.length} metric${toNotify.length === 1 ? "" : "s"} breaching threshold`;
    const text = `Checked at ${result.checkedAt} over the trailing ${result.windowHours}h window:\n\n${breachLines(toNotify)}\n\nFull detail: GET /api/admin/alerts`;
    const emailResult = await sendAlertEmail(env, { subject, text });
    if (emailResult.ok) emailSent = 1;

    const critical = toNotify.filter((breach) => severityOf(breach.metric) === "critical");
    if (critical.length) {
      const smsBody = `TímiNOW: ${critical.length} critical alert${critical.length === 1 ? "" : "s"} — ${critical.map((breach) => breach.metric).join(", ")}. See admin dashboard.`;
      const smsResult = await sendAlertSms(env, { body: smsBody });
      if (smsResult.ok) smsSent = 1;
    }
  }

  return { breaches: breaches.length, notified: toNotify.length, emailSent, smsSent };
}
