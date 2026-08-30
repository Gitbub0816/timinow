/**
 * The evaluator.
 *
 * Every function in this file is pure. No database, no fetch, no `Date.now()`,
 * no randomness, no provider call, no model. It takes normalized facts and a
 * policy fixture and returns a decision. That is not a style preference — it
 * is the mechanism by which acceptance test 28 ("same inputs and rule version
 * always yield the same result") is true structurally rather than by
 * intention. A function that cannot read a clock cannot drift, and a function
 * that cannot call a provider cannot be talked into a different answer by one.
 *
 * `now` is therefore a required argument and the engine throws without it.
 * The alternative — defaulting to the current time — is how a replay of a
 * decision from six weeks ago quietly produces a different result and nobody
 * finds out until somebody appeals.
 *
 * ──────────────────────────────────────────────────── what OCR may decide ──
 *
 * Nothing. Extraction gets to say "this line reads TRANSMISSION REPLACEMENT,
 * $2,600, confidence 0.94". This file decides whether that counts, and it
 * decides by comparing the normalized category against a list in policy.js.
 * A category the policy has never heard of is ambiguous and is excluded with
 * a reason code — never rounded toward the applicant, never rounded away from
 * them. There is no score, no vote, and no tie-break.
 */

/** Machine-readable reasons. The applicant never sees any of these. */
export const REASON_CODES = Object.freeze({
  IDENTITY_NOT_VERIFIED: "IDENTITY_NOT_VERIFIED",
  IDENTITY_CONFIDENCE_INSUFFICIENT: "IDENTITY_CONFIDENCE_INSUFFICIENT",
  DOCUMENT_NOT_INDEPENDENTLY_VERIFIED: "DOCUMENT_NOT_INDEPENDENTLY_VERIFIED",
  NO_PATHWAY_INDEPENDENTLY_VERIFIED: "NO_PATHWAY_INDEPENDENTLY_VERIFIED",
  NO_INCOME_DETECTED_IS_NOT_VERIFIED_ZERO_INCOME: "NO_INCOME_DETECTED_IS_NOT_VERIFIED_ZERO_INCOME",
  BANK_BALANCE_ALONE_NOT_SUFFICIENT: "BANK_BALANCE_ALONE_NOT_SUFFICIENT",
  DISABILITY_STATUS_ALONE_NOT_QUALIFYING: "DISABILITY_STATUS_ALONE_NOT_QUALIFYING",
  INSUFFICIENT_PURPOSE_EVIDENCE: "INSUFFICIENT_PURPOSE_EVIDENCE",
  MERCHANT_CATEGORY_ALONE_INSUFFICIENT: "MERCHANT_CATEGORY_ALONE_INSUFFICIENT"
});

export const DECISION = Object.freeze({
  APPROVED: "APPROVED",
  NOT_VERIFIED: "NOT_VERIFIED"
});

/* ───────────────────────────────────────────────────────────── dates ── */

/**
 * Whole calendar days between two instants, counted in UTC.
 *
 * Calendar days rather than 86,400,000-millisecond intervals, because a
 * termination notice carries a date and not a time. Uploading at 11pm instead
 * of 9am must not make a 30-day-old notice fail; the applicant did not do
 * anything different.
 */
export function daysBetween(fromValue, toValue) {
  const from = utcDayIndex(fromValue);
  const to = utcDayIndex(toValue);
  if (from === null || to === null) return null;
  return to - from;
}

function utcDayIndex(value) {
  if (value === null || value === undefined) return null;
  const text = value instanceof Date ? value.toISOString() : String(value);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : null;
}

function isoInstant(value) {
  const date = value instanceof Date ? value : new Date(String(value));
  const ms = date.getTime();
  if (!Number.isFinite(ms)) throw new Error(`Invalid timestamp "${value}" passed to the hardship engine.`);
  return new Date(ms).toISOString();
}

/** `now` plus whole days, as an instant. Used for eligibility expiry. */
export function addDays(nowValue, days) {
  const ms = new Date(isoInstant(nowValue)).getTime() + Math.trunc(days) * 86_400_000;
  return new Date(ms).toISOString();
}

/* ─────────────────────────────────────────────── the shock threshold ── */

/**
 * Linear interpolation between policy anchors, flat outside them.
 *
 * This is the single reason there are no bracket cliffs. The spec states the
 * curve as bands, which invites a `if (income <= 25000) ... else if` ladder;
 * such a ladder makes the bar jump by hundreds of dollars for one extra
 * dollar of income, and acceptance test 26 exists to catch exactly that. A
 * value returned from this function moves continuously: only its slope
 * changes at an anchor.
 */
function interpolate(anchors, x) {
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  if (x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];
  for (let index = 1; index < anchors.length; index += 1) {
    const [x0, y0] = anchors[index - 1];
    const [x1, y1] = anchors[index];
    if (x <= x1) {
      if (x1 === x0) return y1;
      return y0 + (y1 - y0) * ((x - x0) / (x1 - x0));
    }
  }
  return last[1];
}

/** Income coerced to a whole, non-negative number of cents. */
function normalizedIncomeCents(incomeCents) {
  const number = Number(incomeCents);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.trunc(number));
}

/**
 * The share of annual household income a shock must reach, as a fraction.
 *
 * 2.0% at or below $25,000, rising continuously to 5.0% at $150,000 and flat
 * above. Zero income is a legitimate input and returns the opening rate; no
 * division by income happens anywhere in this file.
 */
export function shockPercent(incomeCents, policy) {
  return interpolate(policy.financialShock.percentAnchors, normalizedIncomeCents(incomeCents));
}

/**
 * The dollar floor at this income, interpolated on the same principle as the
 * percentage — a floor built as steps would reintroduce the cliff that the
 * interpolated percentage removed.
 */
export function shockFloorCents(incomeCents, policy) {
  return Math.round(interpolate(policy.financialShock.floorAnchors, normalizedIncomeCents(incomeCents)));
}

/**
 * What a shock must total to qualify at this income.
 *
 * The greater of the floor and income × percentage. Both inputs to the `max`
 * are continuous, and the maximum of two continuous functions is continuous,
 * so the composed threshold has no cliffs either.
 *
 * `adjustmentFactor` is spec §9.4's post-calculation geographic/household
 * adjustment. It is multiplicative and clamped, which keeps continuity; in
 * policy v1 it is disabled and this argument is ignored.
 */
export function requiredShockCents(incomeCents, policy, { adjustmentFactor = 1 } = {}) {
  const income = normalizedIncomeCents(incomeCents);
  const base = Math.max(shockFloorCents(income, policy), Math.round(income * shockPercent(income, policy)));
  const adjustment = policy.financialShock.thresholdAdjustment;
  if (!adjustment?.enabled) return base;
  const factor = Math.min(adjustment.factorMax, Math.max(adjustment.factorMin, Number(adjustmentFactor) || 1));
  return Math.round(base * factor);
}

/* ────────────────────────────────────────────────── shock line items ── */

/**
 * Sum the line items that actually count.
 *
 * Three ways a line fails to count, and all three are recorded:
 *
 *   excluded  — the category is on the policy's exclusion list. Custom wheels.
 *   ambiguous — the category is on neither list, including categories this
 *               policy version has never heard of. "AUTOMOTIVE SERVICES" is
 *               not a purpose; it is the absence of one, and the engine says
 *               so rather than guessing which way the applicant would prefer.
 *   unproven  — the purpose or the financial event is not evidenced, the
 *               extraction confidence is below the policy floor, the line is
 *               outside the rolling window, or the same document was already
 *               counted in this submission.
 *
 * Returns cents plus the full disposition of every line, because a decision
 * nobody can explain line by line is a decision nobody can appeal.
 */
export function qualifyingShockTotal(lineItems, { now, policy } = {}) {
  if (!now) throw new Error("qualifyingShockTotal requires an explicit `now` — see the file header.");
  if (!policy) throw new Error("qualifyingShockTotal requires a policy version.");

  const shock = policy.financialShock;
  const config = policy.pathways.FINANCIAL_SHOCK;
  const qualifying = new Set(shock.qualifyingCategories);
  const excluded = new Set(shock.excludedCategories);
  const purposeProofs = new Set(shock.acceptedPurposeProofs);
  const financialProofs = new Set(shock.acceptedFinancialProofs);
  const windowDays = shock.aggregationWindowDays;

  const counted = [];
  const rejected = [];
  const reasonCodes = [];
  const seenHashes = new Set();
  let totalCents = 0;

  const note = (code) => { if (!reasonCodes.includes(code)) reasonCodes.push(code); };
  const reject = (item, index, code) => {
    rejected.push({ id: itemId(item, index), category: item?.normalizedCategory || null, amountCents: amountOf(item), code });
    note(code);
  };

  const items = Array.isArray(lineItems) ? lineItems : [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const amountCents = amountOf(item);
    const category = typeof item?.normalizedCategory === "string" ? item.normalizedCategory : null;

    if (!Number.isFinite(amountCents) || amountCents <= 0) { reject(item, index, "LINE_AMOUNT_INVALID"); continue; }
    if (amountCents < shock.minimumLineAmountCents) { reject(item, index, "LINE_AMOUNT_BELOW_MINIMUM"); continue; }

    const age = daysBetween(item?.documentDate, now);
    if (age === null) { reject(item, index, "LINE_DATE_MISSING"); continue; }
    if (age < 0) { reject(item, index, "LINE_DATE_IN_FUTURE"); continue; }
    if (age > windowDays) { reject(item, index, "LINE_OUTSIDE_AGGREGATION_WINDOW"); continue; }

    if (!category || (!qualifying.has(category) && !excluded.has(category))) {
      // The ambiguous case. Both codes are emitted: the first says which line,
      // the second is the spec's required INSUFFICIENT_PURPOSE_EVIDENCE.
      reject(item, index, "LINE_CATEGORY_AMBIGUOUS");
      note(REASON_CODES.INSUFFICIENT_PURPOSE_EVIDENCE);
      continue;
    }
    if (excluded.has(category)) { reject(item, index, "LINE_CATEGORY_EXCLUDED"); continue; }

    const confidence = Number(item?.extractionConfidence);
    if (!Number.isFinite(confidence) || confidence < config.extractionConfidenceFloor) {
      reject(item, index, "LINE_EXTRACTION_CONFIDENCE_BELOW_FLOOR");
      continue;
    }

    if (!purposeProofs.has(item?.purposeProof)) {
      reject(item, index, "LINE_PURPOSE_PROOF_MISSING");
      note(REASON_CODES.INSUFFICIENT_PURPOSE_EVIDENCE);
      // A card transaction with a merchant category and no itemization is the
      // canonical version of this failure and gets its own code.
      if (item?.financialProof === "CONNECTED_TRANSACTION" || item?.financialProof === "BANK_OR_CARD_STATEMENT") {
        note(REASON_CODES.MERCHANT_CATEGORY_ALONE_INSUFFICIENT);
      }
      continue;
    }

    if (!financialProofs.has(item?.financialProof)) { reject(item, index, "LINE_FINANCIAL_PROOF_MISSING"); continue; }
    if (item.financialProof === "CURRENT_BALANCE_OWED" && !shock.unpaidObligationsAllowed) {
      reject(item, index, "LINE_UNPAID_OBLIGATION_NOT_ALLOWED");
      continue;
    }

    // Reuse detection inside one submission. The same invoice presented twice
    // is counted once; whether it was also used by another applicant is a
    // database question, handled in index.js against financial_shock_items.
    const hash = typeof item?.dedupeHash === "string" ? item.dedupeHash : null;
    if (hash && seenHashes.has(hash)) { reject(item, index, "LINE_DUPLICATE_IN_SUBMISSION"); continue; }
    if (hash) seenHashes.add(hash);

    totalCents += amountCents;
    counted.push({ id: itemId(item, index), category, amountCents, issuer: item?.issuer || null, documentDate: item?.documentDate || null });
  }

  return { totalCents, counted, rejected, reasonCodes };
}

function amountOf(item) {
  const number = Number(item?.amountCents);
  return Number.isFinite(number) ? Math.trunc(number) : Number.NaN;
}

function itemId(item, index) {
  return typeof item?.id === "string" && item.id ? item.id : `line_${index}`;
}

/* ─────────────────────────────────────────────────────── the pathways ── */

/**
 * Each evaluator answers one published rule and nothing else. They never look
 * at each other's evidence, never accumulate partial credit, and never return
 * a number that another pathway adds to its own. OR pathways, not a score.
 */
const PATHWAY_EVALUATORS = {
  MEANS_TESTED_BENEFIT(facts, config, policy, ctx) {
    const benefit = facts.benefit;
    if (!benefit) return fail(["NO_BENEFIT_EVIDENCE"]);

    const missing = missingFields(benefit, config.requiredFields);
    if (missing.length) return fail(["MISSING_REQUIRED_FIELDS"], { missingFields: missing });
    if (!config.acceptedDocumentTypes.includes(benefit.documentType)) return fail(["DOCUMENT_TYPE_NOT_ACCEPTED"]);
    // SSDI and other non-means-tested awards land here. Receiving them is not
    // evidence of a means test, and treating them as such would be the
    // disability-equals-eligible rule both specs prohibit.
    if (!config.acceptedPrograms.includes(benefit.programCode)) return fail(["PROGRAM_NOT_MEANS_TESTED"]);
    if (benefit.statusCurrent !== true) return fail(["BENEFIT_NOT_CURRENT"]);
    if (config.identityMatchRequired && benefit.recipientMatch !== true) return fail(["RECIPIENT_IDENTITY_MISMATCH"]);

    const freshness = checkFreshness(benefit.documentDate, config.freshnessWindowDays, ctx.now);
    if (!freshness.ok) return fail([freshness.code], { ageDays: freshness.ageDays });
    if (!confidenceOk(benefit.extractionConfidence, config)) return fail(["EXTRACTION_CONFIDENCE_BELOW_FLOOR"]);

    return pass({
      code: "CURRENT_MEANS_TESTED_BENEFIT_VERIFIED",
      validityDays: config.validityDays,
      sponsoredVisitLimit: config.maxSponsoredVisits,
      used: ["benefit.programCode", "benefit.statusCurrent", "benefit.documentDate", "benefit.recipientMatch"],
      evidenceIds: [benefit.evidenceId],
      detail: { programCode: benefit.programCode, ageDays: freshness.ageDays }
    });
  },

  RECENT_JOB_LOSS(facts, config, policy, ctx) {
    const notice = facts.employment?.terminationNotice;
    if (!notice) return fail(["NO_SEPARATION_NOTICE"]);

    const missing = missingFields(notice, config.requiredFields);
    if (missing.length) return fail(["MISSING_REQUIRED_FIELDS"], { missingFields: missing });
    if (!config.acceptedDocumentTypes.includes(notice.documentType)) return fail(["DOCUMENT_TYPE_NOT_ACCEPTED"]);
    if (!config.acceptedSeparationTypes.includes(notice.separationType)) return fail(["SEPARATION_NOT_QUALIFYING"]);
    if (config.identityMatchRequired && notice.employeeMatch !== true) return fail(["RECIPIENT_IDENTITY_MISMATCH"]);

    // The 30/31 boundary. Day 30 passes, day 31 fails, and the difference is
    // one integer comparison rather than a tolerance somebody can argue with.
    const freshness = checkFreshness(notice.effectiveDate, config.freshnessWindowDays, ctx.now);
    if (!freshness.ok) return fail([freshness.code], { ageDays: freshness.ageDays });
    if (!confidenceOk(notice.extractionConfidence, config)) return fail(["EXTRACTION_CONFIDENCE_BELOW_FLOOR"]);

    return pass({
      code: "RECENT_INVOLUNTARY_SEPARATION_VERIFIED",
      validityDays: config.validityDays,
      sponsoredVisitLimit: config.maxSponsoredVisits,
      used: ["employment.terminationNotice.effectiveDate", "employment.terminationNotice.separationType", "employment.terminationNotice.employeeMatch"],
      evidenceIds: [notice.evidenceId],
      detail: { ageDays: freshness.ageDays, separationType: notice.separationType }
    });
  },

  UNEMPLOYMENT(facts, config, policy, ctx) {
    const claim = facts.employment?.unemployment;
    if (!claim) return fail(["NO_UNEMPLOYMENT_EVIDENCE"]);

    const missing = missingFields(claim, config.requiredFields);
    if (missing.length) return fail(["MISSING_REQUIRED_FIELDS"], { missingFields: missing });
    if (!config.acceptedDocumentTypes.includes(claim.documentType)) return fail(["DOCUMENT_TYPE_NOT_ACCEPTED"]);
    if (!config.acceptedDeterminationStatuses.includes(claim.determinationStatus)) return fail(["CLAIM_NOT_ACTIVE"]);
    if (config.identityMatchRequired && claim.claimantMatch !== true) return fail(["RECIPIENT_IDENTITY_MISMATCH"]);

    const freshness = checkFreshness(claim.documentDate, config.freshnessWindowDays, ctx.now);
    if (!freshness.ok) return fail([freshness.code], { ageDays: freshness.ageDays });
    if (!confidenceOk(claim.extractionConfidence, config)) return fail(["EXTRACTION_CONFIDENCE_BELOW_FLOOR"]);

    return pass({
      code: "CURRENT_UNEMPLOYMENT_DETERMINATION_VERIFIED",
      validityDays: config.validityDays,
      sponsoredVisitLimit: config.maxSponsoredVisits,
      used: ["employment.unemployment.determinationStatus", "employment.unemployment.documentDate", "employment.unemployment.claimantMatch"],
      evidenceIds: [claim.evidenceId],
      detail: { ageDays: freshness.ageDays }
    });
  },

  REDUCED_EARNINGS(facts, config, policy, ctx) {
    const reduction = facts.employment?.reducedEarnings;
    if (!reduction) return fail(["NO_EARNINGS_REDUCTION_EVIDENCE"]);

    const missing = missingFields(reduction, config.requiredFields);
    if (missing.length) return fail(["MISSING_REQUIRED_FIELDS"], { missingFields: missing });
    if (!config.acceptedDocumentTypes.includes(reduction.documentType)) return fail(["DOCUMENT_TYPE_NOT_ACCEPTED"]);
    if (config.identityMatchRequired && reduction.employeeMatch !== true) return fail(["RECIPIENT_IDENTITY_MISMATCH"]);

    const prior = Number(reduction.priorPeriodEarningsCents);
    const current = Number(reduction.currentPeriodEarningsCents);
    // A prior period of zero has no reduction to measure — and is also the
    // only place in this pathway where a division could go wrong, so it is
    // refused before the division rather than guarded after it.
    if (!Number.isFinite(prior) || prior <= 0) return fail(["INSUFFICIENT_COMPARISON_BASIS"]);
    if (!Number.isFinite(current) || current < 0) return fail(["INSUFFICIENT_COMPARISON_BASIS"]);
    if (Number(reduction.comparedPeriods || 0) < config.minimumComparedPeriods) return fail(["TOO_FEW_COMPARED_PERIODS"]);

    const ratio = (prior - current) / prior;
    if (ratio < config.minimumReductionRatio) return fail(["REDUCTION_BELOW_POLICY_MINIMUM"], { reductionRatio: round4(ratio) });

    const freshness = checkFreshness(reduction.comparisonEndDate, config.freshnessWindowDays, ctx.now);
    if (!freshness.ok) return fail([freshness.code], { ageDays: freshness.ageDays });
    if (!confidenceOk(reduction.extractionConfidence, config)) return fail(["EXTRACTION_CONFIDENCE_BELOW_FLOOR"]);

    return pass({
      code: "SUBSTANTIAL_EARNINGS_REDUCTION_VERIFIED",
      validityDays: config.validityDays,
      sponsoredVisitLimit: config.maxSponsoredVisits,
      used: ["employment.reducedEarnings.priorPeriodEarningsCents", "employment.reducedEarnings.currentPeriodEarningsCents", "employment.reducedEarnings.comparisonEndDate"],
      evidenceIds: [reduction.evidenceId],
      detail: { reductionRatio: round4(ratio), ageDays: freshness.ageDays }
    });
  },

  AREA_ADJUSTED_INCOME(facts, config, policy, ctx) {
    const income = facts.income;
    if (!income) return fail(["NO_INCOME_EVIDENCE"]);

    const incomeState = checkVerifiedIncome(income);
    if (!incomeState.ok) return fail(incomeState.codes);
    if (!config.acceptedDocumentTypes.includes(income.documentType)) return fail(["DOCUMENT_TYPE_NOT_ACCEPTED"]);
    if (income.sourceType === "SELF_PREPARED_TAX_RETURN" && !config.selfPreparedReturnAllowed) {
      return fail(["SELF_PREPARED_RETURN_NOT_ACCEPTED"]);
    }
    if (config.identityMatchRequired && income.taxpayerMatch !== true) return fail(["RECIPIENT_IDENTITY_MISMATCH"]);

    const household = checkHousehold(facts, config);
    if (!household.ok) return fail(household.codes);

    const geography = facts.household?.geography;
    // `numeric` rather than `Number`: Number(null) is 0, which would let a
    // missing area index silently become a real one and get clamped into the
    // policy's minimum. A missing dataset must fail, not default.
    const areaIndex = numeric(geography?.areaIndex);
    // The index and the dataset release both have to be present: a threshold
    // computed from an unnamed dataset cannot be re-derived on appeal.
    if (config.geographyRequired && (!geography?.datasetVersion || !Number.isFinite(areaIndex))) {
      return fail(["AREA_DATASET_MISSING"]);
    }

    const freshness = checkFreshness(income.documentDate, config.freshnessWindowDays, ctx.now);
    if (!freshness.ok) return fail([freshness.code], { ageDays: freshness.ageDays });
    if (!confidenceOk(income.extractionConfidence, config)) return fail(["EXTRACTION_CONFIDENCE_BELOW_FLOOR"]);

    const thresholdCents = areaAdjustedThresholdCents(household.size, areaIndex, policy);
    const annualCents = normalizedIncomeCents(income.annualCents);
    if (annualCents > thresholdCents) {
      return fail(["INCOME_ABOVE_AREA_ADJUSTED_THRESHOLD"], { thresholdCents, annualCents });
    }

    // Pay-stub evidence is current but thin, and expires sooner than a return.
    const validityDays = income.documentType === "PAY_STUB_SET" ? config.payStubValidityDays : config.validityDays;
    return pass({
      code: "AREA_ADJUSTED_INCOME_BELOW_THRESHOLD",
      validityDays,
      sponsoredVisitLimit: config.maxSponsoredVisits,
      used: ["income.status", "income.annualCents", "household.size", "household.geography.areaIndex", "household.geography.datasetVersion"],
      evidenceIds: [income.evidenceId],
      detail: {
        annualCents,
        thresholdCents,
        householdSize: household.size,
        areaIndex: round4(clampAreaIndex(areaIndex, policy)),
        datasetId: policy.areaAdjustedIncome.datasetId,
        datasetVersion: geography?.datasetVersion || null
      }
    });
  },

  FINANCIAL_SHOCK(facts, config, policy, ctx) {
    const income = facts.income;
    if (!income) return fail(["INCOME_NOT_INDEPENDENTLY_VERIFIED"]);
    // The threshold is a share of verified household income, so an
    // unverified income makes the threshold unknowable rather than zero.
    const incomeState = checkVerifiedIncome(income);
    if (!incomeState.ok) return fail(incomeState.codes);

    const household = checkHousehold(facts, config);
    if (!household.ok) return fail(household.codes);

    const items = facts.financialShock?.lineItems;
    if (!Array.isArray(items) || items.length === 0) return fail(["NO_SHOCK_LINE_ITEMS"]);

    const shock = qualifyingShockTotal(items, { now: ctx.now, policy });
    const annualCents = normalizedIncomeCents(income.annualCents);
    // No adjustment factor is passed: policy v1 disables the geographic
    // adjustment pending the fairness review, and inventing one here rather
    // than in the fixture is how an unreviewed rule ships anyway.
    const requiredCents = requiredShockCents(annualCents, policy);

    if (shock.totalCents < requiredCents) {
      return fail(
        ["SHOCK_BELOW_REQUIRED_THRESHOLD", ...shock.reasonCodes],
        { qualifyingCents: shock.totalCents, requiredCents, annualCents, rejected: shock.rejected }
      );
    }

    return pass({
      code: "QUALIFYING_FINANCIAL_SHOCK_VERIFIED",
      validityDays: config.validityDays,
      sponsoredVisitLimit: config.maxSponsoredVisits,
      used: ["income.annualCents", "financialShock.lineItems", "household.size"],
      evidenceIds: shock.counted.map((line) => line.id),
      detail: {
        qualifyingCents: shock.totalCents,
        requiredCents,
        annualCents,
        shockPercent: round4(shockPercent(annualCents, policy)),
        floorCents: shockFloorCents(annualCents, policy),
        counted: shock.counted,
        rejected: shock.rejected
      }
    });
  }
};

function pass({ code, validityDays, sponsoredVisitLimit, used, evidenceIds, detail }) {
  return {
    passed: true,
    codes: [code],
    validityDays,
    sponsoredVisitLimit,
    used: used || [],
    evidenceIds: (evidenceIds || []).filter(Boolean),
    detail: detail || {}
  };
}

function fail(codes, detail) {
  return { passed: false, codes, used: [], evidenceIds: [], detail: detail || {} };
}

function missingFields(source, required) {
  return (required || []).filter((field) => {
    const value = source?.[field];
    return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
  });
}

/** Number(), except that absent values stay absent instead of becoming 0. */
function numeric(value) {
  if (value === null || value === undefined || value === "") return Number.NaN;
  return Number(value);
}

function confidenceOk(value, config) {
  const confidence = Number(value);
  return Number.isFinite(confidence) && confidence >= config.extractionConfidenceFloor;
}

function checkFreshness(dateValue, windowDays, now) {
  const ageDays = daysBetween(dateValue, now);
  if (ageDays === null) return { ok: false, code: "DOCUMENT_DATE_MISSING", ageDays: null };
  if (ageDays < 0) return { ok: false, code: "DOCUMENT_DATE_IN_FUTURE", ageDays };
  if (ageDays > windowDays) return { ok: false, code: "DOCUMENT_OUTSIDE_FRESHNESS_WINDOW", ageDays };
  return { ok: true, ageDays };
}

/**
 * Verified income, and the two states that are emphatically not it.
 *
 * `NO_INCOME_DETECTED` means a connected account showed nothing. That is a
 * statement about what TímiNOW could see, not about what the household earns,
 * and it never qualifies anybody by itself — spec §9.3 and §15 both say so,
 * and it is the single easiest way to build a system that approves people who
 * simply do not bank with the institutions that were checked.
 *
 * `annualCents === 0` with `VERIFIED_INCOME` is different: somebody verified
 * it. That is a legitimate input and flows through the arithmetic normally.
 */
function checkVerifiedIncome(income) {
  if (income.status === "NO_INCOME_DETECTED") {
    return { ok: false, codes: ["INCOME_NOT_INDEPENDENTLY_VERIFIED", REASON_CODES.NO_INCOME_DETECTED_IS_NOT_VERIFIED_ZERO_INCOME] };
  }
  if (income.status !== "VERIFIED_INCOME") return { ok: false, codes: ["INCOME_NOT_INDEPENDENTLY_VERIFIED"] };
  const annual = Number(income.annualCents);
  if (!Number.isFinite(annual) || annual < 0) return { ok: false, codes: ["INCOME_AMOUNT_NOT_USABLE"] };
  return { ok: true, codes: [] };
}

function checkHousehold(facts, config) {
  if (!config.householdRequired) return { ok: true, size: 1, codes: [] };
  const size = Number(facts.household?.size);
  if (!Number.isFinite(size) || size < 1) return { ok: false, codes: ["HOUSEHOLD_SIZE_REQUIRED"] };
  // The attestation is what makes an undisclosed second income a
  // misrepresentation rather than an oversight. Required, never inferred.
  if (facts.household?.attested !== true) return { ok: false, codes: ["HOUSEHOLD_ATTESTATION_REQUIRED"] };
  return { ok: true, size: Math.min(Math.trunc(size), 99), codes: [] };
}

function clampAreaIndex(value, policy) {
  const settings = policy.areaAdjustedIncome;
  const index = Number(value);
  if (!Number.isFinite(index)) return settings.areaIndexMin;
  return Math.min(settings.areaIndexMax, Math.max(settings.areaIndexMin, index));
}

/** Household baseline scaled by a clamped published area index. */
export function areaAdjustedThresholdCents(householdSize, areaIndex, policy) {
  const settings = policy.areaAdjustedIncome;
  const counted = Math.min(Math.max(1, Math.trunc(Number(householdSize) || 1)), settings.maxCountedHouseholdSize);
  const baseline = settings.baselineFirstPersonCents + (counted - 1) * settings.additionalPersonCents;
  return Math.round(baseline * clampAreaIndex(areaIndex, policy));
}

function round4(value) {
  return Math.round(Number(value) * 10_000) / 10_000;
}

/* ─────────────────────────────────────────────────────── the decision ── */

/**
 * Run the pathways in policy order and return on the first pass.
 *
 * Returning early is the minimum-necessary-evidence principle in code: once a
 * termination notice has satisfied the rule, asking for a tax return as well
 * is collecting sensitive documents the decision does not need. It also means
 * the reason codes on an approval read as a record of what was tried, in
 * order, which is what an auditor wants.
 *
 * The result carries no prose. `explanation` is a snapshot of the numbers and
 * codes involved, never a sentence a model wrote — a free-form rationale
 * stored as the basis of a decision is the thing spec §9.1 prohibits.
 */
export function evaluate(facts, policy, { now } = {}) {
  if (!policy) throw new Error("evaluate requires a policy version — decisions are made against published rules, never defaults.");
  if (!now) throw new Error("evaluate requires an explicit `now`. Reading the clock inside the evaluator would make a replay of a past decision non-deterministic.");

  const nowIso = isoInstant(now);
  const ctx = { now: nowIso };
  const source = facts && typeof facts === "object" ? facts : {};
  const reasonCodes = [];
  const add = (code) => { if (!reasonCodes.includes(code)) reasonCodes.push(code); };

  // Gate 1: a real, unique person. Identity is not used to infer income; it
  // exists so one household cannot become six accounts.
  if (source.identity?.verified !== true) {
    return decided({ decision: DECISION.NOT_VERIFIED, reasonCodes: [REASON_CODES.IDENTITY_NOT_VERIFIED], policy, nowIso });
  }
  if (policy.evidenceGates.identityUniquenessRequired
      && !policy.evidenceGates.acceptedIdentityConfidence.includes(source.identity?.uniquenessConfidence)) {
    return decided({ decision: DECISION.NOT_VERIFIED, reasonCodes: [REASON_CODES.IDENTITY_CONFIDENCE_INSUFFICIENT], policy, nowIso });
  }

  // Gate 2: tamper signals. A document that may have been altered is not
  // evidence, and the applicant is told nothing beyond the neutral copy.
  const tampered = (Array.isArray(source.documents) ? source.documents : []).filter((document) => {
    if (policy.evidenceGates.rejectTamperRisk.includes(document?.tamperRisk)) return true;
    return document?.tamperRisk === "MEDIUM"
      && policy.evidenceGates.escalateMediumTamperRiskFor.includes(document?.documentType);
  });
  if (tampered.length) {
    return decided({
      decision: DECISION.NOT_VERIFIED,
      reasonCodes: [REASON_CODES.DOCUMENT_NOT_INDEPENDENTLY_VERIFIED],
      policy,
      nowIso,
      evidenceIds: tampered.map((document) => document.evidenceId).filter(Boolean)
    });
  }

  // Why each pathway that ran did not pass, in numbers. This is what makes a
  // denial answerable: "$1,400 of qualifying obligations against a $1,920
  // threshold" is a sentence somebody can check, argue with, and appeal.
  const pathwayDetails = {};

  for (const pathwayId of policy.pathwayOrder) {
    const config = policy.pathways[pathwayId];
    if (!config) { add(`${pathwayId}:PATHWAY_NOT_CONFIGURED`); continue; }
    if (!config.enabled) { add(`${pathwayId}:PATHWAY_DISABLED`); continue; }

    const outcome = PATHWAY_EVALUATORS[pathwayId](source, config, policy, ctx);
    for (const code of outcome.codes) add(`${pathwayId}:${code}`);
    if (!outcome.passed) {
      if (Object.keys(outcome.detail).length) pathwayDetails[pathwayId] = outcome.detail;
      continue;
    }

    return decided({
      decision: DECISION.APPROVED,
      pathway: pathwayId,
      reasonCodes,
      policy,
      nowIso,
      expiresAt: addDays(nowIso, outcome.validityDays),
      sponsoredVisitLimit: outcome.sponsoredVisitLimit,
      evidenceFactsUsed: outcome.used,
      evidenceIds: outcome.evidenceIds,
      detail: outcome.detail
    });
  }

  // Nothing passed. Three shapes of evidence get an explicit code, because
  // each is a thing people reasonably expect to be enough and none of them is.
  if (source.income?.status === "NO_INCOME_DETECTED") add(REASON_CODES.NO_INCOME_DETECTED_IS_NOT_VERIFIED_ZERO_INCOME);
  if (source.bank && Number.isFinite(Number(source.bank.balanceCents))) add(REASON_CODES.BANK_BALANCE_ALONE_NOT_SUFFICIENT);
  if (source.disability?.statusDocumented === true) add(REASON_CODES.DISABILITY_STATUS_ALONE_NOT_QUALIFYING);
  add(REASON_CODES.NO_PATHWAY_INDEPENDENTLY_VERIFIED);

  return decided({ decision: DECISION.NOT_VERIFIED, reasonCodes, policy, nowIso, detail: { pathways: pathwayDetails } });
}

function decided({ decision, pathway = null, reasonCodes, policy, nowIso, expiresAt = null, sponsoredVisitLimit = null, evidenceFactsUsed = [], evidenceIds = [], detail = {} }) {
  return Object.freeze({
    decision,
    pathway,
    reasonCodes: Object.freeze([...reasonCodes]),
    policyId: policy.id,
    policyVersion: policy.version,
    engineVersion: policy.engineVersion,
    decidedAt: nowIso,
    expiresAt,
    sponsoredVisitLimit,
    evidenceFactsUsed: Object.freeze([...evidenceFactsUsed]),
    evidenceIds: Object.freeze([...evidenceIds]),
    /**
     * The stored explanation: codes and numbers only. Rendered by the admin
     * surface into a sentence at read time, which keeps the sentence a
     * presentation concern and the decision a record of arithmetic.
     */
    explanation: Object.freeze({
      decision,
      pathway,
      policyId: policy.id,
      policyVersion: policy.version,
      engineVersion: policy.engineVersion,
      ...detail
    })
  });
}
