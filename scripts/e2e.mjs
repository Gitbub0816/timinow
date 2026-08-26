import { LEGAL_VERSION, TIMI_CUSTOMER_FEE_CENTS, TIMI_TOTAL_SERVICE_FEE_CENTS } from "../src/catalog.js";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.js";
import vetWorker from "../apps/vet-web/src/index.js";
import adminWorker from "../apps/admin-console/src/index.js";

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

const database = new DatabaseSync(":memory:");
database.exec(await readFile("migrations/0001_initial.sql", "utf8"));
database.exec(await readFile("migrations/0002_seed.sql", "utf8"));
database.exec(await readFile("migrations/0003_multi_offer_search.sql", "utf8"));
database.exec(await readFile("migrations/0004_tenancy_admin.sql", "utf8"));
database.exec(await readFile("migrations/0005_voice_calls.sql", "utf8"));
database.exec(await readFile("migrations/0006_care_context.sql", "utf8"));
database.exec(await readFile("migrations/0007_client_errors.sql", "utf8"));
database.exec(await readFile("migrations/0008_payments_ledger.sql", "utf8"));
database.exec(await readFile("migrations/0009_pets.sql", "utf8"));
database.exec(await readFile("migrations/0010_provider_analytics.sql", "utf8"));
database.exec(await readFile("migrations/0011_call_policy.sql", "utf8"));
database.exec(await readFile("migrations/0012_pet_sex.sql", "utf8"));

const env = {
  ASSETS: { fetch: async () => new Response("asset") },
  DB: new D1Mock(database),
  SIGN_IN_REQUIRED: "false",
  DEMO_MODE: "true"
};

async function call(path, init = {}) {
  const response = await worker.fetch(new Request(`https://timi.example${path}`, init), env);
  const body = await response.json();
  return { response, body };
}

const intakePayload = {
  locationId: "loc_hearth",
  pet: { name: "Otis", species: "dog", breed: "Golden retriever", weightLbs: 72 },
  owner: { name: "Maya Morgan", phone: "(510) 555-0147", email: "maya@example.com" },
  concernCategory: "illness_or_injury",
  concernSummary: "Vomited three times this morning and will not drink.",
  symptoms: ["vomiting_or_diarrhea", "not_eating_or_drinking"],
  startedWhen: "today",
  urgency: "urgent",
  redFlags: [],
  customerLatitude: 37.6688,
  customerLongitude: -122.0808,
  travelMinutes: 12,
  consentToContact: true,
  legalConsent: true,
  legalVersion: LEGAL_VERSION
};

let result = await call("/api/locations?lat=37.6688&lng=-122.0808&species=dog&care=urgent");
assert(result.response.status === 200 && result.body.locations.length === 5, "D1 location search must return all seeded clinics");

/* -------------------------------------------------- public config: fees --- */

// The fee amounts are asserted twice over on purpose: against the constants,
// so this test can never disagree with the Worker, and against the literal
// dollar figures, because the numbers themselves are the commercial contract.
result = await call("/api/config");
assert(result.response.status === 200 && result.body.legalVersion === LEGAL_VERSION && result.body.legalVersion === "2026-08-24", "/api/config must serve legal version 2026-08-24, the one the Worker validates intakes against");
assert(result.body.fees?.customerFeeCents === TIMI_CUSTOMER_FEE_CENTS && result.body.fees.customerFeeCents === 2500, "/api/config must disclose the $25 customer fee");
assert(result.body.fees?.totalServiceFeeCents === TIMI_TOTAL_SERVICE_FEE_CENTS && result.body.fees.totalServiceFeeCents === 5000, "/api/config must disclose the $50 total service fee");
assert(result.body.fees?.currency === "usd", "The fee currency travels with the amounts");

result = await call("/api/intakes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...intakePayload, concernSummary: "My dog isn't acting like himself.", symptoms: ["energy_or_behavior"] }) });
assert(result.response.status === 422 && result.body.error.details.some((detail) => detail.includes("observable")), "Vague concern descriptions must be rejected without AI");

result = await call("/api/intakes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(intakePayload) });
assert(result.response.status === 201, `Immediate intake creation failed: ${JSON.stringify(result.body)}`);
assert(result.body.intake.status === "accepted", `Auto-accept location should create an accepted intake: ${JSON.stringify(result.body)}`);
assert(result.body.intake.policy.version === 1, "The tenant policy snapshot must be stored");
const acceptedId = result.body.intake.id;

result = await call(`/api/intakes/${acceptedId}/payment`, { method: "POST" });
assert(result.response.status === 201 && result.body.intake.paymentStatus === "paid", "Demo deposit must complete end to end");

result = await call(`/api/intakes/${acceptedId}/status`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "en_route" }) });
assert(result.body.intake.status === "en_route", "Customer must be able to mark an accepted intake en route");

result = await call("/api/observations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ intakeId: acceptedId, locationId: "loc_hearth", milestone: "arrived" }) });
assert(result.response.status === 201, "Arrival observation must be stored");

result = await call("/api/clinic/dashboard", { headers: { "x-demo-role": "clinic", "x-demo-tenant-id": "tenant_hearth" } });
assert(result.response.status === 200 && result.body.requests.some((item) => item.id === acceptedId), "Clinic dashboard must contain its intake");

/* ------------------------------ optional medications and allergies --- */

// Optional means optional: the intake above carried neither and was accepted.
// When they are given they must reach the clinic unchanged, because a
// paraphrased allergy is worse than none.
result = await call("/api/intakes", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    ...intakePayload,
    pet: { ...intakePayload.pet, medications: "Apoquel 5.4mg twice daily", allergies: "Penicillin — hives last spring" }
  })
});
assert(result.response.status === 201, `Medications and allergies must not block an intake: ${JSON.stringify(result.body)}`);
const medicalIntakeId = result.body.intake.id;
assert(result.body.intake.pet.medications === "Apoquel 5.4mg twice daily", "Medications must round-trip verbatim");
assert(result.body.intake.pet.allergies === "Penicillin — hives last spring", "Allergies must round-trip verbatim");

result = await call("/api/clinic/dashboard", { headers: { "x-demo-role": "clinic", "x-demo-tenant-id": "tenant_hearth" } });
const clinicView = result.body.requests.find((item) => item.id === medicalIntakeId);
assert(clinicView?.pet.allergies === "Penicillin — hives last spring", "The clinic must see the allergies the owner recorded");
assert(clinicView?.pet.medications === "Apoquel 5.4mg twice daily", "The clinic must see the medications the owner recorded");

/* -------------------------------------------- clinic call preferences --- */

// The columns have existed since the voice gateway shipped, with a note saying
// a console would expose them. None did, so every clinic has been on the
// default whether or not that is what they wanted.
const clinicHeaders = { "content-type": "application/json", "x-demo-role": "clinic", "x-demo-tenant-id": "tenant_hearth" };
// Changing them is an administrator's call; reading them is not.
const clinicAdminHeaders = { ...clinicHeaders, "x-demo-role": "org:admin" };
result = await call("/api/clinic/call-preferences", { headers: clinicHeaders });
assert(result.response.status === 200 && result.body.preferences.callsEnabled === true, "Calling defaults to on, as every clinic has been");
assert(result.body.preferences.callPolicy === "always", "The default policy is always — the pre-policy behavior");

result = await call("/api/clinic/call-preferences", { method: "PATCH", headers: clinicAdminHeaders, body: JSON.stringify({ callsEnabled: false }) });
assert(result.body.preferences.callsEnabled === false, "A clinic must be able to say no to the phone call");
assert(result.body.preferences.callPolicy === "never", "The legacy boolean off must map to the never policy, not sit beside it disagreeing");
const tenantRow = database.prepare("SELECT voice_calls_enabled, voice_call_policy FROM tenants WHERE id = 'tenant_hearth'").get();
const locationRow = database.prepare("SELECT voice_calls_enabled FROM locations WHERE tenant_id = 'tenant_hearth'").get();
assert(tenantRow.voice_calls_enabled === 0 && locationRow.voice_calls_enabled === 0, "Both levels must be set, since the gateway requires both to be on");
assert(tenantRow.voice_call_policy === "never", "The stored policy must match what the API reported");

// The three-way policy: ring only while a console is open.
result = await call("/api/clinic/call-preferences", { method: "PATCH", headers: clinicAdminHeaders, body: JSON.stringify({ callPolicy: "console_active" }) });
assert(result.body.preferences.callPolicy === "console_active", "A clinic must be able to ask for calls only while its console is open");
assert(result.body.preferences.callsEnabled === true, "console_active still counts as callable for pre-policy console builds");
result = await call("/api/clinic/call-preferences", { method: "PATCH", headers: clinicAdminHeaders, body: JSON.stringify({ callPolicy: "sometimes" }) });
assert(result.response.status === 422 && result.body.error.code === "INVALID_CALL_POLICY", "An unknown policy must be refused, not stored");

// The dashboard poll is what "the console is open" means; it must leave a
// timestamp behind for the voice gateway to read.
await call("/api/clinic/dashboard", { headers: clinicHeaders });
const presenceRow = database.prepare("SELECT console_last_seen_at FROM tenants WHERE id = 'tenant_hearth'").get();
assert(presenceRow.console_last_seen_at && !Number.isNaN(Date.parse(presenceRow.console_last_seen_at)), "A dashboard fetch must stamp console presence");

result = await call("/api/clinic/call-preferences", { method: "PATCH", headers: clinicAdminHeaders, body: JSON.stringify({ callsEnabled: true, voicePhone: "(510) 555-0199", quietHours: { start: "22:00", end: "07:00" } }) });
assert(result.body.preferences.voicePhone === "(510) 555-0199", "A back line must be dialable instead of the public number");
assert(result.body.preferences.quietHours.start === "22:00", "Quiet hours must round-trip");

// Half a window is not a window, and storing one means ignoring it at 3am.
result = await call("/api/clinic/call-preferences", { method: "PATCH", headers: clinicAdminHeaders, body: JSON.stringify({ quietHours: { start: "22:00", end: "" } }) });
assert(result.response.status === 422 && result.body.error.code === "INVALID_QUIET_HOURS", "A malformed quiet-hours window must be refused, not stored");

result = await call("/api/clinic/call-preferences", { method: "PATCH", headers: clinicAdminHeaders, body: JSON.stringify({ voicePhone: "nope" }) });
assert(result.response.status === 422 && result.body.error.code === "INVALID_PHONE", "A number Tími cannot dial must be refused at the door");

/* ----------------------------------------------- client error reports --- */

// The counterpart to the one sentence the apps now show. Accepted from anyone,
// including somebody who could not sign in, and never argued with.
result = await call("/api/client-errors", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    surface: "customer_ios", appVersion: "1.2.0", path: "/api/intakes/x/status",
    status: 401, code: "AUTHENTICATION_REQUIRED", message: "Sign in is required to continue.",
    reference: "K7MQ2B", detail: { route: "tracker" }
  })
});
assert(result.response.status === 202 && result.body.recorded === true, `A client error report must be accepted: ${JSON.stringify(result.body)}`);
const storedError = database.prepare("SELECT * FROM client_errors WHERE reference = 'K7MQ2B'").get();
assert(storedError, "The report must be stored where an operator can read it");
assert(storedError.status === 401 && storedError.code === "AUTHENTICATION_REQUIRED", "The detail must survive intact");
assert(storedError.fingerprint.includes("AUTHENTICATION_REQUIRED"), "Reports must group by fingerprint, not by message — a message carrying a record id makes every occurrence unique");

// A malformed report is accepted rather than argued with: a client that is
// already broken must not have to handle an error about its error.
result = await call("/api/client-errors", { method: "POST", headers: { "content-type": "application/json" }, body: "not json" });
assert(result.response.status === 202, "A malformed report must not produce an error response");

/* ------------------------------------- veterinary technician staffing --- */

// A provider a platform operator has marked technician-staffed must carry the
// scope-of-practice notice everywhere it is listed, worded by the Worker so no
// client can reword it.
database.prepare("UPDATE locations SET staffing_level = 'veterinary_technician', staffing_note = ? WHERE id = 'loc_juniper'")
  .run("A veterinarian is on call weekday evenings.");
result = await call("/api/locations?lat=37.6688&lng=-122.0808&species=dog&care=urgent");
const technicianRun = result.body.locations.find((item) => item.id === "loc_juniper");
const veterinarianRun = result.body.locations.find((item) => item.id === "loc_hearth");
assert(technicianRun?.staffingLevel === "veterinary_technician", "The staffing level must reach the client");
assert(/cannot diagnose, prognose, prescribe, or perform surgery/.test(technicianRun?.staffingNotice || ""), "A technician-staffed provider must carry the scope-of-practice notice");
assert(/on call weekday evenings/.test(technicianRun?.staffingNotice || ""), "The operator's own note must appear alongside the standard notice, not instead of it");
assert(veterinarianRun?.staffingNotice === null, "A veterinarian-staffed provider must carry no notice — a row written before the column existed is not 'unknown'");
database.prepare("UPDATE locations SET staffing_level = 'veterinarian', staffing_note = NULL WHERE id = 'loc_juniper'").run();

result = await call("/api/clinic/availability", {
  method: "POST",
  headers: { "content-type": "application/json", "x-demo-role": "clinic", "x-demo-tenant-id": "tenant_hearth" },
  body: JSON.stringify({ intakeStatus: "limited", stableWaitMin: 45, stableWaitMax: 80, capacityCount: 1, ttlMinutes: 30, acceptsCritical: false, note: "One stable intake available." })
});
assert(result.response.status === 201 && result.body.location.availability.intakeStatus === "limited", "Clinic live-status publication must update public capacity");

result = await call("/api/searches", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ...intakePayload, locationId: undefined, locationIds: ["loc_bayview", "loc_hearth", "loc_juniper", "loc_cedar", "loc_solano"], targetLimit: 30, radiusMiles: 50 })
});
assert(result.response.status === 201 && result.body.search.status === "collecting", `Multi-clinic search creation failed: ${JSON.stringify(result.body)}`);
const careSearchId = result.body.search.id;
const targets = database.prepare("SELECT id, tenant_id FROM care_search_targets WHERE search_id = ? ORDER BY rank").all(careSearchId);
assert(targets.length === 5, "A care search must fan out to every matching seeded clinic");
for (const [index, target] of targets.entries()) {
  result = await call(`/api/clinic/search-targets/${target.id}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-demo-role": "clinic", "x-demo-tenant-id": target.tenant_id },
    body: JSON.stringify({
      decision: "offer",
      responseType: index % 2 ? "available_now" : "emergency_intake",
      arrivalWindowMinutes: 20 + index * 5,
      holdMinutes: 5,
      waitMin: 10 + index * 5,
      waitMax: 25 + index * 5,
      note: `Offer ${index + 1} is ready for comparison.`
    })
  });
  assert(result.response.status === 200, `Clinic ${target.tenant_id} could not submit an offer: ${JSON.stringify(result.body)}`);
}
result = await call(`/api/searches/${careSearchId}`);
assert(result.response.status === 200 && result.body.search.status === "offers_ready", "The search must become ready after five clinic offers");
assert(result.body.search.offers.length === 5, "The customer must receive exactly five comparable active offers");

// Nothing to drive to for free. Every offer still being compared must not
// leak the address, phone, or exact name a customer could use to bypass
// Tími's fee and go straight to the clinic without ever paying.
for (const offer of result.body.search.offers) {
  assert(offer.location.address === undefined, `An unselected offer must not disclose an address: ${JSON.stringify(offer.location)}`);
  assert(offer.location.phone === undefined, `An unselected offer must not disclose a phone number: ${JSON.stringify(offer.location)}`);
  assert(offer.location.latitude === undefined && offer.location.longitude === undefined, "An unselected offer must not disclose exact coordinates");
  assert(/ in .+/.test(offer.location.name), `A masked offer's name must read as a general area, not a specific business: ${offer.location.name}`);
  assert(offer.location.distanceMiles !== undefined, "A masked offer must still disclose distance — that is what comparing offers means");
}

const chosenOffer = result.body.search.offers[2];
result = await call(`/api/searches/${careSearchId}/select-offer`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ offerId: chosenOffer.id })
});
assert(result.response.status === 201 && result.body.intake.status === "accepted", `Offer selection must create one confirmed intake: ${JSON.stringify(result.body)}`);
assert(result.body.intake.selectedOfferId === chosenOffer.id && result.body.intake.sourceSearchId === careSearchId, "The confirmed intake must retain search and offer provenance");

// The clinic actually chosen (and paid for) must reveal its real address —
// there is no navigating there otherwise, and the fee has been committed to.
assert(typeof result.body.location.address === "string" && result.body.location.address.length > 0, "The selected offer's clinic must reveal its real address for navigation");
assert(typeof result.body.location.phone === "string" && result.body.location.phone.length > 0, "The selected offer's clinic must reveal a real phone number");
assert(typeof result.body.location.latitude === "number", "The selected offer's clinic must reveal exact coordinates for navigation");

result = await call(`/api/searches/${careSearchId}`);
// Released offers drop out of the query entirely (status filters to
// 'active'/'selected'), so the only offer left to see is the one paid for.
assert(result.body.search.offers.length === 1 && result.body.search.offers[0].id === chosenOffer.id, "Only the selected offer should remain visible after selection");
assert(typeof result.body.search.offers[0].location.address === "string", "A selected offer must keep reporting its real address once chosen, not just in the one-time selection response");
assert(database.prepare("SELECT COUNT(*) AS count FROM care_offers WHERE search_id = ? AND status = 'selected'").get(careSearchId).count === 1, "Exactly one offer must be selected");
assert(database.prepare("SELECT COUNT(*) AS count FROM care_offers WHERE search_id = ? AND status = 'released'").get(careSearchId).count === 4, "Every unchosen offer must be released");
assert(database.prepare("SELECT COUNT(*) AS count FROM care_search_targets WHERE search_id = ? AND status = 'selected'").get(careSearchId).count === 1, "Exactly one clinic target must be confirmed");
assert(database.prepare("SELECT COUNT(*) AS count FROM care_search_targets WHERE search_id = ? AND status = 'released'").get(careSearchId).count === 4, "All other clinic targets must be released");

result = await call("/api/intakes", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ...intakePayload, locationId: "loc_bayview", urgency: "emergency", concernSummary: "Possible toxin exposure ten minutes ago.", redFlags: ["possible toxin exposure"] })
});
assert(result.response.status === 201 && result.body.intake.status === "pending", "Emergency hospital request should wait for explicit confirmation");
const pendingId = result.body.intake.id;

result = await call(`/api/clinic/intakes/${pendingId}/decision`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-demo-role": "clinic", "x-demo-tenant-id": "tenant_bayview" },
  body: JSON.stringify({ decision: "accept", arrivalWindowMinutes: 20, note: "Come directly to the emergency entrance." })
});
assert(result.response.status === 200 && result.body.intake.status === "accepted" && result.body.intake.arrivalBy, "Clinic decision must create an arrival window");

result = await call("/api/intakes", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ...intakePayload, locationId: "loc_bayview", concernSummary: "Persistent diarrhea six times today but still currently alert.", urgency: "urgent", redFlags: [] })
});
const expiringId = result.body.intake.id;
database.prepare("UPDATE intake_requests SET request_expires_at = datetime('now', '-1 minute') WHERE id = ?").run(expiringId);
database.prepare("UPDATE intake_requests SET arrival_by = datetime('now', '-30 minutes') WHERE id = ?").run(pendingId);
let scheduledWork;
// Collect every waitUntil, not just the last one — the scheduled handler
// registers more than one piece of background work, and awaiting whichever
// happened to be registered last is how this test would silently stop covering
// the expiry sweep.
const scheduledPromises = [];
await worker.scheduled(null, env, { waitUntil(promise) { scheduledPromises.push(promise); } });
scheduledWork = Promise.all(scheduledPromises);
await scheduledWork;
const expiredRow = database.prepare("SELECT status FROM intake_requests WHERE id = ?").get(expiringId);
const noShowRow = database.prepare("SELECT status FROM intake_requests WHERE id = ?").get(pendingId);
assert(expiredRow.status === "expired", "Scheduled cleanup must expire unanswered requests");
assert(noShowRow.status === "no_show", "Scheduled cleanup must close elapsed arrival windows");
assert(database.prepare("SELECT COUNT(*) AS count FROM intake_events WHERE intake_id = ? AND event_type = 'expired'").get(expiringId).count === 1, "Scheduled expiry must be audited");
assert(database.prepare("SELECT COUNT(*) AS count FROM intake_events WHERE intake_id = ? AND event_type = 'no_show'").get(pendingId).count === 1, "Scheduled no-show must be audited");

/* ------------------------------------------------ pets on the account --- */

// Pets lived in the phone's UserDefaults and nowhere else, which made them a
// property of a device rather than of an account: reinstall, new phone, or a
// second one, and they were gone. Every assertion below is a way that used to
// go wrong.
const maya = { "content-type": "application/json", "x-demo-user-id": "user_maya" };
const dev = { "content-type": "application/json", "x-demo-user-id": "user_dev" };

const otis = {
  id: "pet_otis_local", name: "Otis", species: "dog", breed: "Golden retriever",
  sex: "male", weightLbs: 72, birthYear: 2019, colorToken: 1,
  medications: "Apoquel 5.4mg twice daily", allergies: "Penicillin"
};

result = await call("/api/pets", { headers: maya });
assert(result.response.status === 200 && result.body.pets.length === 0, "A new account starts with no pets");

result = await call(`/api/pets/${otis.id}`, { method: "PUT", headers: maya, body: JSON.stringify(otis) });
assert(result.response.status === 200, "Saving a pet must succeed");
assert(result.body.pet.id === otis.id, "The client's pet id is the id the account keeps");
assert(result.body.pet.medications === "Apoquel 5.4mg twice daily", "Medications must round-trip verbatim");
assert(result.body.pet.colorToken === 1, "The card colour travels with the pet");
assert(result.body.pet.sex === "male", "Sex must round-trip");

// Sex is optional but never freeform.
result = await call(`/api/pets/${otis.id}`, { method: "PUT", headers: maya, body: JSON.stringify({ ...otis, sex: "boy" }) });
assert(result.response.status === 422 && result.body.error.code === "INVALID_SEX", "A freeform sex value is refused, not stored");
result = await call(`/api/pets/${otis.id}`, { method: "PUT", headers: maya, body: JSON.stringify({ ...otis, sex: "" }) });
assert(result.response.status === 200 && result.body.pet.sex === "", "Leaving sex out is always allowed");
result = await call(`/api/pets/${otis.id}`, { method: "PUT", headers: maya, body: JSON.stringify(otis) });
assert(result.body.pet.sex === "male", "Restoring the full record keeps sex");

// The reinstall case, which is the whole point.
result = await call("/api/pets", { headers: maya });
assert(result.body.pets.length === 1 && result.body.pets[0].name === "Otis", "A fresh device reads the account's pets");

// Editing writes through rather than adding a second animal with the same name.
result = await call(`/api/pets/${otis.id}`, {
  method: "PUT", headers: maya, body: JSON.stringify({ ...otis, name: "Otis Jr", weightLbs: 74 })
});
assert(result.response.status === 200 && result.body.pet.name === "Otis Jr", "Saving an existing id edits it");
result = await call("/api/pets", { headers: maya });
assert(result.body.pets.length === 1, "Editing must not create a duplicate");

// Somebody else must not be able to write to a pet id they happen to know.
result = await call(`/api/pets/${otis.id}`, {
  method: "PUT", headers: dev, body: JSON.stringify({ ...otis, name: "Stolen" })
});
assert(result.response.status === 409, "A pet id belonging to another account is refused");
result = await call("/api/pets", { headers: maya });
assert(result.body.pets[0].name === "Otis Jr", "A refused write must not have changed anything");
result = await call("/api/pets", { headers: dev });
assert(result.body.pets.length === 0, "Pets are never visible to another account");

// The upgrade case: a phone holding pets that the account has never seen.
result = await call("/api/pets/sync", {
  method: "POST", headers: maya,
  body: JSON.stringify({ pets: [
    { ...otis, name: "Stale local copy" },
    { id: "pet_luna_local", name: "Luna", species: "cat", colorToken: 0 }
  ] })
});
assert(result.response.status === 200, "Sync must succeed");
assert(result.body.pets.length === 2, "Sync stores local pets the account has never seen");
const synced = result.body.pets.find((pet) => pet.id === otis.id);
assert(synced.name === "Otis Jr", "A stored pet wins over a stale local copy of itself");

// Deleting has to stick across devices, which is why it is a soft delete: a
// row that is simply gone cannot tell a second phone that anything happened.
result = await call(`/api/pets/${otis.id}`, { method: "DELETE", headers: maya });
assert(result.response.status === 200 && result.body.removed === true, "Deleting a pet must report it");
result = await call("/api/pets", { headers: maya });
assert(result.body.pets.length === 1 && result.body.pets[0].id === "pet_luna_local", "A deleted pet leaves the list");

result = await call(`/api/pets/${otis.id}`, { method: "DELETE", headers: maya });
assert(result.response.status === 200 && result.body.removed === false, "Deleting twice is not an error");

// The bug this guards: a sync from a phone that still holds the deleted pet
// must not bring it back, or a delete could never stick on more than one
// device.
result = await call("/api/pets/sync", {
  method: "POST", headers: maya, body: JSON.stringify({ pets: [otis] })
});
assert(result.body.pets.length === 1, "Sync must not resurrect a pet deleted on another device");

// Nonsense is refused with a reason rather than stored.
result = await call("/api/pets/pet_bad", {
  method: "PUT", headers: maya, body: JSON.stringify({ name: "Rex", species: "dragon" })
});
assert(result.response.status === 422 && result.body.error.code === "INVALID_SPECIES", "An unsupported species is refused");
result = await call("/api/pets/pet_bad", {
  method: "PUT", headers: maya, body: JSON.stringify({ name: "", species: "dog" })
});
assert(result.response.status === 422 && result.body.error.code === "PET_NAME_REQUIRED", "A nameless pet is refused");
result = await call("/api/pets/pet_bad", {
  method: "PUT", headers: maya, body: JSON.stringify({ name: "Rex", species: "dog", weightLbs: 9000 })
});
assert(result.response.status === 422 && result.body.error.code === "INVALID_WEIGHT", "An impossible weight is refused");

/* ------------------------------------------------ provider applications --- */

// Public on purpose: the practices Tími most wants to hear from have no
// account, no organization, and no tenant — that is why they are applying.
// The admin console is the only reader.
const applicationPayload = {
  practiceName: "Redwood Trail Veterinary Clinic",
  contactName: "Dr. Priya Raman",
  email: "priya@redwoodtrailvet.example",
  phone: "(510) 555-0142",
  city: "Oakland",
  state: "CA",
  species: "dogs, cats, rabbits",
  message: "Two DVMs, open until 10pm on weekdays."
};
const jsonHeaders = { "content-type": "application/json" };
result = await call("/api/provider-applications", { method: "POST", headers: jsonHeaders, body: JSON.stringify(applicationPayload) });
assert(result.response.status === 201 && result.body.application.status === "new", `A provider application must land as new: ${JSON.stringify(result.body)}`);
const applicationId = result.body.application.id;

// Refused rather than truncated: a practice name cut mid-word is a worse
// record than a form asking to shorten it.
result = await call("/api/provider-applications", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ ...applicationPayload, email: "not-an-email" }) });
assert(result.response.status === 422, "A malformed email must be refused");
result = await call("/api/provider-applications", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ ...applicationPayload, phone: "nope" }) });
assert(result.response.status === 422, "A phone Tími could never dial back must be refused");
result = await call("/api/provider-applications", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ ...applicationPayload, practiceName: "x".repeat(121) }) });
assert(result.response.status === 422, "An over-length practice name must be refused, not truncated");
result = await call("/api/provider-applications", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ ...applicationPayload, message: "x".repeat(1001) }) });
assert(result.response.status === 422, "An over-length message must be refused");
result = await call("/api/provider-applications", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ practiceName: "Nameless" }) });
assert(result.response.status === 422 && result.body.error.details.length >= 4, "Missing required fields must all be named at once, not one 422 per retry");

// The operator side, gated by the same platform-admin check as every other
// /api/admin route.
const adminEnv = { ...env, SURFACE: "admin", PLATFORM_ADMIN_USER_IDS: "user_operator" };
const operatorHeaders = { "content-type": "application/json", "x-demo-user-id": "user_operator" };
async function adminCall(path, init = {}) {
  const response = await adminWorker.fetch(new Request(`https://admin.timi.example${path}`, init), adminEnv);
  return { response, body: await response.json() };
}

result = await adminCall("/api/admin/provider-applications", { headers: operatorHeaders });
assert(result.response.status === 200 && result.body.applications[0]?.id === applicationId, "The operator list is newest first and contains the application");
assert(result.body.applications[0].practiceName === applicationPayload.practiceName && result.body.applications[0].message === applicationPayload.message, "The operator reads exactly what the practice typed");
result = await adminCall("/api/admin/provider-applications", { headers: { ...operatorHeaders, "x-demo-user-id": "user_random" } });
assert(result.response.status === 403, "A non-operator must not read applications");

result = await adminCall(`/api/admin/provider-applications/${applicationId}`, { method: "PATCH", headers: operatorHeaders, body: JSON.stringify({ status: "contacted" }) });
assert(result.response.status === 200 && result.body.application.status === "contacted", "An operator can mark an application contacted");
result = await adminCall(`/api/admin/provider-applications/${applicationId}`, { method: "PATCH", headers: operatorHeaders, body: JSON.stringify({ status: "spam" }) });
assert(result.response.status === 422, "An unknown status must be refused, not stored");
result = await adminCall("/api/admin/provider-applications/application_missing", { method: "PATCH", headers: operatorHeaders, body: JSON.stringify({ status: "closed" }) });
assert(result.response.status === 404, "A missing application answers 404");

/* -------------------------------------------------------------- analytics --- */

// The privacy contract is tested where it matters: on the rows. No raw IP, no
// raw user agent, and a visitor value that is the same for the same
// ip/ua/day, different for a different ip, and never the ip itself.
const uaDesktop = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const uaMobile = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const beacon = (events, headers = {}) => call("/api/analytics", {
  method: "POST",
  headers: { ...jsonHeaders, ...headers },
  body: JSON.stringify({ events })
});

result = await beacon(
  [{ name: "page_view", path: "/find?species=dog&owner=maya@example.com", meta: { screen: "find" } }, { name: "search_started" }],
  { "user-agent": uaDesktop, "cf-connecting-ip": "203.0.113.7" }
);
assert(result.response.status === 202, `The beacon must be acknowledged: ${JSON.stringify(result.body)}`);
result = await beacon([{ name: "page_view", path: "/results" }], { "user-agent": uaDesktop, "cf-connecting-ip": "203.0.113.7" });
assert(result.response.status === 202, "A second beacon from the same visitor must be acknowledged");
result = await beacon([{ name: "page_view", path: "/find" }], { "user-agent": uaMobile, "cf-connecting-ip": "198.51.100.4" });
assert(result.response.status === 202, "A mobile beacon must be acknowledged");

const analyticsRows = database.prepare("SELECT * FROM analytics_events").all();
assert(analyticsRows.length === 4, `Four events should be stored so far, got ${analyticsRows.length}`);
for (const row of analyticsRows) {
  const serialized = JSON.stringify(row);
  assert(!serialized.includes("203.0.113.7") && !serialized.includes("198.51.100.4"), "No raw IP address may ever be stored");
  assert(!serialized.includes("Mozilla"), "No raw user agent may ever be stored");
  assert(/^[0-9a-f]{16}$/.test(row.visitor_hash), "visitor_hash is 16 hex characters of a SHA-256, nothing else");
  assert(row.surface === "customer", "The surface is the Worker's own identity, never the client's claim");
  assert(row.occurred_at && row.visitor_hash !== "203.0.113.7", "The visitor value must never equal the raw ip");
}
const desktopHashes = new Set(analyticsRows.filter((row) => row.device === "desktop").map((row) => row.visitor_hash));
assert(desktopHashes.size === 1, "The same ip, user agent and day must hash to the same visitor");
const mobileRow = analyticsRows.find((row) => row.device === "mobile");
assert(mobileRow && !desktopHashes.has(mobileRow.visitor_hash), "A different ip must hash to a different visitor");
assert(!analyticsRows.some((row) => (row.path || "").includes("?") || (row.path || "").includes("maya@")), "Query strings are stripped before the row exists — a query is where an email lands in a URL");
assert(analyticsRows.some((row) => JSON.parse(row.meta_json).screen === "find"), "Flat string meta must round-trip");

// The two refusals that mean a client bug worth hearing about…
result = await beacon(Array.from({ length: 26 }, (_, index) => ({ name: `event_${index}` })));
assert(result.response.status === 422 && result.body.error.code === "TOO_MANY_EVENTS", "A 26th event in one batch must be refused");
result = await beacon([{ name: "bad name!" }]);
assert(result.response.status === 422 && result.body.error.code === "INVALID_EVENT_NAME", "A name outside the allowed alphabet must be refused");
// …and everything else fails soft: a broken beacon must never break a page.
result = await call("/api/analytics", { method: "POST", headers: jsonHeaders, body: "not json" });
assert(result.response.status === 202, "A malformed beacon is acknowledged and dropped, never argued with");

// The same beacon mounts on all three Workers, and each stores its own surface.
async function beaconVia(surfaceWorker, surfaceEnv, headers, events) {
  const response = await surfaceWorker.fetch(new Request("https://surface.timi.example/api/analytics", {
    method: "POST", headers: { ...jsonHeaders, ...headers }, body: JSON.stringify({ events })
  }), surfaceEnv);
  return { response, body: await response.json() };
}
result = await beaconVia(vetWorker, { ...env, SURFACE: "clinic" }, { "user-agent": uaDesktop, "cf-connecting-ip": "192.0.2.9" }, [{ name: "dashboard_view", path: "/" }]);
assert(result.response.status === 202, "The veterinary Worker must take the same beacon");
result = await beaconVia(adminWorker, adminEnv, { "user-agent": uaDesktop, "cf-connecting-ip": "203.0.113.7" }, [{ name: "console_view", path: "/" }]);
assert(result.response.status === 202, "The admin Worker must take the same beacon");
assert(database.prepare("SELECT COUNT(*) AS c FROM analytics_events WHERE surface = 'clinic'").get().c === 1, "The clinic surface records as clinic");
assert(database.prepare("SELECT COUNT(*) AS c FROM analytics_events WHERE surface = 'admin'").get().c === 1, "The admin surface records as admin");

// The operator summary, and its arithmetic: 6 events today from 3 distinct
// visitors (the admin beacon reused the desktop visitor's ip and user agent,
// which must dedupe — the hash is per person per day, not per surface).
result = await adminCall("/api/admin/analytics/summary?days=7", { headers: operatorHeaders });
assert(result.response.status === 200, `The summary must be readable by an operator: ${JSON.stringify(result.body)}`);
const today = new Date().toISOString().slice(0, 10);
const todayRow = result.body.days.find((row) => row.date === today);
assert(todayRow && todayRow.events === 6 && todayRow.visitors === 3, `Today must count 6 events from 3 visitors: ${JSON.stringify(result.body.days)}`);
assert(result.body.names.find((row) => row.name === "page_view")?.count === 3, "page_view happened three times");
assert(result.body.paths.find((row) => row.path === "/find")?.count === 2, "/find was visited twice, query strings collapsed");
const surfaceSummary = Object.fromEntries(result.body.surfaces.map((row) => [row.surface, row]));
assert(surfaceSummary.customer?.events === 4 && surfaceSummary.customer?.visitors === 2, `The customer surface counts 4 events from 2 visitors: ${JSON.stringify(result.body.surfaces)}`);
assert(surfaceSummary.clinic?.events === 1 && surfaceSummary.admin?.events === 1, "The console surfaces each count their event");
result = await adminCall("/api/admin/analytics/summary", { headers: { ...operatorHeaders, "x-demo-user-id": "user_random" } });
assert(result.response.status === 403, "The summary sits behind the platform-admin gate");

const tableChecks = ["tenants", "locations", "availability_reports", "tenant_policies", "intake_requests", "intake_events", "customer_observations", "notification_outbox", "care_searches", "care_search_targets", "care_offers", "pets", "provider_applications", "analytics_events"];
for (const table of tableChecks) {
  const count = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
  assert(count > 0, `${table} should contain end-to-end test data`);
}

database.close();
console.log("D1 end-to-end tests passed: five-offer search with masked clinic details until selection, atomic customer selection, clinic release, policy snapshot, deposit, fee disclosure on /api/config, travel, optional medications and allergies, pets on the account, veterinary-technician staffing notices, client error reporting, clinic calling preferences, provider applications with operator triage, privacy-preserving analytics with the operator summary, observation, expiry, and audit.");
