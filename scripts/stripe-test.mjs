/**
 * Stripe integration tests.
 *
 * No network and no Stripe credentials: `globalThis.fetch` is replaced with a
 * queue of canned responses that also records every request, so the assertions
 * can be about what we *sent* — the idempotency key, the transfer amount, the
 * absence of an application fee — and not only about what we did with a reply.
 *
 * The things worth testing here are the ones that lose money when they are
 * wrong: the split arithmetic, the rounding direction, whether a webhook is
 * really authenticated, and whether a redelivery writes a second row.
 */

import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.js";
import {
  accountCapabilities,
  encodeForm,
  idempotencyKey,
  parseStripeSignatureHeader,
  verifyWebhookSignature
} from "../src/stripe.js";
import {
  clinicEarnings,
  handleStripeEvent,
  listLedger,
  outcomeForIntake,
  platformFeeFor,
  recordStripeAccount,
  settleIntake,
  splitForOutcome,
  transferGroupFor
} from "../src/payments.js";
import { getIntake } from "../src/db.js";

/* ------------------------------------------------------------- harness --- */

class D1StatementMock {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
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

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message} — expected ${expected}, got ${actual}`);
}

const database = new DatabaseSync(":memory:");
for (const file of [
  "0001_initial.sql", "0002_seed.sql", "0003_multi_offer_search.sql", "0004_tenancy_admin.sql",
  "0005_voice_calls.sql", "0006_care_context.sql", "0007_client_errors.sql", "0008_payments_ledger.sql"
]) {
  database.exec(await readFile(`migrations/${file}`, "utf8"));
}

const DB = new D1Mock(database);
const WEBHOOK_SECRET = "whsec_test_thisisnotarealsecret";

/**
 * The fetch stub. `queue` holds the responses Stripe would give, in order;
 * `calls` accumulates what we actually sent, parsed back out of the form body
 * so an assertion can name a field rather than a substring.
 */
const stripe = { queue: [], calls: [] };
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.toString();
  const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
  const body = typeof init.body === "string" ? init.body : null;
  const form = body && !headers["content-type"]?.includes("json") ? Object.fromEntries(new URLSearchParams(body)) : null;
  stripe.calls.push({ url, method: init.method || "GET", headers, body, form, json: form ? null : (body ? JSON.parse(body) : null) });
  const next = stripe.queue.shift();
  if (!next) throw new Error(`Unexpected Stripe call to ${url} — no queued response`);
  return new Response(JSON.stringify(next.body), { status: next.status || 200, headers: { "content-type": "application/json" } });
};

function queueStripe(body, status = 200) { stripe.queue.push({ body, status }); }
function resetStripe() { stripe.queue.length = 0; stripe.calls.length = 0; }
function callsTo(fragment) { return stripe.calls.filter((call) => call.url.includes(fragment)); }

async function stripeSignature(payload, secret, timestampSeconds) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestampSeconds}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `t=${timestampSeconds},v1=${hex}`;
}

const LIVE_ENV = {
  DB,
  SIGN_IN_REQUIRED: "false",
  DEMO_MODE: "false",
  SURFACE: "customer",
  STRIPE_SECRET_KEY: "sk_test_not_a_real_key",
  STRIPE_PUBLISHABLE_KEY: "pk_test_not_a_real_key",
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  ASSETS: { fetch: async () => new Response("", { status: 404 }) }
};

/** The commercial baseline from docs/PAYMENTS-AND-TENANT-POLICIES.md. */
const BASELINE_POLICY = {
  depositRequired: true,
  depositAmountCents: 5000,
  depositRefundable: true,
  freeCancelMinutes: 20,
  completedPlatformFeeCents: 2000,
  noShowPlatformFeeCents: 500,
  lateCancelPlatformFeeCents: 500,
  details: {}
};

async function seedIntake({ id, tenantId = "tenant_cedar", locationId = "loc_cedar", status = "completed", paymentStatus = "paid", depositCents = 5000, policy = BASELINE_POLICY, paymentIntentId = null, arrivalBy = null, decisionAt = null }) {
  database.prepare(`
    INSERT INTO intake_requests (
      id, public_code, location_id, tenant_id, customer_user_id, pet_name, species,
      owner_name, owner_phone, concern_category, concern_summary, urgency, status,
      requested_at, request_expires_at, arrival_by, decision_at, policy_snapshot_json,
      deposit_amount_cents, payment_status, payment_provider_id, transfer_group
    ) VALUES (?, ?, ?, ?, 'user_test', 'Milo', 'dog', 'Avery Cole', '5105550126',
      'illness_or_injury', 'Limping badly since this morning and will not stand.', 'urgent', ?,
      datetime('now'), datetime('now', '+10 minutes'), ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, `TIMI-${(seedCounter += 1).toString().padStart(4, "0")}`, locationId, tenantId, status,
    arrivalBy, decisionAt, JSON.stringify(policy), depositCents, paymentStatus,
    paymentIntentId, transferGroupFor(id)
  );
  return getIntake({ DB }, id);
}

let seedCounter = 0;
const results = [];
function record(name) { results.push(name); }

/* ---------------------------------------------- 1. the split arithmetic --- */
{
  const completed = splitForOutcome(BASELINE_POLICY, "completed", 5000);
  assertEqual(completed.clinicAmountCents, 3000, "completed: clinic keeps the deposit less the completed fee");
  assertEqual(completed.platformFeeCents, 2000, "completed: Tími takes its completed fee");
  assertEqual(completed.refundAmountCents, 0, "completed: nothing is refunded");

  const noShow = splitForOutcome(BASELINE_POLICY, "no_show", 5000);
  assertEqual(noShow.clinicAmountCents, 4500, "no-show: the clinic keeps the rest");
  assertEqual(noShow.platformFeeCents, 500, "no-show: Tími takes its no-show fee");
  assertEqual(noShow.refundAmountCents, 0, "no-show: nothing is refunded");

  const lateCancel = splitForOutcome(BASELINE_POLICY, "late_cancel", 5000);
  assertEqual(lateCancel.clinicAmountCents, 4500, "late cancel: the clinic held the slot and keeps the rest");
  assertEqual(lateCancel.platformFeeCents, 500, "late cancel: Tími takes its late-cancel fee");
  assertEqual(lateCancel.refundAmountCents, 0, "late cancel: nothing is refunded");

  const freeCancel = splitForOutcome(BASELINE_POLICY, "free_cancel", 5000);
  assertEqual(freeCancel.clinicAmountCents, 0, "free cancel: the clinic gets nothing");
  assertEqual(freeCancel.platformFeeCents, 0, "free cancel: Tími charges nothing");
  assertEqual(freeCancel.refundAmountCents, 5000, "free cancel: the customer is refunded in full");

  const clinicCancelled = splitForOutcome(BASELINE_POLICY, "clinic_cancelled", 5000);
  assertEqual(clinicCancelled.refundAmountCents, 5000, "clinic cancellation: the customer is refunded in full");
  assertEqual(clinicCancelled.platformFeeCents, 0, "clinic cancellation: Tími charges nothing");

  // A non-refundable policy has no free-cancel path at all. An emergency
  // hospital that disclosed this must not have it quietly reinstated.
  const nonRefundable = splitForOutcome({ ...BASELINE_POLICY, depositRefundable: false }, "free_cancel", 7500);
  assertEqual(nonRefundable.outcome, "late_cancel", "non-refundable policy: a cancellation is a late cancel however early");
  assertEqual(nonRefundable.refundAmountCents, 0, "non-refundable policy: nothing is refunded");
  assertEqual(nonRefundable.clinicAmountCents, 7000, "non-refundable policy: the clinic keeps the deposit less the fee");

  for (const outcome of ["completed", "no_show", "late_cancel", "free_cancel", "clinic_cancelled"]) {
    for (const deposit of [0, 1, 499, 5000, 7500, 123_456]) {
      const split = splitForOutcome(BASELINE_POLICY, outcome, deposit);
      assertEqual(
        split.clinicAmountCents + split.platformFeeCents + split.refundAmountCents,
        deposit,
        `${outcome} at ${deposit}: the three parts must sum to the deposit`
      );
      assert(split.clinicAmountCents >= 0 && split.platformFeeCents >= 0 && split.refundAmountCents >= 0, `${outcome} at ${deposit}: no part may be negative`);
    }
  }
  record("split arithmetic for every outcome");
}

/* -------------------------------------------------------- 2. rounding --- */
{
  // 2.5% of $49.99 is 124.975 cents. Flooring keeps the stray cent on the
  // clinic's side of the line; rounding up would take money that is not ours
  // and, at the boundary, transfer more than was charged.
  const percentagePolicy = { ...BASELINE_POLICY, details: { platformFeeBasisPoints: 250 } };
  assertEqual(platformFeeFor(percentagePolicy, "completed", 4999), 2124, "a fractional percentage fee is floored, not rounded");
  const split = splitForOutcome(percentagePolicy, "completed", 4999);
  assertEqual(split.clinicAmountCents, 2875, "the clinic gets the exact remainder after a floored fee");
  assertEqual(split.clinicAmountCents + split.platformFeeCents, 4999, "a floored fee still balances against the deposit");

  // A fee larger than the deposit is a misconfiguration. Capping it means the
  // clinic is paid nothing; not capping it means a negative transfer, which
  // Stripe rejects with an error nobody sees.
  const overCharging = { ...BASELINE_POLICY, completedPlatformFeeCents: 9000 };
  const capped = splitForOutcome(overCharging, "completed", 5000);
  assertEqual(capped.platformFeeCents, 5000, "a fee larger than the deposit is capped at the deposit");
  assertEqual(capped.clinicAmountCents, 0, "a capped fee leaves the clinic zero, never a negative transfer");

  for (let deposit = 1; deposit <= 400; deposit += 1) {
    for (const bps of [1, 37, 250, 999, 10_000]) {
      const policy = { ...BASELINE_POLICY, completedPlatformFeeCents: 0, details: { platformFeeBasisPoints: bps } };
      const rounded = splitForOutcome(policy, "completed", deposit);
      assert(rounded.clinicAmountCents <= deposit, `transfer of ${rounded.clinicAmountCents} exceeds the ${deposit} charged`);
      assert(rounded.platformFeeCents <= deposit, `fee of ${rounded.platformFeeCents} exceeds the ${deposit} charged`);
    }
  }
  record("rounding never transfers more than was charged");
}

/* ------------------------------------------- 3. outcome from the intake --- */
{
  const arrivalBy = new Date(Date.now() + 60 * 60_000).toISOString();
  const early = outcomeForIntake({ status: "cancelled", arrivalBy, policy: { freeCancelMinutes: 20 } });
  assertEqual(early, "free_cancel", "cancelling an hour before a 20-minute window is free");

  const late = outcomeForIntake({ status: "cancelled", arrivalBy: new Date(Date.now() + 5 * 60_000).toISOString(), policy: { freeCancelMinutes: 20 } });
  assertEqual(late, "late_cancel", "cancelling inside the free window is a late cancel");

  assertEqual(outcomeForIntake({ status: "completed" }), "completed", "a completed visit settles as completed");
  assertEqual(outcomeForIntake({ status: "no_show" }), "no_show", "a missed arrival settles as a no-show");
  assertEqual(outcomeForIntake({ status: "declined" }), "clinic_cancelled", "a declined intake refunds in full");
  assertEqual(outcomeForIntake({ status: "accepted" }), null, "an intake still in progress has no outcome yet");
  record("outcome derived from intake state");
}

/* --------------------------------- 4. webhook signature verification --- */
{
  const payload = JSON.stringify({ id: "evt_signature_test", type: "ping" });
  const now = Math.floor(Date.now() / 1000);

  const valid = await verifyWebhookSignature(payload, await stripeSignature(payload, WEBHOOK_SECRET, now), WEBHOOK_SECRET, { nowSeconds: now });
  assert(valid.ok, "a correctly signed payload must verify");

  const wrongSecret = await verifyWebhookSignature(payload, await stripeSignature(payload, "whsec_a_different_secret", now), WEBHOOK_SECRET, { nowSeconds: now });
  assert(!wrongSecret.ok, "a signature made with another secret must be rejected");

  const tampered = await verifyWebhookSignature(`${payload} `, await stripeSignature(payload, WEBHOOK_SECRET, now), WEBHOOK_SECRET, { nowSeconds: now });
  assert(!tampered.ok, "a body altered after signing must be rejected");

  const stale = await verifyWebhookSignature(payload, await stripeSignature(payload, WEBHOOK_SECRET, now - 3600), WEBHOOK_SECRET, { nowSeconds: now });
  assert(!stale.ok, "an hour-old signature must be rejected by the tolerance");
  assert(/tolerance/i.test(stale.reason), "the stale rejection must say it was the tolerance");

  const future = await verifyWebhookSignature(payload, await stripeSignature(payload, WEBHOOK_SECRET, now + 3600), WEBHOOK_SECRET, { nowSeconds: now });
  assert(!future.ok, "a signature stamped in the future must be rejected too");

  const noSecret = await verifyWebhookSignature(payload, await stripeSignature(payload, WEBHOOK_SECRET, now), "", { nowSeconds: now });
  assert(!noSecret.ok, "verification without a configured secret must fail closed, never open");

  const missing = await verifyWebhookSignature(payload, "", WEBHOOK_SECRET, { nowSeconds: now });
  assert(!missing.ok, "a missing Stripe-Signature header must be rejected");

  // Only v1 counts. Stripe sends a fake v0 on test events, and accepting any
  // scheme that is not v1 is exactly the downgrade the docs warn about.
  const v0Only = await verifyWebhookSignature(payload, `t=${now},v0=deadbeef`, WEBHOOK_SECRET, { nowSeconds: now });
  assert(!v0Only.ok, "a v0-only header must be rejected");
  assertEqual(parseStripeSignatureHeader(`t=1,v1=aa,v0=bb`).signatures.length, 1, "only v1 signatures are collected from the header");

  // Rolling an endpoint secret puts two v1 signatures in one header; either
  // matching is enough.
  const rolled = await stripeSignature(payload, WEBHOOK_SECRET, now);
  const both = `${rolled},v1=${"0".repeat(64)}`;
  assert((await verifyWebhookSignature(payload, both, WEBHOOK_SECRET, { nowSeconds: now })).ok, "one matching signature among several must pass");

  record("webhook signature verification");
}

/* ------------------------------ 5. the webhook route end to end, twice --- */
{
  resetStripe();
  const intakeId = "intake_webhook_capture";
  await seedIntake({ id: intakeId, status: "accepted", paymentStatus: "requires_action", paymentIntentId: "pi_capture_1" });

  const event = {
    id: "evt_capture_1",
    type: "payment_intent.succeeded",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    data: {
      object: {
        id: "pi_capture_1",
        object: "payment_intent",
        amount: 5000,
        amount_received: 5000,
        currency: "usd",
        status: "succeeded",
        latest_charge: { id: "ch_capture_1", balance_transaction: { id: "txn_capture_1", fee: 175, available_on: Math.floor(Date.now() / 1000) + 172800 } },
        transfer_group: transferGroupFor(intakeId),
        metadata: { intake_id: intakeId, tenant_id: "tenant_cedar", search_id: "" }
      }
    }
  };
  const body = JSON.stringify(event);
  const signature = await stripeSignature(body, WEBHOOK_SECRET, Math.floor(Date.now() / 1000));

  const post = (headers) => worker.fetch(new Request("https://timinow.pet/api/stripe/webhook", { method: "POST", headers, body }), LIVE_ENV, { waitUntil() {} });

  const forged = await post({ "content-type": "application/json", "stripe-signature": await stripeSignature(body, "whsec_forged", Math.floor(Date.now() / 1000)) });
  assertEqual(forged.status, 400, "a forged webhook signature must be refused");
  assertEqual(database.prepare("SELECT payment_status FROM intake_requests WHERE id = ?").get(intakeId).payment_status, "requires_action", "a refused webhook must not mark anything paid");

  const unsigned = await post({ "content-type": "application/json" });
  assertEqual(unsigned.status, 400, "an unsigned webhook must be refused");

  const accepted = await post({ "content-type": "application/json", "stripe-signature": signature });
  assertEqual(accepted.status, 200, "a correctly signed webhook is accepted");
  assertEqual(database.prepare("SELECT payment_status FROM intake_requests WHERE id = ?").get(intakeId).payment_status, "paid", "the capture webhook marks the deposit paid");

  const ledgerRows = database.prepare("SELECT * FROM payment_ledger WHERE intake_id = ? AND kind = 'deposit_captured'").all(intakeId);
  assertEqual(ledgerRows.length, 1, "the capture writes exactly one ledger row");
  assertEqual(ledgerRows[0].charge_id, "ch_capture_1", "the ledger records the charge id a payout report is joined on");
  assertEqual(ledgerRows[0].balance_transaction_id, "txn_capture_1", "the ledger records the balance transaction");
  assertEqual(ledgerRows[0].fee_cents, 175, "the ledger records Stripe's own fee");
  assertEqual(ledgerRows[0].transfer_group, transferGroupFor(intakeId), "the ledger records the transfer group");
  assertEqual(ledgerRows[0].stripe_event_id, "evt_capture_1", "the ledger records which event produced the row");

  // The redelivery. Stripe will send this again on its own, and processing it
  // twice would claim we captured ten thousand cents.
  const replay = await post({ "content-type": "application/json", "stripe-signature": signature });
  assertEqual(replay.status, 200, "a redelivered event is acknowledged, not errored");
  const afterReplay = database.prepare("SELECT COUNT(*) AS total FROM payment_ledger WHERE intake_id = ? AND kind = 'deposit_captured'").get(intakeId);
  assertEqual(Number(afterReplay.total), 1, "a redelivered event must not write a second ledger row");
  assertEqual(Number(database.prepare("SELECT attempts FROM stripe_events WHERE id = 'evt_capture_1'").get().attempts), 2, "the redelivery is counted against the stored event");

  record("webhook route: forged rejected, valid applied, replay is a no-op");
}

/* ------------------- 6. a refund redelivered is also written only once --- */
{
  const intakeId = "intake_webhook_capture";
  const refundEvent = (id) => ({
    id,
    type: "charge.refunded",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: "ch_capture_1",
        object: "charge",
        currency: "usd",
        amount_refunded: 5000,
        refunded: true,
        payment_intent: "pi_capture_1",
        metadata: { intake_id: intakeId, tenant_id: "tenant_cedar" },
        refunds: { data: [{ id: "re_capture_1", amount: 5000, status: "succeeded", balance_transaction: "txn_refund_1" }] }
      }
    }
  });

  await handleStripeEvent(LIVE_ENV, refundEvent("evt_refund_1"));
  const duplicate = await handleStripeEvent(LIVE_ENV, refundEvent("evt_refund_1"));
  assert(duplicate.duplicate, "the second delivery of the same event id is reported as a duplicate");
  assertEqual(
    Number(database.prepare("SELECT COUNT(*) AS total FROM payment_ledger WHERE kind = 'customer_refund' AND refund_id = 're_capture_1'").get().total),
    1,
    "processing charge.refunded twice must not write two refund rows"
  );
  record("charge.refunded redelivery writes one row");
}

/* ------------------------- 7. a transfer is refused without capability --- */
{
  resetStripe();
  const intakeId = "intake_restricted_clinic";
  const intake = await seedIntake({ id: intakeId, tenantId: "tenant_solano", locationId: "loc_solano", status: "completed", paymentStatus: "paid", paymentIntentId: "pi_restricted" });

  // A connected account that exists but is not yet allowed to receive money —
  // the ordinary state of a clinic part-way through onboarding.
  await recordStripeAccount(LIVE_ENV, {
    tenantId: "tenant_solano",
    stripeAccountId: "acct_restricted",
    accountsApi: "v1",
    account: { id: "acct_restricted", country: "US", payouts_enabled: false, details_submitted: true, capabilities: { transfers: "pending" }, requirements: { currently_due: ["external_account"] } }
  });

  // The refresh this triggers gets the same answer, so the refusal stands.
  queueStripe({ id: "acct_restricted", payouts_enabled: false, details_submitted: true, capabilities: { transfers: "pending" }, requirements: { currently_due: ["external_account"] } });

  const refused = await settleIntake(LIVE_ENV, intake, {});
  assert(!refused.settled, "an intake must not settle when the clinic cannot receive a transfer");
  assertEqual(refused.reason, "TRANSFERS_NOT_ENABLED", "the refusal names the missing capability");
  assertEqual(callsTo("/v1/transfers").length, 0, "no transfer may be attempted against a restricted account");
  assertEqual(
    database.prepare("SELECT settlement_outcome FROM intake_requests WHERE id = ?").get(intakeId).settlement_outcome,
    null,
    "a refused settlement leaves the intake unsettled so the sweep retries it"
  );
  record("transfer refused when the connected account cannot receive one");
}

/* ---------------- 8. a real settlement: amounts, fee, idempotency key --- */
{
  resetStripe();
  const intakeId = "intake_settles_cleanly";
  const intake = await seedIntake({ id: intakeId, status: "completed", paymentStatus: "paid", paymentIntentId: "pi_settle_1" });

  // The capture row is what tells the settlement which charge funded it.
  database.prepare(`
    INSERT INTO payment_ledger (id, occurred_at, kind, direction, amount_cents, currency, stripe_object_id, stripe_object_type, payment_intent_id, charge_id, tenant_id, intake_id, status, stripe_event_id)
    VALUES ('ledger_seed_capture', datetime('now'), 'deposit_captured', 'in', 5000, 'usd', 'pi_settle_1', 'payment_intent', 'pi_settle_1', 'ch_settle_1', 'tenant_cedar', ?, 'succeeded', 'evt_seed_capture')
  `).run(intakeId);

  await recordStripeAccount(LIVE_ENV, {
    tenantId: "tenant_cedar",
    stripeAccountId: "acct_cedar_live",
    accountsApi: "v1",
    account: { id: "acct_cedar_live", country: "US", payouts_enabled: true, details_submitted: true, capabilities: { transfers: "active", card_payments: "inactive" }, requirements: {} }
  });

  queueStripe({ id: "tr_settle_1", object: "transfer", amount: 3000, currency: "usd", destination: "acct_cedar_live", created: Math.floor(Date.now() / 1000), balance_transaction: "txn_transfer_1" });

  const settled = await settleIntake(LIVE_ENV, intake, {});
  assert(settled.settled, "a completed intake with an active clinic account settles");
  assertEqual(settled.split.clinicAmountCents, 3000, "the clinic is transferred the deposit less the completed fee");
  assertEqual(settled.split.platformFeeCents, 2000, "Tími retains its completed fee");

  const transfers = callsTo("/v1/transfers");
  assertEqual(transfers.length, 1, "exactly one transfer is created");
  assertEqual(transfers[0].form.amount, "3000", "the transfer carries the clinic's share, not the whole deposit");
  assertEqual(transfers[0].form.destination, "acct_cedar_live", "the transfer names the clinic's connected account");
  assertEqual(transfers[0].form.source_transaction, "ch_settle_1", "the transfer names the charge that funded it");
  assertEqual(transfers[0].form.transfer_group, transferGroupFor(intakeId), "the transfer carries the intake's transfer group");
  assert(!("application_fee_amount" in transfers[0].form), "the fee is taken by transferring less, never with application_fee_amount");
  assert(!("destination" in transfers[0].form) || !transfers[0].form.transfer_data, "a separate transfer never carries destination-charge parameters");

  const expectedKey = idempotencyKey("transfer", intakeId, "completed", 3000);
  assertEqual(transfers[0].headers["idempotency-key"], expectedKey, "the transfer carries a key derived from our own ids");

  const feeRow = database.prepare("SELECT * FROM payment_ledger WHERE intake_id = ? AND kind = 'platform_fee'").get(intakeId);
  assert(feeRow, "the retained fee gets its own ledger row even though it is not a Stripe object");
  assertEqual(feeRow.amount_cents, 2000, "the fee row records what Tími kept");
  assertEqual(feeRow.direction, "in", "the fee is money staying with the platform");

  const transferRow = database.prepare("SELECT * FROM payment_ledger WHERE intake_id = ? AND kind = 'clinic_transfer'").get(intakeId);
  assertEqual(transferRow.stripe_account_id, "acct_cedar_live", "the transfer row names the connected account");
  assertEqual(transferRow.direction, "out", "the transfer is money leaving the platform");

  const stored = database.prepare("SELECT * FROM intake_requests WHERE id = ?").get(intakeId);
  assertEqual(stored.settlement_outcome, "completed", "the outcome is frozen onto the intake");
  assertEqual(stored.clinic_amount_cents, 3000, "the clinic's share is frozen onto the intake");
  assertEqual(stored.platform_fee_cents, 2000, "the fee is frozen onto the intake");
  assertEqual(stored.stripe_transfer_id, "tr_settle_1", "the transfer id is recorded on the intake");

  // Settling again must do nothing at all, not transfer again.
  const again = await settleIntake(LIVE_ENV, await getIntake(LIVE_ENV, intakeId), {});
  assert(!again.settled, "a settled intake does not settle a second time");
  assertEqual(again.reason, "ALREADY_SETTLED", "the second attempt says why it refused");
  assertEqual(callsTo("/v1/transfers").length, 1, "no second transfer is created");

  record("settlement transfers the clinic's share and retains the fee by transferring less");
}

/* ---------------------------------------- 9. idempotency key stability --- */
{
  // Same logical operation, same key — that is the entire contract. A random
  // key per attempt turns every retry into a second charge, which is the
  // failure the header exists to prevent.
  const first = idempotencyKey("transfer", "intake_abc", "completed", 3000);
  const second = idempotencyKey("transfer", "intake_abc", "completed", 3000);
  assertEqual(first, second, "the same operation produces the same key");
  assert(first !== idempotencyKey("transfer", "intake_abc", "no_show", 4500), "a different outcome is a different operation");
  assert(first !== idempotencyKey("transfer", "intake_def", "completed", 3000), "a different intake is a different operation");
  assert(idempotencyKey("pi", "intake_abc", 5000) !== idempotencyKey("pi", "intake_abc", 7500), "a changed deposit is a different operation");
  assert(first.length <= 255, "the key stays within Stripe's length limit");
  assert(idempotencyKey("transfer", "x".repeat(400)).length <= 255, "an over-long key is truncated rather than rejected by Stripe");

  // Retried after a timeout: the settlement path must rebuild the identical
  // key from the intake rather than minting a new one.
  resetStripe();
  const intakeId = "intake_retry_key";
  const intake = await seedIntake({ id: intakeId, status: "no_show", paymentStatus: "paid", paymentIntentId: "pi_retry" });
  database.prepare(`
    INSERT INTO payment_ledger (id, occurred_at, kind, direction, amount_cents, currency, stripe_object_id, stripe_object_type, charge_id, tenant_id, intake_id, status, stripe_event_id)
    VALUES ('ledger_retry_capture', datetime('now'), 'deposit_captured', 'in', 5000, 'usd', 'pi_retry', 'payment_intent', 'ch_retry', 'tenant_cedar', ?, 'succeeded', 'evt_retry_capture')
  `).run(intakeId);

  queueStripe({ id: "tr_retry_1", object: "transfer", amount: 4500, currency: "usd", destination: "acct_cedar_live", created: Math.floor(Date.now() / 1000) });
  await settleIntake(LIVE_ENV, intake, {});
  const keyA = callsTo("/v1/transfers")[0].headers["idempotency-key"];

  // Simulate the first attempt's response never arriving: the settlement flag
  // was never written, so the sweep comes back to the same intake.
  database.prepare("UPDATE intake_requests SET settlement_outcome = NULL, settled_at = NULL, stripe_transfer_id = NULL WHERE id = ?").run(intakeId);
  resetStripe();
  queueStripe({ id: "tr_retry_1", object: "transfer", amount: 4500, currency: "usd", destination: "acct_cedar_live", created: Math.floor(Date.now() / 1000) });
  await settleIntake(LIVE_ENV, await getIntake(LIVE_ENV, intakeId), {});
  const keyB = callsTo("/v1/transfers")[0].headers["idempotency-key"];
  assertEqual(keyB, keyA, "a retry of the same settlement sends the same idempotency key, so Stripe replays rather than pays twice");
  record("idempotency keys are stable across retries");
}

/* --------------------------------- 10. account capability normalization --- */
{
  const v1Active = accountCapabilities({ payouts_enabled: true, details_submitted: true, capabilities: { transfers: "active", card_payments: "active" }, requirements: {} }, { accountsApi: "v1" });
  assert(v1Active.transfersEnabled, "a v1 account with an active transfers capability and payouts enabled may receive transfers");

  // The trap this guards: `payouts_enabled` flips true before the transfers
  // capability activates on some accounts, and a transfer sent then is
  // rejected by Stripe with an error the clinic never hears about.
  const v1Half = accountCapabilities({ payouts_enabled: true, capabilities: { transfers: "pending" }, requirements: {} }, { accountsApi: "v1" });
  assert(!v1Half.transfersEnabled, "payouts_enabled alone is not permission to transfer");

  const v2Active = accountCapabilities({
    configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { status: "active" }, payouts: { status: "active" } } } } },
    requirements: {}
  }, { accountsApi: "v2" });
  assert(v2Active.transfersEnabled, "a v2 recipient with active stripe_transfers may receive transfers");
  assert(v2Active.payoutsEnabled, "a v2 recipient's payout status is read from the stripe_balance hash");

  const v2Pending = accountCapabilities({
    configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { status: "pending" } } } } },
    requirements: { currently_due: ["identity.individual.id_number"] }
  }, { accountsApi: "v2" });
  assert(!v2Pending.transfersEnabled, "a v2 recipient still pending may not receive transfers");

  assert(!accountCapabilities(null, {}).transfersEnabled, "a missing account is never transferable");
  record("connected-account capability normalization for v1 and v2");
}

/* ------------------------------------------- 11. the account creation body --- */
{
  resetStripe();
  const { createConnectedAccount } = await import("../src/stripe.js");
  queueStripe({ id: "acct_new_v1", capabilities: { transfers: "inactive" }, requirements: {} });
  await createConnectedAccount(LIVE_ENV, { tenantId: "tenant_cedar", email: "ops@example.com", businessName: "Cedar Grove", accountsApi: "v1" });
  const v1Call = callsTo("/v1/accounts")[0];
  assert(!("type" in v1Call.form), "the legacy account type parameter is never sent");
  assertEqual(v1Call.form["controller[stripe_dashboard][type]"], "express", "connected accounts get the Express dashboard");
  assertEqual(v1Call.form["controller[losses][payments]"], "application", "the platform is liable for losses");
  assertEqual(v1Call.form["controller[fees][payer]"], "application", "the platform pays Stripe's fees");
  assertEqual(v1Call.form["capabilities[transfers][requested]"], "true", "the transfers capability is requested");
  assert(!("capabilities[card_payments][requested]" in v1Call.form), "a clinic never takes card payments through Tími");

  resetStripe();
  queueStripe({ id: "acct_new_v2", configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { status: "inactive" } } } } }, requirements: {} });
  await createConnectedAccount(LIVE_ENV, { tenantId: "tenant_cedar", email: "ops@example.com", accountsApi: "v2" });
  const v2Call = callsTo("/v2/core/accounts")[0];
  assertEqual(v2Call.json.dashboard, "express", "a v2 account gets the Express dashboard");
  assertEqual(v2Call.json.configuration.recipient.capabilities.stripe_balance.stripe_transfers.requested, true, "a v2 account requests stripe_transfers on the recipient configuration");
  assert(v2Call.json.include.includes("configuration.recipient"), "the include array is sent, or v2 answers null for the capability we are about to read");
  assert(!("type" in v2Call.json), "the legacy account type parameter is never sent to v2 either");
  record("connected accounts are created without the legacy type parameter");
}

/* --------------------------------------- 12. form encoding of nested data --- */
{
  const encoded = encodeForm({ metadata: { intake_id: "intake_1", nested: { deep: 2 } }, expand: ["latest_charge"], flag: true });
  assertEqual(encoded.get("metadata[intake_id]"), "intake_1", "nested metadata is bracket-encoded");
  assertEqual(encoded.get("metadata[nested][deep]"), "2", "deeply nested values are bracket-encoded");
  assertEqual(encoded.get("expand[0]"), "latest_charge", "arrays are index-encoded");
  assertEqual(encoded.get("flag"), "true", "booleans are sent as Stripe expects them");
  assertEqual(encodeForm({ absent: undefined, blank: null }).toString(), "", "absent values are omitted, never sent as empty strings");
  record("form encoding");
}

/* -------------------------------------------------- 13. the demo path --- */
{
  // The whole test suite, and every local development run, happens with no
  // Stripe credentials. "No secret key" has to stay a working configuration.
  const DEMO_ENV = {
    DB,
    SIGN_IN_REQUIRED: "false",
    DEMO_MODE: "true",
    SURFACE: "customer",
    ASSETS: { fetch: async () => new Response("", { status: 404 }) }
  };
  const intakeId = "intake_demo_deposit";
  await seedIntake({ id: intakeId, status: "accepted", paymentStatus: "pending" });

  resetStripe();
  const response = await worker.fetch(
    new Request(`https://timinow.pet/api/intakes/${intakeId}/payment-intent`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    DEMO_ENV,
    { waitUntil() {} }
  );
  assertEqual(response.status, 201, "the demo deposit path still answers without Stripe credentials");
  const payload = await response.json();
  assertEqual(payload.mode, "demo", "with no secret key and DEMO_MODE on, the deposit completes in demo mode");
  assertEqual(payload.publishableKey, null, "no publishable key is invented when Stripe is not configured");
  assertEqual(callsTo("api.stripe.com").length, 0, "the demo path never calls Stripe");
  assertEqual(database.prepare("SELECT payment_status FROM intake_requests WHERE id = ?").get(intakeId).payment_status, "paid", "the demo deposit is marked paid locally");

  const status = await worker.fetch(new Request(`https://timinow.pet/api/intakes/${intakeId}/payment-status`), DEMO_ENV, { waitUntil() {} });
  assertEqual(status.status, 200, "payment-status keeps working on the demo path");
  assertEqual((await status.json()).paymentsProvider, "demo", "payment-status reports which provider is in play");

  // Without DEMO_MODE there is nothing honest to do, and pretending would be
  // marking an unpaid deposit paid.
  const HARD_ENV = { ...DEMO_ENV, DEMO_MODE: "false" };
  const unconfigured = await worker.fetch(
    new Request(`https://timinow.pet/api/intakes/intake_demo_unconfigured/payment-intent`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    HARD_ENV,
    { waitUntil() {} }
  );
  assertEqual(unconfigured.status, 404, "an unknown intake is a 404 before any payment decision is made");
  record("the demo path works with no STRIPE_SECRET_KEY");
}

/* -------------------------------------- 14. a live PaymentIntent request --- */
{
  resetStripe();
  const intakeId = "intake_live_deposit";
  await seedIntake({ id: intakeId, status: "accepted", paymentStatus: "pending" });
  queueStripe({ id: "pi_live_1", object: "payment_intent", amount: 5000, currency: "usd", status: "requires_payment_method", client_secret: "pi_live_1_secret_x", created: Math.floor(Date.now() / 1000) });

  const response = await worker.fetch(
    new Request(`https://timinow.pet/api/intakes/${intakeId}/payment-intent`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    LIVE_ENV,
    { waitUntil() {} }
  );
  assertEqual(response.status, 201, "the live deposit path answers 201");
  const payload = await response.json();
  assertEqual(payload.clientSecret, "pi_live_1_secret_x", "the client secret reaches the client that will mount Elements");
  assertEqual(payload.publishableKey, "pk_test_not_a_real_key", "the publishable key is served with it so no client holds its own copy");

  const created = callsTo("/v1/payment_intents")[0];
  assertEqual(created.form.amount, "5000", "the PaymentIntent is for the deposit amount");
  assertEqual(created.form["metadata[intake_id]"], intakeId, "the metadata carries the intake a webhook will have to find");
  assertEqual(created.form["metadata[tenant_id]"], "tenant_cedar", "the metadata carries the tenant");
  assertEqual(created.form.transfer_group, transferGroupFor(intakeId), "the transfer group is set at creation, since it cannot be set later");
  assert(!("transfer_data[destination]" in created.form), "a separate charge never names a destination");
  assert(!("application_fee_amount" in created.form), "the platform fee is never an application fee");
  assertEqual(created.headers["idempotency-key"], idempotencyKey("pi", intakeId, 5000), "the PaymentIntent carries a key derived from the intake and the amount");

  // A second request for the same intake must not open a second intent
  // against the same card.
  resetStripe();
  queueStripe({ id: "pi_live_1", object: "payment_intent", amount: 5000, currency: "usd", status: "requires_payment_method", client_secret: "pi_live_1_secret_x", created: Math.floor(Date.now() / 1000) });
  await worker.fetch(
    new Request(`https://timinow.pet/api/intakes/${intakeId}/payment-intent`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    LIVE_ENV,
    { waitUntil() {} }
  );
  assertEqual(callsTo("/v1/payment_intents")[0].headers["idempotency-key"], idempotencyKey("pi", intakeId, 5000), "the retry sends the same key, so Stripe returns the existing intent");
  record("the PaymentIntent request is a separate charge with our metadata");
}

/* ---------------------------------------------- 15. ledger and earnings --- */
{
  const ledger = await listLedger(LIVE_ENV, { tenantId: "tenant_cedar" });
  assert(ledger.entries.length > 0, "the tenant ledger returns rows");
  assert(ledger.totals.platformFeeCents > 0, "the ledger totals include what Tími retained");
  assert(ledger.totals.unreconciledEntries === ledger.totals.entries, "nothing is reconciled until somebody reconciles it");
  assertEqual(ledger.totals.netCents, ledger.totals.inCents - ledger.totals.outCents, "the net is in minus out");

  const scoped = await listLedger(LIVE_ENV, { tenantId: "tenant_solano" });
  assert(scoped.entries.every((entry) => entry.tenantId === "tenant_solano"), "a tenant-scoped ledger never leaks another tenant's rows");

  const earnings = await clinicEarnings(LIVE_ENV, "tenant_cedar");
  assert(earnings.transferredCents > 0, "the clinic view shows what has been transferred to it");
  assertEqual(earnings.awaitingPayoutCents, earnings.transferredCents - earnings.paidOutCents, "awaiting payout is what we sent less what Stripe has paid out");
  record("ledger reads, tenant scoping, and clinic earnings");
}

/* ---------------------------------------- 16. payout events land on a tenant --- */
{
  await handleStripeEvent(LIVE_ENV, {
    id: "evt_payout_1",
    type: "payout.paid",
    created: Math.floor(Date.now() / 1000),
    account: "acct_cedar_live",
    data: { object: { id: "po_1", object: "payout", amount: 3000, currency: "usd", status: "paid", arrival_date: Math.floor(Date.now() / 1000), balance_transaction: "txn_payout_1" } }
  });
  const row = database.prepare("SELECT * FROM payment_ledger WHERE payout_id = 'po_1'").get();
  assert(row, "a connected-account payout is recorded");
  assertEqual(row.tenant_id, "tenant_cedar", "the payout is attributed to the tenant that owns the connected account");
  assertEqual(row.balance_transaction_id, "txn_payout_1", "the payout records the balance transaction a report is joined on");

  const earnings = await clinicEarnings(LIVE_ENV, "tenant_cedar");
  assertEqual(earnings.paidOutCents, 3000, "the clinic view counts the payout Stripe has already sent");
  record("payout events attribute to a tenant");
}

/* ------------------------------------- 17. an unknown event is ignored --- */
{
  const ignored = await handleStripeEvent(LIVE_ENV, {
    id: "evt_unknown_1",
    type: "customer.subscription.created",
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: "sub_1" } }
  });
  assert(!ignored.handled, "an event type we do not handle is ignored, not an error");
  assertEqual(database.prepare("SELECT status FROM stripe_events WHERE id = 'evt_unknown_1'").get().status, "ignored", "an ignored event is still recorded, so a redelivery is still a no-op");
  record("unhandled event types are recorded and ignored");
}

console.log(`Stripe tests passed (${results.length} groups): ${results.join("; ")}.`);
