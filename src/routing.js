/**
 * Staged wave routing.
 *
 * `createCareSearch` (src/index.js) used to insert every matching clinic as
 * `awaiting_response` in one INSERT and fire a dashboard notification and a
 * phone call for all of them in the same request — a flat broadcast. That
 * meant a clinic six miles out with a full parking lot got rung at the same
 * moment as the closest clinic with an open bay, and a clinic that reliably
 * never answers Tími kept getting called first forever, because nothing
 * remembered that it never answers.
 *
 * This module ranks candidates once, at search creation, and assigns each
 * one a wave number. `care_search_targets` still gets one row per candidate
 * up front — nothing here defers the INSERT — but a target's
 * `wave_activated_at` stays NULL until `advanceSearchWaves` decides its wave
 * is due. A Cloudflare Worker has no background timer, so "due" is decided
 * lazily: every time the customer polls `GET /api/searches/:id` (or a clinic
 * responds), the elapsed time since the search was requested is checked
 * against the wave schedule and any wave that has come due is activated —
 * which is the point in time its dashboard notification and voice call are
 * finally enqueued.
 *
 * ═══════════════════════════════════════════ the ranking invariant ═══════
 *
 * `scoreCandidate` below combines required-capability match, reported
 * capacity and how fresh that report is, species/case eligibility, travel
 * time, reported wait, and this clinic's own historical response
 * reliability. It NEVER reads anything about payment: no founding-clinic
 * status, no pricing plan, no sponsorship, no "paid placement" of any kind.
 * Selling a better wave position would be selling triage order to whoever
 * pays for it, which is not a feature this platform offers. If you are
 * adding a signal to this function, it must be something that predicts
 * whether this clinic can actually help this patient soonest — nothing
 * about what Tími earns from the clinic.
 */

import { hasDatabase } from "./db.js";

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

/* ─────────────────────────────────────────────────────── routing policy ─── */

/**
 * Used only when D1 is unavailable (demo mode, the local UI harness) or when
 * no policy row exists yet. Kept in step with migration 0021's seeded
 * `routing_v1` row by convention, the same way src/pricing.js's
 * FALLBACK_PRICING is kept in step with pricing_policies.
 */
export const FALLBACK_ROUTING_POLICY = Object.freeze({
  id: "routing_fallback",
  waves: Object.freeze([
    Object.freeze({ size: 3, durationSeconds: 90 }),
    Object.freeze({ size: 3, durationSeconds: 90 }),
    Object.freeze({ size: 4, durationSeconds: 120 })
  ]),
  expansionBatchSize: 4,
  expansionDurationSeconds: 120,
  searchWindowMinutes: 10,
  offerHoldMinutes: 5
});

function policyFromRow(row) {
  if (!row) return null;
  let waves;
  try {
    waves = JSON.parse(row.waves_json);
  } catch {
    waves = null;
  }
  if (!Array.isArray(waves) || !waves.length) waves = FALLBACK_ROUTING_POLICY.waves;
  return {
    id: row.id,
    waves: waves
      .map((wave) => ({
        size: Math.max(1, Math.trunc(Number(wave?.size) || 1)),
        durationSeconds: Math.max(15, Math.trunc(Number(wave?.durationSeconds) || 90))
      })),
    expansionBatchSize: Math.max(1, Math.trunc(Number(row.expansion_batch_size) || FALLBACK_ROUTING_POLICY.expansionBatchSize)),
    expansionDurationSeconds: Math.max(15, Math.trunc(Number(row.expansion_duration_seconds) || FALLBACK_ROUTING_POLICY.expansionDurationSeconds)),
    searchWindowMinutes: Number(row.search_window_minutes) > 0 ? Number(row.search_window_minutes) : FALLBACK_ROUTING_POLICY.searchWindowMinutes,
    offerHoldMinutes: Number(row.offer_hold_minutes) > 0 ? Number(row.offer_hold_minutes) : FALLBACK_ROUTING_POLICY.offerHoldMinutes
  };
}

/**
 * The routing policy in effect for a new search: a tenant override if the
 * search is scoped to a single tenant's own routing (not used today, but the
 * per-tenant override exists for an admin who needs one clinic network to
 * run a different cadence), otherwise the platform default, otherwise the
 * fallback constant.
 */
export async function activeRoutingPolicy(env, { tenantId = null } = {}) {
  if (!hasDatabase(env)) return FALLBACK_ROUTING_POLICY;
  if (tenantId) {
    const tenantRow = await env.DB.prepare(
      "SELECT * FROM routing_policies WHERE tenant_id = ? AND active = 1 LIMIT 1"
    ).bind(tenantId).first();
    const tenantPolicy = policyFromRow(tenantRow);
    if (tenantPolicy) return tenantPolicy;
  }
  const globalRow = await env.DB.prepare(
    "SELECT * FROM routing_policies WHERE tenant_id IS NULL AND active = 1 LIMIT 1"
  ).first();
  return policyFromRow(globalRow) || FALLBACK_ROUTING_POLICY;
}

/** How many candidates the wave at this 1-indexed position takes. */
function waveSize(policy, waveNumber) {
  const explicit = policy.waves[waveNumber - 1];
  return explicit ? explicit.size : policy.expansionBatchSize;
}

/** How long the wave at this 1-indexed position runs before the next one is due. */
function waveDurationSeconds(policy, waveNumber) {
  const explicit = policy.waves[waveNumber - 1];
  return explicit ? explicit.durationSeconds : policy.expansionDurationSeconds;
}

/** Seconds after the search was requested at which this wave becomes due. Wave 1 is due at 0. */
export function waveStartOffsetSeconds(policy, waveNumber) {
  let offset = 0;
  for (let i = 1; i < waveNumber; i += 1) offset += waveDurationSeconds(policy, i);
  return offset;
}

/**
 * Assigns each ranked candidate (best first) a 1-indexed wave number: the
 * first `policy.waves[0].size` candidates are wave 1, the next
 * `policy.waves[1].size` are wave 2, and so on; once the named waves are
 * exhausted, candidates keep being assigned in batches of
 * `policy.expansionBatchSize` for as long as candidates remain. Whether a
 * late wave actually gets activated before the search window closes is a
 * question for `advanceSearchWaves`, not this function — this only decides
 * order.
 */
export function assignWaves(rankedCandidates, policy) {
  const assignments = [];
  let index = 0;
  let wave = 1;
  while (index < rankedCandidates.length) {
    const size = waveSize(policy, wave);
    for (let i = 0; i < size && index < rankedCandidates.length; i += 1, index += 1) {
      assignments.push({ candidate: rankedCandidates[index], waveNumber: wave });
    }
    wave += 1;
    // A CHECK constraint keeps every duration >= 15s, so this cannot spin
    // forever, but a defensive ceiling costs nothing.
    if (wave > 50) break;
  }
  return assignments;
}

/* ────────────────────────────────────────────────────────────── ranking ─── */

const CAPABILITY_HINTS = {
  possible_emergency: ["emergency"],
  emergency: ["emergency"],
  toxin_ingestion: ["toxin"],
  poisoning: ["toxin"],
  trauma: ["surgery", "imaging"],
  vomiting_diarrhea: ["vomiting"],
  wound_or_injury: ["minor_injury", "surgery"],
  breathing_difficulty: ["oxygen"],
  behavior_or_energy: []
};

function requiredCapabilitiesFor({ concernCategory, redFlags, urgency }) {
  const hints = new Set(CAPABILITY_HINTS[concernCategory] || []);
  if (urgency === "emergency") hints.add("emergency");
  const flagText = (redFlags || []).join(" ").toLowerCase();
  if (/poison|toxin/.test(flagText)) hints.add("toxin");
  if (/breath/.test(flagText)) hints.add("oxygen");
  if (/bleed|hit by car|collapsed/.test(flagText)) hints.add("surgery");
  return [...hints];
}

/**
 * A clinic's historical reliability as a single 0..1 score. A clinic with no
 * history yet gets a neutral prior rather than being punished for being new
 * or rewarded for having never been tested — 0.6, slightly above the
 * midpoint, so an unproven clinic still ranks above one with a demonstrated
 * pattern of ignoring requests.
 */
export function reliabilityScoreFromStats(stats) {
  const received = Number(stats?.requestsReceived) || 0;
  if (!received) return 0.6;
  const responseRate = Math.min(1, (Number(stats.requestsResponded) || 0) / received);
  const ignoreRate = Math.min(1, (Number(stats.requestsIgnored) || 0) / received);
  const medianSeconds = stats.medianResponseSeconds;
  const speedScore = Number.isFinite(medianSeconds) ? Math.max(0, 1 - medianSeconds / 300) : 0.5;
  const score = responseRate * 0.55 + speedScore * 0.2 - ignoreRate * 0.45 + 0.25;
  return Math.max(0, Math.min(1, score));
}

/**
 * Every historical reliability row for a set of tenants, keyed by tenant id.
 * One query for the whole candidate pool rather than one per candidate.
 */
export async function reliabilityByTenant(env, tenantIds) {
  const ids = [...new Set((tenantIds || []).filter(Boolean))];
  if (!ids.length || !hasDatabase(env)) return {};
  const placeholders = ids.map(() => "?").join(",");
  const result = await env.DB.prepare(
    `SELECT * FROM clinic_response_stats WHERE tenant_id IN (${placeholders})`
  ).bind(...ids).all();
  const byTenant = {};
  for (const row of result.results) {
    byTenant[row.tenant_id] = {
      requestsReceived: Number(row.requests_received || 0),
      requestsResponded: Number(row.requests_responded || 0),
      requestsIgnored: Number(row.requests_ignored || 0),
      medianResponseSeconds: row.median_response_seconds === null ? null : Number(row.median_response_seconds)
    };
  }
  return byTenant;
}

/**
 * A single 0..1 score for one candidate clinic. Higher ranks earlier.
 * Weighted sum of: current intake status, how fresh that report is,
 * reported remaining capacity, whether the clinic carries a capability this
 * case is likely to need, travel time, reported wait, and historical
 * response reliability. See the module header: payment status of any kind
 * is never a term in this function, by design and on purpose.
 */
export function scoreCandidate(location, { urgency, concernCategory, redFlags, reliability } = {}) {
  const availability = location?.availability || {};
  const statusScore = ({
    available: 1, limited: 0.75, confirm_first: 0.5, critical_only: 0.4, unverified: 0.15, diverting: 0.05, closed: 0
  })[availability.intakeStatus] ?? 0.15;
  const freshnessScore = availability.stale
    ? 0.1
    : ({ high: 1, medium: 0.6, low: 0.3 })[availability.confidence] ?? 0.3;
  const capacityScore = availability.capacityCount === null || availability.capacityCount === undefined
    ? 0.5
    : Math.max(0, Math.min(1, Number(availability.capacityCount) / 3));
  const distanceMiles = Number.isFinite(location?.distanceMiles) ? location.distanceMiles : 25;
  const travelScore = Math.max(0, 1 - distanceMiles / 30);
  const waitMinutes = Number.isFinite(availability.stableWaitMin) ? availability.stableWaitMin : 45;
  const waitScore = Math.max(0, 1 - waitMinutes / 120);
  const required = requiredCapabilitiesFor({ concernCategory, redFlags, urgency });
  const capabilities = location?.capabilities || [];
  const capabilityScore = required.length
    ? (required.some((capability) => capabilities.includes(capability)) ? 1 : 0.3)
    : 0.7;
  const reliabilityScore = reliabilityScoreFromStats(reliability);

  return (
    statusScore * 0.22 +
    freshnessScore * 0.10 +
    capacityScore * 0.10 +
    capabilityScore * 0.15 +
    travelScore * 0.18 +
    waitScore * 0.15 +
    reliabilityScore * 0.10
  );
}

/**
 * Ranks candidate locations best-first for one care search. Returns the same
 * location objects with a `_routingScore` attached for analytics — never
 * consumed anywhere but logging and the `rank_score` column.
 */
export function rankCandidates(candidates, reliabilityMap, { urgency, concernCategory, redFlags } = {}) {
  return candidates
    .map((location) => ({
      location,
      score: scoreCandidate(location, { urgency, concernCategory, redFlags, reliability: reliabilityMap?.[location.tenantId] })
    }))
    .sort((a, b) => b.score - a.score);
}

/* ─────────────────────────────────────────────────────── wave advancement ─── */

/**
 * Lazily activates every wave that has come due for one search, given how
 * much time has elapsed since it was requested. Called on every customer
 * poll of `GET /api/searches/:id` and on every clinic decision — there is no
 * other clock in a Worker. Returns `true` if it changed anything (the caller
 * should re-read the search), `false` otherwise.
 *
 * Idempotent and safe to call redundantly: the UPDATE only ever touches rows
 * still `wave_activated_at IS NULL`, so two overlapping polls racing here
 * activate the same wave at most once each.
 */
export async function advanceSearchWaves(env, search) {
  if (!hasDatabase(env) || !search) return false;
  if (!["collecting", "offers_ready"].includes(search.status)) return false;

  const policy = search.routingSnapshot || FALLBACK_ROUTING_POLICY;
  const requestedAtMs = Date.parse(search.requestedAt);
  const collectionExpiresAtMs = Date.parse(search.collectionExpiresAt);
  if (!Number.isFinite(requestedAtMs)) return false;
  const nowMs = Date.now();
  const elapsedSeconds = Math.max(0, (nowMs - requestedAtMs) / 1000);
  const collectionWindowSeconds = Number.isFinite(collectionExpiresAtMs)
    ? Math.max(0, (collectionExpiresAtMs - requestedAtMs) / 1000)
    : elapsedSeconds;

  if (elapsedSeconds > collectionWindowSeconds) {
    // The collection window is over. No more waves activate; whatever is
    // still sitting in a future, unactivated wave is voided now rather than
    // left to the five-minute cron sweep — see releaseUnactivatedTargets.
    await releaseUnactivatedTargets(env, search.id);
    return false;
  }

  let dueWave = 1;
  while (waveStartOffsetSeconds(policy, dueWave + 1) <= elapsedSeconds) dueWave += 1;

  // Whether or not `dueWave` has advanced past `search.currentWave`, ask for
  // every target at or below it that has not been activated yet — cheap,
  // and correct even for a wave 1 target that, for whatever reason, missed
  // activation at creation time.
  const pending = await env.DB.prepare(`
    SELECT t.id AS target_id, t.location_id, t.tenant_id, t.travel_minutes, l.name AS location_name, l.phone AS location_phone
    FROM care_search_targets t
    JOIN locations l ON l.id = t.location_id
    WHERE t.search_id = ? AND t.wave_activated_at IS NULL AND t.wave_number <= ?
      AND t.status IN ('contacting', 'awaiting_response')
  `).bind(search.id, dueWave).all();
  if (!pending.results.length) return false;

  const now = new Date().toISOString();
  const statements = [
    env.DB.prepare(`
      UPDATE care_search_targets
      SET wave_activated_at = ?, contacted_at = COALESCE(contacted_at, ?), updated_at = ?
      WHERE search_id = ? AND wave_activated_at IS NULL AND wave_number <= ?
        AND status IN ('contacting', 'awaiting_response')
    `).bind(now, now, now, search.id, dueWave),
    env.DB.prepare(`
      UPDATE care_searches SET current_wave = ?, last_wave_activated_at = ?, updated_at = ? WHERE id = ?
    `).bind(dueWave, now, now, search.id)
  ];

  const spokenConcernText = spokenConcernFromSearch(search);
  const tenantsContacted = new Set();
  for (const target of pending.results) {
    statements.push(
      env.DB.prepare(`
        INSERT INTO notification_outbox (id, tenant_id, channel, template_key, payload_json, available_at)
        VALUES (?, ?, 'dashboard', 'new_care_search', ?, ?)
      `).bind(
        newId("notification"), target.tenant_id,
        JSON.stringify({ searchId: search.id, targetId: target.target_id, petName: search.pet?.name, urgency: search.urgency }),
        now
      ),
      env.DB.prepare(`
        INSERT INTO notification_outbox (id, tenant_id, channel, recipient, template_key, payload_json, available_at)
        VALUES (?, ?, 'voice', ?, 'care_search_call', ?, ?)
      `).bind(
        newId("notification"), target.tenant_id, target.location_phone,
        JSON.stringify({
          searchId: search.id,
          targetId: target.target_id,
          locationId: target.location_id,
          locationName: target.location_name,
          petName: search.pet?.name,
          species: search.pet?.species,
          urgency: search.urgency,
          spokenConcern: spokenConcernText,
          travelMinutes: target.travel_minutes,
          expiresAt: search.searchExpiresAt
        }),
        now
      )
    );
    tenantsContacted.add(target.tenant_id);
  }
  for (const tenantId of tenantsContacted) {
    statements.push(env.DB.prepare(`
      INSERT INTO clinic_response_stats (tenant_id, requests_received, updated_at)
      VALUES (?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(tenant_id) DO UPDATE SET
        requests_received = requests_received + 1,
        updated_at = CURRENT_TIMESTAMP
    `).bind(tenantId));
  }

  await env.DB.batch(statements);
  return true;
}

/**
 * Voids every target still sitting in a wave that never got to activate —
 * called when the collection window closes without exhausting the candidate
 * list, and reused by the booking/cancellation paths in src/index.js for the
 * same release they already perform on every other still-open target.
 * `released` rather than `expired`: these were never offered a chance to
 * respond, which is a different fact than "asked and ran out of time".
 */
export async function releaseUnactivatedTargets(env, searchId) {
  if (!hasDatabase(env)) return 0;
  const now = new Date().toISOString();
  const result = await env.DB.prepare(`
    UPDATE care_search_targets SET status = 'released', released_at = ?, updated_at = ?
    WHERE search_id = ? AND wave_activated_at IS NULL AND status IN ('contacting', 'awaiting_response')
  `).bind(now, now, searchId).run();
  return Number(result?.meta?.changes || 0);
}

/** Builds the same "no pet name, no diagnosis" summary spokenConcern in src/index.js builds at creation, from what the search row kept. */
function spokenConcernFromSearch(search) {
  // Kept intentionally small and local rather than importing src/index.js's
  // richer spokenConcern (which needs the full symptom vocabulary): later
  // waves speak the concern category and urgency, which is what a clinic
  // needs to decide whether to pick up, without re-deriving the exact
  // wording chosen at intake time.
  const urgent = search.urgency === "emergency" ? "an emergency" : "urgent care";
  const species = search.pet?.species || "a pet";
  return `${species} needing ${urgent}`;
}

/* ───────────────────────────────────────────────── reliability updates ─── */

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Recorded when a clinic responds (offer or decline both count — an honest decline is not what "ignored" means). */
export async function recordClinicResponded(env, tenantId, { contactedAt } = {}) {
  if (!hasDatabase(env) || !tenantId) return;
  const row = await env.DB.prepare("SELECT response_seconds_samples_json FROM clinic_response_stats WHERE tenant_id = ?").bind(tenantId).first();
  let samples = [];
  try { samples = JSON.parse(row?.response_seconds_samples_json || "[]"); } catch { samples = []; }
  const contactedAtMs = Date.parse(contactedAt || "");
  if (Number.isFinite(contactedAtMs)) {
    samples.push(Math.max(0, Math.round((Date.now() - contactedAtMs) / 1000)));
    if (samples.length > 20) samples = samples.slice(samples.length - 20);
  }
  await env.DB.prepare(`
    INSERT INTO clinic_response_stats (tenant_id, requests_received, requests_responded, response_seconds_samples_json, median_response_seconds, last_response_at, updated_at)
    VALUES (?, 0, 1, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(tenant_id) DO UPDATE SET
      requests_responded = requests_responded + 1,
      response_seconds_samples_json = excluded.response_seconds_samples_json,
      median_response_seconds = excluded.median_response_seconds,
      last_response_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `).bind(tenantId, JSON.stringify(samples), median(samples)).run();
}

/** Recorded when an activated target's wave never gets a response before the search or collection window ends. */
export async function recordClinicIgnored(env, tenantIds) {
  if (!hasDatabase(env)) return;
  const ids = [...new Set((tenantIds || []).filter(Boolean))];
  if (!ids.length) return;
  await env.DB.batch(ids.map((tenantId) => env.DB.prepare(`
    INSERT INTO clinic_response_stats (tenant_id, requests_received, requests_ignored, updated_at)
    VALUES (?, 0, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(tenant_id) DO UPDATE SET
      requests_ignored = requests_ignored + 1,
      updated_at = CURRENT_TIMESTAMP
  `).bind(tenantId)));
}
