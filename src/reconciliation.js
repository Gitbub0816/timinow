/**
 * Paw It Forward reconciliation — addendum §21.
 *
 * Reconcile to the penny. Not to the dollar, not "within tolerance", not
 * "close enough to sign off": §21 prints a one-cent difference as a
 * CRITICAL_RECONCILIATION_EXCEPTION and this file has no threshold anywhere
 * in it. A rounding tolerance is a place for a real loss to hide, and the
 * only difference between the first missing cent and the first missing
 * thousand dollars is how long nobody looked.
 *
 * ──────────────────────────────────────────────────────────── the identity ──
 *
 *   protected custody cash
 *   = available designated funds
 *   + reserved sponsorships
 *   + reserved/funded refundable deposit guarantees
 *   + earned sponsorships not yet released from custody
 *   − designated cash still clearing in Stripe Payments
 *   − movements in flight
 *   − guarantee float physically held by a clinic
 *
 * The first four terms are claims on Paw It Forward money; the last three
 * are places that money can honestly be other than custody. Every term is an
 * integer number of cents read from the ledger, the fund tables, or the
 * custody transfer journal — never from a Stripe balance, and never from a
 * cached total.
 *
 * The comparison is made against the *rail's own* number. A stub custody
 * provider derives its balance from completed transfers rather than from the
 * ledger for exactly this reason: a reconciliation whose two sides are the
 * same query cannot fail, and a check that cannot fail is not a check.
 *
 * ─────────────────────────────────────────────────────── what never happens ──
 *
 * Nothing here rounds, nothing here adjusts, and nothing here rewrites the
 * ledger to agree with Stripe (§21, §28). An exception is an operations
 * case: a human investigates it, and if a correction is warranted it is a
 * compensating entry posted through the ordinary journal and linked to the
 * case. `resolveException` moves a case's status and records who said what;
 * it cannot move a cent.
 *
 * ───────────────────────────────────────────── the guarantee component ──
 *
 * `pif_deposit_guarantees` is built in parallel. If it is not there yet the
 * guarantee terms are zero and the run says
 * `guarantee_source = UNAVAILABLE_TABLE_MISSING` — recorded, not thrown, and
 * not silently treated as "there are no guarantees", which is a different
 * claim entirely.
 */

import { hasDatabase } from "./db.js";
import { accountBalance, ledgerIntegrity, recordAudit } from "./ledger.js";
import {
  GUARANTEE_COMMITTED_STATES,
  designationStatus,
  resolveCustodyProvider
} from "./fund-custody.js";

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

const DATABASE_REQUIRED = {
  ok: false,
  code: "DATABASE_REQUIRED",
  message: "Reconciliation requires D1. There is nothing to reconcile without the ledger."
};

/** §21's verdict words. There is no third one, and no severity below these. */
export const CRITICAL = "CRITICAL_RECONCILIATION_EXCEPTION";
export const WARNING = "RECONCILIATION_WARNING";

export const EXCEPTION_STATUSES = [
  "OPEN", "INVESTIGATING", "RESOLVED_EXPLAINED", "RESOLVED_COMPENSATING_ENTRY"
];

/**
 * Does this table exist yet?
 *
 * Asked rather than assumed, because the deposit-guarantee migration lands
 * on its own schedule and a reconciliation run that throws is a
 * reconciliation run that did not happen.
 */
async function tableExists(env, name) {
  try {
    const row = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1"
    ).bind(name).first();
    return Boolean(row);
  } catch {
    return false;
  }
}

/* ═════════════════════════════════════════════════════════ the components ══ */

/**
 * Guarantee money the program is still committed to, and how much of it is
 * physically at a clinic.
 *
 * Both come from `pif_deposit_guarantees` rather than from the ledger, on
 * purpose: the ledger says where the cash is and the state machine says what
 * it is promised to, and reconciliation exists to notice when those two
 * stories differ.
 */
async function guaranteeComponent(env, currency) {
  if (!await tableExists(env, "pif_deposit_guarantees")) {
    return {
      available: false,
      source: "UNAVAILABLE_TABLE_MISSING",
      obligationCents: 0,
      note: "pif_deposit_guarantees does not exist on this deployment yet, so the guarantee term is zero rather than unknown-and-guessed."
    };
  }
  try {
    const row = await env.DB.prepare(`
      SELECT COALESCE(SUM(amount_cents - returned_amount_cents - forfeited_amount_cents), 0) AS committed
      FROM pif_deposit_guarantees
      WHERE currency = ?
        AND state IN (${GUARANTEE_COMMITTED_STATES.map(() => "?").join(", ")})
    `).bind(currency, ...GUARANTEE_COMMITTED_STATES).first();
    return {
      available: true,
      source: "pif_deposit_guarantees",
      obligationCents: Number(row?.committed || 0),
      note: null
    };
  } catch (error) {
    return {
      available: false,
      source: "UNAVAILABLE_QUERY_FAILED",
      obligationCents: 0,
      note: `The guarantee tables could not be read: ${error?.message || "unknown error"}.`
    };
  }
}

/**
 * Sponsorships that have been earned but whose cash has not yet left
 * protected custody.
 *
 * Between consumption and release the money is genuinely both: no longer
 * owed to the fund, not yet moved to ClearKey. Leaving this term out is what
 * would make every completed sponsorship look like a custody surplus.
 */
async function earnedNotReleased(env, currency) {
  const consumed = await env.DB.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) AS total
    FROM sponsorships WHERE reversed_at IS NULL AND currency = ?
  `).bind(currency).first();
  const released = await env.DB.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) AS total
    FROM pif_custody_transfers
    WHERE direction = 'RELEASE' AND state = 'COMPLETED' AND currency = ?
  `).bind(currency).first();
  return Number(consumed?.total || 0) - Number(released?.total || 0);
}

/**
 * Guarantee float that physically left *protected custody*, as opposed to
 * guarantee float that left the Payments balance.
 *
 * The distinction is not pedantic. `src/deposit-guarantee.js` currently
 * sources a funded guarantee from `processor_cash` — the money never passes
 * through Treasury — while `fundGuaranteeFromCustody()` sources it from
 * custody as §5's `fundDepositGuarantee()` rail implies. Both are coherent;
 * they are not the same cash location, and an identity that assumed either
 * one would raise a daily critical exception against a correct system.
 *
 * So the identity subtracts what actually left custody (this), and the run
 * separately reports the guarantee float at clinics (the ledger account). A
 * gap between them is real information — guarantee money funded from
 * unrestricted cash rather than from the protected pot — and is raised as a
 * warning, not silently normalized away.
 */
async function guaranteeCashFromCustody(env, currency) {
  const row = await env.DB.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN direction = 'GUARANTEE_FUNDING' THEN amount_cents ELSE 0 END), 0) AS funded,
      COALESCE(SUM(CASE WHEN direction = 'GUARANTEE_RETURN' THEN amount_cents ELSE 0 END), 0) AS returned
    FROM pif_custody_transfers
    WHERE state = 'COMPLETED' AND currency = ?
  `).bind(currency).first();
  return Number(row?.funded || 0) - Number(row?.returned || 0);
}

async function transferJournalCents(env, currency) {
  const row = await env.DB.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN direction IN ('SWEEP', 'GUARANTEE_RETURN') THEN amount_cents ELSE 0 END), 0) AS inflow,
      COALESCE(SUM(CASE WHEN direction IN ('RELEASE', 'GUARANTEE_FUNDING') THEN amount_cents ELSE 0 END), 0) AS outflow
    FROM pif_custody_transfers
    WHERE state = 'COMPLETED' AND currency = ?
  `).bind(currency).first();
  return Number(row?.inflow || 0) - Number(row?.outflow || 0);
}

/* ═══════════════════════════════════════════════════════════════ the run ══ */

/**
 * One reconciliation pass.
 *
 * `runKey` makes it idempotent: the daily cron uses `daily:2026-08-31`, so a
 * scheduler that fires twice records one run rather than two conflicting
 * verdicts for the same day.
 */
export async function runReconciliation(env, options = {}) {
  if (!hasDatabase(env)) return DATABASE_REQUIRED;

  const currency = cleanString(options.currency, 8) || "usd";
  const scope = ["DAILY", "MANUAL", "BACKFILL"].includes(options.scope) ? options.scope : "MANUAL";
  const now = options.now || nowIso();
  const runKey = cleanString(options.runKey, 120)
    || (scope === "DAILY" ? `daily:${now.slice(0, 10)}` : `${scope.toLowerCase()}:${newId("r")}`);
  const triggeredBy = cleanString(options.triggeredBy, 120) || "system:reconciliation";
  const staleHours = Number(options.staleTransferHours) > 0 ? Number(options.staleTransferHours) : 24;

  const runId = newId("pifrecon");
  const claimed = await env.DB.prepare(`
    INSERT OR IGNORE INTO pif_reconciliation_runs (id, run_key, scope, currency, status, triggered_by, started_at)
    VALUES (?, ?, ?, ?, 'RUNNING', ?, ?)
  `).bind(runId, runKey, scope, currency, triggeredBy, now).run();

  if (Number(claimed?.meta?.changes || 0) === 0) {
    const existing = await env.DB.prepare("SELECT * FROM pif_reconciliation_runs WHERE run_key = ? LIMIT 1")
      .bind(runKey).first();
    return { ok: true, duplicate: true, run: runFromRow(existing), exceptions: await exceptionsForRun(env, existing?.id) };
  }

  try {
    const status = await designationStatus(env, { ...options, currency, now });
    if (!status.ok) throw new Error(status.message || status.code);

    const provider = resolveCustodyProvider(env, options);
    const railView = await provider.reconcile(env, { currency });

    const [
      fundAvailableCents,
      fundReservedCents,
      ledgerCustodyCents,
      inTransitCents,
      guaranteeCashAtClinicCents
    ] = await Promise.all([
      accountBalance(env, "fund_available"),
      accountBalance(env, "fund_reserved"),
      accountBalance(env, "pif_custody_cash"),
      accountBalance(env, "pif_custody_in_transit"),
      accountBalance(env, "deposit_guarantee_outstanding")
    ]);

    const guarantee = await guaranteeComponent(env, currency);
    const earnedNotReleasedCents = await earnedNotReleased(env, currency);
    const journalCents = await transferJournalCents(env, currency);
    const guaranteeFromCustodyCents = await guaranteeCashFromCustody(env, currency);
    const designatedInPaymentsCents = status.designatedInPaymentsCents;

    // §21's identity, as arithmetic.
    const expectedCustodyCents =
      fundAvailableCents
      + fundReservedCents
      + guarantee.obligationCents
      + earnedNotReleasedCents
      - designatedInPaymentsCents
      - inTransitCents
      - guaranteeFromCustodyCents;

    // A rail that answered gives the actual. A rail that is absent by design
    // holds nothing, which is a real zero. A rail that was supposed to answer
    // and did not gives no actual at all, and that is itself the exception —
    // reconciliation never invents the other side of its own comparison.
    const railAnswered = Boolean(railView?.ok);
    const railExpectedToAnswer = provider.mode !== "NONE";
    const actualCustodyCents = railAnswered ? Number(railView.balanceCents || 0) : 0;
    const comparable = railAnswered || !railExpectedToAnswer;
    const differenceCents = comparable ? actualCustodyCents - expectedCustodyCents : 0;

    const refunded = await env.DB.prepare(
      "SELECT COALESCE(SUM(refunded_cents), 0) AS total FROM contributions WHERE currency = ?"
    ).bind(currency).first();

    const integrity = await ledgerIntegrity(env);

    const stale = await env.DB.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(amount_cents), 0) AS total
      FROM pif_custody_transfers
      WHERE state IN ('PENDING', 'IN_TRANSIT') AND requested_at < ?
    `).bind(new Date(Date.parse(now) - staleHours * 3_600_000).toISOString()).first();

    const failedTransfers = await env.DB.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(amount_cents), 0) AS total
      FROM pif_custody_transfers WHERE state = 'FAILED'
    `).first();

    const exceptions = [];
    const raise = (code, classification, summary, expected, actual, detail = {}) => {
      exceptions.push({ code, classification, summary, expectedCents: expected, actualCents: actual, detail });
    };

    // ── the penny check ──
    if (!comparable) {
      raise(
        "CUSTODY_RAIL_UNAVAILABLE", CRITICAL,
        "The custody rail did not report a balance, so protected cash could not be reconciled at all.",
        expectedCustodyCents, 0,
        { providerCode: railView?.code || null, providerMessage: railView?.message || null, provider: provider.id }
      );
    } else if (differenceCents !== 0) {
      raise(
        "CUSTODY_BALANCE_MISMATCH", CRITICAL,
        `Protected custody differs from the ledger by ${differenceCents} cent(s). §21: this is never rounded away and never corrected by rewriting the ledger.`,
        expectedCustodyCents, actualCustodyCents,
        {
          fundAvailableCents,
          fundReservedCents,
          guaranteeObligationCents: guarantee.obligationCents,
          earnedNotReleasedCents,
          designatedInPaymentsCents,
          inTransitCents,
          guaranteeCashFromCustodyCents: guaranteeFromCustodyCents,
          guaranteeCashAtClinicCents,
          provider: provider.id
        }
      );
    }

    // ── the ledger's own books have to add up before Stripe is even asked ──
    if (expectedCustodyCents !== ledgerCustodyCents) {
      raise(
        "LEDGER_IDENTITY_MISMATCH", CRITICAL,
        "The §21 identity does not equal the custody account balance, so the fund's own books disagree with themselves.",
        expectedCustodyCents, ledgerCustodyCents,
        { fundAvailableCents, fundReservedCents, guaranteeObligationCents: guarantee.obligationCents, earnedNotReleasedCents, designatedInPaymentsCents, inTransitCents, guaranteeCashFromCustodyCents: guaranteeFromCustodyCents, guaranteeCashAtClinicCents }
      );
    }

    if (journalCents !== ledgerCustodyCents) {
      raise(
        "TRANSFER_JOURNAL_MISMATCH", CRITICAL,
        "Completed custody transfers do not sum to the custody account balance.",
        ledgerCustodyCents, journalCents,
        {}
      );
    }

    if (!integrity.ok) {
      raise(
        "LEDGER_INTEGRITY_FAILED", CRITICAL,
        "The journal is unbalanced or a restricted account is negative.",
        0, 0,
        { unbalanced: integrity.unbalanced, negativeRestricted: integrity.negativeRestricted }
      );
    }

    if (Number(stale?.count || 0) > 0) {
      raise(
        "STALE_TRANSFER_IN_FLIGHT", WARNING,
        `${stale.count} custody movement(s) have been in flight for more than ${staleHours} hours.`,
        0, Number(stale.total || 0),
        { count: Number(stale.count || 0), staleHours }
      );
    }

    if (Number(failedTransfers?.count || 0) > 0) {
      raise(
        "FAILED_TRANSFERS_PRESENT", WARNING,
        `${failedTransfers.count} custody movement(s) failed closed and are waiting to be retried. No cash moved for them.`,
        0, Number(failedTransfers.total || 0),
        { count: Number(failedTransfers.count || 0) }
      );
    }

    if (!status.custodyProtected && status.unprotectedDesignatedCents > 0) {
      raise(
        "DESIGNATED_CASH_NOT_PROTECTED", WARNING,
        `${status.unprotectedDesignatedCents} cent(s) of designated Paw It Forward money are correctly designated in the ledger but not physically protected on this deployment.`,
        0, status.unprotectedDesignatedCents,
        { custodyMode: status.custodyMode, provider: status.provider }
      );
    }

    if (guaranteeCashAtClinicCents !== guaranteeFromCustodyCents) {
      raise(
        "GUARANTEE_CASH_SOURCED_OUTSIDE_CUSTODY", WARNING,
        `${guaranteeCashAtClinicCents - guaranteeFromCustodyCents} cent(s) of guarantee float sitting at clinics were funded from the Payments balance rather than from protected custody. The obligation is recorded either way; the cash did not come out of the protected pot.`,
        guaranteeFromCustodyCents, guaranteeCashAtClinicCents,
        { guaranteeObligationCents: guarantee.obligationCents }
      );
    }

    if (!guarantee.available) {
      raise(
        "GUARANTEE_COMPONENT_UNAVAILABLE", WARNING,
        guarantee.note || "The deposit guarantee component could not be read.",
        0, 0,
        { source: guarantee.source }
      );
    }

    const criticalCount = exceptions.filter((row) => row.classification === CRITICAL).length;
    const completedAt = nowIso();

    const statements = [
      env.DB.prepare(`
        UPDATE pif_reconciliation_runs SET
          status = ?, custody_mode = ?, provider = ?, custody_protected = ?,
          expected_custody_cents = ?, actual_custody_cents = ?, difference_cents = ?,
          fund_available_cents = ?, fund_reserved_cents = ?, guarantee_obligation_cents = ?,
          earned_not_released_cents = ?, designated_in_payments_cents = ?, in_transit_cents = ?,
          guarantee_cash_at_clinic_cents = ?, ledger_custody_cents = ?, transfer_journal_cents = ?,
          unsettled_cents = ?, available_to_sweep_cents = ?, swept_cents = ?, refunded_cents = ?,
          guarantee_source = ?, exception_count = ?, critical_count = ?, notes_json = ?, completed_at = ?
        WHERE id = ?
      `).bind(
        exceptions.length ? "EXCEPTIONS_RAISED" : "OK",
        status.custodyMode, provider.id, status.custodyProtected ? 1 : 0,
        expectedCustodyCents, actualCustodyCents, differenceCents,
        fundAvailableCents, fundReservedCents, guarantee.obligationCents,
        earnedNotReleasedCents, designatedInPaymentsCents, inTransitCents,
        guaranteeCashAtClinicCents, ledgerCustodyCents, journalCents,
        status.unsettledPifContributionsCents, status.availableToSweepPifContributionsCents,
        status.sweptPifContributionsCents, Number(refunded?.total || 0),
        guarantee.source, exceptions.length, criticalCount,
        JSON.stringify({
          railComparable: comparable,
          railMessage: railAnswered ? null : (railView?.message || null),
          guaranteeNote: guarantee.note,
          inFlight: status.inFlight
        }),
        completedAt, runId
      )
    ];

    for (const exception of exceptions) {
      statements.push(env.DB.prepare(`
        INSERT OR IGNORE INTO pif_reconciliation_exceptions (
          id, run_id, code, classification, currency,
          expected_cents, actual_cents, difference_cents, summary, detail_json, status, opened_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)
      `).bind(
        newId("pifexc"), runId, exception.code, exception.classification, currency,
        exception.expectedCents, exception.actualCents, exception.actualCents - exception.expectedCents,
        exception.summary, JSON.stringify(exception.detail || {}), completedAt, completedAt
      ));
    }

    await env.DB.batch(statements);

    if (exceptions.length) {
      await recordAudit(env, {
        actorId: triggeredBy,
        actorRole: "system",
        action: "pif.reconciliation_exceptions",
        subjectType: "pif_reconciliation_run",
        subjectId: runId,
        newState: { criticalCount, exceptionCount: exceptions.length, differenceCents },
        reason: "Reconciliation raised operations cases. Nothing was auto-adjusted."
      });
    }

    const run = await env.DB.prepare("SELECT * FROM pif_reconciliation_runs WHERE id = ? LIMIT 1").bind(runId).first();
    return {
      ok: true,
      run: runFromRow(run),
      exceptions: await exceptionsForRun(env, runId),
      criticalCount
    };
  } catch (error) {
    await env.DB.prepare(`
      UPDATE pif_reconciliation_runs SET status = 'FAILED', error = ?, completed_at = ? WHERE id = ?
    `).bind(String(error?.message || error).slice(0, 500), nowIso(), runId).run();
    return { ok: false, code: "RECONCILIATION_FAILED", message: error?.message || "Reconciliation could not complete.", runId };
  }
}

/* ------------------------------------------------------------ reading --- */

function runFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    runKey: row.run_key,
    scope: row.scope,
    currency: row.currency,
    status: row.status,
    custodyMode: row.custody_mode,
    provider: row.provider,
    custodyProtected: Boolean(row.custody_protected),
    expectedCustodyCents: Number(row.expected_custody_cents || 0),
    actualCustodyCents: Number(row.actual_custody_cents || 0),
    differenceCents: Number(row.difference_cents || 0),
    components: {
      fundAvailableCents: Number(row.fund_available_cents || 0),
      fundReservedCents: Number(row.fund_reserved_cents || 0),
      guaranteeObligationCents: Number(row.guarantee_obligation_cents || 0),
      earnedNotReleasedCents: Number(row.earned_not_released_cents || 0),
      designatedInPaymentsCents: Number(row.designated_in_payments_cents || 0),
      inTransitCents: Number(row.in_transit_cents || 0),
      guaranteeCashAtClinicCents: Number(row.guarantee_cash_at_clinic_cents || 0),
      ledgerCustodyCents: Number(row.ledger_custody_cents || 0),
      transferJournalCents: Number(row.transfer_journal_cents || 0),
      unsettledCents: Number(row.unsettled_cents || 0),
      availableToSweepCents: Number(row.available_to_sweep_cents || 0),
      sweptCents: Number(row.swept_cents || 0),
      refundedCents: Number(row.refunded_cents || 0)
    },
    guaranteeSource: row.guarantee_source,
    exceptionCount: Number(row.exception_count || 0),
    criticalCount: Number(row.critical_count || 0),
    notes: (() => { try { return JSON.parse(row.notes_json || "{}"); } catch { return {}; } })(),
    error: row.error || null,
    triggeredBy: row.triggered_by || null,
    startedAt: row.started_at,
    completedAt: row.completed_at || null
  };
}

function exceptionFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    code: row.code,
    classification: row.classification,
    currency: row.currency,
    expectedCents: Number(row.expected_cents || 0),
    actualCents: Number(row.actual_cents || 0),
    differenceCents: Number(row.difference_cents || 0),
    summary: row.summary,
    detail: (() => { try { return JSON.parse(row.detail_json || "{}"); } catch { return {}; } })(),
    status: row.status,
    investigationNotes: row.investigation_notes || null,
    compensatingTransactionId: row.compensating_transaction_id || null,
    resolvedBy: row.resolved_by || null,
    resolvedAt: row.resolved_at || null,
    openedAt: row.opened_at
  };
}

async function exceptionsForRun(env, runId) {
  if (!runId) return [];
  const result = await env.DB.prepare(
    "SELECT * FROM pif_reconciliation_exceptions WHERE run_id = ? ORDER BY classification ASC, code ASC"
  ).bind(runId).all();
  return result.results.map(exceptionFromRow);
}

export async function listReconciliationRuns(env, { limit = 30 } = {}) {
  if (!hasDatabase(env)) return { runs: [] };
  const result = await env.DB.prepare(
    "SELECT * FROM pif_reconciliation_runs ORDER BY started_at DESC LIMIT ?"
  ).bind(Math.min(Math.max(Math.trunc(Number(limit) || 30), 1), 200)).all();
  return { runs: result.results.map(runFromRow) };
}

export async function getReconciliationRun(env, runId) {
  if (!hasDatabase(env)) return null;
  const row = await env.DB.prepare("SELECT * FROM pif_reconciliation_runs WHERE id = ? LIMIT 1").bind(runId).first();
  if (!row) return null;
  return { run: runFromRow(row), exceptions: await exceptionsForRun(env, runId) };
}

export async function listReconciliationExceptions(env, { status = null, classification = null, limit = 100 } = {}) {
  if (!hasDatabase(env)) return { exceptions: [] };
  const clauses = [];
  const values = [];
  if (status) { clauses.push("status = ?"); values.push(status); }
  if (classification) { clauses.push("classification = ?"); values.push(classification); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await env.DB.prepare(`
    SELECT * FROM pif_reconciliation_exceptions ${where}
    ORDER BY (status = 'OPEN') DESC, classification ASC, opened_at DESC
    LIMIT ?
  `).bind(...values, Math.min(Math.max(Math.trunc(Number(limit) || 100), 1), 500)).all();
  return { exceptions: result.results.map(exceptionFromRow) };
}

/**
 * Move an operations case forward.
 *
 * This is bookkeeping about the investigation, not about the money: no
 * balance changes here, ever. A resolution that claims a correction was made
 * has to point at the compensating journal entry that made it, because
 * "resolved" with nothing to show is how a real loss gets closed as
 * paperwork.
 */
export async function resolveException(env, {
  exceptionId, status, investigationNotes, actorId = null, compensatingTransactionId = null
} = {}) {
  if (!hasDatabase(env)) return DATABASE_REQUIRED;
  const id = cleanString(exceptionId, 120);
  const nextStatus = cleanString(status, 40).toUpperCase();
  const notes = cleanString(investigationNotes, 4000);
  const actor = cleanString(actorId, 120);

  if (!id) return { ok: false, code: "EXCEPTION_REQUIRED", message: "Which exception?" };
  if (!EXCEPTION_STATUSES.includes(nextStatus)) {
    return { ok: false, code: "INVALID_STATUS", message: `Status must be one of ${EXCEPTION_STATUSES.join(", ")}.` };
  }
  if (!notes) {
    return { ok: false, code: "INVESTIGATION_NOTES_REQUIRED", message: "Say what was found. An exception closed without a note is not an investigation." };
  }
  if (!actor) return { ok: false, code: "ACTOR_REQUIRED", message: "A resolution is attributable to a person." };

  const existing = await env.DB.prepare("SELECT * FROM pif_reconciliation_exceptions WHERE id = ? LIMIT 1").bind(id).first();
  if (!existing) return { ok: false, code: "EXCEPTION_NOT_FOUND", message: "That exception does not exist." };

  const resolving = nextStatus.startsWith("RESOLVED_");
  const transactionId = cleanString(compensatingTransactionId, 120) || null;
  if (nextStatus === "RESOLVED_COMPENSATING_ENTRY") {
    if (!transactionId) {
      return {
        ok: false,
        code: "COMPENSATING_ENTRY_REQUIRED",
        message: "Resolving as corrected requires the id of the compensating ledger transaction that corrected it."
      };
    }
    const posting = await env.DB.prepare("SELECT id FROM ledger_transactions WHERE id = ? LIMIT 1").bind(transactionId).first();
    if (!posting) {
      return { ok: false, code: "COMPENSATING_ENTRY_NOT_FOUND", message: "That ledger transaction does not exist." };
    }
  }

  const at = nowIso();
  await env.DB.prepare(`
    UPDATE pif_reconciliation_exceptions
    SET status = ?, investigation_notes = ?, compensating_transaction_id = ?,
        resolved_by = ?, resolved_at = ?, updated_at = ?
    WHERE id = ?
  `).bind(
    nextStatus, notes,
    nextStatus === "RESOLVED_COMPENSATING_ENTRY" ? transactionId : (transactionId || existing.compensating_transaction_id || null),
    resolving ? actor : null,
    resolving ? at : null,
    at, id
  ).run();

  await recordAudit(env, {
    actorId: actor,
    actorRole: "admin",
    action: "pif.reconciliation_exception_updated",
    subjectType: "pif_reconciliation_exception",
    subjectId: id,
    oldState: { status: existing.status },
    newState: { status: nextStatus, compensatingTransactionId: transactionId },
    reason: notes.slice(0, 240)
  });

  const updated = await env.DB.prepare("SELECT * FROM pif_reconciliation_exceptions WHERE id = ? LIMIT 1").bind(id).first();
  return { ok: true, exception: exceptionFromRow(updated) };
}

/* ------------------------------------------------------------ handlers --- */

/** POST /api/admin/pif/reconciliation/runs — run it now. */
export async function handleRunReconciliation(request, env, actor) {
  if (request.method !== "POST") return apiError(405, "METHOD_NOT_ALLOWED", "Use POST to run reconciliation.");
  const body = await request.json().catch(() => ({}));
  const result = await runReconciliation(env, {
    scope: body?.scope === "BACKFILL" ? "BACKFILL" : "MANUAL",
    runKey: body?.runKey,
    triggeredBy: actor?.userId || null
  });
  if (!result.ok) return apiError(result.code === "DATABASE_REQUIRED" ? 503 : 500, result.code, result.message);
  return json(result, { status: result.duplicate ? 200 : 201 });
}

/** GET /api/admin/pif/reconciliation/runs — the run history. */
export async function handleReconciliationRuns(request, env) {
  if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", "Use GET to list reconciliation runs.");
  const url = new URL(request.url);
  return json(await listReconciliationRuns(env, { limit: url.searchParams.get("limit") }));
}

/** GET /api/admin/pif/reconciliation/runs/{id} — one run and its cases. */
export async function handleReconciliationRun(request, env, runId) {
  if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", "Use GET to read a reconciliation run.");
  const found = await getReconciliationRun(env, cleanString(runId, 120));
  if (!found) return apiError(404, "RUN_NOT_FOUND", "That reconciliation run does not exist.");
  return json(found);
}

/** GET /api/admin/pif/reconciliation/exceptions — the open cases. */
export async function handleReconciliationExceptions(request, env) {
  if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", "Use GET to list reconciliation exceptions.");
  const url = new URL(request.url);
  return json(await listReconciliationExceptions(env, {
    status: url.searchParams.get("status"),
    classification: url.searchParams.get("classification"),
    limit: url.searchParams.get("limit")
  }));
}

/** POST /api/admin/pif/reconciliation/exceptions/{id} — move a case forward. */
export async function handleResolveException(request, env, actor, exceptionId) {
  if (request.method !== "POST") return apiError(405, "METHOD_NOT_ALLOWED", "Use POST to update an exception.");
  if (!actor?.userId) return apiError(401, "SIGN_IN_REQUIRED", "A resolution is attributable to a person.");
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return apiError(400, "INVALID_BODY", "Send a JSON body.");
  const result = await resolveException(env, {
    exceptionId,
    status: body.status,
    investigationNotes: body.investigationNotes,
    compensatingTransactionId: body.compensatingTransactionId,
    actorId: actor.userId
  });
  if (!result.ok) {
    const status = result.code === "EXCEPTION_NOT_FOUND" ? 404 : result.code === "DATABASE_REQUIRED" ? 503 : 422;
    return apiError(status, result.code, result.message);
  }
  return json(result);
}

/**
 * The daily cron entry point (§21: reconciliation is daily).
 *
 * `runKey` is the date, so however many times the scheduler fires there is
 * one run per day and one set of cases per day.
 */
export async function reconciliationTick(env, { now = null } = {}) {
  if (!hasDatabase(env)) return DATABASE_REQUIRED;
  const result = await runReconciliation(env, { scope: "DAILY", now: now || nowIso(), triggeredBy: "system:cron" });
  console.log(JSON.stringify({
    event: "pif_reconciliation",
    runId: result.run?.id || result.runId || null,
    status: result.run?.status || "FAILED",
    duplicate: Boolean(result.duplicate),
    differenceCents: result.run?.differenceCents ?? null,
    criticalCount: result.run?.criticalCount ?? null
  }));
  return result;
}
