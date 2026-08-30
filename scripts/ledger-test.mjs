/**
 * The subledger's own tests.
 *
 * Everything the Paw It Forward fund reports rests on two claims: that every
 * journal transaction balances, and that a business event posted twice is
 * recorded once. Both are cheap to assert here and expensive to discover in
 * production, where the symptom is a number nobody can explain.
 */

import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import {
  accountBalance,
  allBalances,
  claimStripeEvent,
  completeStripeEvent,
  fundSummary,
  ledgerIntegrity,
  postTransaction,
  recordAudit,
  RESTRICTED_ACCOUNTS
} from "../src/ledger.js";
import {
  activePricingPolicy,
  clinicFeeFor,
  FALLBACK_PRICING,
  sponsorshipCostFor,
  sponsorshipQuote,
  validateContributionAmount
} from "../src/pricing.js";

class D1StatementMock {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.values = [];
  }
  bind(...values) { this.values = values; return this; }
  async first() { return this.database.prepare(this.sql).get(...this.values) || null; }
  async all() { return { results: this.database.prepare(this.sql).all(...this.values), success: true }; }
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

async function throws(fn, matcher, message) {
  try {
    await fn();
  } catch (error) {
    assert(matcher.test(error.message), `${message} — threw the wrong error: ${error.message}`);
    return;
  }
  throw new Error(`${message} — nothing was thrown.`);
}

const database = new DatabaseSync(":memory:");
for (const file of [
  "0001_initial", "0002_seed", "0003_multi_offer_search", "0004_tenancy_admin",
  "0005_voice_calls", "0006_care_context", "0007_client_errors", "0008_payments_ledger",
  "0009_pets", "0010_provider_analytics", "0011_call_policy", "0012_pet_sex",
  "0013_pricing_and_ledger"
]) {
  database.exec(await readFile(`migrations/${file}.sql`, "utf8"));
}

const env = { DB: new D1Mock(database) };

/* ------------------------------------------------------------- pricing --- */

const pricing = await activePricingPolicy(env);
assert(pricing.ownerFeeCents === 2000, "The launch policy charges the owner $20");
assert(pricing.clinicFeeCents === 2500, "The launch policy charges a standard clinic $25");
assert(pricing.timiMatchCents === 1000, "Tími contributes $10 toward a sponsored connection");

// The seeded row and the no-database fallback must be the same numbers, or a
// demo build quotes a price production does not charge.
assert(pricing.ownerFeeCents === FALLBACK_PRICING.ownerFeeCents, "Seeded owner fee must match the fallback constant");
assert(pricing.clinicFeeCents === FALLBACK_PRICING.clinicFeeCents, "Seeded clinic fee must match the fallback constant");
assert(pricing.timiMatchCents === FALLBACK_PRICING.timiMatchCents, "Seeded match must match the fallback constant");

// Exactly one policy may be active. A second would make the price depend on
// row order, which is how two customers get quoted differently on one day.
await throws(
  async () => database.prepare(
    "INSERT INTO pricing_policies (id, version, owner_fee_cents, clinic_fee_cents, timi_match_cents, active) VALUES ('pricing_v2', 2, 2500, 3000, 1000, 1)"
  ).run(),
  /UNIQUE|constraint/i,
  "A second active pricing policy must be refused"
);

/* ------------------------------------------------- clinic pricing plans --- */

let clinic = await clinicFeeFor(env, "tenant_hearth", pricing);
assert(clinic.feeCents === 2500 && clinic.plan === "STANDARD", "A clinic with no assignment pays the standard fee");

database.prepare("INSERT INTO clinic_pricing_assignments (tenant_id, plan) VALUES ('tenant_hearth', 'FOUNDING')").run();
clinic = await clinicFeeFor(env, "tenant_hearth", pricing);
assert(clinic.feeCents === 0 && clinic.reason === "FOUNDING_CLINIC_RATE", "A founding clinic pays nothing, with a reason on the record");

// Good standing is what the founding rate is conditional on, and losing it
// must be prospective and visible rather than silent.
database.prepare("UPDATE clinic_pricing_assignments SET good_standing = 0 WHERE tenant_id = 'tenant_hearth'").run();
clinic = await clinicFeeFor(env, "tenant_hearth", pricing);
assert(clinic.feeCents === 2500 && clinic.reason === "FOUNDING_SUSPENDED_NOT_IN_GOOD_STANDING", "A founding clinic out of good standing pays the standard fee, and the reason says so");
database.prepare("UPDATE clinic_pricing_assignments SET good_standing = 1 WHERE tenant_id = 'tenant_hearth'").run();

// A CUSTOM plan with no amount would quietly price at the standard fee.
await throws(
  async () => database.prepare("INSERT INTO clinic_pricing_assignments (tenant_id, plan) VALUES ('tenant_juniper', 'CUSTOM')").run(),
  /constraint/i,
  "A custom plan without an amount must be refused"
);

/* ------------------------------------------------- sponsorship arithmetic --- */

const standard = sponsorshipCostFor({ ownerFeeCents: 2000, clinicFeeCents: 2500, timiMatchCents: 1000 });
assert(standard.applicableValueCents === 4500, "A standard connection is worth $45");
assert(standard.timiMatchCents === 1000 && standard.fundContributionCents === 3500, "Tími contributes $10 and the fund $35");

// The heart of it: a founding clinic pays nothing normally, so its sponsored
// booking is worth $20 and asks the fund for $10. Inventing a $25 clinic fee
// nobody would have paid, to make a donor statistic larger, is exactly what
// both specs forbid.
const founding = sponsorshipCostFor({ ownerFeeCents: 2000, clinicFeeCents: 0, timiMatchCents: 1000 });
assert(founding.applicableValueCents === 2000, "A founding clinic's connection is worth $20, not $45");
assert(founding.fundContributionCents === 1000, "A founding clinic's sponsored booking asks the fund for $10, not $35");

// The match can never exceed what would actually have been charged.
const tiny = sponsorshipCostFor({ ownerFeeCents: 500, clinicFeeCents: 0, timiMatchCents: 1000 });
assert(tiny.timiMatchCents === 500 && tiny.fundContributionCents === 0, "Tími's match is capped at the value actually forgone");

const quote = await sponsorshipQuote(env, "tenant_hearth");
assert(quote.fundContributionCents === 1000 && quote.clinicPlan === "FOUNDING", "The live quote reads the clinic's real plan");

/* --------------------------------------------------- contribution amounts --- */

assert(validateContributionAmount(200, { standalone: false, policy: pricing }).ok, "$2 is a valid contribution alongside a booking");
assert(!validateContributionAmount(237, { standalone: false, policy: pricing }).ok, "Cents are refused; contributions are whole dollars");
assert(validateContributionAmount(237, { standalone: false, policy: pricing }).code === "WHOLE_DOLLARS_ONLY", "A cents amount is refused for the right reason");
assert(!validateContributionAmount(0, { standalone: false, policy: pricing }).ok, "Zero is not a contribution");
assert(!validateContributionAmount(900, { standalone: true, policy: pricing }).ok, "The public portal refuses $9");
assert(validateContributionAmount(1000, { standalone: true, policy: pricing }).ok, "The public portal accepts $10");
assert(!validateContributionAmount(2500100, { standalone: true, policy: pricing }).ok, "A contribution above the cap is refused");

/* --------------------------------------------------------- the journal --- */

// A $22 booking payment: $20 owner fee held unearned, $2 to the fund.
const posted = await postTransaction(env, {
  kind: "contribution_posted",
  idempotencyKey: "test:order_1",
  memo: "$20 owner fee plus a $2 contribution",
  lines: [
    { account: "processor_cash", debit: 2200 },
    { account: "platform_fees_unearned", credit: 2000 },
    { account: "fund_available", credit: 200 }
  ]
});
assert(posted.ok && !posted.duplicate, "A balanced transaction posts");
assert(await accountBalance(env, "fund_available") === 200, "The fund holds the full $2 the contributor chose");

// The processor fee is Tími's expense. Netting it out of the contribution
// would quietly turn a $2 gift into $1.83 of fund and $0.17 of nothing.
await postTransaction(env, {
  kind: "processor_fee",
  idempotencyKey: "test:order_1:fee",
  lines: [
    { account: "processor_fee_expense", debit: 94 },
    { account: "processor_cash", credit: 94 }
  ]
});
assert(await accountBalance(env, "fund_available") === 200, "A processor fee never reduces the contributor's fund credit");
assert(await accountBalance(env, "processor_fee_expense") === 94, "The processor fee lands on Tími's expense account");

// Idempotency: the same business event, posted again — as a redelivered
// webhook does — must change nothing.
const replay = await postTransaction(env, {
  kind: "contribution_posted",
  idempotencyKey: "test:order_1",
  lines: [
    { account: "processor_cash", debit: 2200 },
    { account: "platform_fees_unearned", credit: 2000 },
    { account: "fund_available", credit: 200 }
  ]
});
assert(replay.ok && replay.duplicate, "A replayed business event reports itself as a duplicate");
assert(await accountBalance(env, "fund_available") === 200, "A replayed transaction must not double the fund");
const entryCount = database.prepare("SELECT COUNT(*) AS c FROM ledger_entries WHERE transaction_id IN (SELECT id FROM ledger_transactions WHERE idempotency_key = 'test:order_1')").get().c;
assert(entryCount === 3, `A replayed transaction must not attach a second set of lines; found ${entryCount}`);

/* ------------------------------------------------------- what is refused --- */

await throws(
  () => postTransaction(env, {
    kind: "adjustment", idempotencyKey: "test:unbalanced",
    lines: [{ account: "fund_available", debit: 100 }, { account: "processor_cash", credit: 90 }]
  }),
  /Unbalanced/,
  "An unbalanced transaction must be refused, not stored and reconciled later"
);

await throws(
  () => postTransaction(env, {
    kind: "adjustment", idempotencyKey: "test:one-sided",
    lines: [{ account: "fund_available", debit: 100 }]
  }),
  /at least two lines/,
  "A single-sided entry is not double-entry bookkeeping"
);

await throws(
  () => postTransaction(env, {
    kind: "adjustment", idempotencyKey: "test:negative",
    lines: [{ account: "fund_available", debit: -100 }, { account: "processor_cash", credit: -100 }]
  }),
  /Negative/,
  "A negative amount must be refused; reverse an entry instead of negating it"
);

await throws(
  () => postTransaction(env, {
    kind: "adjustment",
    lines: [{ account: "fund_available", debit: 100 }, { account: "processor_cash", credit: 100 }]
  }),
  /idempotencyKey/,
  "A transaction with no idempotency key must be refused — it could post twice"
);

/* ------------------------------------------------ reservation and revenue --- */

// The sponsorship lifecycle in miniature: reserve, then consume. The money
// moves from available to reserved to earned, and at no point is it created.
await postTransaction(env, {
  kind: "contribution_posted", idempotencyKey: "test:big-contribution",
  lines: [{ account: "processor_cash", debit: 10000 }, { account: "fund_available", credit: 10000 }]
});
await postTransaction(env, {
  kind: "sponsorship_reserved", idempotencyKey: "test:reserve_1",
  lines: [{ account: "fund_available", debit: 3500 }, { account: "fund_reserved", credit: 3500 }]
});
assert(await accountBalance(env, "fund_reserved") === 3500, "A reservation moves $35 into reserved");
assert(await accountBalance(env, "fund_available") === 6700, "A reservation reduces available by exactly what it reserved");

await postTransaction(env, {
  kind: "sponsorship_consumed", idempotencyKey: "test:consume_1",
  lines: [{ account: "fund_reserved", debit: 3500 }, { account: "sponsored_access_revenue", credit: 3500 }]
});
assert(await accountBalance(env, "fund_reserved") === 0, "Completion clears the reservation");
assert(await accountBalance(env, "sponsored_access_revenue") === 3500, "Completion — and only completion — recognizes the revenue");

const summary = await fundSummary(env);
assert(summary.availableCents === 6700 && summary.consumedLifetimeCents === 3500, "The fund summary reads from postings, not a counter");

/* ------------------------------------------------------------ integrity --- */

const integrity = await ledgerIntegrity(env);
assert(integrity.ok, `The ledger must be sound: ${JSON.stringify(integrity)}`);
assert(integrity.unbalanced.length === 0, "No transaction may be unbalanced");
assert(integrity.negativeRestricted.length === 0, "No restricted account may be negative");

// And the integrity check must actually notice a problem, or it is decoration.
// Written straight to SQL, bypassing postTransaction, exactly as a bug would.
database.prepare("INSERT INTO ledger_transactions (id, kind, idempotency_key) VALUES ('ltx_broken', 'adjustment', 'test:broken')").run();
database.prepare("INSERT INTO ledger_entries (id, transaction_id, account_code, debit_cents) VALUES ('lent_broken', 'ltx_broken', 'processor_cash', 500)").run();
const broken = await ledgerIntegrity(env);
assert(!broken.ok && broken.unbalanced.length === 1, "The integrity check must catch an unbalanced transaction written behind its back");
database.prepare("DELETE FROM ledger_entries WHERE transaction_id = 'ltx_broken'").run();
database.prepare("DELETE FROM ledger_transactions WHERE id = 'ltx_broken'").run();
assert((await ledgerIntegrity(env)).ok, "The ledger is sound again once the bad transaction is removed");

// Restricted accounts are the ones holding money that is not Tími's.
const balances = await allBalances(env);
for (const code of RESTRICTED_ACCOUNTS) {
  assert(balances[code]?.restricted === true, `${code} must be marked restricted in the database, not only in application code`);
}

/* ----------------------------------------------------- webhook dedupe --- */

assert(await claimStripeEvent(env, { id: "evt_1", type: "payment_intent.succeeded", objectId: "pi_1" }), "A new Stripe event is claimable");
assert(!(await claimStripeEvent(env, { id: "evt_1", type: "payment_intent.succeeded", objectId: "pi_1" })), "An event already being processed must not be claimed twice");
await completeStripeEvent(env, "evt_1");
assert(!(await claimStripeEvent(env, { id: "evt_1", type: "payment_intent.succeeded", objectId: "pi_1" })), "A processed event must never be reprocessed");

// A failed attempt is the one case worth retrying.
await claimStripeEvent(env, { id: "evt_2", type: "charge.refunded", objectId: "ch_2" });
await completeStripeEvent(env, "evt_2", { status: "failed", error: "boom" });
assert(await claimStripeEvent(env, { id: "evt_2", type: "charge.refunded", objectId: "ch_2" }), "A failed event may be retried");

/* ---------------------------------------------------------------- audit --- */

await recordAudit(env, {
  actorId: "user_operator", actorRole: "admin", action: "pricing.publish",
  subjectType: "pricing_policy", subjectId: "pricing_v1",
  oldState: null, newState: { ownerFeeCents: 2000 }, reason: "Launch pricing"
});
const audited = database.prepare("SELECT * FROM audit_events WHERE subject_id = 'pricing_v1'").get();
assert(audited && audited.actor_id === "user_operator" && audited.reason === "Launch pricing", "An audit event records who, what, and why");

console.log("Ledger and pricing tests passed: versioned pricing with one active policy, founding and custom clinic plans, good-standing suspension, sponsorship arithmetic that never invents a fee a founding clinic would not have paid, whole-dollar contribution limits, balanced double-entry posting, processor fees borne by Tími rather than the contributor, idempotent replay, refusal of unbalanced/one-sided/negative/unkeyed transactions, the reserve-to-revenue lifecycle, integrity detection of a journal corrupted behind the API's back, Stripe event dedupe with failed-attempt retry, and the audit trail.");
