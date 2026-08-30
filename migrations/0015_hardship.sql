PRAGMA foreign_keys = ON;

-- ══════════════════════════════════════════════════ the hardship engine ══
--
-- Everything a hardship decision touches, kept apart from the rest of the
-- product on purpose. A person asking for help with a $20 fee hands over the
-- most sensitive documents TímiNOW will ever hold — a termination letter, a
-- benefit award, a hospital bill — and those rows must never be reachable
-- from an ordinary support query, a clinic view, or an analytics job.
--
-- Three rules shape the schema:
--
--   1. No document content, ever. `eligibility_evidence` stores a reference
--      to an encrypted private object and a hash. The bytes live in object
--      storage behind short-lived signed URLs, and D1 never sees them.
--
--   2. Facts outlive documents. `evidence_facts` holds the handful of
--      normalized values the rules actually consumed. The retention job
--      deletes originals on `retention_deadline` and the decision stays
--      explainable, which is what lets retention be short.
--
--   3. Decisions are immutable. A decision row records the rule version, the
--      facts used, the reason codes, and a snapshot explanation. Re-running
--      the engine writes a new row; a later human review writes a new grant.
--      Nothing here is ever updated to make history agree with the present.

-- ─────────────────────────────────────────────────────── applications ──
--
-- The lifecycle. DRAFT while the applicant chooses a pathway and uploads,
-- VERIFYING while extraction runs, then a terminal APPROVED or NOT_VERIFIED.
--
-- The two extra states are not decisions:
--   TECHNICAL_RETRY  a provider failed. The applicant is asked to try again;
--                    a vendor outage is not a finding about their finances.
--   SECURITY_HOLD    internal. The applicant sees neutral pending language and
--                    is never told a hold exists, never shown a score, and
--                    never accused of anything.
CREATE TABLE IF NOT EXISTS eligibility_applications (
  id TEXT PRIMARY KEY,
  applicant_user_id TEXT NOT NULL,
  -- The verified-identity key from the identity provider, hashed. Rate limits
  -- and abuse linkage hang off this rather than off an email address, because
  -- a new email address costs nothing and a new verified identity does not.
  identity_key TEXT,
  identity_session_id TEXT,
  identity_provider TEXT,
  identity_verified INTEGER NOT NULL DEFAULT 0,
  identity_confidence TEXT,
  -- Which branch the applicant chose in the UI. Advisory: the engine still
  -- runs every enabled pathway in policy order.
  selected_pathway TEXT,
  state TEXT NOT NULL DEFAULT 'DRAFT' CHECK (state IN (
    'DRAFT', 'VERIFYING', 'APPROVED', 'NOT_VERIFIED', 'TECHNICAL_RETRY', 'SECURITY_HOLD', 'ABANDONED'
  )),
  -- Household facts, collected only when the chosen pathway needs them.
  household_size INTEGER CHECK (household_size IS NULL OR household_size >= 1),
  household_attested INTEGER NOT NULL DEFAULT 0,
  -- Coarse geography only — county or metro, never a street address, and the
  -- dataset release is stored so the threshold can be re-derived on appeal.
  geography_area_id TEXT,
  geography_dataset_version TEXT,
  geography_area_index REAL,
  -- Versions the applicant actually agreed to, frozen at submission.
  terms_version TEXT,
  attestation_version TEXT,
  attested_at TEXT,
  -- What this application is for. Assistance binds to a person, a pet, and a
  -- booking; there is no transferable balance anywhere in this schema.
  intake_id TEXT REFERENCES intake_requests(id) ON DELETE SET NULL,
  pet_id TEXT,
  policy_id TEXT,
  policy_version INTEGER,
  submitted_at TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_eligibility_applications_user ON eligibility_applications(applicant_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_eligibility_applications_identity ON eligibility_applications(identity_key, created_at);
CREATE INDEX IF NOT EXISTS idx_eligibility_applications_state ON eligibility_applications(state, updated_at);

-- ────────────────────────────────────────────────────────── evidence ──
--
-- A reference, a hash, and a deletion date. Nothing else.
--
-- `content_sha256` is what detects the same invoice arriving under three
-- accounts. It survives the deletion of the object it describes, which is the
-- only way document-reuse detection and short retention can both be true.
CREATE TABLE IF NOT EXISTS eligibility_evidence (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES eligibility_applications(id) ON DELETE CASCADE,
  evidence_type TEXT NOT NULL,
  -- Private object storage: bucket plus key. Never a public URL, never bytes,
  -- and never a signed URL at rest — those are minted per read and expire.
  storage_bucket TEXT NOT NULL,
  storage_object_ref TEXT NOT NULL,
  encryption_key_id TEXT,
  content_sha256 TEXT NOT NULL,
  mime_type TEXT,
  byte_size INTEGER CHECK (byte_size IS NULL OR byte_size >= 0),
  page_count INTEGER,
  extraction_state TEXT NOT NULL DEFAULT 'PENDING' CHECK (extraction_state IN (
    'PENDING', 'EXTRACTING', 'EXTRACTED', 'FAILED', 'REJECTED'
  )),
  extraction_provider TEXT,
  extraction_confidence REAL,
  -- The provider's authenticity signal. Consumed by the policy's evidence
  -- gate; never shown to the applicant in any form.
  tamper_risk TEXT CHECK (tamper_risk IS NULL OR tamper_risk IN ('LOW', 'MEDIUM', 'HIGH', 'UNKNOWN')),
  malware_scan_state TEXT,
  -- The date the retention job deletes or redacts the underlying object. Set
  -- at upload from the policy's retention settings, never extended silently.
  retention_deadline TEXT NOT NULL,
  redacted_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_eligibility_evidence_application ON eligibility_evidence(application_id);
CREATE INDEX IF NOT EXISTS idx_eligibility_evidence_retention ON eligibility_evidence(retention_deadline) WHERE deleted_at IS NULL;
-- Reuse detection across applications. Deliberately not unique: the same
-- person legitimately re-uploads their own invoice on an appeal.
CREATE INDEX IF NOT EXISTS idx_eligibility_evidence_hash ON eligibility_evidence(content_sha256);

-- ───────────────────────────────────────────────────── evidence facts ──
--
-- The normalized minimum the rules consumed, one row per fact path. Small on
-- purpose: a full name and a date are facts; a benefit case number, an SSN,
-- and a diagnosis are not, and none of them belong here.
--
-- `source` distinguishes a machine reading from a correction the applicant
-- made. Applicants may correct non-decision facts (a misread street name);
-- they may not edit the figure a rule turns on, which is why the column
-- exists and why it is audited.
CREATE TABLE IF NOT EXISTS evidence_facts (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES eligibility_applications(id) ON DELETE CASCADE,
  evidence_id TEXT REFERENCES eligibility_evidence(id) ON DELETE SET NULL,
  fact_path TEXT NOT NULL,
  fact_value_json TEXT NOT NULL,
  confidence REAL,
  source TEXT NOT NULL DEFAULT 'EXTRACTION' CHECK (source IN ('EXTRACTION', 'APPLICANT', 'PROVIDER', 'POLICY')),
  decision_relevant INTEGER NOT NULL DEFAULT 1,
  corrected_at TEXT,
  corrected_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (application_id, fact_path)
);

CREATE INDEX IF NOT EXISTS idx_evidence_facts_application ON evidence_facts(application_id);

-- ──────────────────────────────────────────────────────── decisions ──
--
-- Append-only. One row per evaluation, carrying everything needed to re-run
-- it: the policy id and version, the engine version, the fact paths used, the
-- machine-readable reason codes, and a snapshot explanation of the numbers.
--
-- `explanation_json` holds codes and figures, never prose. A free-form
-- rationale stored as the basis of a decision is exactly what spec §9.1
-- prohibits — it reads like an explanation while being unreviewable.
CREATE TABLE IF NOT EXISTS eligibility_decisions (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES eligibility_applications(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('APPROVED', 'NOT_VERIFIED')),
  pathway TEXT,
  policy_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  engine_version TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  -- Null on a denial. Both are set on approval: eligibility is a period *and*
  -- a count, and whichever runs out first ends it.
  expires_at TEXT,
  sponsored_visit_limit INTEGER CHECK (sponsored_visit_limit IS NULL OR sponsored_visit_limit >= 0),
  reason_codes_json TEXT NOT NULL DEFAULT '[]',
  evidence_facts_json TEXT NOT NULL DEFAULT '[]',
  evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  explanation_json TEXT NOT NULL DEFAULT '{}',
  -- Set when a later decision or a human appeal replaces this one. The row
  -- itself is never edited.
  superseded_by TEXT REFERENCES eligibility_decisions(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (decision <> 'APPROVED' OR pathway IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_eligibility_decisions_application ON eligibility_decisions(application_id, decided_at);
CREATE INDEX IF NOT EXISTS idx_eligibility_decisions_policy ON eligibility_decisions(policy_id, policy_version);

-- ─────────────────────────────────────────────── financial shock items ──
--
-- One row per invoice line, with the line's own disposition. An invoice is
-- not a verdict: the same repair order can carry a $2,600 transmission that
-- qualifies and $900 of alloy wheels that does not, and storing the invoice
-- total would destroy the only distinction that matters.
CREATE TABLE IF NOT EXISTS financial_shock_items (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES eligibility_applications(id) ON DELETE CASCADE,
  evidence_id TEXT REFERENCES eligibility_evidence(id) ON DELETE SET NULL,
  issuer TEXT,
  item_date TEXT NOT NULL,
  -- The controlled taxonomy code from policy.js — never a merchant name and
  -- never free text from the document.
  normalized_category TEXT,
  disposition TEXT NOT NULL CHECK (disposition IN ('QUALIFY', 'EXCLUDE', 'AMBIGUOUS', 'UNPROVEN', 'DUPLICATE')),
  disposition_code TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  -- What actually counted toward the threshold: the amount for a QUALIFY row,
  -- zero for everything else. Summing this column is the audit of a decision.
  qualifying_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (qualifying_amount_cents >= 0),
  purpose_proof TEXT,
  financial_proof TEXT,
  transaction_ref TEXT,
  extraction_confidence REAL,
  -- issuer + date + amount + line, hashed. Unique per application so one
  -- invoice cannot be counted twice in a single submission; indexed but not
  -- globally unique so the same line reappearing under a different identity
  -- raises a fraud signal instead of throwing a constraint error at a person
  -- who may simply be appealing.
  dedupe_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (application_id, dedupe_hash),
  CHECK (qualifying_amount_cents = 0 OR disposition = 'QUALIFY')
);

CREATE INDEX IF NOT EXISTS idx_financial_shock_items_application ON financial_shock_items(application_id);
CREATE INDEX IF NOT EXISTS idx_financial_shock_items_dedupe ON financial_shock_items(dedupe_hash);

-- ────────────────────────────────────────────────────────────── grants ──
--
-- What an approval actually confers: a period, a visit count, and a binding
-- to one verified identity. Not a wallet, not a balance, and not cash — a
-- grant can only ever suppress a fee on a booking made by its own applicant.
--
-- Approval moves no fund money. The $35 reservation happens when the assisted
-- booking is confirmed, in the fund's own tables; this row only says the
-- applicant is entitled to ask for one.
CREATE TABLE IF NOT EXISTS eligibility_grants (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES eligibility_decisions(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL REFERENCES eligibility_applications(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  identity_key TEXT,
  state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'CONSUMED', 'EXPIRED', 'REVOKED')),
  granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  sponsored_visit_limit INTEGER NOT NULL DEFAULT 1 CHECK (sponsored_visit_limit >= 0),
  sponsored_visits_used INTEGER NOT NULL DEFAULT 0 CHECK (sponsored_visits_used >= 0),
  last_consumed_at TEXT,
  -- The fund migration owns reservations and sponsorships; referenced by id
  -- without a foreign key so the two migrations stay independent.
  last_reservation_id TEXT,
  intake_id TEXT REFERENCES intake_requests(id) ON DELETE SET NULL,
  -- A revocation is prospective. It never claws back a completed sponsored
  -- visit and never bills a previously sponsored owner retroactively.
  revoked_at TEXT,
  revoked_reason TEXT,
  source TEXT NOT NULL DEFAULT 'AUTOMATED' CHECK (source IN ('AUTOMATED', 'HUMAN_APPEAL', 'SUPPORT_OVERRIDE')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (sponsored_visits_used <= sponsored_visit_limit)
);

-- One live grant per person. Two active grants is how one household quietly
-- gets two sponsored visits in a window that allows one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_eligibility_grants_one_active_user
  ON eligibility_grants(user_id) WHERE state = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_eligibility_grants_identity ON eligibility_grants(identity_key, granted_at);
CREATE INDEX IF NOT EXISTS idx_eligibility_grants_expiry ON eligibility_grants(expires_at) WHERE state = 'ACTIVE';

-- ────────────────────────────────────────────── per-identity rate limit ──
--
-- The default is one sponsored *completed* connection per rolling 12 months.
-- Completed, not approved: an approval that never becomes a visit consumes
-- nothing and must not burn somebody's year.
--
-- Configurable per identity because the policy will need exceptions — a
-- rescue with many animals, a documented catastrophe — and those must be
-- explicit, audited rows rather than someone editing a constant.
CREATE TABLE IF NOT EXISTS eligibility_rate_limits (
  identity_key TEXT PRIMARY KEY,
  user_id TEXT,
  window_days INTEGER NOT NULL DEFAULT 365 CHECK (window_days > 0),
  max_sponsored_connections INTEGER NOT NULL DEFAULT 1 CHECK (max_sponsored_connections >= 0),
  sponsored_connections_used INTEGER NOT NULL DEFAULT 0 CHECK (sponsored_connections_used >= 0),
  window_started_at TEXT,
  last_completed_at TEXT,
  override_reason TEXT,
  override_by TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_eligibility_rate_limits_user ON eligibility_rate_limits(user_id);

-- ──────────────────────────────────────────────────────── fraud signals ──
--
-- One-way and internal. Nothing in this table is ever shown to an applicant,
-- returned by an API a client can reach, or written into a denial. A signal
-- is an observation — this document hash appeared under two identities — not
-- an accusation, and no single weak signal decides anything.
CREATE TABLE IF NOT EXISTS fraud_signals (
  id TEXT PRIMARY KEY,
  application_id TEXT REFERENCES eligibility_applications(id) ON DELETE SET NULL,
  identity_key TEXT,
  user_id TEXT,
  signal_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'LOW' CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH')),
  -- Structured detail only: hashes, counts, ids. Never document content, and
  -- never a model's narrative about a person.
  detail_json TEXT NOT NULL DEFAULT '{}',
  detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_by TEXT,
  reviewed_at TEXT,
  disposition TEXT CHECK (disposition IS NULL OR disposition IN ('CONFIRMED', 'DISMISSED', 'MONITOR'))
);

CREATE INDEX IF NOT EXISTS idx_fraud_signals_identity ON fraud_signals(identity_key, detected_at);
CREATE INDEX IF NOT EXISTS idx_fraud_signals_application ON fraud_signals(application_id);

-- ───────────────────────────────────────────────────────── human appeals ──
--
-- The route the denial copy promises. Asynchronous, and about future
-- bookings: the current booking proceeds at the standard fee either way, and
-- a reversal here never creates a retroactive refund unless support takes an
-- explicit, separately audited action.
CREATE TABLE IF NOT EXISTS human_appeals (
  id TEXT PRIMARY KEY,
  application_id TEXT REFERENCES eligibility_applications(id) ON DELETE SET NULL,
  decision_id TEXT REFERENCES eligibility_decisions(id) ON DELETE SET NULL,
  user_id TEXT,
  contact_email TEXT,
  state TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (state IN ('RECEIVED', 'IN_REVIEW', 'RESOLVED', 'WITHDRAWN')),
  submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewer_id TEXT,
  reviewed_at TEXT,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('FUTURE_ELIGIBILITY_GRANTED', 'UPHELD', 'MORE_EVIDENCE_REQUESTED')),
  -- What the reviewer considered and concluded, recorded for the audit and
  -- for the fairness review of the pathways themselves.
  reason TEXT,
  evidence_considered_json TEXT NOT NULL DEFAULT '[]',
  granted_grant_id TEXT REFERENCES eligibility_grants(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_human_appeals_state ON human_appeals(state, submitted_at);
CREATE INDEX IF NOT EXISTS idx_human_appeals_user ON human_appeals(user_id, submitted_at);
