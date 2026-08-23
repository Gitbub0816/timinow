/**
 * The money logic. Transport lives in `src/stripe.js`; nothing in this file
 * knows what a URL looks like, and every function that decides an amount is a
 * pure function you can call from a test with no network.
 *
 * ───────────────────────────────────────────────────────── the funds flow ──
 *
 * Tími is the merchant of record. The pet owner's arrival deposit is charged
 * to the *platform* account, and the clinic is paid afterwards by a separate
 * Transfer. That is Stripe's "separate charges and transfers", and it is not
 * a stylistic preference:
 *
 *   The split is not knowable at charge time.
 *
 * The owner pays when they select a clinic's offer. What happens to that
 * money — whether the clinic keeps most of it, whether Tími takes a
 * completed-intake fee or a no-show fee or a late-cancel fee, whether the
 * owner is refunded in full — is decided later, from the intake outcome, by
 * `splitForOutcome` below. A destination charge would have transferred the
 * money to the clinic at the moment the card was authorized, before any of
 * that was known, and the only way back would be reversing a transfer that
 * should never have been made.
 *
 * Tími's fee is collected by *transferring less*, never with
 * `application_fee_amount`. Same arithmetic, different meaning: an
 * application fee is a fee the connected account pays out of a charge it
 * owns, and the clinic does not own this charge. Transferring less is the
 * honest description of what happens — the platform holds the money and sends
 * on the clinic's share.
 *
 * Amounts are integer cents everywhere. There is no float in this file.
 */

import { hasDatabase } from "./db.js";
import {
  accountCapabilities,
  createPaymentIntent,
  createRefund,
  createTransfer,
  idempotencyKey,
  retrieveConnectedAccount,
  stripeConfigured,
  StripeError
} from "./stripe.js";

/** Outcomes the split understands. Anything else is a programming error. */
export const SETTLEMENT_OUTCOMES = ["completed", "no_show", "late_cancel", "free_cancel", "clinic_cancelled"];

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function nowIso() {
  return new Date().toISOString();
}

function timestampMs(value) {
  if (!value) return Number.NaN;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  return Date.parse(normalized);
}

function isoFromUnix(seconds) {
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : nowIso();
}

/** Clamp to a whole number of cents inside [0, maximum]. */
function clampCents(value, maximum) {
  const cents = Math.trunc(Number(value) || 0);
  if (cents <= 0) return 0;
  return cents > maximum ? maximum : cents;
}

/**
 * The `transfer_group` for an intake.
 *
 * One string per business action, which for Tími is one intake: one deposit
 * charge, at most one transfer to the clinic, at most one refund. It is set
 * on the PaymentIntent at creation because Stripe will not accept it later,
 * and it is what an operator joins on when a partial refund and a reduced
 * transfer have to be read together.
 */
export function transferGroupFor(intakeId) {
  return `timi_intake_${intakeId}`;
}

/* ───────────────────────────────────────────────────────── the split ───── */

/**
 * The platform's fee for one outcome, in cents.
 *
 * The flat per-outcome fees come from `tenant_policies`. A tenant may
 * additionally carry a percentage in its `policy_json` as basis points
 * (`platformFeeBasisPoints`, or a per-outcome override), which is where
 * rounding enters: 2.5% of a $50 deposit is 125 cents exactly, but 2.5% of
 * $49.99 is 124.975.
 *
 * That is floored, never rounded. Rounding up would take a cent that belongs
 * to the clinic; over a few thousand intakes it becomes a reconciliation
 * discrepancy nobody can explain. Flooring is at worst a cent in the clinic's
 * favour, which nobody ever has to explain.
 *
 * The result is capped at the deposit. A tenant whose completed fee exceeds
 * its own deposit is a misconfiguration, and the failure mode without the cap
 * is a negative transfer — Stripe rejects it, the clinic is never paid, and
 * the reason is buried in an API error.
 */
export function platformFeeFor(policy, outcome, depositCents) {
  const deposit = clampCents(depositCents, Number.MAX_SAFE_INTEGER);
  if (deposit <= 0) return 0;
  const details = policy?.details || {};
  const flat = {
    completed: policy?.completedPlatformFeeCents,
    no_show: policy?.noShowPlatformFeeCents,
    late_cancel: policy?.lateCancelPlatformFeeCents,
    free_cancel: 0,
    clinic_cancelled: 0
  }[outcome] ?? 0;
  const basisPoints = {
    completed: details.completedPlatformFeeBasisPoints,
    no_show: details.noShowPlatformFeeBasisPoints,
    late_cancel: details.lateCancelPlatformFeeBasisPoints,
    free_cancel: 0,
    clinic_cancelled: 0
  }[outcome] ?? details.platformFeeBasisPoints ?? 0;
  const points = Math.max(0, Math.trunc(Number(basisPoints) || 0));
  const percentage = Math.floor((deposit * points) / 10_000);
  return clampCents(Math.trunc(Number(flat) || 0) + percentage, deposit);
}

/**
 * Where the deposit goes, for one outcome.
 *
 * Returns three integers that always sum to exactly the deposit:
 *
 *   clinicAmountCents   what we transfer to the connected account
 *   platformFeeCents    what Tími keeps, by transferring that much less
 *   refundAmountCents   what goes back to the customer's card
 *
 * The remainder is assigned last rather than computed independently, so the
 * three can never drift apart by a rounding cent. The invariant is asserted
 * here and again in scripts/stripe-test.mjs for every outcome, because a
 * split that does not sum is money that exists in the ledger and not in
 * Stripe.
 *
 * The rules, from docs/PAYMENTS-AND-TENANT-POLICIES.md:
 *
 *   completed        Tími takes its completed-intake fee; the clinic gets the
 *                    rest. The customer is not refunded — the whole deposit
 *                    is still credited against the clinic's invoice.
 *   no_show          Tími takes its no-show fee; the clinic keeps the rest,
 *                    because it held capacity for somebody who never came.
 *   late_cancel      Same shape, the late-cancel fee. The clinic held the
 *                    slot; that is what the fee is for.
 *   free_cancel      Full refund, no fee, no transfer. This is the promise
 *                    made on screen before the card was entered, and a fee
 *                    here would break it.
 *   clinic_cancelled Full refund, no fee. The customer did nothing wrong.
 *
 * `depositRefundable: false` removes the free-cancel path entirely: a
 * cancellation on a non-refundable policy is a late cancel however early it
 * arrives. Emergency hospitals use this, and it is disclosed before payment.
 */
export function splitForOutcome(policy, outcome, depositCents) {
  const deposit = clampCents(depositCents, Number.MAX_SAFE_INTEGER);
  if (!SETTLEMENT_OUTCOMES.includes(outcome)) {
    throw new Error(`Unknown settlement outcome: ${outcome}`);
  }
  if (deposit <= 0) {
    return { outcome, depositCents: 0, clinicAmountCents: 0, platformFeeCents: 0, refundAmountCents: 0 };
  }

  const effective = outcome === "free_cancel" && policy?.depositRefundable === false ? "late_cancel" : outcome;
  const platformFeeCents = platformFeeFor(policy, effective, deposit);

  let refundAmountCents = 0;
  if (effective === "free_cancel" || effective === "clinic_cancelled") refundAmountCents = deposit;

  // Whatever is left after the fee and the refund. Never negative, because
  // both were already capped at the deposit and they are never both non-zero.
  const clinicAmountCents = deposit - platformFeeCents - refundAmountCents;

  const split = {
    outcome: effective,
    depositCents: deposit,
    clinicAmountCents,
    platformFeeCents,
    refundAmountCents
  };
  if (clinicAmountCents < 0 || clinicAmountCents + platformFeeCents + refundAmountCents !== deposit) {
    // Unreachable by construction; kept because the day it is reachable is
    // the day the split silently invents or destroys money, and a thrown
    // error is very much better than a transfer.
    throw new Error(`Split does not balance for ${outcome}: ${JSON.stringify(split)} against ${deposit}`);
  }
  return split;
}

/**
 * Which outcome an intake settled into, from its own state.
 *
 * Derived rather than passed in, so the clinic console and the expiry sweep
 * cannot disagree about what happened. `free_cancel` is a cancellation that
 * arrived at least `freeCancelMinutes` before the arrival time the customer
 * was promised — measured against `arrivalBy`, because that is the commitment
 * the window is protecting, and falling back to the acceptance time when a
 * clinic never set one.
 */
export function outcomeForIntake(intake, { now = Date.now() } = {}) {
  const status = intake?.status;
  if (status === "completed" || status === "seen") return "completed";
  if (status === "no_show") return "no_show";
  if (status === "declined" || status === "expired") return "clinic_cancelled";
  if (status !== "cancelled") return null;

  const freeCancelMinutes = Math.max(0, Math.trunc(Number(intake?.policy?.freeCancelMinutes) || 0));
  const deadlineSource = timestampMs(intake?.arrivalBy) || timestampMs(intake?.decisionAt);
  if (!Number.isFinite(deadlineSource)) return "late_cancel";
  return now <= deadlineSource - freeCancelMinutes * 60_000 ? "free_cancel" : "late_cancel";
}

/* ─────────────────────────────────────────────────── connected accounts ── */

function boolean(value) {
  return value === true || value === 1 || value === "1";
}

export function stripeAccountFromRow(row) {
  if (!row) return null;
  let requirements = {};
  try { requirements = JSON.parse(row.requirements_json || "{}"); } catch { requirements = {}; }
  return {
    tenantId: row.tenant_id,
    stripeAccountId: row.stripe_account_id,
    accountsApi: row.accounts_api || "v1",
    transfersStatus: row.transfers_status,
    chargesStatus: row.charges_status,
    payoutsStatus: row.payouts_status,
    transfersEnabled: boolean(row.transfers_enabled),
    payoutsEnabled: boolean(row.payouts_enabled),
    detailsSubmitted: boolean(row.details_submitted),
    onboardingStatus: row.onboarding_status,
    requirements,
    disabledReason: row.disabled_reason,
    country: row.country,
    defaultCurrency: row.default_currency,
    capabilitiesRefreshedAt: row.capabilities_refreshed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function getStripeAccountForTenant(env, tenantId) {
  if (!hasDatabase(env) || !tenantId) return null;
  const row = await env.DB.prepare("SELECT * FROM stripe_accounts WHERE tenant_id = ? LIMIT 1").bind(tenantId).first();
  return stripeAccountFromRow(row);
}

export async function getStripeAccountById(env, stripeAccountId) {
  if (!hasDatabase(env) || !stripeAccountId) return null;
  const row = await env.DB.prepare("SELECT * FROM stripe_accounts WHERE stripe_account_id = ? LIMIT 1").bind(stripeAccountId).first();
  return stripeAccountFromRow(row);
}

/**
 * Derive the onboarding state a console should show.
 *
 * Kept separate from the capability strings because "restricted" and
 * "in progress" look identical in the raw data — both have outstanding
 * requirements — and mean opposite things to whoever has to chase the clinic.
 */
export function onboardingStatusFrom(capabilities) {
  if (capabilities.disabledReason) return "disabled";
  if (capabilities.transfersEnabled) return "complete";
  if (capabilities.transfersStatus === "pending" || capabilities.detailsSubmitted) return "restricted";
  return "in_progress";
}

/**
 * Write what Stripe currently says about a connected account.
 *
 * Called from account creation, from the `account.updated` webhook, and from
 * an explicit refresh in the admin console. All three go through here so the
 * derived `transfers_enabled` flag can never be computed two different ways.
 */
export async function recordStripeAccount(env, { tenantId, stripeAccountId, accountsApi = "v1", account, createdBy }) {
  if (!hasDatabase(env)) return null;
  const capabilities = accountCapabilities(account, { accountsApi });
  const onboarding = onboardingStatusFrom(capabilities);
  const now = nowIso();
  await env.DB.prepare(`
    INSERT INTO stripe_accounts (
      tenant_id, stripe_account_id, accounts_api, transfers_status, charges_status, payouts_status,
      transfers_enabled, payouts_enabled, details_submitted, onboarding_status, requirements_json,
      disabled_reason, country, default_currency, created_by, capabilities_refreshed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id) DO UPDATE SET
      stripe_account_id = excluded.stripe_account_id,
      accounts_api = excluded.accounts_api,
      transfers_status = excluded.transfers_status,
      charges_status = excluded.charges_status,
      payouts_status = excluded.payouts_status,
      transfers_enabled = excluded.transfers_enabled,
      payouts_enabled = excluded.payouts_enabled,
      details_submitted = excluded.details_submitted,
      onboarding_status = excluded.onboarding_status,
      requirements_json = excluded.requirements_json,
      disabled_reason = excluded.disabled_reason,
      capabilities_refreshed_at = excluded.capabilities_refreshed_at,
      updated_at = excluded.updated_at
  `).bind(
    tenantId,
    stripeAccountId,
    accountsApi,
    capabilities.transfersStatus,
    capabilities.chargesStatus,
    capabilities.payoutsStatus,
    capabilities.transfersEnabled ? 1 : 0,
    capabilities.payoutsEnabled ? 1 : 0,
    capabilities.detailsSubmitted ? 1 : 0,
    onboarding,
    JSON.stringify(capabilities.requirements || {}),
    capabilities.disabledReason || null,
    account?.country || account?.identity?.country || "US",
    account?.default_currency || "usd",
    createdBy || null,
    now,
    now,
    now
  ).run();
  return getStripeAccountForTenant(env, tenantId);
}

/**
 * May we transfer money to this clinic right now?
 *
 * Asked before every transfer and answered from our own table, refreshed from
 * Stripe when the row looks stale or unusable. Transferring to an account
 * whose capability is not active fails at Stripe with an error the clinic
 * never sees; the customer's money then sits in the platform balance
 * indefinitely with nothing recording why.
 */
export async function transferEligibility(env, tenantId, { refresh = false } = {}) {
  const stored = await getStripeAccountForTenant(env, tenantId);
  if (!stored) return { ok: false, reason: "NO_CONNECTED_ACCOUNT", message: "This clinic has not connected a Stripe account yet." };

  let account = stored;
  if (refresh || !stored.transfersEnabled) {
    // Only ever re-asked when the stored answer is "no". A cached "yes" is
    // safe: the worst case is a transfer Stripe rejects, which is recorded
    // and retried, whereas re-reading the account on every settlement adds a
    // round trip to the one path that must not be slow.
    if (stripeConfigured(env)) {
      try {
        const fresh = await retrieveConnectedAccount(env, stored.stripeAccountId, { accountsApi: stored.accountsApi });
        account = await recordStripeAccount(env, {
          tenantId,
          stripeAccountId: stored.stripeAccountId,
          accountsApi: stored.accountsApi,
          account: fresh
        }) || stored;
      } catch (error) {
        if (!(error instanceof StripeError)) throw error;
        return { ok: false, reason: "ACCOUNT_UNREADABLE", message: error.message, account: stored };
      }
    }
  }

  if (!account.transfersEnabled) {
    return {
      ok: false,
      reason: "TRANSFERS_NOT_ENABLED",
      message: account.disabledReason
        ? `Stripe has restricted this clinic's account (${account.disabledReason}). It cannot receive transfers.`
        : "This clinic's Stripe account cannot receive transfers yet; onboarding is incomplete.",
      account
    };
  }
  return { ok: true, account };
}

/* ────────────────────────────────────────────────────────── the ledger ── */

/**
 * Append one row.
 *
 * Every Stripe object we touch gets exactly one of these, and the write is
 * `INSERT OR IGNORE` against the partial unique index on
 * (stripe_event_id, stripe_object_id, kind) — so a webhook redelivered while
 * the first delivery is still in flight cannot produce a second row even
 * though both passed the `stripe_events` check.
 */
export async function recordLedgerEntry(env, entry) {
  if (!hasDatabase(env)) return null;
  const id = entry.id || newId("ledger");
  const amount = Math.abs(Math.trunc(Number(entry.amountCents) || 0));
  const fee = Math.abs(Math.trunc(Number(entry.feeCents) || 0));
  await env.DB.prepare(`
    INSERT OR IGNORE INTO payment_ledger (
      id, occurred_at, kind, direction, amount_cents, fee_cents, net_cents, currency,
      stripe_object_id, stripe_object_type, payment_intent_id, charge_id, transfer_id, refund_id,
      payout_id, balance_transaction_id, transfer_group, stripe_account_id, available_on,
      tenant_id, intake_id, search_id, status, reconciled, raw_json, stripe_event_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).bind(
    id,
    entry.occurredAt || nowIso(),
    entry.kind,
    entry.direction,
    amount,
    fee,
    entry.netCents === undefined || entry.netCents === null ? amount - fee : Math.trunc(Number(entry.netCents)),
    entry.currency || "usd",
    entry.stripeObjectId || null,
    entry.stripeObjectType || null,
    entry.paymentIntentId || null,
    entry.chargeId || null,
    entry.transferId || null,
    entry.refundId || null,
    entry.payoutId || null,
    entry.balanceTransactionId || null,
    entry.transferGroup || null,
    entry.stripeAccountId || null,
    entry.availableOn || null,
    entry.tenantId || null,
    entry.intakeId || null,
    entry.searchId || null,
    entry.status || "recorded",
    JSON.stringify(entry.raw || {}),
    entry.stripeEventId || null
  ).run();
  return id;
}

/* ──────────────────────────────────────────────────── deposit intents ── */

/**
 * Create (or return) the deposit PaymentIntent for an intake.
 *
 * The metadata is the only thing that lets a webhook, arriving with nothing
 * but a Stripe object, find its way back to an intake, a tenant, and the
 * search that produced it. Losing it means a successful payment nobody can
 * attribute.
 *
 * The idempotency key is derived from the intake id and the amount, not
 * generated: a retried request must return the PaymentIntent that already
 * exists rather than opening a second one against the same card. Including
 * the amount means a genuinely changed deposit gets a genuinely new intent
 * instead of silently replaying the old amount.
 */
export async function ensureDepositPaymentIntent(env, intake) {
  const depositCents = Math.trunc(Number(intake?.depositAmountCents) || 0);
  if (!intake?.policy?.depositRequired || depositCents <= 0) return { mode: "none", intake };
  if (intake.paymentStatus === "paid") return { mode: "paid", intake };

  const transferGroup = transferGroupFor(intake.id);

  if (!stripeConfigured(env)) {
    // The demo path, unchanged. The whole test suite and every local
    // development run happen without Stripe credentials, so "no secret key"
    // has to stay a working configuration rather than an error.
    if (env.DEMO_MODE !== "true") throw new Error("PAYMENTS_NOT_CONFIGURED");
    const providerId = newId("demo_payment");
    await env.DB.prepare("UPDATE intake_requests SET payment_status = 'paid', payment_provider_id = ?, transfer_group = ?, updated_at = ? WHERE id = ?")
      .bind(providerId, transferGroup, nowIso(), intake.id).run();
    return { mode: "demo", intake: await reloadIntake(env, intake.id) };
  }

  const payment = await createPaymentIntent(env, {
    amountCents: depositCents,
    currency: "usd",
    transferGroup,
    description: `Tími arrival deposit ${intake.publicCode}`,
    statementDescriptorSuffix: "TIMI DEPOSIT",
    metadata: {
      intake_id: intake.id,
      tenant_id: intake.tenantId,
      search_id: intake.sourceSearchId || "",
      public_code: intake.publicCode,
      policy_version: String(intake.policy?.version ?? "")
    },
    idempotencyKey: idempotencyKey("pi", intake.id, depositCents)
  });

  await env.DB.prepare(`
    UPDATE intake_requests
    SET payment_status = CASE WHEN payment_status = 'paid' THEN payment_status ELSE 'requires_action' END,
        payment_provider_id = ?, transfer_group = ?, updated_at = ?
    WHERE id = ?
  `).bind(payment.id, transferGroup, nowIso(), intake.id).run();

  await recordLedgerEntry(env, {
    occurredAt: isoFromUnix(payment.created),
    kind: "deposit_pending",
    // Nothing has moved yet, but the direction of the eventual movement is
    // what makes this row line up with the capture that supersedes it.
    direction: "in",
    amountCents: payment.amount,
    currency: payment.currency,
    stripeObjectId: payment.id,
    stripeObjectType: "payment_intent",
    paymentIntentId: payment.id,
    transferGroup,
    tenantId: intake.tenantId,
    intakeId: intake.id,
    searchId: intake.sourceSearchId || null,
    status: payment.status,
    raw: { amount: payment.amount, currency: payment.currency, status: payment.status }
  });

  return {
    mode: "stripe",
    clientSecret: payment.client_secret,
    paymentIntentId: payment.id,
    intake: await reloadIntake(env, intake.id)
  };
}

async function reloadIntake(env, intakeId) {
  const { getIntake } = await import("./db.js");
  return getIntake(env, intakeId);
}

/* ─────────────────────────────────────────────────────── settlement ───── */

/**
 * Pay the clinic (and refund the customer) for a settled intake.
 *
 * Runs from webhook handling and from the expiry sweep, never from a request
 * a client made. A client saying "this visit is complete" is a client asking
 * for money to move, and the clinic console's decision endpoint is what
 * changes the intake status; this reads that status afterwards.
 *
 * Returns `{ settled: false, reason }` rather than throwing for the ordinary
 * refusals — an unpaid deposit, a clinic that cannot receive transfers, an
 * intake already settled — because all three are states the caller must be
 * able to show, not exceptions.
 */
export async function settleIntake(env, intake, { outcome, stripeEventId, now = Date.now() } = {}) {
  if (!hasDatabase(env)) return { settled: false, reason: "DATABASE_REQUIRED" };
  const resolved = outcome || outcomeForIntake(intake, { now });
  if (!resolved) return { settled: false, reason: "OUTCOME_UNKNOWN" };
  if (intake.settlementOutcome) return { settled: false, reason: "ALREADY_SETTLED", split: null };

  const depositCents = Math.trunc(Number(intake.depositAmountCents) || 0);
  const split = splitForOutcome(intake.policy || {}, resolved, depositCents);

  // Nothing was ever captured, so there is nothing to divide. The outcome is
  // still recorded: "we decided this was a no-show and there was no money" is
  // a fact an operator will want later.
  if (depositCents <= 0 || intake.paymentStatus !== "paid") {
    await markSettled(env, intake, split, { transferId: null });
    return { settled: true, split, moved: false, reason: intake.paymentStatus === "paid" ? "NO_DEPOSIT" : "DEPOSIT_NOT_CAPTURED" };
  }

  const transferGroup = intake.transferGroup || transferGroupFor(intake.id);
  const chargeId = await chargeIdForIntake(env, intake);
  let transferId = null;

  if (split.clinicAmountCents > 0) {
    const eligibility = await transferEligibility(env, intake.tenantId);
    if (!eligibility.ok) {
      // Deliberately not settled. Leaving the intake unsettled is what makes
      // it reappear on the next sweep once the clinic finishes onboarding;
      // marking it settled with no transfer would strand the money silently.
      return { settled: false, reason: eligibility.reason, message: eligibility.message, split };
    }
    if (!stripeConfigured(env)) return { settled: false, reason: "PAYMENTS_NOT_CONFIGURED", split };

    const transfer = await createTransfer(env, {
      amountCents: split.clinicAmountCents,
      currency: "usd",
      destination: eligibility.account.stripeAccountId,
      transferGroup,
      // The charge that funded it. Without this the transfer is refused
      // whenever the deposit has not yet settled into the available balance,
      // which for a deposit taken hours ago is most of the time.
      sourceTransaction: chargeId || undefined,
      description: `Tími clinic settlement ${intake.publicCode} (${split.outcome})`,
      metadata: {
        intake_id: intake.id,
        tenant_id: intake.tenantId,
        search_id: intake.sourceSearchId || "",
        outcome: split.outcome,
        platform_fee_cents: String(split.platformFeeCents)
      },
      idempotencyKey: idempotencyKey("transfer", intake.id, split.outcome, split.clinicAmountCents)
    });
    transferId = transfer.id;

    await recordLedgerEntry(env, {
      occurredAt: isoFromUnix(transfer.created),
      kind: "clinic_transfer",
      direction: "out",
      amountCents: transfer.amount,
      currency: transfer.currency,
      stripeObjectId: transfer.id,
      stripeObjectType: "transfer",
      transferId: transfer.id,
      chargeId: chargeId || null,
      paymentIntentId: intake.paymentProviderId || null,
      balanceTransactionId: typeof transfer.balance_transaction === "string" ? transfer.balance_transaction : transfer.balance_transaction?.id || null,
      transferGroup,
      stripeAccountId: eligibility.account.stripeAccountId,
      tenantId: intake.tenantId,
      intakeId: intake.id,
      searchId: intake.sourceSearchId || null,
      status: "created",
      stripeEventId: stripeEventId || null,
      raw: { amount: transfer.amount, destination: transfer.destination, outcome: split.outcome }
    });
  }

  if (split.platformFeeCents > 0) {
    // Not a Stripe object — there is nothing to fetch, because the fee is
    // simply the money we did not transfer. It gets a row anyway: a ledger
    // that records the transfer and not the fee cannot be reconciled against
    // a deposit, and "where did the other twenty dollars go" is the question
    // this row exists to answer.
    await recordLedgerEntry(env, {
      occurredAt: nowIso(),
      kind: "platform_fee",
      direction: "in",
      amountCents: split.platformFeeCents,
      currency: "usd",
      stripeObjectId: transferId || intake.paymentProviderId || null,
      stripeObjectType: "application_fee",
      paymentIntentId: intake.paymentProviderId || null,
      chargeId: chargeId || null,
      transferId,
      transferGroup,
      tenantId: intake.tenantId,
      intakeId: intake.id,
      searchId: intake.sourceSearchId || null,
      status: "retained",
      stripeEventId: stripeEventId || null,
      raw: { outcome: split.outcome, depositCents: split.depositCents, retainedBy: "transferring_less" }
    });
  }

  if (split.refundAmountCents > 0 && stripeConfigured(env) && intake.paymentProviderId) {
    const refund = await createRefund(env, {
      paymentIntentId: intake.paymentProviderId,
      amountCents: split.refundAmountCents,
      reason: "requested_by_customer",
      metadata: { intake_id: intake.id, tenant_id: intake.tenantId, outcome: split.outcome },
      idempotencyKey: idempotencyKey("refund", intake.id, split.outcome, split.refundAmountCents)
    });
    // The ledger row for the refund is written by the `charge.refunded`
    // webhook, not here. A refund can fail asynchronously, and a row written
    // optimistically at request time would claim money went back that never
    // did.
    await env.DB.prepare("UPDATE intake_requests SET payment_status = 'refunded', updated_at = ? WHERE id = ?")
      .bind(nowIso(), intake.id).run();
    await recordIntakeEvent(env, intake.id, "refund_requested", { refundId: refund.id, amountCents: split.refundAmountCents, outcome: split.outcome });
  }

  await markSettled(env, intake, split, { transferId });
  return { settled: true, split, moved: true, transferId };
}

async function markSettled(env, intake, split, { transferId }) {
  const now = nowIso();
  await env.DB.prepare(`
    UPDATE intake_requests
    SET settlement_outcome = ?, settled_at = ?, clinic_amount_cents = ?, platform_fee_cents = ?,
        refund_amount_cents = ?, stripe_transfer_id = ?, transfer_group = COALESCE(transfer_group, ?), updated_at = ?
    WHERE id = ? AND settlement_outcome IS NULL
  `).bind(
    split.outcome, now, split.clinicAmountCents, split.platformFeeCents, split.refundAmountCents,
    transferId, transferGroupFor(intake.id), now, intake.id
  ).run();
  await recordIntakeEvent(env, intake.id, "settled", {
    outcome: split.outcome,
    clinicAmountCents: split.clinicAmountCents,
    platformFeeCents: split.platformFeeCents,
    refundAmountCents: split.refundAmountCents,
    transferId
  });
}

async function recordIntakeEvent(env, intakeId, type, detail) {
  await env.DB.prepare("INSERT INTO intake_events (id, intake_id, event_type, actor_type, actor_id, detail_json) VALUES (?, ?, ?, 'system', NULL, ?)")
    .bind(newId("event"), intakeId, type, JSON.stringify(detail || {})).run();
}

/**
 * The charge behind an intake's deposit.
 *
 * Read from the ledger rather than from Stripe: the capture webhook already
 * recorded it, and a settlement that has to round-trip to Stripe for an id it
 * was told hours ago is a settlement that fails when Stripe is slow.
 */
async function chargeIdForIntake(env, intake) {
  const row = await env.DB.prepare(`
    SELECT charge_id FROM payment_ledger
    WHERE intake_id = ? AND kind = 'deposit_captured' AND charge_id IS NOT NULL
    ORDER BY occurred_at DESC LIMIT 1
  `).bind(intake.id).first();
  return row?.charge_id || null;
}

/* ─────────────────────────────────────────────────── webhook handling ── */

/**
 * Claim an event id, returning false when it has already been processed.
 *
 * This is the idempotency gate, and it is a bare INSERT rather than a
 * SELECT-then-INSERT on purpose: Stripe redelivers, sometimes concurrently,
 * and a check followed by a write leaves a window in which two deliveries
 * both decide they are the first. The primary key collides instead.
 */
async function claimEvent(env, event) {
  try {
    const result = await env.DB.prepare(`
      INSERT INTO stripe_events (id, type, api_version, livemode, stripe_account_id, event_created_at, received_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'received')
    `).bind(
      event.id,
      event.type,
      event.api_version || null,
      event.livemode === false ? 0 : 1,
      event.account || null,
      isoFromUnix(event.created),
      nowIso()
    ).run();
    return Boolean(result.meta?.changes ?? 1);
  } catch (error) {
    // A primary-key collision is the expected outcome of a redelivery, not a
    // failure. Anything else is a real database problem and must surface.
    if (/UNIQUE|constraint/i.test(error.message || "")) {
      await env.DB.prepare("UPDATE stripe_events SET attempts = attempts + 1 WHERE id = ?").bind(event.id).run();
      return false;
    }
    throw error;
  }
}

async function finishEvent(env, eventId, status, result) {
  await env.DB.prepare("UPDATE stripe_events SET status = ?, processed_at = ?, result_json = ? WHERE id = ?")
    .bind(status, nowIso(), JSON.stringify(result || {}), eventId).run();
}

async function failEvent(env, eventId, message) {
  await env.DB.prepare("UPDATE stripe_events SET status = 'failed', processed_at = ?, last_error = ? WHERE id = ?")
    .bind(nowIso(), String(message).slice(0, 500), eventId).run();
}

function intakeIdFromMetadata(object) {
  return object?.metadata?.intake_id || null;
}

/**
 * Apply one verified Stripe event.
 *
 * This is the only place intake payment state changes. The client is never
 * believed: a phone that says "the sheet succeeded" is a phone that could be
 * lying, could have been closed before the payment actually cleared, or could
 * be a script. Stripe telling us, over a signed channel, is the fact.
 *
 * Returns `{ handled, ignored, duplicate }` so the route can log what
 * happened without re-deriving it.
 */
export async function handleStripeEvent(env, event) {
  if (!hasDatabase(env)) return { handled: false, ignored: true, reason: "DATABASE_REQUIRED" };
  if (!event?.id || !event?.type) return { handled: false, ignored: true, reason: "MALFORMED_EVENT" };

  const claimed = await claimEvent(env, event);
  if (!claimed) return { handled: false, duplicate: true, eventId: event.id };

  try {
    const result = await applyEvent(env, event);
    await finishEvent(env, event.id, result.handled ? "processed" : "ignored", result);
    return { ...result, eventId: event.id };
  } catch (error) {
    await failEvent(env, event.id, error.message);
    throw error;
  }
}

async function applyEvent(env, event) {
  const object = event.data?.object || {};
  const { getIntake } = await import("./db.js");

  switch (event.type) {
    case "payment_intent.succeeded": {
      const intakeId = intakeIdFromMetadata(object);
      const chargeId = typeof object.latest_charge === "string" ? object.latest_charge : object.latest_charge?.id || null;
      const charge = typeof object.latest_charge === "object" ? object.latest_charge : null;
      await recordLedgerEntry(env, {
        occurredAt: isoFromUnix(event.created),
        kind: "deposit_captured",
        direction: "in",
        amountCents: object.amount_received ?? object.amount,
        feeCents: charge?.balance_transaction?.fee ?? 0,
        currency: object.currency,
        stripeObjectId: object.id,
        stripeObjectType: "payment_intent",
        paymentIntentId: object.id,
        chargeId,
        balanceTransactionId: typeof charge?.balance_transaction === "string" ? charge.balance_transaction : charge?.balance_transaction?.id || null,
        availableOn: charge?.balance_transaction?.available_on ? isoFromUnix(charge.balance_transaction.available_on) : null,
        transferGroup: object.transfer_group || (intakeId ? transferGroupFor(intakeId) : null),
        tenantId: object.metadata?.tenant_id || null,
        intakeId,
        searchId: object.metadata?.search_id || null,
        status: "succeeded",
        stripeEventId: event.id,
        raw: { amount: object.amount, amount_received: object.amount_received, currency: object.currency }
      });
      if (intakeId) {
        await env.DB.prepare("UPDATE intake_requests SET payment_status = 'paid', payment_provider_id = ?, updated_at = ? WHERE id = ?")
          .bind(object.id, nowIso(), intakeId).run();
        await recordIntakeEvent(env, intakeId, "deposit_paid", { paymentIntentId: object.id, amountCents: object.amount_received ?? object.amount });
      }
      return { handled: true, intakeId };
    }

    case "payment_intent.processing": {
      const intakeId = intakeIdFromMetadata(object);
      if (intakeId) {
        await env.DB.prepare("UPDATE intake_requests SET payment_status = 'processing', updated_at = ? WHERE id = ? AND payment_status <> 'paid'")
          .bind(nowIso(), intakeId).run();
      }
      return { handled: true, intakeId };
    }

    case "payment_intent.payment_failed": {
      const intakeId = intakeIdFromMetadata(object);
      await recordLedgerEntry(env, {
        occurredAt: isoFromUnix(event.created),
        kind: "deposit_failed",
        direction: "in",
        amountCents: object.amount,
        currency: object.currency,
        stripeObjectId: object.id,
        stripeObjectType: "payment_intent",
        paymentIntentId: object.id,
        transferGroup: object.transfer_group || null,
        tenantId: object.metadata?.tenant_id || null,
        intakeId,
        searchId: object.metadata?.search_id || null,
        status: "failed",
        stripeEventId: event.id,
        raw: { code: object.last_payment_error?.code || null, declineCode: object.last_payment_error?.decline_code || null }
      });
      if (intakeId) {
        await env.DB.prepare("UPDATE intake_requests SET payment_status = 'failed', updated_at = ? WHERE id = ? AND payment_status <> 'paid'")
          .bind(nowIso(), intakeId).run();
      }
      return { handled: true, intakeId };
    }

    case "payment_intent.canceled": {
      const intakeId = intakeIdFromMetadata(object);
      await recordLedgerEntry(env, {
        occurredAt: isoFromUnix(event.created),
        kind: "deposit_canceled",
        direction: "in",
        amountCents: object.amount,
        currency: object.currency,
        stripeObjectId: object.id,
        stripeObjectType: "payment_intent",
        paymentIntentId: object.id,
        transferGroup: object.transfer_group || null,
        tenantId: object.metadata?.tenant_id || null,
        intakeId,
        status: "canceled",
        stripeEventId: event.id,
        raw: { reason: object.cancellation_reason || null }
      });
      return { handled: true, intakeId };
    }

    case "charge.refunded": {
      // The event carries the charge, not the refund, so the amount that
      // matters is the newest refund on it. Using `amount_refunded` would
      // re-record the whole refunded total on every partial refund.
      const refunds = object.refunds?.data || [];
      const refund = refunds[0] || null;
      const intakeId = object.metadata?.intake_id || refund?.metadata?.intake_id || null;
      await recordLedgerEntry(env, {
        occurredAt: isoFromUnix(event.created),
        kind: "customer_refund",
        direction: "out",
        amountCents: refund?.amount ?? object.amount_refunded,
        currency: object.currency,
        stripeObjectId: refund?.id || object.id,
        stripeObjectType: "refund",
        refundId: refund?.id || null,
        chargeId: object.id,
        paymentIntentId: typeof object.payment_intent === "string" ? object.payment_intent : object.payment_intent?.id || null,
        balanceTransactionId: typeof refund?.balance_transaction === "string" ? refund.balance_transaction : refund?.balance_transaction?.id || null,
        transferGroup: object.transfer_group || (intakeId ? transferGroupFor(intakeId) : null),
        tenantId: object.metadata?.tenant_id || null,
        intakeId,
        status: refund?.status || "succeeded",
        stripeEventId: event.id,
        raw: { amountRefunded: object.amount_refunded, fullyRefunded: Boolean(object.refunded) }
      });
      if (intakeId && object.refunded) {
        await env.DB.prepare("UPDATE intake_requests SET payment_status = 'refunded', updated_at = ? WHERE id = ?")
          .bind(nowIso(), intakeId).run();
      }
      return { handled: true, intakeId };
    }

    case "transfer.created":
    case "transfer.reversed": {
      const reversed = event.type === "transfer.reversed";
      const intakeId = intakeIdFromMetadata(object);
      await recordLedgerEntry(env, {
        occurredAt: isoFromUnix(event.created),
        kind: reversed ? "transfer_reversed" : "clinic_transfer",
        direction: reversed ? "in" : "out",
        amountCents: reversed ? object.amount_reversed : object.amount,
        currency: object.currency,
        stripeObjectId: object.id,
        stripeObjectType: "transfer",
        transferId: object.id,
        chargeId: typeof object.source_transaction === "string" ? object.source_transaction : object.source_transaction?.id || null,
        balanceTransactionId: typeof object.balance_transaction === "string" ? object.balance_transaction : object.balance_transaction?.id || null,
        transferGroup: object.transfer_group || null,
        stripeAccountId: typeof object.destination === "string" ? object.destination : object.destination?.id || null,
        tenantId: object.metadata?.tenant_id || null,
        intakeId,
        status: reversed ? "reversed" : "created",
        stripeEventId: event.id,
        raw: { amount: object.amount, amountReversed: object.amount_reversed }
      });
      return { handled: true, intakeId };
    }

    case "payout.paid":
    case "payout.failed": {
      // Connect events, so `event.account` names the clinic. The platform's
      // own payouts arrive with no account and are recorded the same way,
      // which is why the tenant lookup is allowed to come back empty.
      const stripeAccountId = event.account || null;
      const stored = stripeAccountId ? await getStripeAccountById(env, stripeAccountId) : null;
      await recordLedgerEntry(env, {
        occurredAt: isoFromUnix(object.arrival_date || event.created),
        kind: "clinic_payout",
        direction: "out",
        amountCents: object.amount,
        currency: object.currency,
        stripeObjectId: object.id,
        stripeObjectType: "payout",
        payoutId: object.id,
        balanceTransactionId: typeof object.balance_transaction === "string" ? object.balance_transaction : object.balance_transaction?.id || null,
        stripeAccountId,
        tenantId: stored?.tenantId || null,
        status: object.status || (event.type === "payout.paid" ? "paid" : "failed"),
        stripeEventId: event.id,
        raw: { status: object.status, failureCode: object.failure_code || null, arrivalDate: object.arrival_date || null }
      });
      return { handled: true, stripeAccountId };
    }

    case "charge.dispute.created": {
      const intakeId = object.metadata?.intake_id || null;
      await recordLedgerEntry(env, {
        occurredAt: isoFromUnix(event.created),
        kind: "dispute",
        direction: "out",
        amountCents: object.amount,
        currency: object.currency,
        stripeObjectId: object.id,
        stripeObjectType: "dispute",
        chargeId: typeof object.charge === "string" ? object.charge : object.charge?.id || null,
        paymentIntentId: typeof object.payment_intent === "string" ? object.payment_intent : object.payment_intent?.id || null,
        intakeId,
        status: object.status || "needs_response",
        stripeEventId: event.id,
        raw: { reason: object.reason || null }
      });
      return { handled: true, intakeId };
    }

    case "account.updated": {
      const stripeAccountId = object.id || event.account;
      const stored = await getStripeAccountById(env, stripeAccountId);
      if (!stored) return { handled: false, ignored: true, reason: "UNKNOWN_ACCOUNT" };
      await recordStripeAccount(env, {
        tenantId: stored.tenantId,
        stripeAccountId,
        accountsApi: stored.accountsApi,
        account: object
      });
      return { handled: true, stripeAccountId };
    }

    default: {
      // v2 events name the changed configuration in brackets, e.g.
      // `v2.core.account[configuration.recipient].updated`. Matched by prefix
      // rather than enumerated, because the bracketed part is a moving target
      // during the preview and an unmatched one would silently leave a
      // clinic's capability status stale.
      if (event.type.startsWith("v2.core.account")) {
        const stripeAccountId = object.id || event.related_object?.id || event.account;
        const stored = stripeAccountId ? await getStripeAccountById(env, stripeAccountId) : null;
        if (!stored) return { handled: false, ignored: true, reason: "UNKNOWN_ACCOUNT" };
        // A v2 thin event carries an id, not the object. Re-read it.
        if (stripeConfigured(env)) {
          const fresh = await retrieveConnectedAccount(env, stripeAccountId, { accountsApi: "v2" });
          await recordStripeAccount(env, { tenantId: stored.tenantId, stripeAccountId, accountsApi: "v2", account: fresh });
        }
        return { handled: true, stripeAccountId };
      }
      return { handled: false, ignored: true, reason: "UNHANDLED_TYPE" };
    }
  }
}

/* ─────────────────────────────────────────────────────── ledger reads ── */

export function ledgerRowToJson(row) {
  let raw = {};
  try { raw = JSON.parse(row.raw_json || "{}"); } catch { raw = {}; }
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    kind: row.kind,
    direction: row.direction,
    amountCents: row.amount_cents,
    feeCents: row.fee_cents,
    netCents: row.net_cents,
    currency: row.currency,
    stripeObjectId: row.stripe_object_id,
    stripeObjectType: row.stripe_object_type,
    paymentIntentId: row.payment_intent_id,
    chargeId: row.charge_id,
    transferId: row.transfer_id,
    refundId: row.refund_id,
    payoutId: row.payout_id,
    balanceTransactionId: row.balance_transaction_id,
    transferGroup: row.transfer_group,
    stripeAccountId: row.stripe_account_id,
    availableOn: row.available_on,
    tenantId: row.tenant_id,
    intakeId: row.intake_id,
    searchId: row.search_id,
    status: row.status,
    reconciled: boolean(row.reconciled),
    reconciledAt: row.reconciled_at,
    stripeEventId: row.stripe_event_id,
    raw
  };
}

/**
 * The ledger, filtered. Used by the operator console and, scoped to one
 * tenant, by the veterinary console's payouts view.
 */
export async function listLedger(env, { tenantId, intakeId, from, to, kind, reconciled, limit = 200 } = {}) {
  if (!hasDatabase(env)) return { entries: [], totals: emptyTotals() };
  const clauses = [];
  const values = [];
  if (tenantId) { clauses.push("tenant_id = ?"); values.push(tenantId); }
  if (intakeId) { clauses.push("intake_id = ?"); values.push(intakeId); }
  if (from) { clauses.push("occurred_at >= ?"); values.push(from); }
  if (to) { clauses.push("occurred_at <= ?"); values.push(to); }
  if (kind) { clauses.push("kind = ?"); values.push(kind); }
  if (reconciled === true) clauses.push("reconciled = 1");
  if (reconciled === false) clauses.push("reconciled = 0");
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const bounded = Math.min(1000, Math.max(1, Math.trunc(Number(limit) || 200)));

  const [rows, totals] = await Promise.all([
    env.DB.prepare(`SELECT * FROM payment_ledger ${where} ORDER BY occurred_at DESC, rowid DESC LIMIT ?`).bind(...values, bounded).all(),
    env.DB.prepare(`
      SELECT
        COUNT(*) AS entries,
        COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_cents ELSE 0 END), 0) AS in_cents,
        COALESCE(SUM(CASE WHEN direction = 'out' THEN amount_cents ELSE 0 END), 0) AS out_cents,
        COALESCE(SUM(CASE WHEN kind = 'platform_fee' THEN amount_cents ELSE 0 END), 0) AS platform_fee_cents,
        COALESCE(SUM(CASE WHEN kind = 'clinic_transfer' THEN amount_cents ELSE 0 END), 0) AS transferred_cents,
        COALESCE(SUM(CASE WHEN kind = 'customer_refund' THEN amount_cents ELSE 0 END), 0) AS refunded_cents,
        COALESCE(SUM(CASE WHEN reconciled = 0 AND direction = 'in' THEN amount_cents ELSE 0 END), 0) AS unreconciled_in_cents,
        COALESCE(SUM(CASE WHEN reconciled = 0 AND direction = 'out' THEN amount_cents ELSE 0 END), 0) AS unreconciled_out_cents,
        COALESCE(SUM(CASE WHEN reconciled = 0 THEN 1 ELSE 0 END), 0) AS unreconciled_entries
      FROM payment_ledger ${where}
    `).bind(...values).first()
  ]);

  return {
    entries: rows.results.map(ledgerRowToJson),
    totals: {
      entries: Number(totals?.entries || 0),
      inCents: Number(totals?.in_cents || 0),
      outCents: Number(totals?.out_cents || 0),
      netCents: Number(totals?.in_cents || 0) - Number(totals?.out_cents || 0),
      platformFeeCents: Number(totals?.platform_fee_cents || 0),
      transferredCents: Number(totals?.transferred_cents || 0),
      refundedCents: Number(totals?.refunded_cents || 0),
      unreconciledEntries: Number(totals?.unreconciled_entries || 0),
      unreconciledInCents: Number(totals?.unreconciled_in_cents || 0),
      unreconciledOutCents: Number(totals?.unreconciled_out_cents || 0)
    }
  };
}

function emptyTotals() {
  return {
    entries: 0, inCents: 0, outCents: 0, netCents: 0, platformFeeCents: 0,
    transferredCents: 0, refundedCents: 0, unreconciledEntries: 0,
    unreconciledInCents: 0, unreconciledOutCents: 0
  };
}

/**
 * What a clinic is owed and what it has been paid.
 *
 * "Owed" is settled-but-not-yet-paid-out: intakes whose transfer we have
 * created, less the payouts Stripe has already sent to the clinic's bank. It
 * deliberately does not read the clinic's Stripe balance — that number moves
 * for reasons Tími does not control, and a console showing it would be
 * explaining Stripe's arithmetic rather than ours.
 */
export async function clinicEarnings(env, tenantId, { limit = 50 } = {}) {
  if (!hasDatabase(env) || !tenantId) {
    return { transferredCents: 0, paidOutCents: 0, awaitingPayoutCents: 0, currency: "usd", transfers: [], payouts: [] };
  }
  const [totals, transfers, payouts] = await Promise.all([
    env.DB.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN kind = 'clinic_transfer' THEN amount_cents ELSE 0 END), 0) AS transferred,
        COALESCE(SUM(CASE WHEN kind = 'transfer_reversed' THEN amount_cents ELSE 0 END), 0) AS reversed,
        COALESCE(SUM(CASE WHEN kind = 'clinic_payout' AND status = 'paid' THEN amount_cents ELSE 0 END), 0) AS paid_out
      FROM payment_ledger WHERE tenant_id = ?
    `).bind(tenantId).first(),
    env.DB.prepare(`
      SELECT * FROM payment_ledger
      WHERE tenant_id = ? AND kind IN ('clinic_transfer', 'transfer_reversed')
      ORDER BY occurred_at DESC LIMIT ?
    `).bind(tenantId, Math.min(200, Math.max(1, limit))).all(),
    env.DB.prepare(`
      SELECT * FROM payment_ledger
      WHERE tenant_id = ? AND kind = 'clinic_payout'
      ORDER BY occurred_at DESC LIMIT ?
    `).bind(tenantId, Math.min(200, Math.max(1, limit))).all()
  ]);
  const transferredCents = Number(totals?.transferred || 0) - Number(totals?.reversed || 0);
  const paidOutCents = Number(totals?.paid_out || 0);
  return {
    transferredCents,
    paidOutCents,
    awaitingPayoutCents: Math.max(0, transferredCents - paidOutCents),
    currency: "usd",
    transfers: transfers.results.map(ledgerRowToJson),
    payouts: payouts.results.map(ledgerRowToJson)
  };
}

/** Mark ledger rows as matched against a Stripe payout report. */
export async function markReconciled(env, ids, { by } = {}) {
  if (!hasDatabase(env) || !Array.isArray(ids) || !ids.length) return 0;
  const bounded = ids.slice(0, 500);
  const placeholders = bounded.map(() => "?").join(", ");
  const result = await env.DB.prepare(`
    UPDATE payment_ledger SET reconciled = 1, reconciled_at = ?, reconciled_by = ?
    WHERE id IN (${placeholders}) AND reconciled = 0
  `).bind(nowIso(), by || null, ...bounded).run();
  return Number(result.meta?.changes || 0);
}
