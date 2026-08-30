PRAGMA foreign_keys = ON;

-- ─────────────────────────────────────────────────────── pricing policy ──
--
-- Tími's own prices, versioned and stored in whole cents. Previously two
-- constants in src/catalog.js, which meant changing a price meant a deploy
-- and left no record of what a booking was actually quoted at the time.
--
-- Every completed booking captures the policy id it was priced under, so a
-- price change is prospective by construction: historical bookings keep
-- reporting what their owner and clinic were actually told.
CREATE TABLE IF NOT EXISTS pricing_policies (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE,
  -- What the pet owner pays Tími for a completed connection.
  owner_fee_cents INTEGER NOT NULL CHECK (owner_fee_cents >= 0),
  -- What a standard participating clinic pays Tími for a completed
  -- connection. Founding clinics pay 0 via clinic_pricing_assignments.
  clinic_fee_cents INTEGER NOT NULL CHECK (clinic_fee_cents >= 0),
  -- Tími's own contribution toward a sponsored connection. Never cash taken
  -- from the restricted fund — a reporting/unit-economics measure only.
  timi_match_cents INTEGER NOT NULL CHECK (timi_match_cents >= 0),
  -- Contribution limits, in cents.
  min_booking_contribution_cents INTEGER NOT NULL DEFAULT 100,
  min_standalone_contribution_cents INTEGER NOT NULL DEFAULT 1000,
  max_booking_contribution_cents INTEGER NOT NULL DEFAULT 500000,
  max_standalone_contribution_cents INTEGER NOT NULL DEFAULT 2500000,
  currency TEXT NOT NULL DEFAULT 'usd',
  effective_from TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Exactly one row may be active. Enforced by the partial index below.
  active INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One active policy, ever. Without this a second "active" row makes pricing
-- depend on row order, which is how two customers get quoted differently on
-- the same afternoon.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pricing_policies_one_active
  ON pricing_policies(active) WHERE active = 1;

-- The launch policy: $20 owner, $25 clinic, $10 Tími match, leaving $35 as
-- the community fund's share of a sponsored connection.
INSERT OR IGNORE INTO pricing_policies (
  id, version, owner_fee_cents, clinic_fee_cents, timi_match_cents, active, note
) VALUES (
  'pricing_v1', 1, 2000, 2500, 1000, 1,
  'Launch pricing: $20 owner, $25 clinic, $10 Tími match, $35 community share.'
);

-- Which price a clinic actually pays. Absent a row, a clinic is STANDARD.
CREATE TABLE IF NOT EXISTS clinic_pricing_assignments (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  -- FOUNDING is a permanent $0 clinic-side rate for the earliest partners,
  -- conditional on good standing under the clinic agreement. CUSTOM carries
  -- its own cents and a contract reference.
  plan TEXT NOT NULL DEFAULT 'STANDARD' CHECK (plan IN ('STANDARD', 'FOUNDING', 'CUSTOM')),
  custom_fee_cents INTEGER CHECK (custom_fee_cents IS NULL OR custom_fee_cents >= 0),
  contract_id TEXT,
  -- Good standing gates the founding rate. A clinic out of good standing
  -- reverts to the standard fee prospectively; historical bookings keep the
  -- price they were billed at.
  good_standing INTEGER NOT NULL DEFAULT 1,
  standing_note TEXT,
  assigned_by TEXT,
  assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- A CUSTOM plan without an amount would silently price at the standard
  -- fee, which is the opposite of what "custom" means.
  CHECK (plan <> 'CUSTOM' OR custom_fee_cents IS NOT NULL)
);

-- ────────────────────────────────────────────── payment orders/allocations ──
--
-- One customer payment, several internal purposes. A $20 owner fee with a $2
-- contribution is one $22 Stripe PaymentIntent and two allocations; the
-- allocations, not the charge amount, decide what the money means.
--
-- Allocations are written before confirmation and never mutated: inferring a
-- split from a total after the fact is how a $2 contribution silently becomes
-- $1.83 of contribution and $0.17 of guesswork.
CREATE TABLE IF NOT EXISTS payment_orders (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('BOOKING', 'FUND_CONTRIBUTION_ONLY', 'CLINIC_INVOICE')),
  payer_user_id TEXT,
  -- Set for a guest contribution: a pseudonymous id, linkable to an account
  -- later without rewriting history.
  payer_contributor_id TEXT,
  intake_id TEXT REFERENCES intake_requests(id) ON DELETE SET NULL,
  search_id TEXT REFERENCES care_searches(id) ON DELETE SET NULL,
  tenant_id TEXT REFERENCES tenants(id),
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
    'DRAFT', 'REQUIRES_CONFIRMATION', 'AUTHORIZED', 'PAID',
    'FAILED', 'CANCELLED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED'
  )),
  stripe_payment_intent_id TEXT UNIQUE,
  stripe_checkout_session_id TEXT UNIQUE,
  stripe_customer_id TEXT,
  -- What the payer was actually shown before pressing confirm, frozen. A
  -- receipt argument six months later is settled by this, not by re-deriving
  -- today's prices.
  confirmation_snapshot_json TEXT NOT NULL DEFAULT '{}',
  pricing_policy_id TEXT REFERENCES pricing_policies(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_payment_orders_intake ON payment_orders(intake_id);
CREATE INDEX IF NOT EXISTS idx_payment_orders_status ON payment_orders(status, created_at);

CREATE TABLE IF NOT EXISTS payment_allocations (
  id TEXT PRIMARY KEY,
  payment_order_id TEXT NOT NULL REFERENCES payment_orders(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN (
    'OWNER_PLATFORM_FEE',
    'CLINIC_PLATFORM_FEE',
    'CLINIC_DEPOSIT',
    'FUND_CONTRIBUTION'
  )),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'usd',
  contribution_id TEXT,
  refunded_cents INTEGER NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  disputed_cents INTEGER NOT NULL DEFAULT 0 CHECK (disputed_cents >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Refunding more of an allocation than it ever held is always a bug, and
  -- one that would quietly make the fund ledger negative.
  CHECK (refunded_cents <= amount_cents)
);

CREATE INDEX IF NOT EXISTS idx_payment_allocations_order ON payment_allocations(payment_order_id);

-- ───────────────────────────────────────────── double-entry subledger ──
--
-- The source of truth for what the fund holds. Deliberately not a balance
-- column: a mutable counter cannot be audited, cannot be rebuilt, and gives
-- no answer to "how did it get to this number".
--
-- Every fund figure Tími reports — available, reserved, consumed — is a sum
-- over ledger_entries. Cached projections are permitted, but they are
-- projections, and this table is what they are rebuilt from.
CREATE TABLE IF NOT EXISTS ledger_accounts (
  code TEXT PRIMARY KEY,
  class TEXT NOT NULL CHECK (class IN ('ASSET', 'LIABILITY', 'REVENUE', 'EXPENSE', 'EQUITY')),
  -- 'debit' or 'credit': which direction increases this account. Stored so
  -- balance queries do not need a hard-coded sign table in application code.
  normal_balance TEXT NOT NULL CHECK (normal_balance IN ('debit', 'credit')),
  -- Restricted accounts hold money that is not Tími's to spend: contributions
  -- awaiting a qualifying sponsored connection, and clinic deposits.
  restricted INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO ledger_accounts (code, class, normal_balance, restricted, description) VALUES
  ('processor_cash',            'ASSET',     'debit',  0, 'Money held at the payment processor.'),
  ('processor_receivable',      'ASSET',     'debit',  0, 'Charged but not yet settled by the processor.'),
  ('clinic_fee_receivable',     'ASSET',     'debit',  0, 'Clinic platform fees earned and not yet collected.'),
  ('fund_available',            'LIABILITY', 'credit', 1, 'Paw It Forward contributions available to reserve.'),
  ('fund_reserved',             'LIABILITY', 'credit', 1, 'Reserved against an approved sponsored booking, not yet consumed.'),
  ('contribution_refunds_payable', 'LIABILITY', 'credit', 1, 'Contribution refunds owed but not yet paid.'),
  ('clinic_payable',            'LIABILITY', 'credit', 1, 'Clinic deposits and clinic share held for the clinic.'),
  ('platform_fees_unearned',    'LIABILITY', 'credit', 0, 'Owner fees collected before the connection is completed.'),
  ('owner_platform_fee_revenue','REVENUE',   'credit', 0, 'Owner platform fees earned on completed connections.'),
  ('clinic_platform_fee_revenue','REVENUE',  'credit', 0, 'Clinic platform fees earned on completed connections.'),
  ('sponsored_access_revenue',  'REVENUE',   'credit', 0, 'Fund money earned as revenue on completed sponsored connections.'),
  ('processor_fee_expense',     'EXPENSE',   'debit',  0, 'Processor fees, borne by Tími and never by a contribution.'),
  ('timinow_program_match',     'EXPENSE',   'debit',  0, 'Tími''s own contribution toward sponsored connections. Non-cash reporting measure.');

CREATE TABLE IF NOT EXISTS ledger_transactions (
  id TEXT PRIMARY KEY,
  -- Why this journal entry exists, in business language.
  kind TEXT NOT NULL CHECK (kind IN (
    'contribution_posted',
    'contribution_refunded',
    'owner_fee_collected',
    'owner_fee_earned',
    'clinic_fee_earned',
    'clinic_fee_collected',
    'clinic_deposit_collected',
    'clinic_deposit_refunded',
    'sponsorship_reserved',
    'sponsorship_released',
    'sponsorship_consumed',
    'sponsorship_reversed',
    'processor_fee',
    'dispute_opened',
    'dispute_resolved',
    'adjustment'
  )),
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  currency TEXT NOT NULL DEFAULT 'usd',
  -- Immutable references back to whatever caused this.
  payment_order_id TEXT REFERENCES payment_orders(id),
  contribution_id TEXT,
  reservation_id TEXT,
  intake_id TEXT REFERENCES intake_requests(id),
  tenant_id TEXT REFERENCES tenants(id),
  stripe_event_id TEXT,
  -- Idempotency: the natural key of the business event this journal records.
  -- A redelivered webhook computes the same key and the INSERT is ignored,
  -- so revenue cannot be recognized twice.
  idempotency_key TEXT NOT NULL UNIQUE,
  memo TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ledger_transactions_kind ON ledger_transactions(kind, occurred_at);
CREATE INDEX IF NOT EXISTS idx_ledger_transactions_order ON ledger_transactions(payment_order_id);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES ledger_transactions(id) ON DELETE CASCADE,
  account_code TEXT NOT NULL REFERENCES ledger_accounts(code),
  -- Exactly one of these is non-zero. Two columns rather than a signed
  -- amount, because a debit of -35 and a credit of 35 read identically in a
  -- query and mean opposite things to an accountant.
  debit_cents INTEGER NOT NULL DEFAULT 0 CHECK (debit_cents >= 0),
  credit_cents INTEGER NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'usd',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((debit_cents > 0 AND credit_cents = 0) OR (credit_cents > 0 AND debit_cents = 0))
);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_transaction ON ledger_entries(transaction_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_account ON ledger_entries(account_code);

-- ───────────────────────────────────────────────── stripe event dedupe ──
--
-- Separate from the existing stripe_events table, which serves the deposit
-- flow. Webhooks arrive more than once and out of order; both facts must be
-- survivable rather than merely unlikely.
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  stripe_event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  object_id TEXT,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processing', 'processed', 'failed', 'ignored')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_status ON stripe_webhook_events(status, received_at);

-- ───────────────────────────────────────────────────────── audit trail ──
--
-- Append-only. Every policy publish, pricing assignment, manual ledger
-- adjustment, and hardship override lands here with who did it and why.
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actor_id TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT,
  old_state_json TEXT,
  new_state_json TEXT,
  reason TEXT,
  request_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_events_subject ON audit_events(subject_type, subject_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor_id, occurred_at);
