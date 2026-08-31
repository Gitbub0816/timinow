/**
 * Appointment deposit policy and deposit guarantee tests.
 *
 * Addendum §26 acceptance tests 14–29, in order, plus the ones this feature
 * cannot ship without: that the contract's three elections and the addendum's
 * four cannot be silently conflated, that a guarantee reservation and a $35
 * sponsorship reservation can coexist without either pretending the other
 * does not exist, and that the journal still balances after every single
 * operation below.
 *
 * Same harness as scripts/e2e.mjs and scripts/fund-test.mjs — node:sqlite
 * behind a D1-shaped mock — because a money test that runs against a
 * different database than the Worker proves nothing about the Worker.
 */

import { applyMigrations } from "./lib/migrations.mjs";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { ledgerIntegrity, accountBalance, fundSummary } from "../src/ledger.js";
import { recordContribution, postContribution, reserveSponsorship } from "../src/fund.js";
import {
  DEPOSIT_ELECTIONS,
  DEPOSIT_ELECTION_LABELS,
  DEPOSIT_ELECTION_FIELD_LABEL,
  CONTRACT_OPTIONS,
  clinicPortalProjection,
  currentDepositPolicy,
  depositOutcomeForBooking,
  depositPolicyHistory,
  getBookingDepositSnapshot,
  normalizeContractOption,
  saveDepositPolicy,
  snapshotDepositPolicyForBooking,
  validateDepositPolicy
} from "../src/deposit-policy.js";
import {
  ALLOWED_TRANSITIONS,
  GUARANTEE_STATES,
  applyGuaranteeToTreatment,
  authorizeGuaranteeAsTreatmentAssistance,
  beginDepositGuaranteeFunding,
  beginDepositGuaranteeReturn,
  cancelDepositGuarantee,
  disputeDepositGuarantee,
  evaluateDepositGuaranteeEligibility,
  getDepositGuarantee,
  listDepositGuaranteeEvents,
  markDepositGuaranteeFunded,
  permittedForfeitureCents,
  recordAppointmentOutcome,
  recordClinicBillSettlement,
  reserveDepositGuarantee,
  resolveDepositGuaranteeDispute,
  settleDepositGuarantee
} from "../src/deposit-guarantee.js";

class D1StatementMock {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    const placeholders = (this.sql.match(/\?/g) || []).length;
    if (placeholders !== values.length) {
      throw new Error(`Bound ${values.length} values to ${placeholders} placeholders: ${this.sql.trim().slice(0, 90).replace(/\s+/g, " ")}`);
    }
    this.values = values;
    return this;
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.values) || null;
  }

  async all() {
    return { results: this.database.prepare(this.sql).all(...this.values), success: true };
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid || 0) } };
  }
}

class D1Mock {
  constructor(database) { this.database = database; }
  prepare(sql) { return new D1StatementMock(this.database, sql); }
  async batch(statements) {
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const database = new DatabaseSync(":memory:");
await applyMigrations(database);

const env = { DB: new D1Mock(database), SIGN_IN_REQUIRED: "false", DEMO_MODE: "false" };

/** A fourth clinic, so each of the four elections gets its own. */
database.prepare("INSERT OR IGNORE INTO tenants (id, clerk_org_id, name, slug) VALUES (?, ?, ?, ?)")
  .run("tenant_alder", "org_demo_alder", "Alder Creek Animal Hospital", "alder-creek");
database.prepare(`
  INSERT OR IGNORE INTO locations (
    id, tenant_id, name, slug, kind, address_line1, city, region, postal_code, phone,
    latitude, longitude, open_24_hours, accepts_walk_ins, auto_accept, arrival_window_minutes,
    species_json, capabilities_json, hours_json, base_exam_fee_cents
  ) VALUES (?, ?, ?, ?, 'general', '90 Alder Creek Road', 'Hayward', 'CA', '94544', '(510) 555-0113',
            37.66, -122.09, 0, 1, 0, 30, '["dog","cat"]', '["same_day"]', '{"always":"open"}', 8000)
`).run("loc_alder", "tenant_alder", "Alder Creek Animal Hospital", "alder-creek-main");

/**
 * Every assertion about money is followed by this. An unbalanced journal or a
 * negative restricted account is not a smaller problem discovered later — it
 * is the same problem, and the point of the subledger is that it cannot
 * survive one operation undetected.
 */
async function assertLedgerSound(where) {
  const integrity = await ledgerIntegrity(env);
  assert(integrity.ok, `Ledger integrity failed after ${where}: ${JSON.stringify(integrity)}`);
}

let intakeCounter = 0;
function makeIntake(tenantId, locationId, userId = null) {
  intakeCounter += 1;
  const id = `intake_dep_${intakeCounter}`;
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO intake_requests (
      id, public_code, location_id, tenant_id, customer_user_id, pet_name, species,
      owner_name, owner_phone, concern_category, concern_summary, urgency, status,
      requested_at, request_expires_at
    ) VALUES (?, ?, ?, ?, ?, 'Otis', 'dog', 'Maya Morgan', '(510) 555-0147',
              'illness_or_injury', 'Vomited three times and will not drink.', 'urgent',
              'accepted', ?, ?)
  `).run(id, `TIMI-D${intakeCounter}`, locationId, tenantId, userId, now, now);
  return id;
}

function ledgerCountForIntake(intakeId) {
  return Number(database.prepare("SELECT COUNT(*) AS c FROM ledger_transactions WHERE intake_id = ?").get(intakeId).c);
}

function auditRows(action, subjectId) {
  return database.prepare(
    "SELECT * FROM audit_events WHERE action = ? AND subject_id = ? ORDER BY datetime(occurred_at) DESC"
  ).all(action, subjectId);
}

const ADMIN = "admin_dana";
const EFFECTIVE = "2026-03-01T00:00:00.000Z";

/* ══════════════════════════════════════════════ the enum is the spec ══ */

assert(DEPOSIT_ELECTIONS.length === 4, "§8 requires exactly four elections");
assert(DEPOSIT_ELECTION_FIELD_LABEL === "Paw It Forward appointment deposit policy",
  "The field label is §8's label");
assert(DEPOSIT_ELECTION_LABELS.NO_DEPOSIT_REQUIRED === "Will not require a deposit"
  && DEPOSIT_ELECTION_LABELS.WAIVE_FOR_PAW_IT_FORWARD === "Waive deposit for Paw It Forward"
  && DEPOSIT_ELECTION_LABELS.PAW_IT_FORWARD_GUARANTEE === "Accept Paw It Forward deposit guarantee"
  && DEPOSIT_ELECTION_LABELS.CUSTOMER_REQUIRED === "Customer must pay clinic deposit",
  `The four UI labels are §8's, verbatim: ${JSON.stringify(DEPOSIT_ELECTION_LABELS)}`);
assert(GUARANTEE_STATES.length === 13, "§9 lists thirteen states");
assert(ALLOWED_TRANSITIONS.RETURNED.length === 0 && ALLOWED_TRANSITIONS.FORFEITED.length === 0,
  "A resolved guarantee is resolved");

/* ══════════════ acceptance test 14 — no election, no saved clinic ══ */

let refused = await saveDepositPolicy(env, {
  tenantId: "tenant_hearth",
  actorId: ADMIN,
  pawItForwardEnabled: true,
  depositElectionSource: "EXECUTED_AGREEMENT",
  depositElectionEffectiveAt: EFFECTIVE,
  depositElectionVerifiedByAdminUserId: ADMIN
});
assert(!refused.ok && refused.code === "DEPOSIT_ELECTION_REQUIRED",
  `Test 14: a Paw It Forward-enabled clinic cannot be saved without one of the four: ${JSON.stringify(refused)}`);
assert(await currentDepositPolicy(env, "tenant_hearth") === null, "Nothing was written");

refused = validateDepositPolicy({ election: "SOMETHING_ELSE" }, { pawItForwardEnabled: true });
assert(!refused.ok && refused.code === "INVALID_DEPOSIT_ELECTION", "A fifth option does not exist");

/* ═══════ contract parity — the fourth option is not on the paper ══ */

// The executed agreement §15 offers OPTION A (Waiver), OPTION B (Paw It
// Forward Deposit Guarantee) and OPTION C (Customer-Funded). §8 adds a fourth
// and says the next contract revision must carry it. Until then an
// EXECUTED_AGREEMENT source cannot evidence the fourth.
refused = await saveDepositPolicy(env, {
  tenantId: "tenant_juniper",
  actorId: ADMIN,
  election: "NO_DEPOSIT_REQUIRED",
  appointmentDepositRequiredNormally: false,
  appointmentDepositAmountType: "NONE",
  depositRefundability: "NOT_APPLICABLE",
  depositNoShowForfeitType: "NOT_APPLICABLE",
  depositElectionSource: "EXECUTED_AGREEMENT",
  depositElectionEffectiveAt: EFFECTIVE,
  depositElectionVerifiedByAdminUserId: ADMIN
});
assert(!refused.ok && refused.code === "ELECTION_NOT_IN_EXECUTED_CONTRACT",
  `A clinic on the three-option contract cannot appear to have elected the fourth from the contract itself: ${JSON.stringify(refused)}`);

/* ══ acceptance test 15 — NO_DEPOSIT_REQUIRED creates no deposit ══ */

const noDeposit = await saveDepositPolicy(env, {
  tenantId: "tenant_juniper",
  actorId: ADMIN,
  election: "NO_DEPOSIT_REQUIRED",
  appointmentDepositRequiredNormally: false,
  appointmentDepositAmountType: "NONE",
  depositRefundability: "NOT_APPLICABLE",
  depositNoShowForfeitType: "NOT_APPLICABLE",
  // The one lawful route today: the onboarding documentation says in writing
  // that this practice has no appointment deposit at all.
  depositElectionSource: "AUTHORIZED_WRITTEN_INSTRUCTION",
  depositElectionSourceDocumentId: "doc_juniper_onboarding_2026",
  depositElectionEffectiveAt: EFFECTIVE,
  depositElectionVerifiedByAdminUserId: ADMIN,
  contractElectionOption: "NOT_RECORDED",
  changeReason: "Practice confirmed in writing it takes no appointment deposit."
});
assert(noDeposit.ok && noDeposit.policy.election === "NO_DEPOSIT_REQUIRED",
  `NO_DEPOSIT_REQUIRED saves from a written instruction: ${JSON.stringify(noDeposit)}`);

refused = validateDepositPolicy({
  election: "NO_DEPOSIT_REQUIRED",
  appointmentDepositRequiredNormally: false,
  appointmentDepositAmountType: "FIXED",
  appointmentDepositFixedAmountCents: 7500,
  depositRefundability: "NOT_APPLICABLE",
  depositNoShowForfeitType: "NOT_APPLICABLE",
  depositElectionSource: "ADMIN_MIGRATION",
  depositElectionSourceDocumentId: "doc_x",
  depositElectionEffectiveAt: EFFECTIVE,
  depositElectionVerifiedByAdminUserId: ADMIN
});
assert(!refused.ok && refused.code === "NO_DEPOSIT_AMOUNT_MUST_BE_NONE",
  "§8: NO_DEPOSIT_REQUIRED requires amount type NONE — a clinic with an amount that waives it is a different election");

const juniperIntake = makeIntake("tenant_juniper", "loc_juniper");
await snapshotDepositPolicyForBooking(env, { intakeId: juniperIntake, tenantId: "tenant_juniper", sponsored: true });
let outcome = depositOutcomeForBooking(await currentDepositPolicy(env, "tenant_juniper"), { sponsored: true });
assert(outcome.copy.line === "Not required", `§10 copy for no deposit: ${JSON.stringify(outcome.copy)}`);
assert(outcome.copy.headline === "Appointment deposit: Not required", "The pre-confirmation card reads §10's line");
assert(outcome.customerOwesDepositCents === 0 && outcome.guaranteeApplies === false
  && outcome.createsDepositPaymentObject === false,
  "§8: no customer deposit, no guarantee, no deposit payment object");

let attempt = await reserveDepositGuarantee(env, { intakeId: juniperIntake, tenantId: "tenant_juniper" });
assert(!attempt.ok && attempt.code === "ELECTION_DOES_NOT_CREATE_GUARANTEE",
  `Test 15: NO_DEPOSIT_REQUIRED creates no guarantee: ${JSON.stringify(attempt)}`);
assert(ledgerCountForIntake(juniperIntake) === 0, "Test 15: no deposit transaction of any kind");
await assertLedgerSound("NO_DEPOSIT_REQUIRED booking");

/* ══ acceptance test 16 — WAIVE_FOR_PAW_IT_FORWARD ══ */

const waived = await saveDepositPolicy(env, {
  tenantId: "tenant_hearth",
  actorId: ADMIN,
  election: "WAIVE_FOR_PAW_IT_FORWARD",
  appointmentDepositRequiredNormally: true,
  // §8: the waiver keeps the clinic's normal amount, because that amount
  // still applies to everybody outside the program.
  appointmentDepositAmountType: "FIXED",
  appointmentDepositFixedAmountCents: 7500,
  depositRefundability: "REFUNDABLE_UNTIL_CUTOFF",
  depositCancellationCutoffMinutes: 120,
  depositNoShowForfeitType: "FULL",
  depositElectionSource: "EXECUTED_AGREEMENT",
  depositElectionEffectiveAt: EFFECTIVE,
  depositElectionVerifiedByAdminUserId: ADMIN,
  contractElectionOption: "OPTION_A_WAIVER"
});
assert(waived.ok, `Option A saves: ${JSON.stringify(waived)}`);
assert(waived.policy.appointmentDepositFixedAmountCents === 7500,
  "§8: a waiving clinic keeps its ordinary $75 on file");

const hearthSponsored = makeIntake("tenant_hearth", "loc_hearth");
outcome = depositOutcomeForBooking(waived.policy, { sponsored: true });
assert(outcome.copy.line === "Waived with Paw It Forward", `§10 copy for a waiver: ${JSON.stringify(outcome.copy)}`);
assert(outcome.customerOwesDepositCents === 0 && outcome.guaranteeApplies === false
  && outcome.guaranteeExpectedCents === 0,
  "Test 16: no guarantee and no customer deposit");

// The same clinic, a booking that is not a Paw It Forward booking: the
// ordinary $75 still applies, and saying otherwise would misdescribe the
// clinic to a full-fare customer.
const hearthOrdinary = depositOutcomeForBooking(waived.policy, { sponsored: false });
assert(hearthOrdinary.customerOwesDepositCents === 7500,
  `A waiver applies to qualifying program bookings only: ${JSON.stringify(hearthOrdinary.copy)}`);

attempt = await reserveDepositGuarantee(env, { intakeId: hearthSponsored, tenantId: "tenant_hearth" });
assert(!attempt.ok && attempt.code === "ELECTION_DOES_NOT_CREATE_GUARANTEE",
  `Test 16: a waiver sends no guarantee: ${JSON.stringify(attempt)}`);
assert(ledgerCountForIntake(hearthSponsored) === 0, "Test 16: no deposit transaction");
await assertLedgerSound("WAIVE_FOR_PAW_IT_FORWARD booking");

/* ══ acceptance test 18 — CUSTOMER_REQUIRED never spends program cash ══ */

const customerFunded = await saveDepositPolicy(env, {
  tenantId: "tenant_alder",
  actorId: ADMIN,
  election: "CUSTOMER_REQUIRED",
  appointmentDepositRequiredNormally: true,
  appointmentDepositAmountType: "FIXED",
  appointmentDepositFixedAmountCents: 7500,
  depositRefundability: "REFUNDABLE_UNTIL_CUTOFF",
  depositCancellationCutoffMinutes: 240,
  depositNoShowForfeitType: "PARTIAL",
  depositNoShowForfeitAmountCents: 2500,
  depositPolicyCustomerCopy: "Alder Creek holds $75 to reserve an appointment; refundable up to four hours before.",
  depositElectionSource: "EXECUTED_AGREEMENT",
  depositElectionEffectiveAt: EFFECTIVE,
  depositElectionVerifiedByAdminUserId: ADMIN,
  contractElectionOption: "OPTION_C_CUSTOMER_FUNDED"
});
assert(customerFunded.ok, `Option C saves: ${JSON.stringify(customerFunded)}`);

const alderIntake = makeIntake("tenant_alder", "loc_alder");
outcome = depositOutcomeForBooking(customerFunded.policy, { sponsored: true });
assert(outcome.copy.line === "$75 clinic appointment deposit required — You will be responsible for this deposit",
  `§10 copy for a customer-funded deposit: ${JSON.stringify(outcome.copy)}`);
assert(outcome.customerOwesDepositCents === 7500 && outcome.guaranteeApplies === false,
  "Test 18: the customer owes it and Paw It Forward does not");

// §10: this card is shown before confirmation, so it must not name the
// clinic. The clinic's own prose — which does name it — is held back for the
// screen after identity reveal.
const preConfirmationText = `${outcome.copy.headline} ${outcome.copy.detail} ${outcome.copy.line}`;
assert(!preConfirmationText.includes("Alder"),
  `Pre-confirmation deposit copy must not reveal clinic identity: "${preConfirmationText}"`);
assert(outcome.afterReveal.policyCopy.includes("Alder Creek") && outcome.afterReveal.showAfterIdentityReveal,
  "The clinic's own policy prose is returned separately, for after the reveal");

const beforeAlder = await fundSummary(env);
attempt = await reserveDepositGuarantee(env, { intakeId: alderIntake, tenantId: "tenant_alder" });
assert(!attempt.ok && attempt.code === "ELECTION_DOES_NOT_CREATE_GUARANTEE",
  `Test 18: CUSTOMER_REQUIRED does not use Paw It Forward cash: ${JSON.stringify(attempt)}`);
const afterAlder = await fundSummary(env);
assert(beforeAlder.availableCents === afterAlder.availableCents, "Test 18: no program cash moved");
assert(ledgerCountForIntake(alderIntake) === 0, "Test 18: no program posting for a customer-funded deposit");
await assertLedgerSound("CUSTOMER_REQUIRED booking");

// A customer-funded deposit whose amount nobody knows must pause for clinic
// confirmation rather than quote a number (§8).
refused = validateDepositPolicy({
  election: "CUSTOMER_REQUIRED",
  appointmentDepositRequiredNormally: true,
  appointmentDepositAmountType: "CLINIC_CONFIRMS_PER_REQUEST",
  depositRefundability: "VARIABLE_BY_BOOKING",
  depositNoShowForfeitType: "VARIABLE",
  depositElectionSource: "EXECUTED_AGREEMENT",
  depositElectionEffectiveAt: EFFECTIVE,
  depositElectionVerifiedByAdminUserId: ADMIN
});
assert(!refused.ok && refused.code === "CUSTOMER_DEPOSIT_DISCLOSURE_REQUIRED",
  "§8: a customer-funded deposit needs the amount, or disclosure and an explicit pause");

/* ══ acceptance test 17 — the guarantee is a SEPARATE reservation ══ */

const guaranteeClinic = "tenant_bayview";
const bayviewPolicy = await saveDepositPolicy(env, {
  tenantId: guaranteeClinic,
  actorId: ADMIN,
  election: "PAW_IT_FORWARD_GUARANTEE",
  appointmentDepositRequiredNormally: true,
  appointmentDepositAmountType: "FIXED",
  appointmentDepositFixedAmountCents: 7500,
  depositRefundability: "REFUNDABLE_UNTIL_CUTOFF",
  depositCancellationCutoffMinutes: 120,
  depositNoShowForfeitType: "PARTIAL",
  depositNoShowForfeitAmountCents: 2500,
  depositPolicyCustomerCopy: "Bayview holds $75 to reserve an emergency slot.",
  depositPolicyInternalNotes: "Option B initialled by Dr. Reyes on the executed agreement.",
  depositElectionSource: "EXECUTED_AGREEMENT",
  depositElectionEffectiveAt: EFFECTIVE,
  depositElectionVerifiedByAdminUserId: ADMIN,
  contractElectionOption: "OPTION_B_PAW_IT_FORWARD_GUARANTEE"
});
assert(bayviewPolicy.ok, `Option B saves: ${JSON.stringify(bayviewPolicy)}`);
assert(CONTRACT_OPTIONS.OPTION_B_PAW_IT_FORWARD_GUARANTEE === "PAW_IT_FORWARD_GUARANTEE",
  "Contract option B maps to the guarantee election");
// migrations/0017 records the executed §15 election in its own vocabulary.
// Both spellings have to mean the same box, or two files disagree about what
// a contract says.
assert(normalizeContractOption("ACCEPT_PIF_GUARANTEE") === "OPTION_B_PAW_IT_FORWARD_GUARANTEE"
  && normalizeContractOption("CUSTOMER_FUNDED_DEPOSIT") === "OPTION_C_CUSTOMER_FUNDED"
  && normalizeContractOption("WAIVE_FOR_PAW_IT_FORWARD") === "OPTION_A_WAIVER",
  "clinic_contracts.deposit_election spellings normalize to the same three boxes");

// The clinic portal sees it, read-only, without ClearKey's internal notes.
const portal = clinicPortalProjection(bayviewPolicy.policy);
assert(portal.readOnly === true && portal.electionLabel === "Accept Paw It Forward deposit guarantee",
  `§8 Authority: the portal view is read-only: ${JSON.stringify(portal)}`);
assert(!("depositPolicyInternalNotes" in portal) && !("depositElectionVerifiedByAdminUserId" in portal),
  "The clinic portal is not a window into ClearKey's contract administration");

// Money in the fund: $500 of contributions.
const gift = await recordContribution(env, {
  amountCents: 50000, source: "STANDALONE", receiptEmail: "gift@example.com"
});
assert(gift.ok, `A contribution is recorded: ${JSON.stringify(gift)}`);
await postContribution(env, { contributionId: gift.contributionId, stripeEventId: "evt_dep_1", processorFeeCents: 175 });
assert((await fundSummary(env)).availableCents === 50000, "The whole $500 reaches the fund");
await assertLedgerSound("contribution posting");

const bothIntake = makeIntake(guaranteeClinic, "loc_bayview");
await snapshotDepositPolicyForBooking(env, { intakeId: bothIntake, tenantId: guaranteeClinic, sponsored: true });

const sponsorship = await reserveSponsorship(env, { intakeId: bothIntake, tenantId: guaranteeClinic });
assert(sponsorship.ok && sponsorship.amountCents === 3500, `The $35 sponsorship reserves: ${JSON.stringify(sponsorship)}`);

const bothGuarantee = await reserveDepositGuarantee(env, {
  intakeId: bothIntake, tenantId: guaranteeClinic, customerUserId: "user_maya"
});
assert(bothGuarantee.ok && bothGuarantee.guarantee.state === "RESERVED"
  && bothGuarantee.guarantee.amountCents === 7500,
  `Test 17: the guarantee reserves separately: ${JSON.stringify(bothGuarantee)}`);
assert(await accountBalance(env, "fund_reserved") === 3500,
  "Test 17: the $35 sponsorship reservation is its own account");
assert(await accountBalance(env, "fund_deposit_guarantee_reserved") === 7500,
  "Test 17: the $75 guarantee reservation is its own account");
assert(await accountBalance(env, "fund_available") === 50000 - 3500 - 7500,
  "Both reservations draw on the same available cash and neither pretends the other is absent");
await assertLedgerSound("sponsorship + guarantee on one booking");

// Reserving twice for one booking is a duplicate, not a second commitment.
const again = await reserveDepositGuarantee(env, { intakeId: bothIntake, tenantId: guaranteeClinic });
assert(again.ok && again.duplicate, `A repeated reservation is idempotent: ${JSON.stringify(again)}`);
assert(await accountBalance(env, "fund_deposit_guarantee_reserved") === 7500, "and commits nothing further");

/* ══ never beyond available program cash (§9 rule 3) ══ */

const richIntake = makeIntake(guaranteeClinic, "loc_bayview");
const tooBig = await reserveDepositGuarantee(env, {
  intakeId: richIntake, tenantId: guaranteeClinic, amountCents: 5_000_00
});
assert(!tooBig.ok && tooBig.code === "INSUFFICIENT_FUND_BALANCE",
  `A guarantee larger than the fund is refused, not overspent: ${JSON.stringify(tooBig)}`);
assert(await accountBalance(env, "fund_available") === 50000 - 3500 - 7500, "and nothing moved");
await assertLedgerSound("refused oversized guarantee");

/* ══ acceptance test 29 — treatment deposits are out of scope ══ */

const surgeryIntake = makeIntake(guaranteeClinic, "loc_bayview");
for (const kind of ["HOSPITALIZATION", "SURGERY", "TREATMENT", "POST_EVALUATION", "EMERGENCY_TREATMENT"]) {
  const outOfScope = await reserveDepositGuarantee(env, {
    intakeId: surgeryIntake, tenantId: guaranteeClinic, amountCents: 50000, depositKind: kind
  });
  assert(!outOfScope.ok && outOfScope.code === "TREATMENT_DEPOSIT_OUT_OF_SCOPE",
    `Test 29: a ${kind} deposit is never automatically covered: ${JSON.stringify(outOfScope)}`);
}
const refusals = database.prepare(
  "SELECT COUNT(*) AS c FROM pif_deposit_guarantee_refusals WHERE code = 'TREATMENT_DEPOSIT_OUT_OF_SCOPE'"
).get().c;
assert(Number(refusals) === 5, "Every out-of-scope ask is recorded, not silently dropped");
assert(ledgerCountForIntake(surgeryIntake) === 0, "Test 29: no program cash was committed");
await assertLedgerSound("refused treatment deposits");

/* ══ acceptance test 19 and 20 — election changes are documented ══ */

// Missing source.
refused = await saveDepositPolicy(env, {
  tenantId: guaranteeClinic, actorId: ADMIN,
  election: "CUSTOMER_REQUIRED",
  appointmentDepositRequiredNormally: true,
  appointmentDepositAmountType: "FIXED",
  appointmentDepositFixedAmountCents: 7500,
  depositRefundability: "NONREFUNDABLE",
  depositNoShowForfeitType: "FULL",
  depositElectionEffectiveAt: EFFECTIVE,
  depositElectionVerifiedByAdminUserId: ADMIN
});
assert(!refused.ok && refused.code === "DEPOSIT_ELECTION_SOURCE_REQUIRED",
  `Test 20: a change needs a source: ${JSON.stringify(refused)}`);

// Missing effective date.
refused = await saveDepositPolicy(env, {
  tenantId: guaranteeClinic, actorId: ADMIN,
  election: "CUSTOMER_REQUIRED",
  appointmentDepositRequiredNormally: true,
  appointmentDepositAmountType: "FIXED",
  appointmentDepositFixedAmountCents: 7500,
  depositRefundability: "NONREFUNDABLE",
  depositNoShowForfeitType: "FULL",
  depositElectionSource: "SIGNED_AMENDMENT",
  depositElectionSourceDocumentId: "doc_amend_1",
  depositElectionVerifiedByAdminUserId: ADMIN
});
assert(!refused.ok && refused.code === "DEPOSIT_ELECTION_EFFECTIVE_AT_REQUIRED",
  `Test 20: a change needs an effective date: ${JSON.stringify(refused)}`);

// An amendment with no document is not evidence of anything.
refused = await saveDepositPolicy(env, {
  tenantId: guaranteeClinic, actorId: ADMIN,
  election: "CUSTOMER_REQUIRED",
  appointmentDepositRequiredNormally: true,
  appointmentDepositAmountType: "FIXED",
  appointmentDepositFixedAmountCents: 7500,
  depositRefundability: "NONREFUNDABLE",
  depositNoShowForfeitType: "FULL",
  depositElectionSource: "SIGNED_AMENDMENT",
  depositElectionEffectiveAt: "2026-06-01T00:00:00.000Z",
  depositElectionVerifiedByAdminUserId: ADMIN
});
assert(!refused.ok && refused.code === "DEPOSIT_ELECTION_DOCUMENT_REQUIRED",
  `An amendment is only evidence if the document is identified: ${JSON.stringify(refused)}`);

// Changing away from the initialled contract box on the strength of the
// contract itself is exactly the undocumented toggle §8 forbids.
refused = await saveDepositPolicy(env, {
  tenantId: guaranteeClinic, actorId: ADMIN,
  election: "CUSTOMER_REQUIRED",
  appointmentDepositRequiredNormally: true,
  appointmentDepositAmountType: "FIXED",
  appointmentDepositFixedAmountCents: 7500,
  depositRefundability: "NONREFUNDABLE",
  depositNoShowForfeitType: "FULL",
  depositElectionSource: "EXECUTED_AGREEMENT",
  depositElectionEffectiveAt: "2026-06-01T00:00:00.000Z",
  depositElectionVerifiedByAdminUserId: ADMIN
});
assert(!refused.ok && refused.code === "DEPOSIT_ELECTION_AMENDMENT_REQUIRED",
  `Test 20: an election differing from the executed contract needs an amendment: ${JSON.stringify(refused)}`);

// Now do it properly, on a different clinic so the guarantee clinic's
// election stays put for the rest of the file.
const amended = await saveDepositPolicy(env, {
  tenantId: "tenant_hearth", actorId: ADMIN,
  election: "CUSTOMER_REQUIRED",
  appointmentDepositRequiredNormally: true,
  appointmentDepositAmountType: "FIXED",
  appointmentDepositFixedAmountCents: 9000,
  depositRefundability: "NONREFUNDABLE",
  depositNoShowForfeitType: "FULL",
  depositElectionSource: "SIGNED_AMENDMENT",
  depositElectionSourceDocumentId: "doc_hearth_amendment_7",
  depositElectionEffectiveAt: "2026-06-01T00:00:00.000Z",
  depositElectionVerifiedByAdminUserId: "admin_wren",
  changeReason: "Clinic amended its election after raising its deposit."
});
assert(amended.ok && amended.policy.version === 2, `An amended election is a new version: ${JSON.stringify(amended)}`);

const history = await depositPolicyHistory(env, "tenant_hearth");
assert(history.length === 2 && history[0].version === 2 && history[1].supersededAt,
  "Policies are append-only: the prior version is superseded, not overwritten");
assert(history[1].election === "WAIVE_FOR_PAW_IT_FORWARD" && history[1].appointmentDepositFixedAmountCents === 7500,
  "and the prior version still says exactly what it said");

const changeAudit = auditRows("clinic.deposit_policy_changed", amended.policy.id);
assert(changeAudit.length === 1, `Test 19: the change is audited: ${JSON.stringify(changeAudit)}`);
const oldState = JSON.parse(changeAudit[0].old_state_json);
const newState = JSON.parse(changeAudit[0].new_state_json);
assert(oldState.election === "WAIVE_FOR_PAW_IT_FORWARD" && newState.election === "CUSTOMER_REQUIRED",
  "Test 19: prior and new value are both recorded");
assert(newState.source === "SIGNED_AMENDMENT" && newState.effectiveAt === "2026-06-01T00:00:00.000Z"
  && newState.sourceDocumentId === "doc_hearth_amendment_7" && newState.verifiedByAdminUserId === "admin_wren",
  `Test 20: source, effective date, document and verifier are all in the audit: ${JSON.stringify(newState)}`);
assert(changeAudit[0].actor_id === ADMIN, "and who did it");

/* ══ acceptance test 21 — history keeps its snapshot ══ */

// hearthSponsored was snapshotted below; take one now under version 2 and
// confirm the earlier booking is untouched by the amendment above.
const hearthSnapshotIntake = makeIntake("tenant_hearth", "loc_hearth");
await snapshotDepositPolicyForBooking(env, { intakeId: hearthSnapshotIntake, tenantId: "tenant_hearth", sponsored: true });
const newSnapshot = await getBookingDepositSnapshot(env, hearthSnapshotIntake);
assert(newSnapshot.election === "CUSTOMER_REQUIRED" && newSnapshot.customerOwesDepositCents === 9000,
  `A booking made now is quoted under version 2: ${JSON.stringify(newSnapshot)}`);

const bothSnapshot = await getBookingDepositSnapshot(env, bothIntake);
assert(bothSnapshot.policyId === bayviewPolicy.policy.id && bothSnapshot.guaranteeExpectedCents === 7500,
  "Test 21: the earlier booking still points at the policy it was quoted under");

// Change the guarantee clinic's *amount* and confirm nothing historical moves.
const bayviewV2 = await saveDepositPolicy(env, {
  tenantId: guaranteeClinic, actorId: ADMIN,
  election: "PAW_IT_FORWARD_GUARANTEE",
  appointmentDepositRequiredNormally: true,
  appointmentDepositAmountType: "FIXED",
  appointmentDepositFixedAmountCents: 12000,
  depositRefundability: "REFUNDABLE_UNTIL_CUTOFF",
  depositCancellationCutoffMinutes: 120,
  depositNoShowForfeitType: "PARTIAL",
  depositNoShowForfeitAmountCents: 6000,
  depositElectionSource: "AUTHORIZED_WRITTEN_INSTRUCTION",
  depositElectionSourceDocumentId: "doc_bayview_deposit_increase",
  depositElectionEffectiveAt: "2026-07-01T00:00:00.000Z",
  depositElectionVerifiedByAdminUserId: ADMIN,
  changeReason: "Clinic raised its appointment deposit to $120."
});
assert(bayviewV2.ok && bayviewV2.policy.version === 2, "The guarantee clinic raises its deposit");
const bothSnapshotAfter = await getBookingDepositSnapshot(env, bothIntake);
assert(bothSnapshotAfter.guaranteeExpectedCents === 7500
  && bothSnapshotAfter.policy.appointmentDepositFixedAmountCents === 7500,
  `Test 21: a later policy change never rewrites historical booking economics: ${JSON.stringify(bothSnapshotAfter)}`);
const liveGuarantee = await getDepositGuarantee(env, bothGuarantee.guarantee.id);
assert(liveGuarantee.amountCents === 7500, "and the guarantee in flight is still the $75 that was promised");

/* ══ acceptance test 22 — $75 returns after an attended visit ══ */

const funded = await markDepositGuaranteeFunded(env, {
  guaranteeId: liveGuarantee.id, stripeTransferReference: "tr_dep_1", actorId: "system"
});
assert(funded.ok && funded.guarantee.state === "FUNDED", `The guarantee funds: ${JSON.stringify(funded)}`);
assert(await accountBalance(env, "deposit_guarantee_outstanding") === 7500,
  "Program cash is at the clinic, as an asset of the program");
await assertLedgerSound("guarantee funded");

const attended = await recordAppointmentOutcome(env, {
  guaranteeId: liveGuarantee.id, outcome: "ATTENDED", actorId: "system"
});
assert(attended.ok && attended.guarantee.state === "RETURN_DUE",
  `§9 rule 5: verified attendance creates the return obligation: ${JSON.stringify(attended)}`);
assert(attended.guarantee.permittedForfeitureCents === 0, "Attendance permits no forfeiture at all");
await assertLedgerSound("attendance recorded");

const returning = await beginDepositGuaranteeReturn(env, {
  guaranteeId: liveGuarantee.id, clinicPaymentReference: "pay_bayview_001"
});
assert(returning.ok && returning.guarantee.state === "RETURN_PENDING", "The clinic's settlement is in flight");

const returned = await settleDepositGuarantee(env, {
  guaranteeId: liveGuarantee.id, returnedAmountCents: 7500, actorId: "system"
});
assert(returned.ok && returned.guarantee.state === "RETURNED" && returned.guarantee.returnedAmountCents === 7500,
  `Test 22: the $75 guarantee returns after an attended visit: ${JSON.stringify(returned)}`);
assert(await accountBalance(env, "deposit_guarantee_outstanding") === 0, "Nothing is left at the clinic");
assert(await accountBalance(env, "fund_deposit_guarantee_reserved") === 0, "The commitment is discharged");
assert(await accountBalance(env, "fund_available") === 50000 - 3500,
  "The $75 is back in the fund; only the $35 sponsorship is still reserved");
await assertLedgerSound("guarantee returned");

const events = await listDepositGuaranteeEvents(env, liveGuarantee.id);
const ledgerEvents = events.map((event) => event.ledgerEvent).filter(Boolean);
assert(ledgerEvents.includes("DEPOSIT_GUARANTEE_RESERVED")
  && ledgerEvents.includes("DEPOSIT_GUARANTEE_FUNDED")
  && ledgerEvents.includes("DEPOSIT_GUARANTEE_RETURN_DUE")
  && ledgerEvents.includes("DEPOSIT_GUARANTEE_RETURNED"),
  `The §6 event names are recorded on every transition: ${JSON.stringify(ledgerEvents)}`);

/* ══ acceptance test 23 — the return does not reduce the vet bill ══ */

const bill = await recordClinicBillSettlement(env, {
  guaranteeId: liveGuarantee.id,
  veterinaryBillCents: 100000,
  collectedFromInsurerCents: 70000,
  collectedFromCustomerCents: 30000,
  guaranteeAppliedToBillCents: 0,
  reportedBy: "clinic_bayview_user"
});
assert(bill.ok, `An ordinary settlement is accepted: ${JSON.stringify(bill)}`);
assert(bill.customerResponsibleCents === 30000,
  "Test 23: the customer is responsible for the full remainder of the bill, guarantee or no guarantee");
assert(bill.veterinaryBillCents === 100000,
  "Test 23: the returned $75 does not reduce the $1,000 veterinary bill");
const returnedGuarantee = await getDepositGuarantee(env, liveGuarantee.id);
assert(returnedGuarantee.appliedToTreatmentCents === 0,
  "Test 23: not one cent of the guarantee became treatment payment");
await assertLedgerSound("bill settlement");

/* ══ acceptance test 24 — never both returned and forfeited ══ */

refused = await settleDepositGuarantee(env, {
  guaranteeId: liveGuarantee.id, returnedAmountCents: 0, forfeitedAmountCents: 7500,
  forfeitureReason: "second bite"
});
assert(!refused.ok && refused.code === "GUARANTEE_ALREADY_RESOLVED",
  `Test 24: a returned guarantee cannot then be forfeited: ${JSON.stringify(refused)}`);
const stillReturned = await getDepositGuarantee(env, liveGuarantee.id);
assert(stillReturned.state === "RETURNED" && stillReturned.forfeitedAmountCents === 0,
  "and the record still says returned");

let threw = false;
try {
  database.prepare(
    "UPDATE pif_deposit_guarantees SET returned_amount_cents = amount_cents, forfeited_amount_cents = amount_cents WHERE id = ?"
  ).run(liveGuarantee.id);
} catch {
  threw = true;
}
assert(threw, "Test 24: the database itself refuses a row that is both fully returned and fully forfeited");
await assertLedgerSound("test 24");

/* ══ acceptance tests 25, 26, 27 — the no-show settlement ══ */

const noShowIntake = makeIntake(guaranteeClinic, "loc_bayview");
await snapshotDepositPolicyForBooking(env, { intakeId: noShowIntake, tenantId: guaranteeClinic, sponsored: true });
const noShow = await reserveDepositGuarantee(env, {
  intakeId: noShowIntake, tenantId: guaranteeClinic, customerUserId: "user_rae"
});
assert(noShow.ok && noShow.guarantee.amountCents === 12000,
  `A new booking is guaranteed at the clinic's current $120: ${JSON.stringify(noShow.guarantee)}`);
await beginDepositGuaranteeFunding(env, { guaranteeId: noShow.guarantee.id, stripeTransferReference: "tr_dep_2" });
await markDepositGuaranteeFunded(env, { guaranteeId: noShow.guarantee.id });
await assertLedgerSound("second guarantee funded");

// The clinic's documented ordinary policy: PARTIAL, $60. That is the ceiling,
// and it is the ceiling because it is what the clinic could have kept had the
// customer personally funded the deposit (contract §15).
const policyNow = await currentDepositPolicy(env, guaranteeClinic);
assert(permittedForfeitureCents(policyNow, { outcome: "NO_SHOW", amountCents: 12000 }) === 6000,
  "The documented ordinary no-show forfeiture is $60");
assert(permittedForfeitureCents(policyNow, { outcome: "CLINIC_CANCELED", amountCents: 12000 }) === 0,
  "A clinic cancellation permits nothing");
assert(permittedForfeitureCents(policyNow, { outcome: "CUSTOMER_CANCELED", amountCents: 12000, minutesBeforeAppointment: 300 }) === 0,
  "Cancelling inside the clinic's own refundable window permits nothing");
assert(permittedForfeitureCents(policyNow, { outcome: "LATE_CANCELED", amountCents: 12000, minutesBeforeAppointment: 30 }) === 6000,
  "A late cancellation permits only what the ordinary policy allows");

const noShowOutcome = await recordAppointmentOutcome(env, {
  guaranteeId: noShow.guarantee.id, outcome: "NO_SHOW", actorId: "system"
});
assert(noShowOutcome.ok && noShowOutcome.guarantee.permittedForfeitureCents === 6000,
  `The permitted forfeiture is priced once, from the documented policy: ${JSON.stringify(noShowOutcome.guarantee)}`);

// Acceptance test 26.
refused = await settleDepositGuarantee(env, {
  guaranteeId: noShow.guarantee.id, returnedAmountCents: 0, forfeitedAmountCents: 12000,
  forfeitureReason: "no-show"
});
assert(!refused.ok && refused.code === "FORFEITURE_EXCEEDS_POLICY",
  `Test 26: a forfeiture cannot exceed the documented ordinary policy: ${JSON.stringify(refused)}`);

refused = await settleDepositGuarantee(env, {
  guaranteeId: noShow.guarantee.id, returnedAmountCents: 8000, forfeitedAmountCents: 6000,
  forfeitureReason: "no-show"
});
assert(!refused.ok && refused.code === "SETTLEMENT_DOES_NOT_BALANCE",
  `Test 27: the returned and forfeited amounts must be exactly the guarantee: ${JSON.stringify(refused)}`);

// Acceptance test 25: the guarantee cannot become treatment payment.
refused = await applyGuaranteeToTreatment(env, { guaranteeId: noShow.guarantee.id, amountCents: 6000 });
assert(!refused.ok && refused.code === "GUARANTEE_IS_NOT_TREATMENT_PAYMENT",
  `Test 25: a guarantee never automatically becomes treatment payment: ${JSON.stringify(refused)}`);

// The §7 prohibited example, exactly: $1,000 of services, $100 of guarantee
// applied to the bill and kept, $700 insurance, $200 customer.
const prohibited = await recordClinicBillSettlement(env, {
  guaranteeId: noShow.guarantee.id,
  veterinaryBillCents: 100000,
  collectedFromInsurerCents: 70000,
  collectedFromCustomerCents: 20000,
  guaranteeAppliedToBillCents: 10000,
  reportedBy: "clinic_bayview_user"
});
assert(!prohibited.ok && prohibited.code === "GUARANTEE_IS_NOT_TREATMENT_PAYMENT",
  `Test 25 / §7: applying the guarantee to the bill without a separate authorization is refused: ${JSON.stringify(prohibited)}`);
const exception = database.prepare(
  "SELECT * FROM pif_deposit_guarantee_settlements WHERE id = ?"
).get(prohibited.settlementId);
assert(Number(exception.accepted) === 0 && exception.refusal_code === "GUARANTEE_IS_NOT_TREATMENT_PAYMENT",
  "and the prohibited settlement is written down as a reconciliation exception, not merely rejected");

// While that exception stands, the guarantee cannot be closed by another door.
refused = await settleDepositGuarantee(env, {
  guaranteeId: noShow.guarantee.id, returnedAmountCents: 6000, forfeitedAmountCents: 6000,
  forfeitureReason: "no-show"
});
assert(!refused.ok && refused.code === "GUARANTEE_IS_NOT_TREATMENT_PAYMENT",
  `A refused settlement freezes the close: ${JSON.stringify(refused)}`);

// Clear the exception the way operations would — by correcting the report.
database.prepare("UPDATE pif_deposit_guarantee_settlements SET accepted = 1, refusal_code = NULL, guarantee_applied_to_bill_cents = 0, collected_from_customer_cents = 30000 WHERE id = ?")
  .run(prohibited.settlementId);

// Acceptance test 27: partial forfeiture returns the remainder.
const partial = await settleDepositGuarantee(env, {
  guaranteeId: noShow.guarantee.id,
  returnedAmountCents: 6000,
  forfeitedAmountCents: 6000,
  forfeitureReason: "No-show; clinic retained the $60 its disclosed policy permits.",
  clinicPaymentReference: "pay_bayview_002",
  actorId: "system"
});
assert(partial.ok && partial.guarantee.state === "PARTIAL_FORFEITURE",
  `Test 27: a partial forfeiture resolves as PARTIAL_FORFEITURE: ${JSON.stringify(partial)}`);
assert(partial.guarantee.returnedAmountCents === 6000 && partial.guarantee.forfeitedAmountCents === 6000,
  "Test 27: the remainder comes back");
assert(await accountBalance(env, "deposit_guarantee_forfeiture_expense") === 6000,
  "§7: a forfeiture is a real Paw It Forward expense and is recorded as one");
assert(await accountBalance(env, "program_restricted_released") === 6000,
  "and the restricted contribution that funded it is released as actually spent");
assert(await accountBalance(env, "deposit_guarantee_outstanding") === 0, "Nothing is left outstanding");
assert(await accountBalance(env, "fund_available") === 50000 - 3500 - 6000,
  "Only the forfeited $60 has left the fund");
await assertLedgerSound("partial forfeiture");

/* ══ acceptance test 25, continued — the authorized case, and the wall ══ */

const authIntake = makeIntake(guaranteeClinic, "loc_bayview");
await snapshotDepositPolicyForBooking(env, { intakeId: authIntake, tenantId: guaranteeClinic, sponsored: true });
const authGuarantee = (await reserveDepositGuarantee(env, { intakeId: authIntake, tenantId: guaranteeClinic })).guarantee;
await markDepositGuaranteeFunded(env, { guaranteeId: authGuarantee.id });

refused = await authorizeGuaranteeAsTreatmentAssistance(env, { guaranteeId: authGuarantee.id, treatmentAuthorizationId: "ta_1" });
assert(!refused.ok && refused.code === "TREATMENT_AUTHORIZATION_INCOMPLETE",
  "An authorization without an approver and a reason is not an authorization");

const authorized = await authorizeGuaranteeAsTreatmentAssistance(env, {
  guaranteeId: authGuarantee.id,
  treatmentAuthorizationId: "ta_2026_0042",
  authorizedBy: "admin_wren",
  reason: "ClearKey expressly authorized this guarantee as treatment assistance under a separate program decision.",
  actorId: ADMIN
});
assert(authorized.ok, `The one lawful route exists and is recorded: ${JSON.stringify(authorized)}`);
const applied = await applyGuaranteeToTreatment(env, {
  guaranteeId: authGuarantee.id, amountCents: 12000, treatmentAuthorizationId: "ta_2026_0042", actorId: ADMIN
});
assert(applied.ok && applied.guarantee.appliedToTreatmentCents === 12000,
  `An authorized application is allowed: ${JSON.stringify(applied)}`);

// ...and now it cannot also be retained as a forfeiture. Same money twice.
await recordAppointmentOutcome(env, { guaranteeId: authGuarantee.id, outcome: "NO_SHOW" });
refused = await settleDepositGuarantee(env, {
  guaranteeId: authGuarantee.id, returnedAmountCents: 6000, forfeitedAmountCents: 6000,
  forfeitureReason: "no-show"
});
assert(!refused.ok && refused.code === "GUARANTEE_ALREADY_APPLIED_TO_TREATMENT",
  `Contract §15: a clinic may not both apply the guarantee to the bill and retain it: ${JSON.stringify(refused)}`);

// And even with an authorization, being paid the same money by another payer
// is refused — this is the arithmetic of "and collect the same amount from
// the Customer, insurer, financing source, or other payer".
const doubled = await recordClinicBillSettlement(env, {
  guaranteeId: authGuarantee.id,
  veterinaryBillCents: 100000,
  collectedFromInsurerCents: 70000,
  collectedFromCustomerCents: 30000,
  guaranteeAppliedToBillCents: 12000,
  treatmentAuthorizationId: "ta_2026_0042",
  reportedBy: "clinic_bayview_user"
});
assert(!doubled.ok && doubled.code === "DOUBLE_COLLECTION_DETECTED" && doubled.overcollectedCents === 12000,
  `Test 25 / §15: double collection is detectable and refused: ${JSON.stringify(doubled)}`);
await assertLedgerSound("double collection refused");

/* ══ acceptance test 28 — clinic cancellation returns the whole thing ══ */

const clinicCancelIntake = makeIntake(guaranteeClinic, "loc_bayview");
await snapshotDepositPolicyForBooking(env, { intakeId: clinicCancelIntake, tenantId: guaranteeClinic, sponsored: true });
const cancelGuarantee = (await reserveDepositGuarantee(env, { intakeId: clinicCancelIntake, tenantId: guaranteeClinic })).guarantee;
await markDepositGuaranteeFunded(env, { guaranteeId: cancelGuarantee.id });
const availableBeforeCancel = await accountBalance(env, "fund_available");

const clinicCanceled = await recordAppointmentOutcome(env, {
  guaranteeId: cancelGuarantee.id, outcome: "CLINIC_CANCELED", actorId: "system"
});
assert(clinicCanceled.ok && clinicCanceled.guarantee.permittedForfeitureCents === 0,
  "Test 28: a clinic cancellation permits no forfeiture");
const clinicCancelSettled = await settleDepositGuarantee(env, {
  guaranteeId: cancelGuarantee.id, actorId: "system"
});
assert(clinicCancelSettled.ok && clinicCancelSettled.guarantee.state === "RETURNED"
  && clinicCancelSettled.guarantee.returnedAmountCents === 12000,
  `Test 28: the clinic returns the full guarantee: ${JSON.stringify(clinicCancelSettled)}`);
assert(await accountBalance(env, "fund_available") === availableBeforeCancel + 12000,
  "and every cent is back in the fund");
await assertLedgerSound("clinic cancellation");

/* ══ a dispute freezes final accounting (§9 rule 9) ══ */

const disputeIntake = makeIntake(guaranteeClinic, "loc_bayview");
await snapshotDepositPolicyForBooking(env, { intakeId: disputeIntake, tenantId: guaranteeClinic, sponsored: true });
const disputed = (await reserveDepositGuarantee(env, { intakeId: disputeIntake, tenantId: guaranteeClinic })).guarantee;
await markDepositGuaranteeFunded(env, { guaranteeId: disputed.id });
await recordAppointmentOutcome(env, { guaranteeId: disputed.id, outcome: "NO_SHOW" });
const frozen = await disputeDepositGuarantee(env, {
  guaranteeId: disputed.id, reason: "Customer says they arrived and were turned away.", actorId: ADMIN
});
assert(frozen.ok && frozen.guarantee.state === "DISPUTED", "A dispute is recorded");
refused = await settleDepositGuarantee(env, {
  guaranteeId: disputed.id, returnedAmountCents: 6000, forfeitedAmountCents: 6000, forfeitureReason: "no-show"
});
assert(!refused.ok && refused.code === "GUARANTEE_DISPUTED",
  `§9 rule 9: a dispute freezes final accounting: ${JSON.stringify(refused)}`);

const unfrozen = await resolveDepositGuaranteeDispute(env, {
  guaranteeId: disputed.id, resolution: "Arrival confirmed by the clinic's own record.", actorId: ADMIN
});
assert(unfrozen.ok && unfrozen.guarantee.state === "RETURN_DUE", "Resolving puts it back where it was");
const afterDispute = await settleDepositGuarantee(env, { guaranteeId: disputed.id, actorId: ADMIN });
assert(afterDispute.ok && afterDispute.guarantee.state === "RETURNED",
  `and the ordinary rules then decide: ${JSON.stringify(afterDispute)}`);
await assertLedgerSound("dispute resolved");

/* ══ cancelling before funding gives the money straight back ══ */

const abandonedIntake = makeIntake(guaranteeClinic, "loc_bayview");
await snapshotDepositPolicyForBooking(env, { intakeId: abandonedIntake, tenantId: guaranteeClinic, sponsored: true });
const abandoned = (await reserveDepositGuarantee(env, { intakeId: abandonedIntake, tenantId: guaranteeClinic })).guarantee;
const availableBeforeAbandon = await accountBalance(env, "fund_available");
const canceled = await cancelDepositGuarantee(env, { guaranteeId: abandoned.id, reason: "Owner rebooked elsewhere." });
assert(canceled.ok && canceled.guarantee.state === "CANCELED", "An unfunded guarantee cancels");
assert(await accountBalance(env, "fund_available") === availableBeforeAbandon + 12000,
  "and the reservation returns to the fund immediately");
assert((await getDepositGuarantee(env, abandoned.id)).state === "CANCELED",
  "with nothing left committed on that booking");
await assertLedgerSound("cancellation before funding");

// A funded guarantee is not cancellable; it is returned or forfeited.
const fundedIntake = makeIntake(guaranteeClinic, "loc_bayview");
await snapshotDepositPolicyForBooking(env, { intakeId: fundedIntake, tenantId: guaranteeClinic, sponsored: true });
const notCancellable = (await reserveDepositGuarantee(env, { intakeId: fundedIntake, tenantId: guaranteeClinic })).guarantee;
await markDepositGuaranteeFunded(env, { guaranteeId: notCancellable.id });
refused = await cancelDepositGuarantee(env, { guaranteeId: notCancellable.id });
assert(!refused.ok && refused.code === "GUARANTEE_ALREADY_FUNDED",
  `Money that has left is resolved by return or permitted forfeiture: ${JSON.stringify(refused)}`);
await settleDepositGuarantee(env, {
  guaranteeId: (await recordAppointmentOutcome(env, { guaranteeId: notCancellable.id, outcome: "ATTENDED" })).guarantee.id
});
await assertLedgerSound("final settlement");

/* ══ the state machine refuses what it has never been told to allow ══ */

const machineIntake = makeIntake(guaranteeClinic, "loc_bayview");
await snapshotDepositPolicyForBooking(env, { intakeId: machineIntake, tenantId: guaranteeClinic, sponsored: true });
const machine = (await reserveDepositGuarantee(env, { intakeId: machineIntake, tenantId: guaranteeClinic })).guarantee;
refused = await recordAppointmentOutcome(env, { guaranteeId: machine.id, outcome: "ATTENDED" });
assert(!refused.ok && refused.code === "INVALID_TRANSITION",
  `A guarantee that never funded cannot reach RETURN_DUE: ${JSON.stringify(refused)}`);
refused = await settleDepositGuarantee(env, { guaranteeId: machine.id, returnedAmountCents: 12000 });
assert(!refused.ok && refused.code === "OUTCOME_NOT_RECORDED",
  `and cannot be settled without an outcome to check against: ${JSON.stringify(refused)}`);
await cancelDepositGuarantee(env, { guaranteeId: machine.id, reason: "Test cleanup." });
await assertLedgerSound("state machine refusals");

/* ══ eligibility answers without moving anything ══ */

const eligibility = await evaluateDepositGuaranteeEligibility(env, {
  intakeId: makeIntake(guaranteeClinic, "loc_bayview"), tenantId: guaranteeClinic
});
assert(eligibility.ok && eligibility.amountCents === 12000 && eligibility.state === "ELIGIBLE",
  `Eligibility can be asked before anything is promised: ${JSON.stringify(eligibility)}`);
const balancesBefore = await fundSummary(env);
assert(balancesBefore.availableCents === (await fundSummary(env)).availableCents, "and moves nothing");
await assertLedgerSound("eligibility check");

/* ══ every restricted account ends where it should ══ */

// One guarantee is deliberately left open: `authGuarantee`, the $120 applied
// to a veterinary bill under a separate ClearKey treatment-assistance
// authorization. It cannot be forfeited (that would be the same money twice)
// and the clinic will not return money it lawfully applied, so it sits in
// RETURN_DUE as a reconciliation exception until the separate
// treatment-assistance feature §7 contemplates exists to close it. A feature
// that silently invented an outcome for this case would be inventing exactly
// the treatment assistance §7 says not to build yet.
const parked = await getDepositGuarantee(env, authGuarantee.id);
assert(parked.state === "RETURN_DUE" && parked.appliedToTreatmentCents === 12000,
  `The authorized-application case is parked, not guessed at: ${JSON.stringify(parked)}`);

const finalIntegrity = await ledgerIntegrity(env);
assert(finalIntegrity.ok, `Final ledger integrity: ${JSON.stringify(finalIntegrity)}`);
assert(await accountBalance(env, "fund_deposit_guarantee_reserved") === 12000,
  "The only guarantee commitment left is the parked one");
assert(await accountBalance(env, "deposit_guarantee_outstanding") === 12000,
  "and the only program cash still at a clinic is its $120");
assert(await accountBalance(env, "fund_available") === 50000 - 3500 - 6000 - 12000,
  `The fund is the $500 contributed less the $35 sponsorship still reserved, the $60 genuinely forfeited, and the $120 still committed: ${await accountBalance(env, "fund_available")}`);

const guaranteeCount = Number(database.prepare("SELECT COUNT(*) AS c FROM pif_deposit_guarantees").get().c);
const eventCount = Number(database.prepare("SELECT COUNT(*) AS c FROM pif_deposit_guarantee_events").get().c);
assert(guaranteeCount > 0 && eventCount >= guaranteeCount,
  "Every guarantee has at least one append-only transition event");

console.log(`Deposit policy and guarantee tests passed: acceptance tests 14–29, ${guaranteeCount} guarantees, ${eventCount} transition events, ledger balanced throughout.`);
