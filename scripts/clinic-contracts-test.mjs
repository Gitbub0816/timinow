/**
 * The clinic agreement, authorized representatives, and the founding
 * lifecycle.
 *
 * Covers addendum acceptance tests 30–35 —
 *
 *   30. a Founding Clinic is never billed the default $25;
 *   31. temporary inactivity preserves status;
 *   32. an ordinary management change preserves status;
 *   33. voluntary separation + same-entity rejoin restores the waiver;
 *   34. termination for Cause does not automatically restore status;
 *   35. a new legal entity does not automatically inherit status
 *
 * — plus the three properties that make the rest of it trustworthy: an
 * Authorized Representative cannot surrender founding status or amend the
 * agreement, missed calls do not separate a clinic, and the founding history
 * is append-only.
 *
 * Same harness as scripts/clinic-billing-test.mjs: the real migrations
 * applied to an in-memory SQLite database behind a D1-shaped mock, so the SQL
 * and the CHECK constraints under test are the ones that ship.
 */

import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import { activePricingPolicy, clinicFeeFor } from "../src/pricing.js";
import {
  addAuthorizedRepresentative,
  amendContract,
  canAuthorize,
  clinicContractProfile,
  clinicLifecycle,
  completeWindDown,
  CONTRACTING_ENTITY,
  endAuthorizedRepresentative,
  foundingStatus,
  getContract,
  grantFounding,
  listContracts,
  listAuthorizedRepresentatives,
  listFoundingHistory,
  listManagementEvents,
  listSeparationEvents,
  noteMissedCalls,
  preserveFoundingForSuccessor,
  recordContract,
  recordManagementEvent,
  requestRejoin,
  restoreFoundingOnRejoin,
  revokeFoundingForCause,
  separateClinic,
  setFoundingStatus,
  setLifecycleStatus,
  surrenderFounding,
  survivingObligations
} from "../src/clinic-contracts.js";

/* ------------------------------------------------------------ harness --- */

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

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
}

function assertRefused(result, code, message) {
  assert(result && result.ok === false, `${message} (the call succeeded instead)`);
  assert(result.code === code, `${message} — expected ${code}, got ${result.code}: ${result.message}`);
}

const MIGRATIONS = [
  "0001_initial.sql", "0002_seed.sql", "0003_multi_offer_search.sql", "0004_tenancy_admin.sql",
  "0005_voice_calls.sql", "0006_care_context.sql", "0007_client_errors.sql", "0008_payments_ledger.sql",
  "0009_pets.sql", "0010_provider_analytics.sql", "0011_call_policy.sql", "0012_pet_sex.sql",
  "0013_pricing_and_ledger.sql", "0014_fund.sql", "0015_hardship.sql",
  "0016_clinic_billing_and_aliases.sql", "0017_clinic_contracts_lifecycle.sql"
];

const database = new DatabaseSync(":memory:");
for (const migration of MIGRATIONS) {
  database.exec(await readFile(`migrations/${migration}`, "utf8"));
}

const env = { DB: new D1Mock(database) };

function exec(sql, ...values) {
  return database.prepare(sql).run(...values);
}

/* --------------------------------------------------------- fixtures ----- */

const CLINICS = [
  { tenantId: "ten_founding", locationId: "loc_founding", name: "Cedar Hollow Animal Hospital", slug: "t-cedar-hollow" },
  { tenantId: "ten_standard", locationId: "loc_standard", name: "Bayview Veterinary Emergency", slug: "t-bayview" },
  { tenantId: "ten_cause", locationId: "loc_cause", name: "Marsh Lane Veterinary", slug: "t-marsh-lane" },
  { tenantId: "ten_breach", locationId: "loc_breach", name: "Kestrel Animal Care", slug: "t-kestrel" },
  { tenantId: "ten_seller", locationId: "loc_seller", name: "Alder Creek Veterinary Clinic", slug: "t-alder-creek" },
  { tenantId: "ten_successor", locationId: "loc_successor", name: "Alder Creek Veterinary Group, PC", slug: "t-alder-creek-group" },
  { tenantId: "ten_quiet", locationId: "loc_quiet", name: "Harborlight Animal Hospital", slug: "t-harborlight" },
  { tenantId: "ten_winddown", locationId: "loc_winddown", name: "Foxglove Veterinary Hospital", slug: "t-foxglove" }
];

for (const clinic of CLINICS) {
  exec("INSERT INTO tenants (id, name, slug) VALUES (?, ?, ?)", clinic.tenantId, clinic.name, clinic.slug);
  exec(`
    INSERT INTO locations (id, tenant_id, name, slug, kind, address_line1, city, region, postal_code, phone, latitude, longitude)
    VALUES (?, ?, ?, ?, 'emergency', '1200 Shoreline Drive', 'Berkeley', 'CA', '94710', '(510) 555-0188', 37.87, -122.29)
  `, clinic.locationId, clinic.tenantId, clinic.name, clinic.slug);
}

function seedIntake(id, locationId, tenantId, status = "accepted") {
  const now = new Date().toISOString();
  exec(`
    INSERT INTO intake_requests (
      id, public_code, location_id, tenant_id, pet_name, species, owner_name, owner_phone,
      concern_category, concern_summary, urgency, status, requested_at, request_expires_at
    ) VALUES (?, ?, ?, ?, 'Otis', 'dog', 'Maya Morgan', '(510) 555-0147', 'illness_or_injury', 'Vomiting', 'urgent', ?, ?, ?)
  `, id, id.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(-10), locationId, tenantId, status, now, now);
}

function contractFor(tenantId, legalName, version = "2026.1") {
  return {
    tenantId,
    clinicLegalName: legalName,
    clinicDba: legalName.replace(/,? (LLC|PC|Inc\.?)$/i, ""),
    entityType: "Professional Corporation",
    stateOfOrganization: "CA",
    agreementVersion: version,
    agreementDocumentId: `doc_agreement_${tenantId}_${version}`,
    esignEnvelopeId: `env_${tenantId}`,
    esignAuditTrailId: `trail_${tenantId}`,
    authorizedSignerName: "Dr. Priya Raman",
    authorizedSignerTitle: "Owner",
    authorizedSignerEmail: `owner@${tenantId}.example`,
    effectiveDate: "2026-01-15",
    status: "EXECUTED",
    legalNoticeEmail: `legal@${tenantId}.example`,
    billingContactName: "Sam Ortiz",
    billingContactEmail: `billing@${tenantId}.example`,
    depositElection: "ACCEPT_PIF_GUARANTEE",
    participatingLocations: [{ locationId: `loc_${tenantId.replace("ten_", "")}`, name: legalName, city: "Berkeley", region: "CA" }],
    actorId: "admin_dana"
  };
}

const pricing = await activePricingPolicy(env);
const STANDARD_FEE_CENTS = pricing.clinicFeeCents;
assert(STANDARD_FEE_CENTS === 2500, `The seeded standard clinic fee should be $25, found ${STANDARD_FEE_CENTS}.`);

/* ═════════════════════════════════════════ the agreement names ClearKey ═══ */

{
  const recorded = await recordContract(env, contractFor("ten_founding", "Cedar Hollow Animal Hospital, PC"));
  assert(recorded.ok, `Recording the agreement failed: ${recorded.code} ${recorded.message}`);
  assert(
    recorded.contract.contractingEntity === "ClearKey Solutions, LLC",
    "The agreement is with ClearKey Solutions, LLC — TímiNOW is its product, not a party."
  );
  assert(recorded.contract.productName === "TímiNOW", "The product name travels with the contract row.");
  assert(CONTRACTING_ENTITY === "ClearKey Solutions, LLC", "The exported contracting entity must be ClearKey.");
  assert(recorded.contract.status === "EXECUTED", "An executed agreement is recorded as EXECUTED.");
  assert(
    recorded.contract.participatingLocations.length === 1,
    "Participating locations are a schedule to the contract and are stored with it."
  );
  // §33: the e-sign workflow must capture the mandatory Section 15 election.
  assertRefused(
    await recordContract(env, { ...contractFor("ten_standard", "Bayview Veterinary Emergency, Inc."), depositElection: null }),
    "DEPOSIT_ELECTION_REQUIRED",
    "An executed agreement without a Section 15 deposit election must be refused."
  );
  // A DBA is not the contracting party.
  assertRefused(
    await recordContract(env, { ...contractFor("ten_standard", ""), agreementVersion: "2026.2" }),
    "LEGAL_NAME_REQUIRED",
    "An agreement without a contracting legal name must be refused."
  );

  const lifecycle = await clinicLifecycle(env, "ten_founding");
  assert(
    lifecycle.status === "PENDING_ONBOARDING",
    `Execution is not readiness; the clinic should be PENDING_ONBOARDING, found ${lifecycle.status}.`
  );
  assert(lifecycle.activeForReferrals === false, "A clinic that has not onboarded takes no referrals.");
}

await recordContract(env, contractFor("ten_standard", "Bayview Veterinary Emergency, Inc."));
await setLifecycleStatus(env, { tenantId: "ten_founding", status: "ACTIVE", reason: "Onboarding complete.", actorId: "admin_dana" });
await setLifecycleStatus(env, { tenantId: "ten_standard", status: "ACTIVE", reason: "Onboarding complete.", actorId: "admin_dana" });

/* ══════════════════════════════ authorized representatives (§2, §12) ══════ */

const ordinaryRep = await addAuthorizedRepresentative(env, {
  tenantId: "ten_founding",
  name: "Jordan Lee",
  title: "Practice Manager",
  email: "Jordan.Lee@Cedar-Hollow.example",
  phone: "(510) 555-0130",
  role: "AUTHORIZED_REPRESENTATIVE",
  actorId: "admin_dana"
});
assert(ordinaryRep.ok, `Designating a representative failed: ${ordinaryRep.code}`);
assert(ordinaryRep.representative.email === "jordan.lee@cedar-hollow.example", "Representative emails are normalized for lookup.");
assert(ordinaryRep.representative.authorityScope === "ROUTINE", "A representative is ROUTINE unless actual authority is documented.");

// Actual authority to bind must point at the writing that grants it (§2).
assertRefused(
  await addAuthorizedRepresentative(env, {
    tenantId: "ten_founding", name: "Dr. Priya Raman", email: "owner@ten_founding.example",
    role: "AUTHORIZED_SIGNER", authorityScope: "ACTUAL_AUTHORITY_TO_BIND", actorId: "admin_dana"
  }),
  "AUTHORITY_DOCUMENT_REQUIRED",
  "Actual authority to bind must cite the writing that grants it."
);

const signer = await addAuthorizedRepresentative(env, {
  tenantId: "ten_founding", name: "Dr. Priya Raman", title: "Owner",
  email: "owner@ten_founding.example", role: "AUTHORIZED_SIGNER",
  authorityScope: "ACTUAL_AUTHORITY_TO_BIND", authoritySourceDocumentId: "doc_member_resolution_2026",
  actorId: "admin_dana"
});
assert(signer.ok, `Designating the signer failed: ${signer.code}`);

/* --- an ordinary representative may run the practice's day to day --------- */

for (const action of ["AVAILABILITY", "DEPOSIT_CONFIGURATION", "PAYMENT_METHOD", "NOTIFICATIONS", "USERS", "CONTACTS", "TEMPORARY_DEACTIVATION"]) {
  const decision = await canAuthorize(env, "ten_founding", "jordan.lee@cedar-hollow.example", action);
  assert(decision.allowed, `A representative may handle ${action} under §2; refused with ${decision.code}.`);
}
{
  const deposits = await canAuthorize(env, "ten_founding", "jordan.lee@cedar-hollow.example", "DEPOSIT_CONFIGURATION");
  assert(
    deposits.bounded && deposits.requiresSourceDocument,
    "Deposit configuration is routine but bounded — §12 requires it to stay within contractual bounds and cite a source."
  );
}

/* --- and may not do any of the things §2 reserves ------------------------- */

for (const action of ["AMEND_CONTRACT", "SURRENDER_FOUNDING_STATUS", "TRANSFER_OWNERSHIP", "MATERIAL_PRICING_CHANGE", "WAIVE_MATERIAL_CLAIM", "TERMINATE_AGREEMENT"]) {
  const decision = await canAuthorize(env, "ten_founding", "jordan.lee@cedar-hollow.example", action);
  assert(!decision.allowed, `An ordinary representative must not be able to ${action}.`);
  assert(decision.code === "ACTUAL_AUTHORITY_REQUIRED", `Refusing ${action} must cite the missing actual authority, got ${decision.code}.`);
  assert(decision.reserved === true, `${action} is a reserved action.`);
}
{
  const stranger = await canAuthorize(env, "ten_founding", "front.desk@cedar-hollow.example", "AVAILABILITY");
  assert(!stranger.allowed && stranger.code === "NOT_AN_AUTHORIZED_REPRESENTATIVE", "Somebody who is not a representative is not one.");
  const bound = await canAuthorize(env, "ten_founding", "owner@ten_founding.example", "AMEND_CONTRACT");
  assert(bound.allowed && bound.code === "ACTUAL_AUTHORITY_ON_FILE", "A signer with documented authority may amend.");
}

/* ═══════════════════════════════ 30. a Founding Clinic never pays $25 ══════ */

{
  const before = await clinicFeeFor(env, "ten_founding");
  assert(before.feeCents === STANDARD_FEE_CENTS, "Before designation, a clinic pays the standard fee.");

  assertRefused(
    await grantFounding(env, { tenantId: "ten_founding", actorId: "admin_dana" }),
    "SOURCE_DOCUMENT_REQUIRED",
    "Founding status is an express written designation; it needs a document."
  );

  const granted = await grantFounding(env, {
    tenantId: "ten_founding",
    sourceDocumentId: "doc_founding_letter_cedar_hollow",
    contractId: (await getContract(env, "ten_founding")).id,
    reason: "Founding cohort designation.",
    actorId: "admin_dana"
  });
  assert(granted.ok, `Granting founding status failed: ${granted.code} ${granted.message}`);

  const fee = await clinicFeeFor(env, "ten_founding");
  assert(fee.feeCents === 0, `Acceptance test 30: a Founding Clinic pays $0, found ${fee.feeCents}.`);
  assert(fee.plan === "FOUNDING", "The fee resolves through the FOUNDING plan.");
  assert(fee.reason === "FOUNDING_CLINIC_RATE", "A $0 fee explains itself.");
  assert(
    fee.feeCents !== STANDARD_FEE_CENTS,
    "Acceptance test 30: the default $25 must never be the applicable fee for a Founding Clinic."
  );

  const standard = await clinicFeeFor(env, "ten_standard");
  assert(standard.feeCents === STANDARD_FEE_CENTS, "A standard clinic still pays $25 — the waiver is not global.");

  const founding = await foundingStatus(env, "ten_founding");
  assert(founding.status === "ACTIVE", "Founding status is ACTIVE after designation.");
  assert(founding.sourceDocumentId === "doc_founding_letter_cedar_hollow", "The designation points at its document.");
  assert(founding.rejoinEligible === true, "A founding clinic in good standing is rejoin-eligible.");
}

/* ═════════════════════════ 31. temporary inactivity preserves status ══════ */

{
  const inactive = await setFoundingStatus(env, {
    tenantId: "ten_founding",
    status: "TEMPORARILY_INACTIVE",
    reason: "Closed six weeks for a surgical suite renovation.",
    actorId: "admin_dana"
  });
  assert(inactive.ok, `Marking the clinic temporarily inactive failed: ${inactive.code}`);
  assert(inactive.founding.status === "TEMPORARILY_INACTIVE", "The status records the pause.");
  assert(inactive.founding.plan === "FOUNDING", "Acceptance test 31: the FOUNDING plan survives a temporary pause.");
  assert(
    inactive.fee.feeCents === 0,
    `Acceptance test 31: a renovation must not convert the waiver into a $25 fee, found ${inactive.fee.feeCents}.`
  );

  // The same is true of the lifecycle side: still contracted, no referrals.
  const paused = await setLifecycleStatus(env, {
    tenantId: "ten_founding", status: "TEMPORARILY_INACTIVE",
    reason: "Renovation.", actorId: "admin_dana"
  });
  assert(paused.ok && paused.lifecycle.status === "TEMPORARILY_INACTIVE", "TEMPORARILY_INACTIVE is a first-class lifecycle state.");
  assert(paused.lifecycle.activeForReferrals === false, "A paused clinic receives no referrals.");
  assert((await getContract(env, "ten_founding")).status === "EXECUTED", "The agreement continues through a pause.");
  assert((await clinicFeeFor(env, "ten_founding")).feeCents === 0, "And the waiver continues with it.");

  const resumed = await setFoundingStatus(env, { tenantId: "ten_founding", status: "ACTIVE", reason: "Reopened.", actorId: "admin_dana" });
  assert(resumed.ok && resumed.founding.status === "ACTIVE", "The clinic comes back to ACTIVE founding status.");
  await setLifecycleStatus(env, { tenantId: "ten_founding", status: "ACTIVE", reason: "Reopened.", actorId: "admin_dana" });

  // Revocation may never be dressed up as one of these circumstances (§9).
  for (const reason of ["INACTIVITY", "RENOVATION", "STAFFING_SHORTAGE", "SEASONAL_PAUSE", "ORDINARY_MANAGEMENT_CHANGE", "MISSED_CALLS"]) {
    assertRefused(
      await revokeFoundingForCause(env, { tenantId: "ten_founding", causeCategory: "UNCURED_MATERIAL_BREACH", reason, actorId: "admin_dana" }),
      "NOT_A_FORFEITING_CIRCUMSTANCE",
      `"${reason}" is not grounds to revoke founding status.`
    );
  }
  // And "for cause" is a closed list.
  assertRefused(
    await revokeFoundingForCause(env, { tenantId: "ten_founding", causeCategory: "SLOW_TO_ANSWER", reason: "They were slow.", actorId: "admin_dana" }),
    "INVALID_CAUSE",
    "Cause is limited to the categories the agreement enumerates."
  );
  assertRefused(
    await setFoundingStatus(env, { tenantId: "ten_founding", status: "REVOKED_FOR_CAUSE", reason: "x", actorId: "admin_dana" }),
    "CAUSE_REQUIRED",
    "Revocation cannot be reached through an ordinary status change."
  );
}

/* ═══════════════════ 32. an ordinary management change preserves status ═══ */

{
  const foundingBefore = await foundingStatus(env, "ten_founding");
  const feeBefore = await clinicFeeFor(env, "ten_founding");
  const lifecycleBefore = await clinicLifecycle(env, "ten_founding");

  const changes = [
    { eventType: "ADMINISTRATOR", oldValue: "Jordan Lee", newValue: "Alex Nakamura" },
    { eventType: "MEDICAL_DIRECTOR", oldValue: "Dr. Ellis", newValue: "Dr. Ferreira" },
    { eventType: "MANAGEMENT_COMPANY", oldValue: "None", newValue: "Northbay Practice Services" },
    { eventType: "BILLING", oldValue: "billing@old.example", newValue: "ap@cedar-hollow.example" }
  ];
  for (const change of changes) {
    const recorded = await recordManagementEvent(env, {
      tenantId: "ten_founding", ...change, noticeReceivedAt: "2026-03-02", actorId: "admin_dana"
    });
    assert(recorded.ok, `Recording a ${change.eventType} change failed: ${recorded.code}`);
    assert(recorded.agreementContinues === true, `Acceptance test 32: a ${change.eventType} change does not terminate the agreement (§3).`);
    assert(recorded.foundingStatusUnchanged === true, `Acceptance test 32: a ${change.eventType} change does not forfeit founding status (§9).`);
    assert(recorded.requiresSuccessorReview === false, `A ${change.eventType} change is turnover, not a change of contracting entity.`);
    assert(recorded.event.changesContractingEntity === false, `A ${change.eventType} change leaves the contracting entity alone.`);
  }

  const foundingAfter = await foundingStatus(env, "ten_founding");
  const feeAfter = await clinicFeeFor(env, "ten_founding");
  assert(foundingAfter.status === foundingBefore.status, "Acceptance test 32: founding status is untouched by turnover.");
  assert(feeAfter.feeCents === 0 && feeAfter.feeCents === feeBefore.feeCents, "Acceptance test 32: the waiver is untouched by turnover.");
  assert((await clinicLifecycle(env, "ten_founding")).status === lifecycleBefore.status, "Turnover does not move the lifecycle either.");
  assert((await getContract(env, "ten_founding")).status === "EXECUTED", "The agreement is still in force after four personnel changes.");
  assert((await listManagementEvents(env, "ten_founding")).length >= 4, "Every change is on the record (§12).");

  // A legal-entity change is recorded the same way, forfeits nothing on its
  // own, and is flagged for the §30/§9 successor question instead.
  const entity = await recordManagementEvent(env, {
    tenantId: "ten_founding", eventType: "LEGAL_ENTITY",
    oldValue: "Cedar Hollow Animal Hospital, PC", newValue: "Cedar Hollow Veterinary Group, PC",
    note: "Reorganization under review.", actorId: "admin_dana"
  });
  assert(entity.ok, "A legal-entity change is recordable.");
  assert(entity.requiresSuccessorReview === true, "A legal-entity change raises the successor question (§3, §30).");
  assert(entity.foundingStatusUnchanged === true, "Recording an entity change does not itself forfeit founding status.");
  assert((await clinicFeeFor(env, "ten_founding")).feeCents === 0, "Nor does it silently reprice the clinic.");
}

/* --------------- a representative's own history is never overwritten ------ */

{
  const replacement = await addAuthorizedRepresentative(env, {
    tenantId: "ten_founding", name: "Alex Nakamura", title: "Practice Manager",
    email: "alex.nakamura@cedar-hollow.example",
    replacesRepresentativeId: ordinaryRep.representative.id,
    actorId: "admin_dana", reason: "Practice manager change."
  });
  assert(replacement.ok, `Replacing the representative failed: ${replacement.code}`);

  const current = await listAuthorizedRepresentatives(env, "ten_founding");
  const history = await listAuthorizedRepresentatives(env, "ten_founding", { includeHistory: true });
  assert(!current.some((rep) => rep.id === ordinaryRep.representative.id), "The former representative is no longer current.");
  const former = history.find((rep) => rep.id === ordinaryRep.representative.id);
  assert(Boolean(former), "The former representative is still on the record — history is never deleted.");
  assert(former.active === false && Boolean(former.validTo), "A closed representative row carries the date its authority ended.");
  assert(former.name === "Jordan Lee", "And still carries the name it always had.");
  assert(history.length > current.length, "The historical view is strictly larger than the current one.");

  // The old representative's authority is genuinely gone.
  const stale = await canAuthorize(env, "ten_founding", "jordan.lee@cedar-hollow.example", "AVAILABILITY");
  assert(!stale.allowed && stale.code === "NOT_AN_AUTHORIZED_REPRESENTATIVE", "A departed manager cannot still configure the account.");

  // §3 wants the change tracked as an event, not just as a new row.
  const events = await listManagementEvents(env, "ten_founding");
  assert(
    events.some((event) => event.eventType === "AUTHORIZED_REPRESENTATIVE" && event.newValue.includes("alex.nakamura")),
    "Replacing a representative records a management event."
  );

  // Closing a representative without naming a successor keeps the row too.
  const billing = await addAuthorizedRepresentative(env, {
    tenantId: "ten_standard", name: "Rosa Villalobos", title: "Billing Coordinator",
    email: "rosa@bayview.example", role: "BILLING_CONTACT", actorId: "admin_dana"
  });
  assert(billing.ok, `Designating a billing contact failed: ${billing.code}`);
  const ended = await endAuthorizedRepresentative(env, {
    tenantId: "ten_standard", representativeId: billing.representative.id,
    endReason: "DEPARTED", actorId: "admin_dana"
  });
  assert(ended.ok && ended.representative.active === false, "A departed contact is closed out, not deleted.");
  assert(Boolean(ended.representative.validTo), "With the date their authority ended.");
  assert(
    (await listAuthorizedRepresentatives(env, "ten_standard", { includeHistory: true }))
      .some((rep) => rep.id === billing.representative.id),
    "And still visible in the history."
  );
  const reEnded = await endAuthorizedRepresentative(env, {
    tenantId: "ten_standard", representativeId: billing.representative.id, actorId: "admin_dana"
  });
  assert(reEnded.ok && reEnded.alreadyClosed === true, "Closing an already-closed row is a no-op, not a second edit.");
}

/* ═════════ a representative cannot surrender founding status or amend ═════ */

{
  const surrender = await surrenderFounding(env, {
    tenantId: "ten_founding",
    requestedByEmail: "alex.nakamura@cedar-hollow.example",
    sourceDocumentId: "doc_email_from_the_manager",
    reason: "The manager said it was fine.",
    actorId: "admin_dana"
  });
  assertRefused(surrender, "ACTUAL_AUTHORITY_REQUIRED", "An Authorized Representative must not be able to surrender the founding waiver.");
  assert((await foundingStatus(env, "ten_founding")).status === "ACTIVE", "And the waiver is still there afterwards.");
  assert((await clinicFeeFor(env, "ten_founding")).feeCents === 0, "And the clinic is still not being billed $25.");

  const amendment = await amendContract(env, {
    tenantId: "ten_founding",
    requestedByEmail: "alex.nakamura@cedar-hollow.example",
    clinicLegalName: "Cedar Hollow Animal Hospital, PC",
    agreementVersion: "2026.9",
    agreementDocumentId: "doc_amendment_2026_9",
    depositElection: "CUSTOMER_FUNDED_DEPOSIT",
    actorId: "admin_dana"
  });
  assertRefused(amendment, "ACTUAL_AUTHORITY_REQUIRED", "An Authorized Representative must not be able to amend the agreement.");
  assert((await getContract(env, "ten_founding")).agreementVersion === "2026.1", "And the agreement in force is unchanged.");

  // §29: an amendment must be a writing, even from someone who can bind.
  assertRefused(
    await amendContract(env, {
      tenantId: "ten_founding", requestedByEmail: "owner@ten_founding.example",
      clinicLegalName: "Cedar Hollow Animal Hospital, PC", agreementVersion: "2026.9",
      depositElection: "CUSTOMER_FUNDED_DEPOSIT", actorId: "admin_dana"
    }),
    "AMENDMENT_DOCUMENT_REQUIRED",
    "An oral amendment is not an amendment."
  );
}

/* ══════════════════════════ missed calls do not separate a clinic ═════════ */

{
  await recordContract(env, contractFor("ten_quiet", "Harborlight Animal Hospital, PC"));
  await setLifecycleStatus(env, { tenantId: "ten_quiet", status: "ACTIVE", reason: "Onboarded.", actorId: "admin_dana" });
  await grantFounding(env, { tenantId: "ten_quiet", sourceDocumentId: "doc_founding_letter_harborlight", actorId: "admin_dana" });

  const before = await clinicLifecycle(env, "ten_quiet");
  for (let call = 0; call < 6; call += 1) {
    const noted = await noteMissedCalls(env, { tenantId: "ten_quiet", missedCount: 1, windowDescription: "Sunday overnight" });
    assert(noted.ok, "Recording a missed call must not fail.");
    assert(noted.lifecycleChanged === false, "Recording a missed call changes no state.");
    assert(noted.separationRecorded === false, "A missed call is not a separation.");
  }
  const after = await clinicLifecycle(env, "ten_quiet");
  assert(after.status === before.status, `Six missed calls must leave the lifecycle at ${before.status}, found ${after.status}.`);
  assert(after.status === "ACTIVE", "The clinic is still active.");
  assert((await foundingStatus(env, "ten_quiet")).status === "ACTIVE", "Six missed calls do not touch founding status.");
  assert((await clinicFeeFor(env, "ten_quiet")).feeCents === 0, "Nor the waiver.");
  assert((await listSeparationEvents(env, "ten_quiet")).length === 0, "No separation event was written.");

  // Nor can an operator route around it.
  assertRefused(
    await separateClinic(env, { tenantId: "ten_quiet", kind: "WITHOUT_CAUSE", reason: "MISSED_CALLS", actorId: "admin_dana" }),
    "NOT_A_SEPARATION_EVENT",
    "Missed calls are not a contractual separation (§27)."
  );
  assertRefused(
    await setLifecycleStatus(env, { tenantId: "ten_quiet", status: "SEPARATED", reason: "Unresponsive.", triggerSource: "MISSED_CALLS", actorId: "admin_dana" }),
    "MISSED_CALLS_ARE_NOT_SEPARATION",
    "An unanswered-call job cannot move a clinic to SEPARATED."
  );
  assertRefused(
    await setLifecycleStatus(env, { tenantId: "ten_quiet", status: "SEPARATED", reason: "Unresponsive.", actorId: "admin_dana" }),
    "SEPARATION_REQUIRES_EVENT",
    "Separation is never a field edit; it is an event with a notice and a wind-down."
  );

  // The one consequence that is available: still contracted, no referrals.
  const paused = await setLifecycleStatus(env, {
    tenantId: "ten_quiet", status: "TEMPORARILY_INACTIVE",
    reason: "Repeatedly unreachable; paused pending contact.", triggerSource: "MISSED_CALLS", actorId: "admin_dana"
  });
  assert(paused.ok && paused.lifecycle.status === "TEMPORARILY_INACTIVE", "Missed calls may support a pause, and only a pause.");
  assert((await foundingStatus(env, "ten_quiet")).status === "ACTIVE", "The pause still does not cost the clinic its status.");
  assert((await clinicFeeFor(env, "ten_quiet")).feeCents === 0, "Or its waiver.");
}

/* ══════ 33. voluntary separation + same-entity rejoin restores the waiver ══ */

{
  const separated = await separateClinic(env, {
    tenantId: "ten_founding",
    kind: "VOLUNTARY",
    initiatedBy: "CLINIC",
    reason: "Practice is consolidating locations; leaving in good faith.",
    noticeReceivedAt: "2026-05-01",
    actorId: "admin_dana"
  });
  assert(separated.ok, `Voluntary separation failed: ${separated.code} ${separated.message}`);
  assert(separated.lifecycle.status === "SEPARATED", `A clean voluntary exit lands in SEPARATED, found ${separated.lifecycle.status}.`);
  assert(separated.founding.status === "SEPARATED_ELIGIBLE_TO_RESTORE", "Good-faith withdrawal leaves the waiver dormant, not lost (§9).");
  assert(separated.founding.rejoinEligible === true, "And rejoin-eligible.");
  assert(separated.founding.plan === "FOUNDING", "§11: leaving temporarily does not convert the clinic to standard $25 pricing.");
  assert(separated.survivingObligations.kinds.includes("CONFIDENTIALITY"), "Surviving obligations are enumerated at separation (§27).");
  assert(separated.survivingObligations.uncured === false, "This clinic left clean.");

  const rejoin = await requestRejoin(env, {
    tenantId: "ten_founding",
    requestedByName: "Dr. Priya Raman",
    requestedByEmail: "owner@ten_founding.example",
    claimsSameLegalEntity: true,
    claimsSamePractice: true,
    actorId: "admin_dana"
  });
  assert(rejoin.ok, `Requesting reactivation failed: ${rejoin.code}`);
  assert(rejoin.lifecycle.status === "REJOIN_REVIEW", "A reactivation request opens a review.");
  assert(rejoin.bars.barPriorCause === false, "There is no prior Cause on this record.");
  assert(rejoin.bars.barUncuredObligations === false, "And nothing outstanding.");

  const restored = await restoreFoundingOnRejoin(env, {
    tenantId: "ten_founding",
    rejoinRequestId: rejoin.rejoinRequest.id,
    verifiedSameLegalEntity: true,
    verifiedSamePractice: true,
    reason: "Same contracting entity, substantially the same practice.",
    actorId: "admin_dana"
  });
  assert(restored.ok, `Restoring the waiver failed: ${restored.code} ${restored.message}`);
  assert(restored.founding.status === "ACTIVE", "Acceptance test 33: the same entity rejoining is ACTIVE again.");
  assert(restored.fee.feeCents === 0, `Acceptance test 33: the fee waiver is restored, found ${restored.fee.feeCents}.`);
  assert(restored.fee.reason === "FOUNDING_CLINIC_RATE", "And it is billed as the founding rate, not as a discount.");
  assert(restored.rejoinRequest.foundingRestored === true, "The decision is recorded on the request.");
  assert(restored.lifecycle.status === "PENDING_ONBOARDING", "§28: reactivation may require current onboarding.");
}

/* ------- and outstanding obligations block restoration until cleared ------ */

{
  await recordContract(env, contractFor("ten_winddown", "Foxglove Veterinary Hospital, PC"));
  await setLifecycleStatus(env, { tenantId: "ten_winddown", status: "ACTIVE", reason: "Onboarded.", actorId: "admin_dana" });
  await grantFounding(env, { tenantId: "ten_winddown", sourceDocumentId: "doc_founding_letter_foxglove", actorId: "admin_dana" });

  // A confirmed booking on the books, and an unpaid receivable.
  seedIntake("int_winddown_1", "loc_winddown", "ten_winddown", "accepted");
  seedIntake("int_winddown_2", "loc_winddown", "ten_winddown", "completed");
  exec(`
    INSERT INTO clinic_fee_receivables (
      id, intake_id, tenant_id, amount_cents, fee_policy_id, fee_policy_version, plan, reason, state, completed_at
    ) VALUES ('rcv_winddown', 'int_winddown_2', 'ten_winddown', 2500, 'pricing_v1', 1, 'STANDARD', 'STANDARD_RATE', 'PAST_DUE', ?)
  `, new Date().toISOString());

  const obligations = await survivingObligations(env, "ten_winddown");
  assert(obligations.uncured === true, "An unpaid receivable is a surviving obligation.");
  assert(obligations.outstandingReceivableCents === 2500, "And it is counted to the penny.");

  const separated = await separateClinic(env, {
    tenantId: "ten_winddown", kind: "VOLUNTARY", reason: "Closing the Berkeley location.",
    noticeReceivedAt: "2026-06-01", actorId: "admin_dana"
  });
  assert(separated.ok, `Separation failed: ${separated.code}`);
  assert(
    separated.lifecycle.status === "VOLUNTARY_SEPARATION_PENDING",
    `§27 requires orderly completion of confirmed bookings, so the clinic is pending, not separated — found ${separated.lifecycle.status}.`
  );
  assert(separated.windDownBookings.length === 1, "The confirmed booking is named in the wind-down.");
  assert(separated.separation.windDownBookingCount === 1, "And counted on the separation event.");
  assert(separated.separation.obligationsCleared === false, "Money is still owed.");

  assertRefused(
    await completeWindDown(env, { tenantId: "ten_winddown", separationEventId: separated.separation.id, actorId: "admin_dana" }),
    "WIND_DOWN_INCOMPLETE",
    "The account cannot go quiet while a confirmed booking is outstanding."
  );

  exec("UPDATE intake_requests SET status = 'completed' WHERE id = 'int_winddown_1'");
  const wound = await completeWindDown(env, { tenantId: "ten_winddown", separationEventId: separated.separation.id, actorId: "admin_dana" });
  assert(wound.ok && wound.lifecycle.status === "SEPARATED", "Once the booking is seen through, the clinic is SEPARATED.");
  assert(wound.survivingObligations.uncured === true, "The unpaid receivable survives the separation (§27).");

  const rejoin = await requestRejoin(env, {
    tenantId: "ten_winddown", claimsSameLegalEntity: true, claimsSamePractice: true, actorId: "admin_dana"
  });
  assert(rejoin.bars.barUncuredObligations === true, "The review starts with the outstanding balance in front of it.");

  assertRefused(
    await restoreFoundingOnRejoin(env, {
      tenantId: "ten_winddown", rejoinRequestId: rejoin.rejoinRequest.id,
      verifiedSameLegalEntity: true, verifiedSamePractice: true, actorId: "admin_dana"
    }),
    "UNCURED_OBLIGATIONS",
    "§9(b): outstanding amounts must be resolved before the waiver is restored."
  );

  exec("UPDATE clinic_fee_receivables SET state = 'PAID' WHERE id = 'rcv_winddown'");
  const restored = await restoreFoundingOnRejoin(env, {
    tenantId: "ten_winddown", rejoinRequestId: rejoin.rejoinRequest.id,
    verifiedSameLegalEntity: true, verifiedSamePractice: true, actorId: "admin_dana"
  });
  assert(restored.ok, `Once cleared, restoration should succeed: ${restored.code} ${restored.message}`);
  assert(restored.fee.feeCents === 0, "And the waiver comes back.");
}

/* ═══════════ 34. termination for Cause does not automatically restore ═════ */

{
  await recordContract(env, contractFor("ten_cause", "Marsh Lane Veterinary, PC"));
  await setLifecycleStatus(env, { tenantId: "ten_cause", status: "ACTIVE", reason: "Onboarded.", actorId: "admin_dana" });
  await grantFounding(env, { tenantId: "ten_cause", sourceDocumentId: "doc_founding_letter_marsh_lane", actorId: "admin_dana" });
  assert((await clinicFeeFor(env, "ten_cause")).feeCents === 0, "Marsh Lane starts as a founding clinic.");

  const terminated = await separateClinic(env, {
    tenantId: "ten_cause",
    kind: "FOR_CAUSE",
    initiatedBy: "CLEARKEY",
    causeCategory: "PAW_IT_FORWARD_FUND_MISUSE",
    reason: "Program-funded deposits were retained and the same amount collected from the customer.",
    sourceDocumentId: "doc_investigation_marsh_lane",
    actorId: "admin_dana"
  });
  assert(terminated.ok, `Termination for Cause failed: ${terminated.code} ${terminated.message}`);
  assert(terminated.lifecycle.status === "TERMINATED_FOR_CAUSE", "The lifecycle records the Cause termination.");
  assert(terminated.lifecycle.terminatedForCause === true, "And flags it as such.");
  assert(terminated.founding.status === "REVOKED_FOR_CAUSE", "Founding status is revoked for Cause.");
  assert(terminated.founding.rejoinEligible === false, "§28: no contractual right to rejoin.");
  assert(
    (await clinicFeeFor(env, "ten_cause")).feeCents === STANDARD_FEE_CENTS,
    "After Cause, the standard fee applies prospectively."
  );
  assert(terminated.separation.causeCategory === "PAW_IT_FORWARD_FUND_MISUSE", "The separation event names the Cause.");

  const rejoin = await requestRejoin(env, {
    tenantId: "ten_cause", claimsSameLegalEntity: true, claimsSamePractice: true, actorId: "admin_dana"
  });
  assert(rejoin.bars.barPriorCause === true, "A prior Cause is on the record.");
  assert(rejoin.bars.barCircumvention === true, "So is the program misuse.");

  const automatic = await restoreFoundingOnRejoin(env, {
    tenantId: "ten_cause", rejoinRequestId: rejoin.rejoinRequest.id,
    verifiedSameLegalEntity: true, verifiedSamePractice: true, actorId: "admin_dana"
  });
  assertRefused(
    automatic, "RESTORATION_REQUIRES_EXPRESS_WRITING",
    "Acceptance test 34: termination for Cause does not automatically restore founding status."
  );
  assert(
    (await foundingStatus(env, "ten_cause")).status === "REVOKED_FOR_CAUSE",
    "Acceptance test 34: and the refusal leaves the revocation in place."
  );
  assert((await clinicFeeFor(env, "ten_cause")).feeCents === STANDARD_FEE_CENTS, "The clinic still pays the standard fee.");

  // Even with a writing, §9(c) independently bars a clinic whose Cause was
  // fund misuse. The express-writing route is not a way around the misuse bar.
  assertRefused(
    await restoreFoundingOnRejoin(env, {
      tenantId: "ten_cause", rejoinRequestId: rejoin.rejoinRequest.id,
      verifiedSameLegalEntity: true, verifiedSamePractice: true,
      expressWrittenRestoration: true, sourceDocumentId: "doc_restoration_letter", actorId: "admin_dana"
    }),
    "CIRCUMVENTION_OR_MISUSE_ON_RECORD",
    "Material misuse of Paw It Forward bars restoration on its own (§9(c))."
  );
  assert((await clinicFeeFor(env, "ten_cause")).feeCents === STANDARD_FEE_CENTS, "Still the standard fee.");

  // A Cause that is not misuse can be restored — but only in writing, and only
  // as a decision somebody made and signed.
  await recordContract(env, contractFor("ten_breach", "Kestrel Animal Care, PC"));
  await setLifecycleStatus(env, { tenantId: "ten_breach", status: "ACTIVE", reason: "Onboarded.", actorId: "admin_dana" });
  await grantFounding(env, { tenantId: "ten_breach", sourceDocumentId: "doc_founding_letter_kestrel", actorId: "admin_dana" });
  await separateClinic(env, {
    tenantId: "ten_breach", kind: "FOR_CAUSE", initiatedBy: "CLEARKEY",
    causeCategory: "UNCURED_MATERIAL_BREACH", reason: "Material breach uncured after fifteen days' written notice.",
    actorId: "admin_dana"
  });
  const breachRejoin = await requestRejoin(env, {
    tenantId: "ten_breach", claimsSameLegalEntity: true, claimsSamePractice: true, actorId: "admin_dana"
  });
  assertRefused(
    await restoreFoundingOnRejoin(env, {
      tenantId: "ten_breach", rejoinRequestId: breachRejoin.rejoinRequest.id,
      verifiedSameLegalEntity: true, verifiedSamePractice: true, actorId: "admin_dana"
    }),
    "RESTORATION_REQUIRES_EXPRESS_WRITING",
    "Restoration after Cause is never automatic, whatever the category."
  );
  const express = await restoreFoundingOnRejoin(env, {
    tenantId: "ten_breach", rejoinRequestId: breachRejoin.rejoinRequest.id,
    verifiedSameLegalEntity: true, verifiedSamePractice: true,
    expressWrittenRestoration: true, sourceDocumentId: "doc_express_restoration_kestrel",
    reason: "Breach cured; restoration granted in writing.", actorId: "admin_dana"
  });
  assert(express.ok, `Express written restoration should succeed: ${express.code} ${express.message}`);
  assert(express.fee.feeCents === 0, "An express written restoration does restore the waiver.");
  assert(
    express.rejoinRequest.expressWrittenRestorationDocumentId === "doc_express_restoration_kestrel",
    "And the writing is recorded on the request."
  );
}

/* ═══════════ 35. a new legal entity does not automatically inherit ════════ */

{
  // The seller: a founding clinic that sells the practice.
  await recordContract(env, contractFor("ten_seller", "Alder Creek Veterinary Clinic, PC"));
  await setLifecycleStatus(env, { tenantId: "ten_seller", status: "ACTIVE", reason: "Onboarded.", actorId: "admin_dana" });
  await grantFounding(env, { tenantId: "ten_seller", sourceDocumentId: "doc_founding_letter_alder_creek", actorId: "admin_dana" });
  assert((await clinicFeeFor(env, "ten_seller")).feeCents === 0, "The seller is a founding clinic.");

  await recordManagementEvent(env, {
    tenantId: "ten_seller", eventType: "OWNER_CONTROL",
    oldValue: "Dr. Priya Raman (100%)", newValue: "Alder Creek Veterinary Group, PC (asset purchase)",
    sourceDocumentId: "doc_asset_purchase_agreement", actorId: "admin_dana"
  });
  await separateClinic(env, {
    tenantId: "ten_seller", kind: "VOLUNTARY", reason: "Practice sold; the selling entity is winding down.",
    actorId: "admin_dana"
  });

  // The buyer: a different legal entity, its own agreement, its own tenant.
  const successorContract = await recordContract(env, contractFor("ten_successor", "Alder Creek Veterinary Group, PC"));
  assert(successorContract.ok, "The successor signs its own agreement (§3, §30).");
  assert(
    successorContract.contract.clinicLegalName === "Alder Creek Veterinary Group, PC",
    "The successor's agreement names the successor entity."
  );
  assert(
    (await clinicFeeFor(env, "ten_successor")).feeCents === STANDARD_FEE_CENTS,
    "Acceptance test 35: a new legal entity starts on the standard fee — nothing is inherited by signing."
  );
  assert((await foundingStatus(env, "ten_successor")).status === "NOT_APPLICABLE", "The successor has no founding designation.");

  const rejoin = await requestRejoin(env, {
    tenantId: "ten_successor",
    requestedByName: "Dr. Owen Castellanos",
    claimsSameLegalEntity: false,
    claimsSamePractice: true,
    actorId: "admin_dana"
  });
  assert(rejoin.ok, "The successor may ask.");

  const inherited = await restoreFoundingOnRejoin(env, {
    tenantId: "ten_successor", rejoinRequestId: rejoin.rejoinRequest.id,
    verifiedSameLegalEntity: false, verifiedSamePractice: true, actorId: "admin_dana"
  });
  assertRefused(
    inherited, "NEW_ENTITY_NO_AUTOMATIC_INHERITANCE",
    "Acceptance test 35: a new legal entity does not automatically inherit founding status."
  );
  assert(
    (await clinicFeeFor(env, "ten_successor")).feeCents === STANDARD_FEE_CENTS,
    "Acceptance test 35: and it is billed the standard fee until somebody decides otherwise."
  );

  // Preservation is available — as an affirmative recorded decision, never a default.
  assertRefused(
    await preserveFoundingForSuccessor(env, {
      tenantId: "ten_successor", successorLegalName: "Alder Creek Veterinary Group, PC",
      sourceDocumentId: "doc_successor_decision", bonaFideSuccessor: false, substantiallySamePractice: true,
      actorId: "admin_dana"
    }),
    "SUCCESSOR_FINDING_REQUIRED",
    "Preserving founding status requires the bona fide successor finding to actually be made."
  );
  assertRefused(
    await preserveFoundingForSuccessor(env, {
      tenantId: "ten_successor", successorLegalName: "Alder Creek Veterinary Group, PC",
      bonaFideSuccessor: true, substantiallySamePractice: true, actorId: "admin_dana"
    }),
    "SOURCE_DOCUMENT_REQUIRED",
    "And it must be written down."
  );

  const preserved = await preserveFoundingForSuccessor(env, {
    tenantId: "ten_successor", successorLegalName: "Alder Creek Veterinary Group, PC",
    sourceDocumentId: "doc_successor_decision", bonaFideSuccessor: true, substantiallySamePractice: true,
    reason: "Same doctors, same location, same clients; bona fide successor.", actorId: "admin_dana"
  });
  assert(preserved.ok, `Express successor preservation should succeed: ${preserved.code} ${preserved.message}`);
  assert(preserved.fee.feeCents === 0, "Once expressly preserved, the successor holds the waiver.");
  assert(
    (await listFoundingHistory(env, "ten_successor")).some((entry) => entry.successorPreservation),
    "And the history says it was a successor decision, not an ordinary grant."
  );
}

/* ═══════════════════════════ the founding history is append-only ═════════ */

{
  const tenantId = "ten_history";
  exec("INSERT INTO tenants (id, name, slug) VALUES (?, ?, ?)", tenantId, "Willowbrook Veterinary", "t-willowbrook");
  exec(`
    INSERT INTO locations (id, tenant_id, name, slug, kind, address_line1, city, region, postal_code, phone, latitude, longitude)
    VALUES ('loc_history', ?, 'Willowbrook Veterinary', 't-willowbrook', 'general', '9 Willow Way', 'Berkeley', 'CA', '94710', '(510) 555-0199', 37.87, -122.29)
  `, tenantId);
  await recordContract(env, contractFor(tenantId, "Willowbrook Veterinary, PC"));

  const snapshots = [];
  const snapshot = async () => {
    const rows = await listFoundingHistory(env, tenantId);
    snapshots.push(rows.map((row) => `${row.id}|${row.status}|${row.causeCategory || ""}|${row.rejoinEligible}`));
    return rows;
  };

  await snapshot();
  await grantFounding(env, { tenantId, sourceDocumentId: "doc_founding_letter_willowbrook", actorId: "admin_dana" });
  await snapshot();
  await setFoundingStatus(env, { tenantId, status: "TEMPORARILY_INACTIVE", reason: "Seasonal pause.", actorId: "admin_dana" });
  await snapshot();
  await setFoundingStatus(env, { tenantId, status: "ACTIVE", reason: "Reopened.", actorId: "admin_dana" });
  await snapshot();
  await revokeFoundingForCause(env, {
    tenantId, causeCategory: "INTENTIONAL_FEE_CIRCUMVENTION",
    reason: "Referred customers were routed off-platform to avoid the Clinic Fee.", actorId: "admin_dana"
  });
  const finalRows = await snapshot();

  // Newest first, so each earlier snapshot must be a suffix of the next.
  for (let index = 1; index < snapshots.length; index += 1) {
    const previous = snapshots[index - 1];
    const current = snapshots[index];
    assert(current.length >= previous.length, "The founding history only ever grows.");
    const tail = current.slice(current.length - previous.length);
    assert(
      JSON.stringify(tail) === JSON.stringify(previous),
      `A founding history row was rewritten between snapshots ${index - 1} and ${index}.`
    );
  }
  assert(finalRows.length === 4, `Four transitions should leave four rows, found ${finalRows.length}.`);
  assert(finalRows[0].status === "REVOKED_FOR_CAUSE", "The newest row is the revocation.");
  assert(finalRows[0].causeCategory === "INTENTIONAL_FEE_CIRCUMVENTION", "Naming its Cause.");
  assert(finalRows[0].rejoinEligible === false, "And closing rejoin eligibility.");
  assert(
    finalRows.some((row) => row.status === "TEMPORARILY_INACTIVE"),
    "The seasonal pause is still in the record after the revocation."
  );
  assert(
    finalRows.filter((row) => row.status === "ACTIVE").length === 2,
    "Both spells of active status are preserved, not collapsed into one."
  );

  // The database itself refuses the two shapes a bad row could take.
  let refusedCauseless = false;
  try {
    exec(`
      INSERT INTO clinic_founding_status_history (id, tenant_id, status, rejoin_eligible)
      VALUES ('fnd_bad_1', ?, 'REVOKED_FOR_CAUSE', 0)
    `, tenantId);
  } catch { refusedCauseless = true; }
  assert(refusedCauseless, "A revocation without a Cause category must be refused by the schema.");

  let refusedEligible = false;
  try {
    exec(`
      INSERT INTO clinic_founding_status_history (id, tenant_id, status, cause_category, rejoin_eligible)
      VALUES ('fnd_bad_2', ?, 'REVOKED_FOR_CAUSE', 'FRAUD', 1)
    `, tenantId);
  } catch { refusedEligible = true; }
  assert(refusedEligible, "A revocation for Cause cannot claim automatic rejoin eligibility.");
}

/* ═══════════════════════ every material change is audited ════════════════ */

{
  const actions = database.prepare(`
    SELECT DISTINCT action FROM audit_events WHERE subject_type = 'tenant'
  `).all().map((row) => row.action);
  for (const action of [
    "clinic_contract.recorded",
    "clinic_representative.designated",
    "clinic_representative.ended",
    "clinic_management.recorded",
    "clinic_founding.granted",
    "clinic_founding.status_changed",
    "clinic_founding.revoked_for_cause",
    "clinic_founding.restored_on_rejoin",
    "clinic_founding.restoration_refused",
    "clinic_founding.successor_preserved",
    "clinic_separation.recorded",
    "clinic_rejoin.requested",
    "clinic_lifecycle.changed",
    "clinic_lifecycle.missed_calls_noted"
  ]) {
    assert(actions.includes(action), `Material change ${action} must leave an audit event.`);
  }

  const missed = database.prepare(`
    SELECT new_state_json FROM audit_events WHERE action = 'clinic_lifecycle.missed_calls_noted' LIMIT 1
  `).get();
  assert(
    JSON.parse(missed.new_state_json).lifecycleChanged === false,
    "The missed-call audit event records that nothing changed."
  );

  // Acceptance test 30 in its strongest form. Nothing in this module raises a
  // receivable at all — addendum §11 forbids creating a default $25 charge and
  // "discounting it later" — so the only row in the table is the legacy
  // standard-rate charge this test seeded by hand.
  const seeded = database.prepare("SELECT id FROM clinic_fee_receivables").all().map((row) => row.id);
  assert(
    seeded.length === 1 && seeded[0] === "rcv_winddown",
    `The contract module must never write a clinic fee receivable; found ${JSON.stringify(seeded)}.`
  );

  // And every clinic currently holding the waiver resolves to $0 through the
  // one function that decides money.
  const foundingTenants = database.prepare(
    "SELECT tenant_id FROM clinic_pricing_assignments WHERE plan = 'FOUNDING' AND good_standing = 1"
  ).all().map((row) => row.tenant_id);
  assert(foundingTenants.length >= 4, "Several clinics should be holding the waiver by now.");
  for (const tenantId of foundingTenants) {
    const fee = await clinicFeeFor(env, tenantId);
    assert(fee.feeCents === 0, `Acceptance test 30: ${tenantId} holds the waiver but resolves to ${fee.feeCents}.`);
    assert(fee.feeCents !== STANDARD_FEE_CENTS, `Acceptance test 30: ${tenantId} must never be billed the default $25.`);
  }
}

/* ═══════════════════════════════ the admin console profile (§19) ═════════ */

{
  const profile = await clinicContractProfile(env, "ten_founding");
  assert(profile.contractingEntity === "ClearKey Solutions, LLC", "The profile names ClearKey as the counterparty.");
  assert(profile.contract.agreementVersion === "2026.1", "It shows the agreement in force.");
  assert(profile.founding.status === "ACTIVE", "It shows the founding status.");
  assert(profile.pricing.applicableFeeCents === 0, "And the fee that will actually be billed.");
  assert(profile.pricing.reason === "FOUNDING_CLINIC_RATE", "With the reason attached.");
  assert(profile.representatives.length >= 1, "It lists the current representatives.");
  assert(profile.representativeHistory.length > profile.representatives.length, "And keeps the history beside them.");
  assert(profile.managementEvents.length >= 5, "It shows the management/ownership log (§19 Contract section).");
  assert(profile.founding.history.length >= 3, "And the founding history (§19 Pricing section).");
  assert(Array.isArray(profile.lifecycleEvents) && profile.lifecycleEvents.length > 0, "And the lifecycle log (§19 Risk section).");
  assert(profile.survivingObligations.uncured === false, "Cedar Hollow owes nothing.");

  assert((await listContracts(env, { status: "EXECUTED" })).length >= 6, "The admin list shows every executed agreement.");
}

/* -------------------------------------------------------------- done --- */

console.log(`clinic-contracts-test: ${passed} assertions passed.`);
