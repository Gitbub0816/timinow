PRAGMA foreign_keys = ON;

-- ════════════════════════════════════════════════ Feature A — markets ════
--
-- A market is a geographic expansion unit ("East Bay", "Denver Metro"), not a
-- tenant and not a location: one market covers many clinics across many
-- tenants, and a clinic belongs to at most one market. Two states live on the
-- row, deliberately kept apart:
--
--   `state`      the actual, human-decided answer — what customers get right
--                now. Only an admin action ever writes it (src/markets.js
--                setMarketState). Nothing here auto-flips it.
--   `activation` how hard Tími is pushing it — a market can be `green` and
--                still `soft` (quietly live, not yet marketed) before a
--                deliberate `active_marketing` push.
--
-- The *computed* readiness recommendation (src/markets.js
-- computeReadinessReport) is never stored — it is derived fresh from
-- searches/offers/locations every time it is asked for, specifically so it
-- can never drift from the data it describes. Only the thresholds it is
-- judged against are stored, in `market_readiness_config` below, so a target
-- can be tuned without a migration.
CREATE TABLE IF NOT EXISTS markets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'red' CHECK (state IN ('green', 'yellow', 'red')),
  activation TEXT NOT NULL DEFAULT 'inactive' CHECK (activation IN ('active_marketing', 'soft', 'inactive')),
  -- A simple circle rather than a polygon, consistent with how a clinic's own
  -- location is stored (locations.latitude/longitude, migration 0001) and
  -- with the haversine helper already used to rank clinics by distance
  -- (src/db.js haversineMiles) — a market is "close enough to this point",
  -- exactly the question a location answers about a customer.
  center_latitude REAL NOT NULL,
  center_longitude REAL NOT NULL,
  radius_km REAL NOT NULL DEFAULT 40 CHECK (radius_km > 0),
  notes TEXT,
  -- Who last set `state`/`activation` and when, so the console can show "set
  -- to yellow by <admin> on <date>" beside the computed recommendation rather
  -- than only the bare value.
  state_set_by TEXT,
  state_set_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_markets_state ON markets(state, activation);

-- Thresholds a readiness report is judged against, as one editable row rather
-- than constants baked into src/markets.js — a target can move (e.g. the
-- minimum clinic count rising as the network matures) without a code deploy.
-- `id` is always 'default' today; the column exists as a string rather than a
-- boolean "the one row" so a future per-market override is an INSERT, not a
-- schema change.
CREATE TABLE IF NOT EXISTS market_readiness_config (
  id TEXT PRIMARY KEY DEFAULT 'default',
  min_active_clinics INTEGER NOT NULL DEFAULT 8,
  target_active_clinics INTEGER NOT NULL DEFAULT 10,
  min_offer_rate_pct REAL NOT NULL DEFAULT 70,
  max_median_first_offer_minutes REAL NOT NULL DEFAULT 5,
  max_single_clinic_share_pct REAL NOT NULL DEFAULT 50,
  lookback_days INTEGER NOT NULL DEFAULT 30,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT
);

INSERT OR IGNORE INTO market_readiness_config (id) VALUES ('default');

-- A clinic's market, denormalized directly onto `locations` — the same
-- pattern as `locations.tenant_id`, a single owning foreign key, rather than
-- a join table, because a location belongs to at most one market at a time
-- and every other clinic-scoped join in this schema (tenant, policy) already
-- works this way.
ALTER TABLE locations ADD COLUMN market_id TEXT REFERENCES markets(id);
CREATE INDEX IF NOT EXISTS idx_locations_market ON locations(market_id, active);

-- Where a search happened, and whether it landed outside any active market.
-- `out_of_market` is set once at search time and never revisited — it is a
-- demand signal for expansion planning, not a live flag the search reacts
-- to. The customer's search is never blocked by either column; see
-- createCareSearch in src/index.js.
ALTER TABLE care_searches ADD COLUMN market_id TEXT REFERENCES markets(id);
ALTER TABLE care_searches ADD COLUMN out_of_market INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_care_searches_market ON care_searches(market_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_care_searches_out_of_market ON care_searches(out_of_market, requested_at DESC);

-- ════════════════════════════════════════ Feature B — marketplace events ══
--
-- Discrete funnel moments the existing tables cannot answer on their own.
-- Most of what src/metrics.js reports is derived straight from
-- care_searches/care_search_targets/care_offers/intake_requests/
-- payment_ledger — those already carry the timestamps and status columns a
-- funnel needs, and duplicating them here as events would just be a second,
-- driftable copy. This table exists only for the handful of moments nothing
-- else records: a customer viewing the offers they were sent, most notably.
-- One INSERT per event, cheap by design; `id` is deterministic (rather than
-- a random uuid) for the events that must fire at most once (see
-- recordMarketplaceEvent's `idempotencyKey` in src/metrics.js), so a
-- customer re-polling the same screen writes the row once, not once per
-- poll.
CREATE TABLE IF NOT EXISTS marketplace_events (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  -- Free text, not a CHECK: a new funnel moment should be a deploy, not a
  -- table rebuild. See src/metrics.js EVENT_TYPES for the ones currently
  -- written.
  event_type TEXT NOT NULL,
  search_id TEXT,
  target_id TEXT,
  offer_id TEXT,
  intake_id TEXT,
  tenant_id TEXT,
  location_id TEXT,
  market_id TEXT,
  -- Copied from the search at the moment the event is written (see
  -- src/markets.js resolveSearchMarket), not recomputed later — a market's
  -- state can change after the fact and a historical event must keep
  -- describing the coverage that was actually true when it happened.
  out_of_market INTEGER NOT NULL DEFAULT 0,
  actor_type TEXT CHECK (actor_type IS NULL OR actor_type IN ('customer', 'clinic', 'system')),
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_marketplace_events_search ON marketplace_events(search_id, event_type);
CREATE INDEX IF NOT EXISTS idx_marketplace_events_type_time ON marketplace_events(event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketplace_events_tenant_time ON marketplace_events(tenant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketplace_events_market_time ON marketplace_events(market_id, occurred_at DESC);

-- Alert thresholds for GET /api/admin/alerts (src/metrics.js checkAlerts), a
-- separate row from market_readiness_config: readiness judges one market
-- over 30 days for a green/yellow/red call; alerts judge the whole
-- marketplace (optionally one market) over a short recent window for "is
-- something wrong right now". Wiring to email/SMS is deferred — this is the
-- row the eventual notifier would read alongside the breach computation.
CREATE TABLE IF NOT EXISTS metrics_alert_thresholds (
  id TEXT PRIMARY KEY DEFAULT 'default',
  min_offer_rate_pct REAL NOT NULL DEFAULT 70,
  max_median_first_offer_minutes REAL NOT NULL DEFAULT 5,
  max_no_result_rate_pct REAL NOT NULL DEFAULT 15,
  max_decline_rate_pct REAL NOT NULL DEFAULT 40,
  window_hours INTEGER NOT NULL DEFAULT 24,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT
);

INSERT OR IGNORE INTO metrics_alert_thresholds (id) VALUES ('default');

-- ─────────────────────────────────────────────────────────────────────────
-- NOTE for the next two migrations, landing from parallel work and not yet
-- present in this branch:
--   0021 adds a wave number to clinic_search_targets (here: care_search_
--        targets) and a clinic response-reliability stats table for staged
--        wave routing. src/metrics.js feature-detects the wave column via
--        PRAGMA table_info before grouping by it — per-wave matching
--        performance activates automatically once 0021 lands, with no
--        change needed here.
--   0022 adds attribution columns (attribution_source, ...) to searches
--        (here: care_searches). src/metrics.js feature-detects those the
--        same way before honoring the `source` filter — traffic-source
--        breakdowns activate automatically once 0022 lands.
-- ─────────────────────────────────────────────────────────────────────────
