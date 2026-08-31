/**
 * Who may do what in the operator console.
 *
 * Until now the console had one question — is this a platform administrator —
 * and one answer. That was honest when everything the console did was
 * reading. It stopped being adequate the moment the same screens could waive
 * a clinic's fees for the life of its participation, change a deposit
 * election away from what a signed contract says, or move money out of
 * restricted custody.
 *
 * Five roles, per the addendum. Every operator keeps `SUPPORT_ADMIN`'s read
 * access; the others add narrow authority over one domain. `SUPER_ADMIN`
 * exists for the genuinely exceptional case and is deliberately the only
 * role that can do several of these things at once.
 *
 * Nothing here is a substitute for the audit trail. A role decides whether an
 * action is refused; `audit_events` records that it happened, who did it, and
 * why — and that is what somebody reads a year later when a clinic asks how
 * its rate changed.
 */

import { hasDatabase } from "./db.js";
import { isPlatformAdmin } from "./tenancy.js";

export const ADMIN_ROLES = Object.freeze([
  "SUPPORT_ADMIN",
  "CLINIC_OPERATIONS_ADMIN",
  "FINANCE_ADMIN",
  "COMPLIANCE_ADMIN",
  "SUPER_ADMIN"
]);

/**
 * The actions worth gating, and who holds them.
 *
 * Read as: this action requires one of these roles. An action absent from
 * this table needs only platform-administrator status, which is what every
 * ordinary console read has always needed.
 */
export const ACTION_ROLES = Object.freeze({
  // Clinic operations: configuration that follows from a signed document.
  "clinic.profile.edit": ["CLINIC_OPERATIONS_ADMIN", "SUPER_ADMIN"],
  "clinic.deposit_election.set": ["CLINIC_OPERATIONS_ADMIN", "SUPER_ADMIN"],
  "clinic.application.review": ["CLINIC_OPERATIONS_ADMIN", "SUPER_ADMIN"],
  "clinic.lifecycle.set": ["CLINIC_OPERATIONS_ADMIN", "COMPLIANCE_ADMIN", "SUPER_ADMIN"],

  // Commercial terms. A fee change and a founding grant are contractual
  // commitments, not settings.
  "clinic.pricing.set": ["SUPER_ADMIN"],
  "clinic.founding.grant": ["SUPER_ADMIN"],
  "clinic.founding.revoke_for_cause": ["COMPLIANCE_ADMIN", "SUPER_ADMIN"],
  "clinic.founding.restore": ["SUPER_ADMIN"],

  // Money.
  "fund.ledger.adjust": ["FINANCE_ADMIN", "SUPER_ADMIN"],
  "fund.treasury.release": ["FINANCE_ADMIN", "SUPER_ADMIN"],
  "fund.reconciliation.resolve": ["FINANCE_ADMIN", "SUPER_ADMIN"],
  "deposit_guarantee.override": ["FINANCE_ADMIN", "SUPER_ADMIN"],

  // Program integrity.
  "program.suspend": ["COMPLIANCE_ADMIN", "SUPER_ADMIN"],
  "hardship.appeal.decide": ["COMPLIANCE_ADMIN", "SUPER_ADMIN"],
  "clinic.restore_after_cause": ["SUPER_ADMIN"]
});

/**
 * Actions where one person acting alone is the risk.
 *
 * A second operator must approve before these take effect. The addendum asks
 * for dual approval "where practical"; these are the ones where it is, and
 * where the cost of being wrong is somebody else's money or a commitment
 * that outlives whoever made it.
 */
export const DUAL_APPROVAL_ACTIONS = Object.freeze(new Set([
  "fund.ledger.adjust",
  "fund.treasury.release",
  "clinic.pricing.set",
  "clinic.founding.grant",
  "clinic.restore_after_cause",
  "deposit_guarantee.override"
]));

/**
 * The roles this operator actually holds.
 *
 * A platform administrator with no explicit rows is a SUPPORT_ADMIN: read
 * everything, change nothing that matters. That is the safe direction for an
 * existing operator to land in when this table arrives beneath them, and it
 * means granting real authority is always a deliberate act.
 */
export async function rolesFor(env, actor) {
  if (!(await isPlatformAdmin(env, actor))) return [];
  if (!hasDatabase(env)) return ["SUPPORT_ADMIN"];

  const result = await env.DB.prepare(
    "SELECT role FROM admin_role_assignments WHERE clerk_user_id = ? AND revoked_at IS NULL"
  ).bind(actor.userId).all().catch(() => ({ results: [] }));

  const roles = new Set(result.results.map((row) => row.role).filter((role) => ADMIN_ROLES.includes(role)));
  roles.add("SUPPORT_ADMIN");
  // Super administrators hold everything; saying so here means no call site
  // has to remember to check for it alongside whatever else it needs.
  if (roles.has("SUPER_ADMIN")) for (const role of ADMIN_ROLES) roles.add(role);
  return [...roles];
}

/**
 * Whether this operator may perform this action.
 *
 * Returns a decision object rather than a boolean so a refusal can say which
 * role would have been required — an operator who is told only "forbidden"
 * files a support ticket; one told "this needs FINANCE_ADMIN" asks the right
 * person.
 */
export async function authorizeAdminAction(env, actor, action) {
  const roles = await rolesFor(env, actor);
  if (!roles.length) {
    return { allowed: false, code: "ADMIN_REQUIRED", message: "This console is limited to platform operators.", roles, action };
  }

  const required = ACTION_ROLES[action];
  if (!required) return { allowed: true, roles, action, requiresDualApproval: false };

  const held = required.some((role) => roles.includes(role));
  if (!held) {
    return {
      allowed: false,
      code: "ADMIN_ROLE_REQUIRED",
      message: `That action requires ${required.join(" or ")}.`,
      roles,
      action,
      requiredRoles: required
    };
  }
  return { allowed: true, roles, action, requiresDualApproval: DUAL_APPROVAL_ACTIONS.has(action) };
}

/**
 * Record one operator's approval of a high-risk action, and say whether it
 * may now proceed.
 *
 * Two different people, enforced by the unique index on
 * (request_id, approver): approving your own request twice is the failure
 * mode this exists to prevent, and it is the one most likely to be reached
 * by accident.
 */
export async function recordApproval(env, { requestId, action, actorId, payloadHash, note }) {
  if (!hasDatabase(env)) return { ok: false, code: "DATABASE_REQUIRED", message: "D1 is required for dual approval." };
  if (!requestId || !action || !actorId) {
    return { ok: false, code: "APPROVAL_FIELDS_REQUIRED", message: "An approval needs a request, an action, and an approver." };
  }

  await env.DB.prepare(`
    INSERT OR IGNORE INTO admin_approvals (id, request_id, action, approver_id, payload_hash, note)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    `apprv_${crypto.randomUUID().replaceAll("-", "")}`,
    requestId, action, actorId, payloadHash || null, note || null
  ).run();

  const row = await env.DB.prepare(
    "SELECT COUNT(DISTINCT approver_id) AS approvers FROM admin_approvals WHERE request_id = ? AND action = ?"
  ).bind(requestId, action).first();
  const approvers = Number(row?.approvers || 0);
  const required = DUAL_APPROVAL_ACTIONS.has(action) ? 2 : 1;
  return { ok: true, approvers, required, satisfied: approvers >= required };
}

/** Whether a high-risk action has collected the approvals it needs. */
export async function approvalSatisfied(env, { requestId, action }) {
  if (!DUAL_APPROVAL_ACTIONS.has(action)) return true;
  if (!hasDatabase(env)) return false;
  const row = await env.DB.prepare(
    "SELECT COUNT(DISTINCT approver_id) AS approvers FROM admin_approvals WHERE request_id = ? AND action = ?"
  ).bind(requestId, action).first();
  return Number(row?.approvers || 0) >= 2;
}
