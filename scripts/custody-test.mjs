/**
 * Paw It Forward custody and reconciliation tests.
 *
 * Addendum §26 acceptance tests 1–7 in order, plus the three this part of
 * the program cannot ship without: a deployment with no Treasury rail must
 * mark nothing swept, a webhook that reports failure must put the cash back
 * where it was, and `ledgerIntegrity()` must still be sound after every
 * single operation above.
 *
 * Same harness as scripts/e2e.mjs and scripts/fund-test.mjs — node:sqlite
 * behind a D1-shaped mock, every migration applied in order — because a
 * custody test that runs against a different database than the Worker proves
 * nothing about the Worker.
 */

import { DatabaseSync } from "node:sqlite";
import { applyMigrations } from "./lib/migrations.mjs";
import { accountBalance, ledgerIntegrity, postTransaction } from "../src/ledger.js";
import { postContribution, recordContribution, reserveSponsorship, consumeSponsorship } from "../src/fund.js";
import {
  applyCustodyWebhook,
  custodyBalance,
  designationStatus,
  fundGuaranteeFromCustody,
  handleCustodyStatus,
  handleCustodySweep,
  handleCustodyTransfers,
  listCustodyTransfers,
  operatingPayoutGuard,
  releaseSponsorshipFromCustody,
  resolveCustodyProvider,
  returnGuaranteeToCustody,
  stripeTreasuryCustodyProvider,
  stubCustodyProvider,
  custodySweepTick,
  sweepDesignatedContributions,
  unavailableCustodyProvider
} from "../src/fund-custody.js";
import {
  CRITICAL,
  handleReconciliationExceptions,
  handleResolveException,
  handleReconciliationRuns,
  handleRunReconciliation,
  listReconciliationExceptions,
  reconciliationTick,
  resolveException,
  runReconciliation
} from "../src/reconciliation.js";

class D1StatementMock {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    // node:sqlite binds a missing parameter as NULL and so does D1. A guard
    // whose last `?` never got a value reads as `id = NULL`, which is false,
    // so the write quietly does nothing and the caller reports a duplicate.
    // Counting here turns that into a stack trace.
    const placeholders = (this.sql.match(/\?/g) || []).length;
    if (placeholders !== values.length) {
      throw new Error(`Bound ${values.length} values to ${placeholders} placeholders: ${this.sql.trim().slice(0, 120).replace(/\s+/g, " ")}`);
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

// Every migration, in order. Discovered rather than listed: this file is
// written alongside two other migration streams and a hard-coded list would
// go stale the moment either of them lands.
const database = new DatabaseSync(":memory:");
await applyMigrations(database);

const env = { DB: new D1Mock(database), SIGN_IN_REQUIRED: "false", DEMO_MODE: "false" };
const stub = stubCustodyProvider();
const actor = { userId: "user_ops_1", role: "org:admin" };

async function assertLedgerSound(where) {
  const integrity = await ledgerIntegrity(env);
  assert(integrity.ok, `Ledger integrity failed after ${where}: ${JSON.stringify(integrity)}`);
}

async function balances() {
  const [processorCash, fundAvailable, fundReserved, custody, inTransit, unearned, feeExpense, operating, atClinic] = await Promise.all([
    accountBalance(env, "processor_cash"),
    accountBalance(env, "fund_available"),
    accountBalance(env, "fund_reserved"),
    accountBalance(env, "pif_custody_cash"),
    accountBalance(env, "pif_custody_in_transit"),
    accountBalance(env, "platform_fees_unearned"),
    accountBalance(env, "processor_fee_expense"),
    accountBalance(env, "clearkey_operating_cash"),
    accountBalance(env, "deposit_guarantee_outstanding")
  ]);
  return { processorCash, fundAvailable, fundReserved, custody, inTransit, unearned, feeExpense, operating, atClinic };
}

let contributionCounter = 0;
/** A posted contribution: recorded, then credited to the fund by the ledger. */
async function postedContribution(amountCents, { source = "BOOKING", processorFeeCents = 0, paymentOrderId = null } = {}) {
  contributionCounter += 1;
  const recorded = await recordContribution(env, {
    amountCents,
    source,
    paymentOrderId,
    receiptEmail: `giver${contributionCounter}@example.com`
  });
  assert(recorded.ok, `recordContribution(${amountCents}) failed: ${JSON.stringify(recorded)}`);
  const posted = await postContribution(env, { contributionId: recorded.contributionId, processorFeeCents });
  assert(posted.ok && !posted.duplicate, `postContribution failed: ${JSON.stringify(posted)}`);
  return recorded;
}

let revenueCounter = 0;
/** Ordinary TímiNOW revenue arriving at the processor. Never fund money. */
async function ordinaryRevenue(amountCents) {
  revenueCounter += 1;
  const posting = await postTransaction(env, {
    kind: "owner_fee_collected",
    idempotencyKey: `test_owner_fee:${revenueCounter}`,
    memo: "Ordinary TímiNOW owner fee. Not designated.",
    lines: [
      { account: "processor_cash", debit: amountCents },
      { account: "platform_fees_unearned", credit: amountCents }
    ]
  });
  assert(posting.ok, "Ordinary revenue must post");
}

/* ══════════════════════════ 1. $20 + $2 is ONE $22 PaymentIntent ══ */

// The mixed-charge flow itself belongs to the integrator; what this test
// owns is the shape it must leave behind. One order, one PaymentIntent, two
// allocations, and the allocations summing to the order total — because a
// second card charge for the contribution is exactly what §4 and §28 forbid,
// and a total that does not equal its parts is how one appears.
const bookingOrderId = "porder_mixed_22";
database.prepare(`
  INSERT INTO payment_orders (id, purpose, total_cents, currency, status, stripe_payment_intent_id, confirmation_snapshot_json)
  VALUES (?, 'BOOKING', 2200, 'usd', 'REQUIRES_CONFIRMATION', 'pi_mixed_22', '{}')
`).run(bookingOrderId);

const bookingContribution = await recordContribution(env, {
  amountCents: 200,
  source: "BOOKING",
  paymentOrderId: bookingOrderId,
  receiptEmail: "maya@example.com"
});
assert(bookingContribution.ok, `The $2 booking add-on must record: ${JSON.stringify(bookingContribution)}`);

database.prepare(`
  INSERT INTO payment_allocations (id, payment_order_id, purpose, amount_cents, currency)
  VALUES ('alloc_owner_fee_1', ?, 'OWNER_PLATFORM_FEE', 2000, 'usd')
`).run(bookingOrderId);

const order = database.prepare("SELECT * FROM payment_orders WHERE id = ?").get(bookingOrderId);
const allocations = database.prepare("SELECT * FROM payment_allocations WHERE payment_order_id = ? ORDER BY purpose").all(bookingOrderId);
const intentCount = database.prepare("SELECT COUNT(*) AS count FROM payment_orders WHERE stripe_payment_intent_id = 'pi_mixed_22'").get();

assert(Number(intentCount.count) === 1, "A $20 fee plus a $2 contribution is one PaymentIntent, not two (§4, §28)");
assert(allocations.length === 2, `The $22 charge carries exactly two allocations: ${JSON.stringify(allocations)}`);
assert(allocations.reduce((total, row) => total + Number(row.amount_cents), 0) === Number(order.total_cents),
  "The allocations must sum to the order total; a total that is not its parts is an invented charge");
assert(Number(order.total_cents) === 2200, "The single charge is $22");
assert(allocations.find((row) => row.purpose === "FUND_CONTRIBUTION").amount_cents === 200, "$2 is allocated to Paw It Forward");
assert(allocations.find((row) => row.purpose === "OWNER_PLATFORM_FEE").amount_cents === 2000, "$20 is allocated to ordinary TímiNOW revenue");

/* ═══════════════ 2 & 3. exactly $20 operating / $2 PIF, fee absorbed ══ */

await ordinaryRevenue(2000);
const feeCents = 94; // 2.9% + 30¢ on $22, borne by ClearKey (§4 "Processing expense").
const postedBooking = await postContribution(env, { contributionId: bookingContribution.contributionId, processorFeeCents: feeCents });
assert(postedBooking.ok, `The $2 must post to the fund: ${JSON.stringify(postedBooking)}`);

let state = await balances();
assert(state.fundAvailable === 200, `Acceptance test 2/3: the fund is credited the full $2, not $2 minus the fee. Got ${state.fundAvailable}`);
assert(state.unearned === 2000, `Acceptance test 2: exactly $20 is ordinary operating consideration. Got ${state.unearned}`);
assert(state.feeExpense === feeCents, "The processor fee is ClearKey's expense, on its own transaction (§4)");
assert(state.processorCash === 2000 + 200 - feeCents, `Processor cash is the charge minus the fee: ${state.processorCash}`);
await assertLedgerSound("the mixed $22 charge");

/* ═════════════════ fail closed: no Treasury rail, nothing swept ══ */

// §5 and §28. The account has no Treasury capability configured, so the rail
// refuses. What must NOT happen: a transfer marked swept, a ledger entry, or
// a status that lets a console claim the money is protected.
assert(resolveCustodyProvider({ DB: env.DB }).mode === "NONE",
  "A deployment with neither a stub opt-in nor a Treasury account gets the refusing provider, never a stub by default");
assert(unavailableCustodyProvider().available().ok === false, "The no-rail provider is never available");

const treasuryless = stripeTreasuryCustodyProvider();
const failClosed = await sweepDesignatedContributions(env, { provider: treasuryless });
assert(failClosed.ok, "A fail-closed sweep still returns a report rather than throwing");
assert(failClosed.swept.length === 0 && failClosed.sweptCents === 0, "Nothing is swept when the rail is unavailable");
assert(failClosed.failed.length === 1 && failClosed.failed[0].code === "TREASURY_RAIL_UNAVAILABLE",
  `The refusal names the rail: ${JSON.stringify(failClosed.failed)}`);
assert(failClosed.failedClosed === true, "A run that could not reach the rail must never read as a success");

state = await balances();
assert(state.custody === 0 && state.inTransit === 0, "A failed sweep moves no money in the ledger either");
assert(state.processorCash === 2000 + 200 - feeCents, "Processor cash is untouched by a refused sweep");

let status = await designationStatus(env, { provider: treasuryless });
assert(status.sweptPifContributionsCents === 0, "Nothing is marked swept");
assert(status.availableToSweepPifContributionsCents === 200, "The $2 is still designated and still waiting");
assert(status.designatedLedgerCents === 200, "Designation in the ledger is correct with or without a rail");
assert(status.custodyProtected === false, "A deployment with no rail never claims cash is protected");

const failedRows = (await listCustodyTransfers(env, { direction: "SWEEP", state: "FAILED" })).transfers;
assert(failedRows.length === 1 && failedRows[0].errorCode === "TREASURY_RAIL_UNAVAILABLE",
  "The refusal is recorded, so an operator can see what did not happen");
await assertLedgerSound("the fail-closed sweep");

/* ═════════════ 4. the sweep moves only designated eligible cash ══ */

// More ordinary revenue in the same Payments balance, so the sweep has
// something it must refuse to touch. $40 of TímiNOW fees and $2 of
// designated contribution sit in one pile of cash; only one of them is
// addressable from the sweep query at all.
await ordinaryRevenue(2000);

const firstSweep = await sweepDesignatedContributions(env, { provider: stub });
assert(firstSweep.ok && firstSweep.swept.length === 1, `The retry after a fail-closed attempt must succeed: ${JSON.stringify(firstSweep)}`);
assert(firstSweep.sweptCents === 200, `Acceptance test 4: the sweep moves the exact designated $2 and not a cent more. Got ${firstSweep.sweptCents}`);

state = await balances();
assert(state.custody === 200, `Only the designated $2 reached custody: ${state.custody}`);
assert(state.unearned === 2000 + 2000, "The $40 of ordinary revenue is untouched: it is not fund money and cannot be swept as fund money");
assert(state.processorCash === 4000 + 200 - feeCents - 200, `Payments keeps the operating cash: ${state.processorCash}`);
assert(state.fundAvailable === 200, "A sweep moves cash between locations; it never changes what the fund owes");
await assertLedgerSound("the first sweep");

/* ═══════════════════════════ 5. a retry cannot double-sweep ══ */

const retry = await sweepDesignatedContributions(env, { provider: stub });
assert(retry.examined === 0 && retry.swept.length === 0, `A retried sweep finds nothing left to move: ${JSON.stringify(retry)}`);
assert((await balances()).custody === 200, "Custody is unchanged by the retry");

// And the harder half of test 5: two workers running at the same time.
await postedContribution(1000, { source: "STANDALONE" });
const [raceA, raceB] = await Promise.all([
  sweepDesignatedContributions(env, { provider: stub }),
  sweepDesignatedContributions(env, { provider: stub })
]);
const racedCents = raceA.sweptCents + raceB.sweptCents;
assert(racedCents === 1000, `Two concurrent workers must move the $10 once, not twice. Moved ${racedCents}`);

const liveSweeps = database.prepare(`
  SELECT contribution_id, COUNT(*) AS count FROM pif_custody_transfers
  WHERE direction = 'SWEEP' AND state <> 'FAILED' GROUP BY contribution_id HAVING count > 1
`).all();
assert(liveSweeps.length === 0, `No contribution may carry two live sweeps: ${JSON.stringify(liveSweeps)}`);
assert((await balances()).custody === 1200, "Custody holds $2 + $10 and nothing extra");
await assertLedgerSound("the concurrent sweep");

/* ══════════ 6. an operating payout cannot consume unswept PIF cash ══ */

await postedContribution(500);
state = await balances();

let guard = await operatingPayoutGuard(env, { amountCents: state.processorCash });
assert(guard.ok && guard.allowed === false, "A payout of the whole processor balance must be refused while designated cash is unswept");
assert(guard.code === "PAYOUT_BLOCKED_UNSWEPT_DESIGNATED_CASH",
  `Acceptance test 6: the refusal names the reason. Got ${guard.code}`);
assert(guard.protectedFloorCents === 500, `The floor is exactly the unswept designated $5: ${guard.protectedFloorCents}`);
assert(guard.payoutableCents === state.processorCash - 500, "Everything above the floor is still ClearKey's to pay out");

guard = await operatingPayoutGuard(env, { amountCents: guard.payoutableCents });
assert(guard.allowed === true, "Operating cash above the floor pays out normally; the guard is a floor, not a freeze");

await sweepDesignatedContributions(env, { provider: stub });
guard = await operatingPayoutGuard(env, { amountCents: (await balances()).processorCash });
assert(guard.allowed === true && guard.protectedFloorCents === 0,
  "Once the designated amount is protected, the floor is zero and the rest is payable");
assert((await balances()).custody === 1700, "Custody now holds $2 + $10 + $5");
await assertLedgerSound("the payout guard");

/* ═════════ release happens after verified completion, never before ══ */

const bigGift = await postedContribution(5000, { source: "STANDALONE" });
assert(bigGift.ok, "A $50 contribution funds the sponsorship test");

database.prepare(`
  INSERT INTO intake_requests (
    id, public_code, location_id, tenant_id, pet_name, species, owner_name, owner_phone,
    concern_category, concern_summary, urgency, status, requested_at, request_expires_at
  ) VALUES ('intake_custody_1', 'TIMI-C1', 'loc_hearth', 'tenant_hearth', 'Otis', 'dog', 'Maya Morgan',
            '(510) 555-0147', 'illness_or_injury', 'Vomited three times and will not drink.', 'urgent',
            'accepted', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
`).run();

let release = await releaseSponsorshipFromCustody(env, { reservationId: "fres_nonexistent", provider: stub });
assert(!release.ok && release.code === "SPONSORSHIP_NOT_CONSUMED",
  "There is nothing to release for a reservation that never existed");

const reservation = await reserveSponsorship(env, { intakeId: "intake_custody_1", tenantId: "tenant_hearth" });
assert(reservation.ok && !reservation.duplicate && reservation.amountCents === 3500,
  `The $35 must reserve: ${JSON.stringify(reservation)}`);
const reservationId = reservation.reservationId;

release = await releaseSponsorshipFromCustody(env, { reservationId, provider: stub });
assert(!release.ok && release.code === "SPONSORSHIP_NOT_CONSUMED",
  "A reserved sponsorship has earned nothing: §3 rule 5 and §28 forbid releasing before verified completion");

const consumed = await consumeSponsorship(env, { reservationId });
assert(consumed.ok && !consumed.duplicate, `Completion must consume the reservation: ${JSON.stringify(consumed)}`);

// Custody holds $17 and the earned sponsorship is $35: money that was never
// swept cannot be released, and the refusal says so rather than driving the
// restricted custody account negative.
release = await releaseSponsorshipFromCustody(env, { reservationId, provider: stub });
assert(!release.ok && release.code === "INSUFFICIENT_PROTECTED_CUSTODY",
  `Custody cannot release cash it never received: ${JSON.stringify(release)}`);

await sweepDesignatedContributions(env, { provider: stub });
assert((await balances()).custody === 6700, "The $50 gift is swept too, bringing custody to $67");

release = await releaseSponsorshipFromCustody(env, { reservationId, provider: stub });
assert(release.ok && release.state === "COMPLETED", `The earned $35 releases after consumption: ${JSON.stringify(release)}`);
assert(release.amountCents === 3500, "The amount released is the sponsorship's own recorded amount");

state = await balances();
assert(state.custody === 6700 - 3500, `Custody drops by the released amount: ${state.custody}`);
assert(state.operating === 3500, "The earned sponsorship lands in ClearKey operating cash");

const releaseAgain = await releaseSponsorshipFromCustody(env, { reservationId, provider: stub });
assert(releaseAgain.ok && releaseAgain.duplicate, "A replayed release moves nothing");
assert((await balances()).custody === 3200, "The replay changed no balance");
await assertLedgerSound("the sponsorship release");

/* ════════════════════ asynchronous rails settle by webhook only ══ */

const slowRail = stubCustodyProvider({ settleImmediately: false });
const slowGift = await postedContribution(300);
const slowSweep = await sweepDesignatedContributions(env, { provider: slowRail });
assert(slowSweep.inTransit.length === 1 && slowSweep.swept.length === 0,
  "A rail that has not settled leaves the movement in flight, never marked complete");

state = await balances();
assert(state.inTransit === 300, "In-flight cash sits in its own account: neither in Payments nor in custody");
assert(state.custody === 3200, "Custody does not rise until the rail says it did");

status = await designationStatus(env, { provider: slowRail });
assert(status.inFlight.sweepCents === 300, "The in-flight amount is queryable");
assert(status.sweptPifContributionsCents === 1700 + 5000, "Only confirmed movements count as swept");

const inFlight = (await listCustodyTransfers(env, { state: "IN_TRANSIT" })).transfers[0];
const settled = await applyCustodyWebhook(env, { id: "evt_1", type: "payout.paid", data: { object: { id: inFlight.providerObjectId } } });
assert(settled.ok && settled.state === "COMPLETED", `The webhook settles the movement: ${JSON.stringify(settled)}`);
state = await balances();
assert(state.custody === 3500 && state.inTransit === 0, "Settlement moves the cash from in-flight into custody");

const replayed = await applyCustodyWebhook(env, { id: "evt_1", type: "payout.paid", data: { object: { id: inFlight.providerObjectId } } });
assert(replayed.duplicate === true, "A redelivered settlement changes nothing");
assert((await balances()).custody === 3500, "The redelivery moved no money");
await assertLedgerSound("the settlement webhook");

// A movement the rail later reports as failed must put the cash back and
// leave the contribution sweepable again.
const doomed = await postedContribution(400);
await sweepDesignatedContributions(env, { provider: slowRail });
const doomedTransfer = (await listCustodyTransfers(env, { state: "IN_TRANSIT" })).transfers[0];
assert(doomedTransfer.contributionId === doomed.contributionId, "The in-flight movement is the one just started");
const failedWebhook = await applyCustodyWebhook(env, { id: "evt_2", type: "payout.failed", data: { object: { id: doomedTransfer.providerObjectId } } });
assert(failedWebhook.state === "FAILED", "A failed payout is recorded as failed, not quietly retried");
state = await balances();
assert(state.inTransit === 0 && state.custody === 3500, "A failed movement returns the cash to Payments");
assert(state.processorCash >= 400, "The designated $4 is back in the Payments balance");

const recovered = await sweepDesignatedContributions(env, { provider: stub });
assert(recovered.sweptCents === 400, "A failed movement leaves the money sweepable again");
assert((await balances()).custody === 3900, "Custody holds the recovered $4");
await assertLedgerSound("the failed settlement webhook");

/* ═══════════════════════════ reconciliation balances to the penny ══ */

const clean = await runReconciliation(env, { provider: stub, scope: "MANUAL", runKey: "test:clean", triggeredBy: "test" });
assert(clean.ok, `A clean reconciliation must complete: ${JSON.stringify(clean)}`);
assert(clean.run.differenceCents === 0, `Expected and actual custody must agree exactly: ${JSON.stringify(clean.run)}`);
assert(clean.run.expectedCustodyCents === (await balances()).custody,
  "The §21 identity must equal the custody account balance");
assert(clean.criticalCount === 0, `A balanced fund raises no critical exception: ${JSON.stringify(clean.exceptions)}`);
assert(clean.run.guaranteeSource === "pif_deposit_guarantees" || clean.run.guaranteeSource.startsWith("UNAVAILABLE"),
  "The run always records where the guarantee component came from");
assert(clean.exceptions.every((row) => row.classification !== CRITICAL), "No critical case on a balanced fund");
assert(clean.exceptions.some((row) => row.code === "FAILED_TRANSFERS_PRESENT"),
  "The earlier fail-closed attempts are surfaced as a warning rather than forgotten");

const repeat = await runReconciliation(env, { provider: stub, scope: "MANUAL", runKey: "test:clean" });
assert(repeat.duplicate === true, "A run key runs once: a scheduler that fires twice records one verdict");

/* ═════════ 7. a $0.01 discrepancy is a CRITICAL_RECONCILIATION_EXCEPTION ══ */

const before = await balances();
const drifted = await runReconciliation(env, {
  provider: stubCustodyProvider({ driftCents: -1 }),
  scope: "MANUAL",
  runKey: "test:penny",
  triggeredBy: "test"
});
assert(drifted.ok, "The reconciliation completes even when it disagrees");
assert(drifted.run.status === "EXCEPTIONS_RAISED", "A penny short is not an OK run");
assert(drifted.run.differenceCents === -1, `Acceptance test 7: the difference is exactly one cent. Got ${drifted.run.differenceCents}`);

const penny = drifted.exceptions.find((row) => row.code === "CUSTODY_BALANCE_MISMATCH");
assert(penny, `A one-cent difference must raise a case: ${JSON.stringify(drifted.exceptions)}`);
assert(penny.classification === CRITICAL,
  `Acceptance test 7: one cent is a ${CRITICAL}, never a rounding tolerance. Got ${penny.classification}`);
assert(penny.differenceCents === -1 && penny.expectedCents === before.custody && penny.actualCents === before.custody - 1,
  `The case carries expected, actual and difference: ${JSON.stringify(penny)}`);
assert(penny.status === "OPEN", "Every exception opens an operations case");
assert(drifted.criticalCount === 1, "Exactly one critical case for one discrepancy");

const after = await balances();
assert(after.custody === before.custody && after.fundAvailable === before.fundAvailable,
  "§21 and §28: reconciliation never silently rewrites the ledger to match the rail");
await assertLedgerSound("the penny discrepancy");

/* ═════════════════════ an exception is a case, not an adjustment ══ */

let resolution = await resolveException(env, { exceptionId: penny.id, status: "RESOLVED_EXPLAINED", actorId: actor.userId });
assert(!resolution.ok && resolution.code === "INVESTIGATION_NOTES_REQUIRED",
  "A case cannot be closed without saying what was found");

resolution = await resolveException(env, {
  exceptionId: penny.id, status: "RESOLVED_COMPENSATING_ENTRY",
  investigationNotes: "Claimed a correction.", actorId: actor.userId
});
assert(!resolution.ok && resolution.code === "COMPENSATING_ENTRY_REQUIRED",
  "Claiming a correction requires the compensating entry that made it");

resolution = await resolveException(env, {
  exceptionId: penny.id, status: "INVESTIGATING",
  investigationNotes: "Opened with the processor; a settlement adjustment is suspected.", actorId: actor.userId
});
assert(resolution.ok && resolution.exception.status === "INVESTIGATING", "A case can be moved without being closed");
assert((await balances()).custody === before.custody, "Working a case moves no money");

const open = await listReconciliationExceptions(env, { status: "OPEN" });
assert(open.exceptions.every((row) => row.status === "OPEN"), "The open-case list filters by status");
await assertLedgerSound("resolving an exception");

/* ══════════════════ guarantee float leaves and returns custody ══ */

let guarantee = await fundGuaranteeFromCustody(env, { guaranteeId: "pifdg_test_1", amountCents: 900000, provider: stub });
assert(!guarantee.ok && guarantee.code === "INSUFFICIENT_PROTECTED_CUSTODY",
  "A guarantee cannot be funded from custody that does not hold the money");

guarantee = await fundGuaranteeFromCustody(env, { guaranteeId: "pifdg_test_1", amountCents: 1000, provider: stub });
assert(guarantee.ok && guarantee.state === "COMPLETED", `Guarantee funding must move cash: ${JSON.stringify(guarantee)}`);
state = await balances();
assert(state.atClinic === 1000, "Guarantee float at a clinic is still program money, tracked as such (§7)");
assert(state.custody === before.custody - 1000, "The float left protected custody");

// The identity has to hold while the float is out, not only at rest. The
// term it subtracts is what actually left custody, so a guarantee funded
// from the Payments balance instead (which is what src/deposit-guarantee.js
// does today) is reported as a warning rather than mistaken for missing cash.
const funded = await runReconciliation(env, { provider: stub, scope: "MANUAL", runKey: "test:guarantee-funded" });
assert(funded.run.differenceCents === 0, `Custody balances while guarantee float is at a clinic: ${JSON.stringify(funded.run)}`);
assert(funded.criticalCount === 0, `Guarantee float in flight is not an exception: ${JSON.stringify(funded.exceptions)}`);
assert(funded.run.components.guaranteeCashAtClinicCents === 1000, "The run reports the float sitting at the clinic");

const duplicateGuarantee = await fundGuaranteeFromCustody(env, { guaranteeId: "pifdg_test_1", amountCents: 1000, provider: stub });
assert(duplicateGuarantee.duplicate === true, "One live funding per guarantee");

const returned = await returnGuaranteeToCustody(env, { guaranteeId: "pifdg_test_1", amountCents: 1000, provider: stub });
assert(returned.ok && returned.state === "COMPLETED", `The clinic returns the float: ${JSON.stringify(returned)}`);
state = await balances();
assert(state.atClinic === 0 && state.custody === before.custody, "The returned float is back in protected custody");
await assertLedgerSound("the guarantee round trip");

/* ═══════════════════════════════════ the admin console handlers ══ */

async function callHandler(handler, path, init = {}, ...rest) {
  const request = new Request(`https://admin.timi.example${path}`, init);
  const response = await handler(request, env, ...rest);
  return { status: response.status, body: await response.json() };
}

let call = await callHandler(handleCustodyStatus, "/api/admin/pif/custody");
assert(call.status === 200 && call.body.custody.designatedLedgerCents >= 0, "The custody status handler answers");
assert(call.body.rail.ok === false || typeof call.body.rail.balanceCents === "number",
  "The handler reports the rail's answer, including its refusal");

call = await callHandler(handleCustodyTransfers, "/api/admin/pif/custody/transfers?limit=5");
assert(call.status === 200 && Array.isArray(call.body.transfers), "The transfer journal handler answers");

call = await callHandler(handleCustodySweep, "/api/admin/pif/custody/sweep", { method: "POST" }, actor);
assert(call.status === 200 && call.body.sweep.ok, "The sweep handler answers");
assert(call.body.sweep.custodyMode === "NONE", "With no rail configured on this env, the console sweep fails closed rather than inventing one");

call = await callHandler(handleRunReconciliation, "/api/admin/pif/reconciliation/runs", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runKey: "test:handler" })
}, actor);
assert(call.status === 201 && call.body.run.id, `The reconciliation handler runs it: ${JSON.stringify(call.body)}`);

call = await callHandler(handleReconciliationExceptions, "/api/admin/pif/reconciliation/exceptions?status=OPEN");
assert(call.status === 200 && Array.isArray(call.body.exceptions), "The exception list handler answers");

const openCase = call.body.exceptions[0];
if (openCase) {
  const resolved = await callHandler(handleResolveException, `/api/admin/pif/reconciliation/exceptions/${openCase.id}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "RESOLVED_EXPLAINED", investigationNotes: "Reviewed with operations; no cash difference." })
  }, actor, openCase.id);
  assert(resolved.status === 200 && resolved.body.exception.status === "RESOLVED_EXPLAINED", "A case can be closed through the console");
  assert(resolved.body.exception.resolvedBy === actor.userId, "A resolution is attributable to a person");
}

const unauthenticated = await callHandler(handleResolveException, "/api/admin/pif/reconciliation/exceptions/x", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "RESOLVED_EXPLAINED", investigationNotes: "x" })
}, null, "x");
assert(unauthenticated.status === 401, "Anonymous callers cannot close financial cases");

/* ══════════════════════════════════════════════ the cron entry points ══ */

call = await callHandler(handleReconciliationRuns, "/api/admin/pif/reconciliation/runs?limit=5");
assert(call.status === 200 && call.body.runs.length > 0, "The run history handler answers");
assert(call.body.runs[0].components, "A run carries every component of its arithmetic, not just the verdict");

const sweepTick = await custodySweepTick(env);
assert(sweepTick.ok && sweepTick.custodyMode === "NONE",
  "The sweep cron on a Worker with no configured rail fails closed rather than picking a provider for itself");

// This Worker's env names no rail, so the daily cron cannot confirm the cash
// the ledger says is in custody. That is not smoothed over: a rail that
// cannot answer is itself the critical case.
const dailyRun = await reconciliationTick(env);
assert(dailyRun.run.scope === "DAILY" && dailyRun.run.runKey.startsWith("daily:"), "The daily cron records a dated run");
assert(dailyRun.run.custodyProtected === false, "A run on an unprotected deployment never claims protection");
assert(dailyRun.exceptions.some((row) => row.code === "CUSTODY_BALANCE_MISMATCH" && row.classification === CRITICAL),
  "Custody the rail cannot confirm is a critical case, not a silence");

const repeatedDaily = await reconciliationTick(env);
assert(repeatedDaily.duplicate === true, "The daily cron firing twice records one run for the day");
await assertLedgerSound("the cron entry points");

/* ══════════════════════════════════════════ the fund is still sound ══ */

const finalBalance = await custodyBalance(env, { provider: stub });
const finalLedger = (await balances()).custody;
assert(finalBalance.ok && finalBalance.balanceCents === finalLedger,
  `The rail and the ledger agree at the end: ${finalBalance.balanceCents} vs ${finalLedger}`);

const finalRun = await runReconciliation(env, { provider: stub, scope: "MANUAL", runKey: "test:final", triggeredBy: "test" });
assert(finalRun.run.differenceCents === 0, `The books close to the penny: ${JSON.stringify(finalRun.run)}`);
assert(finalRun.criticalCount === 0, `No critical case at the end: ${JSON.stringify(finalRun.exceptions)}`);

await assertLedgerSound("every custody and reconciliation operation");

const negative = database.prepare(`
  SELECT a.code FROM ledger_accounts a
  JOIN ledger_entries e ON e.account_code = a.code
  WHERE a.restricted = 1
  GROUP BY a.code
  HAVING SUM(CASE WHEN a.normal_balance = 'debit' THEN e.debit_cents - e.credit_cents ELSE e.credit_cents - e.debit_cents END) < 0
`).all();
assert(negative.length === 0, `No restricted account may ever be negative: ${JSON.stringify(negative)}`);

console.log("Paw It Forward custody and reconciliation tests passed: acceptance tests 1-7, fail-closed with no Treasury rail, webhook settlement and failure, and a sound ledger after every operation.");


/* ═══════════════════ a deployment with no Treasury rail at all ══ */

// The whole story on one clean database: designation stays exact, the sweep
// refuses instead of pretending, the payout floor still protects the money,
// and reconciliation balances at zero while saying out loud that nothing is
// physically protected. §5's "fail closed" is not a degraded mode; it is a
// correct one that simply cannot make a claim it has no basis for.
const plain = new DatabaseSync(":memory:");
await applyMigrations(plain);
const plainEnv = { DB: new D1Mock(plain) };

const plainGift = await recordContribution(plainEnv, { amountCents: 200, source: "BOOKING", receiptEmail: "no-treasury@example.com" });
assert(plainGift.ok, "A contribution records with no custody rail configured");
assert((await postContribution(plainEnv, { contributionId: plainGift.contributionId, processorFeeCents: 94 })).ok,
  "A contribution posts to the fund with no custody rail configured");

assert(await accountBalance(plainEnv, "fund_available") === 200,
  "With no Treasury the ledger is still exactly right: the full $2 is designated");

const plainSweep = await sweepDesignatedContributions(plainEnv, {});
assert(plainSweep.failedClosed && plainSweep.sweptCents === 0, "Nothing is swept and nothing claims to have been");
assert(await accountBalance(plainEnv, "pif_custody_cash") === 0, "No custody entry is posted");

const plainStatus = await designationStatus(plainEnv, {});
assert(plainStatus.custodyMode === "NONE" && plainStatus.custodyProtected === false,
  "The deployment reports honestly that it protects nothing");
assert(plainStatus.designatedLedgerCents === 200 && plainStatus.sweptPifContributionsCents === 0,
  "Designated in the ledger, not physically swept — the two facts stay separate");

const plainGuard = await operatingPayoutGuard(plainEnv, { amountCents: 106 });
assert(plainGuard.allowed === false && plainGuard.code === "PAYOUT_BLOCKED_UNSWEPT_DESIGNATED_CASH",
  "The payout floor protects designated cash even where there is nowhere to sweep it to");
assert(plainGuard.protectedFloorCents === 200, "The floor is the whole designated amount");

const plainRun = await runReconciliation(plainEnv, { scope: "DAILY" });
assert(plainRun.run.differenceCents === 0, `A no-Treasury deployment still reconciles to zero: ${JSON.stringify(plainRun.run)}`);
assert(plainRun.criticalCount === 0, `No critical case on a correct unprotected deployment: ${JSON.stringify(plainRun.exceptions)}`);
assert(plainRun.exceptions.some((row) => row.code === "DESIGNATED_CASH_NOT_PROTECTED"),
  "It says out loud that $2 of designated money is not physically protected");
assert((await ledgerIntegrity(plainEnv)).ok, "The journal is sound on a deployment with no custody rail");

console.log("No-Treasury deployment: designation exact, sweep refuses, payout floor holds, reconciliation balances and says what is unprotected.");
