import { LEGAL_VERSION } from "../src/catalog.js";
import worker from "../src/index.js";

const assets = { fetch: async () => new Response("asset", { status: 200 }) };

async function call(path, init = {}, env = {}) {
  const request = new Request(`https://timi.example${path}`, init);
  return worker.fetch(request, { ASSETS: assets, SIGN_IN_REQUIRED: "false", DEMO_MODE: "true", ...env });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let response = await call("/api/health");
assert(response.status === 200, "Health route must return 200");
let body = await response.json();
assert(body.ok === true && body.database === false, "Health route must describe fixture mode");

response = await call("/api/config");
body = await response.json();
assert(body.signInRequired === false, "Sign-in must be disabled unless the flag exactly equals true");

response = await call("/api/config", {}, { SIGN_IN_REQUIRED: "TRUE" });
body = await response.json();
assert(body.signInRequired === false, "SIGN_IN_REQUIRED is case-sensitive by design");

response = await call("/api/locations?lat=37.6688&lng=-122.0808&species=dog&care=urgent");
body = await response.json();
assert(response.status === 200 && body.locations.length >= 2, "Fixture search must return nearby care");
assert(body.locations.every((location) => location.availability.label), "Every result must have a public availability label");

response = await call("/api/intakes", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    locationId: "loc_hearth",
    pet: { name: "Otis", species: "dog", breed: "Golden retriever", weightLbs: 72 },
    owner: { name: "Maya Morgan", phone: "(510) 555-0147", email: "maya@example.com" },
    concernCategory: "illness_or_injury",
    concernSummary: "Vomited several times this morning and refused water.",
    symptoms: ["vomiting_or_diarrhea"],
    startedWhen: "today",
    urgency: "urgent",
    travelMinutes: 12,
    consentToContact: true,
    legalConsent: true,
    legalVersion: LEGAL_VERSION
  })
});
body = await response.json();
assert(response.status === 201 && body.demo === true, "Zero-configuration demo must accept a fixture intake");
assert(body.intake.status === "accepted" && body.intake.id.startsWith("demo_"), "Fixture auto-accept must return a usable demo intake");

response = await call("/api/searches", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    locationIds: ["loc_bayview", "loc_hearth", "loc_juniper", "loc_cedar", "loc_solano"],
    targetLimit: 30,
    radiusMiles: 50,
    pet: { name: "Otis", species: "dog", breed: "Golden retriever", weightLbs: 72 },
    owner: { name: "Maya Morgan", phone: "(510) 555-0147", email: "maya@example.com" },
    concernCategory: "illness_or_injury",
    concernSummary: "Vomited several times this morning and refused water.",
    symptoms: ["vomiting_or_diarrhea"],
    startedWhen: "today",
    urgency: "urgent",
    customerLatitude: 37.6688,
    customerLongitude: -122.0808,
    consentToContact: true,
    legalConsent: true,
    legalVersion: LEGAL_VERSION
  })
});
body = await response.json();
assert(response.status === 201 && body.search.offers.length === 5, "Zero-configuration demo must return five clinic offers for comparison");

response = await call("/api/clinic/dashboard", { headers: { "x-demo-role": "clinic", "x-demo-tenant-id": "tenant_hearth" } });
body = await response.json();
assert(response.status === 200 && body.requests.some((request) => request.id === "demo_clinic_request"), "Fixture clinic console must include an actionable request");

response = await call("/api/clinic/availability", {
  method: "POST",
  headers: { "content-type": "application/json", "x-demo-role": "clinic", "x-demo-tenant-id": "tenant_hearth" },
  body: JSON.stringify({ intakeStatus: "limited", stableWaitMin: 25, stableWaitMax: 45, capacityCount: 2, ttlMinutes: 30, acceptsCritical: false })
});
body = await response.json();
assert(response.status === 201 && body.demo === true && body.location.availability.intakeStatus === "limited", "Fixture clinic capacity must be publishable");

// A pet owner must be able to start an intake as a guest — no Clerk account —
// even in production, where SIGN_IN_REQUIRED is always "true"
// (docs/PLATFORM-CONTRACT.md). The request still has to pass ordinary
// validation; only the *authentication* requirement is gone. See
// src/guest-session.js.
response = await call("/api/intakes", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, { SIGN_IN_REQUIRED: "true" });
body = await response.json();
assert(response.status === 422 && body.error.code === "VALIDATION_FAILED", "A guest's intake must be validated, not rejected for lacking a Clerk session");

// Clinic routes are the one surface a guest identity must never satisfy —
// they still require either a signed-in org member or a workstation session
// (src/workstation.js), neither of which a bare guest visitor has.
response = await call("/api/clinic/dashboard", {}, { SIGN_IN_REQUIRED: "true" });
assert(response.status === 403, "Clinic routes must still refuse a plain guest, even though SIGN_IN_REQUIRED no longer blocks them at the door");

response = await call("/api/does-not-exist");
assert(response.status === 404, "Unknown API paths must return 404");

console.log("Worker smoke tests passed: health, config gate, availability fixtures, zero-config intake, clinic demo, guest checkout, clinic auth enforcement, and 404 handling.");
