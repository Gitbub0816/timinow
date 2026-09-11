/**
 * The embeddable widget's server half: tokens, Studio packages, and the one
 * public status endpoint.
 *
 * What matters here is the whitelist discipline (the status response must
 * carry exactly the fields the embed renders and nothing about the clinic),
 * the package rules (only the token's own tenant's packages apply; revoked
 * and foreign ones degrade to the default rather than erroring a clinic's
 * website), and the mandatory credit (poweredByLink is always sent, so every
 * embed's "Powered by Tími" has somewhere to point).
 */

import { applyMigrations } from "./lib/migrations.mjs";
import { DatabaseSync } from "node:sqlite";
import {
  handleCreateWidgetPackage,
  handleCreateWidgetToken,
  handleListWidgetPackages,
  handlePublicWidgetStatus,
  handleRevokeWidgetPackage,
  handleUpdateWidgetPackage,
  WIDGET_DESIGNS,
  WIDGET_ELEMENTS,
  WIDGET_VARIANTS
} from "../src/widget.js";

class D1StatementMock {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.values = [];
  }
  bind(...values) { this.values = values; return this; }
  async first() { return this.database.prepare(this.sql).get(...this.values) || null; }
  async all() { return { results: this.database.prepare(this.sql).all(...this.values), success: true }; }
  async run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid || 0) } };
  }
}

class D1Mock {
  constructor(database) { this.database = database; }
  prepare(sql) { return new D1StatementMock(this.database, sql); }
  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const database = new DatabaseSync(":memory:");
await applyMigrations(database);
const env = { DB: new D1Mock(database) };
const admin = { userId: "user_admin", role: "org:admin", authenticated: true };
const member = { userId: "user_member", role: "org:member", authenticated: true };

/* ---------------------------------------------------------------- seed --- */

database.prepare("INSERT INTO tenants (id, name, slug) VALUES ('tenant_w', 'Widget Vet', 'widget-vet'), ('tenant_other', 'Other Vet', 'other-vet')").run();
database.prepare(`
  INSERT INTO locations (id, tenant_id, name, slug, kind, address_line1, city, region, postal_code, phone, latitude, longitude, active)
  VALUES ('loc_w', 'tenant_w', 'Widget Clinic', 'widget-clinic', 'urgent', '1 Widget Way', 'Oakland', 'CA', '94601', '+15105550100', 37.6, -122.2, 1)
`).run();
const now = Date.now();
database.prepare(`
  INSERT INTO availability_reports (id, location_id, intake_status, accepts_critical, source, confidence, reported_at, expires_at)
  VALUES ('ar_w', 'loc_w', 'available', 1, 'hospital', 'high', ?, ?)
`).run(new Date(now - 5 * 60_000).toISOString(), new Date(now + 2 * 3_600_000).toISOString());
database.prepare(`
  INSERT INTO markets (id, name, slug, center_latitude, center_longitude, radius_km) VALUES ('market_eb', 'East Bay', 'east-bay', 37.67, -122.08, 40)
`).run();
database.prepare("UPDATE locations SET market_id = 'market_eb' WHERE id = 'loc_w'").run();

/* ------------------------------------------------------------- tokens --- */

const tokenRequest = new Request("https://timinow.pet/api/clinic/widget-tokens", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "Front page" })
});
const tokenResponse = await handleCreateWidgetToken(tokenRequest, env, admin, "tenant_w");
assert(tokenResponse.status === 201, "token creation succeeds for an admin");
const secret = (await tokenResponse.json()).token.secret;
assert(secret.startsWith("wgt_"), "the plaintext token is returned once");

/* ----------------------------------------------------------- packages --- */

const makePackage = (body, actor = admin, tenant = "tenant_w") => handleCreateWidgetPackage(
  new Request("https://x/api/clinic/widget-packages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  env, actor, tenant
);

const denied = await makePackage({ name: "Nope" }, member);
assert(denied.status === 403, "a non-admin cannot save a package");

const created = await makePackage({ name: "Sidebar poster", design: "poster", variant: "ink", size: "compact", elements: ["coverage", "donate", "reserve", "bogus"] });
assert(created.status === 201, "an admin saves a package");
const pkg = (await created.json()).package;
assert(pkg.id.startsWith("pkg_"), "package ids are pkg_-prefixed");
assert(pkg.design === "poster" && pkg.variant === "ink" && pkg.size === "compact", "the configuration round-trips");
assert(!pkg.elements.includes("bogus") && pkg.elements.length === 3, "unknown elements are dropped, known ones kept");

const junk = await makePackage({ name: "Junk", design: "marquee", variant: "neon", size: "billboard" });
const junkPkg = (await junk.json()).package;
assert(junkPkg.design === "card" && junkPkg.variant === "cream" && junkPkg.size === "standard",
  "unknown vocabulary degrades to defaults instead of failing");
assert(junkPkg.options.accent === "blue" && junkPkg.options.frame === "ink" && junkPkg.options.shadow === "hard",
  "a package saved without options gets the brand defaults");

// The fine-tuning layer (migration 0029) round-trips, and junk inside it
// degrades knob by knob.
const tuned = await makePackage({
  name: "Tuned", design: "poster", variant: "ink",
  options: { accent: "gold", corners: "pill", frame: "bold", shadow: "none", scale: "roomy", align: "center", heading: "Today at Hearthside", showFreshness: false, sparkles: "yes", corners2: "octagon" }
});
const tunedPkg = (await tuned.json()).package;
assert(tunedPkg.options.accent === "gold" && tunedPkg.options.corners === "pill" && tunedPkg.options.frame === "bold", "option vocabulary round-trips");
assert(tunedPkg.options.shadow === "none" && tunedPkg.options.scale === "roomy" && tunedPkg.options.align === "center", "…all six knobs");
assert(tunedPkg.options.heading === "Today at Hearthside" && tunedPkg.options.showFreshness === false, "heading and freshness toggle survive");
assert(tunedPkg.options.sparkles === undefined, "unknown option keys are dropped");

const updated = await handleUpdateWidgetPackage(
  new Request("https://x/", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ variant: "forest" }) }),
  env, admin, "tenant_w", pkg.id
);
assert((await updated.json()).package.variant === "forest", "PATCH updates only what it names");
assert((await (await handleListWidgetPackages(env, "tenant_w")).json()).packages.length === 3, "all three packages list");

/* -------------------------------------------------------- public status --- */

const statusRequest = (query = "") => new Request(`https://timinow.pet/api/widget/${encodeURIComponent(secret)}/status${query}`);

const plain = await (await handlePublicWidgetStatus(statusRequest(), env, secret)).json();
assert(plain.status === "accepting", `a fresh 'available' report reads accepting, got ${plain.status}`);
assert(plain.coverage === "East Bay", "coverage carries the market's display name");
assert(plain.poweredByLink && plain.poweredByLink.startsWith("https://timinow.pet"), "the mandatory credit always has a target");
assert(plain.donateLink === "https://timinow.pet/#paw-it-forward", "the donate element knows where the fund lives");
assert(plain.package === null, "no package requested, none returned");
// Whitelist discipline: exactly these keys, nothing about the clinic.
const allowed = ["status", "freshness", "link", "coverage", "donateLink", "poweredByLink", "package", "generatedAt"];
assert(Object.keys(plain).every((key) => allowed.includes(key)), `unexpected key in status payload: ${Object.keys(plain).join(",")}`);

const packaged = await (await handlePublicWidgetStatus(statusRequest(`?package=${pkg.id}&client=tenant_w`), env, secret)).json();
assert(packaged.package?.design === "poster" && packaged.package?.variant === "forest", "the tenant's own package resolves");
assert(packaged.package.elements.includes("donate"), "package elements survive");

const mismatch = await handlePublicWidgetStatus(statusRequest(`?client=tenant_other`), env, secret);
assert(mismatch.status === 404, "a client id from another tenant answers like an unknown token");

// A foreign tenant's package silently degrades — a stale copy-paste must
// never blank a clinic's website.
const foreignCreate = await makePackage({ name: "Foreign", design: "night" }, admin, "tenant_other");
const foreignPkg = (await foreignCreate.json()).package;
const foreign = await (await handlePublicWidgetStatus(statusRequest(`?package=${foreignPkg.id}`), env, secret)).json();
assert(foreign.package === null && foreign.status === "accepting", "a foreign package is ignored, status still answers");

const tunedResolved = await (await handlePublicWidgetStatus(statusRequest(`?package=${tunedPkg.id}`), env, secret)).json();
assert(tunedResolved.package?.options?.accent === "gold" && tunedResolved.package?.options?.heading === "Today at Hearthside",
  "the status endpoint carries the package's options to the embed");

await handleRevokeWidgetPackage(env, admin, "tenant_w", pkg.id);
const revoked = await (await handlePublicWidgetStatus(statusRequest(`?package=${pkg.id}`), env, secret)).json();
assert(revoked.package === null, "a revoked package no longer styles the embed");
assert(revoked.status === "accepting", "…but the clinic's status keeps rendering");

/* -------------------------------------------------- tenant isolation --- */
/* Two clinics, two tokens, opposite statuses, different markets: each
   token must answer with ITS clinic's data — this is the wiring that makes
   "each specific tenant gets the correct data to their widget" a tested
   fact rather than an intention. */

database.prepare(`
  INSERT INTO locations (id, tenant_id, name, slug, kind, address_line1, city, region, postal_code, phone, latitude, longitude, active)
  VALUES ('loc_other', 'tenant_other', 'Other Clinic', 'other-clinic', 'urgent', '9 Other Road', 'Denver', 'CO', '80202', '+13035550100', 39.74, -104.99, 1)
`).run();
database.prepare(`
  INSERT INTO availability_reports (id, location_id, intake_status, accepts_critical, source, confidence, reported_at, expires_at)
  VALUES ('ar_other', 'loc_other', 'diverting', 1, 'hospital', 'high', ?, ?)
`).run(new Date(now - 2 * 60_000).toISOString(), new Date(now + 2 * 3_600_000).toISOString());
database.prepare(`
  INSERT INTO markets (id, name, slug, center_latitude, center_longitude, radius_km) VALUES ('market_den', 'Denver Metro', 'denver-metro', 39.74, -104.99, 40)
`).run();
database.prepare("UPDATE locations SET market_id = 'market_den' WHERE id = 'loc_other'").run();

const otherTokenResponse = await handleCreateWidgetToken(
  new Request("https://timinow.pet/api/clinic/widget-tokens", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "Other" }) }),
  env, admin, "tenant_other"
);
const otherSecret = (await otherTokenResponse.json()).token.secret;

const mine = await (await handlePublicWidgetStatus(statusRequest(`?client=tenant_w`), env, secret)).json();
const theirs = await (await handlePublicWidgetStatus(
  new Request(`https://timinow.pet/api/widget/${encodeURIComponent(otherSecret)}/status?client=tenant_other`), env, otherSecret
)).json();
assert(mine.status === "accepting" && mine.coverage === "East Bay", "tenant_w's token reads tenant_w's clinic");
assert(theirs.status === "diverting" && theirs.coverage === "Denver Metro", "tenant_other's token reads tenant_other's clinic");
assert(mine.link !== theirs.link, "attribution links are per-token, never shared");

/* ------------------------------------------------------ embed contract --- */

// The vocabularies the Studio offers must be the ones the embed script
// renders — read the script's own source rather than trusting a copy.
import { readFile } from "node:fs/promises";
const embed = await readFile(new URL("../public/widget.js", import.meta.url), "utf8");
for (const design of WIDGET_DESIGNS) {
  assert(embed.includes(`${design}:`) || embed.includes(`"${design}"`), `embed script is missing design '${design}'`);
}
for (const variant of WIDGET_VARIANTS) {
  assert(embed.includes(`timi-w--${variant}`), `embed script is missing variant '${variant}'`);
}
for (const element of WIDGET_ELEMENTS) {
  assert(embed.includes(element), `embed script never reads element '${element}'`);
}
assert(/Powered by\s*"?\)?/.test(embed) && embed.includes("timi-w-powered"), "the Powered by Tími credit is rendered");
assert(!/innerHTML\s*=/.test(embed), "the embed script never assigns innerHTML");
assert(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(embed), "no emoji anywhere in the embed script");

console.log("Widget tests passed: admin-only token + package management, vocabulary degradation, the options layer round-trip (accent/corners/frame/shadow/scale/align/heading/freshness), tenant-scoped package resolution, client-id mismatch handling, revoked/foreign package fallback, the coverage field from the market map, two-tenant isolation (each token reads only its own clinic's status, market, and attribution link), the whitelisted status payload, and the embed script's own contract (all designs/variants/elements present, credit rendered, no innerHTML, no emoji).");
