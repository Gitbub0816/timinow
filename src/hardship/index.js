/**
 * The hardship application, end to end.
 *
 * This file is the only part of the hardship feature that touches the world:
 * it stores applications, holds references to encrypted evidence, calls the
 * providers, hands the resulting facts to the pure evaluator, writes the
 * decision, and answers HTTP. The decision itself is made in engine.js and
 * cannot be influenced from here — everything below either supplies facts or
 * records what the rules concluded.
 *
 * ──────────────────────────────────────────────────────────── the states ──
 *
 *   DRAFT ──▶ VERIFYING ──▶ APPROVED
 *                       └─▶ NOT_VERIFIED
 *                       ├─▶ TECHNICAL_RETRY   (a vendor failed; not a finding)
 *                       └─▶ SECURITY_HOLD     (internal; neutral to the user)
 *
 * TECHNICAL_RETRY and SECURITY_HOLD are deliberately not decisions. A
 * provider outage must never read to the applicant as "we looked at your
 * finances and said no", and a security hold must never read as an
 * accusation. Both show the same neutral pending language, and in both cases
 * the booking continues at the standard fee.
 *
 * ───────────────────────────────────────────────────── what the user sees ──
 *
 * Reason codes, fraud signals, tamper risk, extraction confidence, and the
 * internal state name never leave this file. The applicant gets one of three
 * sentences and, on a denial, an email address. Everything else is for the
 * audit record and the operations console.
 */

import { hasDatabase } from "../db.js";
import { recordAudit } from "../ledger.js";
import { activePricingPolicy } from "../pricing.js";
import { activePolicy } from "./policy.js";
import { DECISION, evaluate, qualifyingShockTotal } from "./engine.js";
import { providers as defaultProviders, ProviderError } from "./providers.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const SECURITY_HEADERS = {
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY"
};

export const APPLICATION_STATES = Object.freeze(["DRAFT", "VERIFYING", "APPROVED", "NOT_VERIFIED", "TECHNICAL_RETRY", "SECURITY_HOLD", "ABANDONED"]);

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { ...JSON_HEADERS, ...SECURITY_HEADERS, ...(init.headers || {}) }
  });
}

function apiError(status, code, message) {
  return json({ error: { code, message } }, { status });
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function cleanString(value, maxLength = 240) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

/** Whole dollars read as "$20"; anything else keeps its cents. */
export function formatUsd(cents) {
  const amount = Math.max(0, Math.trunc(Number(cents) || 0));
  return amount % 100 === 0 ? `$${amount / 100}` : `$${(amount / 100).toFixed(2)}`;
}

/* ──────────────────────────────────────────────────────────────── copy ── */

/**
 * The soft denial, assembled rather than stored.
 *
 * Spec §6.4 fixes this sentence, and the fee inside it is the one thing that
 * must not be typed: hardcoding "$20" would mean a pricing change silently
 * makes the denial quote the wrong price, which is both a support problem and
 * arguably a misrepresentation. So the amount comes from the active pricing
 * policy and the rest of the sentence is fixed.
 *
 * What is deliberately absent: any reason, any code, any mention of
 * documents, and any suggestion that the applicant did something wrong. The
 * engine may have twelve reason codes; the applicant gets none of them.
 */
export function softDenialCopy({ ownerFeeCents, supportEmail }) {
  return `TímiNOW could not independently verify your hardship at this time. This booking will require our standard ${formatUsd(ownerFeeCents)} fee. We know this isn't what you wanted to hear; if you feel we've made a mistake, email ${supportEmail} and we will have a human evaluate your case for future bookings.`;
}

/** Spec §6.3. The clinic's own charges are named so nobody is surprised. */
export function approvalCopy({ ownerFeeCents }) {
  return `Your ${formatUsd(ownerFeeCents)} TímiNOW fee is covered for this booking, and the clinic will not be charged a TímiNOW referral fee. You remain responsible for the clinic's deposit and veterinary charges.`;
}

/**
 * The neutral wait. Used for both a provider failure and an internal security
 * hold, and identical in each case on purpose — a distinguishable message is
 * a message that tells somebody probing the system which one they triggered.
 */
export function pendingCopy({ ownerFeeCents }) {
  return `TímiNOW is still checking a few things and cannot confirm assistance right now. You can continue this booking at the standard ${formatUsd(ownerFeeCents)} fee, and you are welcome to try again later.`;
}

/* ───────────────────────────────────────────────────────── the lifecycle ── */

function applicationRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.applicant_user_id,
    identityKey: row.identity_key || null,
    identityVerified: Boolean(row.identity_verified),
    identityConfidence: row.identity_confidence || null,
    identitySessionId: row.identity_session_id || null,
    selectedPathway: row.selected_pathway || null,
    state: row.state,
    householdSize: row.household_size === null || row.household_size === undefined ? null : Number(row.household_size),
    householdAttested: Boolean(row.household_attested),
    geography: {
      areaId: row.geography_area_id || null,
      datasetVersion: row.geography_dataset_version || null,
      areaIndex: row.geography_area_index === null || row.geography_area_index === undefined ? null : Number(row.geography_area_index)
    },
    intakeId: row.intake_id || null,
    petId: row.pet_id || null,
    policyId: row.policy_id || null,
    policyVersion: row.policy_version === null || row.policy_version === undefined ? null : Number(row.policy_version),
    submittedAt: row.submitted_at || null,
    decidedAt: row.decided_at || null,
    createdAt: row.created_at
  };
}

/** Open an application in DRAFT. Nothing here decides anything. */
export async function createApplication(env, actor, body = {}, { now = new Date().toISOString() } = {}) {
  const policy = activePolicy();
  const id = newId("elig");
  const householdSize = Number(body?.householdSize);
  await env.DB.prepare(`
    INSERT INTO eligibility_applications (
      id, applicant_user_id, selected_pathway, state, household_size, household_attested,
      geography_area_id, geography_dataset_version, geography_area_index,
      terms_version, attestation_version, attested_at, intake_id, pet_id,
      policy_id, policy_version, created_at, updated_at
    ) VALUES (?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    actor.userId,
    cleanString(body?.selectedPathway, 60) || null,
    Number.isFinite(householdSize) && householdSize >= 1 ? Math.trunc(householdSize) : null,
    body?.householdAttested === true ? 1 : 0,
    cleanString(body?.geography?.areaId, 80) || null,
    cleanString(body?.geography?.datasetVersion, 40) || null,
    Number.isFinite(Number(body?.geography?.areaIndex)) ? Number(body.geography.areaIndex) : null,
    cleanString(body?.termsVersion, 40) || null,
    cleanString(body?.attestationVersion, 40) || null,
    body?.attestationVersion ? now : null,
    cleanString(body?.intakeId, 80) || null,
    cleanString(body?.petId, 80) || null,
    policy.id,
    policy.version,
    now,
    now
  ).run();

  await recordAudit(env, {
    actorId: actor.userId, actorRole: "applicant", action: "hardship.application.created",
    subjectType: "eligibility_application", subjectId: id, newState: { state: "DRAFT", policyId: policy.id, policyVersion: policy.version }
  });
  return await getApplication(env, id, actor.userId);
}

export async function getApplication(env, applicationId, userId) {
  const row = await env.DB.prepare("SELECT * FROM eligibility_applications WHERE id = ? LIMIT 1").bind(applicationId).first();
  if (!row) return null;
  if (userId && row.applicant_user_id !== userId) return null;
  return applicationRow(row);
}

/**
 * Open an identity session.
 *
 * Embedded by default — see providers.js for why the product refuses to send
 * somebody to a vendor's domain mid-booking. The response echoes the mode and
 * the provider's supported modes so a client that cannot embed on this device
 * can ask for the hosted fallback explicitly rather than discovering it by
 * finding a URL where it expected a token.
 */
export async function startIdentitySession(env, application, { mode = "EMBEDDED", returnUrl = null, now = new Date().toISOString(), providerSet } = {}) {
  const set = providerSet || defaultProviders(env);
  const session = await set.identity.createSession({ applicationId: application.id, mode, returnUrl, now });
  await env.DB.prepare(`
    UPDATE eligibility_applications
    SET identity_session_id = ?, identity_provider = ?, updated_at = ?
    WHERE id = ?
  `).bind(session.sessionId, session.provider, now, application.id).run();
  await recordAudit(env, {
    actorId: application.userId, actorRole: "applicant", action: "hardship.identity.session_started",
    subjectType: "eligibility_application", subjectId: application.id,
    newState: { provider: session.provider, mode: session.mode, sessionId: session.sessionId }
  });
  return session;
}

/**
 * Record a piece of evidence — a reference, never content.
 *
 * The bytes are uploaded straight to private object storage by the client
 * against a short-lived signed URL. What lands here is where it went, what
 * hash it had, and when it must be deleted. A row in D1 never carries a page
 * of somebody's medical bill.
 */
export async function attachEvidence(env, application, input = {}, { now = new Date().toISOString() } = {}) {
  const policy = activePolicy();
  const evidenceType = cleanString(input?.evidenceType, 60);
  const bucket = cleanString(input?.storageBucket, 80);
  const objectRef = cleanString(input?.storageObjectRef, 240);
  const hash = cleanString(input?.contentSha256, 128);
  if (!evidenceType || !bucket || !objectRef || !hash) {
    return { ok: false, code: "EVIDENCE_REFERENCE_REQUIRED", message: "Evidence needs a type, a stored object reference, and a content hash." };
  }

  const id = newId("evid");
  const retentionDeadline = new Date(new Date(now).getTime() + policy.retention.rawEvidenceDays * 86_400_000).toISOString();
  await env.DB.prepare(`
    INSERT INTO eligibility_evidence (
      id, application_id, evidence_type, storage_bucket, storage_object_ref, encryption_key_id,
      content_sha256, mime_type, byte_size, extraction_state, retention_deadline, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)
  `).bind(
    id, application.id, evidenceType, bucket, objectRef,
    cleanString(input?.encryptionKeyId, 80) || null, hash,
    cleanString(input?.mimeType, 80) || null,
    Number.isFinite(Number(input?.byteSize)) ? Math.trunc(Number(input.byteSize)) : null,
    retentionDeadline, now
  ).run();

  // Document reuse. The same file appearing under a different applicant is a
  // signal, not a verdict — it is recorded and reviewed, and the applicant is
  // told nothing, because the innocent explanations are common.
  const reuse = await env.DB.prepare(`
    SELECT e.id FROM eligibility_evidence e
    JOIN eligibility_applications a ON a.id = e.application_id
    WHERE e.content_sha256 = ? AND a.applicant_user_id <> ? LIMIT 1
  `).bind(hash, application.userId).first();
  if (reuse) {
    await recordFraudSignal(env, {
      applicationId: application.id, identityKey: application.identityKey, userId: application.userId,
      signalType: "DOCUMENT_REUSED_ACROSS_IDENTITIES", severity: "MEDIUM",
      detail: { contentSha256: hash, matchedEvidenceId: reuse.id }
    }, { now });
  }

  await recordAudit(env, {
    actorId: application.userId, actorRole: "applicant", action: "hardship.evidence.attached",
    subjectType: "eligibility_application", subjectId: application.id,
    newState: { evidenceId: id, evidenceType, retentionDeadline }
  });
  return { ok: true, evidenceId: id, retentionDeadline };
}

export async function recordFraudSignal(env, { applicationId, identityKey, userId, signalType, severity = "LOW", detail = {} }, { now = new Date().toISOString() } = {}) {
  const id = newId("fsig");
  await env.DB.prepare(`
    INSERT INTO fraud_signals (id, application_id, identity_key, user_id, signal_type, severity, detail_json, detected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(id, applicationId || null, identityKey || null, userId || null, signalType, severity, JSON.stringify(detail), now).run();
  return id;
}

/* ─────────────────────────────────────────────────── facts and evidence ── */

const DOCUMENT_ROUTES = Object.freeze({
  BENEFIT_AWARD_LETTER: "benefit",
  BENEFIT_STATUS_NOTICE: "benefit",
  SNAP_NOTICE_OF_ACTION: "benefit",
  TANF_AWARD_NOTICE: "benefit",
  SSI_AWARD_LETTER: "benefit",
  MEDICAID_ELIGIBILITY_NOTICE: "benefit",
  HOUSING_ASSISTANCE_AWARD: "benefit",
  EMPLOYER_TERMINATION_NOTICE: "termination",
  LAYOFF_NOTICE: "termination",
  SEPARATION_NOTICE: "termination",
  WARN_NOTICE: "termination",
  UNEMPLOYMENT_DETERMINATION: "unemployment",
  UNEMPLOYMENT_AWARD_NOTICE: "unemployment",
  UNEMPLOYMENT_PAYMENT_RECORD: "unemployment",
  EMPLOYER_HOURS_REDUCTION_NOTICE: "reducedEarnings",
  PAYROLL_VERIFICATION: "reducedEarnings",
  IRS_RETURN_TRANSCRIPT: "income",
  IRS_WAGE_AND_INCOME_TRANSCRIPT: "income",
  PAYROLL_PROVIDER_VERIFICATION: "income",
  PAY_STUB_SET: "income",
  SSA_BENEFIT_VERIFICATION: "income",
  ITEMIZED_INVOICE: "shock",
  REPAIR_ORDER: "shock",
  MEDICAL_BILL: "shock",
  DENTAL_BILL: "shock",
  EXPLANATION_OF_BENEFITS: "shock",
  FUNERAL_INVOICE: "shock",
  CONTRACTOR_INVOICE: "shock",
  VETERINARY_INVOICE: "shock",
  RECEIPT_ITEMIZED: "shock"
});

/**
 * Turn extracted documents into the normalized facts the evaluator consumes.
 *
 * This is a transport step, not a judgement one: it moves values from a
 * provider's shape into the engine's shape and nothing more. Note what it
 * cannot do — there is no branch here that decides a document is "close
 * enough", no default that fills in a missing date, and no fallback category.
 * Anything the extractor did not supply arrives at the engine missing, and
 * the engine refuses it.
 */
export function factsFromEvidence(application, extractions, identity) {
  const facts = {
    identity: {
      verified: Boolean(identity?.verified),
      uniquenessConfidence: identity?.uniquenessConfidence || "NONE",
      identityKey: identity?.identityKey || null
    },
    household: {
      size: application.householdSize,
      attested: Boolean(application.householdAttested),
      geography: {
        areaId: application.geography?.areaId || null,
        datasetVersion: application.geography?.datasetVersion || null,
        areaIndex: application.geography?.areaIndex
      }
    },
    documents: [],
    financialShock: { lineItems: [] }
  };

  for (const extraction of extractions) {
    const documentType = extraction?.documentType;
    facts.documents.push({
      evidenceId: extraction.evidenceId,
      documentType,
      tamperRisk: extraction.tamperRisk || "UNKNOWN"
    });
    const route = DOCUMENT_ROUTES[documentType];
    const fields = extraction.fields || {};
    const common = {
      evidenceId: extraction.evidenceId,
      documentType,
      issuer: extraction.issuer || null,
      extractionConfidence: extraction.extractionConfidence
    };

    if (route === "benefit") {
      facts.benefit = { ...common, documentDate: extraction.documentDate, ...fields };
    } else if (route === "termination") {
      facts.employment = facts.employment || {};
      facts.employment.terminationNotice = { ...common, documentDate: extraction.documentDate, ...fields };
    } else if (route === "unemployment") {
      facts.employment = facts.employment || {};
      facts.employment.unemployment = { ...common, documentDate: extraction.documentDate, ...fields };
    } else if (route === "reducedEarnings") {
      facts.employment = facts.employment || {};
      facts.employment.reducedEarnings = { ...common, documentDate: extraction.documentDate, ...fields };
    } else if (route === "income") {
      facts.income = { ...common, documentDate: extraction.documentDate, ...fields };
      // Pay-stub sets can evidence both a current income and a reduction.
      if (fields.priorPeriodEarningsCents !== undefined) {
        facts.employment = facts.employment || {};
        facts.employment.reducedEarnings = { ...common, documentDate: extraction.documentDate, ...fields };
      }
    } else if (route === "shock") {
      for (const line of extraction.lineItems || []) {
        facts.financialShock.lineItems.push({
          id: line.id || `${extraction.evidenceId}:${facts.financialShock.lineItems.length}`,
          evidenceId: extraction.evidenceId,
          issuer: extraction.issuer || null,
          // A line inherits its document's date unless it carries its own.
          documentDate: line.documentDate || extraction.documentDate,
          normalizedCategory: line.normalizedCategory,
          amountCents: line.amountCents,
          purposeProof: line.purposeProof,
          financialProof: line.financialProof,
          extractionConfidence: line.extractionConfidence ?? extraction.extractionConfidence,
          dedupeHash: line.dedupeHash || null
        });
      }
    }
  }

  return facts;
}

/* ────────────────────────────────────────────────────────── the decision ── */

/**
 * Submit: extract, evaluate, persist, audit.
 *
 * The order matters. Rate limit and security holds are checked before the
 * rules run, so an applicant who cannot receive another sponsored visit this
 * year is not asked for a hospital bill first. Extraction failures become
 * TECHNICAL_RETRY, never a denial. Only after all of that does the pure
 * evaluator see anything, and whatever it returns is written down verbatim.
 */
export async function submitApplication(env, actor, applicationId, { now = new Date().toISOString(), providerSet, policy = activePolicy() } = {}) {
  const application = await getApplication(env, applicationId, actor.userId);
  if (!application) return { ok: false, status: 404, code: "APPLICATION_NOT_FOUND", message: "That assistance application was not found." };
  if (application.state === "APPROVED" || application.state === "NOT_VERIFIED") {
    const existing = await latestDecision(env, application.id);
    return { ok: true, application, decision: existing, replayed: true };
  }

  const set = providerSet || defaultProviders(env);
  await setState(env, application, "VERIFYING", { now, actorId: actor.userId });

  // Identity first: everything else is meaningless without a unique person.
  let identity = { verified: false, uniquenessConfidence: "NONE", identityKey: null };
  if (application.identitySessionId) {
    try {
      identity = await set.identity.getSessionResult(application.identitySessionId);
    } catch (error) {
      return await technicalRetry(env, application, error, { now, actorId: actor.userId });
    }
  }
  if (identity.identityKey && identity.identityKey !== application.identityKey) {
    await env.DB.prepare("UPDATE eligibility_applications SET identity_key = ?, identity_verified = ?, identity_confidence = ?, updated_at = ? WHERE id = ?")
      .bind(identity.identityKey, identity.verified ? 1 : 0, identity.uniquenessConfidence || null, now, application.id).run();
    application.identityKey = identity.identityKey;
  }

  // An unresolved high-severity signal parks the application. The applicant
  // sees the neutral wait; nothing tells them a hold exists.
  const hold = application.identityKey
    ? await env.DB.prepare("SELECT id FROM fraud_signals WHERE identity_key = ? AND severity = 'HIGH' AND reviewed_at IS NULL LIMIT 1")
      .bind(application.identityKey).first()
    : null;
  if (hold) {
    await setState(env, application, "SECURITY_HOLD", { now, actorId: actor.userId, reason: "unresolved_high_severity_signal" });
    return { ok: true, application: { ...application, state: "SECURITY_HOLD" }, decision: null, pending: true };
  }

  const limit = await rateLimitStatus(env, { identityKey: application.identityKey, userId: actor.userId, policy, now });

  // Extraction. A vendor failure is a retry, never a finding about a person.
  const evidence = await env.DB.prepare("SELECT * FROM eligibility_evidence WHERE application_id = ? ORDER BY created_at, id").bind(application.id).all();
  const extractions = [];
  for (const row of evidence.results || []) {
    try {
      const extracted = await set.documents.extract({ objectRef: row.storage_object_ref, declaredType: row.evidence_type, now });
      extractions.push({ ...extracted, evidenceId: row.id });
      await env.DB.prepare(`
        UPDATE eligibility_evidence
        SET extraction_state = 'EXTRACTED', extraction_provider = ?, extraction_confidence = ?, tamper_risk = ?
        WHERE id = ?
      `).bind(set.documents.id, Number(extracted.extractionConfidence) || null, extracted.tamperRisk || "UNKNOWN", row.id).run();
    } catch (error) {
      await env.DB.prepare("UPDATE eligibility_evidence SET extraction_state = 'FAILED' WHERE id = ?").bind(row.id).run();
      return await technicalRetry(env, application, error, { now, actorId: actor.userId });
    }
  }

  const facts = factsFromEvidence(application, extractions, identity);
  await persistFacts(env, application, facts, { now });

  // The one pure call. Same facts, same policy, same `now` — same decision,
  // forever, which is what makes an appeal reviewable.
  let decision = evaluate(facts, policy, { now });

  // A rate-limited applicant may be perfectly eligible and still not able to
  // receive another sponsored visit this year. That is a soft denial with its
  // own reason code, not a judgement about their finances.
  if (decision.decision === DECISION.APPROVED && !limit.allowed) {
    decision = Object.freeze({
      ...decision,
      decision: DECISION.NOT_VERIFIED,
      pathway: null,
      expiresAt: null,
      sponsoredVisitLimit: 0,
      reasonCodes: Object.freeze([...decision.reasonCodes, "RATE_LIMIT_SPONSORED_CONNECTIONS_EXHAUSTED"]),
      explanation: Object.freeze({ ...decision.explanation, decision: DECISION.NOT_VERIFIED, rateLimit: limit })
    });
  }

  if (facts.financialShock.lineItems.length) {
    await persistShockItems(env, application, facts.financialShock.lineItems, { now, policy });
  }

  const stored = await persistDecision(env, application, decision, { now, actorId: actor.userId });
  await setState(env, application, decision.decision === DECISION.APPROVED ? "APPROVED" : "NOT_VERIFIED", { now, actorId: actor.userId, decidedAt: now });

  if (decision.decision === DECISION.APPROVED) {
    await issueGrant(env, application, decision, stored.id, { now });
  }

  return { ok: true, application: { ...application, state: decision.decision }, decision: { ...decision, id: stored.id } };
}

async function technicalRetry(env, application, error, { now, actorId }) {
  await setState(env, application, "TECHNICAL_RETRY", { now, actorId, reason: error instanceof ProviderError ? error.code : "PROVIDER_ERROR" });
  return { ok: true, application: { ...application, state: "TECHNICAL_RETRY" }, decision: null, pending: true };
}

async function setState(env, application, state, { now, actorId, reason = null, decidedAt = null }) {
  await env.DB.prepare(`
    UPDATE eligibility_applications
    SET state = ?, updated_at = ?, submitted_at = COALESCE(submitted_at, ?), decided_at = COALESCE(?, decided_at)
    WHERE id = ?
  `).bind(state, now, now, decidedAt, application.id).run();
  await recordAudit(env, {
    actorId, actorRole: "applicant", action: "hardship.application.state_changed",
    subjectType: "eligibility_application", subjectId: application.id,
    oldState: { state: application.state }, newState: { state }, reason
  });
  application.state = state;
}

/** The minimum facts the rules used, one row per path. */
async function persistFacts(env, application, facts, { now }) {
  const flat = [];
  const walk = (value, path) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) { flat.push([path, value.length]); return; }
    if (typeof value === "object") { for (const [key, child] of Object.entries(value)) walk(child, path ? `${path}.${key}` : key); return; }
    flat.push([path, value]);
  };
  // Document metadata and line items are recorded in their own tables; this
  // stores the scalar facts a rule can turn on.
  walk({ identity: facts.identity, household: facts.household, income: facts.income, benefit: facts.benefit, employment: facts.employment }, "");

  const statements = flat.slice(0, 200).map(([path, value]) => env.DB.prepare(`
    INSERT INTO evidence_facts (id, application_id, fact_path, fact_value_json, source, created_at)
    VALUES (?, ?, ?, ?, 'EXTRACTION', ?)
    ON CONFLICT (application_id, fact_path) DO UPDATE SET fact_value_json = excluded.fact_value_json
  `).bind(newId("fact"), application.id, path, JSON.stringify(value), now));
  if (statements.length) await env.DB.batch(statements);
}

/**
 * Persist every line and its disposition, qualifying or not.
 *
 * Recomputed with the same pure function the decision used, so the rows and
 * the decision cannot disagree. Storing only the qualifying lines would make
 * a denial impossible to explain: "your invoice did not count" is not an
 * answer, "the $900 wheels are an excluded category" is.
 */
async function persistShockItems(env, application, lineItems, { now, policy }) {
  const shock = qualifyingShockTotal(lineItems, { now, policy });
  const disposition = new Map();
  for (const line of shock.counted) disposition.set(line.id, { disposition: "QUALIFY", code: null, qualifying: line.amountCents });
  for (const line of shock.rejected) {
    disposition.set(line.id, {
      disposition: line.code === "LINE_CATEGORY_EXCLUDED" ? "EXCLUDE"
        : line.code === "LINE_CATEGORY_AMBIGUOUS" ? "AMBIGUOUS"
          : line.code === "LINE_DUPLICATE_IN_SUBMISSION" ? "DUPLICATE" : "UNPROVEN",
      code: line.code,
      qualifying: 0
    });
  }

  const statements = lineItems.map((line, index) => {
    const id = line.id || `line_${index}`;
    const outcome = disposition.get(id) || { disposition: "UNPROVEN", code: "LINE_NOT_EVALUATED", qualifying: 0 };
    return env.DB.prepare(`
      INSERT INTO financial_shock_items (
        id, application_id, evidence_id, issuer, item_date, normalized_category, disposition, disposition_code,
        amount_cents, qualifying_amount_cents, purpose_proof, financial_proof, extraction_confidence, dedupe_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (application_id, dedupe_hash) DO NOTHING
    `).bind(
      newId("fsi"), application.id, line.evidenceId || null, line.issuer || null,
      String(line.documentDate || "").slice(0, 10), line.normalizedCategory || null,
      outcome.disposition, outcome.code,
      Math.max(0, Math.trunc(Number(line.amountCents) || 0)), outcome.qualifying,
      line.purposeProof || null, line.financialProof || null,
      Number.isFinite(Number(line.extractionConfidence)) ? Number(line.extractionConfidence) : null,
      line.dedupeHash || `${id}:${application.id}`, now
    );
  });
  if (statements.length) await env.DB.batch(statements);
}

async function persistDecision(env, application, decision, { now, actorId }) {
  const id = newId("edec");
  await env.DB.prepare(`
    INSERT INTO eligibility_decisions (
      id, application_id, decision, pathway, policy_id, policy_version, engine_version,
      decided_at, expires_at, sponsored_visit_limit, reason_codes_json,
      evidence_facts_json, evidence_ids_json, explanation_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, application.id, decision.decision, decision.pathway, decision.policyId, decision.policyVersion,
    decision.engineVersion, decision.decidedAt, decision.expiresAt, decision.sponsoredVisitLimit,
    JSON.stringify(decision.reasonCodes), JSON.stringify(decision.evidenceFactsUsed),
    JSON.stringify(decision.evidenceIds), JSON.stringify(decision.explanation), now
  ).run();

  // The full record, including the codes the applicant never sees.
  await recordAudit(env, {
    actorId, actorRole: "applicant", action: "hardship.decision.recorded",
    subjectType: "eligibility_decision", subjectId: id,
    newState: {
      applicationId: application.id, decision: decision.decision, pathway: decision.pathway,
      policyId: decision.policyId, policyVersion: decision.policyVersion, engineVersion: decision.engineVersion,
      reasonCodes: decision.reasonCodes, expiresAt: decision.expiresAt, sponsoredVisitLimit: decision.sponsoredVisitLimit
    }
  });
  return { id };
}

async function issueGrant(env, application, decision, decisionId, { now }) {
  const id = newId("grant");
  // Supersede any live grant first so the one-active-grant index holds.
  await env.DB.prepare("UPDATE eligibility_grants SET state = 'EXPIRED', updated_at = ? WHERE user_id = ? AND state = 'ACTIVE'")
    .bind(now, application.userId).run();
  await env.DB.prepare(`
    INSERT INTO eligibility_grants (
      id, decision_id, application_id, user_id, identity_key, state, granted_at, expires_at,
      sponsored_visit_limit, sponsored_visits_used, intake_id, source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, 0, ?, 'AUTOMATED', ?, ?)
  `).bind(
    id, decisionId, application.id, application.userId, application.identityKey || null,
    now, decision.expiresAt, decision.sponsoredVisitLimit ?? 1, application.intakeId, now, now
  ).run();
  await recordAudit(env, {
    actorId: application.userId, actorRole: "applicant", action: "hardship.grant.issued",
    subjectType: "eligibility_grant", subjectId: id,
    newState: { applicationId: application.id, expiresAt: decision.expiresAt, sponsoredVisitLimit: decision.sponsoredVisitLimit }
  });
  return id;
}

export async function latestDecision(env, applicationId) {
  const row = await env.DB.prepare("SELECT * FROM eligibility_decisions WHERE application_id = ? ORDER BY decided_at DESC, id DESC LIMIT 1")
    .bind(applicationId).first();
  if (!row) return null;
  return {
    id: row.id,
    decision: row.decision,
    pathway: row.pathway,
    policyId: row.policy_id,
    policyVersion: Number(row.policy_version),
    engineVersion: row.engine_version,
    decidedAt: row.decided_at,
    expiresAt: row.expires_at,
    sponsoredVisitLimit: row.sponsored_visit_limit === null ? null : Number(row.sponsored_visit_limit),
    reasonCodes: JSON.parse(row.reason_codes_json || "[]"),
    evidenceFactsUsed: JSON.parse(row.evidence_facts_json || "[]"),
    explanation: JSON.parse(row.explanation_json || "{}")
  };
}

/* ─────────────────────────────────────────────────── grants and limits ── */

/**
 * The rolling limit: one sponsored *completed* connection per 12 months by
 * default, configurable per identity. Approvals do not count — an approval
 * that never became a visit cost the fund nothing and must not burn a year.
 */
export async function rateLimitStatus(env, { identityKey, userId, policy = activePolicy(), now = new Date().toISOString() } = {}) {
  const defaults = policy.rateLimit;
  const row = identityKey
    ? await env.DB.prepare("SELECT * FROM eligibility_rate_limits WHERE identity_key = ? LIMIT 1").bind(identityKey).first()
    : null;
  const windowDays = row ? Number(row.window_days) : defaults.windowDays;
  const maximum = row ? Number(row.max_sponsored_connections) : defaults.sponsoredConnectionsPerWindow;
  const windowStart = new Date(new Date(now).getTime() - windowDays * 86_400_000).toISOString();

  let used = 0;
  if (row && row.last_completed_at && row.last_completed_at >= windowStart) used = Number(row.sponsored_connections_used || 0);
  if (!row) {
    // No per-identity row yet: fall back to counting consumed grants for this
    // account inside the window, so a missing row is never a free pass.
    const counted = await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM eligibility_grants
      WHERE user_id = ? AND sponsored_visits_used > 0 AND last_consumed_at >= ?
    `).bind(userId, windowStart).first();
    used = Number(counted?.count || 0);
  }
  return { allowed: used < maximum, used, maximum, windowDays, windowStartedAt: windowStart };
}

/** The live grant for this person, if any. Read by the booking flow. */
export async function activeGrantFor(env, userId, { now = new Date().toISOString() } = {}) {
  const row = await env.DB.prepare(`
    SELECT * FROM eligibility_grants
    WHERE user_id = ? AND state = 'ACTIVE' AND expires_at > ? AND sponsored_visits_used < sponsored_visit_limit
    ORDER BY granted_at DESC LIMIT 1
  `).bind(userId, now).first();
  if (!row) return null;
  return {
    id: row.id,
    applicationId: row.application_id,
    decisionId: row.decision_id,
    expiresAt: row.expires_at,
    sponsoredVisitLimit: Number(row.sponsored_visit_limit),
    sponsoredVisitsUsed: Number(row.sponsored_visits_used)
  };
}

/**
 * Consume a grant for one sponsored connection, and count it against the
 * rolling limit. Called by the fund flow on a *completed* connection — the
 * compare-and-swap on `sponsored_visits_used` is what stops two concurrent
 * bookings from spending one grant twice.
 */
export async function recordSponsoredCompletion(env, { grantId, userId, identityKey, reservationId = null, now = new Date().toISOString(), policy = activePolicy() } = {}) {
  const result = await env.DB.prepare(`
    UPDATE eligibility_grants
    SET sponsored_visits_used = sponsored_visits_used + 1,
        last_consumed_at = ?, last_reservation_id = ?, updated_at = ?,
        state = CASE WHEN sponsored_visits_used + 1 >= sponsored_visit_limit THEN 'CONSUMED' ELSE state END
    WHERE id = ? AND state = 'ACTIVE' AND sponsored_visits_used < sponsored_visit_limit
  `).bind(now, reservationId, now, grantId).run();
  if (!Number(result?.meta?.changes || 0)) return { ok: false, code: "GRANT_NOT_CONSUMABLE" };

  if (identityKey) {
    await env.DB.prepare(`
      INSERT INTO eligibility_rate_limits (identity_key, user_id, window_days, max_sponsored_connections, sponsored_connections_used, window_started_at, last_completed_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT (identity_key) DO UPDATE SET
        sponsored_connections_used = eligibility_rate_limits.sponsored_connections_used + 1,
        last_completed_at = excluded.last_completed_at,
        window_started_at = COALESCE(eligibility_rate_limits.window_started_at, excluded.window_started_at),
        updated_at = excluded.updated_at
    `).bind(identityKey, userId || null, policy.rateLimit.windowDays, policy.rateLimit.sponsoredConnectionsPerWindow, now, now, now).run();
  }
  await recordAudit(env, {
    actorId: userId, actorRole: "system", action: "hardship.grant.consumed",
    subjectType: "eligibility_grant", subjectId: grantId, newState: { reservationId, consumedAt: now }
  });
  return { ok: true };
}

/* ──────────────────────────────────────────────────────── HTTP handlers ── */

/**
 * What the applicant is allowed to see.
 *
 * Built from the decision rather than passed through it: `reasonCodes`,
 * `explanation`, `evidenceIds`, and the internal state name are all dropped
 * here, once, so no future route can leak them by forgetting to.
 */
export function applicantView({ state, decision, pricing, policy }) {
  const ownerFeeCents = pricing.ownerFeeCents;
  if (state === "APPROVED" && decision) {
    return {
      status: "APPROVED",
      title: "Paw It Forward assistance approved",
      message: approvalCopy({ ownerFeeCents }),
      expiresAt: decision.expiresAt,
      sponsoredVisitLimit: decision.sponsoredVisitLimit,
      ownerFeeCents: 0
    };
  }
  if (state === "NOT_VERIFIED") {
    return {
      status: "NOT_VERIFIED",
      title: "We could not verify your hardship",
      message: softDenialCopy({ ownerFeeCents, supportEmail: policy.support.hardshipEmail }),
      supportEmail: policy.support.hardshipEmail,
      ownerFeeCents
    };
  }
  if (state === "TECHNICAL_RETRY" || state === "SECURITY_HOLD") {
    return { status: "PENDING", title: "Still checking", message: pendingCopy({ ownerFeeCents }), ownerFeeCents };
  }
  return { status: state === "VERIFYING" ? "VERIFYING" : "DRAFT", title: null, message: null, ownerFeeCents };
}

/**
 * The routes. Mounted by the integrator under `/api/hardship`; returns null
 * for a path it does not own so the caller can fall through.
 *
 * Everything is scoped to `actor.userId`. There is no route that accepts an
 * applicant id from the request — an application belongs to whoever is signed
 * in, which is the only way to reach one.
 */
export async function handleHardship(request, env, actor, path, method, options = {}) {
  if (!path.startsWith("/api/hardship")) return null;
  if (!actor?.userId) return apiError(401, "AUTHENTICATION_REQUIRED", "Sign in is required to continue.");
  if (!hasDatabase(env)) {
    return apiError(503, "DATABASE_REQUIRED", "TímiNOW cannot reach the assistance service right now. You can still book at the standard fee.");
  }

  const policy = activePolicy();
  const pricing = await activePricingPolicy(env);
  const now = options.now || new Date().toISOString();
  const body = method === "POST" ? await readJson(request).catch(() => null) : null;

  if (path === "/api/hardship/applications") {
    if (method !== "POST") return apiError(405, "METHOD_NOT_ALLOWED", "Use POST to start an assistance application.");
    const application = await createApplication(env, actor, body || {}, { now });
    return json({ application, view: applicantView({ state: application.state, decision: null, pricing, policy }) }, { status: 201 });
  }

  if (path === "/api/hardship/eligibility") {
    if (method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", "Use GET to read current eligibility.");
    const grant = await activeGrantFor(env, actor.userId, { now });
    return json({
      eligible: Boolean(grant),
      grant,
      ownerFeeCents: grant ? 0 : pricing.ownerFeeCents,
      standardOwnerFeeCents: pricing.ownerFeeCents
    });
  }

  const match = path.match(/^\/api\/hardship\/applications\/([^/]+)(?:\/(identity-session|evidence|submit|appeal))?$/);
  if (!match) return apiError(404, "NOT_FOUND", "The requested API route does not exist.");
  const applicationId = decodeURIComponent(match[1]);
  const action = match[2] || null;

  const application = await getApplication(env, applicationId, actor.userId);
  if (!application) return apiError(404, "APPLICATION_NOT_FOUND", "That assistance application was not found.");

  if (!action) {
    if (method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", "Use GET to read an application.");
    const decision = await latestDecision(env, application.id);
    return json({ application, view: applicantView({ state: application.state, decision, pricing, policy }) });
  }

  if (action === "identity-session") {
    if (method !== "POST") return apiError(405, "METHOD_NOT_ALLOWED", "Use POST to start identity verification.");
    // EMBEDDED unless the client explicitly asks for the hosted fallback.
    const mode = cleanString(body?.mode, 16).toUpperCase() === "HOSTED" ? "HOSTED" : "EMBEDDED";
    try {
      const session = await startIdentitySession(env, application, { mode, returnUrl: cleanString(body?.returnUrl, 300) || null, now, providerSet: options.providerSet });
      return json({ session });
    } catch (error) {
      if (error instanceof ProviderError) return apiError(503, "IDENTITY_UNAVAILABLE", "Identity verification is unavailable right now. Please try again shortly.");
      throw error;
    }
  }

  if (action === "evidence") {
    if (method !== "POST") return apiError(405, "METHOD_NOT_ALLOWED", "Use POST to attach evidence.");
    if (application.state !== "DRAFT" && application.state !== "TECHNICAL_RETRY") {
      return apiError(409, "APPLICATION_NOT_OPEN", "This application is no longer accepting documents.");
    }
    const attached = await attachEvidence(env, application, body || {}, { now });
    if (!attached.ok) return apiError(422, attached.code, attached.message);
    return json({ evidenceId: attached.evidenceId, retentionDeadline: attached.retentionDeadline }, { status: 201 });
  }

  if (action === "submit") {
    if (method !== "POST") return apiError(405, "METHOD_NOT_ALLOWED", "Use POST to submit an application.");
    const result = await submitApplication(env, actor, application.id, { now, providerSet: options.providerSet, policy });
    if (!result.ok) return apiError(result.status || 422, result.code, result.message);
    return json({
      application: result.application,
      // Note what is absent: reason codes, the explanation snapshot, evidence
      // ids, and the internal state. The applicant gets a sentence.
      view: applicantView({ state: result.application.state, decision: result.decision, pricing, policy })
    });
  }

  if (action === "appeal") {
    if (method !== "POST") return apiError(405, "METHOD_NOT_ALLOWED", "Use POST to request a human review.");
    const decision = await latestDecision(env, application.id);
    const id = newId("appeal");
    await env.DB.prepare(`
      INSERT INTO human_appeals (id, application_id, decision_id, user_id, contact_email, state, submitted_at, created_at)
      VALUES (?, ?, ?, ?, ?, 'RECEIVED', ?, ?)
    `).bind(id, application.id, decision?.id || null, actor.userId, cleanString(body?.contactEmail, 200) || null, now, now).run();
    await recordAudit(env, {
      actorId: actor.userId, actorRole: "applicant", action: "hardship.appeal.received",
      subjectType: "human_appeal", subjectId: id, newState: { applicationId: application.id, decisionId: decision?.id || null }
    });
    return json({
      appealId: id,
      // Honest about what an appeal can and cannot do: it affects future
      // bookings, and promises no refund on this one.
      message: `A person will review your case. Human review affects future bookings; this booking continues at the standard ${formatUsd(pricing.ownerFeeCents)} fee.`
    }, { status: 201 });
  }

  return apiError(404, "NOT_FOUND", "The requested API route does not exist.");
}

async function readJson(request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 32_768) throw new Error("PAYLOAD_TOO_LARGE");
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) throw new Error("JSON_REQUIRED");
  return request.json();
}
