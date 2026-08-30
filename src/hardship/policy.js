/**
 * The hardship rules, as data.
 *
 * Everything that decides whether TímiNOW covers somebody's fee lives in this
 * file as a frozen fixture with a version on it. Nothing in engine.js knows a
 * dollar amount, a percentage, a freshness window, or the name of a benefit
 * program; it knows how to read a policy. That separation is the whole point:
 * a decision made in March can be re-run in September against the policy it
 * was actually decided under, and it will produce the same answer.
 *
 * ────────────────────────────────────────────── what a policy may not do ──
 *
 * There is no score in here, no weighting, no probability, and no threshold
 * an AI model tunes. Documents may be read by machines — OCR extracts a date,
 * a classifier proposes a line-item category — but the decision is a lookup
 * against these tables and nothing else. A person who is refused is entitled
 * to be told which published rule they did not meet, and that is only
 * possible if the rules are published objects rather than a model's opinion.
 *
 * ───────────────────────────────────────────────────── on the two specs ──
 *
 * The Paw It Forward implementation spec and the Pets Fund engine spec differ
 * in one place that matters here: the second suggests a current means-tested
 * benefit should only corroborate other evidence, the first makes it a
 * standalone pathway with a six-month duration. Paw It Forward governs, so
 * MEANS_TESTED_BENEFIT stands on its own — but it is a pathway config like
 * any other, and setting `enabled: false` on it is a policy edit, not a code
 * change.
 */

/** Recursively freeze so a caller cannot quietly retune a rule at runtime. */
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * Line-item categories that count toward a financial shock.
 *
 * These are normalized codes produced by the extraction provider, not free
 * text from an invoice. A merchant name never appears here: "ABC Auto" is not
 * a category, and the whole reason line items exist is that the same shop
 * sells a transmission and a set of alloy wheels.
 */
const QUALIFYING_CATEGORIES = [
  // Medically necessary health and dental costs already incurred or owed.
  "MEDICAL_EMERGENCY_CARE",
  "MEDICAL_TREATMENT",
  "MEDICAL_HOSPITAL_STAY",
  "MEDICAL_PATIENT_RESPONSIBILITY",
  "DENTAL_NECESSARY_CARE",
  "PRESCRIPTION_MEDICATION",
  "DURABLE_MEDICAL_EQUIPMENT",
  // Vehicle work that restores ordinary safe transportation.
  "VEHICLE_TRANSMISSION_REPAIR",
  "VEHICLE_ENGINE_REPAIR",
  "VEHICLE_BRAKE_REPAIR",
  "VEHICLE_SUSPENSION_STEERING_REPAIR",
  "VEHICLE_SAFETY_TIRE_REPLACEMENT",
  "VEHICLE_TOWING_AFTER_BREAKDOWN",
  // Home repair that affects habitability or safety.
  "HOME_PLUMBING_EMERGENCY",
  "HOME_HEATING_OR_COOLING_FAILURE",
  "HOME_ELECTRICAL_HAZARD_REPAIR",
  "HOME_ROOF_OR_STRUCTURAL_URGENT",
  "HOME_WATER_DAMAGE_REMEDIATION",
  // Death, disaster, dependents, travel.
  "FUNERAL_OR_BURIAL",
  "DISASTER_LOSS_REPAIR_OR_REPLACEMENT",
  "URGENT_DEPENDENT_CARE",
  "EMERGENCY_TRAVEL_DEATH_OR_MEDICAL",
  // Veterinary money already spent is the most common shock in this program.
  "VETERINARY_INCURRED"
];

/**
 * Categories that never count, however large or however sincerely explained.
 *
 * An expense being real is not the question. The question is whether it was
 * unexpected and essential, and a vacation is neither.
 */
const EXCLUDED_CATEGORIES = [
  "LUXURY_GOODS",
  "DISCRETIONARY_RETAIL",
  "VACATION_OR_LEISURE_TRAVEL",
  "ENTERTAINMENT_OR_SUBSCRIPTION",
  "VEHICLE_COSMETIC_UPGRADE",
  "VEHICLE_PERFORMANCE_UPGRADE",
  "VEHICLE_DETAILING",
  "VEHICLE_ENTERTAINMENT_SYSTEM",
  "ELECTIVE_COSMETIC_PROCEDURE",
  "GAMBLING",
  "FINES_OR_PENALTIES",
  "ROUTINE_RECURRING_EXPENSE",
  "DEBT_PAYMENT",
  "INVESTMENT_PURCHASE"
];

/**
 * Codes the extractor emits when it read the line but could not establish its
 * purpose. Listed for documentation only — engine.js treats *anything* not on
 * the qualifying list as non-qualifying, and anything on neither list as
 * ambiguous. A category this file has never heard of can therefore never be
 * guessed into a qualifying total by a future extractor release.
 */
const AMBIGUOUS_CATEGORIES = [
  "AUTOMOTIVE_SERVICES_UNSPECIFIED",
  "GENERAL_MERCHANDISE",
  "PROFESSIONAL_SERVICES_UNSPECIFIED",
  "HOME_SERVICES_UNSPECIFIED",
  "MEDICAL_SERVICES_UNSPECIFIED",
  "OTHER",
  "UNKNOWN"
];

/**
 * The progressive shock curve, as anchors rather than brackets.
 *
 * Spec §9.4 states the curve as a table of income bands, which reads like a
 * step function and must not be built as one: a person earning $50,001 cannot
 * face a materially different bar than one earning $50,000. So the table is
 * stored as the anchor points it describes, and engine.js interpolates
 * linearly between them. Slope changes at an anchor; the value never jumps.
 *
 * Income and floors are in cents throughout, like every other amount in this
 * codebase.
 */
const SHOCK_PERCENT_ANCHORS = [
  [0, 0.02],           //        $0 — 2.0%
  [2_500_000, 0.02],   //   $25,000 — 2.0%, end of the flat opening band
  [5_000_000, 0.03],   //   $50,000 — 3.0%
  [7_500_000, 0.035],  //   $75,000 — 3.5%
  [10_000_000, 0.04],  //  $100,000 — 4.0%
  [15_000_000, 0.05]   //  $150,000 — 5.0%, flat above
];

/**
 * The dollar floor, also as anchors.
 *
 * Spec §9.4's last row reads "> $150,000 → $5,000 floor" while the row below
 * it puts $2,500 at the $150,000 anchor. Taken literally that is a $2,500
 * jump at $150,001 — precisely the cliff the same paragraph forbids, and the
 * one acceptance test 26 probes. It is resolved by ramping the floor from
 * $2,500 at $150,000 to the stated $5,000 at a terminal anchor, flat above,
 * so both numbers in the table are honored and the function stays continuous.
 *
 * The choice is also inert. The required shock is the *greater* of the floor
 * and income × percentage, and 2% of $12,500 is already $250 — so above about
 * $12,500 of income the percentage always wins and the floor never decides
 * anything. The engine test asserts exactly that, which is why the terminal
 * anchor can be a documented policy value rather than an argument.
 */
const SHOCK_FLOOR_ANCHORS = [
  [0, 25_000],          //        $0 — $250
  [2_500_000, 25_000],  //   $25,000 — $250
  [5_000_000, 50_000],  //   $50,000 — $500
  [7_500_000, 100_000], //   $75,000 — $1,000
  [10_000_000, 150_000],//  $100,000 — $1,500
  [15_000_000, 250_000],//  $150,000 — $2,500
  [25_000_000, 500_000] //  $250,000 — $5,000, the terminal floor, flat above
];

/**
 * v1 of the published rules.
 *
 * Every pathway carries the same shape so the admin surface can render them
 * generically and so adding a pathway is a fixture edit plus one evaluator.
 */
const HARDSHIP_POLICY_V1 = {
  id: "hardship_policy_v1",
  version: 1,
  /** Bumped when evaluator behavior changes, independently of the fixtures. */
  engineVersion: "hardship-engine-1",
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  currency: "usd",

  /**
   * Evaluation order. First pass wins and collection stops — the minimum
   * necessary evidence principle. Cheap, fast, single-document pathways come
   * before the ones that need income and an invoice set, so the common case
   * is over in one upload.
   */
  pathwayOrder: [
    "MEANS_TESTED_BENEFIT",
    "RECENT_JOB_LOSS",
    "UNEMPLOYMENT",
    "REDUCED_EARNINGS",
    "AREA_ADJUSTED_INCOME",
    "FINANCIAL_SHOCK"
  ],

  pathways: {
    /**
     * A current means-tested benefit. The means test was already performed by
     * a government agency; TímiNOW is not going to perform a better one.
     */
    MEANS_TESTED_BENEFIT: {
      id: "MEANS_TESTED_BENEFIT",
      label: "Government benefit",
      enabled: true,
      acceptedDocumentTypes: [
        "BENEFIT_AWARD_LETTER",
        "BENEFIT_STATUS_NOTICE",
        "SNAP_NOTICE_OF_ACTION",
        "TANF_AWARD_NOTICE",
        "SSI_AWARD_LETTER",
        "MEDICAID_ELIGIBILITY_NOTICE",
        "HOUSING_ASSISTANCE_AWARD"
      ],
      /**
       * Programs whose own eligibility rule is a means test. SSDI is
       * deliberately absent: it is earned by work history, not by means, and
       * treating it as a means test would be the disability-equals-eligible
       * rule both specs forbid.
       */
      acceptedPrograms: ["SNAP", "TANF", "SSI", "MEDICAID_MEANS_TESTED", "HOUSING_ASSISTANCE", "WIC", "LIHEAP"],
      requiredFields: ["recipientName", "issuer", "programCode", "statusCurrent", "documentDate"],
      freshnessWindowDays: 90,
      validityDays: 180,
      maxSponsoredVisits: 1,
      householdRequired: false,
      geographyRequired: false,
      extractionConfidenceFloor: 0.85,
      identityMatchRequired: true
    },

    /**
     * A termination or layoff notice. Short-lived on purpose: losing a job is
     * a shock, not a permanent state, and a notice from last spring says
     * nothing about this week.
     */
    RECENT_JOB_LOSS: {
      id: "RECENT_JOB_LOSS",
      label: "Recent job loss",
      enabled: true,
      acceptedDocumentTypes: ["EMPLOYER_TERMINATION_NOTICE", "LAYOFF_NOTICE", "SEPARATION_NOTICE", "WARN_NOTICE"],
      requiredFields: ["employeeName", "employerName", "effectiveDate", "separationType"],
      /** Effective date within 30 days. Day 30 passes; day 31 does not. */
      freshnessWindowDays: 30,
      validityDays: 30,
      maxSponsoredVisits: 1,
      householdRequired: false,
      geographyRequired: false,
      extractionConfidenceFloor: 0.8,
      identityMatchRequired: true,
      /** Voluntary resignation is not this pathway. Policy, not code. */
      acceptedSeparationTypes: ["INVOLUNTARY", "LAYOFF", "REDUCTION_IN_FORCE", "POSITION_ELIMINATED", "CONTRACT_ENDED"]
    },

    UNEMPLOYMENT: {
      id: "UNEMPLOYMENT",
      label: "Unemployment benefit",
      enabled: true,
      acceptedDocumentTypes: ["UNEMPLOYMENT_DETERMINATION", "UNEMPLOYMENT_AWARD_NOTICE", "UNEMPLOYMENT_PAYMENT_RECORD"],
      requiredFields: ["claimantName", "issuer", "determinationStatus", "documentDate"],
      freshnessWindowDays: 30,
      validityDays: 90,
      maxSponsoredVisits: 1,
      householdRequired: false,
      geographyRequired: false,
      extractionConfidenceFloor: 0.8,
      identityMatchRequired: true,
      acceptedDeterminationStatuses: ["APPROVED", "MONETARILY_ELIGIBLE", "PAYING", "ACTIVE_CLAIM"]
    },

    /**
     * Hours cut without a termination. The person still has a job, which is
     * exactly why no other pathway catches them.
     */
    REDUCED_EARNINGS: {
      id: "REDUCED_EARNINGS",
      label: "Reduced hours or pay",
      enabled: true,
      acceptedDocumentTypes: ["EMPLOYER_HOURS_REDUCTION_NOTICE", "PAY_STUB_SET", "PAYROLL_VERIFICATION"],
      requiredFields: ["employeeName", "priorPeriodEarningsCents", "currentPeriodEarningsCents", "comparisonEndDate"],
      freshnessWindowDays: 45,
      validityDays: 90,
      maxSponsoredVisits: 1,
      householdRequired: false,
      geographyRequired: false,
      extractionConfidenceFloor: 0.85,
      identityMatchRequired: true,
      /** A 30% drop, in policy where it can be retuned without a deploy. */
      minimumReductionRatio: 0.3,
      /** Fewer than this many compared periods is an anecdote, not a trend. */
      minimumComparedPeriods: 2
    },

    /**
     * Household income against an area-adjusted threshold. Never against the
     * federal poverty line alone — $40,000 in Fresno and $40,000 in San Jose
     * are not the same fact.
     */
    AREA_ADJUSTED_INCOME: {
      id: "AREA_ADJUSTED_INCOME",
      label: "Income or tax document",
      enabled: true,
      acceptedDocumentTypes: [
        "IRS_RETURN_TRANSCRIPT",
        "IRS_WAGE_AND_INCOME_TRANSCRIPT",
        "PAYROLL_PROVIDER_VERIFICATION",
        "PAY_STUB_SET",
        "SSA_BENEFIT_VERIFICATION"
      ],
      /**
       * A self-prepared return is a PDF anybody can edit. Allowed only when
       * the extractor returns a low tamper signal, and disallowed outright by
       * flipping this to false.
       */
      selfPreparedReturnAllowed: false,
      requiredFields: ["taxpayerName", "annualHouseholdIncomeCents", "documentDate", "householdSize"],
      freshnessWindowDays: 400,
      validityDays: 180,
      maxSponsoredVisits: 1,
      householdRequired: true,
      geographyRequired: true,
      extractionConfidenceFloor: 0.85,
      identityMatchRequired: true,
      /** Pay-stub evidence is current but thin; it expires sooner. */
      payStubValidityDays: 90
    },

    /**
     * A recent unexpected essential obligation, aggregated over 30 days.
     * The expensive pathway, last in order for that reason.
     */
    FINANCIAL_SHOCK: {
      id: "FINANCIAL_SHOCK",
      label: "Unexpected essential expense",
      enabled: true,
      acceptedDocumentTypes: [
        "ITEMIZED_INVOICE",
        "REPAIR_ORDER",
        "MEDICAL_BILL",
        "DENTAL_BILL",
        "EXPLANATION_OF_BENEFITS",
        "FUNERAL_INVOICE",
        "CONTRACTOR_INVOICE",
        "VETERINARY_INVOICE",
        "RECEIPT_ITEMIZED"
      ],
      requiredFields: ["issuer", "documentDate", "lineItems"],
      /** The rolling aggregation window. Day 30 counts; day 31 does not. */
      freshnessWindowDays: 30,
      validityDays: 30,
      maxSponsoredVisits: 1,
      householdRequired: true,
      geographyRequired: false,
      extractionConfidenceFloor: 0.85,
      identityMatchRequired: true
    }
  },

  /** The shock curve, its proofs, and its taxonomy. */
  financialShock: {
    aggregationWindowDays: 30,
    percentAnchors: SHOCK_PERCENT_ANCHORS,
    floorAnchors: SHOCK_FLOOR_ANCHORS,
    qualifyingCategories: QUALIFYING_CATEGORIES,
    excludedCategories: EXCLUDED_CATEGORIES,
    ambiguousCategories: AMBIGUOUS_CATEGORIES,
    /**
     * What establishes *purpose*. A bank line reading "AUTO REPAIR — $2,200"
     * establishes that money left; it does not establish whether it bought a
     * transmission or a set of rims.
     */
    acceptedPurposeProofs: ["ITEMIZED_INVOICE", "REPAIR_ORDER", "MEDICAL_BILL", "EOB_PATIENT_RESPONSIBILITY", "FUNERAL_INVOICE", "CONTRACTOR_INVOICE", "VETERINARY_INVOICE", "ITEMIZED_RECEIPT"],
    /**
     * What establishes that the money is genuinely owed or gone. A connected
     * transaction is one option among several — document-based determination
     * is the primary path and must work with no aggregator connected at all.
     */
    acceptedFinancialProofs: ["PAID_INVOICE_MARKER", "PAYMENT_REFERENCE", "BANK_OR_CARD_STATEMENT", "CONNECTED_TRANSACTION", "CURRENT_BALANCE_OWED"],
    /** Unpaid but genuine current obligations count, per spec §9.4 D. */
    unpaidObligationsAllowed: true,
    /** Tolerance when an invoice total and a payment record disagree slightly. */
    amountToleranceRatio: 0.05,
    minimumLineAmountCents: 100,
    /**
     * The hook for spec §9.4's "geographic/household adjustment after the
     * base calculation without discontinuous cliffs". Off in v1: the fairness
     * review that spec §10 requires before geography and household rules ship
     * has not happened, and shipping an invented multiplier ahead of it would
     * be exactly the unreviewed proxy that review exists to catch. When it is
     * enabled the factor is clamped and applied multiplicatively, which keeps
     * the composed function continuous.
     */
    thresholdAdjustment: { enabled: false, factorMin: 0.75, factorMax: 1.25 }
  },

  /**
   * The area-adjusted income threshold.
   *
   * The area index is not computed here — it comes in as a normalized fact
   * carrying the published dataset's id and release, so a decision can be
   * re-derived years later against the same data. The clamp exists because
   * cost indexes have outliers and an unclamped multiplier eventually
   * qualifies somebody in Manhattan earning six figures.
   */
  areaAdjustedIncome: {
    datasetId: "us-area-median-income",
    baselineFirstPersonCents: 3_200_000,
    additionalPersonCents: 1_120_000,
    areaIndexMin: 0.85,
    areaIndexMax: 1.6,
    /** Household sizes above this stop adding, per the usual HUD convention. */
    maxCountedHouseholdSize: 8
  },

  /**
   * Anti-abuse limits that the rules themselves enforce. Everything here is a
   * count over completed connections, not a judgement about a person.
   */
  rateLimit: {
    sponsoredConnectionsPerWindow: 1,
    windowDays: 365,
    /** A second application while one is live is a duplicate, not fraud. */
    concurrentApplicationsAllowed: 1
  },

  /** Extraction signals that stop a decision before any pathway runs. */
  evidenceGates: {
    rejectTamperRisk: ["HIGH"],
    /** MEDIUM tamper risk on a self-prepared document is treated as HIGH. */
    escalateMediumTamperRiskFor: ["SELF_PREPARED_TAX_RETURN", "PAY_STUB_SET"],
    identityUniquenessRequired: true,
    acceptedIdentityConfidence: ["HIGH", "MEDIUM"]
  },

  /** Retention, in days, for the evidence pipeline. Enforced by a job. */
  retention: {
    rawEvidenceDays: 30,
    normalizedFactsDays: 400,
    decisionRecordDays: 2555
  },

  /** Copy anchors. The denial sentence itself is assembled in index.js. */
  support: {
    hardshipEmail: "hardship@timinow.pet"
  }
};

/** Every published policy, keyed by version. Old versions are never edited. */
export const POLICY_VERSIONS = deepFreeze({
  1: HARDSHIP_POLICY_V1,
  hardship_policy_v1: HARDSHIP_POLICY_V1
});

/** The version a new application is decided under. */
export const ACTIVE_POLICY_VERSION = 1;

/**
 * The policy in force.
 *
 * Takes an optional version so a replay, an appeal, or an audit can ask for
 * the rules a specific decision was made under rather than today's.
 */
export function activePolicy(version = ACTIVE_POLICY_VERSION) {
  const policy = POLICY_VERSIONS[version];
  if (!policy) throw new Error(`Unknown hardship policy version "${version}".`);
  return policy;
}

/** Exported for the admin surface and for tests that assert the taxonomy. */
export const CATEGORY_TAXONOMY = deepFreeze({
  qualifying: QUALIFYING_CATEGORIES,
  excluded: EXCLUDED_CATEGORIES,
  ambiguous: AMBIGUOUS_CATEGORIES
});
