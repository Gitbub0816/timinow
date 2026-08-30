PRAGMA foreign_keys = ON;

-- ══════════════════════════════════════════════════ temporary match aliases ──
--
-- Before a customer confirms and pays, a clinic is shown as "Sequoia" rather
-- than by name. The point is not secrecy for its own sake: it is that the
-- comparison, and the clinic's availability commitment, stay inside Tími
-- instead of becoming a maps search that drives an owner to a waiting room
-- that never agreed to take the patient.
--
-- Three properties make the difference between a temporary label and a lie,
-- and all three are enforced here rather than in application code:
--
--   * an alias belongs to a *session*, never to a clinic (there is
--     deliberately no clinic_id column on match_aliases);
--   * no alias appears twice in one result set (UNIQUE below);
--   * a retired alias is deactivated, never deleted, so a mapping issued
--     last month still resolves for support and audit.

CREATE TABLE IF NOT EXISTS match_aliases (
  -- alias_<slug>. Stable across environments so a seeded row can be
  -- referenced by id in a fixture without a lookup.
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  category TEXT NOT NULL,
  -- The library revision this word belongs to. Sessions record the version
  -- they were assigned under, so changing the library later cannot silently
  -- rewrite what an old card said.
  library_version INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  deactivation_reason TEXT,
  deactivated_by TEXT,
  deactivated_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- A word withdrawn without a recorded reason is a word nobody can explain
  -- the absence of six months later.
  CHECK (active = 1 OR deactivation_reason IS NOT NULL)
);

-- The pool a new session draws from.
CREATE INDEX IF NOT EXISTS idx_match_aliases_active ON match_aliases(active, library_version);

-- Case-insensitive uniqueness, required by the library's own screening rules:
-- "Iris" and "iris" are one alias, and two of them in a result set would read
-- as two clinics with the same name.
CREATE UNIQUE INDEX IF NOT EXISTS idx_match_aliases_display_nocase
  ON match_aliases(display_name COLLATE NOCASE);

-- Words withheld without retiring them.
--
-- Separate from match_aliases.active because the two answer different
-- questions: `active = 0` is "this word is out of the library" (legal review,
-- a trademark complaint), a denylist row is "not in this market" — a clinic
-- chain called Harbor Animal Hospital operates here, so Harbor is confusing
-- in this city and unremarkable everywhere else. Neither deletes history.
CREATE TABLE IF NOT EXISTS match_alias_denylist (
  id TEXT PRIMARY KEY,
  alias_slug TEXT NOT NULL REFERENCES match_aliases(slug),
  scope TEXT NOT NULL DEFAULT 'GLOBAL' CHECK (scope IN ('GLOBAL', 'MARKET')),
  -- '*' for a global row. A literal rather than NULL so the UNIQUE below
  -- actually deduplicates: SQLite treats NULLs as distinct.
  market TEXT NOT NULL DEFAULT '*',
  reason TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (alias_slug, scope, market),
  CHECK (scope = 'GLOBAL' OR market <> '*')
);

CREATE INDEX IF NOT EXISTS idx_match_alias_denylist_market ON match_alias_denylist(market);

-- One customer's comparison of one set of candidates.
--
-- The session, not the clinic and not the user, is what an alias is scoped
-- to. It expires: a mapping that outlived its booking is a mapping that has
-- started to look like a permanent name.
CREATE TABLE IF NOT EXISTS search_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  search_id TEXT REFERENCES care_searches(id) ON DELETE SET NULL,
  -- Coarse market key (city/region) used for market-scoped denylisting.
  market TEXT,
  alias_library_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CONFIRMED', 'EXPIRED', 'CANCELLED')),
  -- 30 minutes by default, configurable per session; checkout extends it
  -- rather than letting a card rename itself under a customer entering a
  -- card number.
  ttl_minutes INTEGER NOT NULL DEFAULT 30,
  expires_at TEXT NOT NULL,
  confirmed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_search_sessions_status ON search_sessions(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_search_sessions_search ON search_sessions(search_id);

-- The mapping itself.
--
-- PRIMARY KEY(session, clinic) is what makes the mapping stable: a second
-- assignment for a clinic already in the session is refused rather than
-- overwritten, so a refresh cannot rename a card.
--
-- UNIQUE(session, alias) is what makes five clinics five distinct names.
--
-- clinic_id deliberately carries no foreign key. A mapping is an audit
-- record of what a customer was shown; deleting a location must not be able
-- to erase it.
CREATE TABLE IF NOT EXISTS search_match_aliases (
  search_session_id TEXT NOT NULL REFERENCES search_sessions(id) ON DELETE CASCADE,
  clinic_id TEXT NOT NULL,
  alias_id TEXT NOT NULL REFERENCES match_aliases(id),
  assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Set when the real identity was disclosed — by confirmation, or by an
  -- authorized support lookup, which is additionally written to audit_events.
  revealed_at TEXT,
  revealed_to TEXT,
  reveal_reason TEXT,
  PRIMARY KEY (search_session_id, clinic_id),
  UNIQUE (search_session_id, alias_id)
);

CREATE INDEX IF NOT EXISTS idx_search_match_aliases_alias ON search_match_aliases(alias_id);

-- ═══════════════════════════════════════════════ Google Places attribution ──
--
-- Place ids are cacheable under Google's published Places guidance; rating
-- and rating count are not, beyond what the governing agreement permits.
-- The two therefore live in different tables with different lifetimes, so
-- that "keep the id forever" cannot quietly become "keep the rating forever".
CREATE TABLE IF NOT EXISTS clinic_place_sources (
  clinic_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'GOOGLE_MAPS' CHECK (provider IN ('GOOGLE_MAPS')),
  provider_place_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  linked_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (clinic_id, provider)
);

-- A permitted temporary cache of the two Google-derived fields this product
-- displays: aggregate rating and rating count. Nothing else — no name, no
-- address, no review text, no photo, no editorial or AI summary; those carry
-- their own attribution and source-link obligations that are not implemented.
--
-- expires_at is load-bearing. Stale content must be HIDDEN, never served:
-- when the upstream call fails, the rating module renders its unavailable
-- state and the match card stays complete without it. An old rating shown as
-- current is a misrepresentation of Google's data, and the fact that it is
-- the last number we happened to see does not make it today's number.
CREATE TABLE IF NOT EXISTS place_content_snapshots (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'GOOGLE_MAPS' CHECK (provider IN ('GOOGLE_MAPS')),
  provider_place_id TEXT NOT NULL,
  rating REAL CHECK (rating IS NULL OR (rating >= 0 AND rating <= 5)),
  user_rating_count INTEGER CHECK (user_rating_count IS NULL OR user_rating_count >= 0),
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  -- Which review of the provider's terms this cache was taken under, so a
  -- policy change has a population of rows it applies to.
  source_policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_place_content_snapshots_clinic
  ON place_content_snapshots(clinic_id, datetime(expires_at) DESC);

-- ════════════════════════════════════════════════════════════ join portal ──
--
-- `provider_applications` already existed (migration 0010) as a lead-capture
-- form: practice, contact, city, state, a free-text message, and a
-- new/contacted/closed triage status. That is the same object as the join
-- portal, one screen earlier, so this extends it rather than standing up a
-- second `clinic_applications` table for the same practices to be lost
-- between.
--
-- The legacy `status` column keeps its old vocabulary and its old readers
-- (the admin console). `review_status` carries the portal lifecycle
-- SUBMITTED → REVIEWING → APPROVED/DECLINED/WITHDRAWN; src/clinic-billing.js
-- writes both so neither console sees a row frozen in a state it cannot
-- explain.
ALTER TABLE provider_applications ADD COLUMN address_line1 TEXT;
ALTER TABLE provider_applications ADD COLUMN postal_code TEXT;
ALTER TABLE provider_applications ADD COLUMN country TEXT NOT NULL DEFAULT 'US';
ALTER TABLE provider_applications ADD COLUMN website TEXT;
-- License and accreditation as recorded by the applicant. Verified by a human
-- before approval; the column is what was claimed, not proof of anything.
ALTER TABLE provider_applications ADD COLUMN license_number TEXT;
ALTER TABLE provider_applications ADD COLUMN license_authority TEXT;
ALTER TABLE provider_applications ADD COLUMN license_expires_on TEXT;
ALTER TABLE provider_applications ADD COLUMN accreditation TEXT;
-- JSON arrays/objects, same shape as locations.species_json / capabilities_json
-- / hours_json so approval can copy them onto the created location.
ALTER TABLE provider_applications ADD COLUMN species_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE provider_applications ADD COLUMN capabilities_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE provider_applications ADD COLUMN hours_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE provider_applications ADD COLUMN kind TEXT;
ALTER TABLE provider_applications ADD COLUMN wants_founding INTEGER NOT NULL DEFAULT 0 CHECK (wants_founding IN (0, 1));
ALTER TABLE provider_applications ADD COLUMN heard_about TEXT;
ALTER TABLE provider_applications ADD COLUMN notes TEXT;
ALTER TABLE provider_applications ADD COLUMN review_status TEXT NOT NULL DEFAULT 'SUBMITTED'
  CHECK (review_status IN ('SUBMITTED', 'REVIEWING', 'APPROVED', 'DECLINED', 'WITHDRAWN'));
ALTER TABLE provider_applications ADD COLUMN reviewed_by TEXT;
ALTER TABLE provider_applications ADD COLUMN reviewed_at TEXT;
ALTER TABLE provider_applications ADD COLUMN review_note TEXT;
ALTER TABLE provider_applications ADD COLUMN decline_reason TEXT;
-- Set on approval. The application row is the paper trail for why a tenant
-- exists at all, so it is never deleted once a tenant points back at it.
ALTER TABLE provider_applications ADD COLUMN created_tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL;
ALTER TABLE provider_applications ADD COLUMN created_location_id TEXT REFERENCES locations(id) ON DELETE SET NULL;
-- A coarse per-submitter key for rate limiting the public form. A truncated
-- hash of IP + day, never the address itself — the same posture as
-- analytics_events.visitor_hash.
ALTER TABLE provider_applications ADD COLUMN submitter_hash TEXT;

-- Existing rows predate the portal and are all still in triage.
UPDATE provider_applications SET review_status = CASE status
  WHEN 'contacted' THEN 'REVIEWING'
  WHEN 'closed' THEN 'DECLINED'
  ELSE 'SUBMITTED' END;

CREATE INDEX IF NOT EXISTS idx_provider_applications_review
  ON provider_applications(review_status, datetime(created_at));
CREATE INDEX IF NOT EXISTS idx_provider_applications_submitter
  ON provider_applications(submitter_hash, datetime(created_at));

-- ═════════════════════════════════════════════ clinic invoices and fees ──
--
-- The monthly statement, which is the default collection mechanism: one
-- invoice a month costs less in processor fees than a card charge per visit
-- and gives a practice manager one thing to reconcile.
--
-- No line here ever references the fund. Clinic debt is an ordinary
-- receivable; restricted contributions are somebody else's money being held
-- for a specific purpose, and netting one against the other would spend a
-- donor's $2 on a clinic's unpaid invoice.
CREATE TABLE IF NOT EXISTS clinic_invoices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  total_cents INTEGER NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  line_count INTEGER NOT NULL DEFAULT 0 CHECK (line_count >= 0),
  currency TEXT NOT NULL DEFAULT 'usd',
  stripe_invoice_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'OPEN', 'PAID', 'PAST_DUE', 'UNCOLLECTIBLE', 'VOID')),
  sent_at TEXT,
  paid_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- One statement per practice per period. A second draft for the same month
  -- is how a clinic gets billed twice.
  UNIQUE (tenant_id, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS idx_clinic_invoices_tenant ON clinic_invoices(tenant_id, status);

-- What a clinic owes Tími for one completed connection, and why.
--
-- A row exists for every completed visit, including the ones that cost
-- nothing: a founding clinic's $0 and a sponsored visit's $0 are written
-- explicitly with their reason rather than skipped, because a waiver that
-- leaves no row is indistinguishable from a fee nobody remembered to bill.
--
-- UNIQUE(intake_id) is the idempotency guarantee: a redelivered completion
-- event cannot bill the same visit twice.
CREATE TABLE IF NOT EXISTS clinic_fee_receivables (
  id TEXT PRIMARY KEY,
  intake_id TEXT NOT NULL UNIQUE REFERENCES intake_requests(id) ON DELETE RESTRICT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'usd',
  -- The pricing policy this fee was computed under, captured so a later price
  -- change is prospective by construction.
  fee_policy_id TEXT REFERENCES pricing_policies(id),
  fee_policy_version INTEGER NOT NULL,
  plan TEXT NOT NULL CHECK (plan IN ('STANDARD', 'FOUNDING', 'CUSTOM')),
  -- STANDARD_RATE | FOUNDING_CLINIC_RATE | CUSTOM_CONTRACT_RATE |
  -- FOUNDING_SUSPENDED_NOT_IN_GOOD_STANDING | SPONSORED_VISIT
  reason TEXT NOT NULL,
  -- WAIVED is the terminal state of a $0 row: settled at birth, nothing to
  -- collect, still auditable. VOID is a fee reversed after the fact
  -- (a successful clinic dispute), which is a different fact entirely.
  state TEXT NOT NULL DEFAULT 'DUE' CHECK (state IN ('DUE', 'RETRYING', 'PAST_DUE', 'RESTRICTED', 'PAID', 'VOID', 'WAIVED')),
  completed_at TEXT NOT NULL,
  invoice_id TEXT REFERENCES clinic_invoices(id) ON DELETE SET NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  void_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- A zero fee is never owed, and a non-zero fee is never waived. Without
  -- this a $25 row could be quietly filed as a waiver.
  CHECK ((amount_cents = 0) = (state = 'WAIVED'))
);

CREATE INDEX IF NOT EXISTS idx_clinic_fee_receivables_tenant
  ON clinic_fee_receivables(tenant_id, state, datetime(completed_at));
CREATE INDEX IF NOT EXISTS idx_clinic_fee_receivables_invoice
  ON clinic_fee_receivables(invoice_id);

-- ═══════════════════════════════════════════════════ visit verification ──
--
-- A clinic-side fee cannot rest on "please tell us whether the patient came".
-- Nor can it rest on the customer alone, who may be in a waiting room with a
-- sick animal and no interest in a form.
--
-- So: signals accumulate, and the state machine reads all of them. Each row
-- is one observation with its source and weight. Nothing is overwritten —
-- a contradicting signal is another row, not an edit, because the interesting
-- case for a dispute is precisely the sequence of who said what and when.
CREATE TABLE IF NOT EXISTS visit_signals (
  id TEXT PRIMARY KEY,
  intake_id TEXT NOT NULL REFERENCES intake_requests(id) ON DELETE CASCADE,
  signal TEXT NOT NULL CHECK (signal IN (
    'CUSTOMER_CONFIRMED',
    'CLINIC_ACCEPTED',
    'CLINIC_REVEALED',
    'EN_ROUTE',
    'GEOFENCE_ARRIVAL',
    'CUSTOMER_CHECKIN',
    'CLINIC_CHECKIN',
    'CLINIC_SERVICE_CONFIRMED',
    'CUSTOMER_SERVICE_CONFIRMED',
    'PMS_INTEGRATION_EVENT',
    'DEPOSIT_CAPTURED',
    'DEPOSIT_REFUNDED',
    'CUSTOMER_CANCELLED',
    'CLINIC_CANCELLED',
    'NO_SHOW_REPORTED',
    'DISPUTE_OPENED',
    'DISPUTE_RESOLVED'
  )),
  source TEXT NOT NULL CHECK (source IN ('CUSTOMER', 'CLINIC', 'DEVICE', 'PAYMENT', 'INTEGRATION', 'SUPPORT', 'SYSTEM')),
  -- How much this observation is worth on its own. A clinic's own report of a
  -- completed visit is deliberately not sufficient to bill for it.
  weight INTEGER NOT NULL DEFAULT 1 CHECK (weight >= 0),
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  recorded_by TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_visit_signals_intake ON visit_signals(intake_id, datetime(occurred_at));

-- The current position in the state machine, derived from the signals above
-- and cached here so a dashboard does not replay the log on every poll. The
-- signals remain the source of truth; this row can be rebuilt from them.
CREATE TABLE IF NOT EXISTS visit_verifications (
  intake_id TEXT PRIMARY KEY REFERENCES intake_requests(id) ON DELETE CASCADE,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'MATCHED' CHECK (state IN (
    'MATCHED', 'CUSTOMER_CONFIRMED', 'CLINIC_REVEALED', 'EN_ROUTE', 'ARRIVED_SIGNAL',
    'CLINIC_CHECKIN_CONFIRMED', 'SERVICE_CONFIRMED', 'COMPLETED',
    'CANCELLED', 'NO_SHOW', 'DISPUTED'
  )),
  -- Corroboration score at the time the state was last evaluated. Billing
  -- requires both COMPLETED and independent corroboration.
  corroboration INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  entered_state_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_visit_verifications_state ON visit_verifications(state, datetime(updated_at));

-- ─────────────────────────────────────────────────────── the 250 aliases ──
--
-- Seeded from src/alias-library.js (library version 1). The test suite
-- asserts the two agree exactly, in both directions.

INSERT OR IGNORE INTO match_aliases (id, slug, display_name, category, library_version, active) VALUES
  ('alias_alder', 'alder', 'Alder', 'TREES_WOODLAND', 1, 1),
  ('alias_aspen', 'aspen', 'Aspen', 'TREES_WOODLAND', 1, 1),
  ('alias_banyan', 'banyan', 'Banyan', 'TREES_WOODLAND', 1, 1),
  ('alias_birch', 'birch', 'Birch', 'TREES_WOODLAND', 1, 1),
  ('alias_bramble', 'bramble', 'Bramble', 'TREES_WOODLAND', 1, 1),
  ('alias_canopy', 'canopy', 'Canopy', 'TREES_WOODLAND', 1, 1),
  ('alias_cedar', 'cedar', 'Cedar', 'TREES_WOODLAND', 1, 1),
  ('alias_cypress', 'cypress', 'Cypress', 'TREES_WOODLAND', 1, 1),
  ('alias_dogwood', 'dogwood', 'Dogwood', 'TREES_WOODLAND', 1, 1),
  ('alias_elmwood', 'elmwood', 'Elmwood', 'TREES_WOODLAND', 1, 1),
  ('alias_fernwood', 'fernwood', 'Fernwood', 'TREES_WOODLAND', 1, 1),
  ('alias_grove', 'grove', 'Grove', 'TREES_WOODLAND', 1, 1),
  ('alias_hawthorn', 'hawthorn', 'Hawthorn', 'TREES_WOODLAND', 1, 1),
  ('alias_hemlock', 'hemlock', 'Hemlock', 'TREES_WOODLAND', 1, 1),
  ('alias_hickory', 'hickory', 'Hickory', 'TREES_WOODLAND', 1, 1),
  ('alias_juniper', 'juniper', 'Juniper', 'TREES_WOODLAND', 1, 1),
  ('alias_linden', 'linden', 'Linden', 'TREES_WOODLAND', 1, 1),
  ('alias_magnolia', 'magnolia', 'Magnolia', 'TREES_WOODLAND', 1, 1),
  ('alias_maple', 'maple', 'Maple', 'TREES_WOODLAND', 1, 1),
  ('alias_oakwood', 'oakwood', 'Oakwood', 'TREES_WOODLAND', 1, 1),
  ('alias_pinecrest', 'pinecrest', 'Pinecrest', 'TREES_WOODLAND', 1, 1),
  ('alias_redwood', 'redwood', 'Redwood', 'TREES_WOODLAND', 1, 1),
  ('alias_sequoia', 'sequoia', 'Sequoia', 'TREES_WOODLAND', 1, 1),
  ('alias_sycamore', 'sycamore', 'Sycamore', 'TREES_WOODLAND', 1, 1),
  ('alias_willow', 'willow', 'Willow', 'TREES_WOODLAND', 1, 1),
  ('alias_amaranth', 'amaranth', 'Amaranth', 'FLOWERS_BOTANICALS', 1, 1),
  ('alias_aster', 'aster', 'Aster', 'FLOWERS_BOTANICALS', 1, 1),
  ('alias_azalea', 'azalea', 'Azalea', 'FLOWERS_BOTANICALS', 1, 1),
  ('alias_bluebell', 'bluebell', 'Bluebell', 'FLOWERS_BOTANICALS', 1, 1),
  ('alias_camellia', 'camellia', 'Camellia', 'FLOWERS_BOTANICALS', 1, 1),
  ('alias_clover', 'clover', 'Clover', 'FLOWERS_BOTANICALS', 1, 1),
  ('alias_dahlia', 'dahlia', 'Dahlia', 'FLOWERS_BOTANICALS', 1, 1),
  ('alias_dandelion', 'dandelion', 'Dandelion', 'FLOWERS_BOTANICALS', 1, 1),
  ('alias_flora', 'flora', 'Flora', 'FLOWERS_BOTANICALS', 1, 1),
  ('alias_gardenia', 'gardenia', 'Gardenia', 'FLOWERS_BOTANICALS', 1, 1),
  ('alias_heather', 'heather', 'Heather', 'FLOWERS_BOTANICALS', 1, 1),
  ('alias_hibiscus', 'hibiscus', 'Hibiscus', 'FLOWERS_BOTANICALS', 1, 1),
  ('alias_hollyhock', 'hollyhock', 'Hollyhock', 'FLOWERS_BOTANICALS', 1, 1),
  ('alias_hyacinth', 'hyacinth', 'Hyacinth', 'FLOWERS_BOTANICALS', 1, 1),
  ('alias_iris', 'iris', 'Iris', 'FLOWERS_BOTANICALS', 1, 1),
  ('alias_jasmine', 'jasmine', 'Jasmine', 'FLOWERS_BOTANICALS', 1, 1),
  ('alias_lavender', 'lavender', 'Lavender', 'FLOWERS_BOTANICALS', 1, 1),
  ('alias_lilac', 'lilac', 'Lilac', 'FLOWERS_BOTANICALS', 1, 1),
  ('alias_lotus', 'lotus', 'Lotus', 'FLOWERS_BOTANICALS', 1, 1),
  ('alias_marigold', 'marigold', 'Marigold', 'FLOWERS_BOTANICALS', 1, 1),
  ('alias_orchid', 'orchid', 'Orchid', 'FLOWERS_BOTANICALS', 1, 1),
  ('alias_peony', 'peony', 'Peony', 'FLOWERS_BOTANICALS', 1, 1),
  ('alias_primrose', 'primrose', 'Primrose', 'FLOWERS_BOTANICALS', 1, 1),
  ('alias_verbena', 'verbena', 'Verbena', 'FLOWERS_BOTANICALS', 1, 1),
  ('alias_wisteria', 'wisteria', 'Wisteria', 'FLOWERS_BOTANICALS', 1, 1),
  ('alias_basil', 'basil', 'Basil', 'HERBS_GRASSES', 1, 1),
  ('alias_briar', 'briar', 'Briar', 'HERBS_GRASSES', 1, 1),
  ('alias_bulrush', 'bulrush', 'Bulrush', 'HERBS_GRASSES', 1, 1),
  ('alias_chamomile', 'chamomile', 'Chamomile', 'HERBS_GRASSES', 1, 1),
  ('alias_chicory', 'chicory', 'Chicory', 'HERBS_GRASSES', 1, 1),
  ('alias_coriander', 'coriander', 'Coriander', 'HERBS_GRASSES', 1, 1),
  ('alias_fennel', 'fennel', 'Fennel', 'HERBS_GRASSES', 1, 1),
  ('alias_fern', 'fern', 'Fern', 'HERBS_GRASSES', 1, 1),
  ('alias_flax', 'flax', 'Flax', 'HERBS_GRASSES', 1, 1),
  ('alias_ginger', 'ginger', 'Ginger', 'HERBS_GRASSES', 1, 1),
  ('alias_ivy', 'ivy', 'Ivy', 'HERBS_GRASSES', 1, 1),
  ('alias_laurel', 'laurel', 'Laurel', 'HERBS_GRASSES', 1, 1),
  ('alias_lemongrass', 'lemongrass', 'Lemongrass', 'HERBS_GRASSES', 1, 1),
  ('alias_meadowgrass', 'meadowgrass', 'Meadowgrass', 'HERBS_GRASSES', 1, 1),
  ('alias_mintleaf', 'mintleaf', 'Mintleaf', 'HERBS_GRASSES', 1, 1),
  ('alias_moss', 'moss', 'Moss', 'HERBS_GRASSES', 1, 1),
  ('alias_nettle', 'nettle', 'Nettle', 'HERBS_GRASSES', 1, 1),
  ('alias_oregano', 'oregano', 'Oregano', 'HERBS_GRASSES', 1, 1),
  ('alias_parsley', 'parsley', 'Parsley', 'HERBS_GRASSES', 1, 1),
  ('alias_reed', 'reed', 'Reed', 'HERBS_GRASSES', 1, 1),
  ('alias_rosemary', 'rosemary', 'Rosemary', 'HERBS_GRASSES', 1, 1),
  ('alias_sagebrush', 'sagebrush', 'Sagebrush', 'HERBS_GRASSES', 1, 1),
  ('alias_sorrel', 'sorrel', 'Sorrel', 'HERBS_GRASSES', 1, 1),
  ('alias_thyme', 'thyme', 'Thyme', 'HERBS_GRASSES', 1, 1),
  ('alias_yarrow', 'yarrow', 'Yarrow', 'HERBS_GRASSES', 1, 1),
  ('alias_afterglow', 'afterglow', 'Afterglow', 'SKY_LIGHT', 1, 1),
  ('alias_aurora', 'aurora', 'Aurora', 'SKY_LIGHT', 1, 1),
  ('alias_beacon', 'beacon', 'Beacon', 'SKY_LIGHT', 1, 1),
  ('alias_bluehour', 'bluehour', 'Bluehour', 'SKY_LIGHT', 1, 1),
  ('alias_borealis', 'borealis', 'Borealis', 'SKY_LIGHT', 1, 1),
  ('alias_celestial', 'celestial', 'Celestial', 'SKY_LIGHT', 1, 1),
  ('alias_cirrus', 'cirrus', 'Cirrus', 'SKY_LIGHT', 1, 1),
  ('alias_comet', 'comet', 'Comet', 'SKY_LIGHT', 1, 1),
  ('alias_daybreak', 'daybreak', 'Daybreak', 'SKY_LIGHT', 1, 1),
  ('alias_daylight', 'daylight', 'Daylight', 'SKY_LIGHT', 1, 1),
  ('alias_eclipse', 'eclipse', 'Eclipse', 'SKY_LIGHT', 1, 1),
  ('alias_equinox', 'equinox', 'Equinox', 'SKY_LIGHT', 1, 1),
  ('alias_halo', 'halo', 'Halo', 'SKY_LIGHT', 1, 1),
  ('alias_horizon', 'horizon', 'Horizon', 'SKY_LIGHT', 1, 1),
  ('alias_lumen', 'lumen', 'Lumen', 'SKY_LIGHT', 1, 1),
  ('alias_meridian', 'meridian', 'Meridian', 'SKY_LIGHT', 1, 1),
  ('alias_moonbeam', 'moonbeam', 'Moonbeam', 'SKY_LIGHT', 1, 1),
  ('alias_nova', 'nova', 'Nova', 'SKY_LIGHT', 1, 1),
  ('alias_radiance', 'radiance', 'Radiance', 'SKY_LIGHT', 1, 1),
  ('alias_skylark', 'skylark', 'Skylark', 'SKY_LIGHT', 1, 1),
  ('alias_solstice', 'solstice', 'Solstice', 'SKY_LIGHT', 1, 1),
  ('alias_starlight', 'starlight', 'Starlight', 'SKY_LIGHT', 1, 1),
  ('alias_sunbeam', 'sunbeam', 'Sunbeam', 'SKY_LIGHT', 1, 1),
  ('alias_sundial', 'sundial', 'Sundial', 'SKY_LIGHT', 1, 1),
  ('alias_twilight', 'twilight', 'Twilight', 'SKY_LIGHT', 1, 1),
  ('alias_brook', 'brook', 'Brook', 'WATER_COAST', 1, 1),
  ('alias_cascade', 'cascade', 'Cascade', 'WATER_COAST', 1, 1),
  ('alias_cove', 'cove', 'Cove', 'WATER_COAST', 1, 1),
  ('alias_current', 'current', 'Current', 'WATER_COAST', 1, 1),
  ('alias_delta', 'delta', 'Delta', 'WATER_COAST', 1, 1),
  ('alias_dewdrop', 'dewdrop', 'Dewdrop', 'WATER_COAST', 1, 1),
  ('alias_estuary', 'estuary', 'Estuary', 'WATER_COAST', 1, 1),
  ('alias_fjord', 'fjord', 'Fjord', 'WATER_COAST', 1, 1),
  ('alias_harbor', 'harbor', 'Harbor', 'WATER_COAST', 1, 1),
  ('alias_headwater', 'headwater', 'Headwater', 'WATER_COAST', 1, 1),
  ('alias_lagoon', 'lagoon', 'Lagoon', 'WATER_COAST', 1, 1),
  ('alias_lakeshore', 'lakeshore', 'Lakeshore', 'WATER_COAST', 1, 1),
  ('alias_marina', 'marina', 'Marina', 'WATER_COAST', 1, 1),
  ('alias_mist', 'mist', 'Mist', 'WATER_COAST', 1, 1),
  ('alias_oasis', 'oasis', 'Oasis', 'WATER_COAST', 1, 1),
  ('alias_pebble', 'pebble', 'Pebble', 'WATER_COAST', 1, 1),
  ('alias_rainfall', 'rainfall', 'Rainfall', 'WATER_COAST', 1, 1),
  ('alias_ripple', 'ripple', 'Ripple', 'WATER_COAST', 1, 1),
  ('alias_riverbend', 'riverbend', 'Riverbend', 'WATER_COAST', 1, 1),
  ('alias_seabreeze', 'seabreeze', 'Seabreeze', 'WATER_COAST', 1, 1),
  ('alias_shoal', 'shoal', 'Shoal', 'WATER_COAST', 1, 1),
  ('alias_springtide', 'springtide', 'Springtide', 'WATER_COAST', 1, 1),
  ('alias_stream', 'stream', 'Stream', 'WATER_COAST', 1, 1),
  ('alias_tidepool', 'tidepool', 'Tidepool', 'WATER_COAST', 1, 1),
  ('alias_waterfall', 'waterfall', 'Waterfall', 'WATER_COAST', 1, 1),
  ('alias_arroyo', 'arroyo', 'Arroyo', 'TERRAIN_LANDSCAPE', 1, 1),
  ('alias_bluff', 'bluff', 'Bluff', 'TERRAIN_LANDSCAPE', 1, 1),
  ('alias_canyon', 'canyon', 'Canyon', 'TERRAIN_LANDSCAPE', 1, 1),
  ('alias_canyonland', 'canyonland', 'Canyonland', 'TERRAIN_LANDSCAPE', 1, 1),
  ('alias_cliffside', 'cliffside', 'Cliffside', 'TERRAIN_LANDSCAPE', 1, 1),
  ('alias_crest', 'crest', 'Crest', 'TERRAIN_LANDSCAPE', 1, 1),
  ('alias_dune', 'dune', 'Dune', 'TERRAIN_LANDSCAPE', 1, 1),
  ('alias_fieldstone', 'fieldstone', 'Fieldstone', 'TERRAIN_LANDSCAPE', 1, 1),
  ('alias_foothill', 'foothill', 'Foothill', 'TERRAIN_LANDSCAPE', 1, 1),
  ('alias_glen', 'glen', 'Glen', 'TERRAIN_LANDSCAPE', 1, 1),
  ('alias_granite', 'granite', 'Granite', 'TERRAIN_LANDSCAPE', 1, 1),
  ('alias_highland', 'highland', 'Highland', 'TERRAIN_LANDSCAPE', 1, 1),
  ('alias_hillcrest', 'hillcrest', 'Hillcrest', 'TERRAIN_LANDSCAPE', 1, 1),
  ('alias_meadow', 'meadow', 'Meadow', 'TERRAIN_LANDSCAPE', 1, 1),
  ('alias_mesa', 'mesa', 'Mesa', 'TERRAIN_LANDSCAPE', 1, 1),
  ('alias_moorland', 'moorland', 'Moorland', 'TERRAIN_LANDSCAPE', 1, 1),
  ('alias_overlook', 'overlook', 'Overlook', 'TERRAIN_LANDSCAPE', 1, 1),
  ('alias_prairie', 'prairie', 'Prairie', 'TERRAIN_LANDSCAPE', 1, 1),
  ('alias_ridgeline', 'ridgeline', 'Ridgeline', 'TERRAIN_LANDSCAPE', 1, 1),
  ('alias_sandstone', 'sandstone', 'Sandstone', 'TERRAIN_LANDSCAPE', 1, 1),
  ('alias_sierra', 'sierra', 'Sierra', 'TERRAIN_LANDSCAPE', 1, 1),
  ('alias_summit', 'summit', 'Summit', 'TERRAIN_LANDSCAPE', 1, 1),
  ('alias_timberline', 'timberline', 'Timberline', 'TERRAIN_LANDSCAPE', 1, 1),
  ('alias_vale', 'vale', 'Vale', 'TERRAIN_LANDSCAPE', 1, 1),
  ('alias_wildland', 'wildland', 'Wildland', 'TERRAIN_LANDSCAPE', 1, 1),
  ('alias_autumn', 'autumn', 'Autumn', 'WEATHER_SEASONS', 1, 1),
  ('alias_breeze', 'breeze', 'Breeze', 'WEATHER_SEASONS', 1, 1),
  ('alias_cloudburst', 'cloudburst', 'Cloudburst', 'WEATHER_SEASONS', 1, 1),
  ('alias_cloudlet', 'cloudlet', 'Cloudlet', 'WEATHER_SEASONS', 1, 1),
  ('alias_coolwind', 'coolwind', 'Coolwind', 'WEATHER_SEASONS', 1, 1),
  ('alias_drizzle', 'drizzle', 'Drizzle', 'WEATHER_SEASONS', 1, 1),
  ('alias_evergreen', 'evergreen', 'Evergreen', 'WEATHER_SEASONS', 1, 1),
  ('alias_fairweather', 'fairweather', 'Fairweather', 'WEATHER_SEASONS', 1, 1),
  ('alias_frost', 'frost', 'Frost', 'WEATHER_SEASONS', 1, 1),
  ('alias_goldleaf', 'goldleaf', 'Goldleaf', 'WEATHER_SEASONS', 1, 1),
  ('alias_hailstone', 'hailstone', 'Hailstone', 'WEATHER_SEASONS', 1, 1),
  ('alias_midsummer', 'midsummer', 'Midsummer', 'WEATHER_SEASONS', 1, 1),
  ('alias_monsoon', 'monsoon', 'Monsoon', 'WEATHER_SEASONS', 1, 1),
  ('alias_northwind', 'northwind', 'Northwind', 'WEATHER_SEASONS', 1, 1),
  ('alias_raincloud', 'raincloud', 'Raincloud', 'WEATHER_SEASONS', 1, 1),
  ('alias_raindrop', 'raindrop', 'Raindrop', 'WEATHER_SEASONS', 1, 1),
  ('alias_snowdrop', 'snowdrop', 'Snowdrop', 'WEATHER_SEASONS', 1, 1),
  ('alias_snowfall', 'snowfall', 'Snowfall', 'WEATHER_SEASONS', 1, 1),
  ('alias_spring', 'spring', 'Spring', 'WEATHER_SEASONS', 1, 1),
  ('alias_starfall', 'starfall', 'Starfall', 'WEATHER_SEASONS', 1, 1),
  ('alias_sunshower', 'sunshower', 'Sunshower', 'WEATHER_SEASONS', 1, 1),
  ('alias_tempest', 'tempest', 'Tempest', 'WEATHER_SEASONS', 1, 1),
  ('alias_tradewind', 'tradewind', 'Tradewind', 'WEATHER_SEASONS', 1, 1),
  ('alias_westwind', 'westwind', 'Westwind', 'WEATHER_SEASONS', 1, 1),
  ('alias_wintergreen', 'wintergreen', 'Wintergreen', 'WEATHER_SEASONS', 1, 1),
  ('alias_amber', 'amber', 'Amber', 'STONE_EARTH', 1, 1),
  ('alias_amethyst', 'amethyst', 'Amethyst', 'STONE_EARTH', 1, 1),
  ('alias_basalt', 'basalt', 'Basalt', 'STONE_EARTH', 1, 1),
  ('alias_copper', 'copper', 'Copper', 'STONE_EARTH', 1, 1),
  ('alias_coral', 'coral', 'Coral', 'STONE_EARTH', 1, 1),
  ('alias_crystal', 'crystal', 'Crystal', 'STONE_EARTH', 1, 1),
  ('alias_ember', 'ember', 'Ember', 'STONE_EARTH', 1, 1),
  ('alias_flint', 'flint', 'Flint', 'STONE_EARTH', 1, 1),
  ('alias_garnet', 'garnet', 'Garnet', 'STONE_EARTH', 1, 1),
  ('alias_goldstone', 'goldstone', 'Goldstone', 'STONE_EARTH', 1, 1),
  ('alias_ironwood', 'ironwood', 'Ironwood', 'STONE_EARTH', 1, 1),
  ('alias_jade', 'jade', 'Jade', 'STONE_EARTH', 1, 1),
  ('alias_jasper', 'jasper', 'Jasper', 'STONE_EARTH', 1, 1),
  ('alias_limestone', 'limestone', 'Limestone', 'STONE_EARTH', 1, 1),
  ('alias_marble', 'marble', 'Marble', 'STONE_EARTH', 1, 1),
  ('alias_moonstone', 'moonstone', 'Moonstone', 'STONE_EARTH', 1, 1),
  ('alias_obsidian', 'obsidian', 'Obsidian', 'STONE_EARTH', 1, 1),
  ('alias_onyx', 'onyx', 'Onyx', 'STONE_EARTH', 1, 1),
  ('alias_opal', 'opal', 'Opal', 'STONE_EARTH', 1, 1),
  ('alias_pearl', 'pearl', 'Pearl', 'STONE_EARTH', 1, 1),
  ('alias_quartz', 'quartz', 'Quartz', 'STONE_EARTH', 1, 1),
  ('alias_riverstone', 'riverstone', 'Riverstone', 'STONE_EARTH', 1, 1),
  ('alias_slate', 'slate', 'Slate', 'STONE_EARTH', 1, 1),
  ('alias_topaz', 'topaz', 'Topaz', 'STONE_EARTH', 1, 1),
  ('alias_travertine', 'travertine', 'Travertine', 'STONE_EARTH', 1, 1),
  ('alias_accord', 'accord', 'Accord', 'WARM_ABSTRACT', 1, 1),
  ('alias_amity', 'amity', 'Amity', 'WARM_ABSTRACT', 1, 1),
  ('alias_brightway', 'brightway', 'Brightway', 'WARM_ABSTRACT', 1, 1),
  ('alias_candor', 'candor', 'Candor', 'WARM_ABSTRACT', 1, 1),
  ('alias_compass', 'compass', 'Compass', 'WARM_ABSTRACT', 1, 1),
  ('alias_everwell', 'everwell', 'Everwell', 'WARM_ABSTRACT', 1, 1),
  ('alias_flourish', 'flourish', 'Flourish', 'WARM_ABSTRACT', 1, 1),
  ('alias_harmony', 'harmony', 'Harmony', 'WARM_ABSTRACT', 1, 1),
  ('alias_haven', 'haven', 'Haven', 'WARM_ABSTRACT', 1, 1),
  ('alias_hearth', 'hearth', 'Hearth', 'WARM_ABSTRACT', 1, 1),
  ('alias_kindred', 'kindred', 'Kindred', 'WARM_ABSTRACT', 1, 1),
  ('alias_lantern', 'lantern', 'Lantern', 'WARM_ABSTRACT', 1, 1),
  ('alias_lucent', 'lucent', 'Lucent', 'WARM_ABSTRACT', 1, 1),
  ('alias_mosaic', 'mosaic', 'Mosaic', 'WARM_ABSTRACT', 1, 1),
  ('alias_northstar', 'northstar', 'Northstar', 'WARM_ABSTRACT', 1, 1),
  ('alias_openway', 'openway', 'Openway', 'WARM_ABSTRACT', 1, 1),
  ('alias_promise', 'promise', 'Promise', 'WARM_ABSTRACT', 1, 1),
  ('alias_quietude', 'quietude', 'Quietude', 'WARM_ABSTRACT', 1, 1),
  ('alias_reverie', 'reverie', 'Reverie', 'WARM_ABSTRACT', 1, 1),
  ('alias_serenade', 'serenade', 'Serenade', 'WARM_ABSTRACT', 1, 1),
  ('alias_stillwater', 'stillwater', 'Stillwater', 'WARM_ABSTRACT', 1, 1),
  ('alias_tranquil', 'tranquil', 'Tranquil', 'WARM_ABSTRACT', 1, 1),
  ('alias_unity', 'unity', 'Unity', 'WARM_ABSTRACT', 1, 1),
  ('alias_vantage', 'vantage', 'Vantage', 'WARM_ABSTRACT', 1, 1),
  ('alias_wayfinder', 'wayfinder', 'Wayfinder', 'WARM_ABSTRACT', 1, 1),
  ('alias_cadence', 'cadence', 'Cadence', 'MOVEMENT_MUSIC', 1, 1),
  ('alias_chime', 'chime', 'Chime', 'MOVEMENT_MUSIC', 1, 1),
  ('alias_drift', 'drift', 'Drift', 'MOVEMENT_MUSIC', 1, 1),
  ('alias_echo', 'echo', 'Echo', 'MOVEMENT_MUSIC', 1, 1),
  ('alias_feather', 'feather', 'Feather', 'MOVEMENT_MUSIC', 1, 1),
  ('alias_firefly', 'firefly', 'Firefly', 'MOVEMENT_MUSIC', 1, 1),
  ('alias_glide', 'glide', 'Glide', 'MOVEMENT_MUSIC', 1, 1),
  ('alias_hummingbird', 'hummingbird', 'Hummingbird', 'MOVEMENT_MUSIC', 1, 1),
  ('alias_lilt', 'lilt', 'Lilt', 'MOVEMENT_MUSIC', 1, 1),
  ('alias_melody', 'melody', 'Melody', 'MOVEMENT_MUSIC', 1, 1),
  ('alias_murmur', 'murmur', 'Murmur', 'MOVEMENT_MUSIC', 1, 1),
  ('alias_nightingale', 'nightingale', 'Nightingale', 'MOVEMENT_MUSIC', 1, 1),
  ('alias_overture', 'overture', 'Overture', 'MOVEMENT_MUSIC', 1, 1),
  ('alias_passage', 'passage', 'Passage', 'MOVEMENT_MUSIC', 1, 1),
  ('alias_rhapsody', 'rhapsody', 'Rhapsody', 'MOVEMENT_MUSIC', 1, 1),
  ('alias_rhythm', 'rhythm', 'Rhythm', 'MOVEMENT_MUSIC', 1, 1),
  ('alias_skylight', 'skylight', 'Skylight', 'MOVEMENT_MUSIC', 1, 1),
  ('alias_sparrow', 'sparrow', 'Sparrow', 'MOVEMENT_MUSIC', 1, 1),
  ('alias_tapestry', 'tapestry', 'Tapestry', 'MOVEMENT_MUSIC', 1, 1),
  ('alias_tempo', 'tempo', 'Tempo', 'MOVEMENT_MUSIC', 1, 1),
  ('alias_wander', 'wander', 'Wander', 'MOVEMENT_MUSIC', 1, 1),
  ('alias_whimsy', 'whimsy', 'Whimsy', 'MOVEMENT_MUSIC', 1, 1),
  ('alias_wingspan', 'wingspan', 'Wingspan', 'MOVEMENT_MUSIC', 1, 1),
  ('alias_zephyr', 'zephyr', 'Zephyr', 'MOVEMENT_MUSIC', 1, 1),
  ('alias_zenith', 'zenith', 'Zenith', 'MOVEMENT_MUSIC', 1, 1);
