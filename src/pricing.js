/**
 * Tími's own prices.
 *
 * Every fee this platform charges is a versioned row in `pricing_policies`,
 * not a constant. A booking captures the policy it was priced under, so
 * changing a price is prospective by construction and a receipt argument six
 * months from now is settled by what the customer was actually shown.
 *
 * ───────────────────────────────────────────────────── the economics ──
 *
 * A standard completed connection:
 *
 *   owner pays Tími      $20
 *   clinic pays Tími     $25
 *   ───────────────────────
 *   Tími earns           $45
 *
 * A sponsored connection costs the owner and the clinic nothing. The
 * community fund supplies $35 and Tími contributes the remaining $10 — but
 * only against fees that would genuinely have been charged. A founding
 * clinic pays $0 normally, so its sponsored booking is worth $20, not $45:
 * inventing a $25 clinic fee nobody would have paid, purely to make a donor
 * statistic larger, is the kind of arithmetic that ends a program.
 */

import { hasDatabase } from "./db.js";

/**
 * The fallback policy, used only when there is no database (demo mode and
 * the local UI harness). Deliberately identical to migration 0013's seeded
 * `pricing_v1` — a guard in scripts/validate.mjs proves they agree, because
 * a demo that quotes a different price than production is a demo that lies.
 */
export const FALLBACK_PRICING = Object.freeze({
  id: "pricing_v1",
  version: 1,
  ownerFeeCents: 2000,
  clinicFeeCents: 2500,
  timiMatchCents: 1000,
  minBookingContributionCents: 100,
  minStandaloneContributionCents: 1000,
  maxBookingContributionCents: 500000,
  maxStandaloneContributionCents: 2500000,
  currency: "usd"
});

function policyFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    version: Number(row.version),
    ownerFeeCents: Number(row.owner_fee_cents),
    clinicFeeCents: Number(row.clinic_fee_cents),
    timiMatchCents: Number(row.timi_match_cents),
    minBookingContributionCents: Number(row.min_booking_contribution_cents),
    minStandaloneContributionCents: Number(row.min_standalone_contribution_cents),
    maxBookingContributionCents: Number(row.max_booking_contribution_cents),
    maxStandaloneContributionCents: Number(row.max_standalone_contribution_cents),
    currency: row.currency || "usd"
  };
}

/** The single active pricing policy. */
export async function activePricingPolicy(env) {
  if (!hasDatabase(env)) return FALLBACK_PRICING;
  const row = await env.DB.prepare("SELECT * FROM pricing_policies WHERE active = 1 LIMIT 1").first();
  return policyFromRow(row) || FALLBACK_PRICING;
}

/** A specific policy by id — for reading a historical booking at its own price. */
export async function pricingPolicyById(env, policyId) {
  if (!policyId) return null;
  if (!hasDatabase(env)) return policyId === FALLBACK_PRICING.id ? FALLBACK_PRICING : null;
  const row = await env.DB.prepare("SELECT * FROM pricing_policies WHERE id = ? LIMIT 1").bind(policyId).first();
  return policyFromRow(row);
}

/**
 * What this clinic pays per completed connection, and why.
 *
 * The reason travels with the amount so a $0 line on an invoice can always
 * explain itself. A founding clinic that has fallen out of good standing
 * pays the standard fee again — prospectively; nothing re-bills the past.
 */
export async function clinicFeeFor(env, tenantId, policy) {
  const pricing = policy || await activePricingPolicy(env);
  const standard = { feeCents: pricing.clinicFeeCents, plan: "STANDARD", reason: "STANDARD_RATE" };
  if (!tenantId || !hasDatabase(env)) return standard;

  const row = await env.DB.prepare(
    "SELECT plan, custom_fee_cents, good_standing FROM clinic_pricing_assignments WHERE tenant_id = ? LIMIT 1"
  ).bind(tenantId).first();
  if (!row) return standard;

  if (row.plan === "FOUNDING") {
    if (!Number(row.good_standing)) {
      return { feeCents: pricing.clinicFeeCents, plan: "FOUNDING", reason: "FOUNDING_SUSPENDED_NOT_IN_GOOD_STANDING" };
    }
    return { feeCents: 0, plan: "FOUNDING", reason: "FOUNDING_CLINIC_RATE" };
  }
  if (row.plan === "CUSTOM") {
    // The migration's CHECK guarantees a custom plan carries an amount; this
    // is belt for a row written by hand against a database without it.
    const custom = row.custom_fee_cents === null || row.custom_fee_cents === undefined
      ? pricing.clinicFeeCents
      : Number(row.custom_fee_cents);
    return { feeCents: custom, plan: "CUSTOM", reason: "CUSTOM_CONTRACT_RATE" };
  }
  return standard;
}

/**
 * What a sponsored connection costs the fund, for this clinic.
 *
 * `applicableValueCents` is what Tími would genuinely have earned: the owner
 * fee plus whatever this clinic actually pays. Tími's match is capped at
 * that value, and the fund covers the rest — so a founding clinic's
 * sponsored booking asks the fund for $10, not $35.
 */
export function sponsorshipCostFor({ ownerFeeCents, clinicFeeCents, timiMatchCents }) {
  const owner = Math.max(0, Math.trunc(Number(ownerFeeCents) || 0));
  const clinic = Math.max(0, Math.trunc(Number(clinicFeeCents) || 0));
  const applicableValueCents = owner + clinic;
  const matchCents = Math.min(Math.max(0, Math.trunc(Number(timiMatchCents) || 0)), applicableValueCents);
  return {
    applicableValueCents,
    ownerFeeCents: owner,
    clinicFeeCents: clinic,
    /** Tími's own contribution. A reporting measure — never cash from the fund. */
    timiMatchCents: matchCents,
    /** What the restricted fund must supply and, on completion, earns. */
    fundContributionCents: applicableValueCents - matchCents
  };
}

/** The whole sponsorship picture for one clinic under the active policy. */
export async function sponsorshipQuote(env, tenantId) {
  const pricing = await activePricingPolicy(env);
  const clinic = await clinicFeeFor(env, tenantId, pricing);
  return {
    pricingPolicyId: pricing.id,
    pricingVersion: pricing.version,
    clinicPlan: clinic.plan,
    clinicFeeReason: clinic.reason,
    currency: pricing.currency,
    ...sponsorshipCostFor({
      ownerFeeCents: pricing.ownerFeeCents,
      clinicFeeCents: clinic.feeCents,
      timiMatchCents: pricing.timiMatchCents
    })
  };
}

/**
 * Whether a contribution amount is one Tími will take.
 *
 * Whole dollars only, on purpose: a $2.37 contribution is a rounding error
 * with a receipt, and the processor fee on it is most of the money.
 */
export function validateContributionAmount(amountCents, { standalone, policy }) {
  const cents = Math.trunc(Number(amountCents));
  if (!Number.isFinite(cents) || cents <= 0) {
    return { ok: false, code: "CONTRIBUTION_REQUIRED", message: "Enter a contribution amount." };
  }
  if (cents % 100 !== 0) {
    return { ok: false, code: "WHOLE_DOLLARS_ONLY", message: "Contributions are in whole dollars." };
  }
  const minimum = standalone ? policy.minStandaloneContributionCents : policy.minBookingContributionCents;
  const maximum = standalone ? policy.maxStandaloneContributionCents : policy.maxBookingContributionCents;
  if (cents < minimum) {
    return { ok: false, code: "CONTRIBUTION_TOO_SMALL", message: `The smallest contribution here is $${(minimum / 100).toFixed(0)}.` };
  }
  if (cents > maximum) {
    return { ok: false, code: "CONTRIBUTION_TOO_LARGE", message: `The largest contribution here is $${(maximum / 100).toFixed(0)}. Contact us to give more.` };
  }
  return { ok: true, amountCents: cents };
}
