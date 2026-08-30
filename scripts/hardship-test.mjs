/**
 * Acceptance tests for the hardship engine — spec §19 tests 20 through 31.
 *
 * Two halves. The first exercises the evaluator with no database at all,
 * which is possible precisely because engine.js is pure; the second runs a
 * whole application through D1 and the HTTP handlers with stub providers.
 *
 * The test that matters most is 26. A threshold curve written as income
 * brackets looks correct in every hand-picked example and is wrong at every
 * boundary, so this file does not sample the curve — it sweeps it, and
 * asserts the required amount never moves by more than a dime for a one
 * dollar change in income, anywhere between $0 and $300,000.
 */

import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import { activePolicy, CATEGORY_TAXONOMY } from "../src/hardship/policy.js";
import { evaluate, qualifyingShockTotal, requiredShockCents, shockFloorCents, shockPercent, daysBetween } from "../src/hardship/engine.js";
import {
  providers,
  ProviderError,
  stubDocumentExtractionProvider,
  stubIdentityProvider,
  stubIncomeVerificationProvider,
  stubTransactionVerificationProvider
} from "../src/hardship/providers.js";
import {
  approvalCopy,
  handleHardship,
  latestDecision,
  pendingCopy,
  recordSponsoredCompletion,
  softDenialCopy
} from "../src/hardship/index.js";

class D1StatementMock {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.values) || null;
  }

  async all() {
    return { results: this.database.prepare(this.sql).all(...this.values), success: true };
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid || 0) } };
  }
}

class D1Mock {
  constructor(database) { this.database = database; }
  prepare(sql) { return new D1StatementMock(this.database, sql); }
  async batch(statements) {
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const policy = activePolicy();
const NOW = "2026-08-30T12:00:00.000Z";

/** A date `days` whole days before NOW, as the extractor would report it. */
function daysAgo(days) {
  return new Date(Date.parse("2026-08-30T00:00:00.000Z") - days * 86_400_000).toISOString().slice(0, 10);
}

function baseFacts(extra = {}) {
  return {
    identity: { verified: true, uniquenessConfidence: "HIGH", identityKey: "idk_test" },
    household: { size: 3, attested: true, geography: { areaId: "county:06001", datasetVersion: "2026.1", areaIndex: 1.15 } },
    documents: [],
    ...extra
  };
}

function shockLine(overrides = {}) {
  return {
    id: "line_a",
    normalizedCategory: "VEHICLE_TRANSMISSION_REPAIR",
    amountCents: 260_000,
    documentDate: daysAgo(3),
    issuer: "ABC Auto Service",
    purposeProof: "REPAIR_ORDER",
    financialProof: "PAID_INVOICE_MARKER",
    extractionConfidence: 0.94,
    dedupeHash: "hash_a",
    ...overrides
  };
}

/* ════════════════════════════ part one: the pure evaluator ════════════ */

// ── 26. No bracket cliffs. ─────────────────────────────────────────────
//
// The anchors first: one dollar either side of every band edge in the spec
// table, including the $150,000 edge where the stated floor jumps from
// $2,500 to $5,000 and a literal implementation would move the bar by
// $2,500 for one dollar of income.
const ANCHOR_INCOMES = [0, 2_500_000, 5_000_000, 7_500_000, 10_000_000, 15_000_000, 25_000_000];
for (const anchor of ANCHOR_INCOMES) {
  const below = requiredShockCents(Math.max(0, anchor - 100), policy);
  const above = requiredShockCents(anchor + 100, policy);
  assert(Math.abs(above - below) <= 100,
    `Bracket cliff at $${anchor / 100}: $1 either side moves the required shock from ${below} to ${above} cents`);
  const percentBelow = shockPercent(Math.max(0, anchor - 100), policy);
  const percentAbove = shockPercent(anchor + 100, policy);
  assert(Math.abs(percentAbove - percentBelow) < 1e-4,
    `Bracket cliff in the percentage at $${anchor / 100}: ${percentBelow} → ${percentAbove}`);
}

// Then the whole curve from $0 to $300,000, one dollar at a time. The
// steepest the required amount can legitimately move is about 8 cents per
// dollar of income (5% of income, plus income times the slope of the
// percentage itself), so no single dollar may move the bar by a dime. A band
// implementation fails this within the first thousand steps.
let previousRequired = -1;
let biggestStep = 0;
for (let income = 0; income <= 30_000_000; income += 100) {
  const required = requiredShockCents(income, policy);
  assert(Number.isFinite(required) && required >= 0, `The required shock at ${income} is not a usable number: ${required}`);
  if (previousRequired >= 0) {
    biggestStep = Math.max(biggestStep, Math.abs(required - previousRequired));
    assert(required >= previousRequired, `The required shock fell as income rose, at $${income / 100}`);
  }
  previousRequired = required;
}
assert(biggestStep <= 10, `A $1 change in income moved the required shock by ${biggestStep} cents — that is a cliff, not a slope`);

// The dollar floor is inert above ~$12,500 of income: the percentage always
// wins. That is why the terminal floor anchor is a documented policy choice
// rather than an argument about the spec table's last row.
for (let income = 1_250_000; income <= 30_000_000; income += 250_000) {
  assert(requiredShockCents(income, policy) === Math.round(income * shockPercent(income, policy)),
    `Above $12,500 the percentage must decide, but the floor bound at $${income / 100}`);
}
assert(shockPercent(0, policy) === 0.02 && shockPercent(2_500_000, policy) === 0.02, "The opening band is a flat 2.0%");
assert(shockPercent(30_000_000, policy) === 0.05, "The curve is flat at 5.0% above $150,000");
assert(shockFloorCents(0, policy) === 25_000, "The floor at zero income is $250");
assert(Math.abs(shockPercent(6_000_000, policy) - 0.032) < 1e-9, "At $60,000 the interpolated rate is 3.2%");
assert(requiredShockCents(6_000_000, policy) === 192_000, "At $60,000 the required shock is $1,920");

// ── 23. Zero income is valid input and never divides by zero. ──────────
for (const income of [0, -1, null, undefined, Number.NaN, "0"]) {
  const required = requiredShockCents(income, policy);
  assert(Number.isFinite(required) && required === 25_000, `Income ${String(income)} must yield the $250 floor, got ${required}`);
}
const zeroIncomeFacts = baseFacts({
  income: {
    evidenceId: "evid_tax", documentType: "IRS_RETURN_TRANSCRIPT", status: "VERIFIED_INCOME", annualCents: 0,
    taxpayerName: "Maya Morgan", taxpayerMatch: true, householdSize: 3, annualHouseholdIncomeCents: 0,
    documentDate: daysAgo(60), extractionConfidence: 0.95
  }
});
const zeroIncomeDecision = evaluate(zeroIncomeFacts, policy, { now: NOW });
assert(zeroIncomeDecision.decision === "APPROVED" && zeroIncomeDecision.pathway === "AREA_ADJUSTED_INCOME",
  `Verified zero income is a legitimate input: ${JSON.stringify(zeroIncomeDecision.reasonCodes)}`);
assert(Number.isFinite(zeroIncomeDecision.explanation.thresholdCents), "The zero-income threshold must be a real number");

// ── 20. A current means-tested benefit approves and stops collection. ──
const benefitFacts = baseFacts({
  benefit: {
    evidenceId: "evid_benefit", documentType: "BENEFIT_AWARD_LETTER", issuer: "CalFresh",
    programCode: "SNAP", statusCurrent: true, recipientName: "Maya Morgan", recipientMatch: true,
    documentDate: daysAgo(20), extractionConfidence: 0.93
  }
});
const benefitDecision = evaluate(benefitFacts, policy, { now: NOW });
assert(benefitDecision.decision === "APPROVED" && benefitDecision.pathway === "MEANS_TESTED_BENEFIT",
  `A current SNAP award approves: ${JSON.stringify(benefitDecision.reasonCodes)}`);
assert(benefitDecision.expiresAt === "2027-02-26T12:00:00.000Z", `Six months of eligibility, got ${benefitDecision.expiresAt}`);
assert(benefitDecision.sponsoredVisitLimit === 1, "One sponsored visit under the launch policy");
assert(!benefitDecision.reasonCodes.some((code) => code.startsWith("FINANCIAL_SHOCK") || code.startsWith("AREA_ADJUSTED_INCOME")),
  "Once a pathway passes the engine stops — no later pathway may even be attempted");
assert(benefitDecision.evidenceFactsUsed.includes("benefit.programCode"), "The decision records which facts it used");
assert(!JSON.stringify(benefitDecision.explanation).includes("score"), "There is no score anywhere in an explanation");

// A benefit that is not means-tested (SSDI is earned, not means-tested) fails.
const ssdiDecision = evaluate(baseFacts({
  benefit: { ...benefitFacts.benefit, programCode: "SSDI" },
  disability: { statusDocumented: true }
}), policy, { now: NOW });
assert(ssdiDecision.decision === "NOT_VERIFIED", "A non-means-tested award is not a means test");
assert(ssdiDecision.reasonCodes.includes("MEANS_TESTED_BENEFIT:PROGRAM_NOT_MEANS_TESTED"), "…and says exactly why");
assert(ssdiDecision.reasonCodes.includes("DISABILITY_STATUS_ALONE_NOT_QUALIFYING"), "Disability status alone never qualifies");

// A stale benefit notice fails its own freshness window.
const staleBenefit = evaluate(baseFacts({ benefit: { ...benefitFacts.benefit, documentDate: daysAgo(200) } }), policy, { now: NOW });
assert(staleBenefit.decision === "NOT_VERIFIED" && staleBenefit.reasonCodes.includes("MEANS_TESTED_BENEFIT:DOCUMENT_OUTSIDE_FRESHNESS_WINDOW"),
  "A benefit notice from last year is not current status");

// ── 21. Termination notice: day 30 approves, day 31 does not. ──────────
function terminationFacts(ageDays) {
  return baseFacts({
    employment: {
      terminationNotice: {
        evidenceId: "evid_term", documentType: "EMPLOYER_TERMINATION_NOTICE",
        employeeName: "Dana Reyes", employerName: "Harbor Logistics", employeeMatch: true,
        separationType: "INVOLUNTARY", effectiveDate: daysAgo(ageDays), extractionConfidence: 0.91
      }
    }
  });
}
const day30 = evaluate(terminationFacts(30), policy, { now: NOW });
assert(day30.decision === "APPROVED" && day30.pathway === "RECENT_JOB_LOSS", `A 30-day-old notice approves: ${JSON.stringify(day30.reasonCodes)}`);
assert(day30.expiresAt === "2026-09-29T12:00:00.000Z", `One visit, expiring 30 days after approval, got ${day30.expiresAt}`);
const day31 = evaluate(terminationFacts(31), policy, { now: NOW });
assert(day31.decision === "NOT_VERIFIED", "A 31-day-old notice fails this pathway");
assert(day31.reasonCodes.includes("RECENT_JOB_LOSS:DOCUMENT_OUTSIDE_FRESHNESS_WINDOW"), "…on freshness, specifically");
assert(daysBetween(daysAgo(30), NOW) === 30 && daysBetween(daysAgo(31), NOW) === 31, "Freshness counts whole calendar days in UTC");
// A resignation is not an involuntary separation, however recent.
const voluntary = evaluate(terminationFacts(2), policy, { now: NOW });
assert(voluntary.decision === "APPROVED", "Guard: the recent notice above is otherwise valid");
const resigned = terminationFacts(2);
resigned.employment.terminationNotice.separationType = "VOLUNTARY_RESIGNATION";
assert(evaluate(resigned, policy, { now: NOW }).reasonCodes.includes("RECENT_JOB_LOSS:SEPARATION_NOT_QUALIFYING"),
  "A voluntary resignation is not this pathway");

// ── 22. No income detected never approves by itself. ───────────────────
const noIncome = evaluate(baseFacts({
  income: { evidenceId: "evid_bank", documentType: "PAYROLL_PROVIDER_VERIFICATION", status: "NO_INCOME_DETECTED", annualCents: null, extractionConfidence: 0.99 },
  bank: { balanceCents: 412 }
}), policy, { now: NOW });
assert(noIncome.decision === "NOT_VERIFIED", "An empty connected account is not verified poverty");
assert(noIncome.reasonCodes.includes("NO_INCOME_DETECTED_IS_NOT_VERIFIED_ZERO_INCOME"), "…and is recorded as such");
assert(noIncome.reasonCodes.includes("BANK_BALANCE_ALONE_NOT_SUFFICIENT"), "A bank balance alone is never enough");
assert(noIncome.reasonCodes.includes("AREA_ADJUSTED_INCOME:INCOME_NOT_INDEPENDENTLY_VERIFIED"), "The income pathway refuses an unverified income");
assert(noIncome.reasonCodes.includes("FINANCIAL_SHOCK:INCOME_NOT_INDEPENDENTLY_VERIFIED"), "So does the shock pathway — the threshold is a share of verified income");

// ── 24 & 25. The mixed auto invoice, and the rolling 30-day window. ────
const mixedInvoice = [
  shockLine({ id: "line_transmission", normalizedCategory: "VEHICLE_TRANSMISSION_REPAIR", amountCents: 260_000, dedupeHash: "hash_transmission" }),
  shockLine({ id: "line_wheels", normalizedCategory: "VEHICLE_COSMETIC_UPGRADE", amountCents: 90_000, dedupeHash: "hash_wheels" })
];
const mixed = qualifyingShockTotal(mixedInvoice, { now: NOW, policy });
assert(mixed.totalCents === 260_000, `Only the transmission counts, expected 260000, got ${mixed.totalCents}`);
assert(mixed.counted.length === 1 && mixed.counted[0].id === "line_transmission", "The transmission is the counted line");
assert(mixed.rejected.length === 1 && mixed.rejected[0].id === "line_wheels" && mixed.rejected[0].code === "LINE_CATEGORY_EXCLUDED",
  `The custom wheels are excluded by category: ${JSON.stringify(mixed.rejected)}`);

function shockFacts(lineItems, annualCents = 6_000_000) {
  return baseFacts({
    // A single-person household at $60,000 is well above the area-adjusted
    // threshold, so these cases genuinely exercise the shock pathway rather
    // than being approved by the income pathway two lines earlier.
    household: { size: 1, attested: true, geography: { areaId: "county:06001", datasetVersion: "2026.1", areaIndex: 1.15 } },
    income: {
      evidenceId: "evid_tax", documentType: "IRS_RETURN_TRANSCRIPT", status: "VERIFIED_INCOME", annualCents,
      taxpayerName: "Sam Ortiz", taxpayerMatch: true, householdSize: 3, annualHouseholdIncomeCents: annualCents,
      documentDate: daysAgo(120), extractionConfidence: 0.95
    },
    financialShock: { lineItems }
  });
}
// $60,000 of income needs $1,920, which the transmission alone clears — and
// the household sits above the area-adjusted threshold, so this really is the
// shock pathway deciding rather than the income pathway two steps earlier.
const mixedDecision = evaluate(shockFacts(mixedInvoice), policy, { now: NOW });
assert(mixedDecision.decision === "APPROVED" && mixedDecision.pathway === "FINANCIAL_SHOCK",
  `The mixed invoice approves on the qualifying line only: ${JSON.stringify(mixedDecision.reasonCodes)}`);
assert(mixedDecision.explanation.qualifyingCents === 260_000 && mixedDecision.explanation.requiredCents === 192_000,
  `The stored explanation is arithmetic, not prose: ${JSON.stringify(mixedDecision.explanation)}`);

// Three obligations inside the window aggregate to $2,100 and clear $1,920.
const threeItems = [
  shockLine({ id: "l1", normalizedCategory: "MEDICAL_TREATMENT", amountCents: 70_000, documentDate: daysAgo(2), purposeProof: "MEDICAL_BILL", dedupeHash: "h1" }),
  shockLine({ id: "l2", normalizedCategory: "HOME_PLUMBING_EMERGENCY", amountCents: 70_000, documentDate: daysAgo(17), purposeProof: "CONTRACTOR_INVOICE", dedupeHash: "h2" }),
  shockLine({ id: "l3", normalizedCategory: "VEHICLE_BRAKE_REPAIR", amountCents: 70_000, documentDate: daysAgo(30), purposeProof: "REPAIR_ORDER", dedupeHash: "h3" })
];
const aggregated = evaluate(shockFacts(threeItems), policy, { now: NOW });
assert(aggregated.decision === "APPROVED" && aggregated.explanation.qualifyingCents === 210_000,
  `Three qualifying obligations inside 30 days aggregate: ${JSON.stringify(aggregated.reasonCodes)}`);

// Push the third to day 31 and it drops out; the remaining $1,400 falls short.
const dayThirtyOne = threeItems.map((line) => (line.id === "l3" ? { ...line, documentDate: daysAgo(31) } : line));
const notAggregated = evaluate(shockFacts(dayThirtyOne), policy, { now: NOW });
assert(notAggregated.decision === "NOT_VERIFIED", "A day-31 obligation does not aggregate");
assert(notAggregated.reasonCodes.includes("FINANCIAL_SHOCK:LINE_OUTSIDE_AGGREGATION_WINDOW"), "…and says which line fell outside");
assert(notAggregated.explanation.pathways.FINANCIAL_SHOCK.qualifyingCents === 140_000,
  `Only the two in-window lines counted: ${JSON.stringify(notAggregated.explanation.pathways.FINANCIAL_SHOCK)}`);
assert(notAggregated.explanation.pathways.FINANCIAL_SHOCK.requiredCents === 192_000,
  "A denial records the threshold it fell short of, so the applicant can be told a number on appeal");

// The same invoice submitted twice counts once.
const duplicated = qualifyingShockTotal([shockLine(), shockLine({ id: "line_b" })], { now: NOW, policy });
assert(duplicated.totalCents === 260_000 && duplicated.reasonCodes.includes("LINE_DUPLICATE_IN_SUBMISSION"),
  "A reused invoice line is counted once and flagged");

// ── 27. Ambiguity is never guessed. ────────────────────────────────────
const ambiguous = qualifyingShockTotal([
  shockLine({ id: "line_ambiguous", normalizedCategory: "AUTOMOTIVE_SERVICES_UNSPECIFIED", amountCents: 220_000, dedupeHash: "hash_amb" })
], { now: NOW, policy });
assert(ambiguous.totalCents === 0, "An ambiguous line contributes nothing");
assert(ambiguous.reasonCodes.includes("LINE_CATEGORY_AMBIGUOUS") && ambiguous.reasonCodes.includes("INSUFFICIENT_PURPOSE_EVIDENCE"),
  `Ambiguity surfaces a reason code rather than a guess: ${JSON.stringify(ambiguous.reasonCodes)}`);
const ambiguousDecision = evaluate(shockFacts([
  shockLine({ id: "line_ambiguous", normalizedCategory: "AUTOMOTIVE_SERVICES_UNSPECIFIED", amountCents: 220_000, dedupeHash: "hash_amb" })
]), policy, { now: NOW });
assert(ambiguousDecision.decision === "NOT_VERIFIED" && ambiguousDecision.reasonCodes.includes("FINANCIAL_SHOCK:INSUFFICIENT_PURPOSE_EVIDENCE"),
  "An invoice whose purpose cannot be established soft-fails");

// A category this policy version has never heard of is ambiguous too — a new
// extractor release cannot invent a qualifying category.
const unknownCategory = qualifyingShockTotal([shockLine({ normalizedCategory: "TELEPORTER_REPAIR" })], { now: NOW, policy });
assert(unknownCategory.totalCents === 0 && unknownCategory.reasonCodes.includes("LINE_CATEGORY_AMBIGUOUS"),
  "An unrecognized category is ambiguous, not qualifying");
assert(!CATEGORY_TAXONOMY.qualifying.includes("TELEPORTER_REPAIR"), "Guard: the taxonomy really does not contain it");

// A card transaction with a merchant category and no itemization proves that
// money moved, not what it bought.
const merchantOnly = qualifyingShockTotal([
  shockLine({ purposeProof: null, financialProof: "CONNECTED_TRANSACTION" })
], { now: NOW, policy });
assert(merchantOnly.totalCents === 0 && merchantOnly.reasonCodes.includes("MERCHANT_CATEGORY_ALONE_INSUFFICIENT"),
  "A merchant line alone cannot establish purpose");

// Document-based determination is the primary path: the same shock qualifies
// with no transaction provider connected anywhere in the facts.
assert(evaluate(shockFacts([shockLine()]), policy, { now: NOW }).decision === "APPROVED",
  "An itemized invoice with a paid marker decides on its own, with no aggregator");

// ── 28. Determinism. ───────────────────────────────────────────────────
const determinismFacts = shockFacts(mixedInvoice);
const first = evaluate(determinismFacts, policy, { now: NOW });
const second = evaluate(JSON.parse(JSON.stringify(determinismFacts)), policy, { now: NOW });
assert(JSON.stringify(first) === JSON.stringify(second), "Same inputs and rule version must yield a byte-identical result");
assert(first.policyVersion === policy.version && first.engineVersion === policy.engineVersion, "The decision names the rules it was made under");
let threw = false;
try { evaluate(determinismFacts, policy, {}); } catch { threw = true; }
assert(threw, "The evaluator must refuse to read the clock for itself");

// Tamper and identity gates stop before any pathway runs.
const tampered = evaluate(baseFacts({
  benefit: benefitFacts.benefit,
  documents: [{ evidenceId: "evid_benefit", documentType: "BENEFIT_AWARD_LETTER", tamperRisk: "HIGH" }]
}), policy, { now: NOW });
assert(tampered.decision === "NOT_VERIFIED" && tampered.reasonCodes.includes("DOCUMENT_NOT_INDEPENDENTLY_VERIFIED"),
  "A document that may be altered is not evidence");
const unverifiedIdentity = evaluate({ ...benefitFacts, identity: { verified: false } }, policy, { now: NOW });
assert(unverifiedIdentity.reasonCodes.includes("IDENTITY_NOT_VERIFIED") && unverifiedIdentity.reasonCodes.length === 1,
  "Without a verified person nothing else is evaluated");

// Reduced earnings: a 30% drop qualifies, 20% does not, and a zero prior
// period is refused before the division rather than after it.
function reducedFacts(prior, current) {
  return baseFacts({
    employment: {
      reducedEarnings: {
        evidenceId: "evid_stub", documentType: "EMPLOYER_HOURS_REDUCTION_NOTICE", employeeName: "Sam Ortiz", employeeMatch: true,
        priorPeriodEarningsCents: prior, currentPeriodEarningsCents: current, comparedPeriods: 3,
        comparisonEndDate: daysAgo(10), extractionConfidence: 0.9
      }
    }
  });
}
assert(evaluate(reducedFacts(400_000, 280_000), policy, { now: NOW }).pathway === "REDUCED_EARNINGS", "A 30% cut in pay qualifies");
assert(evaluate(reducedFacts(400_000, 320_000), policy, { now: NOW }).reasonCodes.includes("REDUCED_EARNINGS:REDUCTION_BELOW_POLICY_MINIMUM"), "A 20% cut does not");
const zeroPrior = evaluate(reducedFacts(0, 0), policy, { now: NOW });
assert(zeroPrior.decision === "NOT_VERIFIED" && zeroPrior.reasonCodes.includes("REDUCED_EARNINGS:INSUFFICIENT_COMPARISON_BASIS"),
  "A zero prior period has no reduction to measure and never divides by zero");

/* ════════════════════════════ part two: providers ═════════════════════ */

const identityFixtures = { sessions: {} };
const documentFixtures = { documents: {} };
const identity = stubIdentityProvider(identityFixtures);

const embedded = await identity.createSession({ applicationId: "elig_demo", now: NOW });
assert(embedded.mode === "EMBEDDED" && typeof embedded.clientToken === "string" && embedded.hostedUrl === null,
  `The primary identity flow is embedded and returns a client token, not a URL: ${JSON.stringify(embedded)}`);
assert(embedded.supportedModes.includes("EMBEDDED") && embedded.supportedModes.includes("HOSTED"),
  "The session descriptor tells the client which flows this vendor supports");
const hosted = await identity.createSession({ applicationId: "elig_demo", mode: "HOSTED", returnUrl: "https://timi.example/book", now: NOW });
assert(hosted.mode === "HOSTED" && hosted.clientToken === null && hosted.hostedUrl.includes("return="),
  "The hosted redirect is the documented fallback and carries the return target");
let embedOnlyThrew = false;
try {
  await stubIdentityProvider({ supportedModes: ["EMBEDDED"] }).createSession({ applicationId: "elig_demo", mode: "HOSTED", now: NOW });
} catch (error) { embedOnlyThrew = error instanceof ProviderError; }
assert(embedOnlyThrew, "A provider that cannot run a mode must say so rather than improvise");

const stubSet = providers({});
assert(stubSet.mode === "STUB" && stubSet.transactions.available() === false,
  "With no credentials the factory returns stubs and no transaction provider");
const liveSet = providers({ PLAID_CLIENT_ID: "id", PLAID_SECRET: "secret" });
let adapterThrew = false;
try { await liveSet.transactions.findCorroboration({ applicationId: "x", amountCents: 1 }); } catch (error) { adapterThrew = error instanceof ProviderError; }
assert(liveSet.mode === "LIVE" && adapterThrew, "Configured credentials must never silently fall back to a fixture");
assert((await stubIncomeVerificationProvider({}).verifyIncome({ applicationId: "x" })).status === "INSUFFICIENT_INCOME_EVIDENCE",
  "Nothing connected is insufficient evidence, never zero income");
assert((await stubTransactionVerificationProvider({}).findCorroboration({ applicationId: "x", amountCents: 1 })).available === false,
  "Corroboration degrades to unavailable rather than failing");

/* ════════════════════════ part three: the application ═════════════════ */

const database = new DatabaseSync(":memory:");
// 0014 belongs to the fund migration, which lands separately; nothing in
// 0015 depends on it, and this list proves that.
for (const migration of [
  "0001_initial", "0002_seed", "0003_multi_offer_search", "0004_tenancy_admin", "0005_voice_calls",
  "0006_care_context", "0007_client_errors", "0008_payments_ledger", "0009_pets", "0010_provider_analytics",
  "0011_call_policy", "0012_pet_sex", "0013_pricing_and_ledger", "0015_hardship"
]) {
  database.exec(await readFile(`migrations/${migration}.sql`, "utf8"));
}

const env = { DB: new D1Mock(database), SIGN_IN_REQUIRED: "false" };
const providerSet = {
  mode: "STUB",
  identity,
  documents: stubDocumentExtractionProvider(documentFixtures),
  income: stubIncomeVerificationProvider({}),
  transactions: stubTransactionVerificationProvider({})
};

const jsonHeaders = { "content-type": "application/json" };
async function call(actor, path, { method = "GET", body, now = NOW } = {}) {
  const request = new Request(`https://timi.example${path}`, {
    method,
    headers: body ? jsonHeaders : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const response = await handleHardship(request, env, actor, new URL(request.url).pathname, method, { providerSet, now });
  return { response, body: await response.json() };
}

const maya = { userId: "user_maya" };
const dana = { userId: "user_dana" };

// A DRAFT application, then an embedded identity session, then evidence.
let result = await call(maya, "/api/hardship/applications", { method: "POST", body: { selectedPathway: "MEANS_TESTED_BENEFIT", householdSize: 3, householdAttested: true, termsVersion: "2026-01", attestationVersion: "2026-01" } });
assert(result.response.status === 201 && result.body.application.state === "DRAFT", `An application opens in DRAFT: ${JSON.stringify(result.body)}`);
const mayaApplication = result.body.application.id;

result = await call(maya, `/api/hardship/applications/${mayaApplication}/identity-session`, { method: "POST", body: {} });
assert(result.body.session.mode === "EMBEDDED" && result.body.session.clientToken, "The application's identity session embeds by default");
identityFixtures.sessions[result.body.session.sessionId] = { verified: true, uniquenessConfidence: "HIGH", identityKey: "idk_maya", status: "COMPLETED" };

documentFixtures.documents["private/maya/benefit.pdf"] = {
  documentType: "BENEFIT_AWARD_LETTER", issuer: "CalFresh", documentDate: daysAgo(12),
  extractionConfidence: 0.93, tamperRisk: "LOW",
  fields: { recipientName: "Maya Morgan", programCode: "SNAP", statusCurrent: true, recipientMatch: true }
};
result = await call(maya, `/api/hardship/applications/${mayaApplication}/evidence`, {
  method: "POST",
  body: { evidenceType: "BENEFIT_AWARD_LETTER", storageBucket: "hardship-evidence", storageObjectRef: "private/maya/benefit.pdf", contentSha256: "sha_benefit_1", mimeType: "application/pdf", byteSize: 20_481 }
});
assert(result.response.status === 201 && result.body.retentionDeadline, `Evidence stores a reference and a deletion date: ${JSON.stringify(result.body)}`);
const evidenceRow = database.prepare("SELECT * FROM eligibility_evidence WHERE application_id = ?").get(mayaApplication);
assert(evidenceRow.storage_object_ref === "private/maya/benefit.pdf" && evidenceRow.retention_deadline > NOW, "Retention deadline is set at upload");
assert(!Object.keys(evidenceRow).some((column) => /content|body|text|image/.test(column) && column !== "content_sha256"),
  "No column in eligibility_evidence could ever hold document content");

result = await call(maya, `/api/hardship/applications/${mayaApplication}/submit`, { method: "POST", body: {} });
assert(result.body.application.state === "APPROVED", `The benefit pathway approves through HTTP: ${JSON.stringify(result.body)}`);
assert(result.body.view.message === approvalCopy({ ownerFeeCents: 2000 }), `Approval copy: ${result.body.view.message}`);
assert(result.body.view.ownerFeeCents === 0, "An approved applicant owes no TímiNOW fee");

const mayaDecision = await latestDecision(env, mayaApplication);
assert(mayaDecision.decision === "APPROVED" && mayaDecision.pathway === "MEANS_TESTED_BENEFIT", "The decision row records the pathway");
assert(mayaDecision.reasonCodes.length > 0 && mayaDecision.policyVersion === policy.version, "…the rule version and the machine-readable reasons");
const grantRow = database.prepare("SELECT * FROM eligibility_grants WHERE application_id = ?").get(mayaApplication);
assert(grantRow.state === "ACTIVE" && grantRow.sponsored_visit_limit === 1 && grantRow.sponsored_visits_used === 0,
  "Approval issues a grant and moves no money");
assert(database.prepare("SELECT COUNT(*) AS c FROM audit_events WHERE subject_id = ?").get(mayaApplication).c >= 3,
  "Every state change is audited");
assert(database.prepare("SELECT COUNT(*) AS c FROM evidence_facts WHERE application_id = ?").get(mayaApplication).c > 0,
  "The normalized facts survive the documents");

// 30. Another account cannot read the application, its evidence, or its cause.
result = await call(dana, `/api/hardship/applications/${mayaApplication}`, {});
assert(result.response.status === 404, "An application belongs to whoever is signed in and nobody else");

// ── 29. The soft denial: exact copy, and nothing internal in the body. ──
const REQUIRED_DENIAL = "TímiNOW could not independently verify your hardship at this time. This booking will require our standard $20 fee. We know this isn't what you wanted to hear; if you feel we've made a mistake, email hardship@timinow.pet and we will have a human evaluate your case for future bookings.";
assert(softDenialCopy({ ownerFeeCents: 2000, supportEmail: "hardship@timinow.pet" }) === REQUIRED_DENIAL,
  `The soft denial must be the approved sentence exactly:\n${softDenialCopy({ ownerFeeCents: 2000, supportEmail: "hardship@timinow.pet" })}`);
assert(softDenialCopy({ ownerFeeCents: 2500, supportEmail: "hardship@timinow.pet" }).includes("standard $25 fee"),
  "The fee in the sentence comes from pricing, not from the string");

result = await call(dana, "/api/hardship/applications", { method: "POST", body: { selectedPathway: "FINANCIAL_SHOCK", householdSize: 2, householdAttested: true } });
const danaApplication = result.body.application.id;
result = await call(dana, `/api/hardship/applications/${danaApplication}/identity-session`, { method: "POST", body: {} });
identityFixtures.sessions[result.body.session.sessionId] = { verified: true, uniquenessConfidence: "HIGH", identityKey: "idk_dana", status: "COMPLETED" };

documentFixtures.documents["private/dana/repair.pdf"] = {
  documentType: "REPAIR_ORDER", issuer: "ABC Auto Service", documentDate: daysAgo(4),
  extractionConfidence: 0.9, tamperRisk: "LOW", fields: {},
  lineItems: [
    { id: "dana_line_1", normalizedCategory: "AUTOMOTIVE_SERVICES_UNSPECIFIED", amountCents: 220_000, purposeProof: "REPAIR_ORDER", financialProof: "PAID_INVOICE_MARKER", extractionConfidence: 0.9, dedupeHash: "sha_dana_line_1" }
  ]
};
// The shock pathway needs a verified household income to have a threshold at
// all, so the transcript goes up alongside the repair order.
documentFixtures.documents["private/dana/transcript.pdf"] = {
  documentType: "IRS_RETURN_TRANSCRIPT", issuer: "IRS", documentDate: daysAgo(90),
  extractionConfidence: 0.95, tamperRisk: "LOW",
  fields: { taxpayerName: "Dana Reyes", taxpayerMatch: true, status: "VERIFIED_INCOME", annualCents: 6_000_000, annualHouseholdIncomeCents: 6_000_000, householdSize: 2 }
};
await call(dana, `/api/hardship/applications/${danaApplication}/evidence`, {
  method: "POST",
  body: { evidenceType: "IRS_RETURN_TRANSCRIPT", storageBucket: "hardship-evidence", storageObjectRef: "private/dana/transcript.pdf", contentSha256: "sha_dana_transcript" }
});
await call(dana, `/api/hardship/applications/${danaApplication}/evidence`, {
  method: "POST",
  body: { evidenceType: "REPAIR_ORDER", storageBucket: "hardship-evidence", storageObjectRef: "private/dana/repair.pdf", contentSha256: "sha_dana_repair" }
});
result = await call(dana, `/api/hardship/applications/${danaApplication}/submit`, { method: "POST", body: {} });
assert(result.body.application.state === "NOT_VERIFIED", `An ambiguous invoice soft-fails: ${JSON.stringify(result.body)}`);
assert(result.body.view.message === REQUIRED_DENIAL, `The denial copy must be exact:\n${result.body.view.message}`);

const denialBody = JSON.stringify(result.body);
for (const leak of ["reasonCodes", "explanation", "tamperRisk", "fraud", "INSUFFICIENT_PURPOSE_EVIDENCE", "evidenceIds", "extractionConfidence", "AMBIGUOUS"]) {
  assert(!denialBody.includes(leak), `The applicant response leaked "${leak}": ${denialBody}`);
}
// The codes exist — they are simply not the applicant's to see.
const danaDecision = await latestDecision(env, danaApplication);
assert(danaDecision.reasonCodes.includes("FINANCIAL_SHOCK:INSUFFICIENT_PURPOSE_EVIDENCE"),
  `The internal record keeps the reasons: ${JSON.stringify(danaDecision.reasonCodes)}`);
const shockItem = database.prepare("SELECT * FROM financial_shock_items WHERE application_id = ?").get(danaApplication);
assert(shockItem.disposition === "AMBIGUOUS" && shockItem.qualifying_amount_cents === 0,
  `Every line is stored with its disposition: ${JSON.stringify(shockItem)}`);

// The appeal route the denial promises, and its careful promise.
result = await call(dana, `/api/hardship/applications/${danaApplication}/appeal`, { method: "POST", body: { contactEmail: "dana@example.com" } });
assert(result.response.status === 201 && result.body.message.includes("future bookings"), "An appeal is about future bookings");
assert(database.prepare("SELECT COUNT(*) AS c FROM human_appeals WHERE application_id = ?").get(danaApplication).c === 1, "The appeal is recorded for a human");

// ── A provider outage is a retry, never a finding. ─────────────────────
result = await call(dana, "/api/hardship/applications", { method: "POST", body: { selectedPathway: "RECENT_JOB_LOSS" } });
const retryApplication = result.body.application.id;
await call(dana, `/api/hardship/applications/${retryApplication}/evidence`, {
  method: "POST",
  body: { evidenceType: "EMPLOYER_TERMINATION_NOTICE", storageBucket: "hardship-evidence", storageObjectRef: "private/dana/missing.pdf", contentSha256: "sha_missing" }
});
result = await call(dana, `/api/hardship/applications/${retryApplication}/submit`, { method: "POST", body: {} });
assert(result.body.application.state === "TECHNICAL_RETRY", `An extraction failure is a retry: ${JSON.stringify(result.body)}`);
assert(result.body.view.status === "PENDING" && result.body.view.message === pendingCopy({ ownerFeeCents: 2000 }),
  "…and shows neutral pending language, never a denial");
assert(database.prepare("SELECT COUNT(*) AS c FROM eligibility_decisions WHERE application_id = ?").get(retryApplication).c === 0,
  "A vendor outage writes no decision");

// ── Document reuse raises a signal without accusing anybody. ───────────
await call(dana, `/api/hardship/applications/${retryApplication}/evidence`, {
  method: "POST",
  body: { evidenceType: "BENEFIT_AWARD_LETTER", storageBucket: "hardship-evidence", storageObjectRef: "private/maya/benefit.pdf", contentSha256: "sha_benefit_1" }
});
const signal = database.prepare("SELECT * FROM fraud_signals WHERE signal_type = 'DOCUMENT_REUSED_ACROSS_IDENTITIES'").get();
assert(signal && signal.severity === "MEDIUM", "The same document under two identities is a signal");
assert(!JSON.stringify(await (await call(dana, `/api/hardship/applications/${retryApplication}`, {})).body).includes("fraud"),
  "…and the applicant is told nothing about it");

// ── 31. A later adverse review never bills a sponsored owner. ──────────
const consumed = await recordSponsoredCompletion(env, { grantId: grantRow.id, userId: maya.userId, identityKey: "idk_maya", reservationId: "resv_demo", now: NOW });
assert(consumed.ok, "The grant is consumed on a completed connection");
database.prepare("UPDATE eligibility_grants SET state = 'REVOKED', revoked_at = ?, revoked_reason = ? WHERE id = ?")
  .run("2026-09-15T00:00:00.000Z", "adverse human review", grantRow.id);
const afterRevocation = database.prepare("SELECT * FROM eligibility_grants WHERE id = ?").get(grantRow.id);
assert(afterRevocation.sponsored_visits_used === 1 && afterRevocation.last_reservation_id === "resv_demo",
  "Revocation is prospective: the completed sponsored visit stands");
const hardshipSource = await readFile("src/hardship/index.js", "utf8");
for (const pattern of ["INSERT INTO payment", "UPDATE payment_", "INSERT INTO ledger", "UPDATE ledger_"]) {
  assert(!hardshipSource.includes(pattern), `The hardship module must never move money (${pattern})`);
}

// ── The rolling per-identity limit. ────────────────────────────────────
result = await call(maya, "/api/hardship/applications", { method: "POST", body: { selectedPathway: "MEANS_TESTED_BENEFIT", householdSize: 3, householdAttested: true } });
const secondMaya = result.body.application.id;
result = await call(maya, `/api/hardship/applications/${secondMaya}/identity-session`, { method: "POST", body: {} });
identityFixtures.sessions[result.body.session.sessionId] = { verified: true, uniquenessConfidence: "HIGH", identityKey: "idk_maya", status: "COMPLETED" };
documentFixtures.documents["private/maya/benefit-2.pdf"] = documentFixtures.documents["private/maya/benefit.pdf"];
await call(maya, `/api/hardship/applications/${secondMaya}/evidence`, {
  method: "POST",
  body: { evidenceType: "BENEFIT_AWARD_LETTER", storageBucket: "hardship-evidence", storageObjectRef: "private/maya/benefit-2.pdf", contentSha256: "sha_benefit_2" }
});
result = await call(maya, `/api/hardship/applications/${secondMaya}/submit`, { method: "POST", body: {} });
assert(result.body.application.state === "NOT_VERIFIED", "One sponsored completed connection per rolling 12 months");
assert(result.body.view.message === REQUIRED_DENIAL, "…delivered with the same soft copy, no accusation");
const limited = await latestDecision(env, secondMaya);
assert(limited.reasonCodes.includes("RATE_LIMIT_SPONSORED_CONNECTIONS_EXHAUSTED"), `The limit is recorded internally: ${JSON.stringify(limited.reasonCodes)}`);

// ── The fee in the copy really does follow pricing. ────────────────────
database.prepare("UPDATE pricing_policies SET owner_fee_cents = 2500 WHERE active = 1").run();
result = await call(dana, `/api/hardship/applications/${danaApplication}`, {});
assert(result.body.view.message.includes("standard $25 fee"), `The denial quotes the active price: ${result.body.view.message}`);
database.prepare("UPDATE pricing_policies SET owner_fee_cents = 2000 WHERE active = 1").run();

for (const table of ["eligibility_applications", "eligibility_evidence", "evidence_facts", "eligibility_decisions", "financial_shock_items", "eligibility_grants", "eligibility_rate_limits", "fraud_signals", "human_appeals"]) {
  assert(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count > 0, `${table} should contain end-to-end test data`);
}

database.close();
console.log("Hardship engine tests passed: continuous shock threshold with no bracket cliffs across every anchor, mixed invoice line-item taxonomy, 30-day aggregation with day-31 exclusion, ambiguity refused rather than guessed, verified zero income, no-income-detected and bank balance and disability alone all rejected, deterministic replay, embedded-first identity sessions, retryable provider failures, per-identity rolling limit, prospective revocation, and the exact soft-denial copy priced from the active policy.");
