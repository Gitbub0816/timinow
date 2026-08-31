/**
 * Paw It Forward custody — addendum §5.
 *
 * A customer pays $22 in one charge. Twenty dollars of it is ordinary
 * ClearKey Solutions, LLC revenue and two dollars is Paw It Forward money —
 * designated from the moment the allocation is written, while it is still
 * physically sitting in the Stripe Payments balance. This file is what moves
 * that two dollars, and only that two dollars, into protected custody, and
 * what refuses to pretend it moved when it did not.
 *
 * ─────────────────────────────────────────── two facts, never conflated ──
 *
 *   designated in the ledger   fund_available + fund_reserved. True the
 *                              instant the contribution posts. Correct on
 *                              every deployment, Treasury or not.
 *   physically protected       cash actually in the Stripe Treasury
 *                              financial account. True only after a rail
 *                              confirmed a movement.
 *
 * `designationStatus()` returns both, separately, always. A deployment with
 * no Treasury rail reports honest designation and zero protection; §28 says
 * an operating payout may not consume unswept designated cash, and
 * `operatingPayoutGuard()` is that rule as arithmetic rather than a promise.
 *
 * ──────────────────────────────────────── why a double sweep cannot happen ──
 *
 * Not "is unlikely". Three independent structures have to fail at once:
 *
 *   1. The worker never sweeps a balance. It sweeps *contributions*, one at
 *      a time, and the amount is read from the ledger — the net of credits
 *      and debits to `fund_available` carrying that contribution's id.
 *      Ordinary revenue never touches `fund_available`, so ordinary revenue
 *      is not merely excluded, it is unaddressable (acceptance test 4).
 *   2. A claim row is inserted before the rail is called, guarded by
 *      `NOT EXISTS (a live sweep for this contribution)`. Zero rows changed
 *      means another worker got there first, which is a skip, not an error.
 *   3. `idx_pif_custody_transfers_live_sweep` is a partial UNIQUE index on
 *      `contribution_id` where the sweep is not FAILED. If two workers pass
 *      the guard in the same instant, the database refuses the second row.
 *
 * A FAILED attempt falls out of that index on purpose: a sweep that failed
 * closed because Treasury was unavailable must be retryable the day the rail
 * comes back, and the retry gets its own attempt number and its own
 * idempotency key so it can never collide with the attempt that failed.
 *
 * ───────────────────────────────────────────────────────── fail closed ──
 *
 * §5 and §28: if a required Treasury rail is unavailable, refuse with a
 * code. Never fake a transfer state, never mark something swept that was
 * not. Nothing in this file posts a ledger entry before the rail has
 * accepted the movement, and nothing marks a transfer COMPLETED before the
 * rail says it completed. A transfer in PENDING or IN_TRANSIT is an honest
 * "we do not know yet"; reconciliation raises the stale ones for a human.
 */

import { hasDatabase } from "./db.js";
import { encodeForm, idempotencyKey, stripeConfigured, StripeError } from "./stripe.js";
import { accountBalance, postTransaction, recordAudit } from "./ledger.js";

/* ------------------------------------------------------------ helpers --- */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const SECURITY_HEADERS = {
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), payment=(self), geolocation=(self)"
};

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

/** Whole cents or nothing. §23: money is integer minor units, never a float. */
function cents(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || !Number.isInteger(amount)) return null;
  return amount;
}

const DATABASE_REQUIRED = {
  ok: false,
  code: "DATABASE_REQUIRED",
  message: "Paw It Forward custody requires D1. There is no demo-mode arithmetic for protected cash."
};

export const CUSTODY_DIRECTIONS = ["SWEEP", "RELEASE", "GUARANTEE_FUNDING", "GUARANTEE_RETURN"];
export const CUSTODY_TRANSFER_STATES = ["PENDING", "IN_TRANSIT", "COMPLETED", "FAILED", "CANCELED"];

/** Guarantee states in which program cash is still committed to a clinic. */
export const GUARANTEE_COMMITTED_STATES = [
  "RESERVED", "FUNDING_PENDING", "FUNDED", "RETURN_DUE", "RETURN_PENDING", "DISPUTED"
];
/** Guarantee states in which program cash is physically at a clinic. */
export const GUARANTEE_AT_CLINIC_STATES = ["FUNDED", "RETURN_DUE", "RETURN_PENDING", "DISPUTED"];

/**
 * Where each direction moves cash, and which §6 event it records.
 *
 * `pif_custody_in_transit` is the third account every movement can pass
 * through: it holds cash that has left one side and not yet landed on the
 * other, so an asynchronous rail never has to be described as either "still
 * in Payments" or "safely in custody" while it is neither.
 */
const MOVEMENTS = {
  SWEEP: {
    from: "processor_cash",
    to: "pif_custody_cash",
    eventType: "CONTRIBUTION_SWEPT_TO_TREASURY",
    memo: "CONTRIBUTION_SWEPT_TO_TREASURY: designated Paw It Forward cash moved from Payments into protected custody."
  },
  RELEASE: {
    from: "pif_custody_cash",
    to: "clearkey_operating_cash",
    eventType: "SPONSORSHIP_TREASURY_RELEASED",
    memo: "SPONSORSHIP_TREASURY_RELEASED: earned sponsorship released from protected custody to ClearKey operating."
  },
  GUARANTEE_FUNDING: {
    from: "pif_custody_cash",
    to: "deposit_guarantee_outstanding",
    eventType: "DEPOSIT_GUARANTEE_FUNDED",
    memo: "DEPOSIT_GUARANTEE_FUNDED: program float moved from protected custody to a clinic. Still Paw It Forward money."
  },
  GUARANTEE_RETURN: {
    from: "deposit_guarantee_outstanding",
    to: "pif_custody_cash",
    eventType: "DEPOSIT_GUARANTEE_RETURNED",
    memo: "DEPOSIT_GUARANTEE_RETURNED: guarantee float returned by the clinic to protected custody."
  }
};

/**
 * The §6 event names travel on `pif_custody_transfers.event_type`, not on
 * `ledger_transactions.kind`, because 0013 fixes that column with a CHECK and
 * SQLite cannot widen one without rebuilding the table. Migration 0018 made
 * the same call for the guarantee events; this is the same decision, not a
 * second one. `adjustment` is the kind the enumeration already provides for
 * a movement it does not name.
 */
const LEDGER_KIND = "adjustment";

/* ═══════════════════════════════════════════ FundCustodyProvider (§5) ══
 *
 * The five methods §5 names, and nothing else in the public shape:
 *
 *   getCustodyBalance()
 *   sweepContribution()
 *   releaseCompletedSponsorship()
 *   fundDepositGuarantee()
 *   reconcile()
 *
 * Every one takes `env` first, because a Cloudflare Worker has no ambient
 * configuration and a provider that closed over secrets at module load would
 * be a provider that cannot be tested.
 *
 * A movement method returns either
 *   { ok: true, state: "COMPLETED" | "IN_TRANSIT", providerObjectId, providerStatus }
 * or
 *   { ok: false, code, message }
 * and never anything in between. There is no third answer where the caller
 * has to guess whether cash moved.
 *
 * One method beyond §5's five: `receiveGuaranteeReturn()`, the inbound half
 * of `fundDepositGuarantee()`. §7 requires the float to come back, and the
 * return travels a different Stripe rail than the funding did, so it is a
 * rail and belongs on the provider. Every provider implements it; nothing
 * outside this file depends on it being one of the five.
 */

/** What a provider refuses with when the account has no usable rail. */
export const RAIL_UNAVAILABLE = "TREASURY_RAIL_UNAVAILABLE";

function railUnavailable(message) {
  return { ok: false, code: RAIL_UNAVAILABLE, message };
}

/* ------------------------------------------------- Stripe Treasury ------ */

const STRIPE_API = "https://api.stripe.com";

/**
 * One Stripe request, in the shape src/stripe.js uses.
 *
 * `stripeFetch` there is module-private and src/stripe.js is not ours to
 * edit, so the Treasury endpoints get their own transport here — same form
 * encoding, same deterministic idempotency header, same error class, so a
 * caller cannot tell which file made the call.
 */
async function treasuryFetch(env, path, { method = "GET", body, idempotencyKey: key } = {}) {
  const secret = env?.STRIPE_SECRET_KEY;
  if (!secret) throw new StripeError(503, "STRIPE_SECRET_KEY is not configured on this Worker.");
  const headers = {
    authorization: `Bearer ${secret}`,
    accept: "application/json"
  };
  if (key && method !== "GET") headers["idempotency-key"] = key;
  let payload;
  if (body !== undefined && method !== "GET") {
    headers["content-type"] = "application/x-www-form-urlencoded";
    payload = encodeForm(body).toString();
  }
  const response = await fetch(`${STRIPE_API}${path}`, { method, headers, body: payload });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  if (!response.ok) {
    throw new StripeError(response.status, parsed?.error?.message || `Stripe responded ${response.status}`, parsed);
  }
  return parsed;
}

/**
 * A Stripe error that means "this account does not have this rail".
 *
 * 401/403/404 and the resource/permission error codes are configuration, not
 * weather: retrying will not help and the honest answer is that the rail is
 * unavailable. Everything else (429, 5xx, network) is a transient rail
 * error, which also fails closed but is worth retrying.
 */
function classifyStripeFailure(error) {
  if (!(error instanceof StripeError)) {
    return { code: "TREASURY_RAIL_ERROR", message: error?.message || "The custody rail could not be reached." };
  }
  const permanent = [401, 402, 403, 404].includes(error.status)
    || ["resource_missing", "feature_not_enabled", "treasury_not_enabled", "parameter_unknown"].includes(error.code || "");
  return {
    code: permanent ? RAIL_UNAVAILABLE : "TREASURY_RAIL_ERROR",
    message: error.message
  };
}

/**
 * Protected custody backed by a Stripe Treasury financial account.
 *
 * Rails used, all of them account-specific and therefore all of them
 * preflighted:
 *
 *   sweep              POST /v1/payouts with destination = the financial
 *                      account. This is how Payments balance reaches
 *                      Treasury; it settles asynchronously, so a sweep is
 *                      IN_TRANSIT until `payout.paid` arrives.
 *   release / funding  POST /v1/treasury/outbound_payments
 *   guarantee return   POST /v1/treasury/inbound_transfers
 *   balance            GET  /v1/treasury/financial_accounts/{id}
 *
 * If `STRIPE_TREASURY_FINANCIAL_ACCOUNT` is unset, or Stripe answers that the
 * capability is not enabled, every method refuses. None of them degrades to
 * "assume it worked".
 */
export function stripeTreasuryCustodyProvider(options = {}) {
  const provider = {
    id: "stripe_treasury",
    mode: "STRIPE_TREASURY",
    protectsCash: true,

    financialAccount(env) {
      return cleanString(options.financialAccountId || env?.STRIPE_TREASURY_FINANCIAL_ACCOUNT, 120);
    },

    available(env) {
      if (!stripeConfigured(env)) {
        return { ok: false, code: RAIL_UNAVAILABLE, message: "Stripe is not configured on this Worker." };
      }
      if (!provider.financialAccount(env)) {
        return {
          ok: false,
          code: RAIL_UNAVAILABLE,
          message: "STRIPE_TREASURY_FINANCIAL_ACCOUNT is not set, so this deployment has no protected custody account."
        };
      }
      return { ok: true };
    },

    async getCustodyBalance(env, { currency = "usd" } = {}) {
      const ready = provider.available(env);
      if (!ready.ok) return { ...ready, custodyProtected: false };
      try {
        const account = await treasuryFetch(env, `/v1/treasury/financial_accounts/${provider.financialAccount(env)}`);
        const cash = account?.balance?.cash?.[currency];
        if (cash === undefined || cash === null) {
          return railUnavailable(`The Treasury financial account reports no ${currency} cash balance.`);
        }
        return {
          ok: true,
          custodyProtected: true,
          balanceCents: Math.trunc(Number(cash)),
          currency,
          providerReference: provider.financialAccount(env)
        };
      } catch (error) {
        return { ...classifyStripeFailure(error), custodyProtected: false };
      }
    },

    async sweepContribution(env, plan) {
      const ready = provider.available(env);
      if (!ready.ok) return ready;
      try {
        const payout = await treasuryFetch(env, "/v1/payouts", {
          method: "POST",
          idempotencyKey: idempotencyKey("pif", "sweep", plan.transferId),
          body: {
            amount: plan.amountCents,
            currency: plan.currency,
            destination: provider.financialAccount(env),
            description: "Paw It Forward designated contribution sweep",
            metadata: {
              clearkey_product: "timinow",
              clearkey_entity: "ClearKey Solutions, LLC",
              pif_event: "CONTRIBUTION_SWEPT_TO_TREASURY",
              pif_transfer_id: plan.transferId,
              pif_contribution_id: plan.contributionId || ""
            }
          }
        });
        return {
          ok: true,
          state: payout?.status === "paid" ? "COMPLETED" : "IN_TRANSIT",
          providerObjectId: payout?.id || null,
          providerStatus: payout?.status || null,
          providerReference: provider.financialAccount(env)
        };
      } catch (error) {
        return classifyStripeFailure(error);
      }
    },

    async releaseCompletedSponsorship(env, plan) {
      return outbound(env, plan, "SPONSORSHIP_TREASURY_RELEASED",
        cleanString(options.operatingDestination || env?.STRIPE_TREASURY_OPERATING_DESTINATION, 120));
    },

    async fundDepositGuarantee(env, plan) {
      return outbound(env, plan, "DEPOSIT_GUARANTEE_FUNDED",
        cleanString(plan.destinationPaymentMethod || options.guaranteeDestination || env?.STRIPE_TREASURY_GUARANTEE_DESTINATION, 120));
    },

    /**
     * Returned guarantee float, coming back into custody from the clinic.
     *
     * Not one of §5's five: the five are the interface every provider must
     * implement, and this is the inbound half of `fundDepositGuarantee`,
     * needed because §7 requires the money to come back. Kept on the
     * provider rather than in the worker because it is a rail, not a policy.
     */
    async receiveGuaranteeReturn(env, plan) {
      const ready = provider.available(env);
      if (!ready.ok) return ready;
      const origin = cleanString(plan.originPaymentMethod || options.guaranteeDestination || env?.STRIPE_TREASURY_GUARANTEE_DESTINATION, 120);
      if (!origin) {
        return railUnavailable("No Treasury origin payment method is configured for a guarantee return.");
      }
      try {
        const transfer = await treasuryFetch(env, "/v1/treasury/inbound_transfers", {
          method: "POST",
          idempotencyKey: idempotencyKey("pif", "guarantee_return", plan.transferId),
          body: {
            financial_account: provider.financialAccount(env),
            amount: plan.amountCents,
            currency: plan.currency,
            origin_payment_method: origin,
            description: "Paw It Forward appointment deposit guarantee return",
            metadata: {
              clearkey_product: "timinow",
              pif_event: "DEPOSIT_GUARANTEE_RETURNED",
              pif_transfer_id: plan.transferId,
              pif_guarantee_id: plan.guaranteeId || ""
            }
          }
        });
        return {
          ok: true,
          state: transfer?.status === "succeeded" ? "COMPLETED" : "IN_TRANSIT",
          providerObjectId: transfer?.id || null,
          providerStatus: transfer?.status || null,
          providerReference: provider.financialAccount(env)
        };
      } catch (error) {
        return classifyStripeFailure(error);
      }
    },

    /** The rail's own view, for src/reconciliation.js. */
    async reconcile(env, { currency = "usd" } = {}) {
      const balance = await provider.getCustodyBalance(env, { currency });
      if (!balance.ok) return balance;
      return {
        ok: true,
        custodyProtected: true,
        mode: provider.mode,
        provider: provider.id,
        balanceCents: balance.balanceCents,
        currency,
        providerReference: balance.providerReference
      };
    }
  };

  async function outbound(env, plan, event, destination) {
    const ready = provider.available(env);
    if (!ready.ok) return ready;
    if (!destination) {
      return railUnavailable("No Treasury outbound destination is configured, so custody cannot pay out.");
    }
    try {
      const payment = await treasuryFetch(env, "/v1/treasury/outbound_payments", {
        method: "POST",
        idempotencyKey: idempotencyKey("pif", "outbound", plan.transferId),
        body: {
          financial_account: provider.financialAccount(env),
          amount: plan.amountCents,
          currency: plan.currency,
          destination_payment_method: destination,
          description: event === "SPONSORSHIP_TREASURY_RELEASED"
            ? "Paw It Forward earned sponsorship release"
            : "Paw It Forward appointment deposit guarantee funding",
          metadata: {
            clearkey_product: "timinow",
            clearkey_entity: "ClearKey Solutions, LLC",
            pif_event: event,
            pif_transfer_id: plan.transferId,
            pif_reservation_id: plan.reservationId || "",
            pif_guarantee_id: plan.guaranteeId || ""
          }
        }
      });
      return {
        ok: true,
        state: payment?.status === "posted" ? "COMPLETED" : "IN_TRANSIT",
        providerObjectId: payment?.id || null,
        providerStatus: payment?.status || null,
        providerReference: provider.financialAccount(env)
      };
    } catch (error) {
      return classifyStripeFailure(error);
    }
  }

  return provider;
}

/* ------------------------------------------------------------- stub ---- */

/** Deterministic id, so a retry of the same movement returns the same one. */
function stubObjectId(direction, key) {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `stub_${direction.toLowerCase()}_${hash.toString(16).padStart(8, "0")}`;
}

/**
 * A custody rail with no network.
 *
 * For tests, previews, and any deployment that wants the full custody state
 * machine exercised without a Treasury account. Its balance is derived from
 * completed transfers rather than from the ledger, on purpose: a stub that
 * read the ledger back would make reconciliation tautological, and the one
 * thing reconciliation must be able to do is disagree with the ledger.
 *
 * `driftCents` exists for exactly that — it is how a test manufactures the
 * one-cent discrepancy §21 requires to be caught. `protectsCash` is false:
 * a stub holds no money, and nothing built on it may claim otherwise.
 */
export function stubCustodyProvider(options = {}) {
  const settleImmediately = options.settleImmediately !== false;
  const provider = {
    id: "stub",
    mode: "STUB",
    protectsCash: false,
    driftCents: Math.trunc(Number(options.driftCents) || 0),
    /** Set to a code to make every movement fail closed, as a rail outage would. */
    unavailable: options.unavailable || null,

    available() {
      return provider.unavailable
        ? { ok: false, code: RAIL_UNAVAILABLE, message: `The stub custody rail is unavailable: ${provider.unavailable}.` }
        : { ok: true };
    },

    async getCustodyBalance(env, { currency = "usd" } = {}) {
      const ready = provider.available();
      if (!ready.ok) return { ...ready, custodyProtected: false };
      if (!hasDatabase(env)) return { ...DATABASE_REQUIRED, custodyProtected: false };
      const row = await env.DB.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN direction IN ('SWEEP', 'GUARANTEE_RETURN') THEN amount_cents ELSE 0 END), 0) AS inflow,
          COALESCE(SUM(CASE WHEN direction IN ('RELEASE', 'GUARANTEE_FUNDING') THEN amount_cents ELSE 0 END), 0) AS outflow
        FROM pif_custody_transfers
        WHERE state = 'COMPLETED' AND currency = ?
      `).bind(currency).first();
      return {
        ok: true,
        custodyProtected: false,
        balanceCents: Number(row?.inflow || 0) - Number(row?.outflow || 0) + provider.driftCents,
        currency,
        providerReference: "stub_financial_account"
      };
    },

    async sweepContribution(_env, plan) { return movement("SWEEP", plan); },
    async releaseCompletedSponsorship(_env, plan) { return movement("RELEASE", plan); },
    async fundDepositGuarantee(_env, plan) { return movement("GUARANTEE_FUNDING", plan); },
    async receiveGuaranteeReturn(_env, plan) { return movement("GUARANTEE_RETURN", plan); },

    async reconcile(env, { currency = "usd" } = {}) {
      const balance = await provider.getCustodyBalance(env, { currency });
      if (!balance.ok) return balance;
      return {
        ok: true,
        custodyProtected: false,
        mode: provider.mode,
        provider: provider.id,
        balanceCents: balance.balanceCents,
        currency,
        providerReference: balance.providerReference
      };
    }
  };

  function movement(direction, plan) {
    const ready = provider.available();
    if (!ready.ok) return ready;
    return {
      ok: true,
      state: settleImmediately ? "COMPLETED" : "IN_TRANSIT",
      providerObjectId: stubObjectId(direction, plan.transferId),
      providerStatus: settleImmediately ? "settled" : "processing",
      providerReference: "stub_financial_account"
    };
  }

  return provider;
}

/* ------------------------------------------------------ no rail at all -- */

/**
 * The provider for a deployment with no custody rail.
 *
 * Every movement refuses. The ledger still designates money correctly, the
 * sweep still identifies the exact amount that ought to move, and the
 * transfer table still records that it could not — what does not happen is
 * anything claiming the cash is protected. §5: fail closed.
 */
export function unavailableCustodyProvider(reason = "No Paw It Forward custody rail is configured for this deployment.") {
  const refuse = async () => railUnavailable(reason);
  return {
    id: "none",
    mode: "NONE",
    protectsCash: false,
    available: () => ({ ok: false, code: RAIL_UNAVAILABLE, message: reason }),
    getCustodyBalance: async () => ({ ok: false, code: RAIL_UNAVAILABLE, message: reason, custodyProtected: false }),
    sweepContribution: refuse,
    releaseCompletedSponsorship: refuse,
    fundDepositGuarantee: refuse,
    receiveGuaranteeReturn: refuse,
    reconcile: async () => ({ ok: false, code: RAIL_UNAVAILABLE, message: reason, custodyProtected: false })
  };
}

/**
 * Which provider this deployment gets.
 *
 * `PIF_CUSTODY_PROVIDER=stub` is explicit opt-in and never a fallback: a
 * misconfigured production Worker must land on `unavailableCustodyProvider`
 * and refuse, not on a stub that cheerfully reports movements.
 */
export function resolveCustodyProvider(env, options = {}) {
  if (options.provider) return options.provider;
  const configured = cleanString(env?.PIF_CUSTODY_PROVIDER, 40).toLowerCase();
  if (configured === "stub") return stubCustodyProvider(options.stub || {});
  if (configured === "none") return unavailableCustodyProvider("Paw It Forward custody is disabled on this deployment.");
  const treasury = stripeTreasuryCustodyProvider(options.treasury || {});
  const ready = treasury.available(env);
  return ready.ok
    ? treasury
    : unavailableCustodyProvider(ready.message);
}

/* ═══════════════════════════════════════════ designation vs protection ══ */

function settlementCutoff(env, { now = null, settlementDelayHours = null } = {}) {
  const hours = Number(
    settlementDelayHours === null || settlementDelayHours === undefined
      ? env?.PIF_SWEEP_SETTLEMENT_DELAY_HOURS
      : settlementDelayHours
  );
  const delay = Number.isFinite(hours) && hours > 0 ? hours : 0;
  const at = now ? Date.parse(now) : Date.now();
  return new Date(at - delay * 3_600_000).toISOString();
}

/**
 * Designated contributions that have not been swept, with the exact amount
 * the ledger says is still designated for each.
 *
 * The amount is `credits - debits` on `fund_available` for transactions
 * carrying this contribution's id, which means a partially refunded $50
 * contribution offers $30 to the sweep without anybody subtracting, and a
 * fully refunded one offers nothing and drops out of the HAVING clause.
 */
async function unsweptContributions(env, { cutoff, settledOnly = true, limit = null }) {
  const comparison = settledOnly ? "<=" : ">";
  const sql = `
    SELECT c.id AS contribution_id, c.currency AS currency, c.posted_at AS posted_at,
           COALESCE(SUM(e.credit_cents), 0) - COALESCE(SUM(e.debit_cents), 0) AS designated_cents
    FROM contributions c
    JOIN ledger_transactions t
      ON t.contribution_id = c.id AND t.kind IN ('contribution_posted', 'contribution_refunded')
    JOIN ledger_entries e
      ON e.transaction_id = t.id AND e.account_code = 'fund_available'
    WHERE c.posted_at IS NOT NULL
      AND c.posted_at ${comparison} ?
      AND NOT EXISTS (
        SELECT 1 FROM pif_custody_transfers x
        WHERE x.contribution_id = c.id AND x.direction = 'SWEEP' AND x.state <> 'FAILED'
      )
    GROUP BY c.id
    HAVING designated_cents > 0
    ORDER BY c.posted_at ASC, c.id ASC
    ${limit ? "LIMIT ?" : ""}
  `;
  const statement = limit ? env.DB.prepare(sql).bind(cutoff, limit) : env.DB.prepare(sql).bind(cutoff);
  const result = await statement.all();
  return result.results.map((row) => ({
    contributionId: row.contribution_id,
    currency: row.currency || "usd",
    postedAt: row.posted_at,
    designatedCents: Number(row.designated_cents || 0)
  }));
}

async function sumTransfers(env, { direction, states, currency = "usd" }) {
  const row = await env.DB.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) AS total, COUNT(*) AS count
    FROM pif_custody_transfers
    WHERE direction = ? AND currency = ?
      AND state IN (${states.map(() => "?").join(", ")})
  `).bind(direction, currency, ...states).first();
  return { totalCents: Number(row?.total || 0), count: Number(row?.count || 0) };
}

/**
 * The three states §5 asks to be tracked, plus the two questions they exist
 * to answer: how much designated money is not yet protected, and is any of
 * it protected at all.
 *
 *   unsettledCents           charged, not yet available to move
 *   availableToSweepCents    designated, settled, unclaimed
 *   sweptCents               moved into custody and confirmed there
 *
 * `designatedLedgerCents` and `custodyLedgerCents` are the two facts from the
 * file header, side by side, so no caller ever has to infer one from the
 * other.
 */
export async function designationStatus(env, options = {}) {
  if (!hasDatabase(env)) return DATABASE_REQUIRED;
  const currency = cleanString(options.currency, 8) || "usd";
  const provider = resolveCustodyProvider(env, options);
  const cutoff = settlementCutoff(env, options);

  const [settled, settling] = await Promise.all([
    unsweptContributions(env, { cutoff, settledOnly: true }),
    unsweptContributions(env, { cutoff, settledOnly: false })
  ]);

  // Money Stripe has confirmed but the journal has not yet recorded. It is
  // designated by intent and not yet designated by posting, so it belongs in
  // "unsettled" and never in "available to sweep".
  const chargedNotPosted = await env.DB.prepare(`
    SELECT COALESCE(SUM(c.amount_cents - c.refunded_cents), 0) AS total
    FROM contributions c
    WHERE c.status = 'SUCCEEDED'
      AND NOT EXISTS (
        SELECT 1 FROM ledger_transactions t
        WHERE t.contribution_id = c.id AND t.kind = 'contribution_posted'
      )
  `).first();

  const availableToSweepCents = settled.reduce((total, row) => total + row.designatedCents, 0);
  const settlingCents = settling.reduce((total, row) => total + row.designatedCents, 0);
  const unsettledCents = settlingCents + Number(chargedNotPosted?.total || 0);

  const [sweepCompleted, sweepInFlight, releaseInFlight, guaranteeFundingInFlight, guaranteeReturnInFlight] = await Promise.all([
    sumTransfers(env, { direction: "SWEEP", states: ["COMPLETED"], currency }),
    sumTransfers(env, { direction: "SWEEP", states: ["PENDING", "IN_TRANSIT"], currency }),
    sumTransfers(env, { direction: "RELEASE", states: ["PENDING", "IN_TRANSIT"], currency }),
    sumTransfers(env, { direction: "GUARANTEE_FUNDING", states: ["PENDING", "IN_TRANSIT"], currency }),
    sumTransfers(env, { direction: "GUARANTEE_RETURN", states: ["PENDING", "IN_TRANSIT"], currency })
  ]);

  const [fundAvailableCents, fundReservedCents, custodyLedgerCents, inTransitLedgerCents, guaranteeAtClinicCents] = await Promise.all([
    accountBalance(env, "fund_available"),
    accountBalance(env, "fund_reserved"),
    accountBalance(env, "pif_custody_cash"),
    accountBalance(env, "pif_custody_in_transit"),
    accountBalance(env, "deposit_guarantee_outstanding")
  ]);

  const designatedInPaymentsCents = unsettledCents + availableToSweepCents;

  return {
    ok: true,
    currency,
    custodyMode: provider.mode,
    provider: provider.id,
    /** True only when a rail that genuinely protects cash is in use. */
    custodyProtected: Boolean(provider.protectsCash) && provider.available(env).ok,
    railAvailable: provider.available(env).ok,

    // §5's three states.
    unsettledPifContributionsCents: unsettledCents,
    availableToSweepPifContributionsCents: availableToSweepCents,
    sweptPifContributionsCents: sweepCompleted.totalCents,

    // Designated in the ledger, which is true regardless of any rail.
    designatedLedgerCents: fundAvailableCents + fundReservedCents,
    fundAvailableCents,
    fundReservedCents,

    // Physically where.
    designatedInPaymentsCents,
    custodyLedgerCents,
    inTransitLedgerCents,
    guaranteeCashAtClinicCents: guaranteeAtClinicCents,
    inFlight: {
      sweepCents: sweepInFlight.totalCents,
      releaseCents: releaseInFlight.totalCents,
      guaranteeFundingCents: guaranteeFundingInFlight.totalCents,
      guaranteeReturnCents: guaranteeReturnInFlight.totalCents,
      count: sweepInFlight.count + releaseInFlight.count + guaranteeFundingInFlight.count + guaranteeReturnInFlight.count
    },

    // The number a payout may not touch.
    unprotectedDesignatedCents: designatedInPaymentsCents,
    sweepableCount: settled.length
  };
}

/* ═════════════════════════════════════════════ payout race protection ══
 *
 * §5 and §28: an automatic operating payout must not be able to remove
 * contribution cash before the designated amount is swept. The rule is not a
 * schedule tweak, because a schedule cannot be asserted in a test. It is a
 * floor:
 *
 *   payoutable = processor cash
 *              − designated cash still sitting in Payments
 *              − other restricted balances still sitting in Payments
 *
 * Payout logic asks this before it asks Stripe for anything, and a payout
 * that would dip below the floor is refused with a code that names the
 * reason. Two dollars of somebody's contribution is not a rounding error in
 * a payout run; it is the whole program.
 */
export async function operatingPayoutGuard(env, { amountCents = null, currency = "usd" } = {}) {
  if (!hasDatabase(env)) return DATABASE_REQUIRED;
  const status = await designationStatus(env, { currency });
  if (!status.ok) return status;

  const [processorCashCents, clinicPayableCents, refundsPayableCents] = await Promise.all([
    accountBalance(env, "processor_cash"),
    accountBalance(env, "clinic_payable"),
    accountBalance(env, "contribution_refunds_payable")
  ]);

  const protectedFloorCents = status.unprotectedDesignatedCents;
  const otherRestrictedCents = clinicPayableCents + refundsPayableCents;
  const payoutableCents = Math.max(0, processorCashCents - protectedFloorCents - otherRestrictedCents);

  const requested = amountCents === null || amountCents === undefined ? null : cents(amountCents);
  if (requested !== null && (requested === null || requested <= 0)) {
    return { ok: false, code: "INVALID_PAYOUT_AMOUNT", message: "A payout amount is whole cents above zero." };
  }

  const base = {
    ok: true,
    currency,
    processorCashCents,
    protectedFloorCents,
    otherRestrictedCents,
    payoutableCents,
    custodyProtected: status.custodyProtected,
    unsweptDesignatedCents: status.unprotectedDesignatedCents
  };

  if (requested === null) return { ...base, allowed: null };
  if (requested <= payoutableCents) return { ...base, allowed: true, requestedCents: requested };

  const blockedByPif = requested > processorCashCents - protectedFloorCents - otherRestrictedCents
    && protectedFloorCents > 0
    && requested <= processorCashCents - otherRestrictedCents;

  return {
    ...base,
    allowed: false,
    requestedCents: requested,
    code: blockedByPif ? "PAYOUT_BLOCKED_UNSWEPT_DESIGNATED_CASH" : "PAYOUT_EXCEEDS_UNRESTRICTED_CASH",
    message: blockedByPif
      ? `That payout would remove ${protectedFloorCents} cents of designated Paw It Forward money that has not been swept into protected custody.`
      : "That payout exceeds ClearKey's unrestricted balance at the processor."
  };
}

/* ═══════════════════════════════════════════════ the transfer machinery ══ */

function transferFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    direction: row.direction,
    eventType: row.event_type,
    amountCents: Number(row.amount_cents || 0),
    currency: row.currency || "usd",
    state: row.state,
    provider: row.provider,
    providerObjectId: row.provider_object_id || null,
    providerReference: row.provider_reference || null,
    providerStatus: row.provider_status || null,
    contributionId: row.contribution_id || null,
    reservationId: row.reservation_id || null,
    sponsorshipId: row.sponsorship_id || null,
    guaranteeId: row.guarantee_id || null,
    initiatedTransactionId: row.initiated_transaction_id || null,
    settledTransactionId: row.settled_transaction_id || null,
    idempotencyKey: row.idempotency_key,
    attempt: Number(row.attempt || 1),
    errorCode: row.error_code || null,
    error: row.error || null,
    requestedAt: row.requested_at,
    settledAt: row.settled_at || null
  };
}

async function getTransfer(env, transferId) {
  const row = await env.DB.prepare("SELECT * FROM pif_custody_transfers WHERE id = ? LIMIT 1").bind(transferId).first();
  return transferFromRow(row);
}

/**
 * Claim the right to move this specific money, before any rail is called.
 *
 * The guard, the partial UNIQUE index behind it, and `INSERT OR IGNORE` are
 * three answers to the same question, which is the point: whichever of two
 * concurrent workers loses simply gets `claimed: false` and moves on. No
 * exception, no retry storm, and no second movement.
 */
async function claimTransfer(env, {
  direction, amountCents, currency, provider,
  contributionId = null, reservationId = null, sponsorshipId = null, guaranteeId = null,
  requestedBy = null, now = null
}) {
  const movement = MOVEMENTS[direction];
  const subjectColumn = direction === "SWEEP" ? "contribution_id"
    : direction === "RELEASE" ? "reservation_id"
      : "guarantee_id";
  const subjectValue = direction === "SWEEP" ? contributionId
    : direction === "RELEASE" ? reservationId
      : guaranteeId;
  if (!subjectValue) {
    return { ok: false, code: "TRANSFER_SUBJECT_REQUIRED", message: `A ${direction} needs the record it is moving money for.` };
  }

  const attemptRow = await env.DB.prepare(`
    SELECT COUNT(*) AS attempts FROM pif_custody_transfers
    WHERE ${subjectColumn} = ? AND direction = ?
  `).bind(subjectValue, direction).first();
  const attempt = Number(attemptRow?.attempts || 0) + 1;

  const transferId = newId("pifxfer");
  const at = now || nowIso();
  // Attempt-scoped so a retry after a fail-closed refusal gets its own key
  // rather than colliding with the attempt that failed.
  const key = `pif_custody:${direction}:${subjectValue}:${attempt}`;

  const inserted = await env.DB.prepare(`
    INSERT OR IGNORE INTO pif_custody_transfers (
      id, direction, event_type, amount_cents, currency, state, provider,
      contribution_id, reservation_id, sponsorship_id, guarantee_id,
      idempotency_key, attempt, requested_by, requested_at, created_at, updated_at
    )
    SELECT ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM pif_custody_transfers
      WHERE ${subjectColumn} = ? AND direction = ? AND state <> 'FAILED'
    )
  `).bind(
    transferId, direction, movement.eventType, amountCents, currency, provider.id,
    contributionId, reservationId, sponsorshipId, guaranteeId,
    key, attempt, requestedBy, at, at, at,
    subjectValue, direction
  ).run();

  if (Number(inserted?.meta?.changes || 0) === 0) {
    const existing = await env.DB.prepare(`
      SELECT * FROM pif_custody_transfers
      WHERE ${subjectColumn} = ? AND direction = ? AND state <> 'FAILED' LIMIT 1
    `).bind(subjectValue, direction).first();
    return {
      ok: true,
      claimed: false,
      code: "ALREADY_CLAIMED",
      transfer: transferFromRow(existing)
    };
  }
  return { ok: true, claimed: true, transfer: await getTransfer(env, transferId) };
}

async function markFailed(env, transfer, { code, message, providerStatus = null, now = null }) {
  const at = now || nowIso();
  await env.DB.prepare(`
    UPDATE pif_custody_transfers
    SET state = 'FAILED', error_code = ?, error = ?, provider_status = ?, updated_at = ?
    WHERE id = ? AND state IN ('PENDING', 'IN_TRANSIT')
  `).bind(code, message || null, providerStatus, at, transfer.id).run();
  return { ...transfer, state: "FAILED", errorCode: code, error: message || null };
}

/**
 * Post the ledger leg for a movement.
 *
 * `leg` is one of:
 *   COMPLETED   from -> to, in one transaction, for a rail that settled now
 *   INITIATED   from -> in transit, for a rail that will settle later
 *   SETTLED     in transit -> to
 *   REVERSED    in transit -> from, when a started movement failed
 *
 * Every key is derived from the transfer id, so a redelivered webhook or a
 * retried worker posts nothing the second time.
 */
async function postMovementLeg(env, transfer, leg, { occurredAt = null, stripeEventId = null } = {}) {
  const movement = MOVEMENTS[transfer.direction];
  const lines = {
    COMPLETED: [{ account: movement.to, debit: transfer.amountCents }, { account: movement.from, credit: transfer.amountCents }],
    INITIATED: [{ account: "pif_custody_in_transit", debit: transfer.amountCents }, { account: movement.from, credit: transfer.amountCents }],
    SETTLED: [{ account: movement.to, debit: transfer.amountCents }, { account: "pif_custody_in_transit", credit: transfer.amountCents }],
    REVERSED: [{ account: movement.from, debit: transfer.amountCents }, { account: "pif_custody_in_transit", credit: transfer.amountCents }]
  }[leg];

  return postTransaction(env, {
    kind: LEDGER_KIND,
    idempotencyKey: `pif_custody:${leg.toLowerCase()}:${transfer.id}`,
    occurredAt: occurredAt || nowIso(),
    currency: transfer.currency,
    contributionId: transfer.contributionId,
    reservationId: transfer.reservationId,
    stripeEventId,
    memo: `${movement.memo} [${leg}]`,
    createdBy: "fund-custody",
    lines
  });
}

/**
 * Call the rail, then record what it said. In that order, and never the
 * other way round: the ledger is not touched until the rail has accepted the
 * movement, and the transfer is not COMPLETED until the rail says it is.
 */
async function executeTransfer(env, transfer, provider, { plan = {}, now = null } = {}) {
  const at = now || nowIso();
  const call = {
    SWEEP: () => provider.sweepContribution(env, { ...plan, transferId: transfer.id, amountCents: transfer.amountCents, currency: transfer.currency, contributionId: transfer.contributionId }),
    RELEASE: () => provider.releaseCompletedSponsorship(env, { ...plan, transferId: transfer.id, amountCents: transfer.amountCents, currency: transfer.currency, reservationId: transfer.reservationId, sponsorshipId: transfer.sponsorshipId }),
    GUARANTEE_FUNDING: () => provider.fundDepositGuarantee(env, { ...plan, transferId: transfer.id, amountCents: transfer.amountCents, currency: transfer.currency, guaranteeId: transfer.guaranteeId }),
    GUARANTEE_RETURN: () => provider.receiveGuaranteeReturn(env, { ...plan, transferId: transfer.id, amountCents: transfer.amountCents, currency: transfer.currency, guaranteeId: transfer.guaranteeId })
  }[transfer.direction];

  let outcome;
  try {
    outcome = await call();
  } catch (error) {
    outcome = { ok: false, code: "TREASURY_RAIL_ERROR", message: error?.message || "The custody rail threw." };
  }

  if (!outcome?.ok) {
    const failed = await markFailed(env, transfer, {
      code: outcome?.code || RAIL_UNAVAILABLE,
      message: outcome?.message || "The custody rail refused this movement.",
      now: at
    });
    return { ok: false, code: failed.errorCode, message: failed.error, transfer: failed };
  }

  if (outcome.state === "COMPLETED") {
    const posting = await postMovementLeg(env, transfer, "COMPLETED", { occurredAt: at });
    await env.DB.prepare(`
      UPDATE pif_custody_transfers
      SET state = 'COMPLETED', provider_object_id = ?, provider_reference = ?, provider_status = ?,
          settled_transaction_id = ?, settled_at = ?, updated_at = ?
      WHERE id = ? AND state IN ('PENDING', 'IN_TRANSIT')
    `).bind(
      outcome.providerObjectId || null, outcome.providerReference || null, outcome.providerStatus || null,
      posting.transactionId || null, at, at, transfer.id
    ).run();
    return { ok: true, state: "COMPLETED", transfer: await getTransfer(env, transfer.id), transactionId: posting.transactionId };
  }

  const posting = await postMovementLeg(env, transfer, "INITIATED", { occurredAt: at });
  await env.DB.prepare(`
    UPDATE pif_custody_transfers
    SET state = 'IN_TRANSIT', provider_object_id = ?, provider_reference = ?, provider_status = ?,
        initiated_transaction_id = ?, updated_at = ?
    WHERE id = ? AND state = 'PENDING'
  `).bind(
    outcome.providerObjectId || null, outcome.providerReference || null, outcome.providerStatus || null,
    posting.transactionId || null, at, transfer.id
  ).run();
  return { ok: true, state: "IN_TRANSIT", transfer: await getTransfer(env, transfer.id), transactionId: posting.transactionId };
}

/* ═════════════════════════════════════════════════════ the sweep worker ══ */

/**
 * Move the exact designated eligible amount into protected custody.
 *
 * Ledger-driven: the candidate list and every amount in it come from
 * postings to `fund_available`, never from a Stripe balance and never from a
 * percentage. Ordinary revenue posts to `platform_fees_unearned` and
 * `owner_platform_fee_revenue`; neither is reachable from here, which is why
 * acceptance test 4 is a property of the query rather than of a filter
 * somebody has to remember to write.
 *
 * Idempotent, retry-safe, and safe to run concurrently — see the file
 * header. Returns what moved, what was skipped and why, and what failed
 * closed, because a worker that reports only success is a worker whose
 * failures are discovered by an accountant.
 */
export async function sweepDesignatedContributions(env, options = {}) {
  if (!hasDatabase(env)) return DATABASE_REQUIRED;
  const provider = resolveCustodyProvider(env, options);
  const currency = cleanString(options.currency, 8) || "usd";
  const limit = Math.min(Math.max(Math.trunc(Number(options.limit) || 50), 1), 500);
  const now = options.now || nowIso();
  const cutoff = settlementCutoff(env, { now, settlementDelayHours: options.settlementDelayHours });
  const requestedBy = cleanString(options.actorId, 120) || "system:custody-sweep";

  const candidates = await unsweptContributions(env, { cutoff, settledOnly: true, limit });

  const swept = [];
  const inTransit = [];
  const skipped = [];
  const failed = [];

  for (const candidate of candidates) {
    if (candidate.currency !== currency) {
      skipped.push({ contributionId: candidate.contributionId, code: "CURRENCY_MISMATCH" });
      continue;
    }
    const claim = await claimTransfer(env, {
      direction: "SWEEP",
      amountCents: candidate.designatedCents,
      currency,
      provider,
      contributionId: candidate.contributionId,
      requestedBy,
      now
    });
    if (!claim.ok) {
      skipped.push({ contributionId: candidate.contributionId, code: claim.code });
      continue;
    }
    if (!claim.claimed) {
      // Another worker, or an earlier tick, already owns this money.
      skipped.push({ contributionId: candidate.contributionId, code: "ALREADY_CLAIMED", transferId: claim.transfer?.id || null });
      continue;
    }

    const result = await executeTransfer(env, claim.transfer, provider, { now });
    if (!result.ok) {
      failed.push({
        contributionId: candidate.contributionId,
        transferId: claim.transfer.id,
        amountCents: candidate.designatedCents,
        code: result.code,
        message: result.message
      });
      continue;
    }
    const record = {
      contributionId: candidate.contributionId,
      transferId: claim.transfer.id,
      amountCents: candidate.designatedCents,
      providerObjectId: result.transfer?.providerObjectId || null
    };
    if (result.state === "COMPLETED") swept.push(record); else inTransit.push(record);
  }

  const sweptCents = swept.reduce((total, row) => total + row.amountCents, 0);
  const inTransitCents = inTransit.reduce((total, row) => total + row.amountCents, 0);

  if (swept.length || inTransit.length || failed.length) {
    await recordAudit(env, {
      actorId: requestedBy,
      actorRole: "system",
      action: "pif.custody_sweep",
      subjectType: "pif_custody",
      subjectId: null,
      newState: {
        provider: provider.id,
        mode: provider.mode,
        sweptCount: swept.length,
        sweptCents,
        inTransitCount: inTransit.length,
        failedCount: failed.length
      },
      reason: "Designated Paw It Forward contribution sweep."
    });
  }

  return {
    ok: true,
    provider: provider.id,
    custodyMode: provider.mode,
    custodyProtected: Boolean(provider.protectsCash) && provider.available(env).ok,
    examined: candidates.length,
    swept,
    sweptCents,
    inTransit,
    inTransitCents,
    skipped,
    failed,
    /**
     * A fail-closed run is not an error to the caller — the money is exactly
     * where it was and the ledger still says who it belongs to — but it must
     * never read as a success either.
     */
    failedClosed: failed.some((row) => row.code === RAIL_UNAVAILABLE)
  };
}

/* ══════════════════════════════════════════ release, guarantees, webhook ══ */

/**
 * A movement that already exists for this subject.
 *
 * Checked before the sufficiency guard, not after: a replayed release of an
 * already-released sponsorship must answer "that already happened", never
 * "custody is short" — the second is true and misleading, and an operator
 * acting on it would go looking for missing money that is exactly where it
 * belongs.
 */
async function existingLiveTransfer(env, direction, subjectColumn, subjectValue) {
  const row = await env.DB.prepare(`
    SELECT * FROM pif_custody_transfers
    WHERE ${subjectColumn} = ? AND direction = ? AND state <> 'FAILED' LIMIT 1
  `).bind(subjectValue, direction).first();
  return transferFromRow(row);
}

async function requireCustodyCash(env, amountCents, direction) {
  const source = MOVEMENTS[direction].from;
  if (source !== "pif_custody_cash" && source !== "deposit_guarantee_outstanding") return { ok: true };
  const balance = await accountBalance(env, source);
  if (balance >= amountCents) return { ok: true };
  return {
    ok: false,
    code: source === "pif_custody_cash" ? "INSUFFICIENT_PROTECTED_CUSTODY" : "INSUFFICIENT_GUARANTEE_CASH",
    message: `Custody holds ${balance} cents; this movement needs ${amountCents}. Money that was never swept cannot be released.`
  };
}

/**
 * Release the earned sponsorship from protected custody — and only then.
 *
 * §3 rule 5 and §6: the $35 is not earned when it is approved, not earned
 * when it is reserved, and not earned when a clinic says the visit happened.
 * It is earned when the reservation has been verified COMPLETED and
 * consumed, which in this schema means a `sponsorships` row exists for it
 * and has not been reversed. Every other state refuses.
 *
 * The amount released is the sponsorship's own recorded amount — $10 for a
 * founding clinic, $35 for a standard one — never a constant.
 */
export async function releaseSponsorshipFromCustody(env, options = {}) {
  if (!hasDatabase(env)) return DATABASE_REQUIRED;
  const reservationId = cleanString(options.reservationId, 120);
  if (!reservationId) {
    return { ok: false, code: "RESERVATION_REQUIRED", message: "A release names the reservation whose sponsorship completed." };
  }
  const provider = resolveCustodyProvider(env, options);
  const now = options.now || nowIso();

  const row = await env.DB.prepare(`
    SELECT s.id AS sponsorship_id, s.amount_cents, s.currency, s.reversed_at,
           r.state AS reservation_state
    FROM sponsorships s
    JOIN fund_reservations r ON r.id = s.reservation_id
    WHERE s.reservation_id = ? LIMIT 1
  `).bind(reservationId).first();

  if (!row) {
    return {
      ok: false,
      code: "SPONSORSHIP_NOT_CONSUMED",
      message: "Nothing is released before a verified completed connection has consumed the reservation."
    };
  }
  if (row.reversed_at) {
    return { ok: false, code: "SPONSORSHIP_REVERSED", message: "That sponsorship was reversed; there is nothing earned to release." };
  }
  if (row.reservation_state !== "COMPLETED_CONSUMED") {
    return {
      ok: false,
      code: "SPONSORSHIP_NOT_CONSUMED",
      message: `A ${row.reservation_state} reservation has earned nothing. Release happens after consumption, never before.`
    };
  }

  const amountCents = Number(row.amount_cents || 0);
  if (amountCents <= 0) {
    return { ok: true, skipped: true, code: "NOTHING_TO_RELEASE", reservationId, amountCents: 0 };
  }
  const currency = row.currency || "usd";

  const already = await existingLiveTransfer(env, "RELEASE", "reservation_id", reservationId);
  if (already) return { ok: true, duplicate: true, code: "ALREADY_RELEASED", transfer: already };

  const sufficient = await requireCustodyCash(env, amountCents, "RELEASE");
  if (!sufficient.ok) return sufficient;

  const claim = await claimTransfer(env, {
    direction: "RELEASE",
    amountCents,
    currency,
    provider,
    reservationId,
    sponsorshipId: row.sponsorship_id,
    requestedBy: cleanString(options.actorId, 120) || "system:custody-release",
    now
  });
  if (!claim.ok) return claim;
  if (!claim.claimed) {
    return { ok: true, duplicate: true, code: "ALREADY_RELEASED", transfer: claim.transfer };
  }

  const result = await executeTransfer(env, claim.transfer, provider, { now });
  if (!result.ok) return result;

  await recordAudit(env, {
    actorId: options.actorId || null,
    actorRole: "system",
    action: "pif.custody_release",
    subjectType: "fund_reservation",
    subjectId: reservationId,
    newState: { amountCents, state: result.state, provider: provider.id },
    reason: "Verified completed sponsorship released from protected custody."
  });

  return { ok: true, state: result.state, reservationId, amountCents, transfer: result.transfer };
}

/**
 * Move guarantee float out of protected custody to a clinic (§7).
 *
 * This is the cash leg only. Whether a guarantee may exist at all, what it
 * costs the fund, and how it resolves belong to the deposit-guarantee
 * module and its `pif_deposit_guarantees` state machine; §5 puts the *rail*
 * here, which is why `fundDepositGuarantee` is one of the five provider
 * methods.
 *
 * Two sources are possible and the integrator picks one. `src/deposit-
 * guarantee.js` currently funds a guarantee straight from `processor_cash`,
 * which is coherent but takes the float from unrestricted cash rather than
 * from the protected pot; calling this instead takes it from custody through
 * the Treasury rail. Reconciliation does not assume either — it subtracts
 * what actually left custody and raises a warning naming any float funded
 * from outside it. Wire one or the other, never both, or the cash leg posts
 * twice.
 */
/**
 * Fund a deposit guarantee out of protected custody.
 *
 * ─── NOT WIRED, DELIBERATELY ────────────────────────────────────────────
 *
 * `src/deposit-guarantee.js` also funds a guarantee, from `processor_cash`,
 * and that is the path the routes call today. Both are correct descriptions
 * of the same event — program money leaving for a clinic — and running both
 * would post the cash leg twice, which is the one arithmetic error this
 * subledger exists to make impossible.
 *
 * Which one is right depends on where the money physically sits. Until a
 * Stripe Treasury financial account is enabled for ClearKey, designated cash
 * is still in Payments and the guarantee module's posting is the true one.
 * When Treasury goes live, switch the guarantee module's funding call to this
 * function in the same change that enables the rail — never leave both
 * reachable. scripts/validate.mjs enforces that only one is mounted.
 */
export async function fundGuaranteeFromCustody(env, options = {}) {
  return guaranteeMovement(env, options, "GUARANTEE_FUNDING");
}

/** The other half of §7: the clinic returns the float to protected custody. */
export async function returnGuaranteeToCustody(env, options = {}) {
  return guaranteeMovement(env, options, "GUARANTEE_RETURN");
}

async function guaranteeMovement(env, options, direction) {
  if (!hasDatabase(env)) return DATABASE_REQUIRED;
  const guaranteeId = cleanString(options.guaranteeId, 120);
  const amountCents = cents(options.amountCents);
  if (!guaranteeId) return { ok: false, code: "GUARANTEE_REQUIRED", message: "A guarantee movement names its guarantee." };
  if (amountCents === null || amountCents <= 0) {
    return { ok: false, code: "INVALID_AMOUNT", message: "A guarantee movement is whole cents above zero." };
  }
  const provider = resolveCustodyProvider(env, options);
  const currency = cleanString(options.currency, 8) || "usd";
  const now = options.now || nowIso();

  const already = await existingLiveTransfer(env, direction, "guarantee_id", guaranteeId);
  if (already) return { ok: true, duplicate: true, code: "ALREADY_MOVED", transfer: already };

  const sufficient = await requireCustodyCash(env, amountCents, direction);
  if (!sufficient.ok) return sufficient;

  const claim = await claimTransfer(env, {
    direction,
    amountCents,
    currency,
    provider,
    guaranteeId,
    requestedBy: cleanString(options.actorId, 120) || "system:custody-guarantee",
    now
  });
  if (!claim.ok) return claim;
  if (!claim.claimed) return { ok: true, duplicate: true, code: "ALREADY_MOVED", transfer: claim.transfer };

  const result = await executeTransfer(env, claim.transfer, provider, {
    now,
    plan: {
      destinationPaymentMethod: options.destinationPaymentMethod || null,
      originPaymentMethod: options.originPaymentMethod || null
    }
  });
  if (!result.ok) return result;
  return { ok: true, state: result.state, guaranteeId, amountCents, transfer: result.transfer };
}

/**
 * Finish a movement the rail settled asynchronously.
 *
 * Webhook-reconciled, as §5 asks. The state change is a compare-and-swap on
 * IN_TRANSIT and the ledger key is derived from the transfer id, so a
 * redelivered event a day later changes nothing. A failure reverses the
 * in-transit leg rather than deleting it: "we tried and it did not settle"
 * is a fact worth keeping.
 */
export async function applyCustodyWebhook(env, event) {
  if (!hasDatabase(env)) return DATABASE_REQUIRED;
  const type = cleanString(event?.type, 80);
  const objectId = cleanString(event?.data?.object?.id, 120);
  if (!type || !objectId) return { ok: true, handled: false, code: "NOT_A_CUSTODY_EVENT" };

  const settledTypes = new Set([
    "payout.paid",
    "treasury.outbound_payment.posted",
    "treasury.inbound_transfer.succeeded"
  ]);
  const failedTypes = new Set([
    "payout.failed", "payout.canceled",
    "treasury.outbound_payment.failed", "treasury.outbound_payment.canceled", "treasury.outbound_payment.returned",
    "treasury.inbound_transfer.failed", "treasury.inbound_transfer.canceled"
  ]);
  if (!settledTypes.has(type) && !failedTypes.has(type)) {
    return { ok: true, handled: false, code: "NOT_A_CUSTODY_EVENT" };
  }

  const transfer = transferFromRow(await env.DB.prepare(
    "SELECT * FROM pif_custody_transfers WHERE provider_object_id = ? LIMIT 1"
  ).bind(objectId).first());
  if (!transfer) return { ok: true, handled: false, code: "TRANSFER_NOT_FOUND", objectId };
  if (transfer.state === "COMPLETED" || transfer.state === "FAILED") {
    return { ok: true, handled: true, duplicate: true, transferId: transfer.id, state: transfer.state };
  }

  const at = nowIso();
  if (settledTypes.has(type)) {
    const posting = await postMovementLeg(env, transfer, "SETTLED", { occurredAt: at, stripeEventId: event?.id || null });
    await env.DB.prepare(`
      UPDATE pif_custody_transfers
      SET state = 'COMPLETED', provider_status = ?, settled_transaction_id = ?, settled_at = ?, updated_at = ?
      WHERE id = ? AND state = 'IN_TRANSIT'
    `).bind(type, posting.transactionId || null, at, at, transfer.id).run();
    return { ok: true, handled: true, transferId: transfer.id, state: "COMPLETED" };
  }

  await postMovementLeg(env, transfer, "REVERSED", { occurredAt: at, stripeEventId: event?.id || null });
  await env.DB.prepare(`
    UPDATE pif_custody_transfers
    SET state = 'FAILED', error_code = 'RAIL_REPORTED_FAILURE', error = ?, provider_status = ?, updated_at = ?
    WHERE id = ? AND state = 'IN_TRANSIT'
  `).bind(`The custody rail reported ${type}.`, type, at, transfer.id).run();
  return { ok: true, handled: true, transferId: transfer.id, state: "FAILED" };
}

/* ------------------------------------------------------------ reading --- */

export async function listCustodyTransfers(env, { direction = null, state = null, limit = 100 } = {}) {
  if (!hasDatabase(env)) return { transfers: [] };
  const clauses = [];
  const values = [];
  if (direction) { clauses.push("direction = ?"); values.push(direction); }
  if (state) { clauses.push("state = ?"); values.push(state); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await env.DB.prepare(`
    SELECT * FROM pif_custody_transfers ${where}
    ORDER BY requested_at DESC LIMIT ?
  `).bind(...values, Math.min(Math.max(Math.trunc(Number(limit) || 100), 1), 500)).all();
  return { transfers: result.results.map(transferFromRow) };
}

/** The provider's own view of custody, for the console and reconciliation. */
export async function custodyBalance(env, options = {}) {
  const provider = resolveCustodyProvider(env, options);
  const balance = await provider.getCustodyBalance(env, { currency: options.currency || "usd" });
  return { ...balance, provider: provider.id, custodyMode: provider.mode };
}

/* ------------------------------------------------------------ handlers --- */

/** GET /api/admin/pif/custody — designation, protection, and the rail's balance. */
export async function handleCustodyStatus(request, env) {
  if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", "Use GET to read custody status.");
  const status = await designationStatus(env);
  if (!status.ok) return apiError(503, status.code, status.message);
  const balance = await custodyBalance(env);
  return json({
    custody: status,
    rail: balance.ok
      ? { ok: true, balanceCents: balance.balanceCents, currency: balance.currency, provider: balance.provider, mode: balance.custodyMode }
      : { ok: false, code: balance.code, message: balance.message, provider: balance.provider, mode: balance.custodyMode }
  });
}

/** POST /api/admin/pif/custody/sweep — run the sweep now. */
export async function handleCustodySweep(request, env, actor) {
  if (request.method !== "POST") return apiError(405, "METHOD_NOT_ALLOWED", "Use POST to run the sweep.");
  const body = await request.json().catch(() => ({}));
  const result = await sweepDesignatedContributions(env, {
    limit: body?.limit,
    actorId: actor?.userId || null
  });
  if (!result.ok) return apiError(503, result.code, result.message);
  // A run that could not reach the rail is reported as 200 with the failures
  // named: nothing moved, nothing is claimed to have moved, and the operator
  // sees which rail refused.
  return json({ sweep: result });
}

/** GET /api/admin/pif/custody/transfers — the movement journal. */
export async function handleCustodyTransfers(request, env) {
  if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", "Use GET to list custody transfers.");
  const url = new URL(request.url);
  return json(await listCustodyTransfers(env, {
    direction: url.searchParams.get("direction"),
    state: url.searchParams.get("state"),
    limit: url.searchParams.get("limit")
  }));
}

/**
 * The cron entry point. Safe to run every few minutes: a tick with nothing
 * to sweep does one query and stops, and two ticks that overlap cannot move
 * the same money twice.
 */
export async function custodySweepTick(env) {
  if (!hasDatabase(env)) return DATABASE_REQUIRED;
  const result = await sweepDesignatedContributions(env, { actorId: "system:cron" });
  console.log(JSON.stringify({
    event: "pif_custody_sweep",
    provider: result.provider,
    mode: result.custodyMode,
    examined: result.examined,
    swept: result.swept?.length || 0,
    sweptCents: result.sweptCents || 0,
    inTransit: result.inTransit?.length || 0,
    failed: result.failed?.length || 0,
    failedClosed: Boolean(result.failedClosed)
  }));
  return result;
}
