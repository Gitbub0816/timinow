/**
 * Geographic markets — expansion units above the tenant/location layer.
 *
 * A market ("East Bay", "Denver Metro") is a circle: a center point and a
 * radius, the same shape a customer search already uses to find nearby
 * clinics (src/db.js haversineMiles), so "is this clinic in this market" and
 * "did this search originate inside this market" ask the same geometric
 * question locations already answer.
 *
 * Two states live on every market row, kept deliberately apart:
 *   - `state` (green/yellow/red) is the actual, customer-facing answer.
 *     Only setMarketState ever writes it, and only an admin calls that — see
 *     requirePlatformAdmin below. Nothing in this module ever sets it as a
 *     side effect of computing readiness.
 *   - computeReadinessReport's `recommendedState` is never stored. It is
 *     derived fresh from live data on every call so it can never drift from
 *     the numbers it explains; the admin console shows it next to the
 *     stored `state` so an operator can see the two agree or disagree.
 *
 * See migrations/0024_markets_and_metrics.sql for the table definitions and
 * market_readiness_config for the thresholds this module reads rather than
 * hardcodes.
 */

import { hasDatabase } from "./db.js";
import { isPlatformAdmin, recordAudit, slugify } from "./tenancy.js";

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function cleanString(value, maxLength = 240) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function numberInRange(value, minimum, maximum, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : fallback;
}

/** Kept local rather than imported from db.js/index.js: both of those files
 * already carry their own copy of this exact normalization, because a bare
 * D1 timestamp ("2026-09-04 12:00:00") and an ISO one otherwise parse to two
 * different instants in `Date.parse`. */
function timestampMs(value) {
  if (!value) return Number.NaN;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  return Date.parse(normalized);
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRadians = (degrees) => degrees * (Math.PI / 180);
  const earthRadiusKm = 6371;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.sqrt(a));
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function median(sortedValues) {
  const length = sortedValues.length;
  if (!length) return null;
  const mid = Math.floor(length / 2);
  return length % 2 ? sortedValues[mid] : (sortedValues[mid - 1] + sortedValues[mid]) / 2;
}

/* ------------------------------------------------------------- guard --- */

/** Shared by every admin-console route in this module. Returns an error
 * descriptor (never throws) so callers can respond the same way
 * requireTenantAdmin's callers already do. */
export async function requirePlatformAdmin(env, actor) {
  if (!actor?.authenticated && !actor?.userId) return { status: 401, code: "AUTHENTICATION_REQUIRED", message: "Sign in to continue." };
  if (!(await isPlatformAdmin(env, actor))) return { status: 403, code: "PLATFORM_ADMIN_REQUIRED", message: "Only a platform operator may manage markets." };
  return null;
}

/* -------------------------------------------------------------- CRUD --- */

/** The stored geometry, or null when absent or unparseable. Unparseable is
 * treated as absent rather than thrown: containment then falls back to the
 * circle columns, which every market still carries (migration 0027). */
function parseBoundary(row) {
  if (!row?.boundary_geojson) return null;
  try {
    const geometry = JSON.parse(row.boundary_geojson);
    return geometry && (geometry.type === "Polygon" || geometry.type === "MultiPolygon") ? geometry : null;
  } catch {
    return null;
  }
}

export function marketFromRow(row) {
  if (!row) return null;
  const boundaryGeojson = parseBoundary(row);
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    state: row.state,
    activation: row.activation,
    centerLatitude: row.center_latitude,
    centerLongitude: row.center_longitude,
    radiusKm: row.radius_km,
    boundaryKind: boundaryGeojson && row.boundary_kind === "polygon" ? "polygon" : "circle",
    boundaryGeojson,
    notes: row.notes || null,
    stateSetBy: row.state_set_by || null,
    stateSetAt: row.state_set_at || null,
    locationCount: row.location_count ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function listMarkets(env) {
  if (!hasDatabase(env)) return [];
  const result = await env.DB.prepare(`
    SELECT m.*, (SELECT COUNT(*) FROM locations l WHERE l.market_id = m.id AND l.active = 1) AS location_count
    FROM markets m ORDER BY m.name
  `).all();
  return result.results.map(marketFromRow);
}

export async function getMarket(env, marketId) {
  if (!hasDatabase(env) || !marketId) return null;
  const row = await env.DB.prepare(`
    SELECT m.*, (SELECT COUNT(*) FROM locations l WHERE l.market_id = m.id AND l.active = 1) AS location_count
    FROM markets m WHERE m.id = ? LIMIT 1
  `).bind(marketId).first();
  return marketFromRow(row);
}

async function uniqueMarketSlug(env, name) {
  const base = slugify(name) || "market";
  let candidate = base;
  let suffix = 2;
  while (await env.DB.prepare("SELECT id FROM markets WHERE slug = ? LIMIT 1").bind(candidate).first()) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/** Caps chosen against the admin worker's 32 KiB readJson limit: 500
 * vertices of "[-122.123456,37.123456]," is ~13 KB, comfortably under it,
 * and far more detail than a hand-drawn territory ever carries. */
const BOUNDARY_MAX_VERTICES = 500;
const BOUNDARY_MAX_BYTES = 24_000;

/**
 * A GeoJSON Polygon/MultiPolygon geometry (not a Feature), checked the way a
 * hand-drawn boundary can actually go wrong: open rings, coordinates out of
 * range, latitude/longitude swapped (a lat past ±90 in the longitude slot is
 * caught by the range check), or a paste far too large to store. Returns
 * { errors: string[], geometry: object|null } — geometry is the parsed,
 * validated object ready to stringify.
 */
function validateBoundaryGeojson(value) {
  const errors = [];
  const geometry = typeof value === "string" ? (() => { try { return JSON.parse(value); } catch { return null; } })() : value;
  if (!geometry || typeof geometry !== "object") return { errors: ["boundaryGeojson must be a GeoJSON Polygon or MultiPolygon geometry"], geometry: null };
  const type = geometry.type;
  if (type !== "Polygon" && type !== "MultiPolygon") return { errors: ["boundaryGeojson.type must be Polygon or MultiPolygon"], geometry: null };
  const polygons = type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  if (!Array.isArray(polygons) || !polygons.length) return { errors: ["boundaryGeojson has no coordinates"], geometry: null };

  let vertices = 0;
  for (const rings of polygons) {
    if (!Array.isArray(rings) || !rings.length) { errors.push("each polygon needs at least an outer ring"); continue; }
    for (const ring of rings) {
      if (!Array.isArray(ring) || ring.length < 4) { errors.push("each ring needs at least 4 positions"); continue; }
      const first = ring[0];
      const last = ring[ring.length - 1];
      if (!Array.isArray(first) || !Array.isArray(last) || first[0] !== last[0] || first[1] !== last[1]) {
        errors.push("each ring must close (first and last position equal)");
      }
      for (const position of ring) {
        vertices += 1;
        const lng = Array.isArray(position) ? Number(position[0]) : NaN;
        const lat = Array.isArray(position) ? Number(position[1]) : NaN;
        if (!Number.isFinite(lng) || lng < -180 || lng > 180 || !Number.isFinite(lat) || lat < -90 || lat > 90) {
          errors.push("positions must be [longitude, latitude] within range");
        }
      }
      if (errors.length) break;
    }
    if (errors.length) break;
  }
  if (vertices > BOUNDARY_MAX_VERTICES) errors.push(`boundary has ${vertices} vertices; the maximum is ${BOUNDARY_MAX_VERTICES}`);
  const clean = errors.length ? null : { type, coordinates: geometry.coordinates };
  if (clean && JSON.stringify(clean).length > BOUNDARY_MAX_BYTES) {
    return { errors: [`boundary exceeds ${BOUNDARY_MAX_BYTES} bytes`], geometry: null };
  }
  return { errors, geometry: clean };
}

function validateMarketInput(body, { requireAll } = { requireAll: true }) {
  const errors = [];
  const name = cleanString(body?.name, 120);
  const centerLatitude = numberInRange(body?.centerLatitude, -90, 90);
  const centerLongitude = numberInRange(body?.centerLongitude, -180, 180);
  const radiusKm = numberInRange(body?.radiusKm, 1, 500, requireAll ? null : undefined);
  if (requireAll) {
    if (!name) errors.push("name is required");
    if (centerLatitude === null || centerLongitude === null) errors.push("centerLatitude and centerLongitude are required");
    if (radiusKm === null) errors.push("radiusKm must be between 1 and 500");
  }
  // Three boundary shapes in a request body: absent (leave as-is), null
  // (clear the polygon, back to the circle), or a geometry (validate it).
  let boundary; // undefined = untouched
  if (body?.boundaryGeojson === null) {
    boundary = null;
  } else if (body?.boundaryGeojson !== undefined) {
    const checked = validateBoundaryGeojson(body.boundaryGeojson);
    errors.push(...checked.errors);
    boundary = checked.geometry;
  }
  return { errors, name, centerLatitude, centerLongitude, radiusKm, boundary, notes: cleanString(body?.notes, 2000) || null };
}

export async function createMarket(env, actor, body) {
  if (!hasDatabase(env)) return { status: 503, code: "DATABASE_REQUIRED", message: "D1 is required to create a market." };
  const input = validateMarketInput(body, { requireAll: true });
  if (input.errors.length) return { status: 422, code: "VALIDATION_FAILED", message: "Review the market form.", details: input.errors };

  const id = newId("market");
  const slug = await uniqueMarketSlug(env, input.name);
  const boundaryJson = input.boundary ? JSON.stringify(input.boundary) : null;
  await env.DB.prepare(`
    INSERT INTO markets (id, name, slug, center_latitude, center_longitude, radius_km, boundary_kind, boundary_geojson, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(id, input.name, slug, input.centerLatitude, input.centerLongitude, input.radiusKm, boundaryJson ? "polygon" : "circle", boundaryJson, input.notes, actor.userId).run();
  await recordAudit(env, { actorUserId: actor.userId, actorScope: "platform", action: "market.created", target: id, detail: { name: input.name, slug, boundaryKind: boundaryJson ? "polygon" : "circle" } });
  return { status: 201, body: { market: await getMarket(env, id) } };
}

export async function updateMarket(env, actor, marketId, body) {
  if (!hasDatabase(env)) return { status: 503, code: "DATABASE_REQUIRED", message: "D1 is required to update a market." };
  const market = await getMarket(env, marketId);
  if (!market) return { status: 404, code: "MARKET_NOT_FOUND", message: "That market was not found." };
  const input = validateMarketInput(body, { requireAll: false });
  if (input.errors.length) return { status: 422, code: "VALIDATION_FAILED", message: "Review the market form.", details: input.errors };

  const name = input.name || market.name;
  const centerLatitude = input.centerLatitude ?? market.centerLatitude;
  const centerLongitude = input.centerLongitude ?? market.centerLongitude;
  const radiusKm = input.radiusKm ?? market.radiusKm;
  const notes = body?.notes !== undefined ? input.notes : market.notes;
  // undefined = leave the stored boundary alone; null = clear back to the
  // circle; a geometry = replace. A boundary edit silently changes which
  // future searches and clinics belong here, so the audit row says so.
  const boundaryTouched = input.boundary !== undefined;
  const boundaryJson = boundaryTouched
    ? (input.boundary ? JSON.stringify(input.boundary) : null)
    : (market.boundaryGeojson ? JSON.stringify(market.boundaryGeojson) : null);
  await env.DB.prepare(`
    UPDATE markets SET name = ?, center_latitude = ?, center_longitude = ?, radius_km = ?, boundary_kind = ?, boundary_geojson = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(name, centerLatitude, centerLongitude, radiusKm, boundaryJson ? "polygon" : "circle", boundaryJson, notes, marketId).run();
  await recordAudit(env, {
    actorUserId: actor.userId, actorScope: "platform", action: "market.updated", target: marketId,
    detail: boundaryTouched
      ? { name, boundaryKind: boundaryJson ? "polygon" : "circle", boundaryChanged: true }
      : { name }
  });
  return { status: 200, body: { market: await getMarket(env, marketId) } };
}

const VALID_STATES = new Set(["green", "yellow", "red"]);
const VALID_ACTIVATIONS = new Set(["active_marketing", "soft", "inactive"]);

/** The one place `state`/`activation` may change. Always an explicit admin
 * call — see the module comment — never a side effect of reading readiness. */
export async function setMarketState(env, actor, marketId, body) {
  if (!hasDatabase(env)) return { status: 503, code: "DATABASE_REQUIRED", message: "D1 is required to set a market's state." };
  const market = await getMarket(env, marketId);
  if (!market) return { status: 404, code: "MARKET_NOT_FOUND", message: "That market was not found." };
  const state = body?.state !== undefined ? cleanString(body.state, 20) : market.state;
  const activation = body?.activation !== undefined ? cleanString(body.activation, 20) : market.activation;
  if (!VALID_STATES.has(state)) return { status: 422, code: "INVALID_STATE", message: "state must be green, yellow, or red." };
  if (!VALID_ACTIVATIONS.has(activation)) return { status: 422, code: "INVALID_ACTIVATION", message: "activation must be active_marketing, soft, or inactive." };

  await env.DB.prepare(`
    UPDATE markets SET state = ?, activation = ?, state_set_by = ?, state_set_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(state, activation, actor.userId, marketId).run();
  await recordAudit(env, {
    actorUserId: actor.userId, actorScope: "platform", action: "market.state_set", target: marketId,
    detail: { state, activation, previousState: market.state, previousActivation: market.activation }
  });
  return { status: 200, body: { market: await getMarket(env, marketId) } };
}

/* ------------------------------------------------ location assignment --- */

export async function listMarketLocations(env, marketId) {
  if (!hasDatabase(env)) return [];
  const result = await env.DB.prepare(`
    SELECT id, tenant_id, name, city, region, latitude, longitude, kind, active
    FROM locations WHERE market_id = ? ORDER BY name
  `).bind(marketId).all();
  return result.results.map((row) => ({
    id: row.id, tenantId: row.tenant_id, name: row.name, city: row.city, region: row.region,
    latitude: row.latitude, longitude: row.longitude, kind: row.kind, active: Boolean(row.active)
  }));
}

/** Locations not yet in any market, with the nearest candidate market (if
 * one's radius contains it) so the console can suggest an assignment rather
 * than making an operator guess coordinates against a list of names. */
export async function listUnassignedLocations(env) {
  if (!hasDatabase(env)) return [];
  const [locationRows, markets] = await Promise.all([
    env.DB.prepare("SELECT id, tenant_id, name, city, region, latitude, longitude FROM locations WHERE market_id IS NULL AND active = 1 ORDER BY name").all(),
    listMarkets(env)
  ]);
  return locationRows.results.map((row) => {
    // The suggestion is the nearest market that actually CONTAINS the clinic
    // — polygon or circle, same test the search resolver uses — so a drawn
    // territory suggests exactly the clinics inside its lines.
    let nearest = null;
    let nearestDistanceKm = Infinity;
    for (const market of markets) {
      if (!marketContains(market, row.latitude, row.longitude)) continue;
      const distanceKm = haversineKm(row.latitude, row.longitude, market.centerLatitude, market.centerLongitude);
      if (distanceKm < nearestDistanceKm) { nearestDistanceKm = distanceKm; nearest = market; }
    }
    return {
      id: row.id, tenantId: row.tenant_id, name: row.name, city: row.city, region: row.region,
      latitude: row.latitude, longitude: row.longitude,
      suggestedMarket: nearest
        ? { id: nearest.id, name: nearest.name, distanceKm: round1(nearestDistanceKm) }
        : null
    };
  });
}

export async function assignLocationToMarket(env, actor, marketId, locationId) {
  if (!hasDatabase(env)) return { status: 503, code: "DATABASE_REQUIRED", message: "D1 is required to assign a location." };
  const market = await getMarket(env, marketId);
  if (!market) return { status: 404, code: "MARKET_NOT_FOUND", message: "That market was not found." };
  const result = await env.DB.prepare("UPDATE locations SET market_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(marketId, locationId).run();
  if (!result.meta?.changes) return { status: 404, code: "LOCATION_NOT_FOUND", message: "That location was not found." };
  await recordAudit(env, { actorUserId: actor.userId, actorScope: "platform", action: "market.location_assigned", target: locationId, detail: { marketId } });
  return { status: 200, body: { locationId, marketId } };
}

export async function unassignLocation(env, actor, locationId) {
  if (!hasDatabase(env)) return { status: 503, code: "DATABASE_REQUIRED", message: "D1 is required to unassign a location." };
  const result = await env.DB.prepare("UPDATE locations SET market_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(locationId).run();
  if (!result.meta?.changes) return { status: 404, code: "LOCATION_NOT_FOUND", message: "That location was not found." };
  await recordAudit(env, { actorUserId: actor.userId, actorScope: "platform", action: "market.location_unassigned", target: locationId, detail: {} });
  return { status: 200, body: { locationId } };
}

/* --------------------------------------------------- point resolution --- */

/** Even-odd ray cast over one GeoJSON ring ([lng, lat] positions). The
 * standard half-open crossing test, so shared edges between adjacent
 * territories do not double-count. */
function pointInRing(ring, longitude, latitude) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > latitude !== yj > latitude
      && longitude < ((xj - xi) * (latitude - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Even-odd across every ring of the geometry: inside the outer ring and
 * inside a hole cancel out, which is exactly GeoJSON's hole semantics. */
function pointInBoundary(geometry, latitude, longitude) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let crossings = 0;
  for (const rings of polygons) {
    for (const ring of rings) {
      if (pointInRing(ring, longitude, latitude)) crossings += 1;
    }
  }
  return crossings % 2 === 1;
}

/**
 * Whether a point is in a market, respecting its shape: the drawn polygon
 * when one is stored (with a bounding-box pre-check so the per-search loop in
 * resolveSearchMarket stays cheap), otherwise the original circle. Exported
 * for the console and the tests; every containment decision in this module
 * goes through here so the two shapes cannot drift.
 */
export function marketContains(market, latitude, longitude) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  if (market.boundaryKind === "polygon" && market.boundaryGeojson) {
    const polygons = market.boundaryGeojson.type === "Polygon" ? [market.boundaryGeojson.coordinates] : market.boundaryGeojson.coordinates;
    let minLng = Infinity;
    let maxLng = -Infinity;
    let minLat = Infinity;
    let maxLat = -Infinity;
    for (const rings of polygons) {
      for (const [lng, lat] of rings[0] || []) {
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
    if (longitude < minLng || longitude > maxLng || latitude < minLat || latitude > maxLat) return false;
    return pointInBoundary(market.boundaryGeojson, latitude, longitude);
  }
  return haversineKm(latitude, longitude, market.centerLatitude, market.centerLongitude) <= market.radiusKm;
}

/**
 * The nearest market whose circle contains (lat, lng), regardless of its
 * state or activation — this is deliberately unfiltered so a search landing
 * in a *red* or *inactive* market is still attributed to it (that is exactly
 * the demand signal expansion planning needs) rather than counted as
 * belonging to nowhere. Callers decide what "out of market" means from the
 * returned market's own state/activation — see resolveSearchMarket below and
 * createCareSearch in src/index.js.
 */
export async function nearestContainingMarket(env, latitude, longitude) {
  if (!hasDatabase(env) || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const markets = await listMarkets(env);
  let nearest = null;
  let nearestDistanceKm = Infinity;
  for (const market of markets) {
    // Containment respects the market's shape (drawn polygon or circle);
    // center distance stays the tiebreaker when two territories overlap.
    if (!marketContains(market, latitude, longitude)) continue;
    const distanceKm = haversineKm(latitude, longitude, market.centerLatitude, market.centerLongitude);
    if (distanceKm < nearestDistanceKm) { nearestDistanceKm = distanceKm; nearest = market; }
  }
  return nearest;
}

/** What createCareSearch needs in one call: the market to stamp on the row
 * (or null) and whether this counts as coverage. "Out of market" covers both
 * halves of the spec: no market's circle reaches this point at all, or one
 * does but it is not actually live (`state = 'red'` or `activation =
 * 'inactive'`). Either way the search still runs — see the module comment
 * and createCareSearch — this only measures. */
export async function resolveSearchMarket(env, latitude, longitude) {
  const market = await nearestContainingMarket(env, latitude, longitude);
  if (!market) return { marketId: null, outOfMarket: true };
  const outOfMarket = market.state === "red" || market.activation === "inactive";
  return { marketId: market.id, outOfMarket };
}

/* ------------------------------------------------------------ readiness --- */

export async function getReadinessConfig(env) {
  if (!hasDatabase(env)) {
    return { minActiveClinics: 8, targetActiveClinics: 10, minOfferRatePct: 70, maxMedianFirstOfferMinutes: 5, maxSingleClinicSharePct: 50, lookbackDays: 30 };
  }
  const row = await env.DB.prepare("SELECT * FROM market_readiness_config WHERE id = 'default' LIMIT 1").first();
  return {
    minActiveClinics: row?.min_active_clinics ?? 8,
    targetActiveClinics: row?.target_active_clinics ?? 10,
    minOfferRatePct: row?.min_offer_rate_pct ?? 70,
    maxMedianFirstOfferMinutes: row?.max_median_first_offer_minutes ?? 5,
    maxSingleClinicSharePct: row?.max_single_clinic_share_pct ?? 50,
    lookbackDays: row?.lookback_days ?? 30
  };
}

export async function updateReadinessConfig(env, actor, body) {
  if (!hasDatabase(env)) return { status: 503, code: "DATABASE_REQUIRED", message: "D1 is required to update readiness thresholds." };
  const current = await getReadinessConfig(env);
  const next = {
    minActiveClinics: numberInRange(body?.minActiveClinics, 1, 500, current.minActiveClinics),
    targetActiveClinics: numberInRange(body?.targetActiveClinics, 1, 500, current.targetActiveClinics),
    minOfferRatePct: numberInRange(body?.minOfferRatePct, 0, 100, current.minOfferRatePct),
    maxMedianFirstOfferMinutes: numberInRange(body?.maxMedianFirstOfferMinutes, 0, 1440, current.maxMedianFirstOfferMinutes),
    maxSingleClinicSharePct: numberInRange(body?.maxSingleClinicSharePct, 0, 100, current.maxSingleClinicSharePct),
    lookbackDays: numberInRange(body?.lookbackDays, 1, 365, current.lookbackDays)
  };
  await env.DB.prepare(`
    UPDATE market_readiness_config SET
      min_active_clinics = ?, target_active_clinics = ?, min_offer_rate_pct = ?,
      max_median_first_offer_minutes = ?, max_single_clinic_share_pct = ?, lookback_days = ?,
      updated_at = CURRENT_TIMESTAMP, updated_by = ?
    WHERE id = 'default'
  `).bind(
    next.minActiveClinics, next.targetActiveClinics, next.minOfferRatePct,
    next.maxMedianFirstOfferMinutes, next.maxSingleClinicSharePct, next.lookbackDays, actor.userId
  ).run();
  await recordAudit(env, { actorUserId: actor.userId, actorScope: "platform", action: "market.readiness_config_updated", target: "default", detail: next });
  return { status: 200, body: { config: next } };
}

const DAY_HOURS = { start: 6, end: 18 };
const EVENING_HOURS = { start: 18, end: 22 };

function timeOfDayBucket(hour) {
  if (hour >= DAY_HOURS.start && hour < DAY_HOURS.end) return "day";
  if (hour >= EVENING_HOURS.start && hour < EVENING_HOURS.end) return "evening";
  return "night";
}

/**
 * The five signals docs/PLATFORM-CONTRACT-adjacent product review asked for,
 * computed fresh from care_searches/care_offers/intake_requests/locations —
 * never stored, never cached, so it can never disagree with the data behind
 * it. Returns `recommendedState` alongside the market's actual, admin-set
 * `state` so the console can show both and an operator decides whether to
 * act; this function never writes to the market row.
 */
export async function computeReadinessReport(env, marketId, { now = Date.now() } = {}) {
  if (!hasDatabase(env)) return null;
  const market = await getMarket(env, marketId);
  if (!market) return null;
  const config = await getReadinessConfig(env);
  const since = new Date(now - config.lookbackDays * 86_400_000).toISOString();

  const [clinicRow, searchOfferRows, firstOfferRows, offerHourRows, bookingRows] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS total FROM locations WHERE market_id = ? AND active = 1").bind(marketId).first(),
    env.DB.prepare(`
      SELECT (SELECT COUNT(*) FROM care_offers o WHERE o.search_id = s.id) AS offer_count
      FROM care_searches s WHERE s.market_id = ? AND datetime(s.requested_at) >= datetime(?)
    `).bind(marketId, since).all(),
    env.DB.prepare(`
      SELECT s.requested_at AS requested_at, MIN(o.offered_at) AS first_offered_at
      FROM care_searches s JOIN care_offers o ON o.search_id = s.id
      WHERE s.market_id = ? AND datetime(s.requested_at) >= datetime(?)
      GROUP BY s.id
    `).bind(marketId, since).all(),
    env.DB.prepare(`
      SELECT CAST(strftime('%H', o.offered_at) AS INTEGER) AS hour, COUNT(*) AS total
      FROM care_offers o JOIN locations l ON l.id = o.location_id
      WHERE l.market_id = ? AND datetime(o.offered_at) >= datetime(?)
      GROUP BY hour
    `).bind(marketId, since).all(),
    env.DB.prepare(`
      SELECT l.id AS location_id, COUNT(*) AS bookings
      FROM intake_requests i JOIN locations l ON l.id = i.location_id
      WHERE l.market_id = ? AND datetime(i.requested_at) >= datetime(?) AND i.status NOT IN ('declined', 'expired', 'cancelled')
      GROUP BY l.id ORDER BY bookings DESC
    `).bind(marketId, since).all()
  ]);

  const activeClinicCount = Number(clinicRow?.total || 0);

  const totalSearches = searchOfferRows.results.length;
  const searchesWithOffer = searchOfferRows.results.filter((row) => Number(row.offer_count) > 0).length;
  const offerRatePct = totalSearches ? round1((searchesWithOffer / totalSearches) * 100) : null;

  const firstOfferMinutes = firstOfferRows.results
    .map((row) => (timestampMs(row.first_offered_at) - timestampMs(row.requested_at)) / 60_000)
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  const medianFirstOfferMinutes = firstOfferMinutes.length ? round1(median(firstOfferMinutes)) : null;

  const coverage = { day: false, evening: false, night: false };
  for (const row of offerHourRows.results) {
    if (Number(row.total) > 0) coverage[timeOfDayBucket(Number(row.hour))] = true;
  }
  const fullTimeOfDayCoverage = coverage.day && coverage.evening && coverage.night;

  const totalBookings = bookingRows.results.reduce((sum, row) => sum + Number(row.bookings || 0), 0);
  const busiest = bookingRows.results[0] || null;
  const concentrationPct = totalBookings ? round1((Number(busiest?.bookings || 0) / totalBookings) * 100) : null;

  const checks = {
    meetsMinClinicCount: activeClinicCount >= config.minActiveClinics,
    meetsTargetClinicCount: activeClinicCount >= config.targetActiveClinics,
    meetsOfferRate: offerRatePct !== null && offerRatePct >= config.minOfferRatePct,
    meetsFirstOfferTime: medianFirstOfferMinutes !== null && medianFirstOfferMinutes <= config.maxMedianFirstOfferMinutes,
    meetsTimeOfDayCoverage: fullTimeOfDayCoverage,
    // No bookings yet in the window is not itself a concentration problem —
    // it is the offer-rate and clinic-count checks that catch "nothing is
    // happening here yet". Absent data passes this specific check rather
    // than failing it by a division that never occurred.
    meetsConcentration: concentrationPct === null || concentrationPct <= config.maxSingleClinicSharePct
  };

  // The floor: without the minimum clinic count, nothing else can be trusted
  // (five clinics with a 100% offer rate is a fluke of low volume, not
  // coverage) — that alone caps the recommendation at red.
  let recommendedState = "red";
  if (checks.meetsMinClinicCount) {
    const passing = Object.values(checks).filter(Boolean).length;
    recommendedState = checks.meetsTargetClinicCount && passing === Object.keys(checks).length ? "green" : "yellow";
  }

  return {
    marketId,
    marketName: market.name,
    computedAt: new Date(now).toISOString(),
    lookbackDays: config.lookbackDays,
    metrics: {
      activeClinicCount,
      totalSearches,
      searchesWithOffer,
      offerRatePct,
      medianFirstOfferMinutes,
      timeOfDayCoverage: coverage,
      concentrationPct,
      busiestLocationId: busiest?.location_id || null
    },
    thresholds: config,
    checks,
    recommendedState,
    currentState: market.state,
    currentActivation: market.activation,
    stateMatchesRecommendation: recommendedState === market.state
  };
}
