PRAGMA foreign_keys = ON;

-- ══════════════════════════════════════ Feature: alert breach notifications ═
--
-- src/metrics.js checkAlerts already computes structured breaches against
-- metrics_alert_thresholds (migration 0024); GET /api/admin/alerts polls it
-- on demand. What was missing is delivery: the five-minute cron sweep now
-- calls checkAlerts itself and can email/SMS a breach, but re-sending the
-- same still-breaching alert every five minutes would be worse than silence.
--
-- This table is that memory: one row per alert (keyed by the metric name
-- checkAlerts already uses), holding when it was last actually notified and
-- whether the last check still found it breaching. src/alert-notifications.js
-- reads and writes it to decide "is this the same ongoing breach I already
-- told somebody about, or a new one" — a cleared_at that gets set the moment
-- a check no longer finds the metric breaching, and cleared again on read, is
-- what makes a breach that resolves and later recurs notify immediately
-- instead of waiting out the cooldown from the first time.
CREATE TABLE IF NOT EXISTS alert_notifications_sent (
  -- The metric name from checkAlerts's breach objects, e.g.
  -- "searchToOfferRatePct" — stable across restarts and deploys because it
  -- names what is wrong, not when.
  alert_key TEXT PRIMARY KEY,
  -- When a notification (email and/or SMS) was last actually sent for this
  -- key. The cooldown in src/alert-notifications.js compares "now" against
  -- this, not against last_breach_at, so a breach that keeps being detected
  -- every tick still only pages a human at most once per cooldown window.
  last_sent_at TEXT NOT NULL,
  -- When this key was last seen breaching at all, sent or not — kept mostly
  -- for operator visibility in a future console view; the cooldown decision
  -- itself only needs last_sent_at and cleared_at.
  last_breach_at TEXT NOT NULL,
  -- NULL while the alert is considered still active from the last check that
  -- ran; set to the check time the moment a sweep finds the metric no longer
  -- breaching. A later re-breach with cleared_at NOT NULL is treated as a new
  -- incident and bypasses the cooldown — silence between two unrelated
  -- breaches must not suppress the second one just because it shares a name.
  cleared_at TEXT,
  -- How many times this key has been notified since it was last clear, for
  -- an operator glancing at the table to see "this has fired 6 times" rather
  -- than a bare timestamp.
  notify_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ─────────────────────────────────────────── hardship evidence retention ───
--
-- No schema change needed here: migration 0015 already added
-- eligibility_evidence.deleted_at and its partial index
-- (idx_eligibility_evidence_retention ... WHERE deleted_at IS NULL) in
-- anticipation of exactly this sweep. src/hardship/index.js sweepExpiredEvidence
-- is the job that finally reads retention_deadline and writes deleted_at —
-- see that file for the fail-closed ordering (R2 delete before the D1 row is
-- ever marked).
