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
import { cancelPaymentIntent, createPaymentIntent, idempotencyKey, stripeConfigured, StripeError } from "./stripe.js";
import { activeGrantFor, recordSponsoredCompletion } from "./hardship/index.js";
import { depositOutcomeForBooking, getBookingDepositSnapshot } from "./deposit-policy.js";
import { postContribution } from "./fund.js";

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
    const allocationId = newId("payalloc");
    let lineContributionId = null;
    if (line.purpose === "FUND_CONTRIBUTION") {
      // A gift folded into the booking charge still gets its own
      // `contributions` row, in the same batch as the allocation it explains
      // — that row is what `postContribution` posts to the restricted fund
      // ledger once Stripe confirms, and without it the money would land in
      // `payment_allocations` and never reach `fund_available`. Recognition
      // is ANONYMOUS by construction: the booking flow never asks for a
      // display name, and §5.4 says anonymous is the default, not a fallback.
      lineContributionId = contributionId || newId("contrib");
      if (!contributionId) {
        statements.push(env.DB.prepare(`
          INSERT INTO contributions (
            id, contributor_user_id, contributor_token, amount_cents, currency, source,
            payment_order_id, payment_allocation_id, status, recognition
          ) VALUES (?, ?, ?, ?, ?, 'BOOKING', ?, ?, 'DRAFT', 'ANONYMOUS')
        `).bind(
          lineContributionId, payerUserId, newId("ctr"), line.amountCents, quote.currency,
          orderId, allocationId
        ));
      }
    }
    statements.push(env.DB.prepare(`
      INSERT INTO payment_allocations (id, payment_order_id, purpose, amount_cents, currency, contribution_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      allocationId, orderId, line.purpose, line.amountCents, quote.currency, lineContributionId
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
        // Deliberately not the deposit flow's own `intake_id` key: that key
        // is what src/payments.js's intakeIdFromMetadata reads to mark
        // intake_requests.payment_status "paid" and write a "deposit_*"
        // payment_ledger row, and this can be an owner-fee-only charge with
        // no deposit in it at all — mislabeling that as a deposit event
        // would corrupt reconciliation. This charge is looked up by
        // timi_payment_order_id instead; see markBookingPaymentOrderStatus.
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
    // The gift's own row follows the charge it rides in, so reconciliation
    // can find it from the PaymentIntent alone. Same value on a re-charge of
    // the same order (same idempotency key, same intent), so the one-per-
    // intent UNIQUE index never trips.
    await env.DB.prepare(
      "UPDATE contributions SET stripe_payment_intent_id = ?, status = 'REQUIRES_PAYMENT', updated_at = CURRENT_TIMESTAMP WHERE payment_order_id = ? AND status = 'DRAFT'"
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

/**
 * The customer-facing entry point: get (or start) the one combined charge
 * for an intake — the $15 owner fee, plus the clinic's own arrival deposit
 * when its deposit policy calls for one, as a single card charge.
 *
 * Idempotent across repeated calls (a screen that reappears, a retry after a
 * dropped connection): once a `payment_orders` row exists for this intake
 * and has not failed or been cancelled, this reuses it and re-charges the
 * *same* order id, which carries the same Stripe idempotency key — so a
 * second call never opens a second PaymentIntent.
 *
 * `depositCents` is read from the intake's own `depositAmountCents` —
 * already the deposit-policy engine's answer for this specific booking at
 * `selectCareOffer` time — rather than recomputed here.
 *
 * `contributionCents` is the customer's optional Paw It Forward gift, folded
 * into the same single charge. `null` means "leave it alone" — every poll,
 * including the re-poll after PaymentSheet reports success, passes null and
 * reuses whatever order exists. A number is a decision: if an unpaid order
 * exists with a *different* gift amount, that order (still nothing but a
 * quote — DRAFT or an unconfirmed PaymentIntent) is cancelled and replaced,
 * because a PaymentIntent's amount is fixed at creation and the customer
 * just changed the total.
 */
export async function ensureBookingPaymentOrder(env, { intake, contributionCents = null }) {
  if (!hasDatabase(env)) return { ok: false, code: "DATABASE_REQUIRED", message: "D1 is required to take a payment." };

  // Any paid order settles the question, whichever row it is — with the
  // duplicate rows the pre-guard race left behind (see below), the paid one
  // is not necessarily the one the oldest-wins rule would pick. A gift
  // change requested after payment already landed is ignored for the same
  // reason: the charge exists, and the answer is what actually happened.
  const paid = await env.DB.prepare(
    "SELECT id FROM payment_orders WHERE intake_id = ? AND purpose = 'BOOKING' AND status = 'PAID' ORDER BY created_at ASC, id ASC LIMIT 1"
  ).bind(intake.id).first();
  if (paid) {
    return { ok: true, mode: "paid", totalCents: null, order: await getPaymentOrder(env, paid.id) };
  }

  const requestedContribution = contributionCents == null ? null : Math.max(0, Math.trunc(Number(contributionCents) || 0));

  // A grant waives the $15 owner fee. The clinic's own deposit is the
  // clinic's money — Tími never waives it on its own; only the clinic's
  // recorded election can (WAIVE_FOR_PAW_IT_FORWARD / the guarantee),
  // which is exactly what depositOutcomeForBooking answers below. Looked up
  // before the reuse decision, not just at creation: an approval that lands
  // *after* the order was quoted (the "I need help paying" flow runs from
  // the payment screen itself) has to reach an order that still charges the
  // fee, or the approval changed nothing the customer can see.
  const grant = await activeGrantFor(env, intake.customerUserId);
  let carriedGift = requestedContribution;

  // Oldest wins, ties broken by id: every racer computes the same canonical
  // row no matter which of them inserted it.
  let existing = await env.DB.prepare(
    "SELECT id FROM payment_orders WHERE intake_id = ? AND purpose = 'BOOKING' AND status NOT IN ('FAILED', 'CANCELLED') ORDER BY created_at ASC, id ASC LIMIT 1"
  ).bind(intake.id).first();

  if (existing) {
    const sums = await env.DB.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN purpose = 'FUND_CONTRIBUTION' THEN amount_cents ELSE 0 END), 0) AS gift_cents,
        COALESCE(SUM(CASE WHEN purpose = 'OWNER_PLATFORM_FEE' THEN amount_cents ELSE 0 END), 0) AS fee_cents
      FROM payment_allocations WHERE payment_order_id = ?
    `).bind(existing.id).first();
    const giftCents = Number(sums?.gift_cents || 0);

    let stale = requestedContribution != null && giftCents !== requestedContribution;
    if (!stale && grant && Number(sums?.fee_cents || 0) > 0) {
      // Sponsorship arrived after this quote: the order still charges the
      // fee the grant waives. Re-price, carrying the gift already chosen.
      stale = true;
      if (carriedGift == null) carriedGift = giftCents;
    }
    if (stale) {
      const replaced = await retireUnpaidOrder(env, existing.id);
      // Guarded cancel: zero rows changed means the order left
      // DRAFT/REQUIRES_CONFIRMATION under us — almost certainly the webhook
      // marking it PAID mid-tap — and the money that actually moved outranks
      // the re-price. Keep the order as it is.
      if (replaced) existing = null;
    }
  }

  let orderId;
  if (existing) {
    orderId = existing.id;
  } else {
    // The deposit charged is the one the booking was quoted under: the §25
    // snapshot frozen at selection, re-evaluated with the customer's actual
    // sponsorship standing. Legacy intakes from before snapshots fall back
    // to their own offer-derived policy values.
    const bookingSnapshot = await getBookingDepositSnapshot(env, intake.id);
    let depositCents;
    if (bookingSnapshot) {
      const outcome = Boolean(grant) === bookingSnapshot.sponsored
        ? bookingSnapshot.outcome
        : depositOutcomeForBooking(bookingSnapshot.policy, { sponsored: Boolean(grant) });
      depositCents = Math.max(0, Math.trunc(Number(outcome?.customerOwesDepositCents) || 0));
    } else {
      depositCents = intake.policy?.depositRequired ? Math.trunc(Number(intake.depositAmountCents) || 0) : 0;
    }
    const quote = await quoteBooking(env, {
      sponsored: Boolean(grant),
      depositCents,
      // `carriedGift` rather than the raw request: a sponsorship re-price
      // keeps the gift the customer had already chosen on the retired order.
      contributionCents: carriedGift || 0
    });
    if (!quote.ok) return quote;
    const created = await createBookingPaymentOrder(env, {
      quote,
      intakeId: intake.id,
      tenantId: intake.tenantId,
      payerUserId: intake.customerUserId,
      // Recorded so the webhook can find which grant to consume once this
      // order is actually paid — never eagerly here, since an order that is
      // merely quoted and never paid must not spend somebody's one
      // sponsored connection.
      confirmationSnapshot: { sponsoredGrantId: grant?.id || null }
    });
    if (!created.ok) return created;
    orderId = created.paymentOrderId;

    // The SELECT above and this INSERT are not atomic, and the race is not
    // hypothetical: before the client grew its own in-flight guard, the
    // tracker screen and the payment card both asked on first render, both
    // found nothing, and both inserted — two live PaymentIntents for one
    // intake, visible in the Stripe dashboard. Converge instead of trusting
    // the read: re-select the canonical (oldest) row, and if ours lost the
    // race, cancel ours — still DRAFT, nothing charged against it — and
    // charge the winner. Both racers pick the same winner, so exactly one
    // order ever reaches Stripe.
    const canonical = await env.DB.prepare(
      "SELECT id FROM payment_orders WHERE intake_id = ? AND purpose = 'BOOKING' AND status NOT IN ('FAILED', 'CANCELLED') ORDER BY created_at ASC, id ASC LIMIT 1"
    ).bind(intake.id).first();
    if (canonical && canonical.id !== orderId) {
      await env.DB.prepare("UPDATE payment_orders SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'DRAFT'")
        .bind(orderId).run();
      orderId = canonical.id;
    }
  }

  const charge = await chargeBookingOrder(env, orderId);
  if (!charge.ok) return charge;
  return { ...charge, order: await getPaymentOrder(env, orderId) };
}

/**
 * Retire an order the customer just re-priced (changed their Paw It Forward
 * gift): cancel the row, fail its draft contribution, and best-effort cancel
 * the Stripe PaymentIntent so a stale payment sheet still holding the old
 * client secret cannot complete the old amount.
 *
 * Returns false — and changes nothing — if the order is no longer merely
 * quoted (the status guard on the UPDATE misses), which is the race where
 * payment succeeded in the same instant.
 */
async function retireUnpaidOrder(env, orderId) {
  const result = await env.DB.prepare(
    "UPDATE payment_orders SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('DRAFT', 'REQUIRES_CONFIRMATION')"
  ).bind(orderId).run();
  if (!Number(result?.meta?.changes || 0)) return false;

  await env.DB.prepare(
    "UPDATE contributions SET status = 'FAILED', failure_code = 'REPLACED_BY_NEW_QUOTE', updated_at = CURRENT_TIMESTAMP WHERE payment_order_id = ? AND status IN ('DRAFT', 'REQUIRES_PAYMENT')"
  ).bind(orderId).run();

  const order = await env.DB.prepare("SELECT stripe_payment_intent_id FROM payment_orders WHERE id = ? LIMIT 1").bind(orderId).first();
  if (order?.stripe_payment_intent_id && stripeConfigured(env)) {
    try {
      await cancelPaymentIntent(env, order.stripe_payment_intent_id, { reason: "abandoned" });
    } catch (error) {
      // Not fatal: an intent that refuses cancellation (already succeeded,
      // already cancelled) resolves through the webhook like any other, and
      // the order row is CANCELLED either way.
      console.warn(JSON.stringify({ event: "booking_order_intent_cancel_failed", orderId, message: error?.message || String(error) }));
    }
  }
  return true;
}

/**
 * Applies a Stripe payment_intent event to the `payment_orders` row it
 * belongs to. Deliberately touches nothing else — not `intake_requests`,
 * not either ledger — so this stays additive to the existing deposit
 * webhook handling in src/payments.js rather than risking it.
 *
 * Consumes a sponsorship grant on the transition to PAID, if this order's
 * quote waived the owner fee against one. The hardship module's own
 * `recordSponsoredCompletion` is written for "consume when the visit is
 * actually seen," which this is not — consuming on confirmed payment
 * instead is a deliberate, simpler substitute so a paid, sponsored booking
 * can never be reused for a second free connection while that larger
 * completion-time wiring remains unbuilt.
 */
export async function markBookingPaymentOrderStatus(env, { paymentOrderId, status, stripeEventId }) {
  if (!hasDatabase(env) || !paymentOrderId) return { updated: false };
  const order = await env.DB.prepare("SELECT * FROM payment_orders WHERE id = ? AND purpose = 'BOOKING' LIMIT 1").bind(paymentOrderId).first();
  if (!order) return { updated: false };
  // A webhook can arrive out of order; once paid, nothing should move an
  // order backwards to e.g. a late "processing" event for the same intent.
  if (order.status === "PAID" && status !== "PAID") return { updated: false };
  if (order.status === status) return { updated: false };

  await env.DB.prepare("UPDATE payment_orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(status, paymentOrderId).run();

  if (status === "PAID") {
    // A Paw It Forward gift riding in this charge is restricted fund money
    // the moment Stripe confirms it: post it to the fund ledger now
    // (`postContribution` is idempotent per contribution, so a redelivered
    // webhook posts nothing twice). Failure to post is loud but does not
    // fail the webhook — the order IS paid; the ledger entry is repairable,
    // a false payment failure is not.
    const contributions = await env.DB.prepare(
      "SELECT id FROM contributions WHERE payment_order_id = ? AND status IN ('DRAFT', 'REQUIRES_PAYMENT', 'SUCCEEDED')"
    ).bind(paymentOrderId).all();
    for (const row of contributions.results) {
      const posted = await postContribution(env, { contributionId: row.id, stripeEventId });
      if (!posted.ok) {
        console.warn(JSON.stringify({ event: "booking_contribution_post_failed", paymentOrderId, contributionId: row.id, reason: posted.code, stripeEventId }));
      }
    }

    let snapshot = {};
    try { snapshot = JSON.parse(order.confirmation_snapshot_json || "{}"); } catch { /* malformed snapshot, nothing to consume */ }
    if (snapshot.sponsoredGrantId) {
      const consumed = await recordSponsoredCompletion(env, {
        grantId: snapshot.sponsoredGrantId,
        userId: order.payer_user_id,
        reservationId: paymentOrderId
      });
      if (!consumed.ok) {
        console.warn(JSON.stringify({ event: "booking_payment_grant_consume_failed", paymentOrderId, grantId: snapshot.sponsoredGrantId, reason: consumed.code, stripeEventId }));
      }
    }
  }
  return { updated: true };
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
