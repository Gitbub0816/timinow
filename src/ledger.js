/**
 * The double-entry subledger.
 *
 * Every figure Tími reports about the Paw It Forward fund — available,
 * reserved, consumed — is a sum over `ledger_entries`. There is deliberately
 * no `fund_balance` column to read: a mutable counter cannot be audited,
 * cannot be rebuilt after a bug, and answers "how did it get to this number"
 * with nothing at all.
 *
 * Two rules hold everywhere in this file:
 *
 *   1. Every transaction balances. Debits equal credits, or the write is
 *      refused. An unbalanced journal is not a smaller problem than a wrong
 *      number; it is the same problem, discovered later.
 *
 *   2. Every transaction carries an idempotency key derived from the business
 *      event, not from the request. A Stripe webhook redelivered an hour
 *      later computes the same key, the INSERT is ignored, and revenue is
 *      not recognized twice.
 */

import { hasDatabase } from "./db.js";

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** Accounts whose money is not Tími's to spend. Mirrors ledger_accounts.restricted. */
export const RESTRICTED_ACCOUNTS = new Set([
  "fund_available",
  "fund_reserved",
  "contribution_refunds_payable",
  "clinic_payable"
]);

/**
 * Post one balanced journal transaction.
 *
 * `lines` is an array of `{ account, debit }` or `{ account, credit }` in
 * whole cents. Returns `{ ok: true, transactionId, duplicate }` — `duplicate`
 * true means this exact business event was already posted and nothing
 * changed, which is a success, not an error.
 */
export async function postTransaction(env, {
  kind,
  idempotencyKey,
  lines,
  currency = "usd",
  occurredAt,
  paymentOrderId = null,
  contributionId = null,
  reservationId = null,
  intakeId = null,
  tenantId = null,
  stripeEventId = null,
  memo = null,
  createdBy = null
}) {
  if (!hasDatabase(env)) return { ok: false, code: "DATABASE_REQUIRED", message: "D1 is required to post to the ledger." };
  if (!kind) throw new Error("postTransaction requires a kind.");
  if (!idempotencyKey) throw new Error("postTransaction requires an idempotencyKey — without one a redelivered webhook posts twice.");
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new Error("postTransaction requires at least two lines; a single-sided entry is not double-entry bookkeeping.");
  }

  let debits = 0;
  let credits = 0;
  const prepared = lines.map((line) => {
    const debit = Math.trunc(Number(line.debit) || 0);
    const credit = Math.trunc(Number(line.credit) || 0);
    if (debit < 0 || credit < 0) throw new Error(`Negative amount on ${line.account}. Reverse the entry instead of negating it.`);
    if ((debit > 0) === (credit > 0)) {
      throw new Error(`Line on ${line.account} must be exactly one of debit or credit.`);
    }
    debits += debit;
    credits += credit;
    return { account: line.account, debit, credit };
  });

  if (debits !== credits) {
    throw new Error(`Unbalanced ledger transaction "${kind}": debits ${debits} ≠ credits ${credits}.`);
  }
  if (debits === 0) throw new Error(`Zero-value ledger transaction "${kind}".`);

  const transactionId = newId("ltx");
  const statements = [
    env.DB.prepare(`
      INSERT OR IGNORE INTO ledger_transactions (
        id, kind, occurred_at, currency, payment_order_id, contribution_id, reservation_id,
        intake_id, tenant_id, stripe_event_id, idempotency_key, memo, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      transactionId, kind, occurredAt || new Date().toISOString(), currency,
      paymentOrderId, contributionId, reservationId, intakeId, tenantId,
      stripeEventId, idempotencyKey, memo, createdBy
    )
  ];
  for (const line of prepared) {
    // Each entry is guarded by EXISTS on its own transaction row: if the
    // INSERT OR IGNORE above was ignored as a duplicate, the entries must not
    // be written either — otherwise a redelivery would attach a second set of
    // lines to the first delivery's transaction and unbalance it.
    statements.push(env.DB.prepare(`
      INSERT INTO ledger_entries (id, transaction_id, account_code, debit_cents, credit_cents, currency)
      SELECT ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM ledger_transactions WHERE id = ?)
    `).bind(newId("lent"), transactionId, line.account, line.debit, line.credit, currency, transactionId));
  }

  const results = await env.DB.batch(statements);
  const inserted = Number(results[0]?.meta?.changes || 0) > 0;
  if (!inserted) {
    const existing = await env.DB.prepare("SELECT id FROM ledger_transactions WHERE idempotency_key = ? LIMIT 1")
      .bind(idempotencyKey).first();
    return { ok: true, duplicate: true, transactionId: existing?.id || null };
  }
  return { ok: true, duplicate: false, transactionId };
}

/**
 * The balance of one account, in cents, in its own natural direction.
 *
 * A liability like `fund_available` is credit-normal, so credits raise it and
 * debits lower it; returning the number in natural direction means callers
 * never carry a sign table of their own.
 */
export async function accountBalance(env, accountCode) {
  if (!hasDatabase(env)) return 0;
  const account = await env.DB.prepare("SELECT normal_balance FROM ledger_accounts WHERE code = ? LIMIT 1")
    .bind(accountCode).first();
  if (!account) throw new Error(`Unknown ledger account "${accountCode}".`);
  const row = await env.DB.prepare(`
    SELECT COALESCE(SUM(debit_cents), 0) AS debits, COALESCE(SUM(credit_cents), 0) AS credits
    FROM ledger_entries WHERE account_code = ?
  `).bind(accountCode).first();
  const debits = Number(row?.debits || 0);
  const credits = Number(row?.credits || 0);
  return account.normal_balance === "debit" ? debits - credits : credits - debits;
}

/**
 * Every account balance at once, for the operations dashboard and the daily
 * reconciliation. One query rather than a dozen round trips.
 */
export async function allBalances(env) {
  if (!hasDatabase(env)) return {};
  const result = await env.DB.prepare(`
    SELECT a.code, a.class, a.normal_balance, a.restricted,
           COALESCE(SUM(e.debit_cents), 0) AS debits,
           COALESCE(SUM(e.credit_cents), 0) AS credits
    FROM ledger_accounts a
    LEFT JOIN ledger_entries e ON e.account_code = a.code
    GROUP BY a.code
  `).all();
  const balances = {};
  for (const row of result.results) {
    const debits = Number(row.debits || 0);
    const credits = Number(row.credits || 0);
    balances[row.code] = {
      class: row.class,
      restricted: Boolean(row.restricted),
      balanceCents: row.normal_balance === "debit" ? debits - credits : credits - debits
    };
  }
  return balances;
}

/**
 * What the fund actually holds.
 *
 * `available` is what a new sponsorship may reserve against. It is computed
 * from postings, never cached — see the file header.
 */
export async function fundSummary(env) {
  const balances = await allBalances(env);
  const at = (code) => balances[code]?.balanceCents || 0;
  return {
    availableCents: at("fund_available"),
    reservedCents: at("fund_reserved"),
    consumedLifetimeCents: at("sponsored_access_revenue"),
    refundsPayableCents: at("contribution_refunds_payable"),
    matchLifetimeCents: at("timinow_program_match"),
    processorFeesCents: at("processor_fee_expense")
  };
}

/**
 * Prove the journal is sound.
 *
 * Two questions, both of which must answer "none": is any transaction
 * unbalanced, and is any restricted account negative? A restricted account
 * below zero means Tími has spent money it was holding for somebody else,
 * which is the single worst outcome this subledger exists to prevent.
 */
export async function ledgerIntegrity(env) {
  if (!hasDatabase(env)) return { ok: true, unbalanced: [], negativeRestricted: [] };
  const unbalanced = await env.DB.prepare(`
    SELECT t.id, t.kind,
           COALESCE(SUM(e.debit_cents), 0) AS debits,
           COALESCE(SUM(e.credit_cents), 0) AS credits
    FROM ledger_transactions t
    LEFT JOIN ledger_entries e ON e.transaction_id = t.id
    GROUP BY t.id
    HAVING debits <> credits
  `).all();

  const balances = await allBalances(env);
  const negativeRestricted = Object.entries(balances)
    .filter(([, value]) => value.restricted && value.balanceCents < 0)
    .map(([code, value]) => ({ code, balanceCents: value.balanceCents }));

  return {
    ok: unbalanced.results.length === 0 && negativeRestricted.length === 0,
    unbalanced: unbalanced.results,
    negativeRestricted
  };
}

/** Append one audit event. Never updated, never deleted. */
export async function recordAudit(env, { actorId, actorRole, action, subjectType, subjectId, oldState, newState, reason, requestId }) {
  if (!hasDatabase(env)) return null;
  const id = newId("audit");
  await env.DB.prepare(`
    INSERT INTO audit_events (
      id, actor_id, actor_role, action, subject_type, subject_id,
      old_state_json, new_state_json, reason, request_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, actorId || null, actorRole || null, action, subjectType, subjectId || null,
    oldState === undefined ? null : JSON.stringify(oldState),
    newState === undefined ? null : JSON.stringify(newState),
    reason || null, requestId || null
  ).run();
  return id;
}

/**
 * Claim a Stripe event for processing.
 *
 * Returns false when the event has already been processed, which is the
 * normal case for a redelivery and not an error. The claim and the check are
 * one INSERT so two concurrent deliveries cannot both win.
 */
export async function claimStripeEvent(env, { id, type, objectId }) {
  if (!hasDatabase(env)) return true;
  const result = await env.DB.prepare(`
    INSERT OR IGNORE INTO stripe_webhook_events (stripe_event_id, type, object_id, status, attempts)
    VALUES (?, ?, ?, 'processing', 1)
  `).bind(id, type, objectId || null).run();
  if (Number(result?.meta?.changes || 0) > 0) return true;
  const existing = await env.DB.prepare("SELECT status FROM stripe_webhook_events WHERE stripe_event_id = ? LIMIT 1")
    .bind(id).first();
  // A previous attempt that failed may be retried; a processed one may not.
  return existing?.status === "failed";
}

export async function completeStripeEvent(env, id, { status = "processed", error = null } = {}) {
  if (!hasDatabase(env)) return;
  await env.DB.prepare(`
    UPDATE stripe_webhook_events
    SET status = ?, error = ?, completed_at = CURRENT_TIMESTAMP, attempts = attempts + 1
    WHERE stripe_event_id = ?
  `).bind(status, error, id).run();
}
