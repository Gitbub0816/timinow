/**
 * Temporary match aliases and clinic billing.
 *
 * Covers the alias acceptance tests that are provable in code — 1–8 and
 * 23–25 of the alias spec — plus the money rules that must never drift:
 * a founding clinic bills $0 with a stated reason rather than no row at all,
 * a standard clinic bills only at verified completion, a sponsored visit
 * bills neither side, clinic debt never touches restricted fund money, and
 * the pre-confirmation payload identifies nobody.
 *
 * Same harness as scripts/e2e.mjs: migrations applied to an in-memory SQLite
 * database behind a D1-shaped mock, so the SQL under test is the SQL that
 * ships.
 */

import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import { ALIAS_LIBRARY, ALIAS_LIBRARY_VERSION, aliasBySlug } from "../src/alias-library.js";
import {
  assignAliases,
  collidesWithNames,
  denylistAlias,
  deactivateAlias,
  ensureSearchSession,
  extendSearchSession,
  googleRatingModule,
  markSessionStatus,
  maskedMatchCard,
  MATCH_ALIAS_LABEL,
  revealMapping,
  scanForIdentityLeak,
  sessionMapping
} from "../src/match-alias.js";
import {
  approveClinicApplication,
  assertNoRestrictedOffset,
  assignPricingPlan,
  buildMonthlyInvoice,
  clinicBillingRestricted,
  declineClinicApplication,
  evaluateVisitSignals,
  getClinicFeeReceivable,
  isSponsoredVisit,
  listClinicApplications,
  markInvoicePaid,
  markInvoiceSent,
  nextFailureState,
  recordCompletedVisitFee,
  recordInvoiceFailure,
  recordVisitSignal,
  submitClinicApplication,
  visitFeeQuote,
  visitVerification
} from "../src/clinic-billing.js";
import { accountBalance, ledgerIntegrity } from "../src/ledger.js";

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

async function assertThrows(fn, message) {
  try {
    await fn();
  } catch {
    passed += 1;
    return;
  }
  throw new Error(message);
}

const MIGRATIONS = [
  "0001_initial.sql", "0002_seed.sql", "0003_multi_offer_search.sql", "0004_tenancy_admin.sql",
  "0005_voice_calls.sql", "0006_care_context.sql", "0007_client_errors.sql", "0008_payments_ledger.sql",
  "0009_pets.sql", "0010_provider_analytics.sql", "0011_call_policy.sql", "0012_pet_sex.sql",
  "0013_pricing_and_ledger.sql", "0016_clinic_billing_and_aliases.sql"
];

const database = new DatabaseSync(":memory:");
for (const migration of MIGRATIONS) {
  database.exec(await readFile(`migrations/${migration}`, "utf8"));
}

const env = {
  DB: new D1Mock(database),
  MATCH_ALIAS_SECRET: "test-server-secret",
  GOOGLE_RATINGS_ENABLED: "true"
};

function exec(sql, ...values) {
  return database.prepare(sql).run(...values);
}

/* --------------------------------------------------------- fixtures ----- */

// Three clinics: one standard, one founding, one that will be sponsored.
const CLINICS = [
  { tenantId: "ten_standard", locationId: "loc_standard", name: "Bayview Veterinary Emergency", slug: "t-bayview" },
  { tenantId: "ten_founding", locationId: "loc_founding", name: "Cedar Hollow Animal Hospital", slug: "t-cedar-hollow" },
  { tenantId: "ten_sponsor", locationId: "loc_sponsor", name: "Riverside Pet Urgent Care", slug: "t-riverside" },
  { tenantId: "ten_extra", locationId: "loc_extra", name: "Northgate Veterinary Clinic", slug: "t-northgate" },
  { tenantId: "ten_fifth", locationId: "loc_fifth", name: "Sunfield Animal Care", slug: "t-sunfield" }
];

for (const clinic of CLINICS) {
  exec("INSERT INTO tenants (id, name, slug) VALUES (?, ?, ?)", clinic.tenantId, clinic.name, clinic.slug);
  exec(`
    INSERT INTO locations (id, tenant_id, name, slug, kind, address_line1, city, region, postal_code, phone, latitude, longitude)
    VALUES (?, ?, ?, ?, 'emergency', '1200 Shoreline Drive', 'Berkeley', 'CA', '94710', '(510) 555-0188', 37.87, -122.29)
  `, clinic.locationId, clinic.tenantId, clinic.name, clinic.slug);
}

function seedIntake(id, locationId, tenantId) {
  const now = new Date().toISOString();
  exec(`
    INSERT INTO intake_requests (
      id, public_code, location_id, tenant_id, pet_name, species, owner_name, owner_phone,
      concern_category, concern_summary, urgency, status, requested_at, request_expires_at
    ) VALUES (?, ?, ?, ?, 'Otis', 'dog', 'Maya Morgan', '(510) 555-0147', 'illness_or_injury', 'Vomiting', 'urgent', 'accepted', ?, ?)
  `, id, id.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(-10), locationId, tenantId, now, now);
}

/* ═══════════════════════════════════ alias library (acceptance test 23) ═══ */

assert(ALIAS_LIBRARY.length === 250, `Library must hold exactly 250 aliases, found ${ALIAS_LIBRARY.length}.`);
assert(new Set(ALIAS_LIBRARY.map((alias) => alias.slug)).size === 250, "Alias slugs must be unique.");
assert(
  new Set(ALIAS_LIBRARY.map((alias) => alias.displayName.toLowerCase())).size === 250,
  "Alias display names must be unique case-insensitively."
);
assert(ALIAS_LIBRARY_VERSION === 1, "Library version 1 is what the seed and the tests describe.");
{
  const byCategory = new Map();
  for (const alias of ALIAS_LIBRARY) byCategory.set(alias.category, (byCategory.get(alias.category) || 0) + 1);
  assert(byCategory.size === 10, `Expected 10 categories, found ${byCategory.size}.`);
  for (const [category, count] of byCategory) assert(count === 25, `Category ${category} must hold 25 aliases, found ${count}.`);
  assert(Object.isFrozen(ALIAS_LIBRARY), "ALIAS_LIBRARY must be frozen.");
  assert(aliasBySlug("sequoia")?.displayName === "Sequoia", "aliasBySlug resolves a known word.");
}

// The migration's seed and the module must agree in both directions, or the
// database hands out words the code has never heard of.
{
  const seeded = database.prepare("SELECT id, slug, display_name, category FROM match_aliases ORDER BY slug").all();
  assert(seeded.length === 250, `Migration must seed 250 aliases, found ${seeded.length}.`);
  const fromLibrary = new Map(ALIAS_LIBRARY.map((alias) => [alias.slug, alias]));
  for (const row of seeded) {
    const alias = fromLibrary.get(row.slug);
    assert(Boolean(alias), `Seeded alias ${row.slug} is not in the library.`);
    assert(row.display_name === alias.displayName && row.category === alias.category, `Seeded alias ${row.slug} disagrees with the library.`);
    assert(row.id === `alias_${alias.slug}`, `Seeded alias id must be alias_<slug>, found ${row.id}.`);
  }
}

/* ════════════════════════════════════════ alias assignment (tests 1–8) ═══ */

const fiveClinicIds = CLINICS.map((clinic) => clinic.locationId);

// 1. Five clinics receive five unique active aliases.
const firstAssignment = await assignAliases(env, {
  searchSessionId: "ssn_one",
  clinicIds: fiveClinicIds,
  userId: "user_maya"
});
assert(firstAssignment.assignments.length === 5, "Five candidates receive five aliases.");
assert(new Set(firstAssignment.assignments.map((entry) => entry.aliasId)).size === 5, "Five aliases must be distinct.");
{
  const active = database.prepare("SELECT active FROM match_aliases WHERE id = ?");
  for (const entry of firstAssignment.assignments) {
    assert(Number(active.get(entry.aliasId).active) === 1, `Assigned alias ${entry.slug} must be active.`);
  }
}

// 2. A reload returns the same mapping — including when the candidates come
//    back in a different order, which is what a re-rank between polls looks
//    like.
const reload = await assignAliases(env, {
  searchSessionId: "ssn_one",
  clinicIds: [...fiveClinicIds].reverse()
});
for (const clinicId of fiveClinicIds) {
  assert(
    reload.byClinicId[clinicId].aliasId === firstAssignment.byClinicId[clinicId].aliasId,
    `Reload renamed ${clinicId}: ${firstAssignment.byClinicId[clinicId].slug} → ${reload.byClinicId[clinicId].slug}.`
  );
}

// 3 and 7. A new session randomises the mapping for identical candidates, so
//    a clinic cannot be identified by its alias across sessions. Run enough
//    sessions that "always the same word" would be obvious.
{
  const target = fiveClinicIds[0];
  const seen = new Set();
  for (let index = 0; index < 12; index += 1) {
    const session = await assignAliases(env, { searchSessionId: `ssn_rotate_${index}`, clinicIds: fiveClinicIds });
    seen.add(session.byClinicId[target].slug);
  }
  assert(seen.size > 1, `A clinic kept the same alias across 12 sessions (${[...seen]}) — that is a permanent name.`);
  assert(!seen.has(undefined), "Every session assigned the target clinic an alias.");
}

// 4. Removing a candidate does not rename the others.
{
  const withoutOne = await assignAliases(env, { searchSessionId: "ssn_one", clinicIds: fiveClinicIds.slice(1) });
  for (const clinicId of fiveClinicIds.slice(1)) {
    assert(
      withoutOne.byClinicId[clinicId].aliasId === firstAssignment.byClinicId[clinicId].aliasId,
      `Removing a candidate renamed ${clinicId}.`
    );
  }
  assert(withoutOne.assignments.length === 4, "The withdrawn candidate is no longer returned.");
  // The mapping row survives for the audit window even though the card is gone.
  assert((await sessionMapping(env, "ssn_one")).length === 5, "A withdrawn candidate's mapping row is retained.");
}

// 5. Adding a candidate assigns an unused alias without remapping.
{
  exec("INSERT INTO tenants (id, name, slug) VALUES ('ten_late', 'Late Arrival Veterinary', 'late-arrival')");
  exec(`
    INSERT INTO locations (id, tenant_id, name, slug, kind, address_line1, city, region, postal_code, phone, latitude, longitude)
    VALUES ('loc_late', 'ten_late', 'Late Arrival Veterinary', 'late-arrival', 'urgent', '9 Elm Street', 'Berkeley', 'CA', '94710', '(510) 555-0199', 37.86, -122.28)
  `);
  const withSix = await assignAliases(env, { searchSessionId: "ssn_one", clinicIds: [...fiveClinicIds, "loc_late"] });
  for (const clinicId of fiveClinicIds) {
    assert(withSix.byClinicId[clinicId].aliasId === firstAssignment.byClinicId[clinicId].aliasId, `Adding a candidate renamed ${clinicId}.`);
  }
  const newAlias = withSix.byClinicId.loc_late;
  assert(Boolean(newAlias), "The added candidate received an alias.");
  assert(
    !firstAssignment.assignments.some((entry) => entry.aliasId === newAlias.aliasId),
    "The added candidate reused an alias already visible in this session."
  );
  assert(withSix.assignments.length === 6, "All six candidates are returned.");
}

// 6. Alias choice is independent of rating, distance, wait, fee tier and
//    founding status. Proved structurally: the founding clinic and a
//    restricted-fee clinic are in the set, the candidates are passed in three
//    different rank orders, and the mapping is identical every time. The
//    shuffle is never given those fields at all.
{
  const orders = [
    ["loc_standard", "loc_founding", "loc_sponsor"],
    ["loc_sponsor", "loc_standard", "loc_founding"],
    ["loc_founding", "loc_sponsor", "loc_standard"]
  ];
  const results = [];
  for (const [index, order] of orders.entries()) {
    results.push(await assignAliases(env, { searchSessionId: `ssn_rank_${index}`, clinicIds: order }));
  }
  // Same session id would trivially agree; these are different sessions with
  // the same members, so what is compared is the shuffle itself under
  // different input orders.
  const perSession = results.map((result) => result.assignments.map((entry) => entry.clinicId).sort().join(","));
  assert(new Set(perSession).size === 1, "The same three clinics were not mapped in every ordering.");
  const sameOrderTwice = await assignAliases(env, { searchSessionId: "ssn_rank_0", clinicIds: [...orders[2]] });
  for (const clinicId of orders[0]) {
    assert(
      sameOrderTwice.byClinicId[clinicId].aliasId === results[0].byClinicId[clinicId].aliasId,
      "Re-ranking the candidate list changed the alias mapping inside one session."
    );
  }

  // The persisted path can only prove stability, because the rows already
  // exist. Running the same session against the pure, unpersisted path proves
  // the property one level down: the shuffle itself does not care what order
  // the ranker produced.
  const memoryEnv = { MATCH_ALIAS_SECRET: "test-server-secret" };
  const ranked = await assignAliases(memoryEnv, { searchSessionId: "ssn_pure", clinicIds: orders[0] });
  const reranked = await assignAliases(memoryEnv, { searchSessionId: "ssn_pure", clinicIds: orders[1] });
  assert(ranked.persisted === false, "The pure path reports that it stored nothing.");
  for (const clinicId of orders[0]) {
    assert(
      ranked.byClinicId[clinicId].slug === reranked.byClinicId[clinicId].slug,
      `The shuffle gave ${clinicId} a different alias when the ranking changed.`
    );
  }
  const source = await readFile("src/match-alias.js", "utf8");
  const shuffleStart = source.indexOf("export async function keyedShuffle");
  assert(shuffleStart > 0, "keyedShuffle must exist to be inspected.");
  const shuffleBody = source.slice(shuffleStart, source.indexOf("\n}\n", shuffleStart));
  for (const field of ["rating", "distance", "wait", "fee", "price", "founding", "sponsor", "rank"]) {
    assert(
      !new RegExp(`\\b${field}`, "i").test(shuffleBody),
      `The shuffle reads "${field}" — alias choice must encode no rank.`
    );
  }
}

// 8. An alias that collides with a real or nearby clinic name is excluded for
//    that result set.
{
  assert(collidesWithNames("Cedar", ["Cedar Hollow Animal Hospital"]), "Cedar collides with Cedar Hollow.");
  assert(collidesWithNames("Grove", ["Willow Grove Pet Clinic"]), "A collision mid-name still reads as the clinic's name.");
  assert(!collidesWithNames("Iris", ["Irish Setter Veterinary"]), "A substring inside a longer word is not a collision.");

  const collisionSession = await assignAliases(env, {
    searchSessionId: "ssn_collision",
    clinicIds: ["loc_standard", "loc_founding"],
    candidateNames: ["Cedar Hollow Animal Hospital"],
    nearbyNames: ["Harbor Animal Hospital", "Redwood Veterinary Group"]
  });
  const assigned = collisionSession.assignments.map((entry) => entry.slug);
  for (const forbidden of ["cedar", "harbor", "redwood"]) {
    assert(!assigned.includes(forbidden), `Alias "${forbidden}" collides with a real clinic name in this result set.`);
  }
  assert(collisionSession.excludedCount >= 3, "Collisions must be counted as exclusions.");
}

/* ═══════════════════════════════════ denylist and reveal (tests 24, 25) ═══ */

// 24. A denylisted or deactivated alias is never assigned again, and the
//     sessions that already used it stay auditable.
{
  const historic = await assignAliases(env, { searchSessionId: "ssn_history", clinicIds: ["loc_standard"] });
  const retired = historic.assignments[0];

  const deactivated = await deactivateAlias(env, { slug: retired.slug, reason: "Trademark review", actorId: "admin_1" });
  assert(deactivated.ok, "Deactivating an alias succeeds.");
  assert(
    Number(database.prepare("SELECT active FROM match_aliases WHERE slug = ?").get(retired.slug).active) === 0,
    "A deactivated alias is inactive."
  );
  assert(
    database.prepare("SELECT deactivation_reason r FROM match_aliases WHERE slug = ?").get(retired.slug).r === "Trademark review",
    "A deactivated alias records why."
  );
  assert(
    (await sessionMapping(env, "ssn_history")).some((entry) => entry.slug === retired.slug),
    "History must survive deactivation — the old session still resolves."
  );

  const denied = await denylistAlias(env, { slug: "juniper", scope: "MARKET", market: "berkeley-ca", reason: "Juniper Veterinary operates here", actorId: "admin_1" });
  assert(denied.ok, "Denylisting an alias succeeds.");

  // Draw many sessions in that market; neither word may reappear.
  for (let index = 0; index < 25; index += 1) {
    const session = await assignAliases(env, {
      searchSessionId: `ssn_deny_${index}`,
      clinicIds: fiveClinicIds,
      market: "berkeley-ca"
    });
    const slugs = session.assignments.map((entry) => entry.slug);
    assert(!slugs.includes(retired.slug), `Deactivated alias ${retired.slug} was assigned again.`);
    assert(!slugs.includes("juniper"), "A market-denylisted alias was assigned in that market.");
  }
  assert(
    (await deactivateAlias(env, { slug: "maple" })).code === "REASON_REQUIRED",
    "Deactivating without a reason is refused."
  );
}

// 25. Support access to a live mapping is authorised and logged.
{
  const before = database.prepare("SELECT COUNT(*) c FROM audit_events WHERE action = 'match_alias.revealed'").get().c;
  const revealed = await revealMapping(env, {
    searchSessionId: "ssn_one",
    clinicId: "loc_standard",
    actorId: "support_agent_7",
    actorRole: "support",
    reason: "Assisting active booking BKX-118"
  });
  assert(revealed.ok, "A support reveal resolves the mapping.");
  assert(revealed.mapping.clinicId === "loc_standard", "The reveal returns the real clinic id.");
  const after = database.prepare("SELECT * FROM audit_events WHERE action = 'match_alias.revealed' ORDER BY rowid DESC LIMIT 1").get();
  assert(
    database.prepare("SELECT COUNT(*) c FROM audit_events WHERE action = 'match_alias.revealed'").get().c === before + 1,
    "Every reveal writes exactly one audit event."
  );
  assert(after.actor_id === "support_agent_7", "The audit event names the actor.");
  assert(after.reason === "Assisting active booking BKX-118", "The audit event records why.");
  assert(
    database.prepare("SELECT revealed_at FROM search_match_aliases WHERE search_session_id = 'ssn_one' AND clinic_id = 'loc_standard'").get().revealed_at,
    "The mapping row records that it was revealed."
  );
  const missing = await revealMapping(env, { searchSessionId: "ssn_one", clinicId: "loc_nonexistent", actorId: "support_agent_7" });
  assert(!missing.ok && missing.code === "MAPPING_NOT_FOUND", "A reveal for an unmapped clinic fails rather than inventing one.");
}

/* ═══════════════════════════════ sessions, TTL and lifecycle (spec §4.3) ═══ */

{
  const session = await ensureSearchSession(env, { searchSessionId: "ssn_ttl", userId: "user_maya" });
  assert(session.ttlMinutes === 30, "The default session TTL is 30 minutes.");
  assert(Date.parse(session.expiresAt) > Date.now(), "A new session expires in the future.");
  const extended = await extendSearchSession(env, "ssn_ttl", { minutes: 45 });
  assert(Date.parse(extended.expiresAt) > Date.parse(session.expiresAt), "Checkout extends the mapping's life.");
  const confirmed = await markSessionStatus(env, "ssn_ttl", "CONFIRMED");
  assert(confirmed.status === "CONFIRMED" && confirmed.confirmedAt, "Confirmation is recorded on the session.");

  const custom = await ensureSearchSession(env, { searchSessionId: "ssn_ttl_custom", ttlMinutes: 5 });
  assert(custom.ttlMinutes === 5, "The TTL is configurable per session.");
}

/* ══════════════════════════ the pre-confirmation card (tests 9, 11, 18) ═══ */

const REAL_LOCATION = {
  id: "loc_standard",
  tenantId: "ten_standard",
  name: "Bayview Veterinary Emergency",
  slug: "t-bayview",
  kind: "emergency",
  address: "1200 Shoreline Drive, Berkeley, CA 94710",
  addressLine1: "1200 Shoreline Drive",
  city: "Berkeley",
  region: "CA",
  phone: "(510) 555-0188",
  website: "https://bayviewvet.example",
  latitude: 37.87,
  longitude: -122.29,
  distanceMiles: 4.2,
  open24Hours: true,
  acceptsWalkIns: true,
  species: ["dog", "cat"],
  capabilities: ["xray", "ultrasound"],
  baseExamFeeCents: 14500,
  availability: { intakeStatus: "available", stableWaitMin: 15, stableWaitMax: 25, acceptsCritical: true },
  policy: { depositAmountCents: 5000 }
};

const cardAlias = firstAssignment.byClinicId.loc_standard;
const freshSnapshot = {
  rating: 4.8,
  userRatingCount: 326,
  fetchedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  sourcePolicyVersion: "places-2026-08"
};

{
  const card = maskedMatchCard(REAL_LOCATION, cardAlias, {
    matchToken: "mt_opaque_token",
    travelMinutes: 11,
    ratingSnapshot: freshSnapshot,
    ratingsEnabled: true
  });

  // 9. The persistent label is on the card, not behind a tooltip.
  assert(card.alias.label === MATCH_ALIAS_LABEL, "The card carries the persistent temporary-name label.");
  assert(card.alias.label === "Temporary TímiNOW match name", "The label text is exactly as specified.");
  assert(card.alias.displayName === cardAlias.displayName, "The card carries the alias display name.");
  assert(card.alias.isTemporaryAlias === true, "The card marks the alias as temporary.");
  assert(card.alias.explainer.body.includes("not the clinics' business names"), "The explainer says what an alias is not.");
  assert(card.revealedOnConfirmation.includes("address") && card.revealedOnConfirmation.includes("phone"), "The card states what confirmation reveals.");

  // 11. Nothing identifying.
  const leak = scanForIdentityLeak(card, REAL_LOCATION);
  assert(leak.ok, `The pre-confirmation payload leaks ${leak.findings.join(", ")}.`);
  const serialized = JSON.stringify(card);
  for (const forbidden of ["Bayview", "Shoreline", "5550188", "bayviewvet", "37.87", "-122.29"]) {
    assert(!serialized.includes(forbidden), `The payload contains "${forbidden}".`);
  }
  assert(!serialized.includes("loc_standard") && !serialized.includes("ten_standard"), "The payload exposes no clinic or tenant id.");

  // Still useful: the facts a decision is actually made on.
  assert(card.timinow.distanceMiles === 4.2 && card.timinow.travelMinutes === 11, "Distance and travel time survive masking.");
  assert(card.timinow.estimatedWait.minMinutes === 15 && card.timinow.estimatedWait.maxMinutes === 25, "The estimated wait survives masking.");
  assert(card.timinow.acceptingNow === true, "Availability survives masking.");
  assert(card.timinow.capabilities.includes("xray") && card.timinow.species.includes("dog"), "Capabilities and species survive masking.");

  // 14/17. Google content is separately fielded and carries its own
  //        attribution, inside the rating container.
  assert(card.google.rating === 4.8 && card.google.userRatingCount === 326, "The Google rating is carried in its own field.");
  assert(card.google.attribution.provider === "GOOGLE_MAPS", "The rating carries Google Maps attribution.");
  assert(card.google.attribution.placement === "inside_rating_container", "Attribution belongs inside the rating container.");
  assert(card.attributionBoundary.googleMaps.join(",") === "rating,userRatingCount", "Only rating and count are attributed to Google.");
  assert(card.attributionBoundary.timinow.includes("alias"), "The alias is Tími's, and must never appear as Google's.");
}

// 18. Turning the ratings flag off leaves a complete, usable card.
{
  const withoutRatings = maskedMatchCard(REAL_LOCATION, cardAlias, { travelMinutes: 11, ratingSnapshot: freshSnapshot, ratingsEnabled: false });
  assert(withoutRatings.google === null, "The rating module is absent when the flag is off.");
  assert(withoutRatings.alias.displayName && withoutRatings.timinow.acceptingNow === true, "The card is still complete without ratings.");
  assert(withoutRatings.attributionBoundary.googleMaps.length === 0, "Nothing is attributed to Google when nothing came from Google.");
  assert(scanForIdentityLeak(withoutRatings, REAL_LOCATION).ok, "The flagged-off card leaks nothing either.");
}

// 19. Stale Places content is hidden, never served.
{
  const stale = { ...freshSnapshot, expiresAt: new Date(Date.now() - 1000).toISOString() };
  assert(googleRatingModule(stale, { enabled: true }) === null, "An expired snapshot is not served.");
  assert(googleRatingModule(null, { enabled: true }) === null, "A missing snapshot renders nothing rather than a guess.");
  const card = maskedMatchCard(REAL_LOCATION, cardAlias, { ratingSnapshot: stale, ratingsEnabled: true });
  assert(card.google === null && card.alias.displayName, "A card with stale ratings is still a usable card.");
}

/* ═══════════════════════════════════════════════════ the join portal ═══ */

{
  const submission = await submitClinicApplication(env, {
    body: {
      practiceName: "Green Basin Veterinary",
      contactName: "Dr. Alice Okafor",
      email: "alice@greenbasin.example",
      phone: "(510) 555-0123",
      addressLine1: "88 Basin Way",
      city: "Oakland",
      region: "CA",
      postalCode: "94607",
      website: "https://greenbasin.example",
      licenseNumber: "CA-VET-99213",
      licenseAuthority: "California Veterinary Medical Board",
      kind: "urgent",
      species: ["dog", "cat"],
      capabilities: ["xray"],
      hours: { mon: "8-18" },
      wantsFounding: true,
      heardAbout: "Another clinic",
      notes: "We can take overflow overnight."
    },
    submitterHash: "hash_a"
  });
  assert(submission.ok && submission.application.status === "SUBMITTED", "A valid application is recorded.");

  const invalid = await submitClinicApplication(env, { body: { practiceName: "X", email: "nope" }, submitterHash: "hash_a" });
  assert(!invalid.ok && invalid.code === "VALIDATION_FAILED", "An invalid application is refused with field errors.");

  // Rate limiting: the fourth attempt from one submitter inside an hour.
  for (let index = 0; index < 2; index += 1) {
    await submitClinicApplication(env, {
      body: { practiceName: `Clinic ${index}`, contactName: "A B", email: `c${index}@example.com`, phone: "5105550000", city: "Oakland", region: "CA" },
      submitterHash: "hash_a"
    });
  }
  const limited = await submitClinicApplication(env, {
    body: { practiceName: "Clinic 9", contactName: "A B", email: "c9@example.com", phone: "5105550000", city: "Oakland", region: "CA" },
    submitterHash: "hash_a"
  });
  assert(!limited.ok && limited.code === "RATE_LIMITED", "The public form is rate limited per submitter.");

  const queue = await listClinicApplications(env, { status: "SUBMITTED" });
  assert(queue.length >= 1, "Submitted applications appear in the review queue.");
  const application = queue.find((entry) => entry.practiceName === "Green Basin Veterinary");
  assert(application.license.number === "CA-VET-99213", "License details are stored.");
  assert(application.wantsFounding === true, "The founding request is stored.");

  const approved = await approveClinicApplication(env, {
    applicationId: application.id,
    actorId: "admin_1",
    plan: "FOUNDING",
    location: { latitude: 37.8, longitude: -122.27, addressLine1: "88 Basin Way", phone: "(510) 555-0123" },
    note: "Founding partner #3"
  });
  assert(approved.ok && approved.tenantId, "Approval creates a tenant.");
  assert(approved.locationId, "Approval creates the clinic's first location when it has coordinates.");
  const plan = database.prepare("SELECT * FROM clinic_pricing_assignments WHERE tenant_id = ?").get(approved.tenantId);
  assert(plan.plan === "FOUNDING" && Number(plan.good_standing) === 1, "Approval assigns the founding plan.");
  const stored = await listClinicApplications(env, { status: "APPROVED" });
  assert(stored[0].createdTenantId === approved.tenantId, "The application records the tenant it became.");
  assert(
    database.prepare("SELECT status FROM provider_applications WHERE id = ?").get(application.id).status === "closed",
    "The legacy triage status stays coherent for the existing admin console."
  );

  const second = await approveClinicApplication(env, { applicationId: application.id, actorId: "admin_1" });
  assert(second.ok && second.duplicate, "Approving twice does not create a second tenant.");

  const declining = await declineClinicApplication(env, { applicationId: application.id, actorId: "admin_1", reason: "Already approved" });
  assert(!declining.ok && declining.code === "APPLICATION_APPROVED", "An approved application cannot be declined out from under a live tenant.");
}

/* ═════════════════════════════════════ pricing plans and the $0 waiver ═══ */

await assignPricingPlan(env, { tenantId: "ten_founding", plan: "FOUNDING", actorId: "admin_1", note: "Founding partner #1" });
{
  const invalid = await assignPricingPlan(env, { tenantId: "ten_standard", plan: "CUSTOM", customFeeCents: 1500 });
  assert(!invalid.ok && invalid.code === "CONTRACT_REQUIRED", "A custom rate must point at a contract.");
  const missing = await assignPricingPlan(env, { tenantId: "ten_nobody", plan: "FOUNDING" });
  assert(!missing.ok && missing.code === "TENANT_NOT_FOUND", "A plan cannot be assigned to a clinic that does not exist.");
  assert(
    database.prepare("SELECT COUNT(*) c FROM audit_events WHERE action = 'clinic_pricing.assigned'").get().c >= 1,
    "Pricing assignments are audited."
  );
}

/* ══════════════════════════════ visit verification and completion fees ═══ */

// The state machine, as a pure function first.
{
  const clinicOnly = evaluateVisitSignals([
    { signal: "CUSTOMER_CONFIRMED", occurredAt: "2026-08-30T10:00:00Z" },
    { signal: "CLINIC_CHECKIN", occurredAt: "2026-08-30T10:40:00Z" },
    { signal: "CLINIC_SERVICE_CONFIRMED", occurredAt: "2026-08-30T11:30:00Z" }
  ]);
  assert(clinicOnly.state !== "COMPLETED", "A clinic's own word alone must not complete a visit.");
  assert(clinicOnly.billable === false, "A clinic's own word alone must not be billable.");
  assert(clinicOnly.reasons.includes("SINGLE_SOURCE_ONLY"), "The refusal names the reason.");

  const corroborated = evaluateVisitSignals([
    { signal: "CUSTOMER_CONFIRMED", occurredAt: "2026-08-30T10:00:00Z" },
    { signal: "CUSTOMER_CHECKIN", occurredAt: "2026-08-30T10:35:00Z" },
    { signal: "CLINIC_SERVICE_CONFIRMED", occurredAt: "2026-08-30T11:30:00Z" }
  ]);
  assert(corroborated.state === "COMPLETED" && corroborated.billable, "Two independent sources complete the visit.");

  const contradicted = evaluateVisitSignals([
    { signal: "GEOFENCE_ARRIVAL", occurredAt: "2026-08-30T10:30:00Z" },
    { signal: "DEPOSIT_CAPTURED", occurredAt: "2026-08-30T10:32:00Z" },
    { signal: "NO_SHOW_REPORTED", occurredAt: "2026-08-30T12:00:00Z" }
  ]);
  assert(contradicted.state === "DISPUTED", "A no-show report against arrival evidence is a dispute, not a no-show.");

  const genuine = evaluateVisitSignals([
    { signal: "CUSTOMER_CONFIRMED", occurredAt: "2026-08-30T10:00:00Z" },
    { signal: "NO_SHOW_REPORTED", occurredAt: "2026-08-30T12:00:00Z" }
  ]);
  assert(genuine.state === "NO_SHOW" && !genuine.billable, "An uncontradicted no-show report is a no-show.");

  const disputed = evaluateVisitSignals([
    { signal: "CUSTOMER_CHECKIN", occurredAt: "2026-08-30T10:35:00Z" },
    { signal: "CLINIC_SERVICE_CONFIRMED", occurredAt: "2026-08-30T11:30:00Z" },
    { signal: "DISPUTE_OPENED", occurredAt: "2026-08-30T13:00:00Z" }
  ]);
  assert(disputed.state === "DISPUTED" && !disputed.billable, "An open dispute suspends billing.");
}

// A standard clinic bills only at verified completion.
seedIntake("intake_standard", "loc_standard", "ten_standard");
{
  const tooEarly = await recordCompletedVisitFee(env, { intakeId: "intake_standard", tenantId: "ten_standard" });
  assert(!tooEarly.ok && tooEarly.code === "VISIT_NOT_VERIFIED", "No fee exists before the visit is verified.");
  assert(!(await getClinicFeeReceivable(env, "intake_standard")), "No receivable row is written before completion.");

  await recordVisitSignal(env, { intakeId: "intake_standard", signal: "CUSTOMER_CONFIRMED", tenantId: "ten_standard" });
  await recordVisitSignal(env, { intakeId: "intake_standard", signal: "CLINIC_REVEALED", tenantId: "ten_standard" });
  await recordVisitSignal(env, { intakeId: "intake_standard", signal: "EN_ROUTE", tenantId: "ten_standard" });

  const stillEarly = await recordCompletedVisitFee(env, { intakeId: "intake_standard", tenantId: "ten_standard" });
  assert(!stillEarly.ok, "A visit en route is not a completed visit.");

  await recordVisitSignal(env, { intakeId: "intake_standard", signal: "CUSTOMER_CHECKIN", tenantId: "ten_standard" });
  const clinicSide = await recordVisitSignal(env, { intakeId: "intake_standard", signal: "CLINIC_SERVICE_CONFIRMED", tenantId: "ten_standard" });
  assert(clinicSide.state === "COMPLETED", "Customer check-in plus clinic service confirmation completes the visit.");

  const billed = await recordCompletedVisitFee(env, { intakeId: "intake_standard", tenantId: "ten_standard", actorId: "system" });
  assert(billed.ok, "A verified completion creates the fee.");
  assert(billed.receivable.amountCents === 2500, `The standard clinic fee comes from pricing policy, got ${billed.receivable.amountCents}.`);
  assert(billed.receivable.plan === "STANDARD" && billed.receivable.reason === "STANDARD_RATE", "The fee records its plan and reason.");
  assert(billed.receivable.state === "DUE", "A standard fee starts DUE.");
  assert(billed.receivable.feePolicyVersion === 1, "The fee captures the pricing policy version.");
  assert(await accountBalance(env, "clinic_fee_receivable") === 2500, "The receivable is posted to the ledger.");
  assert(await accountBalance(env, "clinic_platform_fee_revenue") === 2500, "The fee is recognised as revenue at completion.");

  const replay = await recordCompletedVisitFee(env, { intakeId: "intake_standard", tenantId: "ten_standard" });
  assert(replay.ok && replay.duplicate, "A replayed completion does not bill twice.");
  assert(await accountBalance(env, "clinic_platform_fee_revenue") === 2500, "A replayed completion recognises no second revenue.");

  const verification = await visitVerification(env, "intake_standard");
  assert(verification.signals.length === 5, "Every signal is kept; none is overwritten.");
}

// A founding clinic bills $0 — as an explicit row with a stated reason.
seedIntake("intake_founding", "loc_founding", "ten_founding");
{
  await recordVisitSignal(env, { intakeId: "intake_founding", signal: "CUSTOMER_CONFIRMED", tenantId: "ten_founding" });
  await recordVisitSignal(env, { intakeId: "intake_founding", signal: "CUSTOMER_CHECKIN", tenantId: "ten_founding" });
  await recordVisitSignal(env, { intakeId: "intake_founding", signal: "CLINIC_SERVICE_CONFIRMED", tenantId: "ten_founding" });

  const revenueBefore = await accountBalance(env, "clinic_platform_fee_revenue");
  const founding = await recordCompletedVisitFee(env, { intakeId: "intake_founding", tenantId: "ten_founding" });
  assert(founding.ok && founding.waived, "A founding clinic's completed visit is waived.");
  assert(founding.receivable !== null, "The waiver is a row, not a skipped row.");
  assert(founding.receivable.amountCents === 0, "A founding clinic pays nothing.");
  assert(founding.receivable.plan === "FOUNDING", "The row records the founding plan.");
  assert(founding.receivable.reason === "FOUNDING_CLINIC_RATE", "The row states why it is zero.");
  assert(founding.receivable.state === "WAIVED", "A zero fee is settled at birth, not left owing.");
  assert(await accountBalance(env, "clinic_platform_fee_revenue") === revenueBefore, "A $0 fee recognises no revenue.");
  assert(founding.transactionId === null, "A $0 fee posts no journal — there is nothing to record moving.");

  // Losing good standing is prospective: the waived visit stays waived.
  const quoteInStanding = await visitFeeQuote(env, { tenantId: "ten_founding" });
  assert(quoteInStanding.clinicFeeCents === 0, "A founding clinic in good standing is quoted $0.");
}

// A sponsored visit bills neither side.
seedIntake("intake_sponsored", "loc_sponsor", "ten_sponsor");
{
  await recordVisitSignal(env, { intakeId: "intake_sponsored", signal: "CUSTOMER_CONFIRMED", tenantId: "ten_sponsor" });
  await recordVisitSignal(env, { intakeId: "intake_sponsored", signal: "CUSTOMER_CHECKIN", tenantId: "ten_sponsor" });
  await recordVisitSignal(env, { intakeId: "intake_sponsored", signal: "PMS_INTEGRATION_EVENT", tenantId: "ten_sponsor" });

  const quote = await visitFeeQuote(env, { tenantId: "ten_sponsor", isSponsored: true });
  assert(quote.ownerFeeCents === 0, "A sponsored visit costs the owner nothing.");
  assert(quote.clinicFeeCents === 0, "A sponsored visit costs the clinic nothing.");
  assert(quote.ownerFeeReason === "SPONSORED_VISIT" && quote.clinicFeeReason === "SPONSORED_VISIT", "Both zeroes state their reason.");

  const revenueBefore = await accountBalance(env, "clinic_platform_fee_revenue");
  const sponsored = await recordCompletedVisitFee(env, { intakeId: "intake_sponsored", tenantId: "ten_sponsor", isSponsored: true });
  assert(sponsored.ok && sponsored.receivable.amountCents === 0, "A sponsored visit bills the clinic nothing.");
  assert(sponsored.receivable.reason === "SPONSORED_VISIT", "The sponsored waiver states its reason.");
  assert(sponsored.receivable.plan === "STANDARD", "A sponsored standard clinic keeps its plan on the record.");
  assert(await accountBalance(env, "clinic_platform_fee_revenue") === revenueBefore, "A sponsored visit recognises no clinic fee revenue.");

  // The fund module owns the sponsorship record and may not be deployed yet.
  // Its absence must read as "not sponsored" rather than failing the billing
  // path — this database has no fund tables at all.
  assert((await isSponsoredVisit(env, "intake_standard")) === false, "A missing fund module means unsponsored, not an error.");
  assert((await isSponsoredVisit(env, "intake_standard", true)) === true, "An explicit sponsorship flag wins.");

  // The unsponsored version of the same clinic would have been billed $25 —
  // proving the zero came from sponsorship rather than from a missing price.
  const unsponsored = await visitFeeQuote(env, { tenantId: "ten_sponsor", isSponsored: false });
  assert(unsponsored.clinicFeeCents === 2500, "The same clinic is otherwise a standard $25.");
}

/* ═══════════════════════════════ invoicing and the failure ladder ═══ */

{
  const period = { periodStart: "2026-08-01T00:00:00Z", periodEnd: "2026-09-01T00:00:00Z" };
  const invoice = await buildMonthlyInvoice(env, { tenantId: "ten_standard", ...period, actorId: "admin_1" });
  assert(invoice.ok && invoice.invoice.totalCents === 2500, "The monthly invoice aggregates completed visits.");
  assert(invoice.invoice.lineCount === 1, "The invoice counts its lines.");
  assert(invoice.lines[0].intakeId === "intake_standard", "The invoice line references the immutable visit id.");

  const foundingInvoice = await buildMonthlyInvoice(env, { tenantId: "ten_founding", ...period });
  assert(foundingInvoice.ok && foundingInvoice.empty, "A founding clinic's month produces no invoice — and no $0 line to phone about.");

  const again = await buildMonthlyInvoice(env, { tenantId: "ten_standard", ...period });
  assert(again.ok && again.duplicate, "Rebuilding a period reuses the existing invoice rather than billing twice.");

  await markInvoiceSent(env, { invoiceId: invoice.invoice.id, stripeInvoiceId: "in_test_123", actorId: "admin_1" });

  // The failure ladder.
  assert(nextFailureState("DUE", 0, { retryAttempts: 3 }) === "RETRYING", "DUE fails to RETRYING.");
  assert(nextFailureState("RETRYING", 2, { retryAttempts: 3 }) === "PAST_DUE", "RETRYING exhausts to PAST_DUE.");
  assert(nextFailureState("RETRYING", 0, { retryAttempts: 3 }) === "RETRYING", "RETRYING stays until the attempts run out.");

  await recordInvoiceFailure(env, { invoiceId: invoice.invoice.id, error: "card_declined" });
  assert((await getClinicFeeReceivable(env, "intake_standard")).state === "RETRYING", "A failed collection moves the receivable to RETRYING.");
  await recordInvoiceFailure(env, { invoiceId: invoice.invoice.id, error: "card_declined" });
  await recordInvoiceFailure(env, { invoiceId: invoice.invoice.id, error: "card_declined" });
  assert((await getClinicFeeReceivable(env, "intake_standard")).state === "PAST_DUE", "Repeated failures reach PAST_DUE.");

  exec("UPDATE clinic_fee_receivables SET state = 'RESTRICTED' WHERE intake_id = 'intake_standard'");
  const standing = await clinicBillingRestricted(env, "ten_standard");
  assert(standing.restricted === true, "A restricted receivable restricts the clinic.");
  assert(standing.outstandingCents === 2500, "Outstanding debt is reported.");
  assert((await clinicBillingRestricted(env, "ten_founding")).restricted === false, "A founding clinic with only waivers is never restricted.");

  exec("UPDATE clinic_fee_receivables SET state = 'DUE' WHERE intake_id = 'intake_standard'");
  const paid = await markInvoicePaid(env, { invoiceId: invoice.invoice.id, actorId: "admin_1" });
  assert(paid.ok && paid.invoice.status === "PAID", "A paid invoice is marked paid.");
  assert((await getClinicFeeReceivable(env, "intake_standard")).state === "PAID", "Its receivables are settled.");
  assert(await accountBalance(env, "clinic_fee_receivable") === 0, "Payment relieves the receivable.");
  assert(await accountBalance(env, "processor_cash") === 2500, "Payment lands in processor cash.");
  const replay = await markInvoicePaid(env, { invoiceId: invoice.invoice.id });
  assert(replay.duplicate, "A redelivered payment event does not double-count cash.");
}

/* ═══════════════════════ clinic debt never touches restricted fund money ═══ */

{
  await assertThrows(
    async () => assertNoRestrictedOffset([
      { account: "fund_available", debit: 2500 },
      { account: "clinic_fee_receivable", credit: 2500 }
    ]),
    "Netting clinic debt against fund_available must be refused."
  );
  await assertThrows(
    async () => assertNoRestrictedOffset([
      { account: "clinic_payable", debit: 2500 },
      { account: "clinic_platform_fee_revenue", credit: 2500 }
    ]),
    "Netting a clinic fee against a clinic deposit payable must be refused."
  );
  assert(
    assertNoRestrictedOffset([
      { account: "processor_cash", debit: 2500 },
      { account: "clinic_fee_receivable", credit: 2500 }
    ]),
    "An ordinary collection posting is allowed."
  );

  // And nothing this module actually posted touched a restricted account.
  const restricted = database.prepare(`
    SELECT DISTINCT e.account_code
    FROM ledger_entries e
    JOIN ledger_transactions t ON t.id = e.transaction_id
    JOIN ledger_accounts a ON a.code = e.account_code
    WHERE a.restricted = 1
      AND t.kind IN ('clinic_fee_earned', 'clinic_fee_collected', 'adjustment')
  `).all();
  assert(restricted.length === 0, `Clinic billing posted to restricted account(s): ${restricted.map((r) => r.account_code).join(", ")}.`);

  const fundTouched = database.prepare(`
    SELECT COUNT(*) c FROM ledger_entries WHERE account_code IN ('fund_available', 'fund_reserved')
  `).get().c;
  assert(fundTouched === 0, "Clinic billing moved fund money.");

  const integrity = await ledgerIntegrity(env);
  assert(integrity.ok, `The ledger is unbalanced or a restricted account is negative: ${JSON.stringify(integrity)}.`);
}

/* -------------------------------------------------------------- done --- */

console.log(`clinic-billing-test: ${passed} assertions passed.`);
