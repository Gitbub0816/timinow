/**
 * The Paw It Forward appointment deposit guarantee.
 *
 * A clinic requires $75 to hold an appointment. A household that cannot find
 * $75 today does not get seen today. So the program fronts it, the customer
 * attends, and the clinic returns the $75 to the program. That is the whole
 * idea, and every rule in this file exists to keep it from quietly becoming
 * something else.
 *
 * ─────────────────────────────────────────── what it is, and is not (§7) ──
 *
 * The guarantee is **temporary program float**. It is not treatment
 * assistance, not a copayment, not an insurance payment, and it does not
 * reduce anybody's veterinary bill. The customer remains responsible for the
 * full bill; the clinic accounts for the guarantee separately.
 *
 * The executed agreement §15 says it in the clinic's own words: "Clinic shall
 * not both retain or apply the guarantee as payment for veterinary services
 * and collect the same amount from the Customer, insurer, financing source,
 * or other payer." `recordClinicBillSettlement` below turns that sentence
 * into arithmetic, and `settleDepositGuarantee` refuses the transition that
 * would let a refused settlement resolve anyway. A rule enforced only by
 * everyone remembering it is not enforced.
 *
 * ────────────────────────────────────────────────── the money discipline ──
 *
 * Reserve before promising (§9 rule 2), and never beyond available program
 * cash (rule 3). The reservation is written the way `reserveSponsorship` in
 * src/fund.js writes its own: the decision *is* the write. One
 * `INSERT ... SELECT ... WHERE` carries the pause flag, the duplicate guard
 * and the cash test in its WHERE clause, so two concurrent bookings cannot
 * both commit the same dollar. Reading a balance and then writing cannot
 * give that, because both readers see the same balance.
 *
 * The guarantee reservation is separate from the $35 sponsorship reservation
 * (§9 rule 4). One booking can hold both: they are different money for
 * different purposes, and netting them would make a $75 float look like
 * sponsorship spending.
 *
 * ─────────────────────────────────────────────────────────── postings ──
 *
 *   reserved   Dr fund_available                  Cr fund_deposit_guarantee_reserved
 *   released   Dr fund_deposit_guarantee_reserved Cr fund_available
 *   funded     Dr deposit_guarantee_outstanding   Cr processor_cash
 *   returned   Dr processor_cash                  Cr deposit_guarantee_outstanding
 *              Dr fund_deposit_guarantee_reserved Cr fund_available
 *   forfeited  Dr deposit_guarantee_forfeiture_expense Cr deposit_guarantee_outstanding
 *              Dr fund_deposit_guarantee_reserved      Cr program_restricted_released
 *
 * The forfeiture pair is the one worth reading twice. A forfeiture is a real
 * program expense (§7), so it is booked as an expense rather than netted
 * against anything; the restricted contribution that funded it is released
 * in the same transaction, because that money has now genuinely been spent
 * and continuing to show it as available would be a lie about the fund.
 *
 * See migrations/0018 for why these post under existing
 * `ledger_transactions.kind` values while `pif_deposit_guarantee_events`
 * carries the addendum §6 event name.
 */

import { hasDatabase } from "./db.js";
import { postTransaction, recordAudit } from "./ledger.js";
import { currentDepositPolicy, depositPolicyById, getBookingDepositSnapshot, formatMoney } from "./deposit-policy.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function json(data, init = {}) {
  return new Response(JSON.stringify(data), { ...init, headers: { ...JSON_HEADERS, ...(init.headers || {}) } });
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

function text(value, maxLength = 240) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cents(value) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? number : 0;
}

async function readJson(request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 32_768) throw new Error("PAYLOAD_TOO_LARGE");
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new Error("JSON_REQUIRED");
  }
  return request.json();
}

const DATABASE_REQUIRED = Object.freeze({
  ok: false,
  status: 503,
  code: "DATABASE_REQUIRED",
  message: "D1 is required for deposit guarantees."
});

/* ═══════════════════════════════════════════════════ the state machine ═══ */

/** §9, verbatim. */
export const GUARANTEE_STATES = Object.freeze([
  "NOT_APPLICABLE",
  "ELIGIBLE",
  "RESERVED",
  "FUNDING_PENDING",
  "FUNDED",
  "RETURN_DUE",
  "RETURN_PENDING",
  "RETURNED",
  "PARTIAL_FORFEITURE",
  "FORFEITED",
  "DISPUTED",
  "FAILED",
  "CANCELED"
]);

/** States in which the guarantee still holds a claim on program cash. */
export const LIVE_STATES = Object.freeze([
  "ELIGIBLE", "RESERVED", "FUNDING_PENDING", "FUNDED", "RETURN_DUE", "RETURN_PENDING", "DISPUTED"
]);

/** States that are the end of the story. */
export const TERMINAL_STATES = Object.freeze([
  "NOT_APPLICABLE", "RETURNED", "PARTIAL_FORFEITURE", "FORFEITED", "FAILED", "CANCELED"
]);

/**
 * Which transitions exist at all. Anything not listed is refused with
 * INVALID_TRANSITION rather than silently tolerated — a guarantee that can
 * reach RETURNED from FORFEITED is acceptance test 24 waiting to fail.
 */
export const ALLOWED_TRANSITIONS = Object.freeze({
  NOT_APPLICABLE: Object.freeze([]),
  ELIGIBLE: Object.freeze(["RESERVED", "CANCELED", "NOT_APPLICABLE"]),
  RESERVED: Object.freeze(["FUNDING_PENDING", "FUNDED", "CANCELED", "FAILED", "DISPUTED"]),
  FUNDING_PENDING: Object.freeze(["FUNDED", "FAILED", "DISPUTED"]),
  FUNDED: Object.freeze(["RETURN_DUE", "DISPUTED"]),
  RETURN_DUE: Object.freeze(["RETURN_PENDING", "RETURNED", "PARTIAL_FORFEITURE", "FORFEITED", "DISPUTED"]),
  RETURN_PENDING: Object.freeze(["RETURNED", "PARTIAL_FORFEITURE", "FORFEITED", "DISPUTED", "FAILED"]),
  // Terminal. A correction is a compensating entry and a new record, never a
  // second life for a resolved guarantee.
  RETURNED: Object.freeze([]),
  PARTIAL_FORFEITURE: Object.freeze([]),
  FORFEITED: Object.freeze([]),
  // A dispute freezes final accounting (§9 rule 9); resolving it puts the
  // guarantee back where it was and lets the ordinary rules decide.
  DISPUTED: Object.freeze(["RESERVED", "FUNDING_PENDING", "FUNDED", "RETURN_DUE", "RETURN_PENDING", "CANCELED"]),
  FAILED: Object.freeze([]),
  CANCELED: Object.freeze([])
});

/** Appointment outcomes this file knows how to price. */
export const APPOINTMENT_OUTCOMES = Object.freeze([
  "ATTENDED", "COMPLETED", "CLINIC_CANCELED", "CUSTOMER_CANCELED", "LATE_CANCELED", "NO_SHOW"
]);

/**
 * Deposit kinds that are explicitly *not* this feature.
 *
 * §7, last block: "Do not automatically cover hospitalization, surgery,
 * emergency-treatment, treatment-plan, or post-evaluation deposits." The
 * contract says the same at §15: "A treatment or hospitalization deposit is
 * excluded unless ClearKey separately authorizes that specific use."
 */
export const OUT_OF_SCOPE_DEPOSIT_KINDS = Object.freeze([
  "TREATMENT", "TREATMENT_PLAN", "HOSPITALIZATION", "SURGERY",
  "EMERGENCY_TREATMENT", "POST_EVALUATION", "DIAGNOSTIC_PLAN", "BOARDING"
]);

/* ═══════════════════════════════════════════════════════════ row shape ═══ */

function guaranteeFromRow(row) {
  if (!row) return null;
  const amount = Number(row.amount_cents || 0);
  const returned = Number(row.returned_amount_cents || 0);
  const forfeited = Number(row.forfeited_amount_cents || 0);
  return {
    id: row.id,
    intakeId: row.intake_id,
    bookingId: row.intake_id,
    clinicId: row.clinic_id,
    customerId: row.customer_id,
    amountCents: amount,
    currency: row.currency || "usd",
    policySnapshotId: row.policy_snapshot_id,
    bookingSnapshotId: row.booking_snapshot_id,
    depositKind: row.deposit_kind,
    state: row.state,
    stateBeforeDispute: row.state_before_dispute,
    returnReason: row.return_reason,
    returnedAmountCents: returned,
    forfeitedAmountCents: forfeited,
    forfeitureReason: row.forfeiture_reason,
    permittedForfeitureCents: Number(row.permitted_forfeiture_cents || 0),
    unresolvedCents: amount - returned - forfeited,
    clinicPaymentReference: row.clinic_payment_reference,
    stripeTransferReference: row.stripe_transfer_reference,
    treatmentAuthorizationId: row.treatment_authorization_id,
    treatmentAuthorizedBy: row.treatment_authorized_by,
    treatmentAuthorizedAt: row.treatment_authorized_at,
    appliedToTreatmentCents: Number(row.applied_to_treatment_cents || 0),
    reservedAt: row.reserved_at,
    fundedAt: row.funded_at,
    returnDueAt: row.return_due_at,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** One guarantee, by id. */
export async function getDepositGuarantee(env, guaranteeId) {
  if (!hasDatabase(env) || !guaranteeId) return null;
  const row = await env.DB.prepare("SELECT * FROM pif_deposit_guarantees WHERE id = ? LIMIT 1")
    .bind(guaranteeId).first();
  return guaranteeFromRow(row);
}

/** The live guarantee for a booking, if there is one. */
export async function getDepositGuaranteeForBooking(env, intakeId) {
  if (!hasDatabase(env) || !intakeId) return null;
  const row = await env.DB.prepare(
    "SELECT * FROM pif_deposit_guarantees WHERE intake_id = ? ORDER BY datetime(created_at) DESC LIMIT 1"
  ).bind(intakeId).first();
  return guaranteeFromRow(row);
}

/** The append-only transition journal for one guarantee. */
export async function listDepositGuaranteeEvents(env, guaranteeId) {
  if (!hasDatabase(env) || !guaranteeId) return [];
  const result = await env.DB.prepare(
    "SELECT * FROM pif_deposit_guarantee_events WHERE guarantee_id = ? ORDER BY sequence ASC"
  ).bind(guaranteeId).all();
  return result.results.map((row) => ({
    id: row.id,
    guaranteeId: row.guarantee_id,
    sequence: Number(row.sequence),
    fromState: row.from_state,
    toState: row.to_state,
    ledgerEvent: row.ledger_event,
    ledgerTransactionId: row.ledger_transaction_id,
    amountCents: Number(row.amount_cents || 0),
    reason: row.reason,
    actorId: row.actor_id,
    actorRole: row.actor_role,
    detail: row.detail_json ? JSON.parse(row.detail_json) : null,
    occurredAt: row.occurred_at
  }));
}

async function appendEvent(env, {
  guaranteeId, fromState, toState, ledgerEvent = null, ledgerTransactionId = null,
  amountCents = 0, reason = null, actorId = null, actorRole = "system", detail = null
}) {
  const id = newId("dge");
  await env.DB.prepare(`
    INSERT INTO pif_deposit_guarantee_events (
      id, guarantee_id, sequence, from_state, to_state, ledger_event, ledger_transaction_id,
      amount_cents, reason, actor_id, actor_role, detail_json, occurred_at
    )
    SELECT ?, ?, COALESCE((SELECT MAX(sequence) FROM pif_deposit_guarantee_events WHERE guarantee_id = ?), 0) + 1,
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  `).bind(
    id, guaranteeId, guaranteeId, fromState, toState, ledgerEvent, ledgerTransactionId,
    Math.max(0, cents(amountCents)), reason, actorId, actorRole,
    detail ? JSON.stringify(detail) : null, nowIso()
  ).run();
  return id;
}

async function recordRefusal(env, { intakeId, tenantId, requestedDepositKind, requestedAmountCents, code, message, actorId }) {
  if (!hasDatabase(env)) return null;
  const id = newId("dgref");
  await env.DB.prepare(`
    INSERT INTO pif_deposit_guarantee_refusals (
      id, intake_id, tenant_id, requested_deposit_kind, requested_amount_cents, code, message, actor_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, intakeId || null, tenantId || null, requestedDepositKind, Math.max(0, cents(requestedAmountCents)),
    code, message, actorId || null
  ).run();
  return id;
}

/* ═══════════════════════════════════════════════════════ eligibility ═══ */

/**
 * Does this booking get a guarantee at all, and for how much?
 *
 * Answers without moving anything, so a booking flow can ask before it
 * promises. Three ways to be refused, all of them explicit:
 *
 *   * the deposit is not an appointment deposit (§7 treatment deposits);
 *   * the clinic's election is not PAW_IT_FORWARD_GUARANTEE (§9 rule 1) —
 *     including CUSTOMER_REQUIRED, which is acceptance test 18: the program
 *     never spends its cash on a deposit the clinic did not agree to accept
 *     as a guarantee;
 *   * nobody knows the amount yet.
 */
export async function evaluateDepositGuaranteeEligibility(env, {
  intakeId, tenantId = null, depositKind = "APPOINTMENT", amountCents = null, sponsored = true
} = {}) {
  const kind = (text(depositKind, 40) || "APPOINTMENT").toUpperCase();
  if (kind !== "APPOINTMENT") {
    const outOfScope = OUT_OF_SCOPE_DEPOSIT_KINDS.includes(kind);
    return {
      ok: false,
      status: 422,
      state: "NOT_APPLICABLE",
      code: outOfScope ? "TREATMENT_DEPOSIT_OUT_OF_SCOPE" : "UNSUPPORTED_DEPOSIT_KIND",
      message: outOfScope
        ? `Paw It Forward guarantees appointment and reservation deposits only. A ${kind.toLowerCase().replaceAll("_", " ")} deposit is outside this feature (§7) and outside the clinic agreement §15 unless ClearKey separately authorizes that specific use.`
        : `Unknown deposit kind "${kind}".`,
      depositKind: kind
    };
  }

  const snapshot = await getBookingDepositSnapshot(env, intakeId);
  const policy = snapshot?.policy || await currentDepositPolicy(env, tenantId);
  if (!policy) {
    return {
      ok: false, status: 422, state: "NOT_APPLICABLE", code: "NO_DEPOSIT_POLICY",
      message: "This clinic has no recorded Paw It Forward appointment deposit policy, so nothing can be guaranteed."
    };
  }
  if (policy.election !== "PAW_IT_FORWARD_GUARANTEE") {
    return {
      ok: false, status: 422, state: "NOT_APPLICABLE", code: "ELECTION_DOES_NOT_CREATE_GUARANTEE",
      message: `Only "Accept Paw It Forward deposit guarantee" creates a guarantee; this clinic's election is "${policy.electionLabel}".`,
      election: policy.election
    };
  }
  if (!sponsored) {
    return {
      ok: false, status: 422, state: "NOT_APPLICABLE", code: "BOOKING_NOT_SPONSORED",
      message: "A deposit guarantee attaches to a qualifying Paw It Forward booking."
    };
  }

  const determined = amountCents === null || amountCents === undefined
    ? (policy.appointmentDepositAmountType === "FIXED" ? policy.appointmentDepositFixedAmountCents : null)
    : cents(amountCents);
  if (!determined || determined <= 0) {
    return {
      ok: false, status: 422, state: "ELIGIBLE", code: "GUARANTEE_AMOUNT_NOT_DETERMINABLE",
      message: "The clinic must confirm the deposit amount before Paw It Forward can fund a guarantee (§8).",
      election: policy.election
    };
  }
  const limit = policy.depositGuaranteeLimitCents;
  if (typeof limit === "number" && determined > limit) {
    return {
      ok: false, status: 422, state: "ELIGIBLE", code: "GUARANTEE_LIMIT_EXCEEDED",
      message: `${formatMoney(determined, policy.currency)} exceeds this clinic's ${formatMoney(limit, policy.currency)} guarantee limit.`,
      amountCents: determined, limitCents: limit
    };
  }

  return {
    ok: true,
    state: "ELIGIBLE",
    amountCents: determined,
    currency: policy.currency || "usd",
    policyId: policy.id,
    bookingSnapshotId: snapshot?.id || null,
    election: policy.election
  };
}

/* ══════════════════════════════════════════════════════════ reserving ═══ */

/**
 * Commit program cash to a guarantee, atomically (§9 rules 2 and 3).
 *
 * The WHERE clause is the decision. It refuses when assistance is paused,
 * when this booking already has a live guarantee, and — the one that matters
 * — when the amount would take the fund below its liquidity floor once every
 * reservation that exists but has not yet posted is counted. That last term
 * is what closes the window between this INSERT and the posting below: a
 * concurrent caller sees this row and cannot spend the same money.
 *
 * The $35 sponsorship reservation is subtracted too, and vice versa in
 * src/fund.js, because both draw on the same `fund_available` and neither
 * may pretend the other does not exist.
 *
 * Refuses rather than overspends. Always.
 */
export async function reserveDepositGuarantee(env, {
  intakeId,
  tenantId = null,
  customerUserId = null,
  amountCents = null,
  depositKind = "APPOINTMENT",
  sponsored = true,
  actorId = null,
  reason = null
} = {}) {
  if (!hasDatabase(env)) return DATABASE_REQUIRED;
  const intake = text(intakeId, 120);
  if (!intake) return { ok: false, status: 400, code: "INTAKE_REQUIRED", message: "A guarantee belongs to a booking." };

  const eligibility = await evaluateDepositGuaranteeEligibility(env, {
    intakeId: intake, tenantId, depositKind, amountCents, sponsored
  });
  if (!eligibility.ok) {
    // Out-of-scope asks are written down rather than merely refused: how
    // often clinics ask for a surgery deposit is the number that decides
    // whether the separate treatment-assistance feature §7 contemplates is
    // ever worth building.
    if (eligibility.code === "TREATMENT_DEPOSIT_OUT_OF_SCOPE" || eligibility.code === "UNSUPPORTED_DEPOSIT_KIND") {
      await recordRefusal(env, {
        intakeId: intake, tenantId, requestedDepositKind: eligibility.depositKind,
        requestedAmountCents: amountCents, code: eligibility.code, message: eligibility.message, actorId
      });
    }
    return eligibility;
  }

  const amount = eligibility.amountCents;
  const id = newId("dgar");
  const reservedAt = nowIso();

  const insert = await env.DB.prepare(`
    INSERT INTO pif_deposit_guarantees (
      id, intake_id, clinic_id, customer_id, amount_cents, currency,
      policy_snapshot_id, booking_snapshot_id, deposit_kind, state,
      reserved_at, created_at, updated_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'APPOINTMENT', 'RESERVED', ?, ?, ?
    WHERE (SELECT assistance_paused FROM fund_controls WHERE id = 1) = 0
      AND NOT EXISTS (
        SELECT 1 FROM pif_deposit_guarantees
         WHERE intake_id = ?
           AND state IN ('ELIGIBLE', 'RESERVED', 'FUNDING_PENDING', 'FUNDED', 'RETURN_DUE', 'RETURN_PENDING', 'DISPUTED')
      )
      AND ? <= (
        (SELECT COALESCE(SUM(credit_cents), 0) - COALESCE(SUM(debit_cents), 0)
           FROM ledger_entries WHERE account_code = 'fund_available')
        - (SELECT COALESCE(SUM(r.amount_cents), 0) FROM fund_reservations r
            WHERE r.state = 'RESERVED'
              AND NOT EXISTS (SELECT 1 FROM ledger_transactions t
                               WHERE t.reservation_id = r.id AND t.kind = 'sponsorship_reserved'))
        - (SELECT COALESCE(SUM(g.amount_cents), 0) FROM pif_deposit_guarantees g
            WHERE g.state IN ('RESERVED', 'FUNDING_PENDING', 'FUNDED', 'RETURN_DUE', 'RETURN_PENDING', 'DISPUTED')
              AND NOT EXISTS (SELECT 1 FROM pif_deposit_guarantee_events e
                               WHERE e.guarantee_id = g.id AND e.ledger_event = 'DEPOSIT_GUARANTEE_RESERVED'))
        - (SELECT min_liquidity_reserve_cents FROM fund_controls WHERE id = 1)
      )
  `).bind(
    id, intake, tenantId || null, customerUserId || null, amount, eligibility.currency,
    eligibility.policyId, eligibility.bookingSnapshotId, reservedAt, reservedAt, reservedAt,
    intake,
    amount
  ).run();

  if (Number(insert?.meta?.changes || 0) === 0) {
    const existing = await env.DB.prepare(`
      SELECT * FROM pif_deposit_guarantees
       WHERE intake_id = ?
         AND state IN ('ELIGIBLE', 'RESERVED', 'FUNDING_PENDING', 'FUNDED', 'RETURN_DUE', 'RETURN_PENDING', 'DISPUTED')
       LIMIT 1
    `).bind(intake).first();
    if (existing) {
      return { ok: true, duplicate: true, guarantee: guaranteeFromRow(existing), reason: "ALREADY_RESERVED" };
    }
    const paused = await env.DB.prepare("SELECT assistance_paused FROM fund_controls WHERE id = 1").first();
    return Number(paused?.assistance_paused || 0) === 1
      ? { ok: false, status: 409, code: "ASSISTANCE_PAUSED", message: "Paw It Forward assistance is temporarily unavailable." }
      : {
          ok: false, status: 409, code: "INSUFFICIENT_FUND_BALANCE",
          message: "Paw It Forward does not have the available cash to guarantee this deposit.",
          requiredCents: amount
        };
  }

  const posting = await postTransaction(env, {
    kind: "adjustment",
    idempotencyKey: `deposit_guarantee_reserved:${id}`,
    occurredAt: reservedAt,
    currency: eligibility.currency,
    reservationId: id,
    intakeId: intake,
    tenantId: tenantId || null,
    memo: "DEPOSIT_GUARANTEE_RESERVED — appointment deposit guarantee committed. Not revenue, not treatment payment.",
    lines: [
      { account: "fund_available", debit: amount },
      { account: "fund_deposit_guarantee_reserved", credit: amount }
    ]
  });

  await appendEvent(env, {
    guaranteeId: id,
    fromState: null,
    toState: "RESERVED",
    ledgerEvent: "DEPOSIT_GUARANTEE_RESERVED",
    ledgerTransactionId: posting.transactionId,
    amountCents: amount,
    reason: reason || "Guarantee reserved for a qualifying Paw It Forward booking.",
    actorId,
    detail: { policyId: eligibility.policyId, bookingSnapshotId: eligibility.bookingSnapshotId }
  });

  await recordAudit(env, {
    actorId,
    actorRole: "system",
    action: "deposit_guarantee.reserved",
    subjectType: "pif_deposit_guarantee",
    subjectId: id,
    newState: { state: "RESERVED", amountCents: amount, intakeId: intake, tenantId },
    reason: "Appointment deposit guarantee reserved."
  });

  return { ok: true, duplicate: false, guarantee: await getDepositGuarantee(env, id), transactionId: posting.transactionId };
}

/* ═════════════════════════════════════════════════ transition plumbing ═══ */

/**
 * Compare-and-swap one guarantee from a known state to a new one.
 *
 * The UPDATE carries `state = ?` in its WHERE, so a second delivery of the
 * same instruction changes zero rows and is reported as a duplicate rather
 * than posting a second time.
 */
async function transition(env, { guarantee, toState, patch = {}, ledgerEvent = null, ledgerTransactionId = null, amountCents = 0, reason = null, actorId = null, detail = null }) {
  const from = guarantee.state;
  const allowed = ALLOWED_TRANSITIONS[from] || [];
  if (!allowed.includes(toState)) {
    return {
      ok: false, status: 409, code: "INVALID_TRANSITION",
      message: `A ${from} deposit guarantee cannot become ${toState}.`,
      fromState: from, toState
    };
  }
  const columns = Object.keys(patch);
  const assignments = ["state = ?", "updated_at = ?", ...columns.map((column) => `${column} = ?`)];
  const values = [toState, nowIso(), ...columns.map((column) => patch[column])];
  const result = await env.DB.prepare(
    `UPDATE pif_deposit_guarantees SET ${assignments.join(", ")} WHERE id = ? AND state = ?`
  ).bind(...values, guarantee.id, from).run();
  if (Number(result?.meta?.changes || 0) === 0) {
    const current = await getDepositGuarantee(env, guarantee.id);
    return {
      ok: false, status: 409, code: "STATE_CHANGED",
      message: `The guarantee moved to ${current?.state} before this transition could apply.`,
      guarantee: current
    };
  }
  await appendEvent(env, {
    guaranteeId: guarantee.id, fromState: from, toState, ledgerEvent, ledgerTransactionId,
    amountCents, reason, actorId, detail
  });
  return { ok: true, guarantee: await getDepositGuarantee(env, guarantee.id) };
}

async function loadGuarantee(env, guaranteeId) {
  const guarantee = await getDepositGuarantee(env, guaranteeId);
  if (!guarantee) {
    return { error: { ok: false, status: 404, code: "GUARANTEE_NOT_FOUND", message: "That deposit guarantee does not exist." } };
  }
  return { guarantee };
}

/* ══════════════════════════════════════════════════════════ funding ═══ */

/** RESERVED → FUNDING_PENDING. The transfer is in flight; no cash has moved. */
export async function beginDepositGuaranteeFunding(env, { guaranteeId, stripeTransferReference = null, actorId = null } = {}) {
  if (!hasDatabase(env)) return DATABASE_REQUIRED;
  const { guarantee, error } = await loadGuarantee(env, guaranteeId);
  if (error) return error;
  return transition(env, {
    guarantee,
    toState: "FUNDING_PENDING",
    patch: { stripe_transfer_reference: text(stripeTransferReference, 120) || guarantee.stripeTransferReference || null },
    amountCents: guarantee.amountCents,
    reason: "Guarantee transfer initiated.",
    actorId
  });
}

/**
 * The clinic has the money: RESERVED or FUNDING_PENDING → FUNDED.
 *
 * Program cash leaves for the clinic. It is still program cash — it becomes
 * an asset sitting at the clinic, not a payment toward anything — which is
 * why it debits `deposit_guarantee_outstanding` and not an expense.
 */
export async function markDepositGuaranteeFunded(env, {
  guaranteeId, stripeTransferReference = null, clinicPaymentReference = null, occurredAt = null, actorId = null
} = {}) {
  if (!hasDatabase(env)) return DATABASE_REQUIRED;
  const { guarantee, error } = await loadGuarantee(env, guaranteeId);
  if (error) return error;
  if (guarantee.state === "FUNDED") {
    return { ok: true, duplicate: true, guarantee };
  }
  const fundedAt = occurredAt || nowIso();
  const posting = await postTransaction(env, {
    kind: "clinic_deposit_collected",
    idempotencyKey: `deposit_guarantee_funded:${guarantee.id}`,
    occurredAt: fundedAt,
    currency: guarantee.currency,
    reservationId: guarantee.id,
    intakeId: guarantee.intakeId,
    tenantId: guarantee.clinicId,
    memo: "DEPOSIT_GUARANTEE_FUNDED — program cash placed with the clinic as an appointment deposit guarantee. Returnable; not a payment toward veterinary services.",
    lines: [
      { account: "deposit_guarantee_outstanding", debit: guarantee.amountCents },
      { account: "processor_cash", credit: guarantee.amountCents }
    ]
  });
  return transition(env, {
    guarantee,
    toState: "FUNDED",
    patch: {
      funded_at: fundedAt,
      stripe_transfer_reference: text(stripeTransferReference, 120) || guarantee.stripeTransferReference || null,
      clinic_payment_reference: text(clinicPaymentReference, 120) || guarantee.clinicPaymentReference || null
    },
    ledgerEvent: "DEPOSIT_GUARANTEE_FUNDED",
    ledgerTransactionId: posting.transactionId,
    amountCents: guarantee.amountCents,
    reason: "Guarantee funded to the clinic.",
    actorId
  });
}

/** The transfer failed. The reservation goes back to the fund; nobody was promised anything that stuck. */
export async function failDepositGuarantee(env, { guaranteeId, reason, actorId = null } = {}) {
  if (!hasDatabase(env)) return DATABASE_REQUIRED;
  const { guarantee, error } = await loadGuarantee(env, guaranteeId);
  if (error) return error;
  if (guarantee.state === "FUNDED" || guarantee.state === "RETURN_DUE" || guarantee.state === "RETURN_PENDING") {
    return { ok: false, status: 409, code: "ALREADY_FUNDED", message: "Money already left; this is a return or a forfeiture, not a funding failure." };
  }
  const posting = await releaseReservation(env, guarantee, `deposit_guarantee_failed:${guarantee.id}`,
    "DEPOSIT_GUARANTEE_RELEASED — guarantee funding failed; the commitment returns to the fund.");
  return transition(env, {
    guarantee,
    toState: "FAILED",
    patch: { resolved_at: nowIso(), return_reason: text(reason, 240) || "FUNDING_FAILED" },
    ledgerEvent: "DEPOSIT_GUARANTEE_RELEASED",
    ledgerTransactionId: posting.transactionId,
    amountCents: guarantee.amountCents,
    reason: text(reason, 240) || "Guarantee funding failed.",
    actorId
  });
}

async function releaseReservation(env, guarantee, idempotencyKey, memo) {
  return postTransaction(env, {
    kind: "adjustment",
    idempotencyKey,
    currency: guarantee.currency,
    reservationId: guarantee.id,
    intakeId: guarantee.intakeId,
    tenantId: guarantee.clinicId,
    memo,
    lines: [
      { account: "fund_deposit_guarantee_reserved", debit: guarantee.amountCents },
      { account: "fund_available", credit: guarantee.amountCents }
    ]
  });
}

/** The booking went away before the money did. Release and close. */
export async function cancelDepositGuarantee(env, { guaranteeId, reason = "BOOKING_CANCELED", actorId = null } = {}) {
  if (!hasDatabase(env)) return DATABASE_REQUIRED;
  const { guarantee, error } = await loadGuarantee(env, guaranteeId);
  if (error) return error;
  if (guarantee.state === "CANCELED") return { ok: true, duplicate: true, guarantee };
  if (guarantee.fundedAt) {
    return {
      ok: false, status: 409, code: "GUARANTEE_ALREADY_FUNDED",
      message: "A funded guarantee is resolved by return or by permitted forfeiture, not by cancellation."
    };
  }
  const posting = await releaseReservation(env, guarantee, `deposit_guarantee_canceled:${guarantee.id}`,
    "DEPOSIT_GUARANTEE_RELEASED — booking canceled before funding; the commitment returns to the fund.");
  return transition(env, {
    guarantee,
    toState: "CANCELED",
    patch: { resolved_at: nowIso(), return_reason: text(reason, 240) },
    ledgerEvent: "DEPOSIT_GUARANTEE_RELEASED",
    ledgerTransactionId: posting.transactionId,
    amountCents: guarantee.amountCents,
    reason: text(reason, 240),
    actorId
  });
}

/* ═══════════════════════════════════════════ what the clinic may keep ═══ */

/**
 * The most this clinic could lawfully retain, from its own documented
 * ordinary policy.
 *
 * Contract §15, exactly: "Clinic may retain only the amount that its ordinary
 * disclosed no-show or late-cancellation policy would permit it to retain **if
 * the Customer personally funded the deposit**." So this function reads the
 * clinic's own recorded policy and nothing else. There is no program-specific
 * forfeiture rule, generous or punitive, and §12 of the agreement forbids
 * inventing one: a Paw It Forward customer may not be treated more harshly
 * than any other.
 *
 * A VARIABLE policy needs a documented per-booking amount. Absent one the
 * answer is zero — "the clinic says it varies" is not documentation, and the
 * program does not guess in the clinic's favour with contributors' money.
 */
export function permittedForfeitureCents(policy, {
  outcome,
  amountCents,
  minutesBeforeAppointment = null,
  documentedAmountCents = null
} = {}) {
  const amount = Math.max(0, cents(amountCents));
  if (!policy || !amount) return 0;
  const result = String(outcome || "").toUpperCase();

  // Attendance and clinic cancellation always return the whole guarantee
  // (§7 outcome rules; contract §15 return obligation).
  if (result === "ATTENDED" || result === "COMPLETED" || result === "CLINIC_CANCELED") return 0;

  const ordinary = () => {
    switch (policy.depositNoShowForfeitType) {
      case "FULL": return amount;
      case "PARTIAL": return Math.min(Math.max(0, cents(policy.depositNoShowForfeitAmountCents)), amount);
      case "VARIABLE": return Math.min(Math.max(0, cents(documentedAmountCents)), amount);
      case "NONE":
      case "NOT_APPLICABLE":
      default: return 0;
    }
  };

  if (result === "NO_SHOW") return ordinary();

  if (result === "CUSTOMER_CANCELED" || result === "LATE_CANCELED") {
    switch (policy.depositRefundability) {
      case "FULLY_REFUNDABLE":
      case "NOT_APPLICABLE":
        return 0;
      case "REFUNDABLE_UNTIL_CUTOFF": {
        const cutoff = policy.depositCancellationCutoffMinutes;
        if (typeof cutoff !== "number") return 0;
        // Cancelled with time to spare: inside the clinic's own refundable
        // window, so nothing may be kept — whoever funded it.
        if (minutesBeforeAppointment !== null && Number(minutesBeforeAppointment) >= cutoff) return 0;
        return ordinary();
      }
      case "NONREFUNDABLE":
        return ordinary();
      case "VARIABLE_BY_BOOKING":
        return Math.min(Math.max(0, cents(documentedAmountCents)), amount);
      default:
        return 0;
    }
  }

  return 0;
}

/**
 * The appointment happened, or did not: FUNDED → RETURN_DUE (§9 rule 5).
 *
 * This is where the outcome is priced, once, against the snapshot the booking
 * was made under — not against whatever the clinic's policy says today.
 * `permittedForfeitureCents` is stored on the row so the settlement that
 * follows is checked against a number somebody can read back, rather than
 * recomputed from a policy that may have changed in between.
 */
export async function recordAppointmentOutcome(env, {
  guaranteeId,
  outcome,
  minutesBeforeAppointment = null,
  documentedAmountCents = null,
  occurredAt = null,
  actorId = null,
  reason = null
} = {}) {
  if (!hasDatabase(env)) return DATABASE_REQUIRED;
  const { guarantee, error } = await loadGuarantee(env, guaranteeId);
  if (error) return error;
  const result = text(outcome, 40).toUpperCase();
  if (!APPOINTMENT_OUTCOMES.includes(result)) {
    return { ok: false, status: 422, code: "INVALID_OUTCOME", message: `Outcome must be one of ${APPOINTMENT_OUTCOMES.join(", ")}.` };
  }
  if (guarantee.state === "DISPUTED") {
    return { ok: false, status: 409, code: "GUARANTEE_DISPUTED", message: "A dispute freezes final accounting (§9)." };
  }

  const policy = await policyForGuarantee(env, guarantee);
  const permitted = permittedForfeitureCents(policy, {
    outcome: result,
    amountCents: guarantee.amountCents,
    minutesBeforeAppointment,
    documentedAmountCents
  });
  const returnDueAt = occurredAt || nowIso();

  return transition(env, {
    guarantee,
    toState: "RETURN_DUE",
    patch: {
      return_due_at: returnDueAt,
      return_reason: result,
      permitted_forfeiture_cents: permitted
    },
    // §6 has an event for this, and it moves no money: an obligation to
    // account is not a cash movement, and posting one would invent a
    // transaction nobody can point at a bank line for.
    ledgerEvent: "DEPOSIT_GUARANTEE_RETURN_DUE",
    ledgerTransactionId: null,
    amountCents: guarantee.amountCents - permitted,
    reason: text(reason, 240) || `Appointment outcome: ${result}.`,
    actorId,
    detail: {
      outcome: result,
      permittedForfeitureCents: permitted,
      returnableCents: guarantee.amountCents - permitted,
      policyId: policy?.id || null,
      minutesBeforeAppointment,
      documentedAmountCents
    }
  });
}

async function policyForGuarantee(env, guarantee) {
  if (guarantee.bookingSnapshotId || guarantee.intakeId) {
    const snapshot = await getBookingDepositSnapshot(env, guarantee.intakeId);
    if (snapshot?.policy) return snapshot.policy;
  }
  if (guarantee.policySnapshotId) return depositPolicyById(env, guarantee.policySnapshotId);
  return currentDepositPolicy(env, guarantee.clinicId);
}

/** RETURN_DUE → RETURN_PENDING. The clinic's settlement is on its way. */
export async function beginDepositGuaranteeReturn(env, { guaranteeId, clinicPaymentReference = null, actorId = null } = {}) {
  if (!hasDatabase(env)) return DATABASE_REQUIRED;
  const { guarantee, error } = await loadGuarantee(env, guaranteeId);
  if (error) return error;
  return transition(env, {
    guarantee,
    toState: "RETURN_PENDING",
    patch: { clinic_payment_reference: text(clinicPaymentReference, 120) || guarantee.clinicPaymentReference || null },
    amountCents: guarantee.amountCents - guarantee.permittedForfeitureCents,
    reason: "Clinic settlement in flight.",
    actorId
  });
}

/* ═════════════════════════════════════════════════════════ settlement ═══ */

/**
 * Close the guarantee: RETURNED, PARTIAL_FORFEITURE, or FORFEITED.
 *
 * Five refusals live here, and each one is an acceptance test:
 *
 *   24. A guarantee cannot be both returned and forfeited. The two amounts
 *       must add to exactly the guarantee, and the resulting state names
 *       which of the three outcomes happened.
 *   26. A forfeiture may not exceed what the clinic's own documented
 *       ordinary policy permitted — the number priced at
 *       `recordAppointmentOutcome` and stored on the row.
 *   27. Partial forfeiture returns the remainder; it is not a rounding
 *       exercise the clinic gets to keep the difference on.
 *   25/§7. A guarantee that has been applied to the veterinary bill under a
 *       separate treatment authorization cannot then also be forfeited —
 *       that is the same money twice.
 *   §15. A settlement the double-collection check refused does not get to
 *       resolve anyway.
 */
export async function settleDepositGuarantee(env, {
  guaranteeId,
  returnedAmountCents = null,
  forfeitedAmountCents = 0,
  forfeitureReason = null,
  clinicPaymentReference = null,
  occurredAt = null,
  actorId = null
} = {}) {
  if (!hasDatabase(env)) return DATABASE_REQUIRED;
  const { guarantee, error } = await loadGuarantee(env, guaranteeId);
  if (error) return error;

  if (guarantee.state === "DISPUTED") {
    return {
      ok: false, status: 409, code: "GUARANTEE_DISPUTED",
      message: "A dispute freezes final accounting until it is resolved (§9 rule 9)."
    };
  }
  if (TERMINAL_STATES.includes(guarantee.state)) {
    return {
      ok: false, status: 409, code: "GUARANTEE_ALREADY_RESOLVED",
      message: `This guarantee is already ${guarantee.state}; it cannot be settled again.`,
      guarantee
    };
  }
  if (guarantee.state !== "RETURN_DUE" && guarantee.state !== "RETURN_PENDING") {
    return {
      ok: false, status: 409, code: "OUTCOME_NOT_RECORDED",
      message: "Record the appointment outcome first; a settlement without one has nothing to be checked against."
    };
  }

  const amount = guarantee.amountCents;
  const forfeited = Math.max(0, cents(forfeitedAmountCents));
  const returned = returnedAmountCents === null || returnedAmountCents === undefined
    ? amount - forfeited
    : Math.max(0, cents(returnedAmountCents));

  // Acceptance test 24, and acceptance test 27's remainder rule, in one line.
  if (returned + forfeited !== amount) {
    return {
      ok: false, status: 422, code: "SETTLEMENT_DOES_NOT_BALANCE",
      message: `Returned ${formatMoney(returned, guarantee.currency)} plus forfeited ${formatMoney(forfeited, guarantee.currency)} must equal the ${formatMoney(amount, guarantee.currency)} guarantee. A partial forfeiture returns the remainder.`,
      amountCents: amount, returnedAmountCents: returned, forfeitedAmountCents: forfeited
    };
  }

  // Acceptance test 26, contract §15.
  if (forfeited > guarantee.permittedForfeitureCents) {
    return {
      ok: false, status: 422, code: "FORFEITURE_EXCEEDS_POLICY",
      message: `The clinic's documented ordinary policy permits it to retain at most ${formatMoney(guarantee.permittedForfeitureCents, guarantee.currency)} on this outcome — the same amount it could have retained had the customer personally funded the deposit. ${formatMoney(forfeited, guarantee.currency)} exceeds it.`,
      permittedForfeitureCents: guarantee.permittedForfeitureCents,
      requestedForfeitureCents: forfeited
    };
  }

  // §7 / contract §15: the guarantee cannot be applied to the bill and kept.
  if (forfeited > 0 && guarantee.appliedToTreatmentCents > 0) {
    return {
      ok: false, status: 409, code: "GUARANTEE_ALREADY_APPLIED_TO_TREATMENT",
      message: `${formatMoney(guarantee.appliedToTreatmentCents, guarantee.currency)} of this guarantee was applied to the veterinary bill under authorization ${guarantee.treatmentAuthorizationId}. Retaining it as a forfeiture as well would collect the same money twice.`
    };
  }

  // A settlement report the double-collection check already refused does not
  // get to resolve the guarantee by another door.
  const refusedSettlement = await env.DB.prepare(
    "SELECT * FROM pif_deposit_guarantee_settlements WHERE guarantee_id = ? AND accepted = 0 ORDER BY datetime(reported_at) DESC LIMIT 1"
  ).bind(guarantee.id).first();
  if (refusedSettlement) {
    return {
      ok: false, status: 409, code: refusedSettlement.refusal_code || "SETTLEMENT_REFUSED",
      message: "This guarantee has an unresolved settlement exception; it cannot be closed until the clinic's accounting is corrected (contract §15 reconciliation).",
      settlementId: refusedSettlement.id
    };
  }

  const at = occurredAt || nowIso();
  const toState = forfeited === 0 ? "RETURNED" : (returned === 0 ? "FORFEITED" : "PARTIAL_FORFEITURE");
  const ledgerEvent = forfeited === 0
    ? "DEPOSIT_GUARANTEE_RETURNED"
    : (returned === 0 ? "DEPOSIT_GUARANTEE_FORFEITED" : "DEPOSIT_GUARANTEE_PARTIALLY_FORFEITED");

  if (forfeited > 0 && !text(forfeitureReason, 240)) {
    return {
      ok: false, status: 422, code: "FORFEITURE_REASON_REQUIRED",
      message: "A forfeiture is program money spent; it needs a recorded reason."
    };
  }

  let returnTransactionId = null;
  let forfeitTransactionId = null;

  if (returned > 0) {
    const posting = await postTransaction(env, {
      kind: "clinic_deposit_refunded",
      idempotencyKey: `deposit_guarantee_returned:${guarantee.id}`,
      occurredAt: at,
      currency: guarantee.currency,
      reservationId: guarantee.id,
      intakeId: guarantee.intakeId,
      tenantId: guarantee.clinicId,
      memo: `${ledgerEvent} — clinic returned the appointment deposit guarantee to Paw It Forward. The customer remains responsible for the veterinary bill.`,
      lines: [
        { account: "processor_cash", debit: returned },
        { account: "fund_deposit_guarantee_reserved", debit: returned },
        { account: "deposit_guarantee_outstanding", credit: returned },
        { account: "fund_available", credit: returned }
      ]
    });
    returnTransactionId = posting.transactionId;
  }

  if (forfeited > 0) {
    // §7: "A forfeiture is a real Paw It Forward expense and must be recorded
    // as such." The restricted contribution that funded it is released in the
    // same breath, because it has now actually been spent.
    const posting = await postTransaction(env, {
      kind: "adjustment",
      idempotencyKey: `deposit_guarantee_forfeited:${guarantee.id}`,
      occurredAt: at,
      currency: guarantee.currency,
      reservationId: guarantee.id,
      intakeId: guarantee.intakeId,
      tenantId: guarantee.clinicId,
      memo: `${ledgerEvent} — clinic retained the amount its documented ordinary policy permits. A real Paw It Forward expense, not a payment toward veterinary services.`,
      lines: [
        { account: "deposit_guarantee_forfeiture_expense", debit: forfeited },
        { account: "fund_deposit_guarantee_reserved", debit: forfeited },
        { account: "deposit_guarantee_outstanding", credit: forfeited },
        { account: "program_restricted_released", credit: forfeited }
      ]
    });
    forfeitTransactionId = posting.transactionId;
  }

  const moved = await transition(env, {
    guarantee,
    toState,
    patch: {
      returned_amount_cents: returned,
      forfeited_amount_cents: forfeited,
      forfeiture_reason: forfeited > 0 ? text(forfeitureReason, 240) : null,
      clinic_payment_reference: text(clinicPaymentReference, 120) || guarantee.clinicPaymentReference || null,
      resolved_at: at
    },
    ledgerEvent,
    ledgerTransactionId: returnTransactionId || forfeitTransactionId,
    amountCents: amount,
    reason: forfeited > 0 ? text(forfeitureReason, 240) : "Guarantee returned to Paw It Forward.",
    actorId,
    detail: {
      returnedAmountCents: returned,
      forfeitedAmountCents: forfeited,
      permittedForfeitureCents: guarantee.permittedForfeitureCents,
      returnTransactionId,
      forfeitTransactionId
    }
  });
  if (!moved.ok) return moved;

  await recordAudit(env, {
    actorId,
    actorRole: "system",
    action: `deposit_guarantee.${toState.toLowerCase()}`,
    subjectType: "pif_deposit_guarantee",
    subjectId: guarantee.id,
    oldState: { state: guarantee.state, permittedForfeitureCents: guarantee.permittedForfeitureCents },
    newState: { state: toState, returnedAmountCents: returned, forfeitedAmountCents: forfeited },
    reason: forfeited > 0 ? text(forfeitureReason, 240) : "Guarantee returned."
  });

  return { ...moved, returnedAmountCents: returned, forfeitedAmountCents: forfeited, returnTransactionId, forfeitTransactionId };
}

/* ═══════════════════════════════════════════════════════════ disputes ═══ */

/** Freeze final accounting (§9 rule 9). Nothing resolves while a dispute is open. */
export async function disputeDepositGuarantee(env, { guaranteeId, reason, actorId = null } = {}) {
  if (!hasDatabase(env)) return DATABASE_REQUIRED;
  const { guarantee, error } = await loadGuarantee(env, guaranteeId);
  if (error) return error;
  if (!text(reason, 500)) {
    return { ok: false, status: 422, code: "DISPUTE_REASON_REQUIRED", message: "A dispute needs a recorded reason." };
  }
  return transition(env, {
    guarantee,
    toState: "DISPUTED",
    patch: { state_before_dispute: guarantee.state },
    amountCents: guarantee.amountCents,
    reason: text(reason, 500),
    actorId
  });
}

/** Unfreeze. The guarantee returns to where it was and the ordinary rules decide. */
export async function resolveDepositGuaranteeDispute(env, { guaranteeId, resolution, actorId = null } = {}) {
  if (!hasDatabase(env)) return DATABASE_REQUIRED;
  const { guarantee, error } = await loadGuarantee(env, guaranteeId);
  if (error) return error;
  if (guarantee.state !== "DISPUTED") {
    return { ok: false, status: 409, code: "NOT_DISPUTED", message: "That guarantee is not in dispute." };
  }
  const back = guarantee.stateBeforeDispute || "RETURN_DUE";
  return transition(env, {
    guarantee,
    toState: back,
    patch: { state_before_dispute: null },
    amountCents: guarantee.amountCents,
    reason: text(resolution, 500) || "Dispute resolved.",
    actorId
  });
}

/* ══════════════════════════════════════════════ anti-double-payment ═══ */

/**
 * Authorize — expressly, and by a named human — applying a guarantee to the
 * veterinary bill.
 *
 * §7: "Prohibited unless separately authorized as treatment assistance."
 * Contract §15: "A treatment or hospitalization deposit is excluded unless
 * ClearKey separately authorizes that specific use."
 *
 * There is no default, no configuration flag, and no clinic-side path to
 * this. It exists so that the one lawful case is *possible* and leaves a
 * record; without a call to this function, `applyGuaranteeToTreatment`
 * refuses, which is acceptance test 25.
 */
export async function authorizeGuaranteeAsTreatmentAssistance(env, {
  guaranteeId, treatmentAuthorizationId, authorizedBy, reason, actorId = null
} = {}) {
  if (!hasDatabase(env)) return DATABASE_REQUIRED;
  const { guarantee, error } = await loadGuarantee(env, guaranteeId);
  if (error) return error;
  const authorization = text(treatmentAuthorizationId, 120);
  const approver = text(authorizedBy, 120);
  if (!authorization || !approver || !text(reason, 500)) {
    return {
      ok: false, status: 422, code: "TREATMENT_AUTHORIZATION_INCOMPLETE",
      message: "A separate treatment-assistance authorization needs its own identifier, the ClearKey approver, and a reason."
    };
  }
  await env.DB.prepare(`
    UPDATE pif_deposit_guarantees
       SET treatment_authorization_id = ?, treatment_authorized_by = ?, treatment_authorized_at = ?, updated_at = ?
     WHERE id = ?
  `).bind(authorization, approver, nowIso(), nowIso(), guarantee.id).run();

  await appendEvent(env, {
    guaranteeId: guarantee.id,
    fromState: guarantee.state,
    toState: guarantee.state,
    amountCents: 0,
    reason: text(reason, 500),
    actorId,
    detail: { treatmentAuthorizationId: authorization, authorizedBy: approver }
  });
  await recordAudit(env, {
    actorId: actorId || approver,
    actorRole: "clearkey_admin",
    action: "deposit_guarantee.treatment_assistance_authorized",
    subjectType: "pif_deposit_guarantee",
    subjectId: guarantee.id,
    newState: { treatmentAuthorizationId: authorization, authorizedBy: approver },
    reason: text(reason, 500)
  });
  return { ok: true, guarantee: await getDepositGuarantee(env, guarantee.id) };
}

/**
 * Apply some of a guarantee to the veterinary bill.
 *
 * Refused outright unless `authorizeGuaranteeAsTreatmentAssistance` has run
 * for this guarantee. The default answer to "can this $75 come off the bill?"
 * is no, and it is no for a reason worth stating plainly: the customer was
 * told the program was covering a *deposit*. Turning that into treatment
 * payment changes what they were promised and what the clinic may collect,
 * and §10 forbids describing a guarantee as free veterinary care.
 */
export async function applyGuaranteeToTreatment(env, {
  guaranteeId, amountCents, treatmentAuthorizationId = null, actorId = null, reason = null
} = {}) {
  if (!hasDatabase(env)) return DATABASE_REQUIRED;
  const { guarantee, error } = await loadGuarantee(env, guaranteeId);
  if (error) return error;
  const amount = Math.max(0, cents(amountCents));
  if (!amount) return { ok: false, status: 422, code: "AMOUNT_REQUIRED", message: "An amount is required." };

  if (!guarantee.treatmentAuthorizationId) {
    return {
      ok: false, status: 409, code: "GUARANTEE_IS_NOT_TREATMENT_PAYMENT",
      message: "A Paw It Forward appointment deposit guarantee never automatically becomes treatment payment (§7). Applying it to the veterinary bill requires a separate, expressly recorded ClearKey treatment-assistance authorization."
    };
  }
  if (treatmentAuthorizationId && text(treatmentAuthorizationId, 120) !== guarantee.treatmentAuthorizationId) {
    return {
      ok: false, status: 409, code: "TREATMENT_AUTHORIZATION_MISMATCH",
      message: "That authorization does not belong to this guarantee."
    };
  }
  if (amount > guarantee.amountCents - guarantee.appliedToTreatmentCents) {
    return {
      ok: false, status: 422, code: "AMOUNT_EXCEEDS_GUARANTEE",
      message: "More than the guarantee cannot be applied to a bill."
    };
  }
  await env.DB.prepare(
    "UPDATE pif_deposit_guarantees SET applied_to_treatment_cents = applied_to_treatment_cents + ?, updated_at = ? WHERE id = ?"
  ).bind(amount, nowIso(), guarantee.id).run();
  await appendEvent(env, {
    guaranteeId: guarantee.id,
    fromState: guarantee.state,
    toState: guarantee.state,
    amountCents: amount,
    reason: text(reason, 500) || "Applied to the veterinary bill under a separate treatment-assistance authorization.",
    actorId,
    detail: { treatmentAuthorizationId: guarantee.treatmentAuthorizationId, appliedCents: amount }
  });
  return { ok: true, guarantee: await getDepositGuarantee(env, guarantee.id) };
}

/**
 * The clinic reports how the visit was paid, and the arithmetic of contract
 * §15 runs.
 *
 * Two refusals, and both are written to `pif_deposit_guarantee_settlements`
 * with `accepted = 0` rather than merely returned, because a clinic that
 * files a prohibited settlement is a reconciliation exception somebody has to
 * work, not a failed HTTP call:
 *
 *   * the guarantee was applied to the bill without a separate ClearKey
 *     treatment-assistance authorization (§7, contract §15); or
 *   * applied guarantee + customer + insurer + financing exceeds the bill —
 *     the clinic has been paid the same money twice, which is exactly what
 *     "shall not both retain or apply the guarantee ... and collect the same
 *     amount from the Customer, insurer, financing source, or other payer"
 *     prohibits.
 *
 * The §7 worked example passes through both: $1,000 of services, $700
 * insurance, $200 customer, $100 guarantee applied and kept. The first check
 * catches it, because nobody authorized the guarantee as treatment payment.
 */
export async function recordClinicBillSettlement(env, {
  guaranteeId,
  veterinaryBillCents,
  collectedFromCustomerCents = 0,
  collectedFromInsurerCents = 0,
  collectedFromOtherPayerCents = 0,
  guaranteeAppliedToBillCents = 0,
  treatmentAuthorizationId = null,
  reportedBy = null
} = {}) {
  if (!hasDatabase(env)) return DATABASE_REQUIRED;
  const { guarantee, error } = await loadGuarantee(env, guaranteeId);
  if (error) return error;

  const bill = Math.max(0, cents(veterinaryBillCents));
  const customer = Math.max(0, cents(collectedFromCustomerCents));
  const insurer = Math.max(0, cents(collectedFromInsurerCents));
  const other = Math.max(0, cents(collectedFromOtherPayerCents));
  const applied = Math.max(0, cents(guaranteeAppliedToBillCents));
  const authorization = text(treatmentAuthorizationId, 120) || guarantee.treatmentAuthorizationId || null;

  let refusalCode = null;
  let message = null;
  if (applied > 0 && !guarantee.treatmentAuthorizationId) {
    refusalCode = "GUARANTEE_IS_NOT_TREATMENT_PAYMENT";
    message = "The appointment deposit guarantee was applied to the veterinary bill without a separate ClearKey treatment-assistance authorization. The guarantee is temporary program float, not a payment toward veterinary services (§7; agreement §15).";
  }

  const overcollected = applied + customer + insurer + other - bill;
  if (!refusalCode && applied > 0 && overcollected > 0) {
    refusalCode = "DOUBLE_COLLECTION_DETECTED";
    message = `The clinic applied ${formatMoney(applied, guarantee.currency)} of the guarantee to the bill and collected ${formatMoney(customer + insurer + other, guarantee.currency)} from other payers against a ${formatMoney(bill, guarantee.currency)} bill — ${formatMoney(overcollected, guarantee.currency)} collected twice. The agreement §15 forbids both retaining or applying the guarantee as payment for veterinary services and collecting the same amount from the Customer, insurer, financing source, or other payer.`;
  }

  const id = newId("dgset");
  await env.DB.prepare(`
    INSERT INTO pif_deposit_guarantee_settlements (
      id, guarantee_id, intake_id, veterinary_bill_cents, collected_from_customer_cents,
      collected_from_insurer_cents, collected_from_other_payer_cents,
      guarantee_applied_to_bill_cents, treatment_authorization_id, overcollected_cents,
      accepted, refusal_code, reported_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, guarantee.id, guarantee.intakeId, bill, customer, insurer, other, applied,
    authorization, Math.max(0, overcollected), refusalCode ? 0 : 1, refusalCode, reportedBy || null
  ).run();

  await appendEvent(env, {
    guaranteeId: guarantee.id,
    fromState: guarantee.state,
    toState: guarantee.state,
    amountCents: applied,
    reason: refusalCode ? `Settlement refused: ${refusalCode}` : "Clinic bill settlement recorded.",
    actorId: reportedBy,
    actorRole: "clinic",
    detail: { settlementId: id, bill, customer, insurer, other, applied, overcollected: Math.max(0, overcollected) }
  });

  if (refusalCode) {
    await recordAudit(env, {
      actorId: reportedBy,
      actorRole: "clinic",
      action: "deposit_guarantee.settlement_refused",
      subjectType: "pif_deposit_guarantee",
      subjectId: guarantee.id,
      newState: { settlementId: id, refusalCode, overcollectedCents: Math.max(0, overcollected) },
      reason: message
    });
    return { ok: false, status: 409, code: refusalCode, message, settlementId: id, overcollectedCents: Math.max(0, overcollected) };
  }

  return {
    ok: true,
    settlementId: id,
    // The point of the whole feature, restated where the numbers are: the
    // returned guarantee changes nothing about what the customer owes.
    veterinaryBillCents: bill,
    customerResponsibleCents: Math.max(0, bill - insurer - other - applied),
    guaranteeReturnableCents: guarantee.amountCents - applied
  };
}

/* ═══════════════════════════════════════════════════════════ handlers ═══ */
/*
 * Mount everything below behind ClearKey admin or authenticated clinic
 * routes as noted. Nothing here is a public endpoint.
 */

/** GET /api/admin/deposit-guarantees/:id */
export async function handleDepositGuaranteeGet(request, env, actor, guaranteeId) {
  const guarantee = await getDepositGuarantee(env, guaranteeId);
  if (!guarantee) return apiError(404, "GUARANTEE_NOT_FOUND", "That deposit guarantee does not exist.");
  return json({ guarantee, events: await listDepositGuaranteeEvents(env, guaranteeId) });
}

/** POST /api/admin/bookings/:intakeId/deposit-guarantee — reserve. */
export async function handleDepositGuaranteeReserve(request, env, actor, intakeId) {
  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    const code = error.message === "PAYLOAD_TOO_LARGE" ? "PAYLOAD_TOO_LARGE" : "JSON_REQUIRED";
    return apiError(code === "PAYLOAD_TOO_LARGE" ? 413 : 400, code, "A valid JSON request body is required.");
  }
  const result = await reserveDepositGuarantee(env, {
    intakeId,
    tenantId: text(body?.tenantId, 120) || null,
    customerUserId: text(body?.customerUserId, 120) || null,
    amountCents: body?.amountCents ?? null,
    depositKind: body?.depositKind || "APPOINTMENT",
    sponsored: body?.sponsored !== false,
    actorId: actor?.userId || actor?.id || null
  });
  if (!result.ok) return apiError(result.status || 409, result.code, result.message, result.details);
  return json(result, { status: result.duplicate ? 200 : 201 });
}

/**
 * POST /api/admin/deposit-guarantees/:id — `{ action, ... }`.
 *
 * One door for the lifecycle, because a router that spells out nine verbs
 * eventually grows a tenth that skips a check.
 */
export async function handleDepositGuaranteeAction(request, env, actor, guaranteeId) {
  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    const code = error.message === "PAYLOAD_TOO_LARGE" ? "PAYLOAD_TOO_LARGE" : "JSON_REQUIRED";
    return apiError(code === "PAYLOAD_TOO_LARGE" ? 413 : 400, code, "A valid JSON request body is required.");
  }
  const actorId = actor?.userId || actor?.id || null;
  const action = text(body?.action, 40).toLowerCase();
  let result;
  switch (action) {
    case "begin_funding":
      result = await beginDepositGuaranteeFunding(env, { guaranteeId, stripeTransferReference: body?.stripeTransferReference, actorId });
      break;
    case "funded":
      result = await markDepositGuaranteeFunded(env, {
        guaranteeId,
        stripeTransferReference: body?.stripeTransferReference,
        clinicPaymentReference: body?.clinicPaymentReference,
        actorId
      });
      break;
    case "outcome":
      result = await recordAppointmentOutcome(env, {
        guaranteeId,
        outcome: body?.outcome,
        minutesBeforeAppointment: body?.minutesBeforeAppointment ?? null,
        documentedAmountCents: body?.documentedAmountCents ?? null,
        actorId
      });
      break;
    case "begin_return":
      result = await beginDepositGuaranteeReturn(env, { guaranteeId, clinicPaymentReference: body?.clinicPaymentReference, actorId });
      break;
    case "settle":
      result = await settleDepositGuarantee(env, {
        guaranteeId,
        returnedAmountCents: body?.returnedAmountCents ?? null,
        forfeitedAmountCents: body?.forfeitedAmountCents ?? 0,
        forfeitureReason: body?.forfeitureReason ?? null,
        clinicPaymentReference: body?.clinicPaymentReference ?? null,
        actorId
      });
      break;
    case "cancel":
      result = await cancelDepositGuarantee(env, { guaranteeId, reason: body?.reason, actorId });
      break;
    case "fail":
      result = await failDepositGuarantee(env, { guaranteeId, reason: body?.reason, actorId });
      break;
    case "dispute":
      result = await disputeDepositGuarantee(env, { guaranteeId, reason: body?.reason, actorId });
      break;
    case "resolve_dispute":
      result = await resolveDepositGuaranteeDispute(env, { guaranteeId, resolution: body?.resolution, actorId });
      break;
    case "authorize_treatment_assistance":
      result = await authorizeGuaranteeAsTreatmentAssistance(env, {
        guaranteeId,
        treatmentAuthorizationId: body?.treatmentAuthorizationId,
        authorizedBy: body?.authorizedBy,
        reason: body?.reason,
        actorId
      });
      break;
    default:
      return apiError(422, "INVALID_ACTION", "Action must be one of begin_funding, funded, outcome, begin_return, settle, cancel, fail, dispute, resolve_dispute, authorize_treatment_assistance.");
  }
  if (!result.ok) return apiError(result.status || 409, result.code, result.message, result.details);
  return json(result);
}

/** POST /api/clinic/deposit-guarantees/:id/settlement — the clinic's own report. */
export async function handleClinicBillSettlement(request, env, actor, guaranteeId) {
  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    const code = error.message === "PAYLOAD_TOO_LARGE" ? "PAYLOAD_TOO_LARGE" : "JSON_REQUIRED";
    return apiError(code === "PAYLOAD_TOO_LARGE" ? 413 : 400, code, "A valid JSON request body is required.");
  }
  const result = await recordClinicBillSettlement(env, {
    guaranteeId,
    veterinaryBillCents: body?.veterinaryBillCents,
    collectedFromCustomerCents: body?.collectedFromCustomerCents,
    collectedFromInsurerCents: body?.collectedFromInsurerCents,
    collectedFromOtherPayerCents: body?.collectedFromOtherPayerCents,
    guaranteeAppliedToBillCents: body?.guaranteeAppliedToBillCents,
    treatmentAuthorizationId: body?.treatmentAuthorizationId,
    reportedBy: actor?.userId || actor?.id || null
  });
  if (!result.ok) return apiError(result.status || 409, result.code, result.message, result.details);
  return json(result);
}
