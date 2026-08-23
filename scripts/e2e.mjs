import { LEGAL_VERSION } from "../src/catalog.js";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.js";

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

result = await call("/api/clinic/call-preferences", { method: "PATCH", headers: clinicAdminHeaders, body: JSON.stringify({ callsEnabled: false }) });
assert(result.body.preferences.callsEnabled === false, "A clinic must be able to say no to the phone call");
const tenantRow = database.prepare("SELECT voice_calls_enabled FROM tenants WHERE id = 'tenant_hearth'").get();
const locationRow = database.prepare("SELECT voice_calls_enabled FROM locations WHERE tenant_id = 'tenant_hearth'").get();
assert(tenantRow.voice_calls_enabled === 0 && locationRow.voice_calls_enabled === 0, "Both levels must be set, since the gateway requires both to be on");

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
const chosenOffer = result.body.search.offers[2];
result = await call(`/api/searches/${careSearchId}/select-offer`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ offerId: chosenOffer.id })
});
assert(result.response.status === 201 && result.body.intake.status === "accepted", `Offer selection must create one confirmed intake: ${JSON.stringify(result.body)}`);
assert(result.body.intake.selectedOfferId === chosenOffer.id && result.body.intake.sourceSearchId === careSearchId, "The confirmed intake must retain search and offer provenance");
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

const tableChecks = ["tenants", "locations", "availability_reports", "tenant_policies", "intake_requests", "intake_events", "customer_observations", "notification_outbox", "care_searches", "care_search_targets", "care_offers"];
for (const table of tableChecks) {
  const count = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
  assert(count > 0, `${table} should contain end-to-end test data`);
}

database.close();
console.log("D1 end-to-end tests passed: five-offer search, atomic customer selection, clinic release, policy snapshot, deposit, travel, optional medications and allergies, veterinary-technician staffing notices, client error reporting, clinic calling preferences, observation, expiry, and audit.");
