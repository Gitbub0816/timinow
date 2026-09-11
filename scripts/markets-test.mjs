/**
 * Markets: drawn boundaries and point resolution.
 *
 * The polygon containment test decides which market every care search is
 * attributed to and which clinics a territory suggests — geometry bugs here
 * are silent misattribution in production, so the shapes are exercised
 * directly: a triangle over the East Bay, a ring with a hole, a MultiPolygon,
 * and the circle fallback the migration guarantees for existing rows.
 */

import { applyMigrations } from "./lib/migrations.mjs";
import { DatabaseSync } from "node:sqlite";
import {
  createMarket,
  getMarket,
  listUnassignedLocations,
  marketContains,
  nearestContainingMarket,
  resolveSearchMarket,
  updateMarket
} from "../src/markets.js";

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
await applyMigrations(database);
const env = { DB: new D1Mock(database) };
const actor = { userId: "user_admin", authenticated: true };
// The platform-admin gate is exercised by tenancy-test; here the admin is
// simply allowed so the geometry is what is under test.
database.prepare("INSERT INTO platform_admins (clerk_user_id, email, label) VALUES (?, ?, ?)").run("user_admin", "admin@test", "test");

/* ------------------------------------------------------- circle markets --- */

const eastBay = await createMarket(env, actor, {
  name: "East Bay", centerLatitude: 37.67, centerLongitude: -122.08, radiusKm: 30
});
assert(eastBay.status === 201, `create market: ${JSON.stringify(eastBay)}`);
const eastBayId = eastBay.body.market.id;
assert(eastBay.body.market.boundaryKind === "circle", "a market without a drawn boundary is a circle");
assert(eastBay.body.market.boundaryGeojson === null, "no geometry stored for a circle market");

assert(marketContains(eastBay.body.market, 37.7, -122.1), "a point 5km from center is inside a 30km circle");
assert(!marketContains(eastBay.body.market, 38.5, -122.1), "a point 90km north is outside");

/* ------------------------------------------------------ drawn boundary --- */

// A triangle whose bounding box CONTAINS a point the triangle itself does
// not — the classic ray-cast regression. Vertices (lng, lat): the triangle
// covers the area south of the diagonal; (37.79, -121.91) sits in the box's
// north-east corner, outside the hypotenuse.
const triangle = {
  type: "Polygon",
  coordinates: [[[-122.2, 37.6], [-121.9, 37.6], [-122.2, 37.8], [-122.2, 37.6]]]
};
const updated = await updateMarket(env, actor, eastBayId, { boundaryGeojson: triangle });
assert(updated.status === 200, `update boundary: ${JSON.stringify(updated)}`);
assert(updated.body.market.boundaryKind === "polygon", "storing a geometry makes the market a polygon");
assert(updated.body.market.boundaryGeojson.type === "Polygon", "the geometry round-trips");

const asStored = await getMarket(env, eastBayId);
assert(marketContains(asStored, 37.65, -122.15), "a point inside the triangle is in");
assert(!marketContains(asStored, 37.79, -121.91), "inside the bbox but outside the triangle is OUT");
assert(!marketContains(asStored, 37.65, -121.5), "outside the bbox short-circuits to out");
// The circle no longer answers: this point is within 30km of center but
// outside the drawn lines.
assert(!marketContains(asStored, 37.9, -122.08), "the polygon replaces the circle, not augments it");

/* ------------------------------------------------------------- a hole --- */

const donut = {
  type: "Polygon",
  coordinates: [
    [[-122.3, 37.5], [-121.8, 37.5], [-121.8, 37.9], [-122.3, 37.9], [-122.3, 37.5]],
    [[-122.15, 37.65], [-122.0, 37.65], [-122.0, 37.75], [-122.15, 37.75], [-122.15, 37.65]]
  ]
};
await updateMarket(env, actor, eastBayId, { boundaryGeojson: donut });
const donutMarket = await getMarket(env, eastBayId);
assert(marketContains(donutMarket, 37.55, -122.2), "inside the outer ring is in");
assert(!marketContains(donutMarket, 37.7, -122.08), "inside the hole is out");

/* -------------------------------------------------------- MultiPolygon --- */

const twoIslands = {
  type: "MultiPolygon",
  coordinates: [
    [[[-122.3, 37.5], [-122.1, 37.5], [-122.1, 37.7], [-122.3, 37.7], [-122.3, 37.5]]],
    [[[-121.9, 37.8], [-121.7, 37.8], [-121.7, 38.0], [-121.9, 38.0], [-121.9, 37.8]]]
  ]
};
await updateMarket(env, actor, eastBayId, { boundaryGeojson: twoIslands });
const islands = await getMarket(env, eastBayId);
assert(marketContains(islands, 37.6, -122.2), "first island contains");
assert(marketContains(islands, 37.9, -121.8), "second island contains");
assert(!marketContains(islands, 37.75, -122.0), "the water between them does not");

/* ------------------------------------------------- search resolution --- */

const resolved = await resolveSearchMarket(env, 37.6, -122.2);
assert(resolved.marketId === eastBayId, "a search inside the drawn boundary resolves to the market");
// The market is still red/inactive by default, so it counts as out-of-market
// coverage-wise while still being attributed — the 0024 contract.
assert(resolved.outOfMarket === true, "a red market is attributed but out-of-market");
const missed = await resolveSearchMarket(env, 40.0, -105.0);
assert(missed.marketId === null && missed.outOfMarket === true, "Denver is nobody's yet");
assert((await nearestContainingMarket(env, 37.75, -122.0)) === null, "between the islands, no market contains");

/* -------------------------------------------- unassigned suggestions --- */

database.prepare(`
  INSERT INTO tenants (id, name, slug) VALUES ('tenant_geo', 'Geo Vet Group', 'geo-vet-group')
`).run();
database.prepare(`
  INSERT INTO locations (id, tenant_id, name, slug, kind, address_line1, city, region, postal_code, phone, latitude, longitude, active)
  VALUES ('loc_inside', 'tenant_geo', 'Island Clinic', 'island-clinic', 'general', '1 Island Way', 'Oakland', 'CA', '94601', '+15105550101', 37.6, -122.2, 1),
         ('loc_outside', 'tenant_geo', 'Gap Clinic', 'gap-clinic', 'general', '2 Gap Road', 'Hayward', 'CA', '94541', '+15105550102', 37.75, -122.0, 1)
`).run();
const unassigned = await listUnassignedLocations(env);
const inside = unassigned.find((location) => location.id === "loc_inside");
const outside = unassigned.find((location) => location.id === "loc_outside");
assert(inside?.suggestedMarket?.id === eastBayId, "a clinic inside the drawn lines is suggested");
assert(Number.isFinite(inside.latitude) && Number.isFinite(inside.longitude), "suggestions carry coordinates for the console map");
assert(outside?.suggestedMarket === null, "a clinic between the islands is not suggested anywhere");

/* --------------------------------------------------------- validation --- */

const openRing = await updateMarket(env, actor, eastBayId, {
  boundaryGeojson: { type: "Polygon", coordinates: [[[-122.2, 37.6], [-121.9, 37.6], [-122.2, 37.8]]] }
});
assert(openRing.status === 422, "an open (3-point) ring is refused");
const badLat = await updateMarket(env, actor, eastBayId, {
  boundaryGeojson: { type: "Polygon", coordinates: [[[37.6, -122.2], [37.6, -121.9], [37.8, -122.2], [37.6, -122.2]]] }
});
assert(badLat.status === 422, "lat/lng swapped (latitude past ±90 in the second slot) is refused");
const notGeometry = await updateMarket(env, actor, eastBayId, { boundaryGeojson: { type: "Feature" } });
assert(notGeometry.status === 422, "a Feature is not a geometry");

const denseRing = [];
for (let i = 0; i <= 600; i += 1) {
  const angle = (i / 600) * 2 * Math.PI;
  denseRing.push([-122.08 + 0.2 * Math.cos(angle), 37.67 + 0.2 * Math.sin(angle)]);
}
denseRing[denseRing.length - 1] = denseRing[0];
const tooDense = await updateMarket(env, actor, eastBayId, { boundaryGeojson: { type: "Polygon", coordinates: [denseRing] } });
assert(tooDense.status === 422, "601 vertices exceeds the cap");

// Clearing goes back to the circle, and the circle answers again.
const cleared = await updateMarket(env, actor, eastBayId, { boundaryGeojson: null });
assert(cleared.body.market.boundaryKind === "circle", "null clears the polygon");
assert(marketContains(cleared.body.market, 37.9, -122.08), "the circle contains again once cleared");

console.log("Markets tests passed: circle fallback, triangle bbox regression, holes, MultiPolygon, search attribution through drawn lines, containment-based clinic suggestions, ring/vertex/swap validation, and clearing back to the circle.");
