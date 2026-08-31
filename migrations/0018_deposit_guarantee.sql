PRAGMA foreign_keys = ON;

-- ═══════════════════════════════════ appointment deposits and guarantees ──
--
-- Addendum §7 (appointment deposit guarantee), §8 (the required admin clinic
-- profile deposit setting), §9 (the guarantee state machine), §19 Deposits,
-- §23 (data model) and §25 (policy snapshots), read together with the
-- executed clinic agreement §11 (CLINIC DEPOSITS) and §15 (the mandatory
-- deposit election).
--
-- Three facts shape every table below.
--
--   1. The deposit election is a *contract term*, not a preference. The
--      executed agreement makes the clinic initial exactly one of three
--      boxes; the admin console records which box was initialled, from which
--      document, verified by which human, effective when. So the policy is
--      append-only and versioned: a booking made in March must still be able
--      to say what the March policy was, and no later edit may rewrite it
--      (§25, acceptance test 21).
--
--   2. A deposit guarantee is program cash leaving the building. Every
--      movement is a balanced posting in the existing subledger, never a
--      column somebody increments.
--
--   3. A guarantee is temporary float, not treatment assistance. The clinic
--      may not apply it to the veterinary bill and also collect the same
--      amount from the customer, an insurer, or a financing source (contract
--      §15; addendum §7). The settlement rows below exist so that is
--      arithmetic rather than a promise.
--
-- ─────────────────────────────────────── a note on ledger event kinds ──
--
-- Addendum §6 names six new ledger event types:
--
--   DEPOSIT_GUARANTEE_RESERVED / _FUNDED / _RETURN_DUE / _RETURNED /
--   _PARTIALLY_FORFEITED / _FORFEITED
--
-- `ledger_transactions.kind` is constrained by a CHECK written in migration
-- 0013, and SQLite cannot ALTER a CHECK. The alternatives were (a) rebuild
-- `ledger_transactions` — a destructive table swap of the one table in this
-- system that must never lose a row — or (b) post guarantee movements under
-- the existing kinds that already describe them and carry the §6 event name
-- alongside.
--
-- (b), deliberately. The postings stay in `ledger_transactions`, so
-- `ledgerIntegrity()` still proves them balanced and still refuses to let a
-- restricted account go negative — which is the whole point of the
-- subledger, and which a private side table would have quietly given up.
-- The mapping is:
--
--   DEPOSIT_GUARANTEE_RESERVED       -> kind 'adjustment'
--   (release / cancel / failed)      -> kind 'adjustment'
--   DEPOSIT_GUARANTEE_FUNDED         -> kind 'clinic_deposit_collected'
--   DEPOSIT_GUARANTEE_RETURNED       -> kind 'clinic_deposit_refunded'
--   DEPOSIT_GUARANTEE_PARTIALLY_FORFEITED -> a 'clinic_deposit_refunded'
--                                      posting for the returned remainder
--                                      plus an 'adjustment' for the retained
--                                      part
--   DEPOSIT_GUARANTEE_FORFEITED      -> kind 'adjustment'
--   DEPOSIT_GUARANTEE_RETURN_DUE     -> no posting at all; nothing moves when
--                                      an obligation arises, only when cash
--                                      does.
--
-- The precise §6 name is not lost: `pif_deposit_guarantee_events.ledger_event`
-- records it on every transition, next to the `ledger_transaction_id` of the
-- posting it produced. When the next migration is free to rebuild the CHECK,
-- that column is the migration key.

-- ────────────────────────────────────────────────────── ledger accounts ──
--
-- Accounts are rows, not a CHECK, so these are additive and safe.

INSERT OR IGNORE INTO ledger_accounts (code, class, normal_balance, restricted, description) VALUES
  ('fund_deposit_guarantee_reserved', 'LIABILITY', 'credit', 1,
   'Paw It Forward cash committed to an appointment deposit guarantee. Restricted: it is contributors'' money, promised to a clinic, and owed back to fund_available the moment the guarantee resolves.'),
  ('deposit_guarantee_outstanding', 'ASSET', 'debit', 0,
   'Program cash sitting at a clinic as an appointment deposit guarantee, expected back on attendance. An asset of the program, never a customer payment toward treatment.'),
  ('deposit_guarantee_forfeiture_expense', 'EXPENSE', 'debit', 0,
   'Guarantee amounts a clinic lawfully retained under its ordinary disclosed no-show or late-cancellation policy. A real Paw It Forward expense (§7).'),
  ('program_restricted_released', 'REVENUE', 'credit', 0,
   'Restricted contributions released as spent when a program expense — such as a permitted deposit forfeiture — actually consumes them.');

-- ───────────────────────────────────────────── clinic deposit policies ──
--
-- One row per election, forever. `superseded_at IS NULL` marks the row in
-- force; every prior row stays exactly as it was written, which is what lets
-- a booking snapshot point at a policy id and mean it.
--
-- The four elections are §8's, in §8's order:
--
--   NO_DEPOSIT_REQUIRED        "Will not require a deposit"
--   WAIVE_FOR_PAW_IT_FORWARD   "Waive deposit for Paw It Forward"
--   PAW_IT_FORWARD_GUARANTEE   "Accept Paw It Forward deposit guarantee"
--   CUSTOMER_REQUIRED          "Customer must pay clinic deposit"
--
-- The executed agreement (§15) offers only the last three, as OPTION A
-- (Waiver), OPTION B (Paw It Forward Deposit Guarantee) and OPTION C
-- (Customer-Funded). `contract_election_option` records which box the clinic
-- actually initialled and `contract_offers_no_deposit_option` records whether
-- the contract revision that clinic signed even contained a fourth box. A
-- clinic on the three-option paper can therefore never appear to have
-- elected the fourth: the only way to reach NO_DEPOSIT_REQUIRED from that
-- paper is a signed amendment or an authorized written instruction, with a
-- document id, and src/deposit-policy.js enforces exactly that.

CREATE TABLE IF NOT EXISTS clinic_deposit_policies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),

  -- Whether this clinic participates in Paw It Forward at all. A
  -- participating clinic cannot be saved without an election; the NOT NULL
  -- below is half of acceptance test 14 and src/deposit-policy.js is the
  -- other half (a blank submission never reaches this INSERT).
  paw_it_forward_enabled INTEGER NOT NULL DEFAULT 1 CHECK (paw_it_forward_enabled IN (0, 1)),

  paw_it_forward_deposit_policy TEXT NOT NULL CHECK (paw_it_forward_deposit_policy IN (
    'NO_DEPOSIT_REQUIRED',
    'WAIVE_FOR_PAW_IT_FORWARD',
    'PAW_IT_FORWARD_GUARANTEE',
    'CUSTOMER_REQUIRED'
  )),

  -- §8 companion fields, in §8's names.
  appointment_deposit_required_normally INTEGER NOT NULL DEFAULT 0
    CHECK (appointment_deposit_required_normally IN (0, 1)),
  appointment_deposit_amount_type TEXT NOT NULL CHECK (appointment_deposit_amount_type IN (
    'NONE', 'FIXED', 'VARIABLE', 'CLINIC_CONFIRMS_PER_REQUEST'
  )),
  appointment_deposit_fixed_amount_cents INTEGER CHECK (
    appointment_deposit_fixed_amount_cents IS NULL OR appointment_deposit_fixed_amount_cents >= 0
  ),
  deposit_refundability TEXT NOT NULL CHECK (deposit_refundability IN (
    'FULLY_REFUNDABLE', 'REFUNDABLE_UNTIL_CUTOFF', 'NONREFUNDABLE', 'VARIABLE_BY_BOOKING', 'NOT_APPLICABLE'
  )),
  deposit_cancellation_cutoff_minutes INTEGER CHECK (
    deposit_cancellation_cutoff_minutes IS NULL OR deposit_cancellation_cutoff_minutes >= 0
  ),
  deposit_no_show_forfeit_type TEXT NOT NULL CHECK (deposit_no_show_forfeit_type IN (
    'NONE', 'FULL', 'PARTIAL', 'VARIABLE', 'NOT_APPLICABLE'
  )),
  deposit_no_show_forfeit_amount_cents INTEGER CHECK (
    deposit_no_show_forfeit_amount_cents IS NULL OR deposit_no_show_forfeit_amount_cents >= 0
  ),
  -- What a customer is shown after identity reveal. Never shown before
  -- confirmation: it can name the clinic (§10).
  deposit_policy_customer_copy TEXT,
  deposit_policy_internal_notes TEXT,

  -- The most any one guarantee at this clinic may commit. NULL means the
  -- program-wide fund controls are the only ceiling.
  deposit_guarantee_limit_cents INTEGER CHECK (
    deposit_guarantee_limit_cents IS NULL OR deposit_guarantee_limit_cents >= 0
  ),
  currency TEXT NOT NULL DEFAULT 'usd',

  -- Provenance. §8 "Authority": this is an admin-set field read out of an
  -- executed document, not a clinic-portal toggle.
  deposit_election_source TEXT NOT NULL CHECK (deposit_election_source IN (
    'EXECUTED_AGREEMENT', 'SIGNED_AMENDMENT', 'AUTHORIZED_WRITTEN_INSTRUCTION', 'ADMIN_MIGRATION'
  )),
  deposit_election_effective_at TEXT NOT NULL,
  deposit_election_verified_by_admin_user_id TEXT NOT NULL,
  deposit_election_source_document_id TEXT,

  -- Contract parity (§8 "Contract parity").
  contract_election_option TEXT CHECK (contract_election_option IS NULL OR contract_election_option IN (
    'OPTION_A_WAIVER',
    'OPTION_B_PAW_IT_FORWARD_GUARANTEE',
    'OPTION_C_CUSTOMER_FUNDED',
    'OPTION_D_NO_DEPOSIT_REQUIRED',
    'NOT_RECORDED'
  )),
  -- 0 for every clinic on the current three-election paper. The next
  -- contract revision adds the fourth box; clinics signing it get 1.
  contract_offers_no_deposit_option INTEGER NOT NULL DEFAULT 0
    CHECK (contract_offers_no_deposit_option IN (0, 1)),

  change_reason TEXT,
  superseded_at TEXT,
  superseded_by_policy_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE (tenant_id, version),

  -- §8 Validation, restated where a hand-written row also has to obey it.
  --
  -- "NO_DEPOSIT_REQUIRED normally requires amount type NONE." No deposit
  -- exists at all, so there is no amount and nothing to refund or forfeit.
  CHECK (paw_it_forward_deposit_policy <> 'NO_DEPOSIT_REQUIRED' OR (
    appointment_deposit_amount_type = 'NONE'
    AND appointment_deposit_required_normally = 0
    AND deposit_refundability = 'NOT_APPLICABLE'
    AND deposit_no_show_forfeit_type = 'NOT_APPLICABLE'
  )),
  -- The other three all describe a clinic that does ordinarily require one.
  -- WAIVE_FOR_PAW_IT_FORWARD keeps its amount on purpose: the deposit still
  -- applies to everybody outside the program (§8).
  CHECK (paw_it_forward_deposit_policy = 'NO_DEPOSIT_REQUIRED'
         OR appointment_deposit_required_normally = 1),
  -- A guarantee has to be for a determinable number.
  CHECK (paw_it_forward_deposit_policy <> 'PAW_IT_FORWARD_GUARANTEE'
         OR appointment_deposit_amount_type <> 'NONE'),
  CHECK (appointment_deposit_amount_type <> 'FIXED'
         OR appointment_deposit_fixed_amount_cents IS NOT NULL),
  CHECK (deposit_no_show_forfeit_type <> 'PARTIAL'
         OR deposit_no_show_forfeit_amount_cents IS NOT NULL),
  CHECK (deposit_refundability <> 'REFUNDABLE_UNTIL_CUTOFF'
         OR deposit_cancellation_cutoff_minutes IS NOT NULL),
  -- An election that is not simply the executed agreement's own box must
  -- point at the paper that authorized it. This is the mechanical form of
  -- "not an undocumented toggle" (§8).
  CHECK (deposit_election_source = 'EXECUTED_AGREEMENT'
         OR deposit_election_source = 'ADMIN_MIGRATION'
         OR deposit_election_source_document_id IS NOT NULL)
);

-- One live policy per clinic. Without this, "the current deposit policy"
-- depends on row order, which is how two bookings at the same clinic on the
-- same afternoon quote different deposits.
CREATE UNIQUE INDEX IF NOT EXISTS idx_clinic_deposit_policies_current
  ON clinic_deposit_policies(tenant_id) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_clinic_deposit_policies_tenant
  ON clinic_deposit_policies(tenant_id, version);

-- ─────────────────────────────────── booking-time policy snapshots (§25) ──
--
-- Taken at confirmation for every booking, whatever the election — including
-- NO_DEPOSIT_REQUIRED, where the useful historical fact is precisely that no
-- deposit was ever asked for. `policy_json` is the whole policy row as it
-- read at that instant, so the snapshot survives even a policy row that a
-- later data migration touches.

CREATE TABLE IF NOT EXISTS booking_deposit_policy_snapshots (
  id TEXT PRIMARY KEY,
  intake_id TEXT NOT NULL UNIQUE REFERENCES intake_requests(id) ON DELETE CASCADE,
  tenant_id TEXT REFERENCES tenants(id),
  policy_id TEXT REFERENCES clinic_deposit_policies(id),
  policy_version INTEGER,
  paw_it_forward_deposit_policy TEXT NOT NULL,
  sponsored INTEGER NOT NULL DEFAULT 0 CHECK (sponsored IN (0, 1)),
  -- What the customer was actually told before confirming, kept verbatim so
  -- a dispute is settled by the sentence they read and not by a
  -- reconstruction of it.
  customer_deposit_headline TEXT NOT NULL,
  customer_deposit_detail TEXT,
  customer_owes_deposit_cents INTEGER NOT NULL DEFAULT 0 CHECK (customer_owes_deposit_cents >= 0),
  guarantee_expected_cents INTEGER NOT NULL DEFAULT 0 CHECK (guarantee_expected_cents >= 0),
  policy_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_booking_deposit_snapshots_tenant
  ON booking_deposit_policy_snapshots(tenant_id, created_at);

-- ─────────────────────────────────────────── the guarantee itself (§9) ──

CREATE TABLE IF NOT EXISTS pif_deposit_guarantees (
  id TEXT PRIMARY KEY,
  intake_id TEXT NOT NULL REFERENCES intake_requests(id) ON DELETE CASCADE,
  clinic_id TEXT REFERENCES tenants(id),
  customer_id TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'usd',
  policy_snapshot_id TEXT REFERENCES clinic_deposit_policies(id),
  booking_snapshot_id TEXT REFERENCES booking_deposit_policy_snapshots(id),

  -- Appointment/reservation only. Treatment, hospitalization, surgery,
  -- emergency-treatment and post-evaluation deposits are outside this
  -- feature entirely (§7 "Treatment deposits", contract §15). The column
  -- exists so a request for one is *recorded as refused* rather than
  -- silently reshaped into an appointment guarantee.
  deposit_kind TEXT NOT NULL DEFAULT 'APPOINTMENT' CHECK (deposit_kind = 'APPOINTMENT'),

  state TEXT NOT NULL CHECK (state IN (
    'NOT_APPLICABLE',
    'ELIGIBLE',
    'RESERVED',
    'FUNDING_PENDING',
    'FUNDED',
    'RETURN_DUE',
    'RETURN_PENDING',
    'RETURNED',
    'PARTIAL_FORFEITURE',
    'FORFEITED',
    'DISPUTED',
    'FAILED',
    'CANCELED'
  )),
  -- Where a DISPUTED guarantee came from, so releasing the dispute puts it
  -- back rather than guessing (§9 rule 9: a dispute freezes final
  -- accounting; it does not decide it).
  state_before_dispute TEXT,

  return_reason TEXT,
  returned_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (returned_amount_cents >= 0),
  forfeited_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (forfeited_amount_cents >= 0),
  forfeiture_reason TEXT,
  -- What the clinic's own documented ordinary policy would have allowed it
  -- to keep had the customer personally funded the deposit (contract §15).
  -- Computed from the snapshot at settlement and stored, because "we checked
  -- at the time" has to be a number somebody can read back.
  permitted_forfeiture_cents INTEGER NOT NULL DEFAULT 0 CHECK (permitted_forfeiture_cents >= 0),

  clinic_payment_reference TEXT,
  stripe_transfer_reference TEXT,

  -- Anti-double-payment (§7, contract §15). A guarantee only ever becomes
  -- treatment payment under a separate, expressly recorded ClearKey
  -- treatment-assistance authorization. NULL — the normal case — means any
  -- attempt to apply it to the veterinary bill is refused.
  treatment_authorization_id TEXT,
  treatment_authorized_by TEXT,
  treatment_authorized_at TEXT,
  applied_to_treatment_cents INTEGER NOT NULL DEFAULT 0 CHECK (applied_to_treatment_cents >= 0),

  reserved_at TEXT,
  funded_at TEXT,
  return_due_at TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Acceptance test 24, as a constraint rather than as a code path: the
  -- money can be split between returned and forfeited, but the two together
  -- are exactly the guarantee and never more.
  CHECK (returned_amount_cents + forfeited_amount_cents <= amount_cents),
  CHECK (forfeited_amount_cents <= permitted_forfeiture_cents OR forfeited_amount_cents = 0),
  -- A fully returned guarantee has forfeited nothing, and vice versa.
  CHECK (state <> 'RETURNED' OR (forfeited_amount_cents = 0 AND returned_amount_cents = amount_cents)),
  CHECK (state <> 'FORFEITED' OR (returned_amount_cents = 0 AND forfeited_amount_cents = amount_cents)),
  CHECK (state <> 'PARTIAL_FORFEITURE' OR (
    forfeited_amount_cents > 0
    AND returned_amount_cents > 0
    AND returned_amount_cents + forfeited_amount_cents = amount_cents
  )),
  -- Applying program money to a veterinary bill without a recorded
  -- authorization is not a thing this table can hold.
  CHECK (applied_to_treatment_cents = 0 OR treatment_authorization_id IS NOT NULL)
);

-- At most one guarantee holding program cash per booking. A second live one
-- would double-commit the fund for the same appointment.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pif_deposit_guarantees_live
  ON pif_deposit_guarantees(intake_id)
  WHERE state IN ('ELIGIBLE', 'RESERVED', 'FUNDING_PENDING', 'FUNDED', 'RETURN_DUE', 'RETURN_PENDING', 'DISPUTED');
CREATE INDEX IF NOT EXISTS idx_pif_deposit_guarantees_clinic
  ON pif_deposit_guarantees(clinic_id, state);
CREATE INDEX IF NOT EXISTS idx_pif_deposit_guarantees_state
  ON pif_deposit_guarantees(state, created_at);

-- ────────────────────────────────────── append-only transition journal ──
--
-- One row per transition, never updated, never deleted. `ledger_event` is the
-- addendum §6 event name (see the note at the top of this file);
-- `ledger_transaction_id` is the posting it produced, or NULL where the
-- transition moved no money.

CREATE TABLE IF NOT EXISTS pif_deposit_guarantee_events (
  id TEXT PRIMARY KEY,
  guarantee_id TEXT NOT NULL REFERENCES pif_deposit_guarantees(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  ledger_event TEXT CHECK (ledger_event IS NULL OR ledger_event IN (
    'DEPOSIT_GUARANTEE_RESERVED',
    'DEPOSIT_GUARANTEE_RELEASED',
    'DEPOSIT_GUARANTEE_FUNDED',
    'DEPOSIT_GUARANTEE_RETURN_DUE',
    'DEPOSIT_GUARANTEE_RETURNED',
    'DEPOSIT_GUARANTEE_PARTIALLY_FORFEITED',
    'DEPOSIT_GUARANTEE_FORFEITED'
  )),
  ledger_transaction_id TEXT REFERENCES ledger_transactions(id),
  amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  reason TEXT,
  actor_id TEXT,
  actor_role TEXT,
  detail_json TEXT,
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (guarantee_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_pif_guarantee_events_guarantee
  ON pif_deposit_guarantee_events(guarantee_id, sequence);

-- ─────────────────────────────── clinic settlement / double-collection ──
--
-- The arithmetic behind contract §15's prohibition. A clinic reporting how a
-- visit was paid records what it collected from every payer and how much (if
-- any) of the guarantee it applied to the veterinary bill. Two things are
-- then checkable rather than merely promised:
--
--   * the guarantee was applied to the bill at all only under a recorded
--     treatment-assistance authorization; and
--   * applied guarantee + everything collected from customer, insurer and
--     financing source does not exceed the bill.
--
-- The second is what "shall not both retain or apply the guarantee ... and
-- collect the same amount from the Customer, insurer, financing source, or
-- other payer" means when you write it as numbers.

CREATE TABLE IF NOT EXISTS pif_deposit_guarantee_settlements (
  id TEXT PRIMARY KEY,
  guarantee_id TEXT NOT NULL REFERENCES pif_deposit_guarantees(id) ON DELETE CASCADE,
  intake_id TEXT NOT NULL,
  veterinary_bill_cents INTEGER NOT NULL CHECK (veterinary_bill_cents >= 0),
  collected_from_customer_cents INTEGER NOT NULL DEFAULT 0 CHECK (collected_from_customer_cents >= 0),
  collected_from_insurer_cents INTEGER NOT NULL DEFAULT 0 CHECK (collected_from_insurer_cents >= 0),
  collected_from_other_payer_cents INTEGER NOT NULL DEFAULT 0 CHECK (collected_from_other_payer_cents >= 0),
  guarantee_applied_to_bill_cents INTEGER NOT NULL DEFAULT 0 CHECK (guarantee_applied_to_bill_cents >= 0),
  treatment_authorization_id TEXT,
  -- Positive means the clinic was paid more than the bill once the applied
  -- guarantee is counted: the amount double-collected.
  overcollected_cents INTEGER NOT NULL DEFAULT 0,
  accepted INTEGER NOT NULL DEFAULT 1 CHECK (accepted IN (0, 1)),
  refusal_code TEXT,
  reported_by TEXT,
  reported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (guarantee_applied_to_bill_cents = 0 OR treatment_authorization_id IS NOT NULL OR accepted = 0)
);

CREATE INDEX IF NOT EXISTS idx_pif_guarantee_settlements_guarantee
  ON pif_deposit_guarantee_settlements(guarantee_id, reported_at);

-- ──────────────────────────── refused out-of-scope deposit requests (§7) ──
--
-- A request to guarantee a hospitalization, surgery, emergency-treatment,
-- treatment-plan or post-evaluation deposit is refused. It is written down
-- because the interesting operational number is how often clinics ask —
-- that, and not a silent 400, is what tells ClearKey whether the separate
-- treatment-assistance feature §7 contemplates is worth building.

CREATE TABLE IF NOT EXISTS pif_deposit_guarantee_refusals (
  id TEXT PRIMARY KEY,
  intake_id TEXT,
  tenant_id TEXT,
  requested_deposit_kind TEXT NOT NULL,
  requested_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (requested_amount_cents >= 0),
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  actor_id TEXT,
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pif_guarantee_refusals_code
  ON pif_deposit_guarantee_refusals(code, occurred_at);
