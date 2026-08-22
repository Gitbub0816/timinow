/**
 * Shared, dependency-free primitives for the Tími voice gateway
 * (`apps/voice-gateway`). Everything here is a pure function or a thin HTTP
 * client — no Worker globals beyond `fetch` and `crypto`, so this module can
 * be exercised directly from `scripts/voice-test.mjs` with no network and no
 * D1 mock.
 *
 * Nothing in this file knows about `care_searches`, `care_offers`, or D1 rows
 * — that wiring lives in `apps/voice-gateway/src/index.js`, which reproduces
 * the accept/decline statements from `respondToCareSearch` (see that file's
 * comments for exactly where the two paths must be kept in sync).
 */

const XML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

/** Escapes text for safe interpolation into TwiML. Always call this on any caller-influenced string. */
export function escapeXml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => XML_ESCAPES[character]);
}

/**
 * The words spoken on the call. Deliberately takes no pet name and no
 * diagnosis — `spokenConcern` (built in `src/index.js`) already strips those
 * out before it reaches here. Kept under ~25 seconds of speech before the
 * `<Gather>` prompt, per the product spec.
 */
export function buildCallScript({ locationName, spokenConcern, travelMinutes, urgency }) {
  const careWord = urgency === "emergency" ? "emergency care" : "immediate care";
  const intro = `Hi, this is Tími calling for ${locationName}. A pet owner nearby is looking for ${careWord} for ${spokenConcern}, about ${travelMinutes} minutes away.`;
  const prompt = "Do you have time to see them? Press 1 to confirm you can take them, or press 2 to decline. Press 9 to hear this again.";
  const repeat = `Sure, here it is again. ${prompt}`;
  const accepted = "Thank you. We'll send the owner your way and the details are on your Tími console.";
  const declined = "Understood, thank you.";
  const goodbye = "We didn't receive a response. Goodbye.";
  return { intro, prompt, repeat, accepted, declined, goodbye };
}

/* --------------------------------------------------------------- TwiML --- */

/**
 * Twilio's neural Polly voices cost marginally more per character than the
 * standard ones and sound markedly less synthetic. This is the first thing a
 * veterinary practice hears from Tími, often over a speakerphone in a noisy
 * treatment area, so the better voice is worth it. Override with
 * VOICE_SAY_VOICE if you prefer another.
 */
export const DEFAULT_SAY_VOICE = "Polly.Joanna-Neural";

function sayXml(text, { voice = DEFAULT_SAY_VOICE } = {}) {
  return `<Say voice="${escapeXml(voice)}">${escapeXml(text)}</Say>`;
}

function gatherXml({ actionUrl, sayText, numDigits = 1, timeout = 8 }) {
  return `<Gather input="dtmf" numDigits="${numDigits}" timeout="${timeout}" action="${escapeXml(actionUrl)}" method="POST">${sayXml(sayText)}</Gather>`;
}

function redirectXml(url) {
  return `<Redirect method="POST">${escapeXml(url)}</Redirect>`;
}

function hangupXml() {
  return "<Hangup/>";
}

function responseXml(inner) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}

/** The very first thing the clinic hears: the intro, then the Gather prompt. Falls through to `repeatActionUrl` on no input. */
export function outboundTwiml({ script, gatherActionUrl, repeatActionUrl }) {
  return responseXml(
    sayXml(script.intro) +
    gatherXml({ actionUrl: gatherActionUrl, sayText: script.prompt }) +
    redirectXml(repeatActionUrl)
  );
}

/** Re-plays the prompt (pressed 9, or no input yet within the repeat budget). */
export function repeatTwiml({ script, gatherActionUrl, repeatActionUrl }) {
  return responseXml(
    gatherXml({ actionUrl: gatherActionUrl, sayText: script.repeat }) +
    redirectXml(repeatActionUrl)
  );
}

export function acceptedTwiml(script) {
  return responseXml(sayXml(script.accepted) + hangupXml());
}

export function declinedTwiml(script) {
  return responseXml(sayXml(script.declined) + hangupXml());
}

/** The search was already filled (max offers reached, expired, or selected) by the time the clinic answered. */
export function alreadyFilledTwiml() {
  return responseXml(sayXml("Thank you — that request has already been filled.") + hangupXml());
}

/** No digits after the repeat budget is exhausted. */
export function noResponseTwiml(script) {
  return responseXml(sayXml(script.goodbye) + hangupXml());
}

export function errorTwiml(message = "Sorry, something went wrong. Goodbye.") {
  return responseXml(sayXml(message) + hangupXml());
}

/* --------------------------------------------------------- signatures --- */

function bufferToBase64(buffer) {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison. Used for both Twilio signatures and the per-call attempt token. */
export function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = new TextEncoder().encode(a);
  const bufB = new TextEncoder().encode(b);
  if (bufA.length !== bufB.length) return false;
  let diff = 0;
  for (let i = 0; i < bufA.length; i += 1) diff |= bufA[i] ^ bufB[i];
  return diff === 0;
}

/**
 * Twilio's request-signing scheme: the full request URL, followed by every
 * POST parameter sorted by key with `key + value` appended, HMAC-SHA1'd with
 * the auth token, then base64-encoded. This IS the authentication for the
 * three webhook routes — Twilio cannot sign in with Clerk, so a call that
 * fails this check must be rejected with 403.
 */
export async function verifyTwilioSignature(authToken, url, params, signature) {
  if (!authToken || !signature || typeof url !== "string") return false;
  const sortedKeys = Object.keys(params || {}).sort();
  let data = url;
  for (const key of sortedKeys) data += key + params[key];
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  return timingSafeEqual(bufferToBase64(signatureBuffer), signature);
}

/**
 * Scopes a webhook URL to one call attempt so a leaked recording of the URL
 * (server logs, a proxy, a support ticket) cannot be replayed against a
 * different clinic's target. HMAC-SHA256 of the attempt id, truncated to 32
 * hex characters (128 bits) — plenty for an anti-replay token, short enough
 * to keep the callback URL tidy.
 */
export async function signAttemptToken(authToken, attemptId) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authToken),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(String(attemptId)));
  return bufferToHex(signatureBuffer).slice(0, 32);
}

export async function verifyAttemptToken(authToken, attemptId, token) {
  if (!token) return false;
  const expected = await signAttemptToken(authToken, attemptId);
  return timingSafeEqual(expected, token);
}

/* ------------------------------------------------------------- Twilio --- */

/**
 * Places an outbound call via the Twilio REST API. Throws a clear
 * configuration error rather than silently no-op'ing when a from-number
 * isn't available — callers (the cron drain) are expected to catch this and
 * record it as a failed attempt rather than let it bubble up and stop the
 * whole tick.
 */
export async function placeCall(env, { to, from, url, statusCallback }) {
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) throw new Error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be configured");
  const fromNumber = from || env.TWILIO_FROM_NUMBER;
  if (!fromNumber) throw new Error("TWILIO_FROM_NUMBER is not configured — cannot place outbound calls");

  const form = new URLSearchParams();
  form.set("To", to);
  form.set("From", fromNumber);
  form.set("Url", url);
  if (statusCallback) {
    form.set("StatusCallback", statusCallback);
    form.set("StatusCallbackEvent", "initiated ringing answered completed");
    form.set("StatusCallbackMethod", "POST");
  }

  const credentials = btoa(`${accountSid}:${authToken}`);
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`, {
    method: "POST",
    headers: {
      authorization: `Basic ${credentials}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: form.toString()
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.message || `Twilio call request failed (${response.status})`);
  return { sid: body.sid, status: body.status, raw: body };
}

/* --------------------------------------------------------- quiet hours --- */

/**
 * `quietHours` shape: `{ start: "22:00", end: "07:00", timezone: "America/Los_Angeles" }`.
 * An empty object (or a missing start/end) means "always callable". Handles
 * windows that cross midnight (start > end) as well as ones that don't.
 */
export function withinQuietHours(nowIso, quietHours) {
  if (!quietHours || !quietHours.start || !quietHours.end) return false;
  const date = new Date(nowIso);
  if (Number.isNaN(date.getTime())) return false;

  const timezone = quietHours.timezone || "UTC";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit"
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0) % 24;
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  const nowMinutes = hour * 60 + minute;

  const [startHour, startMinute] = quietHours.start.split(":").map(Number);
  const [endHour, endMinute] = quietHours.end.split(":").map(Number);
  const startMinutes = startHour * 60 + startMinute;
  const endMinutes = endHour * 60 + endMinute;
  if (startMinutes === endMinutes) return false;

  return startMinutes < endMinutes
    ? nowMinutes >= startMinutes && nowMinutes < endMinutes
    : nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

/* ------------------------------------------------------------- phones --- */

/** Normalizes to E.164, defaulting to a US country code for a bare 10-digit number. Returns null for anything unusable. */
export function normalizePhone(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/\D/g, "");
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }

  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/* ------------------------------------------------------------- inbound --- */

/**
 * A clinic ringing the number back.
 *
 * Tími only ever dials out, but the number it dials from lands on the clinic's
 * caller ID, and a clinic that missed the call will try it. Left unconfigured
 * they reach Twilio's stock demo message, which is a poor thing for a
 * veterinary practice to hear from a company asking them to take a patient.
 *
 * When the caller's number matches a clinic with a request still open, this
 * offers the same keypad choice the outbound call did — the missed call becomes
 * a second chance to take the patient rather than a dead end.
 */
export function inboundTwiml({ locationName, spokenConcern, travelMinutes, gatherActionUrl }) {
  const greeting = locationName
    ? `Hi, this is Tími. Thanks for calling back, ${locationName}.`
    : "Hi, this is Tími, the veterinary intake network.";

  if (!spokenConcern || !gatherActionUrl) {
    const nothingOpen = `${greeting} There are no open requests for your clinic right now. ` +
      "You can see everything Tími has sent you at providers dot timinow dot pet. Goodbye.";
    return `<?xml version="1.0" encoding="UTF-8"?><Response>${sayXml(nothingOpen)}<Hangup/></Response>`;
  }

  const minutes = Number.isFinite(travelMinutes) ? ` about ${travelMinutes} minutes away` : "";
  const body = `${greeting} There is still an open request: a pet owner is looking for immediate care for ` +
    `${spokenConcern}${minutes}. Do you have time to see them? ` +
    "Press 1 to confirm you can take them, or press 2 to decline.";

  return '<?xml version="1.0" encoding="UTF-8"?><Response>' +
    `<Gather input="dtmf" numDigits="1" timeout="8" action="${escapeXml(gatherActionUrl)}" method="POST">` +
    `${sayXml(body)}</Gather>` +
    sayXml("We didn't receive a response. You can respond at providers dot timinow dot pet. Goodbye.") +
    "<Hangup/></Response>";
}

/**
 * The fallback Twilio calls when the primary request URL errors or times out.
 *
 * Deliberately static: no database, no lookups, nothing that can fail twice. A
 * fallback that depends on the thing that just broke is not a fallback.
 */
export function inboundFallbackTwiml() {
  const message = "Hi, this is Tími, the veterinary intake network. " +
    "We can't take calls on this line right now. " +
    "If Tími called you about a patient, you can respond at providers dot timinow dot pet. Goodbye.";
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${sayXml(message)}<Hangup/></Response>`;
}
