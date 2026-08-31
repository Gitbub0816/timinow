import { LEGAL_VERSION } from "../src/catalog.js";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import worker from "../apps/voice-gateway/src/index.js";
import { applyMigrations } from "./lib/migrations.mjs";
import {
  acceptedTwiml,
  alreadyFilledTwiml,
  buildCallScript,
  DEFAULT_SAY_VOICE,
  declinedTwiml,
  escapeXml,
  noResponseTwiml,
  normalizePhone,
  outboundTwiml,
  repeatTwiml,
  sayVoice,
  verifyTwilioSignature,
  withinQuietHours
} from "../src/voice.js";

/* ------------------------------------------------------------- helpers --- */

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

/** Reproduces the exact Twilio signing algorithm this module claims to verify, so the tests are not just calling the implementation under test to check itself. */
async function twilioSignature(authToken, url, params) {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) data += key + params[key];
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(authToken), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  let binary = "";
  for (const byte of new Uint8Array(signatureBuffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function unescapeXml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractActionUrl(xml) {
  const match = xml.match(/action="([^"]+)"/);
  assert(match, `No action= attribute found in TwiML: ${xml}`);
  return unescapeXml(match[1]);
}

/** Hand-rolled balanced-tag check — there is no XML parser in Node core. */
function assertBalancedXml(xml, label) {
  const stack = [];
  const tagRegex = /<(\/?)([a-zA-Z][\w:-]*)(?:\s+[^<>]*)?(\/?)>/g;
  let match;
  while ((match = tagRegex.exec(xml))) {
    const [, closing, name, selfClosing] = match;
    if (selfClosing) continue;
    if (closing) {
      const last = stack.pop();
      assert(last === name, `${label}: mismatched closing tag </${name}> (expected </${last}>) in: ${xml}`);
    } else {
      stack.push(name);
    }
  }
  assert(stack.length === 0, `${label}: unclosed tag(s) [${stack.join(", ")}] in: ${xml}`);
  assert(xml.startsWith("<?xml"), `${label}: missing XML declaration`);
  assert(xml.includes("<Response>") && xml.includes("</Response>"), `${label}: missing <Response> envelope`);
}

/** Every literal & or < in the rendered text must have been escaped — a raw one means an unescaped interpolation slipped through. */
function assertNoRawSpecialCharacters(xml, label) {
  const strippedOfEntities = xml.replace(/&(amp|lt|gt|quot|apos);/g, "");
  assert(!strippedOfEntities.includes("&"), `${label}: found an unescaped & in: ${xml}`);
  // '<' only ever legitimately opens a real tag; a bare '<' before a non-tag character would mean unescaped text.
  assert(!/<(?![a-zA-Z/?])/.test(strippedOfEntities), `${label}: found an unescaped < in: ${xml}`);
}

/* --------------------------------------------------------- 1. signatures --- */

{
  const authToken = "test_auth_token_abc123";
  const url = "https://voice.timi.example/api/voice/outbound/target_1?attempt=attempt_1&tok=abc";
  const params = { CallSid: "CA123", From: "+15005550006", To: "+15105550194", Digits: "1" };
  const goodSignature = await twilioSignature(authToken, url, params);

  assert(await verifyTwilioSignature(authToken, url, params, goodSignature), "A correctly computed signature must be accepted");
  assert(!(await verifyTwilioSignature(authToken, url, params, `${goodSignature.slice(0, -1)}x`)), "A tampered signature must be rejected");
  assert(!(await verifyTwilioSignature("wrong_token", url, params, goodSignature)), "A signature computed with the wrong auth token must be rejected");
  assert(!(await verifyTwilioSignature(authToken, `${url}&extra=1`, params, goodSignature)), "A signature checked against a different URL must be rejected");
  assert(!(await verifyTwilioSignature(authToken, url, params, "")), "An empty signature must be rejected");
}

/* --------------------------------------------------------- 2. call script --- */

{
  const petName = "Biscuit";
  const script = buildCallScript({
    locationName: "Cedar Grove Veterinary Urgent Care",
    spokenConcern: "a dog with vomiting or diarrhea, starting today",
    travelMinutes: 14,
    urgency: "urgent"
  });
  const allText = Object.values(script).join(" ");
  assert(!allText.includes(petName), "The call script must never mention the pet's name");
  assert(/\bdog\b/.test(script.intro), "The intro must mention the species");
  assert(/press\s*1/i.test(script.prompt), "The prompt must include the press-1 instruction");
  assert(/press\s*2/i.test(script.prompt), "The prompt must include the press-2 instruction");
  assert(/press\s*9/i.test(script.prompt), "The prompt must include the press-9 repeat instruction");

  const emergencyScript = buildCallScript({ locationName: "Solano Pet Emergency", spokenConcern: "a cat with breathing trouble", travelMinutes: 9, urgency: "emergency" });
  assert(/emergency care/.test(emergencyScript.intro), "Emergency urgency should be reflected in the spoken intro");
}

/* ----------------------------------------------------------------- 3. TwiML --- */

{
  assert(escapeXml(`Tom & Jerry's <clinic> says "hi"`) === "Tom &amp; Jerry&apos;s &lt;clinic&gt; says &quot;hi&quot;", "escapeXml must escape all five XML special characters");

  const script = buildCallScript({
    locationName: "Ben & Jerry's Animal Hospital",
    spokenConcern: "a dog & cat with <symptoms>",
    travelMinutes: 12,
    urgency: "urgent"
  });
  const xml = outboundTwiml({
    script,
    gatherActionUrl: "https://voice.timi.example/api/voice/gather/target_1?attempt=a&tok=b",
    repeatActionUrl: "https://voice.timi.example/api/voice/gather/target_1?attempt=a&tok=b"
  });
  assertBalancedXml(xml, "outboundTwiml");
  assertNoRawSpecialCharacters(xml, "outboundTwiml");
  assert(xml.includes("Ben &amp; Jerry"), "Location name special characters must be escaped, not dropped");
  assert(xml.includes("<Gather"), "The outbound TwiML must contain a Gather verb");
  assert(xml.includes("<Redirect"), "The outbound TwiML must contain a no-input Redirect fallback");
}

/* ----------------------------------------------------------- 4. quiet hours --- */

{
  assert(withinQuietHours("2026-08-22T10:00:00.000Z", {}) === false, "An empty quiet-hours config must always be callable");
  assert(withinQuietHours("2026-08-22T10:00:00.000Z", { start: "22:00", end: "07:00", timezone: "UTC" }) === false, "10:00 UTC is outside a 22:00-07:00 window");
  assert(withinQuietHours("2026-08-22T23:30:00.000Z", { start: "22:00", end: "07:00", timezone: "UTC" }) === true, "23:30 UTC is inside a 22:00-07:00 (midnight-crossing) window");
  assert(withinQuietHours("2026-08-22T05:30:00.000Z", { start: "22:00", end: "07:00", timezone: "UTC" }) === true, "05:30 UTC is inside a 22:00-07:00 (midnight-crossing) window, on the other side of midnight");
  assert(withinQuietHours("2026-08-22T12:00:00.000Z", { start: "09:00", end: "17:00", timezone: "UTC" }) === true, "A same-day window (start < end) must also work");
  assert(withinQuietHours("2026-08-22T20:00:00.000Z", { start: "09:00", end: "17:00", timezone: "UTC" }) === false, "Outside a same-day window must return false");
}

/* ------------------------------------------------------------ 5. phones --- */

{
  assert(normalizePhone("(510) 555-0194") === "+15105550194", "A formatted 10-digit US number must normalize with a +1 default");
  assert(normalizePhone("+15105550194") === "+15105550194", "An already-E.164 number must pass through unchanged");
  assert(normalizePhone("5105550194") === "+15105550194", "A bare 10-digit number must default to US");
  assert(normalizePhone("1-510-555-0194") === "+15105550194", "An 11-digit number already starting with 1 must normalize correctly");
  assert(normalizePhone("not a phone number") === null, "Junk input must be rejected");
  assert(normalizePhone("12345") === null, "A too-short number must be rejected");
  assert(normalizePhone("") === null, "An empty string must be rejected");
  assert(normalizePhone(null) === null, "A non-string value must be rejected");
}

/* --------------------------------------------------- 6/7. cron drain + IVR --- */

const database = new DatabaseSync(":memory:");
await applyMigrations(database);

// Shaped like the real thing — 32 hex characters — because placeCall now
// checks that shape before it calls Twilio, and a fixture that could never be
// a real credential would exercise the rejection path rather than the drain.
const TWILIO_AUTH_TOKEN = "0123456789abcdef0123456789abcdef";
const env = {
  ASSETS: { fetch: async () => new Response("asset") },
  DB: new D1Mock(database),
  SIGN_IN_REQUIRED: "false",
  DEMO_MODE: "false",
  SURFACE: "voice",
  MAPBOX_STYLE_URL: "mapbox://styles/example/example",
  TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000001",
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER: "+15005550006",
  VOICE_MAX_ATTEMPTS: "2",
  VOICE_PUBLIC_URL: "https://voice.timi.example"
};

function insertSearchAndTarget({ searchId, targetId, tenantId, locationId, phone, urgency = "urgent", maxOffers = 5 }) {
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 10 * 60_000).toISOString();
  database.prepare(`
    INSERT INTO care_searches (
      id, public_code, customer_user_id, pet_name, species, breed, age_years, weight_lbs,
      owner_name, owner_phone, owner_email, concern_category, concern_summary, urgency,
      red_flags_json, customer_latitude, customer_longitude, radius_miles, status,
      max_offers, target_limit, legal_version, legal_accepted_at, requested_at,
      collection_expires_at, search_expires_at
    ) VALUES (?, ?, NULL, 'Milo', 'dog', NULL, NULL, NULL, 'Avery Cole', '(510) 555-0100', NULL,
      'illness_or_injury', 'Vomiting today, started this morning.', ?, '[]', 37.67, -122.08, 50,
      'collecting', ?, 5, ?, ?, ?, ?, ?)
  `).run(searchId, `PUB_${searchId}`, urgency, maxOffers, LEGAL_VERSION, now, now, future, future);

  database.prepare(`
    INSERT INTO care_search_targets (id, search_id, location_id, tenant_id, rank, travel_minutes, status, contacted_at)
    VALUES (?, ?, ?, ?, 1, 14, 'awaiting_response', ?)
  `).run(targetId, searchId, locationId, tenantId, now);

  database.prepare(`
    INSERT INTO notification_outbox (id, tenant_id, channel, recipient, template_key, payload_json, available_at)
    VALUES (?, ?, 'voice', ?, 'care_search_call', ?, ?)
  `).run(
    `notification_${targetId}`, tenantId, phone,
    JSON.stringify({
      searchId, targetId, locationId,
      locationName: "Hearth & Paw Urgent Care",
      petName: "Milo", species: "dog", urgency,
      spokenConcern: "a dog with vomiting or diarrhea, starting today",
      travelMinutes: 14, expiresAt: future
    }),
    now
  );
}

insertSearchAndTarget({ searchId: "search_accept", targetId: "target_accept", tenantId: "tenant_hearth", locationId: "loc_hearth", phone: "(510) 555-0194" });
insertSearchAndTarget({ searchId: "search_decline", targetId: "target_decline", tenantId: "tenant_hearth", locationId: "loc_hearth", phone: "(510) 555-0194" });
insertSearchAndTarget({ searchId: "search_disabled", targetId: "target_disabled", tenantId: "tenant_bayview", locationId: "loc_bayview", phone: "(510) 555-0138" });
database.prepare("UPDATE tenants SET voice_calls_enabled = 0 WHERE id = 'tenant_bayview'").run();

const capturedCalls = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const href = typeof url === "string" ? url : url.url;
  if (href.includes("api.twilio.com")) {
    const body = Object.fromEntries(new URLSearchParams(init.body));
    capturedCalls.push({ url: href, body });
    return new Response(JSON.stringify({ sid: `CA_${capturedCalls.length}`, status: "queued" }), {
      status: 201,
      headers: { "content-type": "application/json" }
    });
  }
  return originalFetch(url, init);
};

let scheduledWork;
await worker.scheduled(null, env, { waitUntil: (promise) => { scheduledWork = promise; } });
await scheduledWork;

assert(capturedCalls.length === 2, `Only the two enabled targets should have been called, got ${capturedCalls.length}`);

const disabledOutbox = database.prepare("SELECT status, last_error FROM notification_outbox WHERE id = 'notification_target_disabled'").get();
assert(disabledOutbox.status === "cancelled", "A tenant with voice calling disabled must have its outbox row cancelled");
assert(/disabled/i.test(disabledOutbox.last_error || ""), "The cancellation reason must be recorded in last_error");

const acceptOutbox = database.prepare("SELECT status FROM notification_outbox WHERE id = 'notification_target_accept'").get();
const declineOutbox = database.prepare("SELECT status FROM notification_outbox WHERE id = 'notification_target_decline'").get();
assert(acceptOutbox.status === "sent" && declineOutbox.status === "sent", "Successfully placed calls must mark their outbox row sent");

/* ------------------------------------------ 6b. three-way calling policy --- */
// console_active with no console in sight: the call must be cancelled, and
// the reason must say why so a clinic asking "why didn't you call us" gets an
// answer instead of a shrug.
database.prepare("UPDATE tenants SET voice_call_policy = 'console_active', console_last_seen_at = NULL WHERE id = 'tenant_juniper'").run();
// never must win even when the legacy boolean says yes — a clinic that chose
// the policy on a new console must not be rung because an old column agrees
// with an old default.
database.prepare("UPDATE tenants SET voice_call_policy = 'never', voice_calls_enabled = 1 WHERE id = 'tenant_bayview'").run();
database.prepare("UPDATE locations SET voice_calls_enabled = 1 WHERE id = 'loc_bayview'").run();
insertSearchAndTarget({ searchId: "search_stale", targetId: "target_stale", tenantId: "tenant_juniper", locationId: "loc_juniper", phone: "(510) 555-0161" });
insertSearchAndTarget({ searchId: "search_never", targetId: "target_never", tenantId: "tenant_bayview", locationId: "loc_bayview", phone: "(510) 555-0138" });

await worker.scheduled(null, env, { waitUntil: (promise) => { scheduledWork = promise; } });
await scheduledWork;

assert(capturedCalls.length === 2, `console_active with no console and a never policy must both place no call, got ${capturedCalls.length}`);
const staleOutbox = database.prepare("SELECT status, last_error FROM notification_outbox WHERE id = 'notification_target_stale'").get();
assert(staleOutbox.status === "cancelled", "console_active with no active console must cancel the outbox row");
assert(/console/i.test(staleOutbox.last_error || ""), "The console_active cancellation must name the console in its reason");
const neverOutbox = database.prepare("SELECT status, last_error FROM notification_outbox WHERE id = 'notification_target_never'").get();
assert(neverOutbox.status === "cancelled", "A never policy must cancel the call even when the legacy boolean is on");

// The same clinic with a console open (a dashboard poll 5 seconds ago) must
// be called: presence is recency, nothing else.
database.prepare("UPDATE tenants SET console_last_seen_at = ? WHERE id = 'tenant_juniper'").run(new Date(Date.now() - 5_000).toISOString());
insertSearchAndTarget({ searchId: "search_fresh", targetId: "target_fresh", tenantId: "tenant_juniper", locationId: "loc_juniper", phone: "(510) 555-0161" });
await worker.scheduled(null, env, { waitUntil: (promise) => { scheduledWork = promise; } });
await scheduledWork;
assert(capturedCalls.length === 3, `console_active with a console polled 5s ago must place the call, got ${capturedCalls.length}`);
assert(database.prepare("SELECT status FROM notification_outbox WHERE id = 'notification_target_fresh'").get().status === "sent", "The console_active call that was placed must mark its outbox row sent");

function callFor(targetId) {
  const call = capturedCalls.find((entry) => entry.body.Url.includes(`/api/voice/outbound/${targetId}?`));
  assert(call, `No captured Twilio call found for ${targetId}`);
  return call;
}

async function postForm(url, fields) {
  const params = Object.fromEntries(new URLSearchParams(fields));
  const signature = await twilioSignature(TWILIO_AUTH_TOKEN, url, params);
  const response = await worker.fetch(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
    body: new URLSearchParams(fields).toString()
  }), env);
  return { response, text: await response.text() };
}

// --- press 1: accept ---
const acceptCall = callFor("target_accept");
const acceptOutboundUrl = acceptCall.body.Url;
const outboundResult = await postForm(acceptOutboundUrl, { CallSid: "CA_accept", From: "+15005550006", To: "+15105550194" });
assertBalancedXml(outboundResult.text, "outbound response");
assert(outboundResult.text.includes("<Gather"), "The outbound webhook must respond with a Gather prompt");
const acceptGatherUrl = extractActionUrl(outboundResult.text);

/**
 * Dual delivery. The phone call is an addition to the console, never a
 * replacement for it: the call has been placed and answered (the outbound
 * webhook above marked the attempt in_progress), and the same request must
 * still be sitting on the clinic dashboard as pending — whoever is at the
 * desk may reach the screen before anybody reaches the phone. A drain that
 * flipped the target's status to "being called" would hide it here, which is
 * exactly the regression this guards.
 */
const { applyCareSearchDecision, clinicDashboard } = await import("../src/index.js");
{
  const dashboard = await (await clinicDashboard(env, "tenant_hearth")).json();
  const midCall = dashboard.requests.find((item) => item.id === "target_accept");
  assert(midCall, "A target Tími is phoning must still be listed on the clinic dashboard");
  assert(midCall.status === "pending", `A target mid-call must read pending on the dashboard, not ${midCall.status}`);
  assert(dashboard.metrics.pending >= 1, "A mid-call target must count toward the dashboard's pending metric");
}

const firstPressOne = await postForm(acceptGatherUrl, { CallSid: "CA_accept", Digits: "1" });
assertBalancedXml(firstPressOne.text, "gather response (accept)");
assert(/thank you/i.test(firstPressOne.text), "Pressing 1 must play the accepted confirmation");
assert(database.prepare("SELECT COUNT(*) AS c FROM care_offers WHERE target_id = 'target_accept'").get().c === 1, "Pressing 1 must create exactly one care_offers row");
assert(database.prepare("SELECT status FROM care_search_targets WHERE id = 'target_accept'").get().status === "offered", "Pressing 1 must flip the target to offered");

// The other half of dual delivery: the decision made on the phone must show
// up in the console, so a staffer looking at the screen sees that a colleague
// already answered rather than answering again.
{
  const dashboard = await (await clinicDashboard(env, "tenant_hearth")).json();
  const decided = dashboard.requests.find((item) => item.id === "target_accept");
  assert(decided?.status === "offered", `A phone acceptance must show as offered on the dashboard, not ${decided?.status}`);
}

const secondPressOne = await postForm(acceptGatherUrl, { CallSid: "CA_accept", Digits: "1" });
assertBalancedXml(secondPressOne.text, "gather response (accept, repeated)");
assert(database.prepare("SELECT COUNT(*) AS c FROM care_offers WHERE target_id = 'target_accept'").get().c === 1, "Pressing 1 a second time must not create a second care_offers row");

/**
 * The phone and the console are one code path, not two that resemble each
 * other. Drive the same decision through `applyCareSearchDecision` for a
 * second clinic and require the two offers to agree field for field — this is
 * the assertion that would have caught the duplicate implementation this
 * Worker originally carried.
 */
insertSearchAndTarget({
  searchId: "search_console",
  targetId: "target_console",
  tenantId: "tenant_hearth",
  locationId: "loc_hearth",
  phone: "(510) 555-0194"
});
const consoleResult = await applyCareSearchDecision(env, {
  targetId: "target_console",
  tenantId: "tenant_hearth",
  decision: "offer"
});
assert(consoleResult.ok, `The console path must accept: ${consoleResult.code || ""}`);

const comparable = (targetId) => {
  const row = database.prepare("SELECT * FROM care_offers WHERE target_id = ?").get(targetId);
  assert(row, `No offer row for ${targetId}`);
  // Everything except the identifiers and timestamps, which are expected to differ.
  const { id, search_id, target_id, offered_at, expires_at, available_at, arrival_by, created_at, updated_at, ...rest } = row;
  return rest;
};
const byPhone = comparable("target_accept");
const byConsole = comparable("target_console");
assert(
  JSON.stringify(byPhone) === JSON.stringify(byConsole),
  `An offer accepted by phone must be identical to one accepted in the console.\n  phone:   ${JSON.stringify(byPhone)}\n  console: ${JSON.stringify(byConsole)}`
);
assert(
  database.prepare("SELECT status FROM care_search_targets WHERE id = 'target_console'").get().status === "offered",
  "The console path must flip its target to offered too"
);

// --- press 2: decline ---
const declineCall = callFor("target_decline");
const declineOutboundResult = await postForm(declineCall.body.Url, { CallSid: "CA_decline", From: "+15005550006", To: "+15105550194" });
const declineGatherUrl = extractActionUrl(declineOutboundResult.text);
const pressTwo = await postForm(declineGatherUrl, { CallSid: "CA_decline", Digits: "2" });
assertBalancedXml(pressTwo.text, "gather response (decline)");
assert(/understood/i.test(pressTwo.text), "Pressing 2 must play the declined acknowledgement");
assert(database.prepare("SELECT status FROM care_search_targets WHERE id = 'target_decline'").get().status === "declined", "Pressing 2 must mark the target declined");
assert(database.prepare("SELECT COUNT(*) AS c FROM care_offers WHERE target_id = 'target_decline'").get().c === 0, "Declining must never create a care_offers row");
// Dual delivery for the "no" as well: a decline over the phone must read as
// decided on the console, or the desk answers a question already answered.
{
  const dashboard = await (await clinicDashboard(env, "tenant_hearth")).json();
  const declined = dashboard.requests.find((item) => item.id === "target_decline");
  assert(declined?.status === "declined", `A phone decline must show as declined on the dashboard, not ${declined?.status}`);
}

// --- signature/token rejection on a real route ---
const forged = await worker.fetch(new Request(acceptGatherUrl, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "not-a-real-signature" },
  body: "Digits=1"
}), env);
assert(forged.status === 403, "A request without a valid Twilio signature must be rejected with 403");

/* ------------------------------------------------------------- inbound --- */
//
// A clinic that missed the call rings the number back. The number's caller ID is
// Tími's, so this happens; left unhandled they reach Twilio's demo message.

insertSearchAndTarget({
  searchId: "search_callback",
  targetId: "target_callback",
  tenantId: "tenant_hearth",
  locationId: "loc_hearth",
  phone: "(510) 555-0194"
});

const inboundUrl = "https://voice.timinow.pet/api/voice/inbound";
const knownCaller = await postForm(inboundUrl, {
  CallSid: "CA_inbound",
  From: "(510) 555-0194",
  To: "+15105550100"
});
assertBalancedXml(knownCaller.text, "inbound response");
assert(/Hearth/.test(knownCaller.text), "A recognised clinic must be greeted by name");
assert(knownCaller.text.includes("<Gather"), "A clinic with an open request must be offered the keypad choice");
assert(/press 2|Press 2/.test(knownCaller.text), "The callback must offer the same accept/decline choice");
assert(!/Milo/.test(knownCaller.text), "The inbound call must not speak the pet's name either");

// The gather URL is signed, so a caller cannot accept on another clinic's behalf.
const inboundGatherUrl = knownCaller.text.match(/action="([^"]+)"/)[1].replace(/&amp;/g, "&");
const pressOneInbound = await postForm(inboundGatherUrl, { CallSid: "CA_inbound", Digits: "1" });
assert(/thank you/i.test(pressOneInbound.text), "Accepting on a callback must confirm");
assert(
  database.prepare("SELECT COUNT(*) AS c FROM care_offers WHERE target_id = 'target_callback'").get().c === 1,
  "Accepting on a callback must create exactly one offer, like every other path"
);
assert(
  database.prepare("SELECT status FROM care_search_targets WHERE id = 'target_callback'").get().status === "offered",
  "Accepting on a callback must flip the target to offered"
);

// A forged token must not let a caller answer for a clinic that is not theirs.
const tamperedGather = inboundGatherUrl.replace(/tok=[^&]+/, "tok=forged");
const tamperedResult = await postForm(tamperedGather, { CallSid: "CA_inbound", Digits: "1" });
assert(tamperedResult.response.status === 403, "A forged callback token must be rejected");

// An unknown caller gets a neutral greeting, never another clinic's patient.
const strangerResult = await postForm(inboundUrl, {
  CallSid: "CA_stranger",
  From: "+12125550000",
  To: "+15105550100"
});
assertBalancedXml(strangerResult.text, "unknown-caller response");
assert(!strangerResult.text.includes("<Gather"), "An unrecognised caller must not be offered a decision");
assert(!/vomiting/.test(strangerResult.text), "An unrecognised caller must never hear a patient's details");
assert(/timinow/i.test(strangerResult.text), "An unrecognised caller should still be pointed somewhere useful");

// The fallback must answer even when everything else is broken, and must not
// depend on a signature — Twilio calls it precisely when things have gone wrong.
const fallbackResponse = await worker.fetch(
  new Request("https://voice.timinow.pet/api/voice/inbound-fallback", { method: "POST" }),
  env
);
const fallbackText = await fallbackResponse.text();
assert(fallbackResponse.status === 200, "The fallback URL must always answer");
assertBalancedXml(fallbackText, "fallback response");
assert(!fallbackText.includes("<Gather"), "The fallback must not offer a decision it cannot record");

// The number-level status callback is a log sink, not a state transition.
const numberStatus = await postForm("https://voice.timinow.pet/api/voice/status", {
  CallSid: "CA_inbound",
  CallStatus: "completed",
  From: "+15105550194",
  To: "+15105550100",
  CallDuration: "23"
});
assert(numberStatus.response.status === 204, "The number-level status callback must acknowledge with 204");

globalThis.fetch = originalFetch;
database.close();

// The brand name, and the voice that says it.
{
  const script = buildCallScript({ locationName: "Hearth", spokenConcern: "a dog", travelMinutes: 9, urgency: "urgent" });
  const spoken = outboundTwiml({ script, gatherActionUrl: "https://x/g", repeatActionUrl: "https://x/r" });
  assert(spoken.includes('alphabet="ipa"'), "the brand name is spoken phonetically");
  assert(!/>[^<]*T\u00edmi/.test(spoken), "no bare Tími is left for an engine to read as Timmy");
  assert(spoken.includes(">Tee-mee<"), "the phoneme's own text is the respelling, so an engine that ignores the tag still says it right");

  // A voice reaches TwiML as an attribute; it must be the configured one and
  // it must be escaped.
  assert(outboundTwiml({ script, gatherActionUrl: "https://x/g", repeatActionUrl: "https://x/r", voice: "Google.en-US-Chirp3-HD-Aoede" })
    .includes('<Say voice="Google.en-US-Chirp3-HD-Aoede">'), "the requested voice is used");
  assert(sayVoice({ VOICE_SAY_VOICE: "Google.en-US-Studio-O" }) === "Google.en-US-Studio-O", "VOICE_SAY_VOICE is read");
  assert(sayVoice({}) === DEFAULT_SAY_VOICE, "a blank setting falls back to the default");
  assert(sayVoice({ VOICE_SAY_VOICE: "  " }) === DEFAULT_SAY_VOICE, "whitespace is not a voice");

  // Every spoken surface, not just the first one.
  for (const [label, xml] of [
    ["accepted", acceptedTwiml(script, { voice: "Polly.Danielle-Neural" })],
    ["declined", declinedTwiml(script, { voice: "Polly.Danielle-Neural" })],
    ["no response", noResponseTwiml(script, { voice: "Polly.Danielle-Neural" })],
    ["already filled", alreadyFilledTwiml({ voice: "Polly.Danielle-Neural" })],
    ["repeat", repeatTwiml({ script, gatherActionUrl: "https://x/g", repeatActionUrl: "https://x/r", voice: "Polly.Danielle-Neural" })]
  ]) {
    assert(xml.includes('voice="Polly.Danielle-Neural"'), `${label} uses the configured voice`);
  }
}

console.log("Voice gateway tests passed: Twilio signature verification, call-script content, TwiML well-formedness and escaping, quiet-hours math, phone normalization, cron drain (tenant opt-out + successful placement), the three-way call policy (console_active skips with no console and calls with a fresh one, never wins over the legacy boolean), dual delivery (a target stays pending on the dashboard mid-call and its phone decision shows there), phone acceptance producing a byte-identical offer to the console path, and the inbound callback path.");
