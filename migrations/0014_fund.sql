PRAGMA foreign_keys = ON;

-- ═══════════════════════════════════════════ the Paw It Forward fund ══
--
-- Migration 0013 built the two things this one stands on: versioned prices,
-- and a double-entry subledger. This migration adds the four tables that
-- turn those into a program — where a contribution comes from, what is
-- promised to whom, what was actually spent, and the dials that stop the
-- fund promising more than it holds.
--
-- The single idea running through all of it: **reserving is not spending,
-- and spending is not earning.** A contribution lands in `fund_available`
-- and is a liability; approving assistance moves nothing at all; confirming
-- an assisted booking moves money from available to reserved, where it is
-- still the contributors'; only a verified completed connection turns it
-- into revenue. Every one of those transitions is a row here plus a balanced
-- journal transaction in 0013's ledger, and never a mutable counter.

-- ────────────────────────────────────────────────────── contributions ──
--
-- One row per act of giving, whether it rode along with a booking payment or
-- arrived on its own through the public portal. The money itself is recorded
-- in `payment_orders`/`payment_allocations` and in the ledger; this table
-- records the *person's* side of it — what they chose to be called in
-- public, where the receipt goes, which terms they agreed to.
--
-- Guests are first-class. A contributor with no account gets a pseudonymous
-- `contributor_token` rather than nothing, so a receipt can be re-sent, a
-- refund can be found, and the row can be claimed later by an account
-- without rewriting history. "Anonymous" is a display choice; it has never
-- meant that Tími and Stripe hold no identity for the payer, and the copy
-- on the portal says so.
CREATE TABLE IF NOT EXISTS contributions (
  id TEXT PRIMARY KEY,
  -- Clerk's user id when the contributor was signed in. Not a foreign key:
  -- Tími has no users table (see 0009) — Clerk is the register of people.
  contributor_user_id TEXT,
  -- Pseudonymous id for a guest, and the key a later account link uses.
  -- Always set, including for signed-in contributors, so every contribution
  -- has one stable handle regardless of how it arrived.
  contributor_token TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'usd',
  -- BOOKING: added to a booking payment, one PaymentIntent, two allocations.
  -- STANDALONE: its own PaymentIntent with purpose FUND_CONTRIBUTION_ONLY.
  source TEXT NOT NULL CHECK (source IN ('BOOKING', 'STANDALONE')),
  payment_order_id TEXT REFERENCES payment_orders(id) ON DELETE SET NULL,
  payment_allocation_id TEXT,
  stripe_payment_intent_id TEXT,
  stripe_checkout_session_id TEXT,
  -- §13.1. POSTED is distinct from SUCCEEDED on purpose: Stripe telling us
  -- the money arrived and the journal actually recording it are two events,
  -- and the gap between them is exactly where a redelivered webhook would
  -- otherwise post twice.
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
    'DRAFT', 'REQUIRES_PAYMENT', 'SUCCEEDED', 'POSTED',
    'FAILED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED'
  )),
  refunded_cents INTEGER NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  -- What the public impact page and any recognition wall may say. Guests
  -- default to ANONYMOUS; nothing here is ever shown to a recipient.
  recognition TEXT NOT NULL DEFAULT 'ANONYMOUS' CHECK (recognition IN (
    'ANONYMOUS', 'FIRST_NAME_LAST_INITIAL', 'ORGANIZATION'
  )),
  recognition_name TEXT,
  -- Required: a contribution without a way to send a receipt is a payment
  -- support case waiting to happen.
  receipt_email TEXT,
  receipt_sent_at TEXT,
  -- Which version of the program terms this person actually agreed to. The
  -- non-tax-deductibility language lives in those terms, so the version is
  -- the evidence that it was shown.
  terms_version TEXT,
  -- Recurring contributions are NOT implemented (spec §5.4). This column
  -- exists so that adding them later is a migration for the schedule table
  -- alone and not a rewrite of every contribution row — but nothing in the
  -- product creates a schedule, no UI offers one, and this column is null on
  -- every row. Do not build copy that implies a contributor can subscribe.
  contribution_schedule_id TEXT,
  failure_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  posted_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Refunding more than was ever given would drive fund_available negative
  -- silently, which is the one outcome the subledger exists to prevent.
  CHECK (refunded_cents <= amount_cents),
  -- A named recognition without a name would render as a blank line on a
  -- public page; ANONYMOUS is the only choice that needs no name.
  CHECK (recognition = 'ANONYMOUS' OR recognition_name IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_contributions_user ON contributions(contributor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contributions_token ON contributions(contributor_token, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contributions_status ON contributions(status, created_at);
CREATE INDEX IF NOT EXISTS idx_contributions_order ON contributions(payment_order_id);
-- One contribution per PaymentIntent. A redelivered `payment_intent.succeeded`
-- must not be able to mint a second contribution row for the same charge
-- (acceptance test 6), and a UNIQUE index says so at the storage layer rather
-- than trusting every future call site to check first.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contributions_payment_intent
  ON contributions(stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;

-- ─────────────────────────────────────────────────── fund reservations ──
--
-- The promise. When an approved applicant confirms an assisted booking, the
-- fund's share stops being available and becomes reserved — still the
-- contributors' money, no longer spendable on anyone else, not yet revenue.
--
-- `amount_cents` is what the fund supplies and `match_cents` is Tími's own
-- share, both frozen from the pricing policy at reservation time along with
-- `applicable_value_cents` (what Tími would genuinely have earned on this
-- booking). Freezing them is what makes a founding clinic's sponsorship cost
-- the fund $10 rather than $35 forever after, even if that clinic's plan
-- changes tomorrow.
CREATE TABLE IF NOT EXISTS fund_reservations (
  id TEXT PRIMARY KEY,
  intake_id TEXT NOT NULL REFERENCES intake_requests(id) ON DELETE CASCADE,
  search_id TEXT REFERENCES care_searches(id) ON DELETE SET NULL,
  -- The hardship decision this redeems. Not a foreign key yet: the
  -- eligibility tables arrive with the hardship engine (spec §9), and a
  -- reservation must be recordable before that lands.
  eligibility_decision_id TEXT,
  applicant_user_id TEXT,
  -- What the restricted fund supplies. The founding-clinic case is the
  -- reason this is a column and not a constant.
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  -- Tími's own $10. Recorded here for reporting; it is never taken from the
  -- fund and never posted against a fund_* account.
  match_cents INTEGER NOT NULL DEFAULT 0 CHECK (match_cents >= 0),
  -- owner fee + this clinic's actual fee: the value being waived.
  applicable_value_cents INTEGER NOT NULL DEFAULT 0 CHECK (applicable_value_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'usd',
  pricing_policy_id TEXT REFERENCES pricing_policies(id),
  tenant_id TEXT REFERENCES tenants(id),
  -- §13.3.
  state TEXT NOT NULL DEFAULT 'RESERVED' CHECK (state IN (
    'AVAILABLE_CHECKED',
    'RESERVED',
    'COMPLETED_CONSUMED',
    'RELEASED_CANCELLED',
    'RELEASED_EXPIRED',
    'REVERSED_ERROR'
  )),
  -- A reservation nobody redeems must not hold contributions hostage. The
  -- TTL comes from fund_controls.reservation_ttl_minutes.
  expires_at TEXT,
  reserved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  resolution_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Tími's match cannot exceed the value actually being waived, and the fund
  -- covers the rest. Both follow from sponsorshipCostFor() in src/pricing.js;
  -- restating them here means a hand-written row cannot invent economics.
  CHECK (match_cents <= applicable_value_cents),
  CHECK (amount_cents + match_cents = applicable_value_cents)
);

-- ══ THE constraint ══
--
-- At most one live reservation per booking. Without it, a double-submitted
-- confirmation, a retried request, or two browser tabs reserve the fund's
-- share twice for one visit and the second one is money quietly promised to
-- nobody. A partial UNIQUE index makes the database refuse it, so the
-- guarantee does not depend on every future call site remembering to check.
-- Resolved reservations (consumed, released, reversed) fall out of the index
-- and may accumulate freely — the history is the audit trail.
CREATE UNIQUE INDEX IF NOT EXISTS idx_fund_reservations_one_active
  ON fund_reservations(intake_id) WHERE state = 'RESERVED';

CREATE INDEX IF NOT EXISTS idx_fund_reservations_state ON fund_reservations(state, expires_at);
CREATE INDEX IF NOT EXISTS idx_fund_reservations_reserved_at ON fund_reservations(reserved_at);
CREATE INDEX IF NOT EXISTS idx_fund_reservations_applicant ON fund_reservations(applicant_user_id, reserved_at);
CREATE INDEX IF NOT EXISTS idx_fund_reservations_tenant ON fund_reservations(tenant_id, reserved_at);

-- ───────────────────────────────────────────────────────── sponsorships ──
--
-- The spend. One row per reservation that reached a verified completed
-- connection, and the only table the public impact numbers are allowed to
-- count. A reservation is a promise; this is the receipt.
--
-- A reversal does not delete the row — it stamps it. "This was consumed and
-- then unwound, by this person, for this reason" is a materially different
-- fact from "this never happened", and only one of them is true.
CREATE TABLE IF NOT EXISTS sponsorships (
  id TEXT PRIMARY KEY,
  -- One sponsorship per reservation, forever: this is what makes a replayed
  -- completion webhook unable to recognize the revenue twice.
  reservation_id TEXT NOT NULL UNIQUE REFERENCES fund_reservations(id) ON DELETE CASCADE,
  intake_id TEXT NOT NULL REFERENCES intake_requests(id) ON DELETE CASCADE,
  tenant_id TEXT REFERENCES tenants(id),
  -- Copied from the reservation rather than joined at read time, so the
  -- impact page's arithmetic cannot change under it.
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  match_cents INTEGER NOT NULL DEFAULT 0 CHECK (match_cents >= 0),
  applicable_value_cents INTEGER NOT NULL DEFAULT 0 CHECK (applicable_value_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'usd',
  pricing_policy_id TEXT REFERENCES pricing_policies(id),
  consumed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Which Stripe/completion event verified this, for reconciliation.
  completion_event_id TEXT,
  reversed_at TEXT,
  reversal_reason TEXT,
  reversed_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (reversed_at IS NULL OR reversal_reason IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_sponsorships_consumed ON sponsorships(consumed_at);
CREATE INDEX IF NOT EXISTS idx_sponsorships_tenant ON sponsorships(tenant_id, consumed_at);
CREATE INDEX IF NOT EXISTS idx_sponsorships_intake ON sponsorships(intake_id);

-- ──────────────────────────────────────────────────────── fund controls ──
--
-- The dials, in one singleton row. Spec §8.7 asks for a minimum liquidity
-- reserve, daily and monthly automatic-reservation caps, a per-household
-- frequency, a reservation TTL, and a pause switch — and it is emphatic that
-- these are budget decisions and not eligibility decisions. Being eligible
-- does not mean being funded; a full fund does not loosen a rule.
--
-- A singleton rather than a key/value table because every one of these is
-- read together on the availability check, and a missing key would have to
-- mean something.
CREATE TABLE IF NOT EXISTS fund_controls (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- Contributions the fund will not reserve against: the float that keeps a
  -- refund or a chargeback from having to come out of somebody else's
  -- sponsored visit.
  min_liquidity_reserve_cents INTEGER NOT NULL DEFAULT 0 CHECK (min_liquidity_reserve_cents >= 0),
  -- Automatic reservation ceilings. A bug, a scripted abuse run, or an
  -- unexpectedly good press day should not be able to commit the whole fund
  -- between two dashboard refreshes.
  max_daily_reserved_cents INTEGER NOT NULL DEFAULT 100000 CHECK (max_daily_reserved_cents >= 0),
  max_monthly_reserved_cents INTEGER NOT NULL DEFAULT 2000000 CHECK (max_monthly_reserved_cents >= 0),
  -- How long a reservation holds the money before the sweep releases it.
  reservation_ttl_minutes INTEGER NOT NULL DEFAULT 60 CHECK (reservation_ttl_minutes > 0),
  -- Pauses NEW assistance only. Existing reservations are preserved and
  -- still consumable: a person already told their fee is covered must never
  -- be charged it later because operations flipped a switch (§2.5).
  assistance_paused INTEGER NOT NULL DEFAULT 0 CHECK (assistance_paused IN (0, 1)),
  per_household_visits_per_year INTEGER NOT NULL DEFAULT 1 CHECK (per_household_visits_per_year >= 0),
  -- Public metrics are delayed and thresholded (§5.6). With a handful of
  -- sponsored visits in one small town, "3 connections funded this week" is
  -- not an aggregate — it is close to naming three households.
  public_metrics_delay_hours INTEGER NOT NULL DEFAULT 24 CHECK (public_metrics_delay_hours >= 0),
  public_metrics_min_connections INTEGER NOT NULL DEFAULT 5 CHECK (public_metrics_min_connections >= 0),
  -- Standalone contributions above this get a human look before posting.
  enhanced_review_threshold_cents INTEGER NOT NULL DEFAULT 500000 CHECK (enhanced_review_threshold_cents >= 0),
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Launch settings: no liquidity floor yet because there is no float yet,
-- $1,000/day and $20,000/month automatic ceilings, a one-hour reservation
-- TTL, assistance live, one sponsored connection per household per year.
INSERT OR IGNORE INTO fund_controls (
  id, min_liquidity_reserve_cents, max_daily_reserved_cents, max_monthly_reserved_cents,
  reservation_ttl_minutes, assistance_paused, per_household_visits_per_year,
  public_metrics_delay_hours, public_metrics_min_connections, enhanced_review_threshold_cents
) VALUES (1, 0, 100000, 2000000, 60, 0, 1, 24, 5, 500000);

-- ──────────────────────────────────────── the match's other half ──
--
-- Tími's $10 needs somewhere to be credited. It must not credit a fund_*
-- account (that would spend restricted money on Tími's own contribution),
-- must not credit cash (no $10 moves), and must not credit revenue (nothing
-- was earned). What it is, is Tími putting $10 of its own into the program:
-- contributed capital, offsetting the `timinow_program_match` expense that
-- 0013 already defines. Final GL mapping stays accountant-controlled — the
-- pair is a memo entry either way, and it nets to zero in the P&L.
INSERT OR IGNORE INTO ledger_accounts (code, class, normal_balance, restricted, description) VALUES
  ('timinow_match_contributed', 'EQUITY', 'credit', 0,
   'Non-cash offset for the Tími program match. Balances the match memo entry without touching restricted fund money, cash, or revenue.');
