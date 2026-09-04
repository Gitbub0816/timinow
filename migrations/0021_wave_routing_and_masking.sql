PRAGMA foreign_keys = ON;

-- ═══════════════════════════════════════════════ staged wave routing ══════
--
-- Care-search targets used to be inserted as one flat broadcast: every
-- matching clinic became `awaiting_response` in the same INSERT, and every
-- one of them got a dashboard notification and a phone call within the same
-- request. A clinic three miles out with no capacity got rung at the same
-- moment as the best match, and a clinic that reliably ignores Tími kept
-- getting first-priority calls forever because nothing remembered that it
-- ignores Tími.
--
-- Staged routing keeps the row (`care_search_targets` still gets one row per
-- candidate, still ranked, still created up front) but adds *when* a target
-- is allowed to be seen and contacted. `wave_number` is assigned at search
-- creation from the ranked candidate list; `wave_activated_at` stays NULL
-- until a lazy check (there is no background timer in a Worker — see
-- src/routing.js `advanceSearchWaves`) decides the wave is due, at which
-- point the target's dashboard notification and voice call are enqueued for
-- the first time. Deliberately not a new `status` value: every existing
-- release path (customer cancels, customer selects, the search or its
-- collection window ends) already does `UPDATE ... WHERE status IN
-- ('contacting','awaiting_response','offered')` with no regard for wave, so
-- an unactivated future-wave target is voided by the code that already
-- exists the moment the search closes, with nothing new to get wrong.
ALTER TABLE care_search_targets ADD COLUMN wave_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE care_search_targets ADD COLUMN wave_activated_at TEXT;
-- The ranking score this target was assigned at search creation, kept for
-- analytics and for explaining why a clinic landed in the wave it did. Never
-- read back into ranking itself — see src/routing.js for the invariant that
-- paid placement never contributes to this number.
ALTER TABLE care_search_targets ADD COLUMN rank_score REAL;

CREATE INDEX IF NOT EXISTS idx_search_targets_wave
  ON care_search_targets(search_id, wave_number, wave_activated_at);

-- care_searches gains the routing policy it was actually run under (frozen
-- at creation, exactly like intake_requests.policy_snapshot_json — an admin
-- changing the default wave sizes tomorrow must not retroactively change a
-- search already in flight), the wave the search has reached, symptom detail
-- needed to build a wave-2+ voice script lazily (the original request body
-- is gone by the time a later wave activates), and the customer-notification
-- bookkeeping for Feature B.
ALTER TABLE care_searches ADD COLUMN routing_policy_id TEXT;
ALTER TABLE care_searches ADD COLUMN routing_snapshot_json TEXT;
ALTER TABLE care_searches ADD COLUMN current_wave INTEGER NOT NULL DEFAULT 1;
ALTER TABLE care_searches ADD COLUMN last_wave_activated_at TEXT;
ALTER TABLE care_searches ADD COLUMN symptoms_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE care_searches ADD COLUMN started_when TEXT;
-- Set the moment the first active offer exists. Read instead of
-- recomputing "is this the first offer" from a COUNT every time, and it is
-- what "surfaced immediately" actually means for analytics.
ALTER TABLE care_searches ADD COLUMN first_offer_at TEXT;
-- Set once, guarding the single SMS Feature B sends per search. NULL means
-- "not sent yet"; the conditional UPDATE that sets it is the only place a
-- second send could happen, and it is written to fail closed (see
-- notifyFirstOfferBySms in src/index.js).
ALTER TABLE care_searches ADD COLUMN sms_notified_at TEXT;

-- ─────────────────────────────────────────────────────── routing policy ──
--
-- Every number Feature A tunes: wave sizes and durations, the expansion
-- batch once the named waves run out, the overall search window, and how
-- long an offer stays valid once made. tenant_id NULL is the platform
-- default; a tenant_id row overrides it for that tenant's own locations
-- being routed to — nothing here is a hardcoded constant in src/routing.js
-- beyond the fallback used only when D1 is unavailable (demo mode).
CREATE TABLE IF NOT EXISTS routing_policies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  -- JSON array of the named early waves: [{"size":3,"durationSeconds":90}, ...].
  -- Once the array is exhausted, expansion_batch_size /
  -- expansion_duration_seconds keep going until candidates run out or the
  -- search window ends.
  waves_json TEXT NOT NULL DEFAULT '[{"size":3,"durationSeconds":90},{"size":3,"durationSeconds":90},{"size":4,"durationSeconds":120}]',
  expansion_batch_size INTEGER NOT NULL DEFAULT 4 CHECK (expansion_batch_size >= 1),
  expansion_duration_seconds INTEGER NOT NULL DEFAULT 120 CHECK (expansion_duration_seconds >= 15),
  search_window_minutes REAL NOT NULL DEFAULT 10 CHECK (search_window_minutes > 0),
  offer_hold_minutes REAL NOT NULL DEFAULT 5 CHECK (offer_hold_minutes > 0),
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One active platform default, ever.
CREATE UNIQUE INDEX IF NOT EXISTS idx_routing_policies_one_active_global
  ON routing_policies(active) WHERE tenant_id IS NULL AND active = 1;
-- One active override per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS idx_routing_policies_one_active_tenant
  ON routing_policies(tenant_id, active) WHERE tenant_id IS NOT NULL AND active = 1;

INSERT OR IGNORE INTO routing_policies (
  id, tenant_id, version, active, waves_json, expansion_batch_size,
  expansion_duration_seconds, search_window_minutes, offer_hold_minutes, note
) VALUES (
  'routing_v1', NULL, 1, 1,
  '[{"size":3,"durationSeconds":90},{"size":3,"durationSeconds":90},{"size":4,"durationSeconds":120}]',
  4, 120, 10, 5,
  'Launch routing: waves of 3, 3, 4 clinics at roughly 90s/90s/120s, then batches of 4 every ~120s, inside a 10 minute search window; offers hold for 5 minutes once made.'
);

-- ────────────────────────────────────────── clinic response reliability ──
--
-- A clinic that never responds should stop getting first priority. One row
-- per tenant (a clinic tenant has exactly one location in this MVP — see
-- getClinicLocation), updated when a target is contacted (received),
-- answered (responded, offer or decline both count as a response — an
-- honest decline is not the failure this table tracks), or times out still
-- `awaiting_response` while it was already activated (ignored — see the
-- "closedCollections"/"expiredSearches" sweeps in src/index.js and
-- advanceSearchWaves in src/routing.js).
CREATE TABLE IF NOT EXISTS clinic_response_stats (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  requests_received INTEGER NOT NULL DEFAULT 0,
  requests_responded INTEGER NOT NULL DEFAULT 0,
  requests_ignored INTEGER NOT NULL DEFAULT 0,
  -- A capped rolling window of the most recent response times in whole
  -- seconds, e.g. "[42,58,19]". A JSON array rather than a running mean
  -- because a median resists one very fast or very slow outlier better than
  -- an average does, and there is no need for a materialized median column
  -- that could drift from the samples behind it.
  response_seconds_samples_json TEXT NOT NULL DEFAULT '[]',
  median_response_seconds REAL,
  last_response_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ══════════════════════════════════════════════ owner-contact masking ═════
--
-- CLINIC_SEARCH_TARGET_SELECT (src/db.js) already exposes case detail —
-- species, symptoms, urgency, travel time — that a clinic needs to decide
-- whether it can help. It also used to expose owner_name/owner_phone/
-- owner_email in full, to every clinic in every wave, the instant a search
-- was created — before the customer had chosen anyone, let alone paid. A
-- clinic that will never be selected had no reason to hold a pet owner's
-- name and phone number at all.
--
-- No schema is needed to mask the payload — src/db.js changes what it
-- returns, not what it stores, exactly like maskedMatchCard already does for
-- the customer-facing side of the same search. What this migration adds is
-- the audit trail for the reveal itself: audit_events (migration 0013)
-- already fits recordAudit's shape (actor, action, subject, old/new state,
-- reason) and is used the same way by match-alias.js's revealMapping, so
-- reobtain contact reveals are written there under action
-- "clinic_contact.revealed" rather than a new table nothing else reads.

-- ─────────────────────────────────────────────────── launch pricing cut ──
--
-- Feature D: the owner fee moves from $20 to $15. This does not touch the
-- migration 0013 seed (INSERT OR IGNORE 'pricing_v1' at 2000) so the history
-- of what launch pricing actually was stays intact; it updates the row that
-- is active today, exactly the way any other pricing change would ship —
-- prospectively, and reported at whatever price a booking actually saw. A
-- founding clinic's $0 clinic-side rate is untouched, and clinic_fee_cents
-- (the standard clinic rate) is untouched: only what the owner pays moves.
UPDATE pricing_policies
SET owner_fee_cents = 1500,
    note = 'Launch pricing, revised: $15 owner, $25 clinic, $10 Tími match, $30 community share.'
WHERE active = 1 AND owner_fee_cents = 2000;
