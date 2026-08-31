/**
 * The clinic agreement, the people authorized to act under it, and the
 * lifecycle of a practice's participation.
 *
 * The contract this file encodes is the VETERINARY CLINIC PLATFORM
 * PARTICIPATION AGREEMENT between **ClearKey Solutions, LLC** and a
 * veterinary practice. TímiNOW is ClearKey's product and Paw It Forward is a
 * ClearKey-administered program; neither is a party to anything. Where a
 * function below writes a legally significant record, it names ClearKey.
 *
 * ## Why this is a module and not a few columns
 *
 * A founding clinic's fee waiver is worth $25 a visit, forever, and the ways
 * it can be lost by accident all look reasonable from inside a single
 * request handler. A practice closes for six weeks to remodel; an office
 * manager leaves; the answering service misses four calls; the practice is
 * sold to the associate who has worked there for a decade. Each of those, run
 * through an ordinary "deactivate the account" code path, quietly converts a
 * $0 rate into a $25 one — and the clinic finds out on an invoice.
 *
 * The agreement says otherwise, in terms, and this module is where that
 * language becomes behavior:
 *
 *   §3  "A change in personnel, management, administrator, or medical
 *        director that does not change the contracting legal entity shall not
 *        by itself terminate this Agreement or any Founding Clinic status."
 *
 *   §9  "ClearKey shall not treat ordinary inactivity, a temporary
 *        operational pause, staffing shortage, renovation, temporary closure,
 *        or good-faith voluntary withdrawal as permanent forfeiture."
 *
 *   §27 "Mere failure to respond to requests, seasonal closure, staffing
 *        shortage, or temporary inactivity does not automatically constitute
 *        termination."
 *
 * So `recordManagementEvent` cannot touch founding status. `separateClinic`
 * refuses a reason drawn from that list. `noteMissedCalls` returns the
 * lifecycle it was given, unchanged, and says so in the audit trail.
 *
 * ## The four bars, and the one that is different
 *
 * §9 restores the waiver when the same contracting legal entity and
 * substantially the same practice rejoin — *unless* (a) status was previously
 * lost for Cause, (b) obligations remain uncured, (c) there was intentional
 * circumvention or program misuse, or (d) the parties agreed in writing that
 * the privilege was surrendered. `restoreFoundingOnRejoin` checks all four
 * and names the one that applied.
 *
 * Bar (a) is different in kind. §28: "A Clinic terminated for Cause has no
 * contractual right to rejoin... any restoration of Founding Clinic status
 * must be express and in writing." Automatic restoration is therefore not a
 * thing that can be requested harder — it needs a document id and a named
 * decider, and the code will not proceed without both.
 *
 * ## Where the money is decided
 *
 * Nowhere in this file. `clinicFeeFor` in src/pricing.js is the only thing
 * that decides what a clinic pays, reading `clinic_pricing_assignments`.
 * These functions move that row — via `assignPricingPlan` in
 * src/clinic-billing.js, the existing sanctioned path — and record the
 * provenance beside it. There is deliberately no second fee calculation here
 * to disagree with the first, and no `$25` literal at all: addendum §11's
 * rule is that a founding clinic must never have a default receivable raised
 * against it "to be discounted later".
 *
 * ## Everything material is audited
 *
 * Every function that changes a fact writes an append-only `audit_events` row
 * through `recordAudit`. The founding and representative tables are
 * themselves append-only, so the audit trail and the domain history
 * corroborate each other rather than one summarizing the other.
 */

import { hasDatabase } from "./db.js";
import { recordAudit } from "./ledger.js";
import { clinicFeeFor } from "./pricing.js";
import { assignPricingPlan } from "./clinic-billing.js";

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

function text(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeEmail(value) {
  return text(value, 160).toLowerCase();
}

function parseJsonColumn(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function readJson(request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 32_768) throw new Error("PAYLOAD_TOO_LARGE");
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new Error("JSON_REQUIRED");
  }
  return request.json();
}

function requireDatabase(env) {
  if (hasDatabase(env)) return null;
  return { ok: false, status: 503, code: "DATABASE_REQUIRED", message: "D1 is required." };
}

/* ═══════════════════════════════════════════════════════ the vocabulary ═══ */

/**
 * The contracting party. TímiNOW is a product and trade designation of
 * ClearKey, not a legal entity — the agreement's own second paragraph says so
 * — and this constant exists so that a document generator or an admin screen
 * cannot invent a counterparty that does not exist.
 */
export const CONTRACTING_ENTITY = "ClearKey Solutions, LLC";
export const PLATFORM_PRODUCT_NAME = "TímiNOW";
/** A ClearKey-administered program, not a separate legal entity (§1, §15). */
export const ASSISTANCE_PROGRAM_NAME = "Paw It Forward";

export const CONTRACT_STATUSES = Object.freeze([
  "DRAFT", "PENDING_SIGNATURE", "EXECUTED", "SUPERSEDED", "TERMINATED", "VOID"
]);

export const DEPOSIT_ELECTIONS = Object.freeze([
  "NO_DEPOSIT_REQUIRED", "WAIVE_FOR_PAW_IT_FORWARD", "ACCEPT_PIF_GUARANTEE", "CUSTOMER_FUNDED_DEPOSIT"
]);

export const REPRESENTATIVE_ROLES = Object.freeze([
  "AUTHORIZED_REPRESENTATIVE", "AUTHORIZED_SIGNER", "BILLING_CONTACT",
  "LEGAL_NOTICE_CONTACT", "PRACTICE_ADMINISTRATOR", "MEDICAL_DIRECTOR", "STAFF_USER"
]);

export const AUTHORITY_SCOPES = Object.freeze(["ROUTINE", "ACTUAL_AUTHORITY_TO_BIND"]);

export const MANAGEMENT_EVENT_TYPES = Object.freeze([
  "OWNER_CONTROL", "LEGAL_ENTITY", "MANAGEMENT_COMPANY", "ADMINISTRATOR",
  "MEDICAL_DIRECTOR", "BILLING", "AUTHORIZED_REPRESENTATIVE"
]);

/**
 * The management events that change who the contracting party *is*.
 *
 * Everything else on the list above is turnover. §3 draws exactly this line:
 * a new administrator is a notice obligation, a new legal entity is an
 * assignment question.
 */
export const ENTITY_CHANGING_EVENT_TYPES = Object.freeze(["LEGAL_ENTITY", "OWNER_CONTROL"]);

export const FOUNDING_STATUSES = Object.freeze([
  "NOT_APPLICABLE", "ACTIVE", "TEMPORARILY_INACTIVE", "SEPARATED_ELIGIBLE_TO_RESTORE", "REVOKED_FOR_CAUSE"
]);

/**
 * Cause, as §9 defines it. A closed list on purpose: "for cause" that anyone
 * can extend at the keyboard is not a standard, it is a mood.
 */
export const CAUSE_CATEGORIES = Object.freeze([
  "FRAUD",
  "VISIT_OR_PAYMENT_FALSIFICATION",
  "INTENTIONAL_FEE_CIRCUMVENTION",
  "PAW_IT_FORWARD_FUND_MISUSE",
  "DEPOSIT_DOUBLE_COLLECTION",
  "MATERIAL_SECURITY_ABUSE",
  "MATERIAL_UNLAWFUL_CONDUCT",
  "UNCURED_MATERIAL_BREACH"
]);

/**
 * The circumstances that must never, on their own, cost a clinic its founding
 * status or end its agreement.
 *
 * Addendum §11 lists them; contract §9 and §27 are the language behind them.
 * They are a machine-checkable enum rather than prose in a runbook because
 * the failure mode is a well-meaning operator with a dropdown.
 */
export const NON_FORFEITING_CIRCUMSTANCES = Object.freeze([
  "INACTIVITY",
  "TEMPORARY_CLOSURE",
  "STAFFING_SHORTAGE",
  "RENOVATION",
  "SEASONAL_PAUSE",
  "TEMPORARY_AVAILABILITY_DEACTIVATION",
  "ADMINISTRATOR_CHANGE",
  "MEDICAL_DIRECTOR_CHANGE",
  "ORDINARY_MANAGEMENT_CHANGE",
  "GOOD_FAITH_VOLUNTARY_SEPARATION",
  "MISSED_CALLS",
  "UNANSWERED_IVR"
]);

export const CLINIC_LIFECYCLE_STATES = Object.freeze([
  "PENDING_CONTRACT",
  "PENDING_ONBOARDING",
  "ACTIVE",
  "TEMPORARILY_INACTIVE",
  "SUSPENDED",
  "VOLUNTARY_SEPARATION_PENDING",
  "SEPARATED",
  "TERMINATED_FOR_CAUSE",
  "REJOIN_REVIEW"
]);

/**
 * What an Authorized Representative may do on the clinic's own instruction.
 *
 * §2, verbatim in substance: "routine Platform administration, availability
 * configuration, deposit settings, payment methods, notification preferences,
 * users, and similar operational matters."
 */
export const ROUTINE_REPRESENTATIVE_ACTIONS = Object.freeze([
  "AVAILABILITY",
  "TEMPORARY_DEACTIVATION",
  "DEPOSIT_CONFIGURATION",
  "PAYMENT_METHOD",
  "NOTIFICATIONS",
  "USERS",
  "CONTACTS",
  "VIEW_BILLING",
  "DISPUTE_A_CHARGE"
]);

/**
 * What an Authorized Representative may *not* do without actual authority.
 *
 * §2's proviso: "An Authorized Representative may not amend this Agreement,
 * transfer ownership, waive a material claim, or bind Clinic to materially
 * different pricing unless the representative has actual authority to do so."
 *
 * Surrendering founding status appears here because §9(d) makes surrender an
 * express written agreement between the Parties — which is an amendment of
 * the commercial bargain by any other name, and addendum §12 names it
 * explicitly among the things an ordinary clinic user must not be assumed to
 * be able to do.
 */
export const RESERVED_ACTIONS = Object.freeze([
  "AMEND_CONTRACT",
  "SURRENDER_FOUNDING_STATUS",
  "TRANSFER_OWNERSHIP",
  "ASSIGN_AGREEMENT",
  "MATERIAL_PRICING_CHANGE",
  "WAIVE_MATERIAL_CLAIM",
  "TERMINATE_AGREEMENT"
]);

/**
 * The obligations that outlive the account (§27, addendum §13). Returned with
 * every separation so that "we're done here" is never the last word.
 */
export const SURVIVING_OBLIGATION_KINDS = Object.freeze([
  "AMOUNTS_DUE",
  "REFUNDS",
  "CHARGEBACKS",
  "DEPOSIT_RETURNS",
  "RECONCILIATION",
  "CONFIDENTIALITY",
  "SECURITY",
  "INDEMNITY",
  "AUDIT_RECORDS"
]);

/** Booking states that must be seen through before an account goes quiet (§27). */
const WIND_DOWN_BOOKING_STATES = Object.freeze(["accepted", "en_route", "arrived", "triaged"]);

/** Receivable states that mean money is still owed. Mirrors migration 0016. */
const UNCURED_RECEIVABLE_STATES = Object.freeze(["DUE", "RETRYING", "PAST_DUE", "RESTRICTED"]);
const UNCURED_INVOICE_STATES = Object.freeze(["OPEN", "PAST_DUE"]);

/* ══════════════════════════════════════════════════════════ the contract ═══ */

function contractFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    clinicLegalName: row.clinic_legal_name,
    clinicDba: row.clinic_dba,
    entityType: row.entity_type,
    stateOfOrganization: row.state_of_organization,
    contractingEntity: row.contracting_entity,
    productName: row.product_name,
    agreementVersion: row.agreement_version,
    agreementDocumentId: row.agreement_document_id,
    esignEnvelopeId: row.esign_envelope_id,
    esignAuditTrailId: row.esign_audit_trail_id,
    authorizedSigner: row.authorized_signer_name
      ? { name: row.authorized_signer_name, title: row.authorized_signer_title, email: row.authorized_signer_email }
      : null,
    effectiveDate: row.effective_date,
    status: row.status,
    legalNoticeEmail: row.legal_notice_email,
    billingContact: row.billing_contact_email || row.billing_contact_name
      ? { name: row.billing_contact_name, email: row.billing_contact_email }
      : null,
    depositElection: row.deposit_election,
    participatingLocations: parseJsonColumn(row.participating_locations_json, []),
    supersededByContractId: row.superseded_by_contract_id,
    terminatedAt: row.terminated_at,
    terminationReason: row.termination_reason,
    notes: row.notes,
    recordedBy: row.recorded_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeLocations(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((entry) => ({
    locationId: text(entry?.locationId, 80) || null,
    name: text(entry?.name, 160),
    addressLine1: text(entry?.addressLine1, 200) || null,
    city: text(entry?.city, 120) || null,
    region: text(entry?.region, 40) || null,
    postalCode: text(entry?.postalCode, 20) || null
  })).filter((entry) => entry.name || entry.locationId);
}

/**
 * Record an executed (or pending) agreement.
 *
 * Recording a *new* executed agreement supersedes the one in force rather
 * than editing it: §34 says a later signed writing controls over an
 * inconsistent earlier provision, which only means anything if the earlier
 * writing still exists to be inconsistent with.
 */
export async function recordContract(env, {
  tenantId,
  clinicLegalName,
  clinicDba = null,
  entityType = null,
  stateOfOrganization = null,
  agreementVersion,
  agreementDocumentId = null,
  esignEnvelopeId = null,
  esignAuditTrailId = null,
  authorizedSignerName = null,
  authorizedSignerTitle = null,
  authorizedSignerEmail = null,
  effectiveDate = null,
  status = "EXECUTED",
  legalNoticeEmail = null,
  billingContactName = null,
  billingContactEmail = null,
  depositElection = null,
  participatingLocations = [],
  notes = null,
  actorId = null
} = {}) {
  const guard = requireDatabase(env);
  if (guard) return guard;

  const legalName = text(clinicLegalName, 200);
  const version = text(agreementVersion, 40);
  if (!tenantId) return { ok: false, status: 422, code: "TENANT_REQUIRED", message: "A clinic is required." };
  if (!legalName) {
    return {
      ok: false, status: 422, code: "LEGAL_NAME_REQUIRED",
      message: "The contracting legal name is required — a DBA is not the party to the agreement."
    };
  }
  if (!version) return { ok: false, status: 422, code: "AGREEMENT_VERSION_REQUIRED", message: "An agreement version is required." };
  if (!CONTRACT_STATUSES.includes(status)) {
    return { ok: false, status: 422, code: "INVALID_CONTRACT_STATUS", message: `Status must be one of ${CONTRACT_STATUSES.join(", ")}.` };
  }
  if (depositElection && !DEPOSIT_ELECTIONS.includes(depositElection)) {
    return { ok: false, status: 422, code: "INVALID_DEPOSIT_ELECTION", message: `Deposit election must be one of ${DEPOSIT_ELECTIONS.join(", ")}.` };
  }
  // §33: the e-sign workflow must identify the legal entity, the signer, the
  // signer's title, the Authorized Representative, and the §15 election. An
  // "executed" row missing the election is an incomplete execution record.
  if (status === "EXECUTED" && !depositElection) {
    return {
      ok: false, status: 422, code: "DEPOSIT_ELECTION_REQUIRED",
      message: "An executed agreement must carry exactly one Section 15 deposit election."
    };
  }

  const tenant = await env.DB.prepare("SELECT id FROM tenants WHERE id = ? LIMIT 1").bind(tenantId).first();
  if (!tenant) return { ok: false, status: 404, code: "TENANT_NOT_FOUND", message: "That clinic was not found." };

  const existingVersion = await env.DB.prepare(
    "SELECT id FROM clinic_contracts WHERE tenant_id = ? AND agreement_version = ? LIMIT 1"
  ).bind(tenantId, version).first();
  if (existingVersion) {
    return {
      ok: false, status: 409, code: "AGREEMENT_VERSION_EXISTS",
      message: "That agreement version is already recorded for this clinic. An amendment is a new version."
    };
  }

  const inForce = await env.DB.prepare(
    "SELECT * FROM clinic_contracts WHERE tenant_id = ? AND status = 'EXECUTED' LIMIT 1"
  ).bind(tenantId).first();

  const id = newId("cont");
  if (status === "EXECUTED" && inForce) {
    await env.DB.prepare(
      "UPDATE clinic_contracts SET status = 'SUPERSEDED', superseded_by_contract_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).bind(id, inForce.id).run();
  }

  await env.DB.prepare(`
    INSERT INTO clinic_contracts (
      id, tenant_id, clinic_legal_name, clinic_dba, entity_type, state_of_organization,
      contracting_entity, product_name, agreement_version, agreement_document_id,
      esign_envelope_id, esign_audit_trail_id,
      authorized_signer_name, authorized_signer_title, authorized_signer_email,
      effective_date, status, legal_notice_email, billing_contact_name, billing_contact_email,
      deposit_election, participating_locations_json, notes, recorded_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, tenantId, legalName, text(clinicDba, 200) || null, text(entityType, 80) || null,
    text(stateOfOrganization, 80) || null, CONTRACTING_ENTITY, PLATFORM_PRODUCT_NAME,
    version, text(agreementDocumentId, 120) || null,
    text(esignEnvelopeId, 120) || null, text(esignAuditTrailId, 120) || null,
    text(authorizedSignerName, 160) || null, text(authorizedSignerTitle, 120) || null,
    normalizeEmail(authorizedSignerEmail) || null,
    text(effectiveDate, 40) || null, status, normalizeEmail(legalNoticeEmail) || null,
    text(billingContactName, 160) || null, normalizeEmail(billingContactEmail) || null,
    depositElection || null, JSON.stringify(normalizeLocations(participatingLocations)),
    text(notes, 2000) || null, actorId
  ).run();

  // A clinic with a signed agreement but no onboarding is PENDING_ONBOARDING,
  // not ACTIVE: execution is not the same as being ready to take a referral.
  if (status === "EXECUTED") {
    const lifecycle = await clinicLifecycle(env, tenantId);
    if (!lifecycle || lifecycle.status === "PENDING_CONTRACT") {
      await writeLifecycle(env, {
        tenantId,
        toStatus: "PENDING_ONBOARDING",
        reason: "Agreement executed.",
        triggerSource: "ONBOARDING",
        contractId: id,
        actorId
      });
    }
  }

  await recordAudit(env, {
    actorId, actorRole: "platform", action: "clinic_contract.recorded",
    subjectType: "tenant", subjectId: tenantId,
    oldState: inForce ? { contractId: inForce.id, agreementVersion: inForce.agreement_version, status: inForce.status } : null,
    newState: { contractId: id, agreementVersion: version, status, contractingEntity: CONTRACTING_ENTITY, depositElection },
    reason: notes || null
  });

  return { ok: true, contract: await getContract(env, tenantId, { contractId: id }) };
}

/** The agreement in force for a clinic, or a specific one by id. */
export async function getContract(env, tenantId, { contractId = null, includeSuperseded = false } = {}) {
  if (!hasDatabase(env)) return null;
  if (contractId) {
    const row = await env.DB.prepare("SELECT * FROM clinic_contracts WHERE id = ? LIMIT 1").bind(contractId).first();
    return contractFromRow(row);
  }
  const row = await env.DB.prepare(`
    SELECT * FROM clinic_contracts
    WHERE tenant_id = ? ${includeSuperseded ? "" : "AND status = 'EXECUTED'"}
    ORDER BY CASE status WHEN 'EXECUTED' THEN 0 WHEN 'PENDING_SIGNATURE' THEN 1 ELSE 2 END,
             datetime(created_at) DESC
    LIMIT 1
  `).bind(tenantId).first();
  return contractFromRow(row);
}

/** Every agreement for one clinic, or across the platform for the admin list. */
export async function listContracts(env, { tenantId = null, status = null, limit = 100 } = {}) {
  if (!hasDatabase(env)) return [];
  const capped = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const clauses = [];
  const values = [];
  if (tenantId) { clauses.push("tenant_id = ?"); values.push(tenantId); }
  if (status) { clauses.push("status = ?"); values.push(status); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { results } = await env.DB.prepare(
    `SELECT * FROM clinic_contracts ${where} ORDER BY datetime(created_at) DESC, rowid DESC LIMIT ?`
  ).bind(...values, capped).all();
  return (results || []).map(contractFromRow);
}

/**
 * Amend the agreement.
 *
 * §29: "No individual employee or representative of ClearKey may orally amend
 * this Agreement. A negotiated amendment must be in a writing or authenticated
 * electronic record authorized by both Parties." So an amendment is a new
 * contract row with its own document, and — because §2 reserves amendment
 * from an ordinary Authorized Representative — the request must name a clinic
 * signer who actually has authority to bind.
 */
export async function amendContract(env, { tenantId, requestedByEmail = null, actorId = null, ...contract } = {}) {
  const guard = requireDatabase(env);
  if (guard) return guard;
  if (requestedByEmail) {
    const authority = await canAuthorize(env, tenantId, requestedByEmail, "AMEND_CONTRACT");
    if (!authority.allowed) {
      return { ok: false, status: 403, code: authority.code, message: authority.message, details: { action: "AMEND_CONTRACT" } };
    }
  }
  if (!contract.agreementDocumentId) {
    return {
      ok: false, status: 422, code: "AMENDMENT_DOCUMENT_REQUIRED",
      message: "An amendment must be a writing or authenticated electronic record."
    };
  }
  return recordContract(env, { ...contract, tenantId, actorId, status: "EXECUTED" });
}

/* ═══════════════════════════════════════════ authorized representatives ═══ */

function representativeFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    contractId: row.contract_id,
    name: row.name,
    title: row.title,
    email: row.email,
    phone: row.phone,
    role: row.role,
    authorityScope: row.authority_scope,
    authoritySourceDocumentId: row.authority_source_document_id,
    active: Boolean(row.active),
    validFrom: row.valid_from,
    validTo: row.valid_to,
    endReason: row.end_reason,
    sourceDocumentId: row.source_document_id,
    recordedBy: row.recorded_by,
    createdAt: row.created_at
  };
}

/**
 * Designate an Authorized Representative.
 *
 * `replacesRepresentativeId` closes the named row instead of overwriting it,
 * which is the whole point: §3 obliges a clinic to notify ClearKey when the
 * representative changes, and a table that keeps only the current name cannot
 * show that the notice was given, or when the previous person's authority
 * actually ended.
 */
export async function addAuthorizedRepresentative(env, {
  tenantId,
  name,
  email,
  title = null,
  phone = null,
  role = "AUTHORIZED_REPRESENTATIVE",
  authorityScope = "ROUTINE",
  authoritySourceDocumentId = null,
  contractId = null,
  sourceDocumentId = null,
  validFrom = null,
  replacesRepresentativeId = null,
  actorId = null,
  reason = null
} = {}) {
  const guard = requireDatabase(env);
  if (guard) return guard;
  const cleanName = text(name, 160);
  const cleanEmail = normalizeEmail(email);
  if (!tenantId) return { ok: false, status: 422, code: "TENANT_REQUIRED", message: "A clinic is required." };
  if (!cleanName) return { ok: false, status: 422, code: "NAME_REQUIRED", message: "A representative needs a name." };
  if (!cleanEmail) return { ok: false, status: 422, code: "EMAIL_REQUIRED", message: "A representative needs an email address." };
  if (!REPRESENTATIVE_ROLES.includes(role)) {
    return { ok: false, status: 422, code: "INVALID_ROLE", message: `Role must be one of ${REPRESENTATIVE_ROLES.join(", ")}.` };
  }
  if (!AUTHORITY_SCOPES.includes(authorityScope)) {
    return { ok: false, status: 422, code: "INVALID_AUTHORITY_SCOPE", message: `Authority scope must be one of ${AUTHORITY_SCOPES.join(", ")}.` };
  }
  if (authorityScope === "ACTUAL_AUTHORITY_TO_BIND" && !authoritySourceDocumentId) {
    return {
      ok: false, status: 422, code: "AUTHORITY_DOCUMENT_REQUIRED",
      message: "Actual authority to bind the clinic must point at the writing that grants it."
    };
  }

  const tenant = await env.DB.prepare("SELECT id FROM tenants WHERE id = ? LIMIT 1").bind(tenantId).first();
  if (!tenant) return { ok: false, status: 404, code: "TENANT_NOT_FOUND", message: "That clinic was not found." };

  let replaced = null;
  if (replacesRepresentativeId) {
    replaced = await env.DB.prepare(
      "SELECT * FROM clinic_authorized_representatives WHERE id = ? AND tenant_id = ? LIMIT 1"
    ).bind(replacesRepresentativeId, tenantId).first();
    if (!replaced) {
      return { ok: false, status: 404, code: "REPRESENTATIVE_NOT_FOUND", message: "The representative being replaced was not found." };
    }
    await env.DB.prepare(`
      UPDATE clinic_authorized_representatives
         SET active = 0, valid_to = COALESCE(?, CURRENT_TIMESTAMP), end_reason = COALESCE(end_reason, 'SUPERSEDED')
       WHERE id = ? AND active = 1
    `).bind(text(validFrom, 40) || null, replacesRepresentativeId).run();
  }

  const id = newId("rep");
  await env.DB.prepare(`
    INSERT INTO clinic_authorized_representatives (
      id, tenant_id, contract_id, name, title, email, phone, role,
      authority_scope, authority_source_document_id, active, valid_from, source_document_id, recorded_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, COALESCE(?, CURRENT_TIMESTAMP), ?, ?)
  `).bind(
    id, tenantId, contractId, cleanName, text(title, 120) || null, cleanEmail, text(phone, 40) || null,
    role, authorityScope, text(authoritySourceDocumentId, 120) || null,
    text(validFrom, 40) || null, text(sourceDocumentId, 120) || null, actorId
  ).run();

  // §3 requires the change itself to be tracked, not just the new name.
  if (replaced) {
    await recordManagementEvent(env, {
      tenantId,
      eventType: "AUTHORIZED_REPRESENTATIVE",
      oldValue: `${replaced.name} <${replaced.email}>`,
      newValue: `${cleanName} <${cleanEmail}>`,
      sourceDocumentId,
      note: reason,
      actorId
    });
  }

  await recordAudit(env, {
    actorId, actorRole: "platform", action: "clinic_representative.designated",
    subjectType: "tenant", subjectId: tenantId,
    oldState: replaced ? representativeFromRow(replaced) : null,
    newState: { id, name: cleanName, email: cleanEmail, role, authorityScope },
    reason
  });

  return { ok: true, representative: await getAuthorizedRepresentative(env, id) };
}

/** Close a representative's authority without naming a successor. */
export async function endAuthorizedRepresentative(env, { tenantId, representativeId, endReason = "DEPARTED", validTo = null, actorId = null } = {}) {
  const guard = requireDatabase(env);
  if (guard) return guard;
  const row = await env.DB.prepare(
    "SELECT * FROM clinic_authorized_representatives WHERE id = ? AND tenant_id = ? LIMIT 1"
  ).bind(representativeId, tenantId).first();
  if (!row) return { ok: false, status: 404, code: "REPRESENTATIVE_NOT_FOUND", message: "That representative was not found." };
  if (!Number(row.active)) {
    return { ok: true, representative: representativeFromRow(row), alreadyClosed: true };
  }
  await env.DB.prepare(`
    UPDATE clinic_authorized_representatives
       SET active = 0, valid_to = COALESCE(?, CURRENT_TIMESTAMP), end_reason = ?
     WHERE id = ?
  `).bind(text(validTo, 40) || null, text(endReason, 120) || "DEPARTED", representativeId).run();

  await recordAudit(env, {
    actorId, actorRole: "platform", action: "clinic_representative.ended",
    subjectType: "tenant", subjectId: tenantId,
    oldState: representativeFromRow(row), newState: { active: false, endReason },
    reason: endReason
  });
  return { ok: true, representative: await getAuthorizedRepresentative(env, representativeId) };
}

export async function getAuthorizedRepresentative(env, representativeId) {
  if (!hasDatabase(env)) return null;
  const row = await env.DB.prepare(
    "SELECT * FROM clinic_authorized_representatives WHERE id = ? LIMIT 1"
  ).bind(representativeId).first();
  return representativeFromRow(row);
}

/**
 * The clinic's representatives. Defaults to the ones in force; pass
 * `includeHistory` for the full record, newest first.
 */
export async function listAuthorizedRepresentatives(env, tenantId, { includeHistory = false } = {}) {
  if (!hasDatabase(env)) return [];
  const { results } = await env.DB.prepare(`
    SELECT * FROM clinic_authorized_representatives
     WHERE tenant_id = ? ${includeHistory ? "" : "AND active = 1"}
     ORDER BY active DESC, datetime(valid_from) DESC
  `).bind(tenantId).all();
  return (results || []).map(representativeFromRow);
}

/**
 * May this person do this, on this clinic's behalf?
 *
 * The answer §2 gives has three parts, and all three are returned rather than
 * collapsed into a boolean, because the interesting refusals are the ones
 * where the person is genuinely the clinic's representative and still cannot
 * do the thing:
 *
 *   * an unknown or closed-out email is not a representative at all;
 *   * a representative may do the routine list;
 *   * the reserved list needs `ACTUAL_AUTHORITY_TO_BIND`, which is a
 *     documented finding, not a role name.
 *
 * `bounded: true` marks the middle case §12 describes as "deposit
 * configuration within contractual bounds": permitted, but the resulting
 * election has to point at the executed election or a signed change, so the
 * caller is told to demand a source document rather than accepting a click.
 */
export async function canAuthorize(env, tenantId, email, action) {
  const cleanEmail = normalizeEmail(email);
  const wanted = text(action, 60).toUpperCase();
  const isRoutine = ROUTINE_REPRESENTATIVE_ACTIONS.includes(wanted);
  const isReserved = RESERVED_ACTIONS.includes(wanted);

  if (!isRoutine && !isReserved) {
    return {
      allowed: false, code: "UNKNOWN_ACTION",
      message: "That action is not one the agreement describes.",
      action: wanted, reserved: false
    };
  }
  if (!hasDatabase(env)) {
    return { allowed: false, code: "DATABASE_REQUIRED", message: "D1 is required.", action: wanted, reserved: isReserved };
  }
  if (!cleanEmail) {
    return { allowed: false, code: "REPRESENTATIVE_REQUIRED", message: "An authorized representative is required.", action: wanted, reserved: isReserved };
  }

  const row = await env.DB.prepare(`
    SELECT * FROM clinic_authorized_representatives
     WHERE tenant_id = ? AND email = ? AND active = 1
     ORDER BY CASE authority_scope WHEN 'ACTUAL_AUTHORITY_TO_BIND' THEN 0 ELSE 1 END
     LIMIT 1
  `).bind(tenantId, cleanEmail).first();

  if (!row) {
    return {
      allowed: false, code: "NOT_AN_AUTHORIZED_REPRESENTATIVE",
      message: "That person is not a current authorized representative of this clinic.",
      action: wanted, reserved: isReserved
    };
  }
  const representative = representativeFromRow(row);

  if (isReserved) {
    if (representative.authorityScope !== "ACTUAL_AUTHORITY_TO_BIND") {
      return {
        allowed: false,
        code: "ACTUAL_AUTHORITY_REQUIRED",
        // The sentence a support agent will have to repeat, so it says what
        // the agreement says rather than "permission denied".
        message: "An Authorized Representative may not amend the agreement, surrender Founding Clinic status, transfer ownership, materially change pricing, or waive a material claim without actual authority to bind the clinic.",
        action: wanted, reserved: true, representative
      };
    }
    return {
      allowed: true, code: "ACTUAL_AUTHORITY_ON_FILE",
      message: "Actual authority to bind the clinic is on file.",
      action: wanted, reserved: true,
      requiresSourceDocument: true,
      authoritySourceDocumentId: representative.authoritySourceDocumentId,
      representative
    };
  }

  const bounded = wanted === "DEPOSIT_CONFIGURATION";
  return {
    allowed: true, code: "ROUTINE_ADMINISTRATION",
    message: "Routine platform administration is within an authorized representative's authority.",
    action: wanted, reserved: false, bounded,
    requiresSourceDocument: bounded,
    representative
  };
}

/* ═════════════════════════════════════════════ management/ownership log ═══ */

function managementEventFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    contractId: row.contract_id,
    eventType: row.event_type,
    oldValue: row.old_value,
    newValue: row.new_value,
    effectiveAt: row.effective_at,
    noticeReceivedAt: row.notice_received_at,
    changesContractingEntity: Boolean(row.changes_contracting_entity),
    requiresSuccessorReview: Boolean(row.requires_successor_review),
    sourceDocumentId: row.source_document_id,
    note: row.note,
    recordedBy: row.recorded_by,
    recordedAt: row.recorded_at
  };
}

/**
 * Record a change in management, control, ownership, or representatives.
 *
 * **This function cannot end an agreement or cost a clinic its founding
 * status, and that is its most important property.** §3: a change that does
 * not change the contracting legal entity "shall not by itself terminate this
 * Agreement or any Founding Clinic status", and §9: "A mere change of
 * manager, administrator, medical director, or other personnel does not
 * constitute a forfeiture."
 *
 * The result carries `foundingStatusUnchanged` and `agreementContinues` so a
 * caller that was about to do something rash is told, in the return value,
 * that it must not.
 *
 * A LEGAL_ENTITY or OWNER_CONTROL event is different: it does not forfeit
 * anything either, but it raises the §30 assignment question and the §9
 * successor question, so it is flagged for review rather than acted on.
 */
export async function recordManagementEvent(env, {
  tenantId,
  eventType,
  oldValue = null,
  newValue = null,
  effectiveAt = null,
  noticeReceivedAt = null,
  sourceDocumentId = null,
  note = null,
  contractId = null,
  actorId = null
} = {}) {
  const guard = requireDatabase(env);
  if (guard) return guard;
  if (!MANAGEMENT_EVENT_TYPES.includes(eventType)) {
    return { ok: false, status: 422, code: "INVALID_EVENT_TYPE", message: `Event type must be one of ${MANAGEMENT_EVENT_TYPES.join(", ")}.` };
  }
  const tenant = await env.DB.prepare("SELECT id FROM tenants WHERE id = ? LIMIT 1").bind(tenantId).first();
  if (!tenant) return { ok: false, status: 404, code: "TENANT_NOT_FOUND", message: "That clinic was not found." };

  const changesEntity = ENTITY_CHANGING_EVENT_TYPES.includes(eventType);
  const foundingBefore = await foundingStatus(env, tenantId);
  const id = newId("mgmt");

  await env.DB.prepare(`
    INSERT INTO clinic_management_events (
      id, tenant_id, contract_id, event_type, old_value, new_value,
      effective_at, notice_received_at, changes_contracting_entity, requires_successor_review,
      source_document_id, note, recorded_by
    ) VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?, ?, ?, ?, ?, ?)
  `).bind(
    id, tenantId, contractId, eventType, text(oldValue, 400) || null, text(newValue, 400) || null,
    text(effectiveAt, 40) || null, text(noticeReceivedAt, 40) || null,
    changesEntity ? 1 : 0, changesEntity ? 1 : 0,
    text(sourceDocumentId, 120) || null, text(note, 2000) || null, actorId
  ).run();

  const foundingAfter = await foundingStatus(env, tenantId);

  await recordAudit(env, {
    actorId, actorRole: "platform", action: "clinic_management.recorded",
    subjectType: "tenant", subjectId: tenantId,
    oldState: { foundingStatus: foundingBefore.status, plan: foundingBefore.plan },
    newState: {
      eventId: id, eventType, oldValue, newValue,
      changesContractingEntity: changesEntity,
      // Spelled out in the audit trail because this is the fact a clinic will
      // one day ask us to prove.
      foundingStatusUnchanged: true,
      foundingStatus: foundingAfter.status
    },
    reason: note || "Ordinary management change; agreement and founding status continue (§3, §9)."
  });

  return {
    ok: true,
    event: managementEventFromRow(
      await env.DB.prepare("SELECT * FROM clinic_management_events WHERE id = ? LIMIT 1").bind(id).first()
    ),
    /** §3: turnover never terminates the agreement on its own. */
    agreementContinues: true,
    /** §9: and never forfeits the waiver. */
    foundingStatusUnchanged: foundingBefore.status === foundingAfter.status,
    foundingStatus: foundingAfter.status,
    /** §30/§9: an entity change needs a decision, and never gets a default one. */
    requiresSuccessorReview: changesEntity
  };
}

export async function listManagementEvents(env, tenantId, { limit = 200 } = {}) {
  if (!hasDatabase(env)) return [];
  const capped = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const { results } = await env.DB.prepare(`
    SELECT * FROM clinic_management_events WHERE tenant_id = ?
     ORDER BY datetime(effective_at) DESC, rowid DESC LIMIT ?
  `).bind(tenantId, capped).all();
  return (results || []).map(managementEventFromRow);
}

/* ═════════════════════════════════════════════════ founding clinic status ═══ */

function foundingHistoryFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    contractId: row.contract_id,
    status: row.status,
    previousStatus: row.previous_status,
    reason: row.reason,
    causeCategory: row.cause_category,
    grantedAt: row.granted_at,
    grantedBy: row.granted_by,
    rejoinEligible: Boolean(row.rejoin_eligible),
    revokedAt: row.revoked_at,
    revocationReason: row.revocation_reason,
    surrenderedInWriting: Boolean(row.surrendered_in_writing),
    successorPreservation: Boolean(row.successor_preservation),
    sourceDocumentId: row.source_document_id,
    effectiveAt: row.effective_at,
    recordedBy: row.recorded_by,
    recordedAt: row.recorded_at
  };
}

/** The founding history, newest first. Append-only; nothing here is editable. */
export async function listFoundingHistory(env, tenantId, { limit = 200 } = {}) {
  if (!hasDatabase(env)) return [];
  const capped = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const { results } = await env.DB.prepare(`
    SELECT * FROM clinic_founding_status_history WHERE tenant_id = ?
     ORDER BY datetime(effective_at) DESC, rowid DESC LIMIT ?
  `).bind(tenantId, capped).all();
  return (results || []).map(foundingHistoryFromRow);
}

/**
 * A clinic's founding position: the pricing row that decides money, the
 * history row that explains it, and the fee that actually results.
 *
 * The fee comes from `clinicFeeFor`, not from a rule restated here. If those
 * two ever disagreed, the one that bills would win — so there is only one.
 */
export async function foundingStatus(env, tenantId) {
  const empty = {
    tenantId, plan: "STANDARD", status: "NOT_APPLICABLE", rejoinEligible: true,
    grantedAt: null, grantedBy: null, revokedAt: null, revocationReason: null,
    goodStanding: true, sourceDocumentId: null, pricingEffectiveAt: null, latest: null
  };
  if (!hasDatabase(env)) return empty;
  const row = await env.DB.prepare(
    "SELECT * FROM clinic_pricing_assignments WHERE tenant_id = ? LIMIT 1"
  ).bind(tenantId).first();
  const [latest] = await listFoundingHistory(env, tenantId, { limit: 1 });
  if (!row) return { ...empty, latest };
  return {
    tenantId,
    plan: row.plan,
    status: row.founding_status,
    rejoinEligible: Boolean(row.founding_rejoin_eligible),
    grantedAt: row.founding_granted_at,
    grantedBy: row.founding_granted_by,
    revokedAt: row.founding_revoked_at,
    revocationReason: row.founding_revocation_reason,
    goodStanding: Boolean(row.good_standing),
    sourceDocumentId: row.pricing_source_document_id,
    pricingEffectiveAt: row.pricing_effective_at,
    customFeeCents: row.custom_fee_cents === null || row.custom_fee_cents === undefined ? null : Number(row.custom_fee_cents),
    latest
  };
}

/** Append one founding-history row. The only way this table is ever written. */
async function appendFoundingHistory(env, {
  tenantId, status, previousStatus = null, reason = null, causeCategory = null,
  grantedAt = null, grantedBy = null, rejoinEligible = true, revokedAt = null,
  revocationReason = null, surrenderedInWriting = false, successorPreservation = false,
  sourceDocumentId = null, effectiveAt = null, contractId = null, actorId = null
}) {
  const id = newId("fnd");
  await env.DB.prepare(`
    INSERT INTO clinic_founding_status_history (
      id, tenant_id, contract_id, status, previous_status, reason, cause_category,
      granted_at, granted_by, rejoin_eligible, revoked_at, revocation_reason,
      surrendered_in_writing, successor_preservation, source_document_id, effective_at, recorded_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?)
  `).bind(
    id, tenantId, contractId, status, previousStatus, text(reason, 2000) || null, causeCategory,
    text(grantedAt, 40) || null, grantedBy, rejoinEligible ? 1 : 0,
    text(revokedAt, 40) || null, text(revocationReason, 2000) || null,
    surrenderedInWriting ? 1 : 0, successorPreservation ? 1 : 0,
    text(sourceDocumentId, 120) || null, text(effectiveAt, 40) || null, actorId
  ).run();
  return id;
}

/**
 * The contract a pricing decision should point at.
 *
 * `assignPricingPlan` writes `contract_id` on every call, so passing nothing
 * would quietly clear the reference a previous decision established. A price
 * that has lost its agreement reference is a price nobody can defend.
 */
async function resolveContractId(env, tenantId, provided) {
  if (provided) return provided;
  const assignment = await env.DB.prepare(
    "SELECT contract_id FROM clinic_pricing_assignments WHERE tenant_id = ? LIMIT 1"
  ).bind(tenantId).first();
  if (assignment?.contract_id) return assignment.contract_id;
  const contract = await getContract(env, tenantId);
  return contract?.id || null;
}

/** Write the founding provenance columns onto the pricing assignment. */
async function updateFoundingColumns(env, tenantId, fields) {
  const columns = [];
  const values = [];
  for (const [column, value] of Object.entries(fields)) {
    columns.push(`${column} = ?`);
    values.push(value);
  }
  if (!columns.length) return;
  await env.DB.prepare(
    `UPDATE clinic_pricing_assignments SET ${columns.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ?`
  ).bind(...values, tenantId).run();
}

/**
 * Designate a Founding Clinic.
 *
 * §9 makes this an express written designation by ClearKey — so it requires a
 * source document, and it writes the pricing plan through
 * `assignPricingPlan`, the same path any other pricing decision takes. There
 * is no separate founding fee constant anywhere: FOUNDING resolves to $0 in
 * `clinicFeeFor`, and a founding clinic therefore never has a $25 receivable
 * raised against it in the first place (addendum §11).
 */
export async function grantFounding(env, {
  tenantId, sourceDocumentId, contractId = null, effectiveAt = null, actorId = null, reason = null
} = {}) {
  const guard = requireDatabase(env);
  if (guard) return guard;
  if (!sourceDocumentId) {
    return {
      ok: false, status: 422, code: "SOURCE_DOCUMENT_REQUIRED",
      message: "Founding Clinic status is an express written designation by ClearKey; record the document."
    };
  }
  const before = await foundingStatus(env, tenantId);
  if (before.status === "REVOKED_FOR_CAUSE") {
    return {
      ok: false, status: 409, code: "RESTORATION_REQUIRES_EXPRESS_WRITING",
      message: "This clinic lost Founding Clinic status for Cause. Restoration must be express and in writing — use restoreFoundingOnRejoin."
    };
  }

  const assigned = await assignPricingPlan(env, {
    tenantId, plan: "FOUNDING", contractId: await resolveContractId(env, tenantId, contractId),
    actorId, goodStanding: true,
    note: reason || "Founding Clinic designation.",
    reason: reason || "Founding Clinic designation (agreement §9)."
  });
  if (!assigned.ok) return assigned;

  await updateFoundingColumns(env, tenantId, {
    founding_status: "ACTIVE",
    founding_granted_at: text(effectiveAt, 40) || new Date().toISOString(),
    founding_granted_by: actorId,
    founding_rejoin_eligible: 1,
    founding_revoked_at: null,
    founding_revocation_reason: null,
    pricing_source_document_id: text(sourceDocumentId, 120),
    pricing_effective_at: text(effectiveAt, 40) || new Date().toISOString()
  });

  await appendFoundingHistory(env, {
    tenantId, status: "ACTIVE", previousStatus: before.status, reason,
    grantedAt: effectiveAt, grantedBy: actorId, rejoinEligible: true,
    sourceDocumentId, effectiveAt, contractId, actorId
  });

  await recordAudit(env, {
    actorId, actorRole: "platform", action: "clinic_founding.granted",
    subjectType: "tenant", subjectId: tenantId,
    oldState: { status: before.status, plan: before.plan },
    newState: { status: "ACTIVE", plan: "FOUNDING", sourceDocumentId },
    reason: reason || "Founding Clinic designation."
  });

  return { ok: true, founding: await foundingStatus(env, tenantId), fee: await clinicFeeFor(env, tenantId) };
}

/**
 * Move founding status between the non-terminal states.
 *
 * TEMPORARILY_INACTIVE is the one that matters. §9 forbids treating "ordinary
 * inactivity, a temporary operational pause, staffing shortage, renovation,
 * temporary closure, or good-faith voluntary withdrawal as permanent
 * forfeiture" — so this transition **keeps the FOUNDING plan and good
 * standing**, and the clinic's fee stays $0. Nothing about a remodel converts
 * a waiver into a receivable.
 *
 * REVOKED_FOR_CAUSE is refused here. It has its own function, which demands a
 * Cause category.
 */
export async function setFoundingStatus(env, { tenantId, status, reason = null, sourceDocumentId = null, effectiveAt = null, actorId = null } = {}) {
  const guard = requireDatabase(env);
  if (guard) return guard;
  if (!FOUNDING_STATUSES.includes(status)) {
    return { ok: false, status: 422, code: "INVALID_FOUNDING_STATUS", message: `Status must be one of ${FOUNDING_STATUSES.join(", ")}.` };
  }
  if (status === "REVOKED_FOR_CAUSE") {
    return {
      ok: false, status: 422, code: "CAUSE_REQUIRED",
      message: "Revoking Founding Clinic status requires a Cause category — use revokeFoundingForCause."
    };
  }
  const before = await foundingStatus(env, tenantId);
  if (before.status === "NOT_APPLICABLE" && status !== "NOT_APPLICABLE") {
    return { ok: false, status: 409, code: "NOT_A_FOUNDING_CLINIC", message: "This clinic has no Founding Clinic designation to move." };
  }
  if (before.status === "REVOKED_FOR_CAUSE") {
    return {
      ok: false, status: 409, code: "RESTORATION_REQUIRES_EXPRESS_WRITING",
      message: "Founding Clinic status lost for Cause is not restored by a status change."
    };
  }

  // The plan stays FOUNDING through inactivity and separation. §11: "do not
  // convert it to standard $25 pricing simply because it left temporarily."
  await updateFoundingColumns(env, tenantId, {
    founding_status: status,
    founding_rejoin_eligible: 1,
    pricing_source_document_id: text(sourceDocumentId, 120) || before.sourceDocumentId || null
  });

  await appendFoundingHistory(env, {
    tenantId, status, previousStatus: before.status, reason,
    grantedAt: before.grantedAt, grantedBy: before.grantedBy,
    rejoinEligible: true, sourceDocumentId, effectiveAt, actorId
  });

  await recordAudit(env, {
    actorId, actorRole: "platform", action: "clinic_founding.status_changed",
    subjectType: "tenant", subjectId: tenantId,
    oldState: { status: before.status, plan: before.plan },
    newState: { status, plan: (await foundingStatus(env, tenantId)).plan, preservesWaiver: true },
    reason: reason || "Founding status change; the fee waiver is preserved (§9)."
  });

  return { ok: true, founding: await foundingStatus(env, tenantId), fee: await clinicFeeFor(env, tenantId) };
}

/**
 * Surrender founding status at the clinic's request.
 *
 * §9(d) allows the Parties to agree in writing that the privilege was
 * surrendered — but §2 does not let an ordinary Authorized Representative
 * agree to it, so the request must come from someone with actual authority to
 * bind the clinic, and must point at the writing.
 */
export async function surrenderFounding(env, { tenantId, requestedByEmail, sourceDocumentId, reason = null, actorId = null } = {}) {
  const guard = requireDatabase(env);
  if (guard) return guard;
  const authority = await canAuthorize(env, tenantId, requestedByEmail, "SURRENDER_FOUNDING_STATUS");
  if (!authority.allowed) {
    return { ok: false, status: 403, code: authority.code, message: authority.message, details: { action: "SURRENDER_FOUNDING_STATUS" } };
  }
  if (!sourceDocumentId) {
    return {
      ok: false, status: 422, code: "WRITTEN_SURRENDER_REQUIRED",
      message: "Surrender of Founding Clinic status must be expressly agreed in writing."
    };
  }
  const before = await foundingStatus(env, tenantId);
  if (before.status === "NOT_APPLICABLE") {
    return { ok: false, status: 409, code: "NOT_A_FOUNDING_CLINIC", message: "This clinic has no Founding Clinic designation." };
  }

  const assigned = await assignPricingPlan(env, {
    tenantId, plan: "STANDARD", contractId: await resolveContractId(env, tenantId, null),
    actorId, goodStanding: true,
    note: "Founding Clinic status surrendered in writing.",
    reason: reason || "Written surrender of Founding Clinic status (§9(d))."
  });
  if (!assigned.ok) return assigned;

  await updateFoundingColumns(env, tenantId, {
    founding_status: "NOT_APPLICABLE",
    founding_rejoin_eligible: 0,
    pricing_source_document_id: text(sourceDocumentId, 120),
    pricing_effective_at: new Date().toISOString()
  });
  await appendFoundingHistory(env, {
    tenantId, status: "NOT_APPLICABLE", previousStatus: before.status,
    reason: reason || "Surrendered in writing.", rejoinEligible: false,
    surrenderedInWriting: true, sourceDocumentId, actorId
  });
  await recordAudit(env, {
    actorId, actorRole: "platform", action: "clinic_founding.surrendered",
    subjectType: "tenant", subjectId: tenantId,
    oldState: { status: before.status }, newState: { status: "NOT_APPLICABLE", surrenderedInWriting: true, sourceDocumentId },
    reason
  });
  return { ok: true, founding: await foundingStatus(env, tenantId), fee: await clinicFeeFor(env, tenantId) };
}

/**
 * Revoke founding status for Cause.
 *
 * The only route to REVOKED_FOR_CAUSE, and it demands one of §9's enumerated
 * categories plus a written reason. A revocation reason drawn from the
 * non-forfeiting list — inactivity, a remodel, a new practice manager, missed
 * calls — is refused outright: those are the exact circumstances §9 says must
 * not cost a clinic its status, and an operator picking the wrong dropdown
 * should hit a wall rather than a $25 invoice.
 */
export async function revokeFoundingForCause(env, {
  tenantId, causeCategory, reason, sourceDocumentId = null, effectiveAt = null, actorId = null
} = {}) {
  const guard = requireDatabase(env);
  if (guard) return guard;
  if (!CAUSE_CATEGORIES.includes(causeCategory)) {
    return {
      ok: false, status: 422, code: "INVALID_CAUSE",
      message: `Cause must be one of the agreement's enumerated categories: ${CAUSE_CATEGORIES.join(", ")}.`
    };
  }
  if (!text(reason, 2000)) {
    return { ok: false, status: 422, code: "REASON_REQUIRED", message: "Revocation for Cause requires a written reason." };
  }
  if (NON_FORFEITING_CIRCUMSTANCES.includes(text(reason, 60).toUpperCase())) {
    return {
      ok: false, status: 422, code: "NOT_A_FORFEITING_CIRCUMSTANCE",
      message: "Inactivity, temporary closure, staffing shortage, renovation, a seasonal pause, a management change, or missed calls are not grounds to revoke Founding Clinic status."
    };
  }
  const before = await foundingStatus(env, tenantId);
  if (before.status === "NOT_APPLICABLE") {
    return { ok: false, status: 409, code: "NOT_A_FOUNDING_CLINIC", message: "This clinic has no Founding Clinic designation to revoke." };
  }

  // Prospective only: the clinic pays the standard fee on visits completed
  // from now on. Nothing re-bills what was already waived.
  const assigned = await assignPricingPlan(env, {
    tenantId, plan: "STANDARD", contractId: await resolveContractId(env, tenantId, null),
    actorId, goodStanding: false,
    note: `Founding status revoked for Cause: ${causeCategory}.`,
    reason
  });
  if (!assigned.ok) return assigned;

  const when = text(effectiveAt, 40) || new Date().toISOString();
  await updateFoundingColumns(env, tenantId, {
    founding_status: "REVOKED_FOR_CAUSE",
    founding_rejoin_eligible: 0,
    founding_revoked_at: when,
    founding_revocation_reason: text(reason, 2000),
    pricing_source_document_id: text(sourceDocumentId, 120) || before.sourceDocumentId || null,
    pricing_effective_at: when
  });
  await appendFoundingHistory(env, {
    tenantId, status: "REVOKED_FOR_CAUSE", previousStatus: before.status,
    reason, causeCategory, rejoinEligible: false, revokedAt: when,
    revocationReason: reason, sourceDocumentId, effectiveAt: when, actorId
  });
  await recordAudit(env, {
    actorId, actorRole: "platform", action: "clinic_founding.revoked_for_cause",
    subjectType: "tenant", subjectId: tenantId,
    oldState: { status: before.status, plan: before.plan },
    newState: { status: "REVOKED_FOR_CAUSE", plan: "STANDARD", causeCategory, rejoinEligible: false },
    reason
  });

  return { ok: true, founding: await foundingStatus(env, tenantId), fee: await clinicFeeFor(env, tenantId) };
}

/**
 * Expressly preserve founding status for a bona fide successor.
 *
 * §3: ClearKey "may, in its discretion, preserve Founding Clinic status for a
 * bona fide successor operating substantially the same veterinary practice,
 * but no purchaser or successor acquires such status merely by acquiring
 * assets, a location, goodwill, or a trade name."
 *
 * That "may" is why this is a separate, deliberate function rather than a
 * branch inside an ownership-change handler. Nothing inherits founding status
 * by default; somebody decides, in writing, and their name is on it.
 */
export async function preserveFoundingForSuccessor(env, {
  tenantId, successorLegalName, sourceDocumentId, bonaFideSuccessor = false,
  substantiallySamePractice = false, reason = null, actorId = null
} = {}) {
  const guard = requireDatabase(env);
  if (guard) return guard;
  if (!bonaFideSuccessor || !substantiallySamePractice) {
    return {
      ok: false, status: 422, code: "SUCCESSOR_FINDING_REQUIRED",
      message: "Preserving Founding Clinic status requires an affirmative finding of a bona fide successor operating substantially the same practice."
    };
  }
  if (!sourceDocumentId) {
    return {
      ok: false, status: 422, code: "SOURCE_DOCUMENT_REQUIRED",
      message: "Preservation for a successor must be an express recorded decision by ClearKey."
    };
  }
  const before = await foundingStatus(env, tenantId);
  if (before.status === "REVOKED_FOR_CAUSE") {
    return {
      ok: false, status: 409, code: "RESTORATION_REQUIRES_EXPRESS_WRITING",
      message: "Founding Clinic status lost for Cause is not preserved through a successor."
    };
  }

  const granted = await grantFounding(env, {
    tenantId, sourceDocumentId, effectiveAt: null, actorId,
    reason: reason || `Founding Clinic status expressly preserved for bona fide successor ${text(successorLegalName, 200)}.`
  });
  if (!granted.ok) return granted;

  await appendFoundingHistory(env, {
    tenantId, status: "ACTIVE", previousStatus: before.status,
    reason: reason || "Successor preservation.", successorPreservation: true,
    grantedBy: actorId, sourceDocumentId, actorId
  });
  await recordAudit(env, {
    actorId, actorRole: "platform", action: "clinic_founding.successor_preserved",
    subjectType: "tenant", subjectId: tenantId,
    oldState: { status: before.status },
    newState: { status: "ACTIVE", successorLegalName: text(successorLegalName, 200), sourceDocumentId },
    reason
  });
  return { ok: true, founding: await foundingStatus(env, tenantId), fee: await clinicFeeFor(env, tenantId) };
}

/* ═════════════════════════════════════════════════════ surviving obligations ═══ */

/**
 * What is still owed, and to whom, at the moment a clinic leaves.
 *
 * §27 makes these survive separation, and §9(b) makes them a bar to restoring
 * the founding waiver on rejoin. Both readers get the same function, so a
 * clinic cannot be told it is clear on the way out and blocked on the way in.
 */
export async function survivingObligations(env, tenantId) {
  const summary = {
    kinds: SURVIVING_OBLIGATION_KINDS,
    outstandingReceivableCount: 0,
    outstandingReceivableCents: 0,
    openInvoiceCount: 0,
    openInvoiceCents: 0,
    uncured: false
  };
  if (!hasDatabase(env)) return summary;

  const receivables = await env.DB.prepare(`
    SELECT COUNT(*) AS c, COALESCE(SUM(amount_cents), 0) AS cents
      FROM clinic_fee_receivables
     WHERE tenant_id = ? AND state IN (${UNCURED_RECEIVABLE_STATES.map(() => "?").join(", ")})
  `).bind(tenantId, ...UNCURED_RECEIVABLE_STATES).first();
  const invoices = await env.DB.prepare(`
    SELECT COUNT(*) AS c, COALESCE(SUM(total_cents), 0) AS cents
      FROM clinic_invoices
     WHERE tenant_id = ? AND status IN (${UNCURED_INVOICE_STATES.map(() => "?").join(", ")})
  `).bind(tenantId, ...UNCURED_INVOICE_STATES).first();

  summary.outstandingReceivableCount = Number(receivables?.c || 0);
  summary.outstandingReceivableCents = Number(receivables?.cents || 0);
  summary.openInvoiceCount = Number(invoices?.c || 0);
  summary.openInvoiceCents = Number(invoices?.cents || 0);
  summary.uncured = summary.outstandingReceivableCount > 0 || summary.openInvoiceCount > 0;
  return summary;
}

/**
 * Confirmed bookings that must be seen through.
 *
 * §27: ClearKey stops sending new referrals when termination takes effect,
 * "subject to orderly completion of already-confirmed bookings." An owner
 * with a confirmed appointment tomorrow is not a party to the clinic's
 * decision to leave, and their appointment does not evaporate with it.
 */
export async function windDownBookings(env, tenantId) {
  if (!hasDatabase(env)) return [];
  const { results } = await env.DB.prepare(`
    SELECT id, public_code, status, requested_at
      FROM intake_requests
     WHERE tenant_id = ? AND status IN (${WIND_DOWN_BOOKING_STATES.map(() => "?").join(", ")})
     ORDER BY datetime(requested_at) DESC
     LIMIT 500
  `).bind(tenantId, ...WIND_DOWN_BOOKING_STATES).all();
  return (results || []).map((row) => ({
    intakeId: row.id, publicCode: row.public_code, status: row.status, requestedAt: row.requested_at
  }));
}

/* ═══════════════════════════════════════════════════════════ lifecycle ═══ */

function lifecycleFromRow(row) {
  if (!row) return null;
  return {
    tenantId: row.tenant_id,
    contractId: row.contract_id,
    status: row.status,
    reason: row.reason,
    suspensionReason: row.suspension_reason,
    terminationReason: row.termination_reason,
    terminatedForCause: Boolean(row.terminated_for_cause),
    effectiveAt: row.effective_at,
    separationEffectiveAt: row.separation_effective_at,
    activeForReferrals: Boolean(row.active_for_referrals),
    lastAdminReviewAt: row.last_admin_review_at,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function clinicLifecycle(env, tenantId) {
  if (!hasDatabase(env)) return null;
  const row = await env.DB.prepare("SELECT * FROM clinic_lifecycle WHERE tenant_id = ? LIMIT 1").bind(tenantId).first();
  return lifecycleFromRow(row);
}

export async function listLifecycleEvents(env, tenantId, { limit = 200 } = {}) {
  if (!hasDatabase(env)) return [];
  const capped = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const { results } = await env.DB.prepare(`
    SELECT * FROM clinic_lifecycle_events WHERE tenant_id = ?
     ORDER BY datetime(effective_at) DESC, rowid DESC LIMIT ?
  `).bind(tenantId, capped).all();
  return (results || []).map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    reason: row.reason,
    triggerSource: row.trigger_source,
    separationEventId: row.separation_event_id,
    rejoinRequestId: row.rejoin_request_id,
    effectiveAt: row.effective_at,
    recordedBy: row.recorded_by,
    recordedAt: row.recorded_at
  }));
}

/** Write the lifecycle row and its event. Internal; the exported doors validate. */
async function writeLifecycle(env, {
  tenantId, toStatus, reason = null, triggerSource = "ADMIN", contractId = null,
  suspensionReason = null, terminationReason = null, separationEffectiveAt = null,
  separationEventId = null, rejoinRequestId = null, effectiveAt = null, actorId = null
}) {
  const current = await clinicLifecycle(env, tenantId);
  const forCause = toStatus === "TERMINATED_FOR_CAUSE";
  const activeForReferrals = toStatus === "ACTIVE";
  const when = text(effectiveAt, 40) || new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO clinic_lifecycle (
      tenant_id, contract_id, status, reason, suspension_reason, termination_reason,
      terminated_for_cause, effective_at, separation_effective_at, active_for_referrals, updated_by, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(tenant_id) DO UPDATE SET
      contract_id = COALESCE(excluded.contract_id, clinic_lifecycle.contract_id),
      status = excluded.status,
      reason = excluded.reason,
      suspension_reason = excluded.suspension_reason,
      termination_reason = excluded.termination_reason,
      terminated_for_cause = excluded.terminated_for_cause,
      effective_at = excluded.effective_at,
      separation_effective_at = excluded.separation_effective_at,
      active_for_referrals = excluded.active_for_referrals,
      updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    tenantId, contractId, toStatus, text(reason, 2000) || null,
    toStatus === "SUSPENDED" ? text(suspensionReason, 2000) || text(reason, 2000) || null : null,
    forCause || toStatus === "SEPARATED" ? text(terminationReason, 2000) || text(reason, 2000) || null : null,
    forCause ? 1 : 0, when, text(separationEffectiveAt, 40) || null,
    activeForReferrals ? 1 : 0, actorId
  ).run();

  await env.DB.prepare(`
    INSERT INTO clinic_lifecycle_events (
      id, tenant_id, from_status, to_status, reason, trigger_source,
      separation_event_id, rejoin_request_id, effective_at, recorded_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    newId("lce"), tenantId, current?.status || null, toStatus, text(reason, 2000) || null,
    triggerSource, separationEventId, rejoinRequestId, when, actorId
  ).run();

  await recordAudit(env, {
    actorId, actorRole: "platform", action: "clinic_lifecycle.changed",
    subjectType: "tenant", subjectId: tenantId,
    oldState: current ? { status: current.status } : null,
    newState: { status: toStatus, triggerSource, activeForReferrals },
    reason
  });

  return clinicLifecycle(env, tenantId);
}

/**
 * Move a clinic's lifecycle state.
 *
 * Two refusals live here, and both are contract text rather than policy:
 *
 *   * A separation state cannot be entered through this door at all. Leaving
 *     is `separateClinic`, which records the event, the wind-down, and the
 *     surviving obligations. A lifecycle field flipped to SEPARATED with no
 *     separation event behind it is a clinic that vanished without a record.
 *
 *   * Missed calls cannot justify anything worse than TEMPORARILY_INACTIVE.
 *     §27: "Mere failure to respond to requests, seasonal closure, staffing
 *     shortage, or temporary inactivity does not automatically constitute
 *     termination."
 */
export async function setLifecycleStatus(env, {
  tenantId, status, reason = null, triggerSource = "ADMIN", suspensionReason = null, effectiveAt = null, actorId = null
} = {}) {
  const guard = requireDatabase(env);
  if (guard) return guard;
  if (!CLINIC_LIFECYCLE_STATES.includes(status)) {
    return { ok: false, status: 422, code: "INVALID_LIFECYCLE_STATUS", message: `Status must be one of ${CLINIC_LIFECYCLE_STATES.join(", ")}.` };
  }
  const tenant = await env.DB.prepare("SELECT id FROM tenants WHERE id = ? LIMIT 1").bind(tenantId).first();
  if (!tenant) return { ok: false, status: 404, code: "TENANT_NOT_FOUND", message: "That clinic was not found." };

  const separationStates = ["VOLUNTARY_SEPARATION_PENDING", "SEPARATED", "TERMINATED_FOR_CAUSE"];
  // Checked before the general refusal below, so an unanswered-call job is
  // told the specific thing that is wrong with what it asked for.
  const source = text(triggerSource, 40).toUpperCase() || "ADMIN";
  if (source === "MISSED_CALLS" && !["TEMPORARILY_INACTIVE", "ACTIVE"].includes(status)) {
    return {
      ok: false, status: 422, code: "MISSED_CALLS_ARE_NOT_SEPARATION",
      message: "Unanswered availability calls are not a contractual separation. The most they support is TEMPORARILY_INACTIVE."
    };
  }
  if (separationStates.includes(status)) {
    return {
      ok: false, status: 422, code: "SEPARATION_REQUIRES_EVENT",
      message: "Separating or terminating a clinic must go through separateClinic, which records the notice, wind-down, and surviving obligations."
    };
  }
  if (NON_FORFEITING_CIRCUMSTANCES.includes(text(reason, 60).toUpperCase()) && separationStates.includes(status)) {
    return {
      ok: false, status: 422, code: "NOT_A_SEPARATION_EVENT",
      message: "That circumstance does not end a clinic's participation under the agreement."
    };
  }

  const lifecycle = await writeLifecycle(env, {
    tenantId, toStatus: status, reason, triggerSource: source, suspensionReason, effectiveAt, actorId
  });
  return { ok: true, lifecycle, foundingStatus: (await foundingStatus(env, tenantId)).status };
}

/**
 * Record unanswered availability calls, and change nothing.
 *
 * This function exists to be the thing an IVR retry loop calls, so that the
 * loop has somewhere to put the fact without reaching for a state machine. It
 * writes an audit note and returns the lifecycle it found — identical to the
 * one it was given. §27 is explicit that silence is not termination, and a
 * clinic that missed four calls on a Sunday night is a clinic that missed
 * four calls on a Sunday night.
 *
 * If a human decides the pattern warrants it, `setLifecycleStatus` can move
 * the clinic to TEMPORARILY_INACTIVE — still contracted, still founding, no
 * referrals. That is the entire available consequence.
 */
export async function noteMissedCalls(env, { tenantId, missedCount = 1, windowDescription = null, actorId = null } = {}) {
  const guard = requireDatabase(env);
  if (guard) return guard;
  const before = await clinicLifecycle(env, tenantId);
  const founding = await foundingStatus(env, tenantId);
  await recordAudit(env, {
    actorId, actorRole: "system", action: "clinic_lifecycle.missed_calls_noted",
    subjectType: "tenant", subjectId: tenantId,
    oldState: { status: before?.status || null, foundingStatus: founding.status },
    newState: {
      status: before?.status || null,
      foundingStatus: founding.status,
      missedCount: Math.max(0, Math.trunc(Number(missedCount) || 0)),
      lifecycleChanged: false,
      note: "Unanswered availability calls are not a contractual separation (§27)."
    },
    reason: windowDescription || "Missed availability calls recorded; no lifecycle or founding effect."
  });
  return {
    ok: true,
    lifecycle: before,
    lifecycleChanged: false,
    foundingStatus: founding.status,
    separationRecorded: false
  };
}

/* ═══════════════════════════════════════════════════ separation / rejoin ═══ */

function separationFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    contractId: row.contract_id,
    kind: row.kind,
    initiatedBy: row.initiated_by,
    causeCategory: row.cause_category,
    reason: row.reason,
    noticeReceivedAt: row.notice_received_at,
    effectiveAt: row.effective_at,
    windDownBookingCount: Number(row.wind_down_booking_count || 0),
    windDownComplete: Boolean(row.wind_down_complete),
    survivingObligations: parseJsonColumn(row.surviving_obligations_json, {}),
    obligationsCleared: Boolean(row.obligations_cleared),
    foundingStatusAtSeparation: row.founding_status_at_separation,
    sourceDocumentId: row.source_document_id,
    recordedBy: row.recorded_by,
    recordedAt: row.recorded_at
  };
}

export async function listSeparationEvents(env, tenantId) {
  if (!hasDatabase(env)) return [];
  const { results } = await env.DB.prepare(
    "SELECT * FROM clinic_separation_events WHERE tenant_id = ? ORDER BY datetime(recorded_at) DESC, rowid DESC LIMIT 200"
  ).bind(tenantId).all();
  return (results || []).map(separationFromRow);
}

/**
 * Separate a clinic from the Platform.
 *
 * Three kinds, three different consequences for the waiver:
 *
 *   VOLUNTARY / WITHOUT_CAUSE — founding status becomes
 *   SEPARATED_ELIGIBLE_TO_RESTORE and the FOUNDING plan is left in place.
 *   §9: good-faith withdrawal is not permanent forfeiture, and §11 adds "do
 *   not convert it to standard $25 pricing simply because it left
 *   temporarily."
 *
 *   FOR_CAUSE — an enumerated category is required, founding status is
 *   revoked, rejoin eligibility is closed, and §28 governs anything after.
 *
 * A reason drawn from the non-forfeiting list is refused for every kind. A
 * remodel is not a separation, and neither is a quiet week.
 *
 * When confirmed bookings are outstanding the clinic lands in
 * VOLUNTARY_SEPARATION_PENDING rather than SEPARATED: §27 requires orderly
 * completion of what is already booked, and the state says so out loud
 * instead of leaving owners attached to a closed account.
 */
export async function separateClinic(env, {
  tenantId,
  kind = "VOLUNTARY",
  initiatedBy = "CLINIC",
  reason = null,
  causeCategory = null,
  noticeReceivedAt = null,
  effectiveAt = null,
  sourceDocumentId = null,
  contractId = null,
  actorId = null
} = {}) {
  const guard = requireDatabase(env);
  if (guard) return guard;
  const kinds = ["VOLUNTARY", "WITHOUT_CAUSE", "FOR_CAUSE"];
  if (!kinds.includes(kind)) {
    return { ok: false, status: 422, code: "INVALID_SEPARATION_KIND", message: `Kind must be one of ${kinds.join(", ")}.` };
  }
  if (kind === "FOR_CAUSE" && !CAUSE_CATEGORIES.includes(causeCategory)) {
    return {
      ok: false, status: 422, code: "INVALID_CAUSE",
      message: `Termination for Cause requires one of: ${CAUSE_CATEGORIES.join(", ")}.`
    };
  }
  if (kind !== "FOR_CAUSE" && causeCategory) {
    return { ok: false, status: 422, code: "CAUSE_ON_NON_CAUSE_SEPARATION", message: "Only a FOR_CAUSE separation carries a Cause category." };
  }
  if (NON_FORFEITING_CIRCUMSTANCES.includes(text(reason, 60).toUpperCase())) {
    return {
      ok: false, status: 422, code: "NOT_A_SEPARATION_EVENT",
      message: "Inactivity, temporary closure, a staffing shortage, a renovation, a seasonal pause, a management change, or missed calls do not separate a clinic from the Platform."
    };
  }
  const tenant = await env.DB.prepare("SELECT id FROM tenants WHERE id = ? LIMIT 1").bind(tenantId).first();
  if (!tenant) return { ok: false, status: 404, code: "TENANT_NOT_FOUND", message: "That clinic was not found." };

  const foundingBefore = await foundingStatus(env, tenantId);
  const obligations = await survivingObligations(env, tenantId);
  const pending = await windDownBookings(env, tenantId);

  const id = newId("sep");
  await env.DB.prepare(`
    INSERT INTO clinic_separation_events (
      id, tenant_id, contract_id, kind, initiated_by, cause_category, reason,
      notice_received_at, effective_at, wind_down_booking_count, surviving_obligations_json,
      obligations_cleared, founding_status_at_separation, source_document_id, recorded_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, tenantId, contractId, kind, initiatedBy, causeCategory, text(reason, 2000) || null,
    text(noticeReceivedAt, 40) || null, text(effectiveAt, 40) || null,
    pending.length, JSON.stringify(obligations), obligations.uncured ? 0 : 1,
    foundingBefore.status, text(sourceDocumentId, 120) || null, actorId
  ).run();

  // Founding consequences. Only Cause is terminal.
  if (foundingBefore.status !== "NOT_APPLICABLE") {
    if (kind === "FOR_CAUSE") {
      const revoked = await revokeFoundingForCause(env, {
        tenantId, causeCategory, reason: reason || `Terminated for Cause: ${causeCategory}.`,
        sourceDocumentId, effectiveAt, actorId
      });
      if (!revoked.ok) return revoked;
    } else if (foundingBefore.status !== "SEPARATED_ELIGIBLE_TO_RESTORE") {
      const moved = await setFoundingStatus(env, {
        tenantId, status: "SEPARATED_ELIGIBLE_TO_RESTORE",
        reason: reason || "Good-faith separation; the fee waiver is dormant, not lost (§9).",
        sourceDocumentId, effectiveAt, actorId
      });
      if (!moved.ok) return moved;
    }
  }

  const toStatus = kind === "FOR_CAUSE"
    ? "TERMINATED_FOR_CAUSE"
    : pending.length > 0 || (effectiveAt && Date.parse(effectiveAt) > Date.now())
      ? "VOLUNTARY_SEPARATION_PENDING"
      : "SEPARATED";

  const lifecycle = await writeLifecycle(env, {
    tenantId, toStatus, reason, triggerSource: kind === "FOR_CAUSE" ? "RISK_REVIEW" : "CLINIC_NOTICE",
    contractId, terminationReason: reason, separationEffectiveAt: effectiveAt,
    separationEventId: id, effectiveAt, actorId
  });

  await recordAudit(env, {
    actorId, actorRole: "platform", action: "clinic_separation.recorded",
    subjectType: "tenant", subjectId: tenantId,
    oldState: { lifecycle: null, foundingStatus: foundingBefore.status },
    newState: {
      separationEventId: id, kind, causeCategory, lifecycleStatus: toStatus,
      foundingStatus: (await foundingStatus(env, tenantId)).status,
      windDownBookingCount: pending.length,
      survivingObligations: obligations
    },
    reason
  });

  return {
    ok: true,
    separation: separationFromRow(
      await env.DB.prepare("SELECT * FROM clinic_separation_events WHERE id = ? LIMIT 1").bind(id).first()
    ),
    lifecycle,
    founding: await foundingStatus(env, tenantId),
    /** §27: already-confirmed bookings are seen through, not cancelled. */
    windDownBookings: pending,
    survivingObligations: obligations
  };
}

/** Close out a pending separation once the confirmed bookings are finished. */
export async function completeWindDown(env, { tenantId, separationEventId, actorId = null, reason = null } = {}) {
  const guard = requireDatabase(env);
  if (guard) return guard;
  const row = await env.DB.prepare(
    "SELECT * FROM clinic_separation_events WHERE id = ? AND tenant_id = ? LIMIT 1"
  ).bind(separationEventId, tenantId).first();
  if (!row) return { ok: false, status: 404, code: "SEPARATION_NOT_FOUND", message: "That separation event was not found." };

  const pending = await windDownBookings(env, tenantId);
  if (pending.length) {
    return {
      ok: false, status: 409, code: "WIND_DOWN_INCOMPLETE",
      message: "Confirmed bookings are still outstanding; §27 requires orderly completion before the account goes quiet.",
      details: { outstanding: pending.length }
    };
  }
  const obligations = await survivingObligations(env, tenantId);
  await env.DB.prepare(`
    UPDATE clinic_separation_events
       SET wind_down_complete = 1, surviving_obligations_json = ?, obligations_cleared = ?
     WHERE id = ?
  `).bind(JSON.stringify(obligations), obligations.uncured ? 0 : 1, separationEventId).run();

  const lifecycle = row.kind === "FOR_CAUSE"
    ? await clinicLifecycle(env, tenantId)
    : await writeLifecycle(env, {
      tenantId, toStatus: "SEPARATED", reason: reason || "Wind-down complete.",
      triggerSource: "ADMIN", separationEventId, terminationReason: row.reason, actorId
    });

  return { ok: true, lifecycle, survivingObligations: obligations };
}

/**
 * A former clinic asks to come back (§28).
 *
 * The request records what is *claimed* — same legal entity, substantially
 * the same practice — separately from what is later verified, and evaluates
 * the four §9 bars up front so the review starts with the answer in front of
 * it. It decides nothing: `restoreFoundingOnRejoin` does that, on an express
 * decision by a named person.
 */
export async function requestRejoin(env, {
  tenantId,
  requestedByName = null,
  requestedByEmail = null,
  claimsSameLegalEntity = false,
  claimsSamePractice = false,
  separationEventId = null,
  actorId = null
} = {}) {
  const guard = requireDatabase(env);
  if (guard) return guard;
  const tenant = await env.DB.prepare("SELECT id FROM tenants WHERE id = ? LIMIT 1").bind(tenantId).first();
  if (!tenant) return { ok: false, status: 404, code: "TENANT_NOT_FOUND", message: "That clinic was not found." };

  const founding = await foundingStatus(env, tenantId);
  const lifecycle = await clinicLifecycle(env, tenantId);
  const obligations = await survivingObligations(env, tenantId);
  const history = await listFoundingHistory(env, tenantId);

  const barPriorCause = founding.status === "REVOKED_FOR_CAUSE"
    || history.some((entry) => entry.status === "REVOKED_FOR_CAUSE")
    || Boolean(lifecycle?.terminatedForCause);
  const barWrittenSurrender = history.some((entry) => entry.surrenderedInWriting);
  const barCircumvention = history.some((entry) => [
    "INTENTIONAL_FEE_CIRCUMVENTION", "PAW_IT_FORWARD_FUND_MISUSE",
    "DEPOSIT_DOUBLE_COLLECTION", "VISIT_OR_PAYMENT_FALSIFICATION", "FRAUD"
  ].includes(entry.causeCategory));

  const latestSeparation = separationEventId || (await listSeparationEvents(env, tenantId))[0]?.id || null;

  const id = newId("rjn");
  await env.DB.prepare(`
    INSERT INTO clinic_rejoin_requests (
      id, tenant_id, separation_event_id, requested_by_name, requested_by_email,
      claims_same_legal_entity, claims_same_practice,
      bar_prior_cause, bar_uncured_obligations, bar_circumvention_or_misuse, bar_written_surrender,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SUBMITTED')
  `).bind(
    id, tenantId, latestSeparation, text(requestedByName, 160) || null, normalizeEmail(requestedByEmail) || null,
    claimsSameLegalEntity ? 1 : 0, claimsSamePractice ? 1 : 0,
    barPriorCause ? 1 : 0, obligations.uncured ? 1 : 0, barCircumvention ? 1 : 0, barWrittenSurrender ? 1 : 0
  ).run();

  const lifecycleAfter = await writeLifecycle(env, {
    tenantId, toStatus: "REJOIN_REVIEW", reason: "Reactivation requested (§28).",
    triggerSource: "REJOIN", rejoinRequestId: id, actorId
  });

  await recordAudit(env, {
    actorId, actorRole: "platform", action: "clinic_rejoin.requested",
    subjectType: "tenant", subjectId: tenantId,
    oldState: { lifecycle: lifecycle?.status || null, foundingStatus: founding.status },
    newState: {
      rejoinRequestId: id, claimsSameLegalEntity, claimsSamePractice,
      bars: { barPriorCause, barUncuredObligations: obligations.uncured, barCircumvention, barWrittenSurrender }
    },
    reason: "Reactivation requested."
  });

  return {
    ok: true,
    rejoinRequest: await getRejoinRequest(env, id),
    lifecycle: lifecycleAfter,
    survivingObligations: obligations,
    /** The §9 bars, evaluated but not decided. */
    bars: { barPriorCause, barUncuredObligations: obligations.uncured, barCircumvention, barWrittenSurrender }
  };
}

export async function getRejoinRequest(env, rejoinRequestId) {
  if (!hasDatabase(env)) return null;
  const row = await env.DB.prepare("SELECT * FROM clinic_rejoin_requests WHERE id = ? LIMIT 1").bind(rejoinRequestId).first();
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    separationEventId: row.separation_event_id,
    requestedAt: row.requested_at,
    requestedByName: row.requested_by_name,
    requestedByEmail: row.requested_by_email,
    claimsSameLegalEntity: Boolean(row.claims_same_legal_entity),
    claimsSamePractice: Boolean(row.claims_same_practice),
    verifiedSameLegalEntity: row.verified_same_legal_entity === null ? null : Boolean(row.verified_same_legal_entity),
    verifiedSamePractice: row.verified_same_practice === null ? null : Boolean(row.verified_same_practice),
    bars: {
      priorCause: Boolean(row.bar_prior_cause),
      uncuredObligations: Boolean(row.bar_uncured_obligations),
      circumventionOrMisuse: Boolean(row.bar_circumvention_or_misuse),
      writtenSurrender: Boolean(row.bar_written_surrender)
    },
    status: row.status,
    foundingRestored: Boolean(row.founding_restored),
    foundingDecisionNote: row.founding_decision_note,
    expressWrittenRestorationDocumentId: row.express_written_restoration_document_id,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    decisionReason: row.decision_reason
  };
}

export async function listRejoinRequests(env, { tenantId = null, status = null, limit = 100 } = {}) {
  if (!hasDatabase(env)) return [];
  const capped = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const clauses = [];
  const values = [];
  if (tenantId) { clauses.push("tenant_id = ?"); values.push(tenantId); }
  if (status) { clauses.push("status = ?"); values.push(status); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { results } = await env.DB.prepare(
    `SELECT id FROM clinic_rejoin_requests ${where} ORDER BY datetime(requested_at) DESC, rowid DESC LIMIT ?`
  ).bind(...values, capped).all();
  const out = [];
  for (const row of results || []) out.push(await getRejoinRequest(env, row.id));
  return out;
}

/**
 * Decide a rejoin, and whether the founding waiver comes back with it.
 *
 * §9's rule, in order:
 *
 *   1. The same contracting legal entity and substantially the same practice.
 *      Anything else is a *successor*, and §3 is emphatic that "no purchaser
 *      or successor acquires such status merely by acquiring assets, a
 *      location, goodwill, or a trade name." A new entity therefore gets
 *      `NEW_ENTITY_NO_AUTOMATIC_INHERITANCE` and is pointed at
 *      `preserveFoundingForSuccessor`, which requires a real decision.
 *
 *   2. No prior loss for Cause. §28 makes restoration after Cause "express
 *      and in writing" — so it needs `expressWrittenRestoration` plus a
 *      document id, and even then it is discretionary rather than owed.
 *
 *   3. No uncured amounts, chargebacks, refunds, or surviving obligations.
 *
 *   4. No intentional fee circumvention or program misuse, and no written
 *      surrender.
 *
 * Pass all four and the waiver is restored — not re-granted as a favor.
 * §11: "do not convert it to standard $25 pricing simply because it left
 * temporarily."
 */
export async function restoreFoundingOnRejoin(env, {
  tenantId,
  rejoinRequestId = null,
  verifiedSameLegalEntity = false,
  verifiedSamePractice = false,
  expressWrittenRestoration = false,
  sourceDocumentId = null,
  reason = null,
  actorId = null
} = {}) {
  const guard = requireDatabase(env);
  if (guard) return guard;

  const request = rejoinRequestId
    ? await getRejoinRequest(env, rejoinRequestId)
    : (await listRejoinRequests(env, { tenantId, limit: 1 }))[0] || null;
  if (rejoinRequestId && !request) {
    return { ok: false, status: 404, code: "REJOIN_REQUEST_NOT_FOUND", message: "That reactivation request was not found." };
  }
  const clinicId = tenantId || request?.tenantId;
  if (!clinicId) return { ok: false, status: 422, code: "TENANT_REQUIRED", message: "A clinic is required." };

  const founding = await foundingStatus(env, clinicId);
  const history = await listFoundingHistory(env, clinicId);
  const obligations = await survivingObligations(env, clinicId);
  const priorCause = founding.status === "REVOKED_FOR_CAUSE" || history.some((entry) => entry.status === "REVOKED_FOR_CAUSE");
  const writtenSurrender = history.some((entry) => entry.surrenderedInWriting);
  const circumvention = history.some((entry) => [
    "INTENTIONAL_FEE_CIRCUMVENTION", "PAW_IT_FORWARD_FUND_MISUSE",
    "DEPOSIT_DOUBLE_COLLECTION", "VISIT_OR_PAYMENT_FALSIFICATION", "FRAUD"
  ].includes(entry.causeCategory));

  const refuse = async (code, message, details) => {
    if (request) {
      await env.DB.prepare(`
        UPDATE clinic_rejoin_requests
           SET verified_same_legal_entity = ?, verified_same_practice = ?, status = 'IN_REVIEW',
               founding_restored = 0, founding_decision_note = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
      `).bind(verifiedSameLegalEntity ? 1 : 0, verifiedSamePractice ? 1 : 0, message, request.id).run();
    }
    await recordAudit(env, {
      actorId, actorRole: "platform", action: "clinic_founding.restoration_refused",
      subjectType: "tenant", subjectId: clinicId,
      oldState: { status: founding.status },
      newState: { restored: false, code, ...(details || {}) },
      reason: message
    });
    return { ok: false, status: 409, code, message, details, founding, survivingObligations: obligations };
  };

  if (!verifiedSameLegalEntity || !verifiedSamePractice) {
    return refuse(
      "NEW_ENTITY_NO_AUTOMATIC_INHERITANCE",
      "A new legal entity, merger, asset transfer, or change of control does not automatically inherit Founding Clinic status. ClearKey may expressly preserve it for a bona fide successor as a recorded decision.",
      { verifiedSameLegalEntity, verifiedSamePractice }
    );
  }
  if (priorCause && !(expressWrittenRestoration && sourceDocumentId)) {
    return refuse(
      "RESTORATION_REQUIRES_EXPRESS_WRITING",
      "A clinic terminated for Cause has no automatic right to rejoin or regain Founding Clinic status; restoration must be express and in writing.",
      { priorCause: true }
    );
  }
  if (obligations.uncured) {
    return refuse(
      "UNCURED_OBLIGATIONS",
      "Outstanding amounts, chargebacks, refunds, or other surviving obligations must be resolved before the Founding Clinic waiver is restored.",
      { survivingObligations: obligations }
    );
  }
  if (circumvention) {
    return refuse(
      "CIRCUMVENTION_OR_MISUSE_ON_RECORD",
      "Intentional fee circumvention, fraudulent reporting, or material misuse of Paw It Forward bars restoration of the Founding Clinic waiver.",
      { circumvention: true }
    );
  }
  if (writtenSurrender) {
    return refuse(
      "FOUNDING_SURRENDERED_IN_WRITING",
      "The Parties expressly agreed in writing that the Founding Clinic privilege was surrendered.",
      { writtenSurrender: true }
    );
  }

  // Restored, not re-granted. The plan was never converted to STANDARD on the
  // way out, so this is putting the status back where §9 says it belongs.
  const assigned = await assignPricingPlan(env, {
    tenantId: clinicId, plan: "FOUNDING", contractId: await resolveContractId(env, clinicId, null),
    actorId, goodStanding: true,
    note: "Founding Clinic waiver restored on rejoin.",
    reason: reason || "Same legal entity and substantially the same practice rejoined (§9)."
  });
  if (!assigned.ok) return assigned;

  await updateFoundingColumns(env, clinicId, {
    founding_status: "ACTIVE",
    founding_rejoin_eligible: 1,
    founding_revoked_at: null,
    founding_revocation_reason: null,
    pricing_source_document_id: text(sourceDocumentId, 120) || founding.sourceDocumentId || null,
    pricing_effective_at: new Date().toISOString()
  });
  await appendFoundingHistory(env, {
    tenantId: clinicId, status: "ACTIVE", previousStatus: founding.status,
    reason: reason || "Founding Clinic waiver restored on rejoin (§9).",
    grantedAt: founding.grantedAt, grantedBy: founding.grantedBy,
    rejoinEligible: true, sourceDocumentId, actorId
  });

  if (request) {
    await env.DB.prepare(`
      UPDATE clinic_rejoin_requests
         SET verified_same_legal_entity = 1, verified_same_practice = 1, status = 'APPROVED',
             founding_restored = 1, founding_decision_note = ?,
             express_written_restoration_document_id = ?,
             decided_at = CURRENT_TIMESTAMP, decided_by = ?, decision_reason = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).bind(
      reason || "Founding Clinic waiver restored.",
      expressWrittenRestoration ? text(sourceDocumentId, 120) : null,
      actorId, reason || null, request.id
    ).run();
  }

  const lifecycle = await writeLifecycle(env, {
    tenantId: clinicId, toStatus: "PENDING_ONBOARDING",
    reason: reason || "Reactivation approved; current onboarding requirements apply (§28).",
    triggerSource: "REJOIN", rejoinRequestId: request?.id || null, actorId
  });

  await recordAudit(env, {
    actorId, actorRole: "platform", action: "clinic_founding.restored_on_rejoin",
    subjectType: "tenant", subjectId: clinicId,
    oldState: { status: founding.status, plan: founding.plan },
    newState: { status: "ACTIVE", plan: "FOUNDING", expressWrittenRestoration, sourceDocumentId },
    reason
  });

  return {
    ok: true,
    founding: await foundingStatus(env, clinicId),
    fee: await clinicFeeFor(env, clinicId),
    lifecycle,
    rejoinRequest: request ? await getRejoinRequest(env, request.id) : null
  };
}

/* ═════════════════════════════════════════════════ admin console profile ═══ */

/**
 * The Contract, Pricing/Founding, and Risk sections of the internal clinic
 * profile (addendum §19), assembled in one read.
 *
 * The `fee` field is `clinicFeeFor`'s answer, not a restatement of it — the
 * screen shows the number that will actually be billed, which is the only
 * number worth showing.
 */
export async function clinicContractProfile(env, tenantId) {
  const contract = await getContract(env, tenantId);
  const founding = await foundingStatus(env, tenantId);
  const lifecycle = await clinicLifecycle(env, tenantId);
  const fee = await clinicFeeFor(env, tenantId);
  const [latestSeparation] = await listSeparationEvents(env, tenantId);
  return {
    tenantId,
    contractingEntity: CONTRACTING_ENTITY,
    productName: PLATFORM_PRODUCT_NAME,
    contract,
    representatives: await listAuthorizedRepresentatives(env, tenantId),
    representativeHistory: await listAuthorizedRepresentatives(env, tenantId, { includeHistory: true }),
    managementEvents: await listManagementEvents(env, tenantId, { limit: 50 }),
    founding: {
      ...founding,
      history: await listFoundingHistory(env, tenantId, { limit: 50 })
    },
    pricing: {
      plan: fee.plan,
      applicableFeeCents: fee.feeCents,
      reason: fee.reason,
      sourceDocumentId: founding.sourceDocumentId,
      effectiveAt: founding.pricingEffectiveAt
    },
    lifecycle,
    lifecycleEvents: await listLifecycleEvents(env, tenantId, { limit: 50 }),
    separation: latestSeparation || null,
    rejoinRequests: await listRejoinRequests(env, { tenantId, limit: 20 }),
    survivingObligations: await survivingObligations(env, tenantId),
    windDownBookings: await windDownBookings(env, tenantId)
  };
}

/* ══════════════════════════════════════════════════════════════ handlers ═══ */

/** GET /api/admin/clinics/:tenantId/contract */
export async function handleClinicContractProfile(request, env, tenantId) {
  if (!hasDatabase(env)) return apiError(503, "DATABASE_REQUIRED", "D1 is required.");
  if (!tenantId) return apiError(422, "TENANT_REQUIRED", "A clinic is required.");
  const tenant = await env.DB.prepare("SELECT id FROM tenants WHERE id = ? LIMIT 1").bind(tenantId).first();
  if (!tenant) return apiError(404, "TENANT_NOT_FOUND", "That clinic was not found.");
  return json({ profile: await clinicContractProfile(env, tenantId) });
}

/** GET /api/admin/clinic-contracts?status=EXECUTED */
export async function handleClinicContractList(request, env) {
  if (!hasDatabase(env)) return apiError(503, "DATABASE_REQUIRED", "D1 is required.");
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  if (status && !CONTRACT_STATUSES.includes(status)) {
    return apiError(422, "INVALID_STATUS", `Status must be one of ${CONTRACT_STATUSES.join(", ")}.`);
  }
  return json({
    contracts: await listContracts(env, {
      tenantId: url.searchParams.get("tenantId"),
      status,
      limit: url.searchParams.get("limit")
    })
  });
}

/**
 * POST /api/admin/clinics/:tenantId/contract — `{ action, ... }`.
 *
 * One door, several actions, each of which is one of the exported functions
 * above with its refusals intact. There is deliberately no generic "update
 * the founding column" action: every path into that field runs through the
 * rules, because a console that can set a field directly is a console that
 * will eventually be used to set it wrongly.
 */
export async function handleClinicContractUpdate(request, env, actor, tenantId) {
  if (!hasDatabase(env)) return apiError(503, "DATABASE_REQUIRED", "D1 is required.");
  if (!tenantId) return apiError(422, "TENANT_REQUIRED", "A clinic is required.");
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
    case "record_contract":
      result = await recordContract(env, { ...body, tenantId, actorId });
      break;
    case "amend_contract":
      result = await amendContract(env, { ...body, tenantId, actorId });
      break;
    case "add_representative":
      result = await addAuthorizedRepresentative(env, { ...body, tenantId, actorId });
      break;
    case "end_representative":
      result = await endAuthorizedRepresentative(env, {
        tenantId, representativeId: text(body?.representativeId, 80),
        endReason: text(body?.endReason, 120) || "DEPARTED", validTo: body?.validTo || null, actorId
      });
      break;
    case "record_management_event":
      result = await recordManagementEvent(env, { ...body, tenantId, actorId });
      break;
    case "grant_founding":
      result = await grantFounding(env, { ...body, tenantId, actorId });
      break;
    case "set_founding_status":
      result = await setFoundingStatus(env, { ...body, tenantId, actorId });
      break;
    case "surrender_founding":
      result = await surrenderFounding(env, { ...body, tenantId, actorId });
      break;
    case "revoke_founding_for_cause":
      result = await revokeFoundingForCause(env, { ...body, tenantId, actorId });
      break;
    case "preserve_founding_for_successor":
      result = await preserveFoundingForSuccessor(env, { ...body, tenantId, actorId });
      break;
    case "set_lifecycle":
      result = await setLifecycleStatus(env, { ...body, tenantId, actorId });
      break;
    case "separate":
      result = await separateClinic(env, { ...body, tenantId, actorId });
      break;
    case "complete_wind_down":
      result = await completeWindDown(env, { ...body, tenantId, actorId });
      break;
    case "request_rejoin":
      result = await requestRejoin(env, { ...body, tenantId, actorId });
      break;
    case "restore_founding":
      result = await restoreFoundingOnRejoin(env, { ...body, tenantId, actorId });
      break;
    default:
      return apiError(422, "INVALID_ACTION", "Unknown action for a clinic contract update.");
  }

  if (!result.ok) return apiError(result.status || 400, result.code, result.message, result.details);
  return json(result);
}

/**
 * POST /api/clinic/authorization-check — `{ email, action }`.
 *
 * Exposed so a clinic-side console can grey out what a representative cannot
 * do, rather than letting them attempt it and be refused. The refusal is
 * still enforced server-side in every function above; this is courtesy, not
 * the control.
 */
export async function handleAuthorizationCheck(request, env, tenantId) {
  let body;
  try {
    body = await readJson(request);
  } catch {
    return apiError(400, "JSON_REQUIRED", "A valid JSON request body is required.");
  }
  const decision = await canAuthorize(env, tenantId, body?.email, body?.action);
  return json({ authorization: decision }, { status: decision.allowed ? 200 : 403 });
}
