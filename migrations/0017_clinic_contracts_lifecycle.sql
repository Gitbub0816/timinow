PRAGMA foreign_keys = ON;

-- ═══════════════════════════════════ the clinic agreement, as data ══════════
--
-- The paper is a real contract: the VETERINARY CLINIC PLATFORM PARTICIPATION
-- AGREEMENT between **ClearKey Solutions, LLC** and a veterinary practice.
-- TímiNOW is ClearKey's product, not a counterparty; Paw It Forward is a
-- ClearKey-administered program inside the same agreement. Nothing in this
-- schema may name TímiNOW or Paw It Forward as a contracting entity.
--
-- Four ideas run through every table below, and each of them exists because
-- getting it wrong costs a practice its bargain:
--
--   1. **History, not current state.** An Authorized Representative, an
--      owner, a founding designation — each is a fact with a date range. A
--      row is closed and a new one opened; nothing is overwritten. When a
--      clinic asks in 2029 who authorized a 2026 pricing change, "the person
--      currently in the field" is not an answer.
--
--   2. **Ordinary turnover is not a forfeiture.** Contract §3: "A change in
--      personnel, management, administrator, or medical director that does
--      not change the contracting legal entity shall not by itself terminate
--      this Agreement or any Founding Clinic status." So management events
--      are *recorded*, and the founding tables are deliberately not reachable
--      from them.
--
--   3. **Cause is a short, closed list.** Contract §9 enumerates it. A
--      revocation row must name one of those categories, so "revoked for
--      cause" can never mean "revoked because someone was annoyed".
--
--   4. **Silence is not separation.** Contract §27: "Mere failure to respond
--      to requests, seasonal closure, staffing shortage, or temporary
--      inactivity does not automatically constitute termination." The
--      lifecycle table therefore has a TEMPORARILY_INACTIVE state that sits
--      squarely inside the contract, and missed IVR calls have no path to
--      SEPARATED at all.

-- ─────────────────────────────────────────────────────── the agreement ──
--
-- One executed agreement per clinic per version. Superseded versions are kept
-- (status SUPERSEDED) rather than updated in place: an amendment is a new
-- document, and the old one still governs the bookings priced under it.
--
-- Participating locations are JSON rather than a child table because they are
-- a *schedule to the contract* — a snapshot of what was signed, which must not
-- drift when the operational `locations` table is edited. Contract §35 asks
-- for exactly this: "Primary Participating Location" plus an attached
-- schedule.
CREATE TABLE IF NOT EXISTS clinic_contracts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,

  -- §35 enrollment block. The legal name is the contracting party; the DBA is
  -- what the sign on the building says. Confusing the two is how a founding
  -- privilege gets claimed by a purchaser of a trade name (§9).
  clinic_legal_name TEXT NOT NULL,
  clinic_dba TEXT,
  entity_type TEXT,
  state_of_organization TEXT,

  -- The counterparty, spelled out so no report can quietly print "TímiNOW,
  -- LLC". CHECKed rather than defaulted: a row that names anything else is
  -- refused at the database.
  contracting_entity TEXT NOT NULL DEFAULT 'ClearKey Solutions, LLC'
    CHECK (contracting_entity = 'ClearKey Solutions, LLC'),
  product_name TEXT NOT NULL DEFAULT 'TímiNOW',

  agreement_version TEXT NOT NULL,
  -- The stored executed PDF/record, and the e-sign provider's own envelope
  -- and audit trail. Contract §33 contemplates retaining the completed audit
  -- trail with the executed agreement; these three ids are how we prove
  -- execution without holding the signature image in this table.
  agreement_document_id TEXT,
  esign_envelope_id TEXT,
  esign_audit_trail_id TEXT,

  -- Who signed, as distinct from who administers day to day (§2 vs §35).
  authorized_signer_name TEXT,
  authorized_signer_title TEXT,
  authorized_signer_email TEXT,

  effective_date TEXT,
  -- PENDING_SIGNATURE: sent, not executed. EXECUTED: in force.
  -- SUPERSEDED: replaced by a later signed writing (§34).
  -- TERMINATED: the agreement itself ended (§27) — separate from lifecycle.
  status TEXT NOT NULL DEFAULT 'PENDING_SIGNATURE' CHECK (status IN (
    'DRAFT', 'PENDING_SIGNATURE', 'EXECUTED', 'SUPERSEDED', 'TERMINATED', 'VOID'
  )),

  -- §31: contractual notices go to the legal-notice address, operational
  -- notices may go through the Platform. Two different columns because
  -- sending a termination notice to the front desk is not notice.
  legal_notice_email TEXT,
  billing_contact_name TEXT,
  billing_contact_email TEXT,

  -- The §15 election, captured as executed. The operational copy of this
  -- setting lives with the deposit policy; this column is what the contract
  -- says, and disagreement between the two is a finding, not a merge.
  deposit_election TEXT CHECK (deposit_election IS NULL OR deposit_election IN (
    'NO_DEPOSIT_REQUIRED', 'WAIVE_FOR_PAW_IT_FORWARD', 'ACCEPT_PIF_GUARANTEE', 'CUSTOMER_FUNDED_DEPOSIT'
  )),

  -- JSON array of { locationId?, name, addressLine1, city, region, postalCode }.
  participating_locations_json TEXT NOT NULL DEFAULT '[]',

  -- Set when this row is replaced by an amendment, so the chain is walkable.
  superseded_by_contract_id TEXT REFERENCES clinic_contracts(id) ON DELETE SET NULL,
  terminated_at TEXT,
  termination_reason TEXT,

  notes TEXT,
  recorded_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- One executed copy of a given version per clinic. A second one is either a
  -- duplicate import or a version number that was not incremented, and both
  -- are worth refusing loudly.
  UNIQUE (tenant_id, agreement_version)
);

CREATE INDEX IF NOT EXISTS idx_clinic_contracts_tenant ON clinic_contracts(tenant_id, status);
-- At most one agreement in force per clinic.
CREATE UNIQUE INDEX IF NOT EXISTS idx_clinic_contracts_one_executed
  ON clinic_contracts(tenant_id) WHERE status = 'EXECUTED';

-- ──────────────────────────────────────── authorized representatives ──
--
-- Contract §2 designates at least one Authorized Representative, on whose
-- routine instructions ClearKey may reasonably rely — and who "may not amend
-- this Agreement, transfer ownership, waive a material claim, or bind Clinic
-- to materially different pricing unless the representative has actual
-- authority to do so."
--
-- That last clause is why `authority_scope` exists as a column rather than an
-- assumption. ROUTINE is the default and covers §2's enumerated operations.
-- ACTUAL_AUTHORITY_TO_BIND is an affirmative, documented finding — it must
-- carry `authority_source_document_id`, because "we believed they could sign"
-- is not the standard the section sets.
--
-- HISTORICAL: a change closes one row (valid_to, active = 0) and opens
-- another. There is no UPDATE path that rewrites a name.
CREATE TABLE IF NOT EXISTS clinic_authorized_representatives (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  contract_id TEXT REFERENCES clinic_contracts(id) ON DELETE SET NULL,

  name TEXT NOT NULL,
  title TEXT,
  email TEXT NOT NULL,
  phone TEXT,

  role TEXT NOT NULL DEFAULT 'AUTHORIZED_REPRESENTATIVE' CHECK (role IN (
    'AUTHORIZED_REPRESENTATIVE', 'AUTHORIZED_SIGNER', 'BILLING_CONTACT',
    'LEGAL_NOTICE_CONTACT', 'PRACTICE_ADMINISTRATOR', 'MEDICAL_DIRECTOR', 'STAFF_USER'
  )),
  authority_scope TEXT NOT NULL DEFAULT 'ROUTINE' CHECK (authority_scope IN (
    'ROUTINE', 'ACTUAL_AUTHORITY_TO_BIND'
  )),
  -- The writing that establishes actual authority (a resolution, an operating
  -- agreement excerpt, a signed designation). Required for the binding scope.
  authority_source_document_id TEXT,

  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  valid_from TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  valid_to TEXT,
  -- Why the row closed: SUPERSEDED (a replacement), DEPARTED, REVOKED,
  -- ENTITY_CHANGE. Kept as free text with a hint rather than an enum because
  -- the interesting cases are narrative.
  end_reason TEXT,

  source_document_id TEXT,
  recorded_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- An open row has no end date and a closed row has one. Without this a
  -- "current" representative can carry a valid_to in the past and still be
  -- relied upon.
  CHECK ((active = 1) = (valid_to IS NULL)),
  -- §2's proviso, enforced rather than remembered.
  CHECK (authority_scope <> 'ACTUAL_AUTHORITY_TO_BIND' OR authority_source_document_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_clinic_reps_tenant ON clinic_authorized_representatives(tenant_id, active);
CREATE INDEX IF NOT EXISTS idx_clinic_reps_email ON clinic_authorized_representatives(tenant_id, email, active);

-- ────────────────────────────────── management / ownership / control ──
--
-- Contract §3 requires notice within ten business days of a material change
-- in ownership, controlling interest, legal entity, management company,
-- practice administrator, medical director, payment account, billing contact,
-- or Authorized Representative. Addendum §12 requires those to be tracked
-- historically.
--
-- APPEND-ONLY. This table is the answer to "when did this practice change
-- hands, and what did we do about it" — and, just as often, to "no, that was
-- a new office manager, not a sale."
CREATE TABLE IF NOT EXISTS clinic_management_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  contract_id TEXT REFERENCES clinic_contracts(id) ON DELETE SET NULL,

  event_type TEXT NOT NULL CHECK (event_type IN (
    'OWNER_CONTROL', 'LEGAL_ENTITY', 'MANAGEMENT_COMPANY', 'ADMINISTRATOR',
    'MEDICAL_DIRECTOR', 'BILLING', 'AUTHORIZED_REPRESENTATIVE'
  )),
  old_value TEXT,
  new_value TEXT,
  effective_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  notice_received_at TEXT,

  -- Derived at write time and stored, because the consequence is the point of
  -- the row. A change that leaves the contracting legal entity intact cannot
  -- terminate the agreement or forfeit founding status (§3, §9); only a true
  -- entity change or change of control raises the assignment question (§30).
  changes_contracting_entity INTEGER NOT NULL DEFAULT 0 CHECK (changes_contracting_entity IN (0, 1)),
  requires_successor_review INTEGER NOT NULL DEFAULT 0 CHECK (requires_successor_review IN (0, 1)),

  source_document_id TEXT,
  note TEXT,
  recorded_by TEXT,
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- An entity change is exactly the case that needs successor review. Pairing
  -- them in a CHECK stops a legal-entity row being filed as routine turnover.
  CHECK (changes_contracting_entity = 0 OR requires_successor_review = 1)
);

CREATE INDEX IF NOT EXISTS idx_clinic_management_events_tenant
  ON clinic_management_events(tenant_id, datetime(effective_at));

-- ───────────────────────────────────────── founding status, over time ──
--
-- Contract §9. The waiver is a contractual commercial privilege of the
-- enrolled Clinic, and this table is its provenance: granted when, by whom,
-- under what document, and — if it ever ended — under which enumerated Cause.
--
-- APPEND-ONLY, and read newest-first. A "current" founding status is a
-- derived value, never an editable field, so nobody can quietly move a clinic
-- from REVOKED_FOR_CAUSE back to ACTIVE without leaving the two rows that
-- show it happened.
CREATE TABLE IF NOT EXISTS clinic_founding_status_history (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  contract_id TEXT REFERENCES clinic_contracts(id) ON DELETE SET NULL,

  status TEXT NOT NULL CHECK (status IN (
    'NOT_APPLICABLE',
    'ACTIVE',
    -- Closed for renovation, short-staffed, paused for the season. Still a
    -- Founding Clinic; §9 forbids treating any of these as forfeiture.
    'TEMPORARILY_INACTIVE',
    -- Left in good faith. The waiver is dormant, not lost (§9, §28).
    'SEPARATED_ELIGIBLE_TO_RESTORE',
    -- The only terminal state, and only for an enumerated Cause.
    'REVOKED_FOR_CAUSE'
  )),
  previous_status TEXT,
  reason TEXT,
  -- One of the §9 Cause categories; required for, and only for, a revocation.
  cause_category TEXT CHECK (cause_category IS NULL OR cause_category IN (
    'FRAUD',
    'VISIT_OR_PAYMENT_FALSIFICATION',
    'INTENTIONAL_FEE_CIRCUMVENTION',
    'PAW_IT_FORWARD_FUND_MISUSE',
    'DEPOSIT_DOUBLE_COLLECTION',
    'MATERIAL_SECURITY_ABUSE',
    'MATERIAL_UNLAWFUL_CONDUCT',
    'UNCURED_MATERIAL_BREACH'
  )),

  granted_at TEXT,
  granted_by TEXT,
  -- Whether a later rejoin may restore the waiver without a fresh written
  -- decision. False after Cause: §28 requires restoration to be "express and
  -- in writing".
  rejoin_eligible INTEGER NOT NULL DEFAULT 1 CHECK (rejoin_eligible IN (0, 1)),
  revoked_at TEXT,
  revocation_reason TEXT,

  -- §9(d): the Parties may expressly agree in writing that the privilege was
  -- surrendered. That is a document, not an inference from silence.
  surrendered_in_writing INTEGER NOT NULL DEFAULT 0 CHECK (surrendered_in_writing IN (0, 1)),
  -- §3/§9: a bona fide successor may keep the privilege, but only as an
  -- affirmative recorded decision by ClearKey.
  successor_preservation INTEGER NOT NULL DEFAULT 0 CHECK (successor_preservation IN (0, 1)),

  source_document_id TEXT,
  effective_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  recorded_by TEXT,
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CHECK ((status = 'REVOKED_FOR_CAUSE') = (cause_category IS NOT NULL)),
  CHECK (status <> 'REVOKED_FOR_CAUSE' OR rejoin_eligible = 0)
);

CREATE INDEX IF NOT EXISTS idx_clinic_founding_history_tenant
  ON clinic_founding_status_history(tenant_id, datetime(effective_at));

-- ─────────────────────────────────────────────────────────── separation ──
--
-- Addendum §13 and contract §27. Every leaving is a row: who initiated it,
-- whether Cause was involved, when it takes effect, and what still has to be
-- finished. The wind-down and surviving-obligation columns exist because §27
-- makes both explicit — "orderly completion of already-confirmed bookings"
-- and payment, refund, reconciliation, confidentiality, data, and indemnity
-- obligations that outlive the account.
CREATE TABLE IF NOT EXISTS clinic_separation_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  contract_id TEXT REFERENCES clinic_contracts(id) ON DELETE SET NULL,

  kind TEXT NOT NULL CHECK (kind IN (
    'VOLUNTARY',              -- clinic gave notice (§27)
    'WITHOUT_CAUSE',          -- either party's 30-day notice
    'FOR_CAUSE',              -- §9 Cause
    'SUSPENSION',             -- §26 temporary stop; not a separation
    'REACTIVATION'            -- the account came back (§28)
  )),
  initiated_by TEXT NOT NULL DEFAULT 'CLINIC' CHECK (initiated_by IN ('CLINIC', 'CLEARKEY', 'MUTUAL')),
  cause_category TEXT CHECK (cause_category IS NULL OR cause_category IN (
    'FRAUD',
    'VISIT_OR_PAYMENT_FALSIFICATION',
    'INTENTIONAL_FEE_CIRCUMVENTION',
    'PAW_IT_FORWARD_FUND_MISUSE',
    'DEPOSIT_DOUBLE_COLLECTION',
    'MATERIAL_SECURITY_ABUSE',
    'MATERIAL_UNLAWFUL_CONDUCT',
    'UNCURED_MATERIAL_BREACH'
  )),
  reason TEXT,

  notice_received_at TEXT,
  effective_at TEXT,
  -- Confirmed bookings outstanding when notice landed. New referrals stop;
  -- these are seen through (§27).
  wind_down_booking_count INTEGER NOT NULL DEFAULT 0 CHECK (wind_down_booking_count >= 0),
  wind_down_complete INTEGER NOT NULL DEFAULT 0 CHECK (wind_down_complete IN (0, 1)),
  -- JSON snapshot of what survives: amounts due, refunds, chargebacks,
  -- deposit returns, reconciliation, confidentiality, security, indemnity,
  -- audit records.
  surviving_obligations_json TEXT NOT NULL DEFAULT '{}',
  obligations_cleared INTEGER NOT NULL DEFAULT 0 CHECK (obligations_cleared IN (0, 1)),

  founding_status_at_separation TEXT,
  source_document_id TEXT,
  recorded_by TEXT,
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CHECK ((kind = 'FOR_CAUSE') = (cause_category IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_clinic_separation_events_tenant
  ON clinic_separation_events(tenant_id, datetime(recorded_at));

-- ───────────────────────────────────────────────────────────── rejoining ──
--
-- Contract §28. A request is a record of what was asserted — same legal
-- entity? substantially the same practice? — and of what was found, kept
-- apart from the decision itself. The four §9 bars each get their own column
-- so a denial can point at the one that applied, and a restoration can show
-- that all four were checked.
CREATE TABLE IF NOT EXISTS clinic_rejoin_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  separation_event_id TEXT REFERENCES clinic_separation_events(id) ON DELETE SET NULL,

  requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  requested_by_name TEXT,
  requested_by_email TEXT,

  -- Asserted by the clinic, verified by ClearKey. The distinction matters:
  -- §9 restores the waiver for "the same contracting legal entity and
  -- substantially the same participating veterinary practice", and an
  -- assertion is not a verification.
  claims_same_legal_entity INTEGER NOT NULL DEFAULT 0 CHECK (claims_same_legal_entity IN (0, 1)),
  claims_same_practice INTEGER NOT NULL DEFAULT 0 CHECK (claims_same_practice IN (0, 1)),
  verified_same_legal_entity INTEGER CHECK (verified_same_legal_entity IS NULL OR verified_same_legal_entity IN (0, 1)),
  verified_same_practice INTEGER CHECK (verified_same_practice IS NULL OR verified_same_practice IN (0, 1)),

  -- The §9 bars to restoration, each recorded on its own.
  bar_prior_cause INTEGER NOT NULL DEFAULT 0 CHECK (bar_prior_cause IN (0, 1)),
  bar_uncured_obligations INTEGER NOT NULL DEFAULT 0 CHECK (bar_uncured_obligations IN (0, 1)),
  bar_circumvention_or_misuse INTEGER NOT NULL DEFAULT 0 CHECK (bar_circumvention_or_misuse IN (0, 1)),
  bar_written_surrender INTEGER NOT NULL DEFAULT 0 CHECK (bar_written_surrender IN (0, 1)),

  status TEXT NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN (
    'SUBMITTED', 'IN_REVIEW', 'APPROVED', 'DECLINED', 'WITHDRAWN'
  )),
  founding_restored INTEGER NOT NULL DEFAULT 0 CHECK (founding_restored IN (0, 1)),
  founding_decision_note TEXT,
  -- §28: after Cause, "any restoration of Founding Clinic status must be
  -- express and in writing." This is that writing.
  express_written_restoration_document_id TEXT,

  decided_at TEXT,
  decided_by TEXT,
  decision_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_clinic_rejoin_requests_tenant
  ON clinic_rejoin_requests(tenant_id, status);

-- ────────────────────────────────────────────────── clinic lifecycle ──
--
-- Addendum §13's nine states, one row per clinic, plus an append-only event
-- log beside it. The row is a cache of the log's newest entry; the log is the
-- record.
--
-- The state that carries the most weight here is TEMPORARILY_INACTIVE. It is
-- what a clinic that missed six calls, closed for a remodel, or lost two
-- techs actually is — still contracted, no referrals — and having it as a
-- first-class state is what stops "unresponsive" from being filed as
-- "separated" by a background job with good intentions.
CREATE TABLE IF NOT EXISTS clinic_lifecycle (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  contract_id TEXT REFERENCES clinic_contracts(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'PENDING_CONTRACT' CHECK (status IN (
    'PENDING_CONTRACT',
    'PENDING_ONBOARDING',
    'ACTIVE',
    'TEMPORARILY_INACTIVE',
    'SUSPENDED',
    'VOLUNTARY_SEPARATION_PENDING',
    'SEPARATED',
    'TERMINATED_FOR_CAUSE',
    'REJOIN_REVIEW'
  )),
  reason TEXT,
  -- SUSPENDED is §26: temporary, and expressly "not necessarily a termination
  -- or permanent Separation", which is why it has its own reason column and
  -- no effect on the founding tables.
  suspension_reason TEXT,
  termination_reason TEXT,
  terminated_for_cause INTEGER NOT NULL DEFAULT 0 CHECK (terminated_for_cause IN (0, 1)),
  effective_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- For VOLUNTARY_SEPARATION_PENDING: notice received, effective date ahead.
  separation_effective_at TEXT,
  active_for_referrals INTEGER NOT NULL DEFAULT 0 CHECK (active_for_referrals IN (0, 1)),
  last_admin_review_at TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Only one state means terminated for Cause. Anything else claiming the
  -- flag would let a routine deactivation carry a Cause finding forward into
  -- a rejoin review.
  CHECK ((terminated_for_cause = 1) = (status = 'TERMINATED_FOR_CAUSE')),
  -- Referrals flow in exactly one state.
  CHECK ((active_for_referrals = 1) = (status = 'ACTIVE'))
);

CREATE TABLE IF NOT EXISTS clinic_lifecycle_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,
  -- What prompted it: ADMIN | CLINIC_NOTICE | RISK_REVIEW | ONBOARDING |
  -- REJOIN | SYSTEM. Never IVR silence; see the CHECK below.
  trigger_source TEXT NOT NULL DEFAULT 'ADMIN',
  separation_event_id TEXT REFERENCES clinic_separation_events(id) ON DELETE SET NULL,
  rejoin_request_id TEXT REFERENCES clinic_rejoin_requests(id) ON DELETE SET NULL,
  effective_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  recorded_by TEXT,
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Contract §27: "Mere failure to respond to requests, seasonal closure,
  -- staffing shortage, or temporary inactivity does not automatically
  -- constitute termination." Unanswered calls may explain a move to
  -- TEMPORARILY_INACTIVE; they may never be the stated basis for separating
  -- or terminating a clinic. Enforced here so no future caller can do it by
  -- passing a string.
  CHECK (
    trigger_source <> 'MISSED_CALLS'
    OR to_status IN ('TEMPORARILY_INACTIVE', 'ACTIVE')
  )
);

CREATE INDEX IF NOT EXISTS idx_clinic_lifecycle_events_tenant
  ON clinic_lifecycle_events(tenant_id, datetime(effective_at));

-- ───────────────────── founding fields on the existing pricing assignment ──
--
-- `clinic_pricing_assignments` (migration 0013) already decides what a clinic
-- pays, and `clinicFeeFor` in src/pricing.js already reads it. Addendum §11's
-- admin fields are added *to that table* rather than to a parallel one: two
-- tables that both claim to know whether a clinic is founding is exactly how
-- a clinic gets billed $25 by the half of the system that lost the argument.
--
-- These columns are administrative provenance. The money still resolves
-- through plan + good_standing, unchanged.
ALTER TABLE clinic_pricing_assignments ADD COLUMN founding_status TEXT NOT NULL DEFAULT 'NOT_APPLICABLE'
  CHECK (founding_status IN (
    'NOT_APPLICABLE', 'ACTIVE', 'TEMPORARILY_INACTIVE', 'SEPARATED_ELIGIBLE_TO_RESTORE', 'REVOKED_FOR_CAUSE'
  ));
ALTER TABLE clinic_pricing_assignments ADD COLUMN founding_granted_at TEXT;
ALTER TABLE clinic_pricing_assignments ADD COLUMN founding_granted_by TEXT;
ALTER TABLE clinic_pricing_assignments ADD COLUMN founding_rejoin_eligible INTEGER NOT NULL DEFAULT 1
  CHECK (founding_rejoin_eligible IN (0, 1));
ALTER TABLE clinic_pricing_assignments ADD COLUMN founding_revoked_at TEXT;
ALTER TABLE clinic_pricing_assignments ADD COLUMN founding_revocation_reason TEXT;
-- The signed writing a price points at. §11: pricing must resolve through
-- centralized policy, and a rate nobody can produce a document for is a rate
-- nobody can defend.
ALTER TABLE clinic_pricing_assignments ADD COLUMN pricing_source_document_id TEXT;
ALTER TABLE clinic_pricing_assignments ADD COLUMN pricing_effective_at TEXT;

-- Existing FOUNDING clinics predate these columns. Backfill their status from
-- the plan they already carry so nothing reads NOT_APPLICABLE for a practice
-- that has been paying $0 since launch.
UPDATE clinic_pricing_assignments
   SET founding_status = CASE WHEN good_standing = 1 THEN 'ACTIVE' ELSE 'TEMPORARILY_INACTIVE' END,
       founding_granted_at = COALESCE(founding_granted_at, assigned_at),
       founding_granted_by = COALESCE(founding_granted_by, assigned_by)
 WHERE plan = 'FOUNDING';

CREATE INDEX IF NOT EXISTS idx_clinic_pricing_assignments_founding
  ON clinic_pricing_assignments(founding_status);
