/**
 * One charge, several purposes.
 *
 * A booking can carry three different kinds of money at once: Tími's $20
 * owner fee, an optional Paw It Forward contribution, and — where the clinic
 * takes one and Tími is collecting it — an appointment deposit. The customer
 * sees one card charge for $22, or $72, and that is what their statement
 * says.
 *
 * What makes that safe is that the split is written down before the charge
 * exists. `payment_allocations` rows are created first, sum to the order
 * total, and are never recomputed: a $2 contribution is $2 because a row says
 * so, not because somebody subtracted $20 from $22 six months later while
 * handling a partial refund.
 *
 *   ┌ payment_order  $22 ────────────────────────────────┐
 *   │  allocation  OWNER_PLATFORM_FEE   $20              │
 *   │  allocation  FUND_CONTRIBUTION     $2              │
 *   └────────────────────────────────────────────────────┘
 *            one Stripe PaymentIntent, amount 2200
 *
 * Nothing here posts to the ledger. Money is recognized when Stripe says the
 * payment succeeded, because a PaymentIntent that has been created is not
 * money anybody has paid.
 */

import { hasDatabase } from "./db.js";
import { activePricingPolicy, validateContributionAmount } from "./pricing.js";
import { createPaymentIntent, idempotencyKey, stripeConfigured, StripeError } from "./stripe.js";

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

/**
 * Price one booking, before any money moves.
 *
 * `sponsored` is the whole point of the shape here: a sponsored booking does
 * not charge $20 and refund it, and it does not create a $20 PaymentIntent
 * that some later code marks as handled. It charges nothing, and the record
 * says the fee was waived and why.
 */
export async function quoteBooking(env, { sponsored = false, contributionCents = 0, depositCents = 0 } = {}) {
  const pricing = await activePricingPolicy(env);
  const lines = [];

  const ownerFeeStandardCents = pricing.ownerFeeCents;
  const ownerFeeChargedCents = sponsored ? 0 : ownerFeeStandardCents;
  if (ownerFeeChargedCents > 0) {
    lines.push({ purpose: "OWNER_PLATFORM_FEE", amountCents: ownerFeeChargedCents });
  }

  let contribution = Math.trunc(Number(contributionCents) || 0);
  if (contribution > 0) {
    const valid = validateContributionAmount(contribution, { standalone: false, policy: pricing });
    if (!valid.ok) return { ok: false, ...valid };
    lines.push({ purpose: "FUND_CONTRIBUTION", amountCents: contribution });
  } else {
    contribution = 0;
  }

  const deposit = Math.max(0, Math.trunc(Number(depositCents) || 0));
  if (deposit > 0) lines.push({ purpose: "CLINIC_DEPOSIT", amountCents: deposit });

  const totalCents = lines.reduce((sum, line) => sum + line.amountCents, 0);
  return {
    ok: true,
    pricingPolicyId: pricing.id,
    pricingVersion: pricing.version,
    currency: pricing.currency,
    sponsored,
    /** What the owner would have paid, and what they are actually paying. */
    ownerFeeStandardCents,
    ownerFeeChargedCents,
    ownerFeeWaiverReason: sponsored ? "PAW_IT_FORWARD" : null,
    contributionCents: contribution,
    depositCents: deposit,
    totalCents,
    lines
  };
}

/**
 * Write the order and its allocations, then mint one PaymentIntent for the
 * total.
 *
 * The allocations are inserted in the same batch as the order, so an order
 * whose parts do not sum to its total cannot exist even for an instant.
 */
export async function createBookingPaymentOrder(env, {
  quote,
  intakeId = null,
  searchId = null,
  tenantId = null,
  payerUserId = null,
  contributionId = null,
  confirmationSnapshot = {}
}) {
  if (!hasDatabase(env)) return { ok: false, code: "DATABASE_REQUIRED", message: "D1 is required to take a payment." };
  if (!quote?.ok) return { ok: false, code: "QUOTE_REQUIRED", message: "Price the booking before charging it." };

  const orderId = newId("payorder");
  const statements = [
    env.DB.prepare(`
      INSERT INTO payment_orders (
        id, purpose, payer_user_id, intake_id, search_id, tenant_id,
        total_cents, currency, status, confirmation_snapshot_json, pricing_policy_id
      ) VALUES (?, 'BOOKING', ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)
    `).bind(
      orderId, payerUserId, intakeId, searchId, tenantId,
      quote.totalCents, quote.currency,
      JSON.stringify(confirmationSnapshot), quote.pricingPolicyId
    )
  ];
  for (const line of quote.lines) {
    statements.push(env.DB.prepare(`
      INSERT INTO payment_allocations (id, payment_order_id, purpose, amount_cents, currency, contribution_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      newId("payalloc"), orderId, line.purpose, line.amountCents, quote.currency,
      line.purpose === "FUND_CONTRIBUTION" ? contributionId : null
    ));
  }
  await env.DB.batch(statements);
  return { ok: true, paymentOrderId: orderId, totalCents: quote.totalCents };
}

/**
 * The customer's single charge.
 *
 * A sponsored booking with no contribution and no deposit totals zero, and
 * zero is not a charge: creating a $0 PaymentIntent so that something
 * downstream can call it paid is exactly the fake-payment pattern the
 * addendum prohibits. It returns `mode: "no_charge"` and the booking
 * proceeds on the strength of the waiver and the fund reservation.
 */
export async function chargeBookingOrder(env, paymentOrderId) {
  if (!hasDatabase(env)) return { ok: false, code: "DATABASE_REQUIRED", message: "D1 is required to take a payment." };

  const order = await env.DB.prepare("SELECT * FROM payment_orders WHERE id = ? LIMIT 1").bind(paymentOrderId).first();
  if (!order) return { ok: false, code: "PAYMENT_ORDER_NOT_FOUND", message: "That payment order was not found." };

  const allocations = await env.DB.prepare(
    "SELECT purpose, amount_cents FROM payment_allocations WHERE payment_order_id = ?"
  ).bind(paymentOrderId).all();
  const allocated = allocations.results.reduce((sum, row) => sum + Number(row.amount_cents), 0);
  // The invariant that makes every later refund and dispute tractable. If it
  // is ever false, the honest thing is to refuse the charge.
  if (allocated !== Number(order.total_cents)) {
    return {
      ok: false,
      code: "ALLOCATIONS_DO_NOT_SUM",
      message: `Payment order ${paymentOrderId} allocates ${allocated} against a total of ${order.total_cents}.`
    };
  }

  if (Number(order.total_cents) === 0) {
    await env.DB.prepare("UPDATE payment_orders SET status = 'PAID', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'DRAFT'")
      .bind(paymentOrderId).run();
    return { ok: true, mode: "no_charge", totalCents: 0 };
  }

  if (!stripeConfigured(env)) {
    await env.DB.prepare("UPDATE payment_orders SET status = 'REQUIRES_CONFIRMATION', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(paymentOrderId).run();
    return { ok: true, mode: "demo", totalCents: Number(order.total_cents), clientSecret: null };
  }

  const contributionCents = allocations.results
    .filter((row) => row.purpose === "FUND_CONTRIBUTION")
    .reduce((sum, row) => sum + Number(row.amount_cents), 0);

  try {
    const intent = await createPaymentIntent(env, {
      amountCents: Number(order.total_cents),
      currency: order.currency || "usd",
      description: "Tími NOW booking",
      statementDescriptorSuffix: "TIMINOW",
      idempotencyKey: idempotencyKey("booking-order", paymentOrderId, order.total_cents),
      /**
       * Enough to attribute a webhook to a booking, and nothing more. Never
       * hardship evidence, a benefit type, a diagnosis, or a shock
       * description — Stripe metadata is not a private store.
       */
      metadata: {
        clearkey_product: "timinow",
        timi_payment_order_id: paymentOrderId,
        timi_intake_id: order.intake_id || "",
        timi_tenant_id: order.tenant_id || "",
        payment_allocation_version: "1",
        contains_pif_contribution: contributionCents > 0 ? "true" : "false",
        pif_contribution_cents: String(contributionCents)
      }
    });

    await env.DB.prepare(
      "UPDATE payment_orders SET status = 'REQUIRES_CONFIRMATION', stripe_payment_intent_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).bind(intent.id, paymentOrderId).run();

    return {
      ok: true,
      mode: "stripe",
      totalCents: Number(order.total_cents),
      paymentIntentId: intent.id,
      clientSecret: intent.client_secret
    };
  } catch (error) {
    if (error instanceof StripeError) {
      console.warn(JSON.stringify({ event: "booking_charge_failed", paymentOrderId, message: error.message }));
      return { ok: false, code: "PAYMENT_PROVIDER_ERROR", message: "The payment provider could not start this charge. Please try again." };
    }
    throw error;
  }
}

/** An order with its allocations, for receipts and for reconciliation. */
export async function getPaymentOrder(env, paymentOrderId) {
  if (!hasDatabase(env)) return null;
  const order = await env.DB.prepare("SELECT * FROM payment_orders WHERE id = ? LIMIT 1").bind(paymentOrderId).first();
  if (!order) return null;
  const allocations = await env.DB.prepare(
    "SELECT id, purpose, amount_cents, refunded_cents, disputed_cents FROM payment_allocations WHERE payment_order_id = ? ORDER BY purpose"
  ).bind(paymentOrderId).all();
  return {
    id: order.id,
    purpose: order.purpose,
    intakeId: order.intake_id,
    searchId: order.search_id,
    tenantId: order.tenant_id,
    totalCents: Number(order.total_cents),
    currency: order.currency,
    status: order.status,
    stripePaymentIntentId: order.stripe_payment_intent_id,
    pricingPolicyId: order.pricing_policy_id,
    confirmationSnapshot: JSON.parse(order.confirmation_snapshot_json || "{}"),
    allocations: allocations.results.map((row) => ({
      id: row.id,
      purpose: row.purpose,
      amountCents: Number(row.amount_cents),
      refundedCents: Number(row.refunded_cents),
      disputedCents: Number(row.disputed_cents)
    }))
  };
}

/**
 * Refund part of a mixed charge, against a named allocation.
 *
 * By allocation id, never by percentage. Refunding "half of $22" is a
 * question with no correct answer once the $22 was $20 of fee and $2 of
 * somebody else's contribution — and guessing at it later is how a
 * restricted balance goes wrong.
 */
export async function refundAllocation(env, { allocationId, amountCents }) {
  if (!hasDatabase(env)) return { ok: false, code: "DATABASE_REQUIRED", message: "D1 is required to refund." };
  const amount = Math.trunc(Number(amountCents) || 0);
  if (amount <= 0) return { ok: false, code: "REFUND_AMOUNT_REQUIRED", message: "A refund needs an amount." };

  const allocation = await env.DB.prepare("SELECT * FROM payment_allocations WHERE id = ? LIMIT 1").bind(allocationId).first();
  if (!allocation) return { ok: false, code: "ALLOCATION_NOT_FOUND", message: "That payment allocation was not found." };

  const remaining = Number(allocation.amount_cents) - Number(allocation.refunded_cents);
  if (amount > remaining) {
    return { ok: false, code: "REFUND_EXCEEDS_ALLOCATION", message: `Only ${remaining} cents remain refundable on that allocation.` };
  }

  const result = await env.DB.prepare(
    "UPDATE payment_allocations SET refunded_cents = refunded_cents + ? WHERE id = ? AND refunded_cents + ? <= amount_cents"
  ).bind(amount, allocationId, amount).run();
  if (!Number(result?.meta?.changes || 0)) {
    return { ok: false, code: "REFUND_RACE", message: "That allocation changed while the refund was being applied." };
  }
  return { ok: true, allocationId, refundedCents: Number(allocation.refunded_cents) + amount, purpose: allocation.purpose };
}
