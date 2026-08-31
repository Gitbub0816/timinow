PRAGMA foreign_keys = ON;

-- ═══════════════════════════════════════════ Paw It Forward custody ══
--
-- Addendum §5. A customer pays $22 in one charge. Twenty dollars of it is
-- ordinary ClearKey Solutions, LLC revenue; two dollars is Paw It Forward
-- money from the moment the allocation is created, while it is still sitting
-- in the Stripe Payments balance. This migration adds the tables that record
-- (a) the physical movement of that designated money into protected custody
-- and back out again, and (b) the daily proof that the two agree to the
-- penny.
--
-- The distinction this schema exists to keep honest:
--
--   designated in the ledger   fund_available + fund_reserved. True the
--                              instant the allocation is written.
--   physically protected       cash actually sitting in the Stripe Treasury
--                              financial account. True only after a sweep
--                              the rail confirmed.
--
-- The second is never inferred from the first. A deployment with no Treasury
-- rail keeps perfectly correct designation and reports zero protection —
-- it simply cannot claim the cash is safe, and §5/§28 say to fail closed
-- rather than pretend.
--
-- ─────────────────────────────────────────────── on ledger_transactions ──
--
-- 0013 fixes `ledger_transactions.kind` with a CHECK enumeration and SQLite
-- cannot widen a CHECK without rebuilding the table. Rebuilding a table that
-- other in-flight migrations also extend is how two correct migrations
-- destroy each other's work, so nothing here alters ledger_transactions at
-- all. Custody cash movements post under the existing `adjustment` kind, and
-- the §6 event type (CONTRIBUTION_SWEPT_TO_TREASURY,
-- SPONSORSHIP_TREASURY_RELEASED, DEPOSIT_GUARANTEE_FUNDED,
-- DEPOSIT_GUARANTEE_RETURNED, ...) lives on the custody transfer row below,
-- which also carries the provider references and links back to the journal
-- transaction it produced. When the ledger's kind vocabulary is widened
-- centrally, `pif_custody_transfers.event_type` is the column to copy from.

-- ─────────────────────────────────────────── where designated cash sits ──
--
-- Four new accounts, all of them cash *locations*. None of them changes what
-- the fund owes; they only say where the money that backs it physically is.
-- Three are restricted, which means ledgerIntegrity() refuses to let them go
-- negative: releasing more from custody than was ever swept into it is the
-- exact failure this program cannot survive quietly.
INSERT OR IGNORE INTO ledger_accounts (code, class, normal_balance, restricted, description) VALUES
  ('pif_custody_cash',            'ASSET',   'debit',  1,
   'Paw It Forward cash in protected custody (Stripe Treasury financial account). Never operating cash.'),
  ('pif_custody_in_transit',      'ASSET',   'debit',  1,
   'Designated cash that has left one side of a custody movement and not yet landed on the other. Settles to zero.'),
  ('clearkey_operating_cash',     'ASSET',   'debit',  0,
   'ClearKey Solutions, LLC external operating bank. Unrestricted.');

-- Guarantee cash sitting at a clinic already has an account: migration 0018
-- defines `deposit_guarantee_outstanding` for exactly that, and custody uses
-- it rather than minting a second one. Two accounts for one pile of money is
-- how a reconciliation identity stops being an identity. Repeated here as
-- INSERT OR IGNORE only so that the custody module still has somewhere to
-- post if 0018 has not been applied; where it has, 0018's row wins.
INSERT OR IGNORE INTO ledger_accounts (code, class, normal_balance, restricted, description) VALUES
  ('deposit_guarantee_outstanding', 'ASSET', 'debit', 0,
   'Program cash sitting at a clinic as an appointment deposit guarantee, expected back on attendance. An asset of the program, never a customer payment toward treatment.');

-- ──────────────────────────────────────────────── pif_custody_transfers ──
--
-- One row per attempted physical movement of designated cash. This table is
-- the reason a double sweep is not merely unlikely but unrepresentable:
--
--   * `idempotency_key` is UNIQUE, so the same logical attempt inserts once;
--   * the partial unique index below allows at most one *live* SWEEP per
--     contribution, so two concurrent workers cannot both claim the same $2;
--   * a FAILED row falls out of that index, so a sweep that failed closed
--     (no Treasury rail, rail rejected the movement) can be retried later
--     without ever being able to shadow a live one.
--
-- The row is written BEFORE the rail is called and only marked COMPLETED
-- when the rail says so. A row in PENDING/IN_TRANSIT is an honest "we do not
-- know yet"; nothing in this system is ever marked swept because a request
-- was sent.
CREATE TABLE IF NOT EXISTS pif_custody_transfers (
  id TEXT PRIMARY KEY,

  -- SWEEP             Payments balance -> protected custody
  -- RELEASE           protected custody -> ClearKey operating (earned sponsorship only)
  -- GUARANTEE_FUNDING protected custody -> clinic (appointment deposit guarantee)
  -- GUARANTEE_RETURN  clinic -> protected custody
  direction TEXT NOT NULL CHECK (direction IN ('SWEEP', 'RELEASE', 'GUARANTEE_FUNDING', 'GUARANTEE_RETURN')),

  -- The §6 event type this movement records. Kept here rather than on
  -- ledger_transactions.kind — see the note at the top of this file.
  event_type TEXT NOT NULL CHECK (event_type IN (
    'CONTRIBUTION_SWEPT_TO_TREASURY',
    'SPONSORSHIP_TREASURY_RELEASED',
    'DEPOSIT_GUARANTEE_FUNDED',
    'DEPOSIT_GUARANTEE_RETURNED'
  )),

  -- Integer minor units and an ISO currency, always (§23). The amount is the
  -- exact designated figure derived from the ledger, never a percentage of a
  -- balance: see src/fund-custody.js.
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'usd',

  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN (
    'PENDING',     -- claimed, rail not yet called
    'IN_TRANSIT',  -- rail accepted it, settlement not yet confirmed
    'COMPLETED',   -- rail confirmed; the second ledger leg has posted
    'FAILED',      -- rail refused or was unavailable; no cash moved
    'CANCELED'
  )),

  -- Which custody implementation ran this: 'stripe_treasury', 'stub', or
  -- 'none' for a deployment with no rail at all.
  provider TEXT NOT NULL,
  -- The rail's own object (payout, outbound payment, inbound transfer).
  provider_object_id TEXT,
  -- The Treasury financial account, or whatever the provider's custody
  -- container is called.
  provider_reference TEXT,
  provider_status TEXT,

  -- What this movement is about. contribution_id/reservation_id are real
  -- foreign keys; guarantee_id deliberately is not, because
  -- pif_deposit_guarantees arrives in a parallel migration and this table
  -- must be creatable before it exists.
  contribution_id TEXT REFERENCES contributions(id) ON DELETE SET NULL,
  reservation_id TEXT REFERENCES fund_reservations(id) ON DELETE SET NULL,
  sponsorship_id TEXT REFERENCES sponsorships(id) ON DELETE SET NULL,
  guarantee_id TEXT,

  -- The journal transaction that recorded the first leg, and the one that
  -- recorded settlement. Both are ordinary balanced ledger transactions.
  initiated_transaction_id TEXT REFERENCES ledger_transactions(id),
  settled_transaction_id TEXT REFERENCES ledger_transactions(id),

  -- Derived from the business event, never from the request. Retrying an
  -- attempt recomputes the same key and inserts nothing.
  idempotency_key TEXT NOT NULL UNIQUE,
  -- Which retry this is for its subject. A failed attempt does not consume
  -- the subject; it consumes one attempt number.
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),

  error_code TEXT,
  error TEXT,
  requested_by TEXT,

  requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  settled_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- A movement that succeeded must say when, and one that failed must say
  -- why. "COMPLETED, reason unknown" is not a state this table can hold.
  CHECK (state <> 'COMPLETED' OR settled_at IS NOT NULL),
  CHECK (state <> 'FAILED' OR error_code IS NOT NULL),
  -- A sweep is always about one contribution; without that link the worker
  -- could sweep a lump sum, which is precisely what §5 forbids.
  CHECK (direction <> 'SWEEP' OR contribution_id IS NOT NULL)
);

-- ══ THE constraint ══
--
-- At most one live sweep per contribution. Acceptance test 5: a retry, a
-- second cron tick, or two workers racing cannot move the same designated $2
-- twice, because the database refuses the second row rather than trusting
-- every future call site to have checked first. FAILED attempts are excluded
-- so a fail-closed sweep is retryable once the rail comes back.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pif_custody_transfers_live_sweep
  ON pif_custody_transfers(contribution_id)
  WHERE direction = 'SWEEP' AND state <> 'FAILED';

-- The same guarantee for the other three directions: one live release per
-- sponsorship, one live funding and one live return per guarantee.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pif_custody_transfers_live_release
  ON pif_custody_transfers(reservation_id)
  WHERE direction = 'RELEASE' AND state <> 'FAILED';
CREATE UNIQUE INDEX IF NOT EXISTS idx_pif_custody_transfers_live_guarantee
  ON pif_custody_transfers(guarantee_id, direction)
  WHERE guarantee_id IS NOT NULL AND state <> 'FAILED';

CREATE INDEX IF NOT EXISTS idx_pif_custody_transfers_state
  ON pif_custody_transfers(state, direction, requested_at);
CREATE INDEX IF NOT EXISTS idx_pif_custody_transfers_provider_object
  ON pif_custody_transfers(provider_object_id);

-- ────────────────────────────────────────────── pif_reconciliation_runs ──
--
-- §21. One row per reconciliation pass, holding every component that went
-- into the arithmetic. Storing the components rather than only the verdict
-- is the difference between "the fund was short a penny on the 3rd" and an
-- investigator being able to say which of nine numbers moved.
CREATE TABLE IF NOT EXISTS pif_reconciliation_runs (
  id TEXT PRIMARY KEY,
  -- Makes a daily run idempotent: 'daily:2026-08-31' inserts once however
  -- many times the cron fires.
  run_key TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL DEFAULT 'DAILY' CHECK (scope IN ('DAILY', 'MANUAL', 'BACKFILL')),
  currency TEXT NOT NULL DEFAULT 'usd',

  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN (
    'RUNNING', 'OK', 'EXCEPTIONS_RAISED', 'FAILED'
  )),
  -- STRIPE_TREASURY: cash is genuinely in protected custody.
  -- STUB:            a deterministic custody rail, for tests and previews.
  -- NONE:            no Treasury rail on this account. Designation is still
  --                  exact; protection is honestly reported as zero.
  custody_mode TEXT NOT NULL DEFAULT 'NONE' CHECK (custody_mode IN ('STRIPE_TREASURY', 'STUB', 'NONE')),
  provider TEXT,
  custody_protected INTEGER NOT NULL DEFAULT 0 CHECK (custody_protected IN (0, 1)),

  -- The headline comparison (§21).
  expected_custody_cents INTEGER NOT NULL DEFAULT 0,
  actual_custody_cents INTEGER NOT NULL DEFAULT 0,
  difference_cents INTEGER NOT NULL DEFAULT 0,

  -- Every component of the identity, so the arithmetic is reproducible.
  fund_available_cents INTEGER NOT NULL DEFAULT 0,
  fund_reserved_cents INTEGER NOT NULL DEFAULT 0,
  guarantee_obligation_cents INTEGER NOT NULL DEFAULT 0,
  earned_not_released_cents INTEGER NOT NULL DEFAULT 0,
  designated_in_payments_cents INTEGER NOT NULL DEFAULT 0,
  in_transit_cents INTEGER NOT NULL DEFAULT 0,
  guarantee_cash_at_clinic_cents INTEGER NOT NULL DEFAULT 0,
  ledger_custody_cents INTEGER NOT NULL DEFAULT 0,
  transfer_journal_cents INTEGER NOT NULL DEFAULT 0,
  unsettled_cents INTEGER NOT NULL DEFAULT 0,
  available_to_sweep_cents INTEGER NOT NULL DEFAULT 0,
  swept_cents INTEGER NOT NULL DEFAULT 0,
  refunded_cents INTEGER NOT NULL DEFAULT 0,

  -- 'pif_deposit_guarantees' when the parallel deposit-guarantee tables were
  -- there to read, 'UNAVAILABLE_TABLE_MISSING' when they were not. The run
  -- says which rather than throwing or silently counting zero as truth.
  guarantee_source TEXT NOT NULL DEFAULT 'UNAVAILABLE_TABLE_MISSING',

  exception_count INTEGER NOT NULL DEFAULT 0,
  critical_count INTEGER NOT NULL DEFAULT 0,
  notes_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  triggered_by TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_pif_reconciliation_runs_started
  ON pif_reconciliation_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_pif_reconciliation_runs_status
  ON pif_reconciliation_runs(status, started_at DESC);

-- ──────────────────────────────────────── pif_reconciliation_exceptions ──
--
-- §21: a one-cent unexplained difference is an exception, not a rounding
-- tolerance. There is no threshold column in this table on purpose — adding
-- one is how "we ignore differences under a dollar" gets shipped.
--
-- Nothing here auto-adjusts. An exception is an operations case: somebody
-- investigates it, and if a correction is warranted it is a compensating
-- ledger entry posted through the ordinary journal and linked here. The
-- ledger is never rewritten to match Stripe (§28).
CREATE TABLE IF NOT EXISTS pif_reconciliation_exceptions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES pif_reconciliation_runs(id) ON DELETE CASCADE,

  -- Which check failed: CUSTODY_BALANCE_MISMATCH, LEDGER_IDENTITY_MISMATCH,
  -- TRANSFER_JOURNAL_MISMATCH, LEDGER_INTEGRITY_FAILED, ...
  code TEXT NOT NULL,
  -- §21's verdict word. A money difference of any size is CRITICAL.
  classification TEXT NOT NULL CHECK (classification IN (
    'CRITICAL_RECONCILIATION_EXCEPTION',
    'RECONCILIATION_WARNING'
  )),

  currency TEXT NOT NULL DEFAULT 'usd',
  expected_cents INTEGER NOT NULL DEFAULT 0,
  actual_cents INTEGER NOT NULL DEFAULT 0,
  difference_cents INTEGER NOT NULL DEFAULT 0,

  summary TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',

  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN (
    'OPEN',
    'INVESTIGATING',
    'RESOLVED_EXPLAINED',           -- understood; no entry was warranted
    'RESOLVED_COMPENSATING_ENTRY'   -- corrected by the linked journal entry
  )),
  investigation_notes TEXT,
  -- Required by application logic for RESOLVED_COMPENSATING_ENTRY: a
  -- resolution that claims a correction must point at the entry that made it.
  compensating_transaction_id TEXT REFERENCES ledger_transactions(id),
  resolved_by TEXT,
  resolved_at TEXT,

  opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CHECK (status NOT IN ('RESOLVED_EXPLAINED', 'RESOLVED_COMPENSATING_ENTRY')
         OR (resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND investigation_notes IS NOT NULL)),
  CHECK (status <> 'RESOLVED_COMPENSATING_ENTRY' OR compensating_transaction_id IS NOT NULL)
);

-- One case per check per run: a run that finds the same penny short in three
-- places opens three cases, not one, and re-running the same day reopens
-- nothing.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pif_reconciliation_exceptions_run_code
  ON pif_reconciliation_exceptions(run_id, code);
CREATE INDEX IF NOT EXISTS idx_pif_reconciliation_exceptions_status
  ON pif_reconciliation_exceptions(status, classification, opened_at DESC);
