PRAGMA foreign_keys = ON;

-- Money, and the paper trail an operator needs when Stripe and Tími disagree.
--
-- Tími is the merchant of record. The pet owner pays the arrival deposit to
-- the platform; the clinic is paid afterwards by a Transfer, for whatever is
-- left once the intake outcome is known. That is "separate charges and
-- transfers", and it is the whole reason these tables exist: with a
-- destination charge Stripe would own the split and there would be nothing
-- interesting to record. Here the split is ours, so the record has to be ours
-- too.
--
-- Three tables:
--   stripe_accounts   one connected account per clinic, and whether it can
--                     actually receive money yet
--   payment_ledger    one row per Stripe object we touched, ever
--   stripe_events     which webhook events have already been applied
--
-- See docs/STRIPE.md for the funds flow and the decision record.

-- ─────────────────────────────────────────────────── connected accounts ───

-- One row per tenant. A clinic that has never been onboarded simply has no
-- row, which is a different thing from a clinic whose onboarding stalled —
-- the console has to say which, so `onboarding_status` is stored rather than
-- inferred from the capability flags.
CREATE TABLE IF NOT EXISTS stripe_accounts (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  stripe_account_id TEXT NOT NULL UNIQUE,

  -- Which Accounts API minted it. v2 accounts carry
  -- `configuration.recipient`; v1 accounts carry the `transfers` capability
  -- and controller properties. Both are supported and they are read
  -- differently, so the row has to remember which one it is rather than the
  -- code guessing from the id — the id looks identical either way.
  accounts_api TEXT NOT NULL DEFAULT 'v1' CHECK (accounts_api IN ('v1', 'v2')),

  -- The three capability answers we care about, stored verbatim as Stripe
  -- reports them ('active' | 'pending' | 'inactive' | 'restricted' | ...)
  -- rather than flattened to a boolean. "pending" and "inactive" mean very
  -- different things to somebody deciding whether to chase a clinic.
  --
  -- transfers_status is the one that gates a payout to this clinic:
  --   v1  capabilities.transfers
  --   v2  configuration.recipient.capabilities.stripe_balance.stripe_transfers
  transfers_status TEXT NOT NULL DEFAULT 'inactive',
  -- v1 capabilities.card_payments. We do not take direct charges, so this is
  -- informational; it is recorded because an operator reading a restricted
  -- account wants the whole picture.
  charges_status TEXT NOT NULL DEFAULT 'inactive',
  -- v1 `payouts_enabled`; v2
  -- `configuration.recipient.capabilities.stripe_balance.payouts`. Whether
  -- Stripe will move the clinic's balance to its bank. A clinic can be
  -- transferable and not payable (no external account yet) — money would pile
  -- up in a Stripe balance nobody is watching, so it is worth showing.
  payouts_status TEXT NOT NULL DEFAULT 'inactive',
  -- Denormalized from transfers_status/payouts_status at write time so the
  -- one question every caller actually asks — "may I transfer to this
  -- clinic?" — is an indexable column and not a string comparison repeated in
  -- four places.
  transfers_enabled INTEGER NOT NULL DEFAULT 0,
  payouts_enabled INTEGER NOT NULL DEFAULT 0,
  details_submitted INTEGER NOT NULL DEFAULT 0,

  onboarding_status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (onboarding_status IN ('not_started', 'in_progress', 'complete', 'restricted', 'disabled')),
  -- Stripe's own `requirements` hash, whole. An operator asked "what does
  -- this clinic still owe Stripe?" and the answer is a list that changes
  -- shape without warning; storing it as JSON means a new requirement type
  -- never needs a migration to become visible.
  requirements_json TEXT NOT NULL DEFAULT '{}',
  disabled_reason TEXT,

  country TEXT NOT NULL DEFAULT 'US',
  default_currency TEXT NOT NULL DEFAULT 'usd',
  -- Who kicked off onboarding, for the audit trail.
  created_by TEXT,
  -- When we last asked Stripe rather than when we last guessed. A capability
  -- read from a webhook two weeks ago is not a fact about today.
  capabilities_refreshed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stripe_accounts_account ON stripe_accounts(stripe_account_id);
CREATE INDEX IF NOT EXISTS idx_stripe_accounts_transferable ON stripe_accounts(transfers_enabled, onboarding_status);

-- ─────────────────────────────────────────────────────────────── ledger ───

-- Every Stripe object we touch gets a row here, once.
--
-- The audience for this table is a person with a Stripe payout report open in
-- one window and this in the other, trying to work out why the two numbers
-- differ. Everything they would have to join on is therefore a column:
--
--   * `transfer_group` — the single string that ties a charge to the
--     transfers made against it. It is what Stripe's own Sigma queries join
--     on, and without it a partial refund plus a reduced transfer is
--     unreadable.
--   * `balance_transaction_id` — a payout is a list of balance transactions.
--     This is the only field that maps our row to a line of a payout report.
--   * `available_on` — when Stripe said the money becomes available. Payout
--     dates follow from this, and "why was this not in Tuesday's payout" is
--     answered by it and nothing else.
--   * `fee_cents` / `net_cents` — gross minus Stripe's cut. Reconciling
--     against gross alone always looks wrong.
--   * `stripe_event_id` — which webhook produced the row. When a row looks
--     wrong, the next question is always "what did Stripe actually send".
--
-- Amounts are integer cents, always. `direction` says which way the money
-- moved from the *platform's* point of view: 'in' is money arriving in the
-- Tími balance, 'out' is money leaving it. Amounts are stored positive and
-- the direction carries the sign, because a report that sums a column of
-- mixed signs hides a mistake that a report which sums two columns cannot.
CREATE TABLE IF NOT EXISTS payment_ledger (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,

  -- What kind of movement this is, in our language rather than Stripe's.
  -- Free text under a CHECK: these are the ones the split can produce, and a
  -- new one should be a deliberate migration, not a surprise string.
  kind TEXT NOT NULL CHECK (kind IN (
    'deposit_pending',      -- PaymentIntent created, nothing has moved
    'deposit_captured',     -- the customer's money is ours
    'deposit_failed',
    'deposit_canceled',
    'clinic_transfer',      -- our money moving to the clinic
    'transfer_reversed',
    'platform_fee',         -- the slice we kept by transferring less
    'customer_refund',
    'clinic_payout',        -- clinic balance to clinic bank
    'dispute',
    'adjustment'
  )),
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  -- Stripe's own fee on this object, when the balance transaction told us.
  fee_cents INTEGER NOT NULL DEFAULT 0,
  net_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'usd',

  -- The object this row is about, and what type it is: payment_intent,
  -- charge, transfer, transfer_reversal, refund, payout, application_fee,
  -- balance_transaction, dispute.
  stripe_object_id TEXT,
  stripe_object_type TEXT,

  -- Related ids, denormalized so a reconciliation query is a WHERE and not a
  -- recursive walk.
  payment_intent_id TEXT,
  charge_id TEXT,
  transfer_id TEXT,
  refund_id TEXT,
  payout_id TEXT,
  balance_transaction_id TEXT,
  transfer_group TEXT,
  -- The connected account this row concerns. NULL means the platform balance.
  stripe_account_id TEXT,
  available_on TEXT,

  -- Deliberately NOT foreign keys.
  --
  -- These are Stripe's words for what a payment was about, copied out of
  -- object metadata. Stripe does not know or care whether our rows still
  -- exist: an intake can be deleted, a test event can name nothing, metadata
  -- can be wrong. With a foreign key here the INSERT fails and the ledger
  -- silently refuses to record what Stripe told us — in exactly the cases
  -- where an operator most needs the record, and with the event then marked
  -- failed and dropped.
  --
  -- A ledger of external facts must be able to hold a fact it cannot match.
  -- The admin console left-joins these; an id with nothing behind it shows as
  -- unmatched, which is information rather than an error.
  tenant_id TEXT,
  intake_id TEXT,
  search_id TEXT,

  status TEXT NOT NULL DEFAULT 'recorded',
  -- Cleared when an operator (or a future automated sweep) has matched this
  -- row to a Stripe payout. Nothing sets it to 1 automatically yet; the point
  -- of the column is that the console can show what is still outstanding.
  reconciled INTEGER NOT NULL DEFAULT 0,
  reconciled_at TEXT,
  reconciled_by TEXT,

  raw_json TEXT NOT NULL DEFAULT '{}',
  -- The webhook event that produced this row. NULL only for rows written by
  -- an API call we made ourselves (a PaymentIntent we just created), which is
  -- exactly the set of rows a webhook will later supersede.
  stripe_event_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Stripe redelivers. `stripe_events` is the first line of defence, but it is
-- a separate statement from the insert, and two concurrent deliveries of the
-- same event can both pass it. This index is the second line: the same event
-- cannot describe the same object in the same way twice, whatever the
-- interleaving. It is a UNIQUE INDEX rather than a table constraint so the
-- NULL event ids (rows we wrote ourselves) stay exempt — in SQLite, NULLs are
-- distinct in a unique index, which is what we want here.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_event_object
  ON payment_ledger(stripe_event_id, stripe_object_id, kind)
  WHERE stripe_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ledger_tenant_time ON payment_ledger(tenant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_object ON payment_ledger(stripe_object_id);
CREATE INDEX IF NOT EXISTS idx_ledger_intake ON payment_ledger(intake_id);
CREATE INDEX IF NOT EXISTS idx_ledger_unreconciled ON payment_ledger(reconciled, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_transfer_group ON payment_ledger(transfer_group);
CREATE INDEX IF NOT EXISTS idx_ledger_payout ON payment_ledger(payout_id);
CREATE INDEX IF NOT EXISTS idx_ledger_payment_intent ON payment_ledger(payment_intent_id);

-- ────────────────────────────────────────────────────────────── events ───

-- The idempotency table.
--
-- Stripe retries a webhook until it gets a 2xx, and it will happily deliver
-- the same event twice on its own. Without this, one `charge.refunded`
-- redelivered writes a second refund row and the ledger claims we refunded
-- twice as much as we did. The primary key is Stripe's event id, so the
-- second delivery collides on insert and the handler returns early.
--
-- Rows are kept after processing on purpose: "did we ever see this event"
-- outlives "are we processing it now", and the answer is the first thing
-- anybody asks when a payment looks unapplied.
CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  api_version TEXT,
  livemode INTEGER NOT NULL DEFAULT 1,
  -- The connected account an event belongs to, for Connect events delivered
  -- to the platform endpoint. NULL for platform-level events.
  stripe_account_id TEXT,
  -- Stripe's `created`, as ISO. Ordering by receipt would be ordering by our
  -- retry schedule, which is not the order things happened.
  event_created_at TEXT,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TEXT,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'processed', 'ignored', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  -- What the row's handler did, so a redelivery can be answered without
  -- re-deriving it, and so an operator can see that an event was recognized
  -- and deliberately did nothing.
  result_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_stripe_events_type ON stripe_events(type, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_stripe_events_status ON stripe_events(status, received_at DESC);

-- ───────────────────────────────────────────── settlement on the intake ───

-- The intake already carries `payment_status` and `payment_provider_id` from
-- the demo path. What it never carried is the *outcome* the split was
-- computed from, or the three numbers that split produced. Recomputing them
-- from policy later is wrong the moment a tenant edits its policy, so they
-- are frozen onto the row at settlement.
ALTER TABLE intake_requests ADD COLUMN settlement_outcome TEXT;
ALTER TABLE intake_requests ADD COLUMN settled_at TEXT;
ALTER TABLE intake_requests ADD COLUMN clinic_amount_cents INTEGER;
ALTER TABLE intake_requests ADD COLUMN platform_fee_cents INTEGER;
ALTER TABLE intake_requests ADD COLUMN refund_amount_cents INTEGER;
ALTER TABLE intake_requests ADD COLUMN stripe_transfer_id TEXT;
-- Ours, not Stripe's: one string per intake, used as the PaymentIntent's
-- `transfer_group` so every later transfer and refund is joinable back to the
-- one business action.
ALTER TABLE intake_requests ADD COLUMN transfer_group TEXT;

CREATE INDEX IF NOT EXISTS idx_intakes_settlement ON intake_requests(tenant_id, settlement_outcome, settled_at);
CREATE INDEX IF NOT EXISTS idx_intakes_transfer_group ON intake_requests(transfer_group);
