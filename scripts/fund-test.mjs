/**
 * Paw It Forward fund tests.
 *
 * Spec §19 acceptance tests 8–15 in order, plus the four this program cannot
 * ship without: two concurrent reservations must not overspend the fund, a
 * replayed completion must not recognize revenue twice, a founding clinic's
 * sponsored booking must cost the fund $10 and not $35, and the journal must
 * still balance after every single operation above.
 *
 * Same harness as scripts/e2e.mjs — node:sqlite behind a D1-shaped mock —
 * because a fund test that runs against a different database than the Worker
 * proves nothing about the Worker.
 */

import { applyMigrations } from "./lib/migrations.mjs";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { fundSummary, ledgerIntegrity, accountBalance } from "../src/ledger.js";
import { createContributionPayment } from "../src/fund.js";
import { sponsorshipQuote, activePricingPolicy, validateContributionAmount } from "../src/pricing.js";
import {
  checkFundAvailability,
  consumeSponsorship,
  contributorHistory,
  createStandaloneContribution,
  expireStaleReservations,
  fundControls,
  fundImpact,
  getContributorHistory,
  getFundImpact,
  getReservation,
  postContribution,
  recordContribution,
  releaseSponsorship,
  reserveSponsorship,
  reverseSponsorship
} from "../src/fund.js";

class D1StatementMock {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    // node:sqlite silently binds a missing parameter as NULL, and D1 is not
    // much louder. A guard whose last `?` never got a value reads as
    // `id = NULL`, which is false, so the write quietly does nothing and the
    // caller reports a duplicate. Counting here turns that into a stack
    // trace — it is how the first version of consumeSponsorship was caught.
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

/**
 * Every assertion about money is followed by this. An unbalanced journal or
 * a negative restricted account is not a smaller problem discovered later —
 * it is the same problem, and the point of the subledger is that it cannot
 * survive one operation undetected.
 */
async function assertLedgerSound(where) {
  const integrity = await ledgerIntegrity(env);
  assert(integrity.ok, `Ledger integrity failed after ${where}: ${JSON.stringify(integrity)}`);
}

let intakeCounter = 0;
function makeIntake(tenantId = "tenant_hearth", locationId = "loc_hearth", userId = null) {
  intakeCounter += 1;
  const id = `intake_test_${intakeCounter}`;
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO intake_requests (
      id, public_code, location_id, tenant_id, customer_user_id, pet_name, species,
      owner_name, owner_phone, concern_category, concern_summary, urgency, status,
      requested_at, request_expires_at
    ) VALUES (?, ?, ?, ?, ?, 'Otis', 'dog', 'Maya Morgan', '(510) 555-0147',
              'illness_or_injury', 'Vomited three times and will not drink.', 'urgent',
              'accepted', ?, ?)
  `).run(id, `TIMI-T${intakeCounter}`, locationId, tenantId, userId, now, now);
  return id;
}

async function setControls(patch) {
  const entries = Object.entries(patch);
  database.prepare(
    `UPDATE fund_controls SET ${entries.map(([key]) => `${key} = ?`).join(", ")} WHERE id = 1`
  ).run(...entries.map(([, value]) => value));
}

/* ══════════════════════════════════ economics come from the policy ══ */

const policy = await activePricingPolicy(env);
assert(policy.ownerFeeCents === 1500 && policy.clinicFeeCents === 2500 && policy.timiMatchCents === 1000,
  `Migration 0021 must land the $15 owner fee prospectively, without disturbing the rest of the launch policy: ${JSON.stringify(policy)}`);

const standardQuote = await sponsorshipQuote(env, "tenant_hearth");
assert(standardQuote.fundContributionCents === 3000, `A standard sponsored connection costs the fund $30: ${JSON.stringify(standardQuote)}`);
assert(standardQuote.timiMatchCents === 1000, "Tími matches $10 on a standard sponsored connection");
assert(standardQuote.applicableValueCents === 4000, "$15 owner + $25 clinic is the value being waived");

/* ══════════════════════════ whole dollars, minimums, and maximums ══ */

// Acceptance tests 3 and 4, at the validation boundary the fund actually
// uses. $9 is refused on the portal and $10 is taken; cents are refused
// everywhere; the cap is enforced.
assert(validateContributionAmount(900, { standalone: true, policy }).code === "CONTRIBUTION_TOO_SMALL",
  "The public portal rejects $9");
assert(validateContributionAmount(1000, { standalone: true, policy }).ok, "The public portal accepts $10");
assert(validateContributionAmount(1050, { standalone: true, policy }).code === "WHOLE_DOLLARS_ONLY",
  "Contributions are whole dollars, so $10.50 is refused");
assert(validateContributionAmount(0, { standalone: true, policy }).code === "CONTRIBUTION_REQUIRED",
  "$0 is not a contribution");

let refused = await recordContribution(env, { amountCents: 900, source: "STANDALONE", receiptEmail: "gift@example.com" });
assert(!refused.ok && refused.code === "CONTRIBUTION_TOO_SMALL", `recordContribution must refuse $9 standalone: ${JSON.stringify(refused)}`);

refused = await recordContribution(env, { amountCents: 250, source: "STANDALONE", receiptEmail: "gift@example.com" });
assert(!refused.ok && refused.code === "WHOLE_DOLLARS_ONLY", "A $2.50 contribution fails on the whole-dollar rule first");

refused = await recordContribution(env, { amountCents: 1050, source: "BOOKING", receiptEmail: "gift@example.com" });
assert(!refused.ok && refused.code === "WHOLE_DOLLARS_ONLY", "Booking-time contributions reject cents");

refused = await recordContribution(env, { amountCents: 2500000000, source: "STANDALONE", receiptEmail: "gift@example.com" });
assert(!refused.ok && refused.code === "CONTRIBUTION_TOO_LARGE", "The configured maximum is enforced");

refused = await recordContribution(env, { amountCents: 2000, source: "STANDALONE" });
assert(!refused.ok && refused.code === "RECEIPT_EMAIL_REQUIRED", "A contribution needs somewhere to send the receipt (§5.4)");

refused = await recordContribution(env, {
  amountCents: 2000, source: "STANDALONE", receiptEmail: "gift@example.com",
  recognition: "ORGANIZATION"
});
assert(!refused.ok && refused.code === "RECOGNITION_NAME_REQUIRED", "Named recognition needs a name");

/* ══════════════════════════════ contributions post to the fund ══ */

// A guest gives $200. Anonymous in public, fully identified internally, and
// the receipt address is required — acceptance test 5.
const guest = await recordContribution(env, {
  amountCents: 20000,
  source: "STANDALONE",
  receiptEmail: "Guest@Example.com",
  termsVersion: "paw-it-forward-2026-08"
});
assert(guest.ok && guest.status === "DRAFT", `A valid guest contribution must be recorded: ${JSON.stringify(guest)}`);
assert(guest.contributorToken.startsWith("ctr_"), "A guest gets a pseudonymous contributor token");
assert(guest.disclosure === "This contribution is not represented by TímiNOW as tax deductible.",
  "The non-deductibility disclosure travels with the draft (§3)");

let draftRow = database.prepare("SELECT * FROM contributions WHERE id = ?").get(guest.contributionId);
assert(draftRow.recognition === "ANONYMOUS", "Guests are publicly anonymous by default (§5.4)");
assert(draftRow.receipt_email === "guest@example.com", "The receipt address is stored, normalized");
assert(draftRow.contribution_schedule_id === null, "Recurring is not implemented; the column stays null (§5.4)");
assert(draftRow.status === "DRAFT", "Nothing is posted before Stripe confirms");

const allocation = database.prepare("SELECT * FROM payment_allocations WHERE contribution_id = ?").get(guest.contributionId);
assert(allocation.purpose === "FUND_CONTRIBUTION" && Number(allocation.amount_cents) === 20000,
  "The allocation is written before confirmation and says what the money is for");

let before = await fundSummary(env);
assert(before.availableCents === 0, "A draft contribution has moved no money");
await assertLedgerSound("contribution draft");

// The money arrives, and Stripe takes $0.88 of it. Acceptance test 2: the
// fee reduces Tími's cash and shows up as expense — the contributor's $200
// reaches the fund whole.
const posted = await postContribution(env, {
  contributionId: guest.contributionId,
  stripeEventId: "evt_contrib_1",
  processorFeeCents: 88
});
assert(posted.ok && !posted.duplicate, `The contribution must post: ${JSON.stringify(posted)}`);

let summary = await fundSummary(env);
assert(summary.availableCents === 20000, `The whole $200 reaches fund_available, not $199.12: ${summary.availableCents}`);
assert(summary.processorFeesCents === 88, "The processor fee is its own expense");
assert(await accountBalance(env, "processor_cash") === 20000 - 88, "Cash is net of the fee; the fund is not");
await assertLedgerSound("contribution posting");

// Acceptance test 6: a redelivered success webhook creates no second journal.
const replayed = await postContribution(env, {
  contributionId: guest.contributionId,
  stripeEventId: "evt_contrib_1_redelivered",
  processorFeeCents: 88
});
assert(replayed.ok && replayed.duplicate, `A replayed contribution posting must be a duplicate, not a second credit: ${JSON.stringify(replayed)}`);
summary = await fundSummary(env);
assert(summary.availableCents === 20000, "A duplicate webhook must not double the fund");
assert(summary.processorFeesCents === 88, "A duplicate webhook must not double the processor fee either");
const journalCount = database.prepare(
  "SELECT COUNT(*) AS c FROM ledger_transactions WHERE contribution_id = ? AND kind = 'contribution_posted'"
).get(guest.contributionId).c;
assert(Number(journalCount) === 1, "Exactly one contribution_posted transaction exists");
await assertLedgerSound("replayed contribution posting");

/* ══ acceptance test 8 — approval alone moves no fund money ══ */

const availability = await checkFundAvailability(env, "tenant_hearth");
assert(availability.canFund === true, `The fund can pay for a standard connection: ${JSON.stringify(availability)}`);
assert(availability.requiredCents === 3000, "The check asks the pricing policy, not a constant");
assert(availability.availableCents === 20000, "Availability is the posted balance less the liquidity reserve");

summary = await fundSummary(env);
assert(summary.availableCents === 20000 && summary.reservedCents === 0,
  "Acceptance test 8: checking availability — and approving assistance — moves nothing");
await assertLedgerSound("availability check");

/* ══ acceptance test 9 — confirming moves $30 available → reserved ══ */

const intakeA = makeIntake("tenant_hearth", "loc_hearth", "user_alice");
const reservation = await reserveSponsorship(env, {
  intakeId: intakeA,
  tenantId: "tenant_hearth",
  eligibilityDecisionId: "elig_alice_1",
  applicantUserId: "user_alice"
});
assert(reservation.ok && !reservation.duplicate, `Reservation must succeed: ${JSON.stringify(reservation)}`);
assert(reservation.amountCents === 3000, "Acceptance test 9: exactly $30 is reserved");
assert(reservation.matchCents === 1000, "Tími's $10 is recorded on the reservation");

summary = await fundSummary(env);
assert(summary.availableCents === 17000 && summary.reservedCents === 3000,
  `Acceptance test 9: $30 moves from available to reserved: ${JSON.stringify(summary)}`);
assert(summary.consumedLifetimeCents === 0, "Reserving recognizes no revenue");
await assertLedgerSound("reservation");

// At most one live reservation per booking — the partial unique index.
const doubled = await reserveSponsorship(env, { intakeId: intakeA, tenantId: "tenant_hearth", applicantUserId: "user_alice" });
assert(doubled.ok && doubled.duplicate && doubled.reason === "ALREADY_RESERVED",
  `A second reservation for the same booking must be refused as a duplicate: ${JSON.stringify(doubled)}`);
summary = await fundSummary(env);
assert(summary.reservedCents === 3000, "A double-submitted confirmation must not reserve twice");
await assertLedgerSound("duplicate reservation attempt");

/* ══ acceptance test 11 — cancellation returns all $30, recognizes $0 ══ */

const released = await releaseSponsorship(env, { reservationId: reservation.reservationId, reason: "OWNER_CANCELLED" });
assert(released.ok && released.state === "RELEASED_CANCELLED", `Release must succeed: ${JSON.stringify(released)}`);
summary = await fundSummary(env);
assert(summary.availableCents === 20000 && summary.reservedCents === 0,
  "Acceptance test 11: cancellation returns the whole reservation to available");
assert(summary.consumedLifetimeCents === 0, "Acceptance test 11: no sponsored revenue is recognized");
await assertLedgerSound("release");

const releasedTwice = await releaseSponsorship(env, { reservationId: reservation.reservationId, reason: "OWNER_CANCELLED" });
assert(releasedTwice.ok && releasedTwice.duplicate, "Release is idempotent");
summary = await fundSummary(env);
assert(summary.availableCents === 20000, "A repeated release must not credit the fund twice");
await assertLedgerSound("repeated release");

/* ══ acceptance test 10 — two concurrent reservations cannot overspend ══ */

// Squeeze the fund to exactly one standard sponsorship using the liquidity
// reserve, then race two bookings at it. Exactly one may win; the loser must
// be refused rather than served from money that is not there.
await setControls({ min_liquidity_reserve_cents: 20000 - 3000 });
const squeezed = await checkFundAvailability(env, "tenant_hearth");
assert(squeezed.availableCents === 3000 && squeezed.canFund, "Exactly one sponsorship's worth is committable");

const intakeB = makeIntake("tenant_hearth", "loc_hearth", "user_bob");
const intakeC = makeIntake("tenant_hearth", "loc_hearth", "user_cleo");
const raced = await Promise.all([
  reserveSponsorship(env, { intakeId: intakeB, tenantId: "tenant_hearth", applicantUserId: "user_bob" }),
  reserveSponsorship(env, { intakeId: intakeC, tenantId: "tenant_hearth", applicantUserId: "user_cleo" })
]);
const winners = raced.filter((outcome) => outcome.ok && !outcome.duplicate);
const losers = raced.filter((outcome) => !outcome.ok);
assert(winners.length === 1 && losers.length === 1,
  `Acceptance test 10: exactly one of two concurrent reservations may win: ${JSON.stringify(raced)}`);
assert(losers[0].code === "INSUFFICIENT_FUND_BALANCE",
  `The loser is refused for the honest reason: ${JSON.stringify(losers[0])}`);

summary = await fundSummary(env);
assert(summary.reservedCents === 3000, `Acceptance test 10: the fund reserved $30 once, not twice: ${JSON.stringify(summary)}`);
assert(summary.availableCents === 17000, "The fund was not overspent");
const liveReservations = Number(database.prepare("SELECT COUNT(*) AS c FROM fund_reservations WHERE state = 'RESERVED'").get().c);
assert(liveReservations === 1, "Only one reservation row is live");
await assertLedgerSound("concurrent reservation race");

await setControls({ min_liquidity_reserve_cents: 0 });
const winner = winners[0];

/* ══ acceptance test 12 — completion moves exactly $30, once, plus the match ══ */

const consumed = await consumeSponsorship(env, { reservationId: winner.reservationId, stripeEventId: "evt_complete_1" });
assert(consumed.ok && !consumed.duplicate, `Consumption must succeed: ${JSON.stringify(consumed)}`);
assert(consumed.amountCents === 3000 && consumed.matchCents === 1000, "Acceptance test 12: $30 consumed, $10 matched");

summary = await fundSummary(env);
assert(summary.reservedCents === 0, "The reservation is gone from reserved");
assert(summary.consumedLifetimeCents === 3000, `Acceptance test 12: exactly $30 becomes sponsored revenue: ${summary.consumedLifetimeCents}`);
assert(summary.matchLifetimeCents === 1000, "Acceptance test 12: the $10 match is recorded as a metric");
assert(summary.availableCents === 17000, "Consumption takes nothing further from available");
await assertLedgerSound("consumption");

// The match must be a memo pair: no cash, no revenue, and nothing taken from
// the restricted fund. Its other side is contributed capital, so the two
// halves net to zero and neither touches fund_available or fund_reserved.
const matchTransaction = database.prepare(
  "SELECT id FROM ledger_transactions WHERE idempotency_key = ?"
).get(`sponsorship_match:${winner.reservationId}`);
assert(matchTransaction, "The match posts its own transaction, separate from the $30");
const matchLines = database.prepare(
  "SELECT account_code, debit_cents, credit_cents FROM ledger_entries WHERE transaction_id = ? ORDER BY account_code"
).all(matchTransaction.id);
assert(matchLines.length === 2, "The match is a two-line memo entry");
const matchAccounts = matchLines.map((line) => line.account_code).sort();
assert(matchAccounts.join(",") === "timinow_match_contributed,timinow_program_match",
  `The match must not touch fund, cash, or revenue accounts: ${matchAccounts.join(",")}`);
assert(await accountBalance(env, "timinow_match_contributed") === 1000,
  "The match's credit side is contributed capital, not revenue");
assert(await accountBalance(env, "sponsored_access_revenue") === 3000,
  "Revenue is the fund's $30 only — the match never inflates it");
assert(await accountBalance(env, "owner_platform_fee_revenue") === 0
  && await accountBalance(env, "clinic_platform_fee_revenue") === 0,
  "Acceptance test 14: a sponsored booking charges the owner $0 and the clinic $0");

/* ══ acceptance test 13 — replayed completion recognizes revenue once ══ */

const replayedCompletion = await consumeSponsorship(env, { reservationId: winner.reservationId, stripeEventId: "evt_complete_1_again" });
assert(replayedCompletion.ok && replayedCompletion.duplicate,
  `Acceptance test 13: a replayed completion is a duplicate: ${JSON.stringify(replayedCompletion)}`);
summary = await fundSummary(env);
assert(summary.consumedLifetimeCents === 3000, "Acceptance test 13: revenue is recognized once, not twice");
assert(summary.matchLifetimeCents === 1000, "The match is recorded once as well");
assert(Number(database.prepare("SELECT COUNT(*) AS c FROM sponsorships").get().c) === 1,
  "One completed connection produced one sponsorship row");
await assertLedgerSound("replayed completion");

/* ══ a founding clinic's sponsorship costs the fund $5, not $30 ══ */
//
// $15 owner fee + $0 founding clinic fee = $15 of real value waived. Tími's
// match is still capped at $10 (min(timiMatchCents, applicableValueCents)),
// so the fund supplies the remaining $5 — less than it did before the owner
// fee cut, because there is less real value here to waive in the first
// place. Inventing a $25 clinic fee nobody would have paid, to keep this
// number looking like it did before, is exactly what both specs forbid.

database.prepare(
  "INSERT OR REPLACE INTO clinic_pricing_assignments (tenant_id, plan, good_standing) VALUES ('tenant_juniper', 'FOUNDING', 1)"
).run();

const foundingQuote = await sponsorshipQuote(env, "tenant_juniper");
assert(foundingQuote.clinicPlan === "FOUNDING" && foundingQuote.clinicFeeCents === 0,
  "A founding clinic pays Tími nothing normally");
assert(foundingQuote.applicableValueCents === 1500,
  "Only $15 of real value is waived — inventing a $25 clinic fee nobody would have paid is the failure mode");
assert(foundingQuote.fundContributionCents === 500 && foundingQuote.timiMatchCents === 1000,
  `A founding sponsorship asks the fund for $5: ${JSON.stringify(foundingQuote)}`);

const foundingAvailability = await checkFundAvailability(env, "tenant_juniper");
assert(foundingAvailability.requiredCents === 500, "The availability check quotes $5 for a founding clinic");

const intakeD = makeIntake("tenant_juniper", "loc_juniper", "user_dana");
const foundingReservation = await reserveSponsorship(env, {
  intakeId: intakeD, tenantId: "tenant_juniper", applicantUserId: "user_dana"
});
assert(foundingReservation.ok && foundingReservation.amountCents === 500,
  `A founding sponsorship reserves $5, not $30: ${JSON.stringify(foundingReservation)}`);
assert(foundingReservation.applicableValueCents === 1500, "The waived value is frozen on the reservation");

summary = await fundSummary(env);
assert(summary.availableCents === 16500 && summary.reservedCents === 500, "Only $5 leaves available");
await assertLedgerSound("founding-clinic reservation");

const foundingConsumed = await consumeSponsorship(env, { reservationId: foundingReservation.reservationId });
assert(foundingConsumed.ok && foundingConsumed.amountCents === 500 && foundingConsumed.matchCents === 1000,
  "A founding sponsored connection costs the fund $5 and Tími $10");
summary = await fundSummary(env);
assert(summary.consumedLifetimeCents === 3500, "$30 + $5 of community money has now been consumed");
assert(summary.matchLifetimeCents === 2000, "Two connections, two $10 matches");
await assertLedgerSound("founding-clinic consumption");

/* ══ acceptance test 15 — public impact counts consumption only ══ */

// Two consumed connections so far, both consumed just now. The delay window
// alone must keep them off the public page, and the aggregation threshold
// must keep them off it even once the delay has passed.
let impact = await fundImpact(env);
assert(impact.published === false, "Fresh consumption is not published immediately (§5.6 delay)");

await setControls({ public_metrics_min_connections: 2, public_metrics_delay_hours: 24 });
impact = await fundImpact(env);
assert(impact.published === false, "The 24-hour delay still hides connections consumed a moment ago");

// Backdate two completions past the delay window, and add a live reservation
// that must never be counted.
const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
database.prepare("UPDATE sponsorships SET consumed_at = ?").run(threeDaysAgo);

const intakeE = makeIntake("tenant_hearth", "loc_hearth", "user_erin");
const uncountedReservation = await reserveSponsorship(env, {
  intakeId: intakeE, tenantId: "tenant_hearth", applicantUserId: "user_erin"
});
assert(uncountedReservation.ok, "A live reservation exists while the impact page is read");

impact = await fundImpact(env);
assert(impact.published === true, `Two settled connections meet the threshold: ${JSON.stringify(impact)}`);
assert(impact.completedConnections === 2,
  `Acceptance test 15: only consumed sponsorships count — the live reservation must not appear: ${impact.completedConnections}`);
assert(impact.communityDollarsConsumedCents === 3500, "Community dollars consumed is $30 + $5");
assert(impact.timiMatchTotalCents === 2000, "The Tími match total is $10 per completed connection");
assert(!/treatment cost|vet bill/i.test(impact.explanation) || /do not pay veterinary treatment/i.test(impact.explanation),
  "The impact copy must never imply the fund pays for veterinary care");
await assertLedgerSound("impact read");

/* ══════════════════════════ expiry sweep and controlled reversal ══ */

// Age the live reservation past its TTL and sweep it.
database.prepare("UPDATE fund_reservations SET expires_at = ? WHERE id = ?")
  .run(new Date(Date.now() - 60_000).toISOString(), uncountedReservation.reservationId);
const swept = await expireStaleReservations(env);
assert(swept.ok && swept.released === 1, `The sweep must release the stale reservation: ${JSON.stringify(swept)}`);
const sweptReservation = await getReservation(env, uncountedReservation.reservationId);
assert(sweptReservation.state === "RELEASED_EXPIRED", "An expired reservation is released, not consumed");
summary = await fundSummary(env);
assert(summary.reservedCents === 0, "The sweep returns the money to available");
assert(summary.consumedLifetimeCents === 3500, "The sweep recognizes no revenue");
await assertLedgerSound("expiry sweep");

// A reversal needs a reason and a named actor, and only a consumed
// sponsorship can be reversed.
let badReversal = await reverseSponsorship(env, { reservationId: winner.reservationId, actorId: "ops_dana" });
assert(!badReversal.ok && badReversal.code === "REVERSAL_REASON_REQUIRED", "A reversal without a reason is refused");
badReversal = await reverseSponsorship(env, { reservationId: uncountedReservation.reservationId, reason: "oops", actorId: "ops_dana" });
assert(!badReversal.ok && badReversal.code === "RESERVATION_NOT_REVERSIBLE", "A released reservation cannot be reversed");

const reversed = await reverseSponsorship(env, {
  reservationId: winner.reservationId,
  reason: "Clinic confirmed the visit against the wrong booking.",
  actorId: "ops_dana"
});
assert(reversed.ok && reversed.state === "REVERSED_ERROR", `Controlled reversal must succeed: ${JSON.stringify(reversed)}`);
summary = await fundSummary(env);
assert(summary.consumedLifetimeCents === 500, "The reversal unwinds the $30 of recognized revenue");
assert(summary.matchLifetimeCents === 1000, "The reversal unwinds that connection's match metric too");
assert(summary.availableCents === 20000 - 500, "The reversed $30 is restored to available; the founding $5 stays consumed");
await assertLedgerSound("reversal");

const reversedAgain = await reverseSponsorship(env, {
  reservationId: winner.reservationId, reason: "Same reason.", actorId: "ops_dana"
});
assert(reversedAgain.ok && reversedAgain.duplicate, "Reversal is idempotent");
await assertLedgerSound("repeated reversal");

// The reversal drops the settled count from two to one, and the aggregation
// threshold immediately withholds the whole page rather than publishing a
// number derived from a single household.
impact = await fundImpact(env);
assert(impact.published === false && impact.reason === "BELOW_AGGREGATION_THRESHOLD",
  `One remaining connection falls back below the threshold: ${JSON.stringify(impact)}`);

await setControls({ public_metrics_min_connections: 1 });
impact = await fundImpact(env);
assert(impact.published === true && impact.completedConnections === 1 && impact.communityDollarsConsumedCents === 500,
  `A reversed completion leaves the public count: ${JSON.stringify(impact)}`);
assert(impact.timiMatchTotalCents === 1000, "…and takes its $10 match out of the total with it");

/* ══════════════════════════════════ pause, caps, household limit ══ */

await setControls({ assistance_paused: 1 });
const paused = await checkFundAvailability(env, "tenant_hearth");
assert(!paused.canFund && paused.reason === "ASSISTANCE_PAUSED", "The pause switch stops new assistance");
const intakeF = makeIntake("tenant_hearth", "loc_hearth", "user_fred");
const pausedReservation = await reserveSponsorship(env, { intakeId: intakeF, tenantId: "tenant_hearth", applicantUserId: "user_fred" });
assert(!pausedReservation.ok && pausedReservation.code === "ASSISTANCE_PAUSED", "A paused program reserves nothing");

// The pause preserves existing reservations: the founding sponsorship
// consumed above is untouched, and nobody is retroactively charged.
summary = await fundSummary(env);
assert(summary.consumedLifetimeCents === 500, "Pausing does not unwind what was already consumed");
await setControls({ assistance_paused: 0 });

await setControls({ max_daily_reserved_cents: 100 });
const cappedIntake = makeIntake("tenant_hearth", "loc_hearth", "user_gil");
const capped = await reserveSponsorship(env, { intakeId: cappedIntake, tenantId: "tenant_hearth", applicantUserId: "user_gil" });
assert(!capped.ok && capped.code === "DAILY_CAP_REACHED", `The daily cap refuses the reservation: ${JSON.stringify(capped)}`);
await setControls({ max_daily_reserved_cents: 100000 });

await setControls({ max_monthly_reserved_cents: 100 });
const monthlyIntake = makeIntake("tenant_hearth", "loc_hearth", "user_ida");
const monthly = await reserveSponsorship(env, { intakeId: monthlyIntake, tenantId: "tenant_hearth", applicantUserId: "user_ida" });
assert(!monthly.ok && monthly.code === "MONTHLY_CAP_REACHED", `The monthly cap refuses the reservation: ${JSON.stringify(monthly)}`);
await setControls({ max_monthly_reserved_cents: 2000000 });

// One sponsored connection per household per rolling year: user_dana already
// has a consumed founding sponsorship.
const repeatIntake = makeIntake("tenant_hearth", "loc_hearth", "user_dana");
const repeat = await reserveSponsorship(env, { intakeId: repeatIntake, tenantId: "tenant_hearth", applicantUserId: "user_dana" });
assert(!repeat.ok, `A second sponsorship inside the household window is refused: ${JSON.stringify(repeat)}`);
await assertLedgerSound("controls");

/* ══════════════════════════════════════════ contributor history ══ */

const mine = await recordContribution(env, {
  amountCents: 3500,
  source: "STANDALONE",
  contributorUserId: "user_helen",
  receiptEmail: "helen@example.com",
  recognition: "FIRST_NAME_LAST_INITIAL",
  recognitionName: "Helen R."
});
assert(mine.ok, `A signed-in contribution must record: ${JSON.stringify(mine)}`);
await postContribution(env, { contributionId: mine.contributionId, stripeEventId: "evt_contrib_2" });

const history = await contributorHistory(env, "user_helen");
assert(history.contributions.length === 1 && history.totalContributedCents === 3500,
  `A contributor sees their own giving: ${JSON.stringify(history)}`);
assert(history.contributions[0].recognition === "FIRST_NAME_LAST_INITIAL", "The recognition preference is visible to its owner");

const otherHistory = await contributorHistory(env, "user_someone_else");
assert(otherHistory.contributions.length === 0, "A contributor never sees anyone else's contributions");
assert((await contributorHistory(env, null)).contributions.length === 0, "An anonymous read returns nothing");
await assertLedgerSound("contributor history");

/* ══════════════════════════════════════════════ HTTP handlers ══ */

const jsonRequest = (body) => new Request("https://timi.example/api/fund/contributions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body)
});

let response = await createStandaloneContribution(jsonRequest({ amountCents: 2000, receiptEmail: "portal@example.com" }), env, null);
assert(response.status === 422, "The portal requires explicit consent to the program terms");
assert((await response.json()).error.code === "TERMS_CONSENT_REQUIRED", "…and says which consent is missing");

response = await createStandaloneContribution(jsonRequest({ amountCents: 900, receiptEmail: "portal@example.com", consent: true }), env, null);
assert(response.status === 422 && (await response.json()).error.code === "CONTRIBUTION_TOO_SMALL",
  "Acceptance test 4: the portal refuses $9");

response = await createStandaloneContribution(
  jsonRequest({ amountCents: 1000, receiptEmail: "portal@example.com", consent: true, termsVersion: "paw-it-forward-2026-08" }),
  env, null
);
assert(response.status === 201, "Acceptance test 4: the portal accepts $10");
const created = (await response.json()).contribution;
assert(created.status === "DRAFT" && created.contributorToken.startsWith("ctr_"),
  "A guest contribution comes back as a draft with a pseudonymous token");

response = await createStandaloneContribution(new Request("https://timi.example/api/fund/contributions"), env, null);
assert(response.status === 405, "Only POST creates a contribution");

response = await getFundImpact(new Request("https://timi.example/api/fund/impact"), env);
assert(response.status === 200, "The impact endpoint is public");
const impactBody = (await response.json()).impact;
assert(impactBody.completedConnections === 1, "The public endpoint serves the same consumption-only count");

response = await getContributorHistory(new Request("https://timi.example/api/fund/contributions"), env, null);
assert(response.status === 401, "Contribution history needs a signed-in contributor");

response = await getContributorHistory(
  new Request("https://timi.example/api/fund/contributions"), env, { userId: "user_helen" }
);
assert(response.status === 200, "A signed-in contributor may read their own history");
assert((await response.json()).contributions.length === 1, "…and sees exactly their own contributions");

/* ------------------------------------------------ the booking-time gift --- */

// The optional Paw It Forward gift folded into the customer's one combined
// booking charge (src/booking-payment.js). The chips in the app re-price the
// order server-side, so what these prove is the server contract: a gift is
// an allocation plus a contributions row before any money, a changed gift
// retires the quoted order rather than mutating a PaymentIntent's amount,
// and a paid gift posts to the restricted fund exactly once.
{
  const { ensureBookingPaymentOrder, markBookingPaymentOrderStatus } = await import("../src/booking-payment.js");
  // payment_orders.intake_id is a real foreign key, so the intake exists
  // first — against the seeded Hearth & Paw clinic, like the e2e's own.
  for (const id of ["intake_gift", "intake_gift_invalid"]) {
    database.prepare(`
      INSERT INTO intake_requests (
        id, public_code, location_id, tenant_id, pet_name, species, owner_name, owner_phone,
        concern_category, concern_summary, urgency, status, requested_at, request_expires_at, customer_user_id
      ) VALUES (?, ?, 'loc_hearth', 'tenant_hearth', 'Biscuit', 'dog', 'Gift Tester', '+15105550100',
        'vomiting_or_diarrhea', 'Vomited twice since 7 AM and will not drink.', 'same_day', 'accepted',
        datetime('now'), datetime('now', '+1 hour'), 'user_gift')
    `).run(id, `TIMI-${id.toUpperCase().slice(-4)}`);
  }
  const intake = { id: "intake_gift", customerUserId: "user_gift", tenantId: "tenant_hearth" };

  // $15 fee + $5 gift, one order, split written down as allocations.
  let result = await ensureBookingPaymentOrder(env, { intake, contributionCents: 500 });
  assert(result.ok && result.order.totalCents === 2000, `A $5 gift joins the $15 fee in one order (${JSON.stringify(result)})`);
  const giftLine = result.order.allocations.find((line) => line.purpose === "FUND_CONTRIBUTION");
  assert(giftLine && giftLine.amountCents === 500, "The gift is its own allocation, at its own amount");
  const firstOrderId = result.order.id;
  const giftRow = database.prepare("SELECT source, status FROM contributions WHERE payment_order_id = ?").get(firstOrderId);
  assert(giftRow && giftRow.source === "BOOKING", "A booking gift gets a contributions row the ledger can post from");

  // A poll — no gift decision — reuses the order untouched.
  result = await ensureBookingPaymentOrder(env, { intake });
  assert(result.ok && result.order.id === firstOrderId && result.order.totalCents === 2000, "A poll never re-prices the order");

  // Changing the gift retires the merely-quoted order and re-prices.
  result = await ensureBookingPaymentOrder(env, { intake, contributionCents: 200 });
  assert(result.ok && result.order.id !== firstOrderId && result.order.totalCents === 1700, "A changed gift is a new order at the new total");
  assert(database.prepare("SELECT status FROM payment_orders WHERE id = ?").get(firstOrderId).status === "CANCELLED", "The old quote is cancelled, not left charging the old amount");
  assert(database.prepare("SELECT status FROM contributions WHERE payment_order_id = ?").get(firstOrderId).status === "FAILED", "The old gift row fails with its order");

  // Whole dollars only — the same rule as the standalone portal.
  const invalid = await ensureBookingPaymentOrder(env, { intake: { ...intake, id: "intake_gift_invalid" }, contributionCents: 250 });
  assert(!invalid.ok && invalid.code === "WHOLE_DOLLARS_ONLY", "A $2.50 gift is refused, not rounded");

  // Paid: the gift posts to the restricted fund, and a redelivered webhook
  // posts nothing further.
  const beforeCents = (await fundSummary(env)).availableCents;
  await markBookingPaymentOrderStatus(env, { paymentOrderId: result.order.id, status: "PAID", stripeEventId: "evt_booking_gift" });
  assert((await fundSummary(env)).availableCents === beforeCents + 200, "A paid booking gift credits fund_available");
  await markBookingPaymentOrderStatus(env, { paymentOrderId: result.order.id, status: "PAID", stripeEventId: "evt_booking_gift" });
  assert((await fundSummary(env)).availableCents === beforeCents + 200, "A redelivered PAID posts the gift once");
  assert(database.prepare("SELECT status FROM contributions WHERE payment_order_id = ?").get(result.order.id).status === "POSTED", "The gift row is POSTED once the money is real");
  await assertLedgerSound("the booking-time gift");

  // A grant approved *after* the order was quoted re-prices it on the next
  // poll — the "I need help paying" flow runs from the payment screen, so
  // an approval that could not reach the standing quote would change
  // nothing the applicant can see. The gift they had chosen is carried.
  const sponsoredIntake = { id: "intake_gift_invalid", customerUserId: "user_gift2", tenantId: "tenant_hearth" };
  let sponsored = await ensureBookingPaymentOrder(env, { intake: sponsoredIntake, contributionCents: 300 });
  assert(sponsored.ok && sponsored.order.totalCents === 1800, "Before approval: fee plus gift");
  const preGrantOrderId = sponsored.order.id;
  database.prepare("INSERT INTO eligibility_applications (id, applicant_user_id) VALUES ('app_gift2', 'user_gift2')").run();
  database.prepare(`
    INSERT INTO eligibility_decisions (id, application_id, decision, pathway, policy_id, policy_version, engine_version, decided_at)
    VALUES ('dec_gift2', 'app_gift2', 'APPROVED', 'BENEFIT_LETTER', 'policy_test', 1, 'test', datetime('now'))
  `).run();
  database.prepare(`
    INSERT INTO eligibility_grants (id, decision_id, application_id, user_id, expires_at)
    VALUES ('grant_gift2', 'dec_gift2', 'app_gift2', 'user_gift2', datetime('now', '+30 days'))
  `).run();
  sponsored = await ensureBookingPaymentOrder(env, { intake: sponsoredIntake });
  assert(sponsored.ok && sponsored.order.id !== preGrantOrderId, "Approval retires the fee-charging quote");
  assert(sponsored.order.totalCents === 300, `The re-priced order is the carried gift alone (${sponsored.order.totalCents})`);
  assert(!sponsored.order.allocations.some((line) => line.purpose === "OWNER_PLATFORM_FEE"), "No fee line survives an active grant");
  assert(sponsored.order.allocations.some((line) => line.purpose === "FUND_CONTRIBUTION" && line.amountCents === 300), "The chosen gift rides across the re-price");
  await assertLedgerSound("the sponsorship re-price");
}

/* ══════════════════════════════════════════════════ final proof ══ */

await assertLedgerSound("the whole run");
const finalIntegrity = await ledgerIntegrity(env);
assert(finalIntegrity.unbalanced.length === 0, "No unbalanced transaction survived the run");
assert(finalIntegrity.negativeRestricted.length === 0, "No restricted account went negative");

const controls = await fundControls(env);
assert(controls.reservationTtlMinutes === 60, "The seeded reservation TTL is one hour");
assert(controls.perHouseholdVisitsPerYear === 1, "The seeded household frequency is one visit per year");

const tableChecks = ["contributions", "fund_reservations", "sponsorships", "fund_controls"];
for (const table of tableChecks) {
  const count = Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
  assert(count > 0, `${table} should contain fund test data`);
}

const transactions = Number(database.prepare("SELECT COUNT(*) AS c FROM ledger_transactions").get().c);
/* ------------------------------------------- the contribution payment call --- */

// Minting the charge is separate from creating the contribution: a
// contributor who abandons the payment sheet leaves a DRAFT row and no
// charge, which is the honest record of what happened.
{
  const draft = await recordContribution(env, { amountCents: 2000, source: "STANDALONE", receiptEmail: "gift@example.com" });
  assert(draft.ok, "A $20 standalone contribution is valid");

  const post = (id) => new Request(`https://timi.example/api/fund/contributions/${id}/payment`, { method: "POST" });

  // With no Stripe key the caller is told plainly. A portal must never be
  // able to show a success page for a payment that did not happen.
  let response = await createContributionPayment(post(draft.contributionId), env, null, draft.contributionId);
  let body = await response.json();
  assert(response.status === 200 && body.mode === "demo", `An unconfigured deployment must say so: ${JSON.stringify(body)}`);
  assert(body.clientSecret === null, "The demo path must not invent a client secret");
  assert(/no card was charged/i.test(body.message), "The demo path must say no card was charged");

  // Nothing has been posted to the fund. A created PaymentIntent is not money
  // anybody has given.
  const beforeCents = (await fundSummary(env)).availableCents;
  await createContributionPayment(post(draft.contributionId), env, null, draft.contributionId);
  assert((await fundSummary(env)).availableCents === beforeCents, "Starting a payment must not credit the fund");

  response = await createContributionPayment(post("contribution_nope"), env, null, "contribution_nope");
  assert(response.status === 404, "An unknown contribution is a 404");

  // A contribution attached to an account belongs to that account.
  const owned = await recordContribution(env, { amountCents: 2000, source: "STANDALONE", contributorUserId: "user_maya", receiptEmail: "maya@example.com" });
  response = await createContributionPayment(post(owned.contributionId), env, { userId: "user_dev" }, owned.contributionId);
  assert(response.status === 403, "One account must not be able to pay another's contribution");
  response = await createContributionPayment(post(owned.contributionId), env, { userId: "user_maya" }, owned.contributionId);
  assert(response.status === 200, "The owner may pay their own contribution");

  // An already-posted contribution cannot be charged a second time.
  database.prepare("UPDATE contributions SET status = 'POSTED' WHERE id = ?").run(owned.contributionId);
  response = await createContributionPayment(post(owned.contributionId), env, { userId: "user_maya" }, owned.contributionId);
  body = await response.json();
  assert(response.status === 409 && body.error.code === "CONTRIBUTION_ALREADY_PAID", "A paid contribution cannot be charged again");

  const wrongMethod = new Request(`https://timi.example/api/fund/contributions/${draft.contributionId}/payment`, { method: "GET" });
  response = await createContributionPayment(wrongMethod, env, null, draft.contributionId);
  assert(response.status === 405, "GET is not how a payment starts");

  assert((await ledgerIntegrity(env)).ok, "The ledger stays sound across the payment call");
}


database.close();
console.log(`Paw It Forward fund tests passed: ${transactions} balanced journal transactions across whole-dollar contribution validation, contributions posting whole with the processor fee borne separately, duplicate webhooks posting once, approval moving no money, atomic $30 reservation, two concurrent reservations unable to overspend, release and expiry recognizing $0, verified completion recognizing $30 once with a non-cash $10 match, replayed completion recognizing nothing further, a founding clinic's sponsorship costing the fund $5 rather than $30, controlled reversal, delayed and thresholded public impact counting only consumed sponsorships, pause/cap/household controls, contributor-scoped history, a contribution payment call that credits nothing until Stripe confirms and never fakes a success, a booking-time gift that re-prices the one combined charge and posts to the fund exactly once, and a ledger that balanced after every one of them.`);
