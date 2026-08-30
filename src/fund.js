/**
 * The Paw It Forward fund.
 *
 * Contributions arrive, are held, are promised, and — only sometimes — are
 * spent. This file is the state machine for that, and everything it does is
 * a row in `fund_reservations`/`sponsorships` plus a balanced journal
 * transaction in `src/ledger.js`. There is no `fund_balance` column anywhere
 * in it, deliberately: see the header of src/ledger.js.
 *
 * ───────────────────────────────────────────────── the four transitions ──
 *
 *   contribution posted   Dr processor_cash        Cr fund_available
 *   sponsorship reserved  Dr fund_available        Cr fund_reserved
 *   sponsorship released  Dr fund_reserved         Cr fund_available
 *   sponsorship consumed  Dr fund_reserved         Cr sponsored_access_revenue
 *
 * Read that list twice, because the whole program is in the shape of it.
 * Approving assistance appears nowhere — approval moves no money at all
 * (acceptance test 8). Reserving moves money between two liability accounts
 * and earns nothing; the contributors still own every cent of it. Only the
 * last line credits revenue, and it only ever runs after a completed
 * connection has been verified. A booking that is cancelled, expires, finds
 * no clinic, or ends in a no-show returns the whole reservation and
 * recognizes nothing.
 *
 * ────────────────────────────────────────────────────────── the amounts ──
 *
 * Nothing here knows that the fund's share is $35. It asks
 * `sponsorshipQuote(env, tenantId)`, which reads the active pricing policy
 * and that clinic's actual rate. A founding clinic pays Tími $0 normally, so
 * a sponsored booking there waives $20 of real value, not $45 — the fund is
 * asked for $10 and Tími matches $10. Hardcoding $35 would have the fund pay
 * $25 of clinic fee that nobody was ever going to be charged, purely to make
 * a donor statistic larger. That is not a rounding difference; it is
 * spending restricted money on a number.
 *
 * ────────────────────────────────────────────────────── the $10 match ──
 *
 * Tími's match is a *reporting* measure. It must not debit the restricted
 * fund (that would be contributors paying Tími's share) and must not
 * fabricate cash or revenue (nothing was received, nothing was earned). What
 * actually happens is that Tími forgoes $10 of fees it would otherwise have
 * billed, so the honest pair is a memo entry that nets to zero:
 *
 *   Dr timinow_program_match      $10   (EXPENSE — the program costs Tími this)
 *   Cr timinow_match_contributed  $10   (EQUITY — Tími put it in; no cash moved)
 *
 * It touches no fund_* account, no cash account, and no revenue account, and
 * it is posted as its own transaction so that a report can show or hide it
 * without disturbing the $35. Final GL mapping is accountant-controlled;
 * what this file guarantees is that the two sides exist and balance.
 *
 * ────────────────────────────────────────────────────────── idempotency ──
 *
 * Every posting key is derived from the business event
 * (`sponsorship_consumed:res_abc`), never from the request. A Stripe
 * completion event redelivered an hour later recomputes the same key, the
 * INSERT is ignored, and revenue is recognized exactly once (acceptance
 * test 13).
 */

import { hasDatabase } from "./db.js";
import {
  accountBalance,
  fundSummary,
  ledgerIntegrity,
  postTransaction,
  recordAudit
} from "./ledger.js";
import {
  activePricingPolicy,
  sponsorshipQuote,
  validateContributionAmount
} from "./pricing.js";

/* ------------------------------------------------------------ helpers --- */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const SECURITY_HEADERS = {
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), payment=(self), geolocation=(self)"
};

// src/index.js keeps `json` and `apiError` private to itself. These are the
// same two functions with the same headers; if index.js ever exports them,
// delete these and import instead.
function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { ...JSON_HEADERS, ...SECURITY_HEADERS, ...(init.headers || {}) }
  });
}

function apiError(status, code, message, details) {
  return json({ error: { code, message, ...(details ? { details } : {}) } }, { status });
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function nowIso() {
  return new Date().toISOString();
}

function cleanString(value, maxLength = 240) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

/** Cheap sanity, not validation: Stripe and the receipt are the real check. */
function cleanEmail(value) {
  const email = cleanString(value, 254).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : "";
}

const RECOGNITION_CHOICES = new Set(["ANONYMOUS", "FIRST_NAME_LAST_INITIAL", "ORGANIZATION"]);

function isoOffsetDays(days, from = Date.now()) {
  return new Date(from - days * 86_400_000).toISOString();
}

function isoOffsetHours(hours, from = Date.now()) {
  return new Date(from - hours * 3_600_000).toISOString();
}

function startOfUtcDayIso(from = Date.now()) {
  const date = new Date(from);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).toISOString();
}

function startOfUtcMonthIso(from = Date.now()) {
  const date = new Date(from);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString();
}

const DATABASE_REQUIRED = {
  ok: false,
  code: "DATABASE_REQUIRED",
  message: "The Paw It Forward fund requires D1; it has no demo-mode arithmetic on purpose."
};

/**
 * The program's dials.
 *
 * Falls back to the migration's seeded values rather than to zeroes: a
 * missing controls row must not read as "no daily cap".
 */
export async function fundControls(env) {
  const defaults = {
    minLiquidityReserveCents: 0,
    maxDailyReservedCents: 100000,
    maxMonthlyReservedCents: 2000000,
    reservationTtlMinutes: 60,
    assistancePaused: false,
    perHouseholdVisitsPerYear: 1,
    publicMetricsDelayHours: 24,
    publicMetricsMinConnections: 5,
    enhancedReviewThresholdCents: 500000
  };
  if (!hasDatabase(env)) return defaults;
  const row = await env.DB.prepare("SELECT * FROM fund_controls WHERE id = 1 LIMIT 1").first();
  if (!row) return defaults;
  return {
    minLiquidityReserveCents: Number(row.min_liquidity_reserve_cents),
    maxDailyReservedCents: Number(row.max_daily_reserved_cents),
    maxMonthlyReservedCents: Number(row.max_monthly_reserved_cents),
    reservationTtlMinutes: Number(row.reservation_ttl_minutes),
    assistancePaused: Boolean(Number(row.assistance_paused)),
    perHouseholdVisitsPerYear: Number(row.per_household_visits_per_year),
    publicMetricsDelayHours: Number(row.public_metrics_delay_hours),
    publicMetricsMinConnections: Number(row.public_metrics_min_connections),
    enhancedReviewThresholdCents: Number(row.enhanced_review_threshold_cents)
  };
}

function contributionFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    contributorUserId: row.contributor_user_id || null,
    contributorToken: row.contributor_token,
    amountCents: Number(row.amount_cents),
    currency: row.currency,
    source: row.source,
    paymentOrderId: row.payment_order_id || null,
    paymentAllocationId: row.payment_allocation_id || null,
    stripePaymentIntentId: row.stripe_payment_intent_id || null,
    status: row.status,
    refundedCents: Number(row.refunded_cents || 0),
    recognition: row.recognition,
    recognitionName: row.recognition_name || null,
    receiptEmail: row.receipt_email || null,
    termsVersion: row.terms_version || null,
    createdAt: row.created_at,
    postedAt: row.posted_at || null
  };
}

function reservationFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    intakeId: row.intake_id,
    searchId: row.search_id || null,
    eligibilityDecisionId: row.eligibility_decision_id || null,
    applicantUserId: row.applicant_user_id || null,
    amountCents: Number(row.amount_cents),
    matchCents: Number(row.match_cents || 0),
    applicableValueCents: Number(row.applicable_value_cents || 0),
    currency: row.currency,
    pricingPolicyId: row.pricing_policy_id || null,
    tenantId: row.tenant_id || null,
    state: row.state,
    expiresAt: row.expires_at || null,
    reservedAt: row.reserved_at,
    resolvedAt: row.resolved_at || null,
    resolutionReason: row.resolution_reason || null
  };
}

export async function getContribution(env, contributionId) {
  if (!hasDatabase(env)) return null;
  const row = await env.DB.prepare("SELECT * FROM contributions WHERE id = ? LIMIT 1").bind(contributionId).first();
  return contributionFromRow(row);
}

export async function getReservation(env, reservationId) {
  if (!hasDatabase(env)) return null;
  const row = await env.DB.prepare("SELECT * FROM fund_reservations WHERE id = ? LIMIT 1").bind(reservationId).first();
  return reservationFromRow(row);
}

/** Whether the reservation's own journal entry actually landed. */
async function reservationIsPosted(env, reservationId) {
  const row = await env.DB.prepare(`
    SELECT 1 AS found FROM ledger_transactions
    WHERE reservation_id = ? AND kind = 'sponsorship_reserved' LIMIT 1
  `).bind(reservationId).first();
  return Boolean(row);
}

/* ------------------------------------------------------ contributions --- */

/**
 * Record somebody's intention to give, before any money has moved.
 *
 * Writes three rows: the contribution, a payment order (or an allocation on
 * the booking's existing order), and the immutable allocation that says what
 * this slice of the charge is *for*. All in DRAFT — nothing is posted to the
 * ledger until Stripe confirms, which is `postContribution` below.
 *
 * The allocation is written now, before confirmation, precisely so that the
 * split is never inferred from a total afterwards: a $22 charge is $20 of
 * platform consideration and $2 of restricted fund money because two rows
 * say so, not because someone subtracted.
 */
export async function recordContribution(env, {
  amountCents,
  source = "STANDALONE",
  contributorUserId = null,
  contributorToken = null,
  recognition = "ANONYMOUS",
  recognitionName = null,
  receiptEmail = null,
  termsVersion = null,
  paymentOrderId = null,
  intakeId = null,
  searchId = null,
  tenantId = null,
  stripePaymentIntentId = null,
  stripeCheckoutSessionId = null
} = {}) {
  if (!hasDatabase(env)) return DATABASE_REQUIRED;

  if (source !== "BOOKING" && source !== "STANDALONE") {
    return { ok: false, code: "INVALID_SOURCE", message: "A contribution is either BOOKING or STANDALONE." };
  }

  const policy = await activePricingPolicy(env);
  const amount = validateContributionAmount(amountCents, { standalone: source === "STANDALONE", policy });
  if (!amount.ok) return amount;

  const choice = cleanString(recognition, 40).toUpperCase() || "ANONYMOUS";
  if (!RECOGNITION_CHOICES.has(choice)) {
    return { ok: false, code: "INVALID_RECOGNITION", message: "Choose anonymous, first name and last initial, or an organization name." };
  }
  const name = cleanString(recognitionName, 120) || null;
  if (choice !== "ANONYMOUS" && !name) {
    return { ok: false, code: "RECOGNITION_NAME_REQUIRED", message: "Tell us the name to show, or choose anonymous." };
  }

  // §5.4: the email is for the receipt and for payment support. It is not
  // what "anonymous" refers to — that is a display choice only, and the
  // portal copy says as much.
  const email = cleanEmail(receiptEmail);
  if (!email) {
    return { ok: false, code: "RECEIPT_EMAIL_REQUIRED", message: "We need an email address to send your receipt." };
  }

  const contributionId = newId("contrib");
  const token = cleanString(contributorToken, 80) || newId("ctr");
  const allocationId = newId("alloc");
  const createdAt = nowIso();
  const currency = policy.currency || "usd";

  const statements = [];
  let orderId = cleanString(paymentOrderId, 80) || null;

  if (orderId) {
    const order = await env.DB.prepare("SELECT id, currency FROM payment_orders WHERE id = ? LIMIT 1").bind(orderId).first();
    if (!order) {
      return { ok: false, code: "PAYMENT_ORDER_NOT_FOUND", message: "That payment order does not exist." };
    }
  } else {
    orderId = newId("porder");
    statements.push(env.DB.prepare(`
      INSERT INTO payment_orders (
        id, purpose, payer_user_id, payer_contributor_id, intake_id, search_id, tenant_id,
        total_cents, currency, status, stripe_payment_intent_id, stripe_checkout_session_id,
        confirmation_snapshot_json, pricing_policy_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?)
    `).bind(
      orderId,
      source === "STANDALONE" ? "FUND_CONTRIBUTION_ONLY" : "BOOKING",
      contributorUserId || null,
      token,
      intakeId || null,
      searchId || null,
      tenantId || null,
      amount.amountCents,
      currency,
      stripePaymentIntentId || null,
      stripeCheckoutSessionId || null,
      JSON.stringify({
        purpose: "FUND_CONTRIBUTION",
        amountCents: amount.amountCents,
        currency,
        // The disclosure the payer was shown, frozen with the amount. §3.
        disclosure: "This contribution is not represented by TímiNOW as tax deductible.",
        termsVersion: cleanString(termsVersion, 40) || null,
        shownAt: createdAt
      }),
      policy.id,
      createdAt,
      createdAt
    ));
  }

  statements.push(env.DB.prepare(`
    INSERT INTO contributions (
      id, contributor_user_id, contributor_token, amount_cents, currency, source,
      payment_order_id, payment_allocation_id, stripe_payment_intent_id, stripe_checkout_session_id,
      status, recognition, recognition_name, receipt_email, terms_version,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?)
  `).bind(
    contributionId, contributorUserId || null, token, amount.amountCents, currency, source,
    orderId, allocationId, stripePaymentIntentId || null, stripeCheckoutSessionId || null,
    choice, name, email, cleanString(termsVersion, 40) || null,
    createdAt, createdAt
  ));

  statements.push(env.DB.prepare(`
    INSERT INTO payment_allocations (
      id, payment_order_id, purpose, amount_cents, currency, contribution_id, created_at
    ) VALUES (?, ?, 'FUND_CONTRIBUTION', ?, ?, ?, ?)
  `).bind(allocationId, orderId, amount.amountCents, currency, contributionId, createdAt));

  await env.DB.batch(statements);

  return {
    ok: true,
    contributionId,
    paymentOrderId: orderId,
    paymentAllocationId: allocationId,
    contributorToken: token,
    amountCents: amount.amountCents,
    currency,
    status: "DRAFT",
    // §3: the exact words counsel signed off on, returned with the draft so
    // the checkout screen cannot paraphrase them into a charitable claim.
    disclosure: "This contribution is not represented by TímiNOW as tax deductible."
  };
}

/**
 * The money arrived. Put it in the fund.
 *
 *   Dr processor_cash    Cr fund_available
 *
 * The processor fee is a *second, separate* transaction (§7.2):
 *
 *   Dr processor_fee_expense    Cr processor_cash
 *
 * Tími bears it. Netting it out of the contribution instead would mean a
 * person who chose $2 funded $1.83 and the receipt would be a small lie —
 * and at $2 the fee is most of the money, which is exactly why the public
 * standalone minimum is $10 rather than a technical fix here.
 *
 * Idempotent by construction: both keys are derived from the contribution
 * id, so a redelivered `payment_intent.succeeded` posts nothing the second
 * time (acceptance test 6).
 */
export async function postContribution(env, { contributionId, stripeEventId = null, processorFeeCents = 0, occurredAt = null } = {}) {
  if (!hasDatabase(env)) return DATABASE_REQUIRED;

  const contribution = await getContribution(env, contributionId);
  if (!contribution) {
    return { ok: false, code: "CONTRIBUTION_NOT_FOUND", message: "That contribution does not exist." };
  }
  if (["FAILED"].includes(contribution.status)) {
    return { ok: false, code: "CONTRIBUTION_FAILED", message: "A failed contribution cannot be posted." };
  }

  const postedAt = occurredAt || nowIso();

  const posting = await postTransaction(env, {
    kind: "contribution_posted",
    idempotencyKey: `contribution_posted:${contribution.id}`,
    occurredAt: postedAt,
    currency: contribution.currency,
    contributionId: contribution.id,
    paymentOrderId: contribution.paymentOrderId,
    stripeEventId,
    memo: `Paw It Forward contribution (${contribution.source.toLowerCase()})`,
    lines: [
      { account: "processor_cash", debit: contribution.amountCents },
      { account: "fund_available", credit: contribution.amountCents }
    ]
  });
  if (!posting.ok) return posting;

  // Separate transaction, separate idempotency key. A fee that arrives later
  // (Stripe reports it on the balance transaction, not the intent) posts on
  // its own without touching what the contributor gave.
  const fee = Math.max(0, Math.trunc(Number(processorFeeCents) || 0));
  let feeTransactionId = null;
  if (fee > 0) {
    const feePosting = await postTransaction(env, {
      kind: "processor_fee",
      idempotencyKey: `processor_fee:contribution:${contribution.id}`,
      occurredAt: postedAt,
      currency: contribution.currency,
      contributionId: contribution.id,
      paymentOrderId: contribution.paymentOrderId,
      stripeEventId,
      memo: "Processor fee borne by Tími, never netted from a contribution.",
      lines: [
        { account: "processor_fee_expense", debit: fee },
        { account: "processor_cash", credit: fee }
      ]
    });
    feeTransactionId = feePosting.transactionId;
  }

  // Compare-and-swap on the status so a redelivery cannot rewrite posted_at.
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE contributions
      SET status = 'POSTED', posted_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('DRAFT', 'REQUIRES_PAYMENT', 'SUCCEEDED')
    `).bind(postedAt, postedAt, contribution.id),
    env.DB.prepare(`
      UPDATE payment_orders SET status = 'PAID', updated_at = ?
      WHERE id = ? AND status IN ('DRAFT', 'REQUIRES_CONFIRMATION', 'AUTHORIZED')
    `).bind(postedAt, contribution.paymentOrderId)
  ]);

  return {
    ok: true,
    duplicate: Boolean(posting.duplicate),
    contributionId: contribution.id,
    transactionId: posting.transactionId,
    feeTransactionId,
    amountCents: contribution.amountCents,
    status: "POSTED"
  };
}

/** A contributor's own giving history. Never anyone else's, never a recipient's. */
export async function contributorHistory(env, userId) {
  if (!hasDatabase(env)) return { contributions: [], totalContributedCents: 0, totalRefundedCents: 0 };
  const id = cleanString(userId, 120);
  if (!id) return { contributions: [], totalContributedCents: 0, totalRefundedCents: 0 };

  const result = await env.DB.prepare(`
    SELECT * FROM contributions
    WHERE contributor_user_id = ?
    ORDER BY datetime(created_at) DESC
    LIMIT 200
  `).bind(id).all();

  const contributions = result.results.map(contributionFromRow);
  // Only money that actually landed counts toward the total. A draft that
  // never got paid is not something a person gave.
  const settled = contributions.filter((row) => ["POSTED", "PARTIALLY_REFUNDED", "REFUNDED", "DISPUTED"].includes(row.status));
  return {
    contributions,
    totalContributedCents: settled.reduce((sum, row) => sum + row.amountCents, 0),
    totalRefundedCents: settled.reduce((sum, row) => sum + row.refundedCents, 0),
    // §5.5: a contributor has no balance to direct and no recipient to see.
    // Saying so here keeps a future UI from inventing one.
    note: "Contributions support eligible TímiNOW access generally. They are not a balance you hold and do not choose a recipient."
  };
}

/* ------------------------------------------------------- availability --- */

async function reservedSince(env, sinceIso) {
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM fund_reservations WHERE reserved_at >= ?"
  ).bind(sinceIso).first();
  return Number(row?.total || 0);
}

/**
 * Can the fund pay for a sponsored connection at this clinic right now?
 *
 * §6.1 is the reason this exists as its own function: it is checked *before*
 * inviting somebody into a hardship application, so that a person in a bad
 * week is not asked to upload a termination letter only to be told at the
 * end that the budget ran out. Being eligible and being funded are separate
 * questions and this one is the budget's.
 *
 * `availableCents` is the fund's posted balance less the liquidity reserve —
 * what could actually be committed — not the raw liability balance.
 */
export async function checkFundAvailability(env, tenantId = null) {
  if (!hasDatabase(env)) {
    return { canFund: false, requiredCents: 0, availableCents: 0, reason: "DATABASE_REQUIRED" };
  }

  const [quote, controls, summary] = await Promise.all([
    sponsorshipQuote(env, tenantId),
    fundControls(env),
    fundSummary(env)
  ]);

  const requiredCents = quote.fundContributionCents;
  const availableCents = Math.max(0, summary.availableCents - controls.minLiquidityReserveCents);

  const base = {
    requiredCents,
    availableCents,
    matchCents: quote.timiMatchCents,
    applicableValueCents: quote.applicableValueCents,
    pricingPolicyId: quote.pricingPolicyId,
    clinicPlan: quote.clinicPlan,
    currency: quote.currency,
    liquidityReserveCents: controls.minLiquidityReserveCents,
    fundAvailableCents: summary.availableCents,
    fundReservedCents: summary.reservedCents
  };

  if (controls.assistancePaused) {
    return { ...base, canFund: false, reason: "ASSISTANCE_PAUSED" };
  }
  if (availableCents < requiredCents) {
    return { ...base, canFund: false, reason: "INSUFFICIENT_FUND_BALANCE" };
  }

  const dayStart = startOfUtcDayIso();
  const monthStart = startOfUtcMonthIso();
  const [today, thisMonth] = await Promise.all([reservedSince(env, dayStart), reservedSince(env, monthStart)]);
  if (today + requiredCents > controls.maxDailyReservedCents) {
    return { ...base, canFund: false, reason: "DAILY_CAP_REACHED" };
  }
  if (thisMonth + requiredCents > controls.maxMonthlyReservedCents) {
    return { ...base, canFund: false, reason: "MONTHLY_CAP_REACHED" };
  }

  return { ...base, canFund: true, reason: null };
}

/* --------------------------------------------------------- reservation --- */

/**
 * Promise the fund's share to one booking, atomically.
 *
 * The whole difficulty of this function is acceptance test 10: two people
 * confirming assisted bookings in the same instant must not both reserve
 * against $35 the fund holds once. Reading a balance, deciding, and then
 * writing cannot give that — both readers see the same balance.
 *
 * So the decision *is* the write. One `INSERT ... SELECT ... WHERE` carries
 * every condition (not paused, no live reservation for this booking, enough
 * posted balance above the liquidity floor, under the daily and monthly
 * caps, within the household frequency) in its own WHERE clause, and SQLite
 * runs it as a single statement. A losing racer inserts zero rows and is
 * refused; it does not overspend and it does not need a lock.
 *
 * The balance term subtracts reservations that exist but whose journal entry
 * has not landed yet, which closes the remaining gap: between this INSERT
 * and the `postTransaction` below, the row is already counted against the
 * fund, so a concurrent caller cannot spend the same money in the window.
 *
 * Refuses rather than overspends. Always.
 */
export async function reserveSponsorship(env, {
  intakeId,
  searchId = null,
  eligibilityDecisionId = null,
  tenantId = null,
  applicantUserId = null,
  ttlMinutes = null
} = {}) {
  if (!hasDatabase(env)) return DATABASE_REQUIRED;
  const intake = cleanString(intakeId, 120);
  if (!intake) return { ok: false, code: "INTAKE_REQUIRED", message: "A reservation needs a booking." };

  const [quote, controls] = await Promise.all([sponsorshipQuote(env, tenantId), fundControls(env)]);
  const amountCents = quote.fundContributionCents;
  const matchCents = quote.timiMatchCents;
  const applicableValueCents = quote.applicableValueCents;

  const reservationId = newId("fres");
  const reservedAt = nowIso();
  const ttl = Number(ttlMinutes) > 0 ? Number(ttlMinutes) : controls.reservationTtlMinutes;
  const expiresAt = new Date(Date.parse(reservedAt) + ttl * 60_000).toISOString();
  const dayStart = startOfUtcDayIso();
  const monthStart = startOfUtcMonthIso();
  const yearStart = isoOffsetDays(365);
  const applicant = cleanString(applicantUserId, 120) || null;

  const insert = await env.DB.prepare(`
    INSERT INTO fund_reservations (
      id, intake_id, search_id, eligibility_decision_id, applicant_user_id,
      amount_cents, match_cents, applicable_value_cents, currency,
      pricing_policy_id, tenant_id, state, expires_at, reserved_at, created_at, updated_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RESERVED', ?, ?, ?, ?
    WHERE (SELECT assistance_paused FROM fund_controls WHERE id = 1) = 0
      AND NOT EXISTS (SELECT 1 FROM fund_reservations WHERE intake_id = ? AND state = 'RESERVED')
      AND ? <= (
        (SELECT COALESCE(SUM(credit_cents), 0) - COALESCE(SUM(debit_cents), 0)
           FROM ledger_entries WHERE account_code = 'fund_available')
        - (SELECT COALESCE(SUM(r.amount_cents), 0) FROM fund_reservations r
            WHERE r.state = 'RESERVED'
              AND NOT EXISTS (SELECT 1 FROM ledger_transactions t
                               WHERE t.reservation_id = r.id AND t.kind = 'sponsorship_reserved'))
        - (SELECT min_liquidity_reserve_cents FROM fund_controls WHERE id = 1)
      )
      AND ? + (SELECT COALESCE(SUM(amount_cents), 0) FROM fund_reservations WHERE reserved_at >= ?)
          <= (SELECT max_daily_reserved_cents FROM fund_controls WHERE id = 1)
      AND ? + (SELECT COALESCE(SUM(amount_cents), 0) FROM fund_reservations WHERE reserved_at >= ?)
          <= (SELECT max_monthly_reserved_cents FROM fund_controls WHERE id = 1)
      AND (? IS NULL OR (
        (SELECT COUNT(*) FROM fund_reservations
          WHERE applicant_user_id = ? AND reserved_at >= ?
            AND state IN ('RESERVED', 'COMPLETED_CONSUMED'))
        < (SELECT per_household_visits_per_year FROM fund_controls WHERE id = 1)
      ))
  `).bind(
    reservationId, intake, searchId || null, eligibilityDecisionId || null, applicant,
    amountCents, matchCents, applicableValueCents, quote.currency,
    quote.pricingPolicyId, tenantId || null, expiresAt, reservedAt, reservedAt, reservedAt,
    intake,
    amountCents,
    amountCents, dayStart,
    amountCents, monthStart,
    applicant, applicant, yearStart
  ).run();

  if (Number(insert?.meta?.changes || 0) === 0) {
    // Say which wall was hit, without re-deciding: the availability check
    // reads the same controls and the same ledger.
    const existing = await env.DB.prepare(
      "SELECT * FROM fund_reservations WHERE intake_id = ? AND state = 'RESERVED' LIMIT 1"
    ).bind(intake).first();
    if (existing) {
      return { ok: true, duplicate: true, reservation: reservationFromRow(existing), reason: "ALREADY_RESERVED" };
    }
    const availability = await checkFundAvailability(env, tenantId);
    return {
      ok: false,
      code: availability.reason || "HOUSEHOLD_LIMIT_REACHED",
      message: availability.reason === "ASSISTANCE_PAUSED"
        ? "Paw It Forward assistance is temporarily unavailable."
        : "Paw It Forward could not reserve funding for this booking.",
      availability
    };
  }

  // The reservation exists and is already counted against the fund by the
  // guard above; now make it visible in the journal. An amount of zero can
  // only happen if a clinic and the owner both owe nothing, in which case
  // there is no money to move and posting would be a zero-value entry.
  let transactionId = null;
  if (amountCents > 0) {
    const posting = await postTransaction(env, {
      kind: "sponsorship_reserved",
      idempotencyKey: `sponsorship_reserved:${reservationId}`,
      occurredAt: reservedAt,
      currency: quote.currency,
      reservationId,
      intakeId: intake,
      tenantId: tenantId || null,
      memo: "Reserved against an approved sponsored booking. Not revenue.",
      lines: [
        { account: "fund_available", debit: amountCents },
        { account: "fund_reserved", credit: amountCents }
      ]
    });
    transactionId = posting.transactionId;
  }

  await recordAudit(env, {
    actorId: applicant,
    actorRole: "system",
    action: "fund.sponsorship_reserved",
    subjectType: "fund_reservation",
    subjectId: reservationId,
    newState: { state: "RESERVED", amountCents, matchCents, intakeId: intake },
    reason: "Assisted booking confirmed."
  });

  return {
    ok: true,
    duplicate: false,
    reservationId,
    transactionId,
    amountCents,
    matchCents,
    applicableValueCents,
    expiresAt,
    currency: quote.currency,
    pricingPolicyId: quote.pricingPolicyId,
    clinicPlan: quote.clinicPlan
  };
}

/**
 * Give the money back to the fund.
 *
 * Cancellation, expiry, no clinic match, no-show — §8.5 treats all of them
 * the same way, because none of them is a completed connection and the only
 * thing that may recognize revenue is a completed connection.
 *
 * Idempotent: the state change is a compare-and-swap on `state = 'RESERVED'`,
 * so a second release is a no-op rather than a second credit to the fund.
 */
export async function releaseSponsorship(env, { reservationId, reason = "CANCELLED", actorId = null } = {}) {
  if (!hasDatabase(env)) return DATABASE_REQUIRED;

  const reservation = await getReservation(env, reservationId);
  if (!reservation) {
    return { ok: false, code: "RESERVATION_NOT_FOUND", message: "That reservation does not exist." };
  }
  const expired = String(reason).toUpperCase().includes("EXPIR");
  const nextState = expired ? "RELEASED_EXPIRED" : "RELEASED_CANCELLED";

  if (reservation.state !== "RESERVED") {
    const released = reservation.state === "RELEASED_CANCELLED" || reservation.state === "RELEASED_EXPIRED";
    return released
      ? { ok: true, duplicate: true, reservationId: reservation.id, state: reservation.state }
      : { ok: false, code: "RESERVATION_NOT_RELEASABLE", message: `A ${reservation.state} reservation cannot be released.` };
  }

  const resolvedAt = nowIso();
  const update = await env.DB.prepare(`
    UPDATE fund_reservations
    SET state = ?, resolved_at = ?, resolution_reason = ?, updated_at = ?
    WHERE id = ? AND state = 'RESERVED'
  `).bind(nextState, resolvedAt, cleanString(reason, 200) || nextState, resolvedAt, reservation.id).run();

  if (Number(update?.meta?.changes || 0) === 0) {
    return { ok: true, duplicate: true, reservationId: reservation.id, state: nextState };
  }

  // Only unwind a journal entry that exists. A reservation whose posting
  // never landed (process died between the two writes) is released by state
  // alone — debiting fund_reserved for it would drive a restricted account
  // negative, which is the one thing the subledger exists to prevent.
  let transactionId = null;
  if (reservation.amountCents > 0 && await reservationIsPosted(env, reservation.id)) {
    const posting = await postTransaction(env, {
      kind: "sponsorship_released",
      idempotencyKey: `sponsorship_released:${reservation.id}`,
      occurredAt: resolvedAt,
      currency: reservation.currency,
      reservationId: reservation.id,
      intakeId: reservation.intakeId,
      tenantId: reservation.tenantId,
      memo: `Reservation released: ${nextState}. No sponsored revenue recognized.`,
      lines: [
        { account: "fund_reserved", debit: reservation.amountCents },
        { account: "fund_available", credit: reservation.amountCents }
      ]
    });
    transactionId = posting.transactionId;
  }

  await recordAudit(env, {
    actorId,
    actorRole: actorId ? "operator" : "system",
    action: "fund.sponsorship_released",
    subjectType: "fund_reservation",
    subjectId: reservation.id,
    oldState: { state: "RESERVED" },
    newState: { state: nextState },
    reason: cleanString(reason, 200) || nextState
  });

  return { ok: true, duplicate: false, reservationId: reservation.id, state: nextState, transactionId, amountCents: reservation.amountCents };
}

/**
 * The connection completed and was verified. Now — and only now — the fund's
 * share becomes revenue.
 *
 *   Dr fund_reserved              Cr sponsored_access_revenue
 *
 * plus the separate, non-cash match memo described in the file header.
 *
 * Two things make a replayed completion safe (acceptance test 13): the
 * `sponsorships.reservation_id` UNIQUE index, and the ledger's idempotency
 * key. Either alone would do; both is deliberate, because this is the one
 * transition that cannot be undone by simply doing it again.
 */
export async function consumeSponsorship(env, { reservationId, stripeEventId = null, occurredAt = null } = {}) {
  if (!hasDatabase(env)) return DATABASE_REQUIRED;

  const reservation = await getReservation(env, reservationId);
  if (!reservation) {
    return { ok: false, code: "RESERVATION_NOT_FOUND", message: "That reservation does not exist." };
  }
  if (reservation.state === "COMPLETED_CONSUMED") {
    return { ok: true, duplicate: true, reservationId: reservation.id, state: "COMPLETED_CONSUMED" };
  }
  if (reservation.state !== "RESERVED") {
    return { ok: false, code: "RESERVATION_NOT_CONSUMABLE", message: `A ${reservation.state} reservation cannot be consumed.` };
  }
  if (!await reservationIsPosted(env, reservation.id) && reservation.amountCents > 0) {
    return { ok: false, code: "RESERVATION_NOT_POSTED", message: "This reservation has no journal entry to consume." };
  }

  const consumedAt = occurredAt || nowIso();
  const sponsorshipId = newId("spon");

  // Compare-and-swap plus a UNIQUE reservation_id: whichever delivery of the
  // completion event arrives first writes the sponsorship and flips the
  // state; the rest change nothing.
  const results = await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO sponsorships (
        id, reservation_id, intake_id, tenant_id, amount_cents, match_cents,
        applicable_value_cents, currency, pricing_policy_id, consumed_at, completion_event_id, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM fund_reservations WHERE id = ? AND state = 'RESERVED')
        AND NOT EXISTS (SELECT 1 FROM sponsorships WHERE reservation_id = ?)
    `).bind(
      sponsorshipId, reservation.id, reservation.intakeId, reservation.tenantId,
      reservation.amountCents, reservation.matchCents, reservation.applicableValueCents,
      reservation.currency, reservation.pricingPolicyId, consumedAt, stripeEventId || null, consumedAt,
      reservation.id, reservation.id
    ),
    env.DB.prepare(`
      UPDATE fund_reservations
      SET state = 'COMPLETED_CONSUMED', resolved_at = ?, resolution_reason = 'COMPLETION_VERIFIED', updated_at = ?
      WHERE id = ? AND state = 'RESERVED'
    `).bind(consumedAt, consumedAt, reservation.id)
  ]);

  if (Number(results[0]?.meta?.changes || 0) === 0) {
    return { ok: true, duplicate: true, reservationId: reservation.id, state: "COMPLETED_CONSUMED" };
  }

  let transactionId = null;
  if (reservation.amountCents > 0) {
    const posting = await postTransaction(env, {
      kind: "sponsorship_consumed",
      idempotencyKey: `sponsorship_consumed:${reservation.id}`,
      occurredAt: consumedAt,
      currency: reservation.currency,
      reservationId: reservation.id,
      intakeId: reservation.intakeId,
      tenantId: reservation.tenantId,
      stripeEventId,
      memo: "Completed sponsored connection: restricted fund money becomes earned revenue.",
      lines: [
        { account: "fund_reserved", debit: reservation.amountCents },
        { account: "sponsored_access_revenue", credit: reservation.amountCents }
      ]
    });
    transactionId = posting.transactionId;
  }

  // Tími's own share. Its own transaction, its own key, and neither side of
  // it is a fund_* account, a cash account, or a revenue account — see the
  // file header for why those three were all wrong.
  let matchTransactionId = null;
  if (reservation.matchCents > 0) {
    const matchPosting = await postTransaction(env, {
      kind: "sponsorship_consumed",
      idempotencyKey: `sponsorship_match:${reservation.id}`,
      occurredAt: consumedAt,
      currency: reservation.currency,
      reservationId: reservation.id,
      intakeId: reservation.intakeId,
      tenantId: reservation.tenantId,
      stripeEventId,
      memo: "Tími program match: non-cash reporting entry. No fund money, no cash, no revenue.",
      lines: [
        { account: "timinow_program_match", debit: reservation.matchCents },
        { account: "timinow_match_contributed", credit: reservation.matchCents }
      ]
    });
    matchTransactionId = matchPosting.transactionId;
  }

  await recordAudit(env, {
    actorRole: "system",
    action: "fund.sponsorship_consumed",
    subjectType: "fund_reservation",
    subjectId: reservation.id,
    oldState: { state: "RESERVED" },
    newState: { state: "COMPLETED_CONSUMED", amountCents: reservation.amountCents, matchCents: reservation.matchCents },
    reason: "Completion verified.",
    requestId: stripeEventId
  });

  return {
    ok: true,
    duplicate: false,
    reservationId: reservation.id,
    sponsorshipId,
    state: "COMPLETED_CONSUMED",
    amountCents: reservation.amountCents,
    matchCents: reservation.matchCents,
    transactionId,
    matchTransactionId
  };
}

/**
 * Undo a completion that should never have been recorded.
 *
 * §8.5's last clause, and controlled on purpose: a reason, an actor, and an
 * audit row are required, and the reversal restores the money to
 * `fund_available` rather than to `fund_reserved` — the reservation is dead
 * and nobody is holding a promise against it any more.
 *
 * Note what this does *not* do: it never bills the owner. §2.5 and
 * acceptance test 31 — a person told their fee was covered is not charged it
 * later because Tími made a bookkeeping error.
 */
export async function reverseSponsorship(env, { reservationId, reason, actorId } = {}) {
  if (!hasDatabase(env)) return DATABASE_REQUIRED;
  const why = cleanString(reason, 300);
  if (!why) return { ok: false, code: "REVERSAL_REASON_REQUIRED", message: "A reversal needs a written reason." };
  const actor = cleanString(actorId, 120);
  if (!actor) return { ok: false, code: "REVERSAL_ACTOR_REQUIRED", message: "A reversal needs a named actor." };

  const reservation = await getReservation(env, reservationId);
  if (!reservation) return { ok: false, code: "RESERVATION_NOT_FOUND", message: "That reservation does not exist." };
  if (reservation.state === "REVERSED_ERROR") {
    return { ok: true, duplicate: true, reservationId: reservation.id, state: "REVERSED_ERROR" };
  }
  if (reservation.state !== "COMPLETED_CONSUMED") {
    return { ok: false, code: "RESERVATION_NOT_REVERSIBLE", message: "Only a consumed sponsorship can be reversed." };
  }

  const reversedAt = nowIso();
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE fund_reservations
      SET state = 'REVERSED_ERROR', resolved_at = ?, resolution_reason = ?, updated_at = ?
      WHERE id = ? AND state = 'COMPLETED_CONSUMED'
    `).bind(reversedAt, why, reversedAt, reservation.id),
    env.DB.prepare(`
      UPDATE sponsorships SET reversed_at = ?, reversal_reason = ?, reversed_by = ?
      WHERE reservation_id = ? AND reversed_at IS NULL
    `).bind(reversedAt, why, actor, reservation.id)
  ]);

  if (Number(results[0]?.meta?.changes || 0) === 0) {
    return { ok: true, duplicate: true, reservationId: reservation.id, state: "REVERSED_ERROR" };
  }

  let transactionId = null;
  if (reservation.amountCents > 0) {
    const posting = await postTransaction(env, {
      kind: "sponsorship_reversed",
      idempotencyKey: `sponsorship_reversed:${reservation.id}`,
      occurredAt: reversedAt,
      currency: reservation.currency,
      reservationId: reservation.id,
      intakeId: reservation.intakeId,
      tenantId: reservation.tenantId,
      memo: `Controlled reversal: ${why}`,
      createdBy: actor,
      lines: [
        { account: "sponsored_access_revenue", debit: reservation.amountCents },
        { account: "fund_available", credit: reservation.amountCents }
      ]
    });
    transactionId = posting.transactionId;
  }

  let matchTransactionId = null;
  if (reservation.matchCents > 0) {
    const matchPosting = await postTransaction(env, {
      kind: "sponsorship_reversed",
      idempotencyKey: `sponsorship_match_reversed:${reservation.id}`,
      occurredAt: reversedAt,
      currency: reservation.currency,
      reservationId: reservation.id,
      intakeId: reservation.intakeId,
      tenantId: reservation.tenantId,
      memo: "Reverses the Tími program match memo entry.",
      createdBy: actor,
      lines: [
        { account: "timinow_match_contributed", debit: reservation.matchCents },
        { account: "timinow_program_match", credit: reservation.matchCents }
      ]
    });
    matchTransactionId = matchPosting.transactionId;
  }

  await recordAudit(env, {
    actorId: actor,
    actorRole: "operator",
    action: "fund.sponsorship_reversed",
    subjectType: "fund_reservation",
    subjectId: reservation.id,
    oldState: { state: "COMPLETED_CONSUMED" },
    newState: { state: "REVERSED_ERROR" },
    reason: why
  });

  return { ok: true, duplicate: false, reservationId: reservation.id, state: "REVERSED_ERROR", transactionId, matchTransactionId };
}

/**
 * The sweep. Cron-callable.
 *
 * A reservation nobody redeemed is contributions held hostage by an
 * abandoned checkout, so the TTL is not a tidiness feature — it is the
 * difference between the fund's money being available to the next applicant
 * and sitting behind a browser tab somebody closed.
 */
export async function expireStaleReservations(env, { limit = 200, now = null } = {}) {
  if (!hasDatabase(env)) return { ok: false, code: "DATABASE_REQUIRED", released: 0 };
  const cutoff = now || nowIso();
  const result = await env.DB.prepare(`
    SELECT id FROM fund_reservations
    WHERE state = 'RESERVED' AND expires_at IS NOT NULL AND expires_at <= ?
    ORDER BY expires_at
    LIMIT ?
  `).bind(cutoff, limit).all();

  const released = [];
  const failed = [];
  for (const row of result.results) {
    const outcome = await releaseSponsorship(env, { reservationId: row.id, reason: "RESERVATION_EXPIRED" });
    if (outcome.ok) released.push(row.id); else failed.push({ id: row.id, code: outcome.code });
  }
  return { ok: true, released: released.length, reservationIds: released, failed };
}

/* --------------------------------------------------------- public data --- */

/**
 * The numbers the public impact page is allowed to show.
 *
 * Two rules from §5.6, both enforced here rather than in a template:
 *
 *   1. **Only consumed sponsorships count.** Not applications, not
 *      approvals, not reservations, not bookings in progress (acceptance
 *      test 15). A reservation is a promise; counting it as a visit funded
 *      would mean the headline number goes down when a booking is cancelled,
 *      which is the tell that it was never a real number.
 *
 *   2. **Delayed and thresholded.** Metrics lag by
 *      `public_metrics_delay_hours` so refunds, disputes and reversals have
 *      landed, and stay unpublished until there are at least
 *      `public_metrics_min_connections` of them. With three sponsored visits
 *      in one small town, a live counter is not an aggregate — it is close
 *      to naming three households.
 *
 * Reversed sponsorships are excluded: a completion that was unwound did not
 * happen.
 */
export async function fundImpact(env) {
  const controls = await fundControls(env);
  const unpublished = {
    published: false,
    reason: "BELOW_AGGREGATION_THRESHOLD",
    completedConnections: null,
    communityDollarsConsumedCents: null,
    timiMatchTotalCents: null,
    asOf: null,
    minimumConnections: controls.publicMetricsMinConnections,
    delayHours: controls.publicMetricsDelayHours
  };
  if (!hasDatabase(env)) return unpublished;

  const asOf = isoOffsetHours(controls.publicMetricsDelayHours);
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS connections,
           COALESCE(SUM(amount_cents), 0) AS community_cents,
           COALESCE(SUM(match_cents), 0) AS match_cents
    FROM sponsorships
    WHERE reversed_at IS NULL AND consumed_at <= ?
  `).bind(asOf).first();

  const connections = Number(row?.connections || 0);
  if (connections < controls.publicMetricsMinConnections) {
    return { ...unpublished, asOf };
  }
  return {
    published: true,
    reason: null,
    completedConnections: connections,
    communityDollarsConsumedCents: Number(row.community_cents || 0),
    timiMatchTotalCents: Number(row.match_cents || 0),
    asOf,
    minimumConnections: controls.publicMetricsMinConnections,
    delayHours: controls.publicMetricsDelayHours,
    // Never "$35 pays for a pet's treatment". §5.1.
    explanation: "Community contributions cover TímiNOW access fees for pet owners with verified financial hardship. They do not pay veterinary treatment costs."
  };
}

/**
 * The operations view: balances, aging reservations, and whether the journal
 * is still sound. Not public — every number here is exact and undelayed.
 */
export async function fundDashboard(env) {
  if (!hasDatabase(env)) return { ok: false, code: "DATABASE_REQUIRED" };
  const [summary, controls, integrity] = await Promise.all([fundSummary(env), fundControls(env), ledgerIntegrity(env)]);
  const reservations = await env.DB.prepare(`
    SELECT state, COUNT(*) AS count, COALESCE(SUM(amount_cents), 0) AS cents
    FROM fund_reservations GROUP BY state
  `).all();
  const matchContributed = await accountBalance(env, "timinow_match_contributed");
  return {
    ok: true,
    balances: summary,
    controls,
    integrity,
    matchContributedCents: matchContributed,
    reservationsByState: Object.fromEntries(reservations.results.map((row) => [row.state, { count: Number(row.count), cents: Number(row.cents) }]))
  };
}

/* ------------------------------------------------------- HTTP handlers --- */
//
// Pure functions of (request, env, actor). None of them is mounted here —
// src/index.js owns routing, and this module deliberately does not reach
// into it. See the report accompanying this change for the routes.

/**
 * POST /api/fund/contributions — the public Paw It Forward portal.
 *
 * Guests are welcome: an unauthenticated caller gets a pseudonymous
 * contributor token back, which is what a later account link uses. What they
 * do not get is a way to be publicly named without saying so — recognition
 * defaults to ANONYMOUS (§5.4).
 */
export async function createStandaloneContribution(request, env, actor) {
  if (request.method !== "POST") {
    return apiError(405, "METHOD_NOT_ALLOWED", "Use POST to make a contribution.");
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return apiError(400, "INVALID_BODY", "Send a JSON body.");
  }
  if (body.consent !== true) {
    return apiError(422, "TERMS_CONSENT_REQUIRED", "Please agree to the Paw It Forward program terms.");
  }

  const result = await recordContribution(env, {
    amountCents: body.amountCents,
    source: "STANDALONE",
    contributorUserId: actor?.userId || null,
    contributorToken: body.contributorToken || null,
    recognition: body.recognition || "ANONYMOUS",
    recognitionName: body.recognitionName || null,
    receiptEmail: body.receiptEmail || actor?.email || null,
    termsVersion: body.termsVersion || null
  });

  if (!result.ok) {
    const status = result.code === "DATABASE_REQUIRED" ? 503 : 422;
    return apiError(status, result.code, result.message);
  }
  return json({ contribution: result }, { status: 201 });
}

/** GET /api/fund/impact — public, delayed, thresholded. */
export async function getFundImpact(request, env) {
  if (request.method !== "GET") {
    return apiError(405, "METHOD_NOT_ALLOWED", "Use GET to read the impact totals.");
  }
  return json({ impact: await fundImpact(env) });
}

/** GET /api/fund/contributions — the signed-in contributor's own history. */
export async function getContributorHistory(request, env, actor) {
  if (request.method !== "GET") {
    return apiError(405, "METHOD_NOT_ALLOWED", "Use GET to read your contributions.");
  }
  if (!actor?.userId) {
    return apiError(401, "SIGN_IN_REQUIRED", "Sign in to see your contributions.");
  }
  return json(await contributorHistory(env, actor.userId));
}
