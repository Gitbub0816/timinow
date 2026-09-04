/**
 * The core marketplace analytics dashboard: demand, supply, matching,
 * booking, revenue, and quality, computed from the tables the marketplace
 * flow already writes (care_searches / care_search_targets / care_offers /
 * intake_requests / payment_ledger / client_errors), plus the one new table
 * this module adds for what nothing else records — see marketplace_events in
 * migrations/0024_markets_and_metrics.sql.
 *
 * Two migrations are landing from parallel work and are not yet present in
 * this branch:
 *   - 0021 adds a wave number to care_search_targets (staged wave routing)
 *     and a clinic response-reliability stats table.
 *   - 0022 adds attribution columns (attribution_source, ...) to
 *     care_searches.
 * Every query that would use either one is feature-detected with
 * `columnExists` below rather than assuming the column is there — see
 * `waveAvailable` / `attributionAvailable` on the returned report. Nothing
 * here needs to change when those migrations land; the numbers simply start
 * populating.
 */

import { hasDatabase } from "./db.js";

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function cleanString(value, maxLength = 240) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function timestampMs(value) {
  if (!value) return Number.NaN;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  return Date.parse(normalized);
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

function pct(numerator, denominator) {
  return denominator ? round1((numerator / denominator) * 100) : null;
}

/** Table/column names here are always literals this module controls, never
 * request input, so string interpolation into PRAGMA is safe. */
async function columnExists(env, table, column) {
  if (!hasDatabase(env)) return false;
  try {
    const result = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
    return result.results.some((row) => row.name === column);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------- marketplace events --- */

const EVENT_TYPES = new Set([
  "search_started", "offers_viewed", "offer_made", "target_declined",
  "offer_selected", "search_cancelled", "search_expired"
]);

/**
 * Builds (but does not run) an INSERT for `marketplace_events`, so a caller
 * that already batches its own writes — createCareSearch, applyCareSearch
 * Decision, selectCareOffer, cancelCareSearch in src/index.js — can append
 * one more statement to that same `env.DB.batch([...])` rather than pay a
 * second round trip for an event nobody has to wait on.
 *
 * Pass `idempotencyKey` for a moment that must be recorded at most once no
 * matter how many times the triggering request repeats (a customer polling
 * the same screen) — the row's id is derived from the key and the insert
 * uses INSERT OR IGNORE, so the second and later calls are free.
 */
export function marketplaceEventStatement(env, {
  type, searchId = null, targetId = null, offerId = null, intakeId = null,
  tenantId = null, locationId = null, marketId = null, outOfMarket = false, actorType = null,
  meta = {}, idempotencyKey = null
}) {
  const id = idempotencyKey ? `event_${idempotencyKey}` : newId("event");
  const sql = idempotencyKey ? `
    INSERT OR IGNORE INTO marketplace_events
      (id, occurred_at, event_type, search_id, target_id, offer_id, intake_id, tenant_id, location_id, market_id, out_of_market, actor_type, meta_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ` : `
    INSERT INTO marketplace_events
      (id, occurred_at, event_type, search_id, target_id, offer_id, intake_id, tenant_id, location_id, market_id, out_of_market, actor_type, meta_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  return env.DB.prepare(sql).bind(
    id, new Date().toISOString(), String(type), searchId, targetId, offerId, intakeId,
    tenantId, locationId, marketId, outOfMarket ? 1 : 0, actorType, JSON.stringify(meta || {})
  );
}

/** Standalone, fire-and-forget version for call sites that are not already
 * inside a batch — fail-soft on purpose, the same contract as
 * src/analytics.js: an event that cannot be written must never break the
 * request that triggered it. */
export async function recordMarketplaceEvent(env, params) {
  if (!hasDatabase(env) || !EVENT_TYPES.has(String(params?.type))) return;
  try {
    await marketplaceEventStatement(env, params).run();
  } catch (error) {
    console.warn(JSON.stringify({ event: "marketplace_event_insert_failed", type: params?.type, message: error.message }));
  }
}

/* -------------------------------------------------------------- filters --- */

function parseFilters(url) {
  const params = url.searchParams;
  const to = cleanString(params.get("to"), 40) || new Date().toISOString();
  const fromDefault = new Date(timestampMs(to) - 30 * 86_400_000).toISOString();
  const from = cleanString(params.get("from"), 40) || fromDefault;
  return {
    from,
    to,
    // 'out_of_market' is a real, selectable bucket, not only a market id.
    marketId: cleanString(params.get("market"), 80) || null,
    tenantId: cleanString(params.get("tenant"), 80) || null,
    source: cleanString(params.get("source"), 80) || null
  };
}

/** care_searches.market_id / out_of_market clause, reused by every section
 * that starts from a search. */
function marketClause(filters, values, column = "market_id", outOfMarketColumn = "out_of_market") {
  if (!filters.marketId) return "";
  if (filters.marketId === "out_of_market") return ` AND ${outOfMarketColumn} = 1`;
  values.push(filters.marketId);
  return ` AND ${column} = ?`;
}

/* --------------------------------------------------------------- demand --- */

async function demandMetrics(env, filters, attributionAvailable) {
  const sourceClause = filters.source && attributionAvailable ? " AND attribution_source = ?" : "";
  const marketSql = marketClause(filters, []);
  // Bind order must match clause order exactly: the date range always comes
  // first, then the source filter (if present), then the market filter (if
  // present and not the synthetic 'out_of_market' bucket, which needs no
  // bound value at all).
  const orderedValues = [filters.from, filters.to];
  if (filters.source && attributionAvailable) orderedValues.push(filters.source);
  if (filters.marketId && filters.marketId !== "out_of_market") orderedValues.push(filters.marketId);

  const [totals, byDay, byHour, byMarket] = await Promise.all([
    env.DB.prepare(`
      SELECT COUNT(*) AS total, SUM(CASE WHEN out_of_market = 1 THEN 1 ELSE 0 END) AS out_of_market
      FROM care_searches WHERE datetime(requested_at) >= datetime(?) AND datetime(requested_at) <= datetime(?) ${sourceClause}${marketSql}
    `).bind(...orderedValues).first(),
    env.DB.prepare(`
      SELECT date(requested_at) AS day, COUNT(*) AS total
      FROM care_searches WHERE datetime(requested_at) >= datetime(?) AND datetime(requested_at) <= datetime(?) ${sourceClause}${marketSql}
      GROUP BY day ORDER BY day
    `).bind(...orderedValues).all(),
    env.DB.prepare(`
      SELECT CAST(strftime('%H', requested_at) AS INTEGER) AS hour, COUNT(*) AS total
      FROM care_searches WHERE datetime(requested_at) >= datetime(?) AND datetime(requested_at) <= datetime(?) ${sourceClause}${marketSql}
      GROUP BY hour ORDER BY hour
    `).bind(...orderedValues).all(),
    env.DB.prepare(`
      SELECT COALESCE(market_id, 'unassigned') AS market_id, COUNT(*) AS total,
        SUM(CASE WHEN out_of_market = 1 THEN 1 ELSE 0 END) AS out_of_market
      FROM care_searches WHERE datetime(requested_at) >= datetime(?) AND datetime(requested_at) <= datetime(?) ${sourceClause}
      GROUP BY market_id ORDER BY total DESC
    `).bind(filters.from, filters.to, ...(filters.source && attributionAvailable ? [filters.source] : [])).all()
  ]);

  // "valid intakes" — every persisted care_searches row already passed
  // createCareSearch's validation (an invalid one never reaches the
  // database; see validateIntake in src/index.js) — so it is the same count
  // as `total` here. Reported under both names so a reader looking for
  // either term finds it.
  return {
    searchesStarted: Number(totals?.total || 0),
    validIntakes: Number(totals?.total || 0),
    outOfMarketSearches: Number(totals?.out_of_market || 0),
    byDay: byDay.results.map((row) => ({ date: row.day, total: Number(row.total) })),
    byHour: byHour.results.map((row) => ({ hour: Number(row.hour), total: Number(row.total) })),
    byMarket: byMarket.results.map((row) => ({ marketId: row.market_id, total: Number(row.total), outOfMarket: Number(row.out_of_market) }))
  };
}

/* --------------------------------------------------------------- supply --- */

async function supplyMetrics(env, filters) {
  const values = [];
  const clauses = ["l.active = 1"];
  if (filters.marketId && filters.marketId !== "out_of_market") { clauses.push("l.market_id = ?"); values.push(filters.marketId); }
  if (filters.tenantId) { clauses.push("l.tenant_id = ?"); values.push(filters.tenantId); }
  const where = `WHERE ${clauses.join(" AND ")}`;

  const [activeCount, latestReports, responseRow] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS total FROM locations l ${where}`).bind(...values).first(),
    env.DB.prepare(`
      SELECT l.id AS location_id, ar.intake_status, ar.expires_at, ar.reported_at
      FROM locations l
      LEFT JOIN availability_reports ar ON ar.id = (
        SELECT ar2.id FROM availability_reports ar2 WHERE ar2.location_id = l.id
        ORDER BY datetime(ar2.reported_at) DESC, ar2.rowid DESC LIMIT 1
      )
      ${where}
    `).bind(...values).all(),
    env.DB.prepare(`
      SELECT
        SUM(CASE WHEN t.status = 'offered' THEN 1 ELSE 0 END) AS offered,
        SUM(CASE WHEN t.status = 'declined' THEN 1 ELSE 0 END) AS declined,
        SUM(CASE WHEN t.status = 'expired' THEN 1 ELSE 0 END) AS expired
      FROM care_search_targets t
      JOIN locations l ON l.id = t.location_id
      WHERE datetime(t.created_at) >= datetime(?) AND datetime(t.created_at) <= datetime(?)
        ${filters.marketId && filters.marketId !== "out_of_market" ? "AND l.market_id = ?" : ""}
        ${filters.tenantId ? "AND t.tenant_id = ?" : ""}
    `).bind(filters.from, filters.to,
      ...(filters.marketId && filters.marketId !== "out_of_market" ? [filters.marketId] : []),
      ...(filters.tenantId ? [filters.tenantId] : [])
    ).first()
  ]);

  const now = Date.now();
  const freshness = { fresh: 0, aging: 0, stale: 0, never: 0 };
  const stateCounts = {};
  for (const row of latestReports.results) {
    if (!row.reported_at) { freshness.never += 1; stateCounts.unverified = (stateCounts.unverified || 0) + 1; continue; }
    const status = row.expires_at && timestampMs(row.expires_at) <= now ? "unverified" : (row.intake_status || "unverified");
    stateCounts[status] = (stateCounts[status] || 0) + 1;
    const ageMinutes = (now - timestampMs(row.reported_at)) / 60_000;
    if (ageMinutes <= 30) freshness.fresh += 1;
    else if (ageMinutes <= 120) freshness.aging += 1;
    else freshness.stale += 1;
  }

  const offered = Number(responseRow?.offered || 0);
  const declined = Number(responseRow?.declined || 0);
  const expired = Number(responseRow?.expired || 0);
  const decided = offered + declined;

  return {
    activeClinics: Number(activeCount?.total || 0),
    availabilityStates: Object.entries(stateCounts).map(([status, total]) => ({ status, total })),
    capacityFreshness: freshness,
    clinicResponse: {
      offered, declined, ignoredOrExpired: expired,
      responseRatePct: pct(decided, decided + expired),
      declineRatePct: pct(declined, decided)
    }
  };
}

/* -------------------------------------------------------------- matching --- */

async function matchingMetrics(env, filters, waveAvailable) {
  const marketSql = marketClause(filters, []);
  const values = [filters.from, filters.to];
  if (filters.marketId && filters.marketId !== "out_of_market") values.push(filters.marketId);

  const [searchRows, targetCountRow, firstOfferRows, waveRows] = await Promise.all([
    env.DB.prepare(`
      SELECT s.id, (SELECT COUNT(*) FROM care_offers o WHERE o.search_id = s.id) AS offer_count
      FROM care_searches s
      WHERE datetime(s.requested_at) >= datetime(?) AND datetime(s.requested_at) <= datetime(?)${marketSql}
    `).bind(...values).all(),
    env.DB.prepare(`
      SELECT AVG(target_count) AS avg_targets FROM (
        SELECT s.id, COUNT(t.id) AS target_count
        FROM care_searches s LEFT JOIN care_search_targets t ON t.search_id = s.id
        WHERE datetime(s.requested_at) >= datetime(?) AND datetime(s.requested_at) <= datetime(?)${marketSql}
        GROUP BY s.id
      )
    `).bind(...values).first(),
    env.DB.prepare(`
      SELECT s.requested_at AS requested_at, MIN(o.offered_at) AS first_offered_at
      FROM care_searches s JOIN care_offers o ON o.search_id = s.id
      WHERE datetime(s.requested_at) >= datetime(?) AND datetime(s.requested_at) <= datetime(?)${marketSql}
      GROUP BY s.id
    `).bind(...values).all(),
    waveAvailable ? env.DB.prepare(`
      SELECT t.wave AS wave,
        SUM(CASE WHEN t.status = 'offered' THEN 1 ELSE 0 END) AS offered,
        SUM(CASE WHEN t.status = 'declined' THEN 1 ELSE 0 END) AS declined,
        SUM(CASE WHEN t.status = 'expired' THEN 1 ELSE 0 END) AS expired,
        COUNT(*) AS total
      FROM care_search_targets t JOIN care_searches s ON s.id = t.search_id
      WHERE datetime(s.requested_at) >= datetime(?) AND datetime(s.requested_at) <= datetime(?)${marketSql} AND t.wave IS NOT NULL
      GROUP BY t.wave ORDER BY t.wave
    `).bind(...values).all() : null
  ]);

  const totalSearches = searchRows.results.length;
  const withOffer = searchRows.results.filter((row) => Number(row.offer_count) > 0).length;
  const withTwoPlus = searchRows.results.filter((row) => Number(row.offer_count) >= 2).length;
  const noResult = totalSearches - withOffer;

  const firstOfferMinutes = firstOfferRows.results
    .map((row) => (timestampMs(row.first_offered_at) - timestampMs(row.requested_at)) / 60_000)
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);

  return {
    searchToOfferRatePct: pct(withOffer, totalSearches),
    twoPlusOfferRatePct: pct(withTwoPlus, totalSearches),
    noResultRatePct: pct(noResult, totalSearches),
    medianTimeToFirstOfferMinutes: firstOfferMinutes.length ? round1(median(firstOfferMinutes)) : null,
    avgClinicsContacted: targetCountRow?.avg_targets != null ? round1(Number(targetCountRow.avg_targets)) : null,
    totalSearches,
    // Activates the moment migration 0021 lands (see the module comment) —
    // no code change required, only data.
    waveAvailable,
    byWave: waveAvailable ? waveRows.results.map((row) => ({
      wave: row.wave,
      total: Number(row.total),
      offered: Number(row.offered),
      declined: Number(row.declined),
      expired: Number(row.expired),
      offerRatePct: pct(Number(row.offered), Number(row.total))
    })) : null
  };
}

/* --------------------------------------------------------------- booking --- */

const CONFIRMED_STATUSES = ["accepted", "en_route", "arrived", "triaged", "seen", "completed"];
const VISIT_STATUSES = ["arrived", "triaged", "seen", "completed"];

async function bookingMetrics(env, filters) {
  // intake_requests has no market_id of its own — it is reached through the
  // care_search that produced it (source_search_id), which does.
  const marketFilter = filters.marketId && filters.marketId !== "out_of_market"
    ? "AND i.source_search_id IN (SELECT id FROM care_searches WHERE market_id = ?)"
    : filters.marketId === "out_of_market"
      ? "AND i.source_search_id IN (SELECT id FROM care_searches WHERE out_of_market = 1)"
      : "";
  const tenantFilter = filters.tenantId ? "AND i.tenant_id = ?" : "";
  const values = [filters.from, filters.to];
  if (filters.marketId && filters.marketId !== "out_of_market") values.push(filters.marketId);
  if (filters.tenantId) values.push(filters.tenantId);

  // "Viewed" is written per-search with no tenant (a customer views a set of
  // offers, not one clinic's), so only the market filter applies here — the
  // event itself carries market_id at write time (see the GET
  // /api/searches/:id hook in src/index.js).
  const viewedMarketSql = marketClause(filters, []);
  const viewedValues = [filters.from, filters.to];
  if (filters.marketId && filters.marketId !== "out_of_market") viewedValues.push(filters.marketId);

  const [viewed, statusRow] = await Promise.all([
    env.DB.prepare(`
      SELECT COUNT(DISTINCT search_id) AS total FROM marketplace_events
      WHERE event_type = 'offers_viewed' AND datetime(occurred_at) >= datetime(?) AND datetime(occurred_at) <= datetime(?)${viewedMarketSql}
    `).bind(...viewedValues).first(),
    env.DB.prepare(`
      SELECT
        COUNT(*) AS selected,
        SUM(CASE WHEN payment_status = 'paid' THEN 1 ELSE 0 END) AS paid,
        SUM(CASE WHEN status IN (${CONFIRMED_STATUSES.map(() => "?").join(",")}) THEN 1 ELSE 0 END) AS confirmed,
        SUM(CASE WHEN status IN (${VISIT_STATUSES.map(() => "?").join(",")}) THEN 1 ELSE 0 END) AS visited,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
        SUM(CASE WHEN status = 'no_show' THEN 1 ELSE 0 END) AS no_show
      FROM intake_requests i
      WHERE source_search_id IS NOT NULL AND datetime(requested_at) >= datetime(?) AND datetime(requested_at) <= datetime(?)
        ${marketFilter} ${tenantFilter}
    `).bind(...CONFIRMED_STATUSES, ...VISIT_STATUSES, ...values).first()
  ]);

  return {
    // "Viewed" is the one funnel step nothing else records — see
    // marketplace_events / recordMarketplaceEvent and the GET
    // /api/searches/:id hook in src/index.js. Distinct searches, since a
    // customer polling the same screen writes at most one such event
    // (idempotencyKey = the search id).
    offersViewed: Number(viewed?.total || 0),
    offersSelected: Number(statusRow?.selected || 0),
    paid: Number(statusRow?.paid || 0),
    confirmedBooking: Number(statusRow?.confirmed || 0),
    confirmedVisit: Number(statusRow?.visited || 0),
    cancellations: Number(statusRow?.cancelled || 0),
    noShows: Number(statusRow?.no_show || 0)
  };
}

/* --------------------------------------------------------------- revenue --- */

async function revenueMetrics(env, filters) {
  const marketJoin = filters.marketId
    ? `JOIN intake_requests i ON i.id = p.intake_id JOIN locations l ON l.id = i.location_id`
    : "";
  const marketFilter = filters.marketId === "out_of_market"
    ? "AND i.source_search_id IN (SELECT id FROM care_searches WHERE out_of_market = 1)"
    : filters.marketId ? "AND l.market_id = ?" : "";
  const tenantFilter = filters.tenantId ? "AND p.tenant_id = ?" : "";
  const values = [filters.from, filters.to];
  if (filters.marketId && filters.marketId !== "out_of_market") values.push(filters.marketId);
  if (filters.tenantId) values.push(filters.tenantId);

  const [totalsRow, byMarketRows] = await Promise.all([
    env.DB.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN p.kind = 'deposit_captured' THEN p.amount_cents ELSE 0 END), 0) AS customer_payments_cents,
        COALESCE(SUM(CASE WHEN p.kind = 'clinic_transfer' THEN p.amount_cents ELSE 0 END), 0) AS clinic_transfers_cents,
        COALESCE(SUM(CASE WHEN p.kind = 'platform_fee' THEN p.amount_cents ELSE 0 END), 0) AS platform_fee_cents,
        COALESCE(SUM(CASE WHEN p.kind = 'customer_refund' THEN p.amount_cents ELSE 0 END), 0) AS refunds_cents
      FROM payment_ledger p ${marketJoin}
      WHERE datetime(p.occurred_at) >= datetime(?) AND datetime(p.occurred_at) <= datetime(?) ${marketFilter} ${tenantFilter}
    `).bind(...values).first(),
    env.DB.prepare(`
      SELECT COALESCE(l.market_id, 'unassigned') AS market_id,
        COALESCE(SUM(CASE WHEN p.kind = 'platform_fee' THEN p.amount_cents ELSE 0 END), 0) AS platform_fee_cents,
        COALESCE(SUM(CASE WHEN p.kind = 'clinic_transfer' THEN p.amount_cents ELSE 0 END), 0) AS clinic_transfers_cents
      FROM payment_ledger p
      JOIN intake_requests i ON i.id = p.intake_id
      JOIN locations l ON l.id = i.location_id
      WHERE datetime(p.occurred_at) >= datetime(?) AND datetime(p.occurred_at) <= datetime(?) ${tenantFilter}
      GROUP BY market_id ORDER BY platform_fee_cents DESC
    `).bind(filters.from, filters.to, ...(filters.tenantId ? [filters.tenantId] : [])).all()
  ]);

  // "Successful connection" = a confirmed booking, reusing the same
  // definition bookingMetrics uses, so the per-connection figure and the
  // booking funnel never disagree about what counts as one.
  const confirmedRow = await env.DB.prepare(`
    SELECT COUNT(*) AS total FROM intake_requests i
    ${filters.marketId ? "JOIN care_searches s ON s.id = i.source_search_id" : ""}
    WHERE datetime(i.requested_at) >= datetime(?) AND datetime(i.requested_at) <= datetime(?)
      AND i.status IN (${CONFIRMED_STATUSES.map(() => "?").join(",")})
      ${filters.marketId === "out_of_market" ? "AND s.out_of_market = 1" : filters.marketId ? "AND s.market_id = ?" : ""}
      ${filters.tenantId ? "AND i.tenant_id = ?" : ""}
  `).bind(
    filters.from, filters.to, ...CONFIRMED_STATUSES,
    ...(filters.marketId && filters.marketId !== "out_of_market" ? [filters.marketId] : []),
    ...(filters.tenantId ? [filters.tenantId] : [])
  ).first();

  const platformFeeCents = Number(totalsRow?.platform_fee_cents || 0);
  const confirmed = Number(confirmedRow?.total || 0);

  return {
    customerPaymentsCents: Number(totalsRow?.customer_payments_cents || 0),
    clinicTransfersCents: Number(totalsRow?.clinic_transfers_cents || 0),
    platformFeeCents,
    refundsCents: Number(totalsRow?.refunds_cents || 0),
    revenuePerConnectionCents: confirmed ? Math.round(platformFeeCents / confirmed) : null,
    byMarket: byMarketRows.results.map((row) => ({
      marketId: row.market_id, platformFeeCents: Number(row.platform_fee_cents), clinicTransfersCents: Number(row.clinic_transfers_cents)
    }))
  };
}

/* --------------------------------------------------------------- quality --- */

async function qualityMetrics(env, filters) {
  // care_search_targets carries no market_id of its own — for a real market
  // it is reached through its location; for the synthetic 'out_of_market'
  // bucket (which describes the *search*, not the clinic contacted) it is
  // reached through its search instead, the same way bookingMetrics reaches
  // out-of-market intakes above.
  const targetValues = [filters.from, filters.to];
  let targetMarketFilter = "";
  if (filters.marketId === "out_of_market") {
    targetMarketFilter = "AND t.search_id IN (SELECT id FROM care_searches WHERE out_of_market = 1)";
  } else if (filters.marketId) {
    targetMarketFilter = "AND t.location_id IN (SELECT id FROM locations WHERE market_id = ?)";
    targetValues.push(filters.marketId);
  }
  if (filters.tenantId) targetValues.push(filters.tenantId);

  const [targetRow, offerRow, errorRows, cancelRow, staleRow] = await Promise.all([
    env.DB.prepare(`
      SELECT
        SUM(CASE WHEN t.status = 'expired' THEN 1 ELSE 0 END) AS expired_requests,
        SUM(CASE WHEN t.status = 'declined' THEN 1 ELSE 0 END) AS declined,
        SUM(CASE WHEN t.status = 'offered' THEN 1 ELSE 0 END) AS offered
      FROM care_search_targets t
      WHERE datetime(t.created_at) >= datetime(?) AND datetime(t.created_at) <= datetime(?)
        ${targetMarketFilter} ${filters.tenantId ? "AND t.tenant_id = ?" : ""}
    `).bind(...targetValues).first(),
    env.DB.prepare(`
      SELECT COUNT(*) AS expired_offers FROM care_offers
      WHERE status = 'expired' AND datetime(offered_at) >= datetime(?) AND datetime(offered_at) <= datetime(?)
    `).bind(filters.from, filters.to).first(),
    env.DB.prepare(`
      SELECT surface, code, COUNT(*) AS total FROM client_errors
      WHERE datetime(occurred_at) >= datetime(?) AND datetime(occurred_at) <= datetime(?)
      GROUP BY surface, code ORDER BY total DESC LIMIT 15
    `).bind(filters.from, filters.to).all(),
    env.DB.prepare(`
      SELECT COUNT(*) AS total FROM care_searches
      WHERE status = 'cancelled' AND datetime(requested_at) >= datetime(?) AND datetime(requested_at) <= datetime(?)${marketClause(filters, [])}
    `).bind(filters.from, filters.to, ...(filters.marketId && filters.marketId !== "out_of_market" ? [filters.marketId] : [])).first(),
    // Current, live snapshot — how many active locations' most recent
    // availability report is already expired right now. An incident count
    // over time would need its own event stream; this reports the present
    // state, which is what an operator opening the dashboard actually wants
    // first. See supplyMetrics.capacityFreshness for the same signal shaped
    // as a distribution across all locations, not only the stale ones.
    env.DB.prepare(`
      SELECT COUNT(*) AS total FROM locations l
      WHERE l.active = 1 AND (
        NOT EXISTS (SELECT 1 FROM availability_reports ar WHERE ar.location_id = l.id)
        OR (SELECT ar2.expires_at FROM availability_reports ar2 WHERE ar2.location_id = l.id ORDER BY datetime(ar2.reported_at) DESC, ar2.rowid DESC LIMIT 1) <= datetime('now')
      )
      ${filters.marketId && filters.marketId !== "out_of_market" ? "AND l.market_id = ?" : ""}
    `).bind(...(filters.marketId && filters.marketId !== "out_of_market" ? [filters.marketId] : [])).first()
  ]);

  const offered = Number(targetRow?.offered || 0);
  const declined = Number(targetRow?.declined || 0);

  return {
    staleCapacityLocationsNow: Number(staleRow?.total || 0),
    ignoredOrExpiredRequests: Number(targetRow?.expired_requests || 0),
    expiredOffers: Number(offerRow?.expired_offers || 0),
    clinicDeclineRatePct: pct(declined, declined + offered),
    // Abandonment is under-instrumented today: a customer who closes the tab
    // mid-search leaves no row anywhere. The one abandonment point this
    // table can see is an explicit cancel — see the searchCancelled event
    // written from cancelCareSearch in src/index.js. A page-close signal
    // would need a client-side beacon and is deferred; see the report for
    // this task.
    customerAbandonment: { explicitCancellations: Number(cancelRow?.total || 0) },
    technicalFailures: errorRows.results.map((row) => ({ surface: row.surface, code: row.code, total: Number(row.total) }))
  };
}

/* ---------------------------------------------------------------- report --- */

export async function getMetrics(env, url) {
  if (!hasDatabase(env)) return { filters: parseFilters(url), demand: null, supply: null, matching: null, booking: null, revenue: null, quality: null };
  const filters = parseFilters(url);
  const [waveAvailable, attributionAvailable] = await Promise.all([
    columnExists(env, "care_search_targets", "wave"),
    columnExists(env, "care_searches", "attribution_source")
  ]);

  const [demand, supply, matching, booking, revenue, quality] = await Promise.all([
    demandMetrics(env, filters, attributionAvailable),
    supplyMetrics(env, filters),
    matchingMetrics(env, filters, waveAvailable),
    bookingMetrics(env, filters),
    revenueMetrics(env, filters),
    qualityMetrics(env, filters)
  ]);

  return { filters, waveAvailable, attributionAvailable, demand, supply, matching, booking, revenue, quality };
}

/* ---------------------------------------------------------------- alerts --- */

export async function getAlertThresholds(env) {
  if (!hasDatabase(env)) {
    return { minOfferRatePct: 70, maxMedianFirstOfferMinutes: 5, maxNoResultRatePct: 15, maxDeclineRatePct: 40, windowHours: 24 };
  }
  const row = await env.DB.prepare("SELECT * FROM metrics_alert_thresholds WHERE id = 'default' LIMIT 1").first();
  return {
    minOfferRatePct: row?.min_offer_rate_pct ?? 70,
    maxMedianFirstOfferMinutes: row?.max_median_first_offer_minutes ?? 5,
    maxNoResultRatePct: row?.max_no_result_rate_pct ?? 15,
    maxDeclineRatePct: row?.max_decline_rate_pct ?? 40,
    windowHours: row?.window_hours ?? 24
  };
}

export async function updateAlertThresholds(env, actor, body) {
  if (!hasDatabase(env)) return { status: 503, code: "DATABASE_REQUIRED", message: "D1 is required to update alert thresholds." };
  const current = await getAlertThresholds(env);
  const num = (value, min, max, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
  };
  const next = {
    minOfferRatePct: num(body?.minOfferRatePct, 0, 100, current.minOfferRatePct),
    maxMedianFirstOfferMinutes: num(body?.maxMedianFirstOfferMinutes, 0, 1440, current.maxMedianFirstOfferMinutes),
    maxNoResultRatePct: num(body?.maxNoResultRatePct, 0, 100, current.maxNoResultRatePct),
    maxDeclineRatePct: num(body?.maxDeclineRatePct, 0, 100, current.maxDeclineRatePct),
    windowHours: num(body?.windowHours, 1, 168, current.windowHours)
  };
  await env.DB.prepare(`
    UPDATE metrics_alert_thresholds SET
      min_offer_rate_pct = ?, max_median_first_offer_minutes = ?, max_no_result_rate_pct = ?, max_decline_rate_pct = ?, window_hours = ?,
      updated_at = CURRENT_TIMESTAMP, updated_by = ?
    WHERE id = 'default'
  `).bind(next.minOfferRatePct, next.maxMedianFirstOfferMinutes, next.maxNoResultRatePct, next.maxDeclineRatePct, next.windowHours, actor.userId).run();
  return { status: 200, body: { thresholds: next } };
}

/**
 * Current breaches against `metrics_alert_thresholds`, over that config's
 * own recent window (not the dashboard's date-range filter — an alert asks
 * "is something wrong right now", not "how did last quarter look"). Wiring
 * to email/SMS is deferred; this endpoint is the structured answer a
 * notifier would poll.
 */
export async function checkAlerts(env) {
  if (!hasDatabase(env)) return { checkedAt: new Date().toISOString(), windowHours: 24, breaches: [], values: null };
  const thresholds = await getAlertThresholds(env);
  const to = new Date().toISOString();
  const from = new Date(Date.now() - thresholds.windowHours * 3_600_000).toISOString();
  const filters = { from, to, marketId: null, tenantId: null, source: null };
  const [matching, supply] = await Promise.all([
    matchingMetrics(env, filters, false),
    supplyMetrics(env, filters)
  ]);

  const breaches = [];
  if (matching.searchToOfferRatePct !== null && matching.searchToOfferRatePct < thresholds.minOfferRatePct) {
    breaches.push({ metric: "searchToOfferRatePct", value: matching.searchToOfferRatePct, threshold: thresholds.minOfferRatePct, direction: "below" });
  }
  if (matching.medianTimeToFirstOfferMinutes !== null && matching.medianTimeToFirstOfferMinutes > thresholds.maxMedianFirstOfferMinutes) {
    breaches.push({ metric: "medianTimeToFirstOfferMinutes", value: matching.medianTimeToFirstOfferMinutes, threshold: thresholds.maxMedianFirstOfferMinutes, direction: "above" });
  }
  if (matching.noResultRatePct !== null && matching.noResultRatePct > thresholds.maxNoResultRatePct) {
    breaches.push({ metric: "noResultRatePct", value: matching.noResultRatePct, threshold: thresholds.maxNoResultRatePct, direction: "above" });
  }
  if (supply.clinicResponse.declineRatePct !== null && supply.clinicResponse.declineRatePct > thresholds.maxDeclineRatePct) {
    breaches.push({ metric: "clinicDeclineRatePct", value: supply.clinicResponse.declineRatePct, threshold: thresholds.maxDeclineRatePct, direction: "above" });
  }

  return {
    checkedAt: to,
    windowHours: thresholds.windowHours,
    thresholds,
    breaches,
    values: {
      searchToOfferRatePct: matching.searchToOfferRatePct,
      medianTimeToFirstOfferMinutes: matching.medianTimeToFirstOfferMinutes,
      noResultRatePct: matching.noResultRatePct,
      clinicDeclineRatePct: supply.clinicResponse.declineRatePct
    }
  };
}
