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
  legalVersion: "2026-08-21"
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
await worker.scheduled(null, env, { waitUntil(promise) { scheduledWork = promise; } });
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
console.log("D1 end-to-end tests passed: five-offer search, atomic customer selection, clinic release, policy snapshot, deposit, travel, observation, expiry, and audit.");
