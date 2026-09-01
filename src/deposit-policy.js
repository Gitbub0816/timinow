/**
 * The clinic's appointment-deposit election.
 *
 * Addendum §8 makes this a required field on the internal admin clinic
 * profile, and it is the most consequential single-select in the product: it
 * decides whether a customer is asked for money before they can be seen,
 * whether the program commits cash on their behalf, and what a clinic may
 * keep if the appointment does not happen.
 *
 * ───────────────────────────────────────────────────────── four options ──
 *
 *   NO_DEPOSIT_REQUIRED       "Will not require a deposit"
 *   WAIVE_FOR_PAW_IT_FORWARD  "Waive deposit for Paw It Forward"
 *   PAW_IT_FORWARD_GUARANTEE  "Accept Paw It Forward deposit guarantee"
 *   CUSTOMER_REQUIRED         "Customer must pay clinic deposit"
 *
 * The executed clinic agreement offers three: OPTION A (Waiver), OPTION B
 * (Paw It Forward Deposit Guarantee), OPTION C (Customer-Funded). §8 adds
 * the fourth for the ordinary factual case of a clinic that has no
 * appointment deposit at all, and says the next contract revision must carry
 * it so that contract and profile map one to one.
 *
 * Until that revision ships, this file holds the seam shut. A clinic that
 * signed the three-option paper cannot end up recorded as having elected the
 * fourth: `contract_offers_no_deposit_option` says whether the paper that
 * clinic signed even contained the box, and electing NO_DEPOSIT_REQUIRED
 * against a paper that did not is refused unless a signed amendment or an
 * authorized written instruction — with a document id — is named. The
 * difference between "the clinic told us it has no deposit" and "the clinic
 * initialled a box saying so" is exactly the kind of difference that gets
 * argued about eighteen months later, so it is stored, not inferred.
 *
 * ──────────────────────────────────────────────────────────── authority ──
 *
 * §8: this is set by a ClearKey admin from the executed documentation. It is
 * *not* a clinic-portal toggle. `clinicPortalProjection` is the read-only
 * view the portal gets; there is deliberately no writer in this file that a
 * clinic-authenticated route could call.
 *
 * ────────────────────────────────────────────────────────── versioning ──
 *
 * Policies are append-only. Saving a change supersedes the current row and
 * writes a new version; nothing ever updates an election in place. A booking
 * snapshots the row id it was quoted under (§25), so a clinic that changes
 * its policy in June cannot change what a customer was told in March.
 */

import { hasDatabase } from "./db.js";
import { recordAudit } from "./ledger.js";

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

function text(value, maxLength = 240) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function bool(value) {
  return value === true || value === 1 || value === "1";
}

function intOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? number : null;
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
  message: "D1 is required to read or write a clinic deposit policy."
});

/* ═══════════════════════════════════════════════════ the enumerations ═══ */

/** §8, in §8's order. The order is the order of the radio group. */
export const DEPOSIT_ELECTIONS = Object.freeze([
  "NO_DEPOSIT_REQUIRED",
  "WAIVE_FOR_PAW_IT_FORWARD",
  "PAW_IT_FORWARD_GUARANTEE",
  "CUSTOMER_REQUIRED"
]);

/** The exact §8 UI labels. Consoles render these; they do not invent wording. */
export const DEPOSIT_ELECTION_LABELS = Object.freeze({
  NO_DEPOSIT_REQUIRED: "Will not require a deposit",
  WAIVE_FOR_PAW_IT_FORWARD: "Waive deposit for Paw It Forward",
  PAW_IT_FORWARD_GUARANTEE: "Accept Paw It Forward deposit guarantee",
  CUSTOMER_REQUIRED: "Customer must pay clinic deposit"
});

/** The field label itself, from §8. */
export const DEPOSIT_ELECTION_FIELD_LABEL = "Paw It Forward appointment deposit policy";

export const DEPOSIT_AMOUNT_TYPES = Object.freeze([
  "NONE", "FIXED", "VARIABLE", "CLINIC_CONFIRMS_PER_REQUEST"
]);

export const DEPOSIT_REFUNDABILITY = Object.freeze([
  "FULLY_REFUNDABLE", "REFUNDABLE_UNTIL_CUTOFF", "NONREFUNDABLE", "VARIABLE_BY_BOOKING", "NOT_APPLICABLE"
]);

export const DEPOSIT_NO_SHOW_FORFEIT_TYPES = Object.freeze([
  "NONE", "FULL", "PARTIAL", "VARIABLE", "NOT_APPLICABLE"
]);

export const DEPOSIT_ELECTION_SOURCES = Object.freeze([
  "EXECUTED_AGREEMENT", "SIGNED_AMENDMENT", "AUTHORIZED_WRITTEN_INSTRUCTION", "ADMIN_MIGRATION"
]);

/**
 * Which box on the executed agreement (§15) corresponds to which election.
 *
 * `OPTION_D_NO_DEPOSIT_REQUIRED` does not exist on the current revision. It
 * is listed so that the day the revised agreement ships, the mapping is
 * already one-to-one and nothing here needs rewriting — only the clinic's
 * `contractOffersNoDepositOption` flips to true.
 */
export const CONTRACT_OPTIONS = Object.freeze({
  OPTION_A_WAIVER: "WAIVE_FOR_PAW_IT_FORWARD",
  OPTION_B_PAW_IT_FORWARD_GUARANTEE: "PAW_IT_FORWARD_GUARANTEE",
  OPTION_C_CUSTOMER_FUNDED: "CUSTOMER_REQUIRED",
  OPTION_D_NO_DEPOSIT_REQUIRED: "NO_DEPOSIT_REQUIRED"
});

/**
 * Other spellings of the same three boxes.
 *
 * `clinic_contracts.deposit_election` (migration 0017) records the executed
 * §15 election in its own vocabulary. Rather than have two files disagree
 * about what a contract says — which is exactly the kind of disagreement §8
 * calls a finding rather than a merge — anything in this table is accepted
 * wherever a contract option is given, and normalized to the OPTION_* name.
 */
export const CONTRACT_OPTION_ALIASES = Object.freeze({
  OPTION_A: "OPTION_A_WAIVER",
  OPTION_B: "OPTION_B_PAW_IT_FORWARD_GUARANTEE",
  OPTION_C: "OPTION_C_CUSTOMER_FUNDED",
  OPTION_D: "OPTION_D_NO_DEPOSIT_REQUIRED",
  WAIVER: "OPTION_A_WAIVER",
  WAIVE_FOR_PAW_IT_FORWARD: "OPTION_A_WAIVER",
  PAW_IT_FORWARD_GUARANTEE: "OPTION_B_PAW_IT_FORWARD_GUARANTEE",
  ACCEPT_PIF_GUARANTEE: "OPTION_B_PAW_IT_FORWARD_GUARANTEE",
  CUSTOMER_REQUIRED: "OPTION_C_CUSTOMER_FUNDED",
  CUSTOMER_FUNDED: "OPTION_C_CUSTOMER_FUNDED",
  CUSTOMER_FUNDED_DEPOSIT: "OPTION_C_CUSTOMER_FUNDED",
  NO_DEPOSIT_REQUIRED: "OPTION_D_NO_DEPOSIT_REQUIRED"
});

/** Normalize whichever spelling a caller has into an OPTION_* name. */
export function normalizeContractOption(value) {
  const raw = text(value, 60).toUpperCase();
  if (!raw) return null;
  if (raw === "NOT_RECORDED") return "NOT_RECORDED";
  if (Object.prototype.hasOwnProperty.call(CONTRACT_OPTIONS, raw)) return raw;
  return CONTRACT_OPTION_ALIASES[raw] || raw;
}

export const CONTRACT_OPTION_FOR_ELECTION = Object.freeze({
  WAIVE_FOR_PAW_IT_FORWARD: "OPTION_A_WAIVER",
  PAW_IT_FORWARD_GUARANTEE: "OPTION_B_PAW_IT_FORWARD_GUARANTEE",
  CUSTOMER_REQUIRED: "OPTION_C_CUSTOMER_FUNDED",
  NO_DEPOSIT_REQUIRED: "OPTION_D_NO_DEPOSIT_REQUIRED"
});

/**
 * The elections the *current agreement template* offers on its face.
 *
 * All four, since the 2026 revision added OPTION D — NO APPOINTMENT DEPOSIT
 * REQUIRED (docs/contracts/TimiNOW_Clinic_Platform_Agreement_2026.docx).
 *
 * This is the template, not any particular clinic's signed paper. A clinic
 * that executed the earlier three-option version still cannot evidence
 * Option D from its own agreement, which is what the per-clinic
 * `contract_offers_no_deposit_option` column records — set it when a clinic
 * signs the revised paper. That clinic needs an amendment or an authorized
 * written instruction instead, and the validation below enforces exactly
 * that rather than trusting this list.
 */
export const ELECTIONS_IN_CURRENT_CONTRACT = Object.freeze([
  "WAIVE_FOR_PAW_IT_FORWARD", "PAW_IT_FORWARD_GUARANTEE", "CUSTOMER_REQUIRED", "NO_DEPOSIT_REQUIRED"
]);

/* ═══════════════════════════════════════════════════════ money as text ═══ */

/**
 * "$75", "$7.50" — never "75.00 USD" and never a float.
 *
 * The customer-facing copy in §10 is written in whole dollars, so whole
 * dollars print without a decimal and anything else prints with two.
 */
export function formatMoney(cents, currency = "usd") {
  const amount = Math.trunc(Number(cents) || 0);
  const symbol = String(currency).toLowerCase() === "usd" ? "$" : "";
  const whole = amount % 100 === 0;
  const body = whole ? String(amount / 100) : (amount / 100).toFixed(2);
  return symbol ? `${symbol}${body}` : `${body} ${String(currency).toUpperCase()}`;
}

/* ═══════════════════════════════════════════════════════════ row shape ═══ */

function policyFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    version: Number(row.version),
    pawItForwardEnabled: Boolean(row.paw_it_forward_enabled),
    election: row.paw_it_forward_deposit_policy,
    electionLabel: DEPOSIT_ELECTION_LABELS[row.paw_it_forward_deposit_policy] || null,
    appointmentDepositRequiredNormally: Boolean(row.appointment_deposit_required_normally),
    appointmentDepositAmountType: row.appointment_deposit_amount_type,
    appointmentDepositFixedAmountCents: row.appointment_deposit_fixed_amount_cents === null
      ? null : Number(row.appointment_deposit_fixed_amount_cents),
    depositRefundability: row.deposit_refundability,
    depositCancellationCutoffMinutes: row.deposit_cancellation_cutoff_minutes === null
      ? null : Number(row.deposit_cancellation_cutoff_minutes),
    depositNoShowForfeitType: row.deposit_no_show_forfeit_type,
    depositNoShowForfeitAmountCents: row.deposit_no_show_forfeit_amount_cents === null
      ? null : Number(row.deposit_no_show_forfeit_amount_cents),
    depositPolicyCustomerCopy: row.deposit_policy_customer_copy,
    depositPolicyInternalNotes: row.deposit_policy_internal_notes,
    depositGuaranteeLimitCents: row.deposit_guarantee_limit_cents === null
      ? null : Number(row.deposit_guarantee_limit_cents),
    currency: row.currency || "usd",
    depositElectionSource: row.deposit_election_source,
    depositElectionEffectiveAt: row.deposit_election_effective_at,
    depositElectionVerifiedByAdminUserId: row.deposit_election_verified_by_admin_user_id,
    depositElectionSourceDocumentId: row.deposit_election_source_document_id,
    contractElectionOption: row.contract_election_option,
    contractOffersNoDepositOption: Boolean(row.contract_offers_no_deposit_option),
    changeReason: row.change_reason,
    supersededAt: row.superseded_at,
    supersededByPolicyId: row.superseded_by_policy_id,
    createdBy: row.created_by,
    createdAt: row.created_at
  };
}

/* ══════════════════════════════════════════════════════════ validation ═══ */

function fail(code, message, details) {
  return { ok: false, status: 422, code, message, ...(details ? { details } : {}) };
}

/**
 * §8's validation block, in §8's order, plus the two rules that come from the
 * contract rather than from the addendum.
 *
 * Returns `{ ok: true, normalized }` or a refusal with a code the console can
 * map to the field that is wrong. Every refusal is deliberate; none of them
 * is a shape check that a UI could have done, because the UI is not the last
 * thing to touch this row.
 */
export function validateDepositPolicy(input = {}, {
  pawItForwardEnabled = true,
  contractElectionOption = null,
  contractOffersNoDepositOption = false
} = {}) {
  const enabled = pawItForwardEnabled !== false;
  const election = text(input.election || input.pawItForwardDepositPolicy, 40).toUpperCase();

  // Acceptance test 14. A participating clinic without an election is not a
  // clinic with a default — it is a clinic nobody has read the contract for.
  if (!election) {
    return enabled
      ? fail("DEPOSIT_ELECTION_REQUIRED",
          `A Paw It Forward-enabled clinic cannot be saved without a "${DEPOSIT_ELECTION_FIELD_LABEL}" election.`)
      : fail("DEPOSIT_ELECTION_REQUIRED", "A deposit election is required.");
  }
  if (!DEPOSIT_ELECTIONS.includes(election)) {
    return fail("INVALID_DEPOSIT_ELECTION", `Election must be one of ${DEPOSIT_ELECTIONS.join(", ")}.`);
  }

  const amountType = text(input.appointmentDepositAmountType, 40).toUpperCase() || "NONE";
  if (!DEPOSIT_AMOUNT_TYPES.includes(amountType)) {
    return fail("INVALID_DEPOSIT_AMOUNT_TYPE", `Amount type must be one of ${DEPOSIT_AMOUNT_TYPES.join(", ")}.`);
  }
  const refundability = text(input.depositRefundability, 40).toUpperCase() || "NOT_APPLICABLE";
  if (!DEPOSIT_REFUNDABILITY.includes(refundability)) {
    return fail("INVALID_DEPOSIT_REFUNDABILITY", `Refundability must be one of ${DEPOSIT_REFUNDABILITY.join(", ")}.`);
  }
  const forfeitType = text(input.depositNoShowForfeitType, 40).toUpperCase() || "NOT_APPLICABLE";
  if (!DEPOSIT_NO_SHOW_FORFEIT_TYPES.includes(forfeitType)) {
    return fail("INVALID_DEPOSIT_FORFEIT_TYPE", `No-show forfeiture must be one of ${DEPOSIT_NO_SHOW_FORFEIT_TYPES.join(", ")}.`);
  }

  const fixedAmount = intOrNull(input.appointmentDepositFixedAmountCents);
  const forfeitAmount = intOrNull(input.depositNoShowForfeitAmountCents);
  const cutoffMinutes = intOrNull(input.depositCancellationCutoffMinutes);
  const guaranteeLimit = intOrNull(input.depositGuaranteeLimitCents);
  if (fixedAmount !== null && fixedAmount < 0) return fail("INVALID_DEPOSIT_AMOUNT", "A deposit amount cannot be negative.");
  if (forfeitAmount !== null && forfeitAmount < 0) return fail("INVALID_FORFEIT_AMOUNT", "A forfeiture amount cannot be negative.");
  if (cutoffMinutes !== null && cutoffMinutes < 0) return fail("INVALID_CUTOFF", "A cancellation cutoff cannot be negative.");
  if (guaranteeLimit !== null && guaranteeLimit < 0) return fail("INVALID_GUARANTEE_LIMIT", "A guarantee limit cannot be negative.");

  const requiredNormally = input.appointmentDepositRequiredNormally === undefined
    ? election !== "NO_DEPOSIT_REQUIRED"
    : bool(input.appointmentDepositRequiredNormally);

  // §8: NO_DEPOSIT_REQUIRED normally requires amount type NONE. There is no
  // deposit, so there is nothing to size, refund, or forfeit — and this is
  // what keeps it distinct from a clinic that has a deposit and waives it.
  if (election === "NO_DEPOSIT_REQUIRED") {
    if (amountType !== "NONE") {
      return fail("NO_DEPOSIT_AMOUNT_MUST_BE_NONE",
        "\"Will not require a deposit\" means there is no deposit: amount type must be NONE. A clinic that has a deposit and waives it for the program is WAIVE_FOR_PAW_IT_FORWARD.");
    }
    if (requiredNormally) {
      return fail("NO_DEPOSIT_CANNOT_REQUIRE_NORMALLY",
        "\"Will not require a deposit\" cannot be combined with a clinic that ordinarily requires one — that is WAIVE_FOR_PAW_IT_FORWARD.");
    }
  } else if (!requiredNormally) {
    // The other three all describe a clinic that has an ordinary deposit.
    return fail("DEPOSIT_REQUIRED_NORMALLY_EXPECTED",
      "This election describes a clinic that ordinarily requires an appointment deposit; set appointmentDepositRequiredNormally.");
  }

  // §8: WAIVE_FOR_PAW_IT_FORWARD may keep the clinic's normal amount, on
  // purpose. The deposit still applies to everyone outside the program, and
  // erasing the number here would make the profile lie about the clinic.

  // §8: a guarantee requires a determinable amount before funding.
  if (election === "PAW_IT_FORWARD_GUARANTEE") {
    if (amountType === "NONE") {
      return fail("GUARANTEE_AMOUNT_REQUIRED",
        "A Paw It Forward deposit guarantee needs a determinable deposit amount; amount type NONE gives nothing to guarantee.");
    }
    if (amountType === "FIXED" && (fixedAmount === null || fixedAmount <= 0)) {
      return fail("GUARANTEE_AMOUNT_REQUIRED", "A FIXED deposit needs appointmentDepositFixedAmountCents above zero.");
    }
  }

  // §8: CUSTOMER_REQUIRED requires amount/policy before confirmation, or an
  // explicit pause for clinic confirmation. A per-request amount is allowed
  // — it is what many clinics actually do — but only with disclosure copy,
  // because the customer has to be told something true before they confirm.
  if (election === "CUSTOMER_REQUIRED") {
    if (amountType === "NONE") {
      return fail("CUSTOMER_DEPOSIT_AMOUNT_REQUIRED",
        "\"Customer must pay clinic deposit\" needs a deposit to pay; amount type NONE contradicts it.");
    }
    if (amountType === "FIXED" && (fixedAmount === null || fixedAmount <= 0)) {
      return fail("CUSTOMER_DEPOSIT_AMOUNT_REQUIRED", "A FIXED customer-funded deposit needs an amount above zero.");
    }
    if (amountType !== "FIXED" && !text(input.depositPolicyCustomerCopy, 2000)) {
      return fail("CUSTOMER_DEPOSIT_DISCLOSURE_REQUIRED",
        "A customer-funded deposit whose amount is not fixed must carry disclosure copy, so the booking can pause for clinic confirmation instead of quoting a number nobody has.");
    }
  }

  if (amountType === "FIXED" && fixedAmount === null) {
    return fail("DEPOSIT_AMOUNT_REQUIRED", "A FIXED deposit needs appointmentDepositFixedAmountCents.");
  }
  if (forfeitType === "PARTIAL" && forfeitAmount === null) {
    return fail("FORFEIT_AMOUNT_REQUIRED", "A PARTIAL no-show forfeiture needs the amount the clinic's policy permits it to keep.");
  }
  if (forfeitType === "PARTIAL" && amountType === "FIXED" && fixedAmount !== null && forfeitAmount > fixedAmount) {
    return fail("FORFEIT_EXCEEDS_DEPOSIT", "A clinic cannot keep more than the deposit itself.");
  }
  if (refundability === "REFUNDABLE_UNTIL_CUTOFF" && cutoffMinutes === null) {
    return fail("CUTOFF_REQUIRED", "REFUNDABLE_UNTIL_CUTOFF needs deposit_cancellation_cutoff_minutes.");
  }
  if (election === "NO_DEPOSIT_REQUIRED" && (refundability !== "NOT_APPLICABLE" || forfeitType !== "NOT_APPLICABLE")) {
    return fail("NO_DEPOSIT_POLICY_MUST_BE_NOT_APPLICABLE",
      "With no deposit there is nothing to refund and nothing to forfeit; both fields are NOT_APPLICABLE.");
  }

  /* ───────────────────────────────────────────────────── provenance ─── */

  const source = text(input.depositElectionSource, 40).toUpperCase();
  if (!source) {
    return fail("DEPOSIT_ELECTION_SOURCE_REQUIRED",
      "Every election records which document it came from: EXECUTED_AGREEMENT, SIGNED_AMENDMENT, AUTHORIZED_WRITTEN_INSTRUCTION, or ADMIN_MIGRATION.");
  }
  if (!DEPOSIT_ELECTION_SOURCES.includes(source)) {
    return fail("INVALID_DEPOSIT_ELECTION_SOURCE", `Source must be one of ${DEPOSIT_ELECTION_SOURCES.join(", ")}.`);
  }
  const effectiveAt = text(input.depositElectionEffectiveAt, 40);
  if (!effectiveAt || Number.isNaN(Date.parse(effectiveAt))) {
    return fail("DEPOSIT_ELECTION_EFFECTIVE_AT_REQUIRED",
      "An election needs an effective date, as an ISO 8601 timestamp.");
  }
  const verifiedBy = text(input.depositElectionVerifiedByAdminUserId, 120);
  if (!verifiedBy) {
    return fail("DEPOSIT_ELECTION_VERIFIER_REQUIRED",
      "A ClearKey admin has to be recorded as having read the document and set this field (§8 Authority).");
  }
  const documentId = text(input.depositElectionSourceDocumentId, 120) || null;
  if ((source === "SIGNED_AMENDMENT" || source === "AUTHORIZED_WRITTEN_INSTRUCTION") && !documentId) {
    return fail("DEPOSIT_ELECTION_DOCUMENT_REQUIRED",
      "An amendment or a written instruction is only evidence if the document is identified.");
  }

  /* ─────────────────────────────────────────────── contract parity ─── */

  const contractOption = normalizeContractOption(input.contractElectionOption || contractElectionOption);
  const offersFourth = bool(input.contractOffersNoDepositOption ?? contractOffersNoDepositOption);
  if (contractOption && !Object.prototype.hasOwnProperty.call(CONTRACT_OPTIONS, contractOption) && contractOption !== "NOT_RECORDED") {
    return fail("INVALID_CONTRACT_OPTION",
      `contractElectionOption must be one of ${Object.keys(CONTRACT_OPTIONS).join(", ")} or NOT_RECORDED.`);
  }

  // §8 contract parity. The fourth option does not exist on the executed
  // three-election agreement, so an EXECUTED_AGREEMENT source cannot
  // evidence it. This is the guard that keeps a clinic on the current paper
  // from ever silently appearing to have elected it.
  if (election === "NO_DEPOSIT_REQUIRED" && !offersFourth) {
    if (source === "EXECUTED_AGREEMENT") {
      return fail("ELECTION_NOT_IN_EXECUTED_CONTRACT",
        "The executed agreement (§15) offers three elections — Waiver, Paw It Forward Guarantee, Customer-Funded. \"Will not require a deposit\" is addendum §8's fourth option and is not on this clinic's paper: record it from a signed amendment or an authorized written instruction until the revised agreement ships.");
    }
    if (source === "ADMIN_MIGRATION" && !documentId) {
      return fail("DEPOSIT_ELECTION_DOCUMENT_REQUIRED",
        "Migrating a clinic to \"Will not require a deposit\" needs the onboarding document that states the clinic has no appointment deposit.");
    }
  }

  // An election that differs from the box the clinic actually initialled is
  // a change to a contract term, not a settings change (§8).
  const contractElection = contractOption && contractOption !== "NOT_RECORDED"
    ? CONTRACT_OPTIONS[contractOption]
    : null;
  if (contractElection && contractElection !== election && source === "EXECUTED_AGREEMENT") {
    return fail("DEPOSIT_ELECTION_AMENDMENT_REQUIRED",
      `The executed agreement records ${contractOption} (${DEPOSIT_ELECTION_LABELS[contractElection]}). Changing to ${DEPOSIT_ELECTION_LABELS[election]} requires a signed amendment or an authorized written instruction, with the document identified — never an undocumented toggle.`);
  }

  return {
    ok: true,
    normalized: {
      pawItForwardEnabled: enabled,
      election,
      appointmentDepositRequiredNormally: requiredNormally,
      appointmentDepositAmountType: amountType,
      appointmentDepositFixedAmountCents: amountType === "FIXED" ? fixedAmount : (amountType === "NONE" ? null : fixedAmount),
      depositRefundability: refundability,
      depositCancellationCutoffMinutes: cutoffMinutes,
      depositNoShowForfeitType: forfeitType,
      depositNoShowForfeitAmountCents: forfeitAmount,
      depositPolicyCustomerCopy: text(input.depositPolicyCustomerCopy, 2000) || null,
      depositPolicyInternalNotes: text(input.depositPolicyInternalNotes, 4000) || null,
      depositGuaranteeLimitCents: guaranteeLimit,
      currency: (text(input.currency, 8) || "usd").toLowerCase(),
      depositElectionSource: source,
      depositElectionEffectiveAt: new Date(Date.parse(effectiveAt)).toISOString(),
      depositElectionVerifiedByAdminUserId: verifiedBy,
      depositElectionSourceDocumentId: documentId,
      contractElectionOption: contractOption,
      contractOffersNoDepositOption: offersFourth,
      changeReason: text(input.changeReason || input.reason, 500) || null
    }
  };
}

/* ═══════════════════════════════════════════════════════════ reads ═══ */

/** The policy in force for a clinic, or null when nobody has set one. */
export async function currentDepositPolicy(env, tenantId) {
  if (!hasDatabase(env) || !tenantId) return null;
  const row = await env.DB.prepare(
    "SELECT * FROM clinic_deposit_policies WHERE tenant_id = ? AND superseded_at IS NULL LIMIT 1"
  ).bind(tenantId).first();
  return policyFromRow(row);
}

/** One specific version, by id — what a booking snapshot points at. */
export async function depositPolicyById(env, policyId) {
  if (!hasDatabase(env) || !policyId) return null;
  const row = await env.DB.prepare("SELECT * FROM clinic_deposit_policies WHERE id = ? LIMIT 1")
    .bind(policyId).first();
  return policyFromRow(row);
}

/** Every version, newest first. The admin console's change log. */
export async function depositPolicyHistory(env, tenantId, { limit = 50 } = {}) {
  if (!hasDatabase(env) || !tenantId) return [];
  const result = await env.DB.prepare(
    "SELECT * FROM clinic_deposit_policies WHERE tenant_id = ? ORDER BY version DESC LIMIT ?"
  ).bind(tenantId, Math.min(Math.max(Number(limit) || 50, 1), 200)).all();
  return result.results.map(policyFromRow);
}

/**
 * What the clinic portal may see: the election, its label, the numbers, and
 * a plain statement that it is not theirs to change.
 *
 * Internal notes and the identity of the verifying admin are not in it. §8
 * says the portal may display this read-only; it does not say the portal is
 * a window into ClearKey's contract administration.
 */
export function clinicPortalProjection(policy) {
  if (!policy) {
    return {
      fieldLabel: DEPOSIT_ELECTION_FIELD_LABEL,
      election: null,
      electionLabel: null,
      readOnly: true,
      setBy: "ClearKey admin",
      changeInstructions: "This election comes from your executed agreement. To change it, contact ClearKey; a change requires a signed amendment or an authorized written instruction."
    };
  }
  return {
    fieldLabel: DEPOSIT_ELECTION_FIELD_LABEL,
    election: policy.election,
    electionLabel: policy.electionLabel,
    appointmentDepositRequiredNormally: policy.appointmentDepositRequiredNormally,
    appointmentDepositAmountType: policy.appointmentDepositAmountType,
    appointmentDepositFixedAmountCents: policy.appointmentDepositFixedAmountCents,
    depositRefundability: policy.depositRefundability,
    depositCancellationCutoffMinutes: policy.depositCancellationCutoffMinutes,
    depositNoShowForfeitType: policy.depositNoShowForfeitType,
    depositNoShowForfeitAmountCents: policy.depositNoShowForfeitAmountCents,
    depositPolicyCustomerCopy: policy.depositPolicyCustomerCopy,
    effectiveAt: policy.depositElectionEffectiveAt,
    version: policy.version,
    readOnly: true,
    setBy: "ClearKey admin",
    changeInstructions: "This election comes from your executed agreement. To change it, contact ClearKey; a change requires a signed amendment or an authorized written instruction."
  };
}

/* ═══════════════════════════════════════════════════════════ writes ═══ */

/**
 * Record an election. Append-only: the current row is superseded and a new
 * version is written, and every change is audited with source, actor,
 * effective date and prior/new value (§8, acceptance tests 19 and 20).
 *
 * There is no update path. A correction is a new version with a reason, which
 * is the only form of correction that leaves the earlier statement readable.
 */
export async function saveDepositPolicy(env, {
  tenantId,
  actorId = null,
  actorRole = "clearkey_admin",
  pawItForwardEnabled = true,
  requestId = null,
  ...input
} = {}) {
  if (!hasDatabase(env)) return DATABASE_REQUIRED;
  const tenant = text(tenantId, 120);
  if (!tenant) return { ok: false, status: 400, code: "TENANT_REQUIRED", message: "A deposit policy belongs to a clinic." };

  const existing = await currentDepositPolicy(env, tenant);
  const validation = validateDepositPolicy(
    {
      // The contract facts carry forward unless this change restates them:
      // the paper a clinic signed does not change because somebody edited a
      // dropdown.
      contractElectionOption: input.contractElectionOption ?? existing?.contractElectionOption ?? null,
      contractOffersNoDepositOption: input.contractOffersNoDepositOption ?? existing?.contractOffersNoDepositOption ?? false,
      ...input
    },
    {
      pawItForwardEnabled,
      contractElectionOption: existing?.contractElectionOption ?? null,
      contractOffersNoDepositOption: existing?.contractOffersNoDepositOption ?? false
    }
  );
  if (!validation.ok) return validation;
  const next = validation.normalized;

  const id = newId("cdp");
  const now = new Date().toISOString();

  const statements = [];
  if (existing) {
    statements.push(env.DB.prepare(
      "UPDATE clinic_deposit_policies SET superseded_at = ?, superseded_by_policy_id = ? WHERE id = ? AND superseded_at IS NULL"
    ).bind(now, id, existing.id));
  }
  statements.push(env.DB.prepare(`
    INSERT INTO clinic_deposit_policies (
      id, tenant_id, version, paw_it_forward_enabled, paw_it_forward_deposit_policy,
      appointment_deposit_required_normally, appointment_deposit_amount_type,
      appointment_deposit_fixed_amount_cents, deposit_refundability,
      deposit_cancellation_cutoff_minutes, deposit_no_show_forfeit_type,
      deposit_no_show_forfeit_amount_cents, deposit_policy_customer_copy,
      deposit_policy_internal_notes, deposit_guarantee_limit_cents, currency,
      deposit_election_source, deposit_election_effective_at,
      deposit_election_verified_by_admin_user_id, deposit_election_source_document_id,
      contract_election_option, contract_offers_no_deposit_option,
      change_reason, created_by, created_at
    )
    SELECT ?, ?, COALESCE((SELECT MAX(version) FROM clinic_deposit_policies WHERE tenant_id = ?), 0) + 1,
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  `).bind(
    id, tenant, tenant,
    next.pawItForwardEnabled ? 1 : 0, next.election,
    next.appointmentDepositRequiredNormally ? 1 : 0, next.appointmentDepositAmountType,
    next.appointmentDepositFixedAmountCents, next.depositRefundability,
    next.depositCancellationCutoffMinutes, next.depositNoShowForfeitType,
    next.depositNoShowForfeitAmountCents, next.depositPolicyCustomerCopy,
    next.depositPolicyInternalNotes, next.depositGuaranteeLimitCents, next.currency,
    next.depositElectionSource, next.depositElectionEffectiveAt,
    next.depositElectionVerifiedByAdminUserId, next.depositElectionSourceDocumentId,
    next.contractElectionOption, next.contractOffersNoDepositOption ? 1 : 0,
    next.changeReason, actorId, now
  ));

  await env.DB.batch(statements);

  // Acceptance tests 19 and 20: prior value, new value, source, effective
  // date, and who. An audit row that says only "policy changed" is not an
  // audit row.
  await recordAudit(env, {
    actorId: actorId || next.depositElectionVerifiedByAdminUserId,
    actorRole,
    action: existing ? "clinic.deposit_policy_changed" : "clinic.deposit_policy_set",
    subjectType: "clinic_deposit_policy",
    subjectId: id,
    oldState: existing
      ? {
          policyId: existing.id,
          version: existing.version,
          election: existing.election,
          amountType: existing.appointmentDepositAmountType,
          fixedAmountCents: existing.appointmentDepositFixedAmountCents,
          source: existing.depositElectionSource,
          effectiveAt: existing.depositElectionEffectiveAt
        }
      : null,
    newState: {
      tenantId: tenant,
      policyId: id,
      election: next.election,
      electionLabel: DEPOSIT_ELECTION_LABELS[next.election],
      amountType: next.appointmentDepositAmountType,
      fixedAmountCents: next.appointmentDepositFixedAmountCents,
      source: next.depositElectionSource,
      effectiveAt: next.depositElectionEffectiveAt,
      verifiedByAdminUserId: next.depositElectionVerifiedByAdminUserId,
      sourceDocumentId: next.depositElectionSourceDocumentId,
      contractElectionOption: next.contractElectionOption
    },
    reason: next.changeReason || (existing ? "Deposit election changed." : "Deposit election recorded from executed documentation."),
    requestId
  });

  const saved = await depositPolicyById(env, id);
  return { ok: true, policy: saved, previousPolicyId: existing?.id || null };
}

/* ═══════════════════════════════════════════ what the customer faces ═══ */

/**
 * The deposit outcome for one booking, in §10's words.
 *
 * This runs *before confirmation*, so nothing it returns may identify the
 * clinic: the pre-confirmation card is masked by design (§2, §10), and a
 * deposit line that said "Bayside Animal Hospital requires $75" would undo
 * the alias in one sentence. The copy below therefore says "clinic", never a
 * name, and the clinic's own policy prose — which can name it — is returned
 * separately under `afterReveal`, for the screen that comes after
 * confirmation.
 *
 * `sponsored` is whether this booking is a qualifying Paw It Forward booking.
 * It matters for two of the four elections: a waiver and a guarantee apply to
 * program bookings, and the same clinic's ordinary deposit still applies to
 * everybody else.
 */
export function depositOutcomeForBooking(policy, { sponsored = false } = {}) {
  const isSponsored = sponsored === true;

  if (!policy) {
    // No election on file. The honest answer is not "no deposit" — it is
    // that we do not know, and a booking must not quote a number nobody set.
    return {
      election: null,
      electionLabel: null,
      sponsored: isSponsored,
      amountKnown: false,
      customerOwesDepositCents: 0,
      guaranteeApplies: false,
      guaranteeExpectedCents: 0,
      requiresClinicConfirmation: true,
      copy: {
        headline: "Appointment deposit: Confirmed by the clinic before booking",
        detail: null,
        line: "Confirmed by the clinic before booking"
      },
      afterReveal: null
    };
  }

  const currency = policy.currency || "usd";
  const amountType = policy.appointmentDepositAmountType;
  const fixed = policy.appointmentDepositFixedAmountCents;
  const amountKnown = amountType === "FIXED" && typeof fixed === "number" && fixed > 0;
  const amountText = amountKnown ? formatMoney(fixed, currency) : null;

  const afterReveal = {
    policyCopy: policy.depositPolicyCustomerCopy || null,
    refundability: policy.depositRefundability,
    cancellationCutoffMinutes: policy.depositCancellationCutoffMinutes,
    noShowForfeitType: policy.depositNoShowForfeitType,
    noShowForfeitAmountCents: policy.depositNoShowForfeitAmountCents,
    // §10: the real clinic policy is shown after identity reveal and before
    // any customer-funded deposit is captured.
    showAfterIdentityReveal: true
  };

  const base = {
    election: policy.election,
    electionLabel: policy.electionLabel,
    sponsored: isSponsored,
    policyId: policy.id,
    policyVersion: policy.version,
    currency,
    amountKnown,
    afterReveal
  };

  if (policy.election === "NO_DEPOSIT_REQUIRED") {
    // §8: no customer deposit, no guarantee, no deposit payment object.
    return {
      ...base,
      customerOwesDepositCents: 0,
      guaranteeApplies: false,
      guaranteeExpectedCents: 0,
      requiresClinicConfirmation: false,
      createsDepositPaymentObject: false,
      copy: {
        headline: "Appointment deposit: Not required",
        detail: null,
        line: "Not required"
      }
    };
  }

  if (policy.election === "WAIVE_FOR_PAW_IT_FORWARD" && isSponsored) {
    return {
      ...base,
      customerOwesDepositCents: 0,
      guaranteeApplies: false,
      guaranteeExpectedCents: 0,
      requiresClinicConfirmation: false,
      createsDepositPaymentObject: false,
      copy: {
        headline: "Appointment deposit: Waived with Paw It Forward",
        detail: null,
        line: "Waived with Paw It Forward"
      }
    };
  }

  if (policy.election === "PAW_IT_FORWARD_GUARANTEE" && isSponsored) {
    // The customer is not charged the appointment deposit; the program
    // fronts it and the clinic returns it on attendance. Never described as
    // free veterinary care (§10) — the line says "deposit", and the bill is
    // not mentioned because the bill is not affected.
    if (!amountKnown) {
      return {
        ...base,
        customerOwesDepositCents: 0,
        guaranteeApplies: true,
        guaranteeExpectedCents: 0,
        requiresClinicConfirmation: true,
        createsDepositPaymentObject: false,
        copy: {
          headline: "Appointment deposit: Confirmed by the clinic, then covered by Paw It Forward",
          detail: "Paw It Forward covers the appointment deposit once the clinic confirms the amount.",
          line: "Covered by Paw It Forward deposit guarantee"
        }
      };
    }
    return {
      ...base,
      customerOwesDepositCents: 0,
      guaranteeApplies: true,
      guaranteeExpectedCents: fixed,
      requiresClinicConfirmation: false,
      createsDepositPaymentObject: false,
      copy: {
        headline: `${amountText} appointment deposit`,
        detail: "Covered by Paw It Forward deposit guarantee",
        line: `${amountText} appointment deposit — Covered by Paw It Forward deposit guarantee`
      }
    };
  }

  // CUSTOMER_REQUIRED, and the ordinary non-program booking at a clinic that
  // waives or guarantees only for the program: the customer owes the clinic's
  // deposit and is told so in as many words. Paw It Forward may still be
  // covering the TímiNOW fees; that is a different sentence on a different
  // line, and conflating them is how somebody arrives believing the deposit
  // was handled.
  if (!amountKnown) {
    return {
      ...base,
      customerOwesDepositCents: 0,
      guaranteeApplies: false,
      guaranteeExpectedCents: 0,
      requiresClinicConfirmation: true,
      createsDepositPaymentObject: false,
      copy: {
        headline: "Clinic appointment deposit required",
        detail: "The clinic confirms the amount before you book — you will be responsible for this deposit",
        line: "Clinic appointment deposit required — amount confirmed by the clinic before you book"
      }
    };
  }
  return {
    ...base,
    customerOwesDepositCents: fixed,
    guaranteeApplies: false,
    guaranteeExpectedCents: 0,
    requiresClinicConfirmation: false,
    createsDepositPaymentObject: true,
    copy: {
      headline: `${amountText} clinic appointment deposit required`,
      detail: "You will be responsible for this deposit",
      line: `${amountText} clinic appointment deposit required — You will be responsible for this deposit`
    }
  };
}

/* ═══════════════════════════════════════════ booking policy snapshots ═══ */

/**
 * Freeze the deposit policy onto a booking at confirmation (§25).
 *
 * Taken for every booking, including the ones with no deposit at all: the
 * historically useful fact there is precisely that nothing was asked for.
 * Idempotent per booking — confirming twice does not produce two versions of
 * what the customer was told.
 */
export async function snapshotDepositPolicyForBooking(env, { intakeId, tenantId, sponsored = false, actorId = null } = {}) {
  if (!hasDatabase(env)) return DATABASE_REQUIRED;
  const intake = text(intakeId, 120);
  if (!intake) return { ok: false, status: 400, code: "INTAKE_REQUIRED", message: "A snapshot belongs to a booking." };

  const existing = await getBookingDepositSnapshot(env, intake);
  if (existing) return { ok: true, duplicate: true, snapshot: existing };

  const policy = await currentDepositPolicy(env, tenantId);
  const outcome = depositOutcomeForBooking(policy, { sponsored });
  const id = newId("bdps");

  await env.DB.prepare(`
    INSERT OR IGNORE INTO booking_deposit_policy_snapshots (
      id, intake_id, tenant_id, policy_id, policy_version, paw_it_forward_deposit_policy,
      sponsored, customer_deposit_headline, customer_deposit_detail,
      customer_owes_deposit_cents, guarantee_expected_cents, policy_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, intake, tenantId || null, policy?.id || null, policy?.version ?? null,
    policy?.election || "UNSET", sponsored ? 1 : 0,
    outcome.copy.headline, outcome.copy.detail,
    outcome.customerOwesDepositCents, outcome.guaranteeExpectedCents,
    JSON.stringify({ policy, outcome })
  ).run();

  await recordAudit(env, {
    actorId,
    actorRole: "system",
    action: "booking.deposit_policy_snapshotted",
    subjectType: "booking_deposit_policy_snapshot",
    subjectId: id,
    newState: { intakeId: intake, policyId: policy?.id || null, election: policy?.election || null, sponsored },
    reason: "Booking confirmed; deposit policy frozen (§25)."
  });

  return { ok: true, duplicate: false, snapshot: await getBookingDepositSnapshot(env, intake) };
}

/** The frozen policy a booking was actually quoted under. */
export async function getBookingDepositSnapshot(env, intakeId) {
  if (!hasDatabase(env) || !intakeId) return null;
  const row = await env.DB.prepare(
    "SELECT * FROM booking_deposit_policy_snapshots WHERE intake_id = ? LIMIT 1"
  ).bind(intakeId).first();
  if (!row) return null;
  let parsed = {};
  try {
    parsed = JSON.parse(row.policy_json);
  } catch {
    parsed = {};
  }
  return {
    id: row.id,
    intakeId: row.intake_id,
    tenantId: row.tenant_id,
    policyId: row.policy_id,
    policyVersion: row.policy_version === null ? null : Number(row.policy_version),
    election: row.paw_it_forward_deposit_policy,
    sponsored: Boolean(row.sponsored),
    customerDepositHeadline: row.customer_deposit_headline,
    customerDepositDetail: row.customer_deposit_detail,
    customerOwesDepositCents: Number(row.customer_owes_deposit_cents || 0),
    guaranteeExpectedCents: Number(row.guarantee_expected_cents || 0),
    policy: parsed.policy || null,
    outcome: parsed.outcome || null,
    createdAt: row.created_at
  };
}

/* ═══════════════════════════════════════════════════════════ handlers ═══ */
/*
 * Mount every route below behind ClearKey admin authentication except the
 * clinic-portal read, which is mounted behind ordinary tenant auth. §8 is
 * explicit that this is not a clinic-controlled setting, and there is no
 * writer here that a clinic session should ever be able to reach.
 */

/** GET /api/admin/clinics/:tenantId/deposit-policy */
export async function handleAdminDepositPolicyGet(request, env, actor, tenantId) {
  const [policy, history] = await Promise.all([
    currentDepositPolicy(env, tenantId),
    depositPolicyHistory(env, tenantId)
  ]);
  return json({
    fieldLabel: DEPOSIT_ELECTION_FIELD_LABEL,
    options: DEPOSIT_ELECTIONS.map((value) => ({ value, label: DEPOSIT_ELECTION_LABELS[value] })),
    contractOptions: CONTRACT_OPTIONS,
    policy,
    history
  });
}

/** PUT /api/admin/clinics/:tenantId/deposit-policy */
export async function handleAdminDepositPolicySave(request, env, actor, tenantId) {
  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    const code = error.message === "PAYLOAD_TOO_LARGE" ? "PAYLOAD_TOO_LARGE" : "JSON_REQUIRED";
    return apiError(code === "PAYLOAD_TOO_LARGE" ? 413 : 400, code, "A valid JSON request body is required.");
  }
  const actorId = actor?.userId || actor?.id || null;
  const result = await saveDepositPolicy(env, {
    tenantId,
    actorId,
    pawItForwardEnabled: body?.pawItForwardEnabled ?? true,
    ...body
  });
  if (!result.ok) return apiError(result.status || 422, result.code, result.message, result.details);
  return json({ policy: result.policy, previousPolicyId: result.previousPolicyId });
}

/** GET /api/clinic/deposit-policy — the clinic's own read-only view. */
export async function handleClinicDepositPolicyView(env, tenantId) {
  return json({ depositPolicy: clinicPortalProjection(await currentDepositPolicy(env, tenantId)) });
}

/** GET /api/bookings/:intakeId/deposit — what this booking was quoted. */
export async function handleBookingDepositSnapshot(request, env, intakeId) {
  const snapshot = await getBookingDepositSnapshot(env, intakeId);
  if (!snapshot) return apiError(404, "SNAPSHOT_NOT_FOUND", "That booking has no deposit snapshot.");
  return json({ deposit: snapshot });
}
