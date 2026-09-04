import {
  VoiceGuide,
  clearRoute,
  configureMap,
  drawRoute,
  fetchRoute,
  formatDistance,
  formatDuration,
  mapAvailable,
  phraseInstruction,
  renderClinicMap,
  announcement,
  toneFor
} from "./map.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/* ---------------------------------------------------------------------- */
/* First-party analytics beacon.                                           */
/*                                                                         */
/* Cookieless by design: events carry an event name, a path, and optional  */
/* coarse metadata — never an identifier, cookie, or storage-derived id.   */
/* Fire-and-forget: a failed beacon must never affect the page.            */
/* ---------------------------------------------------------------------- */
const track = (() => {
  const queue = [];
  let flushTimer = null;
  function deliver(events) {
    if (!events.length) return;
    const body = JSON.stringify({ events });
    try {
      if (navigator.sendBeacon && navigator.sendBeacon("/api/analytics", new Blob([body], { type: "application/json" }))) return;
    } catch { /* fall through to fetch */ }
    try {
      fetch("/api/analytics", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true, credentials: "omit" }).catch(() => {});
    } catch { /* analytics must never break the page */ }
  }
  function flush() {
    window.clearTimeout(flushTimer);
    flushTimer = null;
    while (queue.length) deliver(queue.splice(0, 25));
  }
  try {
    addEventListener("pagehide", flush);
    addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
  } catch { /* ignore */ }
  return (name, meta) => {
    try {
      if (!/^[a-z0-9_.:-]{1,40}$/i.test(String(name))) return;
      const event = { name: String(name), path: `#${state?.route || "home"}` };
      if (meta && typeof meta === "object") event.meta = meta;
      queue.push(event);
      if (!flushTimer) flushTimer = window.setTimeout(flush, 400);
    } catch { /* analytics must never break the page */ }
  };
})();

/* Boot splash: shown by static HTML immediately, hidden once the app has
   booted — but never before ~1.2s, so it reads as a moment, not a flash. */
const BOOT_STARTED_AT = Date.now();
function hideBootSplash() {
  const splash = $("[data-boot-splash]");
  if (!splash || splash.dataset.hiding) return;
  splash.dataset.hiding = "true";
  const linger = Math.max(0, 1200 - (Date.now() - BOOT_STARTED_AT));
  window.setTimeout(() => {
    splash.classList.add("is-hidden");
    window.setTimeout(() => splash.remove(), 480);
  }, linger);
}
window.setTimeout(hideBootSplash, 10000);

const APP_ROUTES = new Set(["find", "results", "tracker", "pets", "clinic", "sign-in", "legal"]);
const PROTECTED_ROUTES = new Set(["find", "results", "tracker", "pets", "clinic"]);
const DEFAULT_POSITION = { latitude: 37.6688, longitude: -122.0808, label: "Hayward, California", detail: "Using demonstration coordinates" };
const STORAGE_KEYS = {
  draft: "timi_intake_draft_v1",
  intake: "timi_current_intake_v1",
  search: "timi_current_search_v1",
  clinicAvailability: "timi_demo_clinic_availability_v1",
  clinicDecisions: "timi_demo_clinic_decisions_v1",
  navigation: "timi_navigation_preferences_v1",
  matchAliases: "timi_match_aliases_v1",
  postVisitContribution: "timi_post_visit_contribution_v1"
};

/* ---------------------------------------------------------------------- */
/* Temporary match aliases.                                                */
/*                                                                         */
/* A clinic a customer has not yet chosen is shown under a temporary       */
/* TímiNOW match name, never its business name — see the alias library     */
/* specification. The server owns assignment; every offer may carry        */
/* `offer.matchAlias`. This local library is the presentation fallback for */
/* a deployment whose search service has not started sending one yet, and  */
/* it follows the same rules: a mapping is created once per search         */
/* session from a cryptographically random shuffle, is stable for the life */
/* of that session (refresh, back-navigation, payment entry), is unique    */
/* within a result set, is never seeded from a clinic id, and never        */
/* survives into a new search. Aliases are presentation only: selection,    */
/* payment, and routing all use the offer and location ids.                */
/* ---------------------------------------------------------------------- */
const ALIAS_LIBRARY = [
  "Alder", "Aspen", "Banyan", "Birch", "Bramble", "Canopy", "Cedar", "Cypress", "Dogwood", "Elmwood",
  "Fernwood", "Grove", "Hawthorn", "Hemlock", "Hickory", "Juniper", "Linden", "Magnolia", "Maple", "Oakwood",
  "Pinecrest", "Redwood", "Sequoia", "Sycamore", "Willow", "Amaranth", "Aster", "Azalea", "Bluebell", "Camellia",
  "Clover", "Dahlia", "Dandelion", "Flora", "Gardenia", "Heather", "Hibiscus", "Hollyhock", "Hyacinth", "Iris",
  "Jasmine", "Lavender", "Lilac", "Lotus", "Marigold", "Orchid", "Peony", "Primrose", "Verbena", "Wisteria",
  "Basil", "Briar", "Bulrush", "Chamomile", "Chicory", "Coriander", "Fennel", "Fern", "Flax", "Ginger",
  "Ivy", "Laurel", "Lemongrass", "Meadowgrass", "Mintleaf", "Moss", "Nettle", "Oregano", "Parsley", "Reed",
  "Rosemary", "Sagebrush", "Sorrel", "Thyme", "Yarrow", "Afterglow", "Aurora", "Beacon", "Bluehour", "Borealis",
  "Celestial", "Cirrus", "Comet", "Daybreak", "Daylight", "Eclipse", "Equinox", "Halo", "Horizon", "Lumen",
  "Meridian", "Moonbeam", "Nova", "Radiance", "Skylark", "Solstice", "Starlight", "Sunbeam", "Sundial", "Twilight",
  "Brook", "Cascade", "Cove", "Current", "Delta", "Dewdrop", "Estuary", "Fjord", "Harbor", "Headwater",
  "Lagoon", "Lakeshore", "Marina", "Mist", "Oasis", "Pebble", "Rainfall", "Ripple", "Riverbend", "Seabreeze",
  "Shoal", "Springtide", "Stream", "Tidepool", "Waterfall", "Arroyo", "Bluff", "Canyon", "Canyonland", "Cliffside",
  "Crest", "Dune", "Fieldstone", "Foothill", "Glen", "Granite", "Highland", "Hillcrest", "Meadow", "Mesa",
  "Moorland", "Overlook", "Prairie", "Ridgeline", "Sandstone", "Sierra", "Summit", "Timberline", "Vale", "Wildland",
  "Autumn", "Breeze", "Cloudburst", "Cloudlet", "Coolwind", "Drizzle", "Evergreen", "Fairweather", "Frost", "Goldleaf",
  "Hailstone", "Midsummer", "Monsoon", "Northwind", "Raincloud", "Raindrop", "Snowdrop", "Snowfall", "Spring", "Starfall",
  "Sunshower", "Tempest", "Tradewind", "Westwind", "Wintergreen", "Amber", "Amethyst", "Basalt", "Copper", "Coral",
  "Crystal", "Ember", "Flint", "Garnet", "Goldstone", "Ironwood", "Jade", "Jasper", "Limestone", "Marble",
  "Moonstone", "Obsidian", "Onyx", "Opal", "Pearl", "Quartz", "Riverstone", "Slate", "Topaz", "Travertine",
  "Accord", "Amity", "Brightway", "Candor", "Compass", "Everwell", "Flourish", "Harmony", "Haven", "Hearth",
  "Kindred", "Lantern", "Lucent", "Mosaic", "Northstar", "Openway", "Promise", "Quietude", "Reverie", "Serenade",
  "Stillwater", "Tranquil", "Unity", "Vantage", "Wayfinder", "Cadence", "Chime", "Drift", "Echo", "Feather",
  "Firefly", "Glide", "Hummingbird", "Lilt", "Melody", "Murmur", "Nightingale", "Overture", "Passage", "Rhapsody",
  "Rhythm", "Skylight", "Sparrow", "Tapestry", "Tempo", "Wander", "Whimsy", "Wingspan", "Zephyr", "Zenith"
];

const state = {
  route: "home",
  config: null,
  clerk: null,
  session: null,
  auth: null,
  intakeStep: 1,
  intakeDraft: readStorage(STORAGE_KEYS.draft, {
    position: DEFAULT_POSITION,
    petName: "Otis",
    species: "dog",
    breed: "Golden retriever",
    weightLbs: 72,
    urgency: "same_day",
    symptoms: [],
    startedWhen: "",
    concernSummary: "",
    redFlags: [],
    ownerName: "Maya Morgan",
    ownerPhone: "(510) 555-0147",
    ownerEmail: "maya@example.com"
  }),
  locations: [],
  selectedLocation: null,
  currentIntake: readStorage(STORAGE_KEYS.intake, null),
  currentSearch: readStorage(STORAGE_KEYS.search, null),
  /** searchId → { locationId: aliasName }. Presentation only; see ALIAS_LIBRARY. */
  matchAliases: readStorage(STORAGE_KEYS.matchAliases, {}),
  /** The offer sitting on the pre-confirmation screen, with its checkout choices. */
  pendingMatch: null,
  /** The in-flight hardship application, if the customer opened one. */
  assistance: null,
  /** The standalone contribution being paid from the public portal. */
  contribution: null,
  /** Amount choices on the two non-checkout contribution surfaces. */
  portalContribution: { choice: null, cents: 0 },
  postVisitContribution: { choice: null, cents: 0 },
  trackerTimer: null,
  clinicTimer: null,
  deferredInstall: null,
  stripe: null,
  stripeElements: null,
  clinicData: null,
  knownClinicRequests: new Set(),
  clinicInitialized: false,
  resultsMap: null,
  trackerMap: null,
  activeRoute: null,
  navigationActive: false,
  navigationWatchId: null,
  voiceGuide: null,
  navigationPreferences: readStorage(STORAGE_KEYS.navigation, {
    voiceEnabled: true,
    voiceURI: null,
    rate: 1,
    units: "imperial",
    avoidTolls: false,
    avoidHighways: false,
    avoidFerries: false
  })
};

function readStorage(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage can be unavailable in privacy modes. */ }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatMoney(cents) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format((cents || 0) / 100);
}

/**
 * Cents, always. Rounding $49.95 to "$50" is tolerable in a summary tile and
 * indefensible in an itemized order the customer is about to authorize.
 */
function formatMoneyExact(cents) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format((cents || 0) / 100);
}

/* ---------------------------------------------------------------------- */
/* Prices.                                                                 */
/*                                                                         */
/* Every amount this client shows comes from /api/config's versioned       */
/* pricing policy. Nothing here hard-codes a dollar figure into copy: a    */
/* price change is a database row, and a screen quoting yesterday's number */
/* is a screen that lies to somebody about to pay.                         */
/* ---------------------------------------------------------------------- */
const FEE_FALLBACK = { ownerFeeCents: 1500, clinicFeeCents: 2500, timiMatchCents: 1000, sponsorshipFundCents: 3000, minBookingContributionCents: 100, minStandaloneContributionCents: 1000, maxBookingContributionCents: 500000, maxStandaloneContributionCents: 2500000, currency: "usd" };

function fees() {
  return { ...FEE_FALLBACK, ...(state.config?.fees || {}) };
}

/** What the pet owner pays Tími for this connection. */
function ownerFeeCents() {
  return fees().ownerFeeCents;
}

/** The customer-paid Tími fee, disclosed wherever amounts show. */
function serviceFeeSentence() {
  return `Tími’s ${formatMoney(ownerFeeCents())} booking fee is charged separately from any clinic deposit and is itemized before you pay.`;
}

/** Is the Google-sourced rating module switched on for this deployment? */
function googleRatingsEnabled() {
  const config = state.config || {};
  if (config.googleRatingsEnabled !== undefined) return config.googleRatingsEnabled !== false;
  return config.features?.googleRatings !== false;
}

/**
 * The Google Maps rating for an offer, or null when there is none to show.
 * Never falls back to a stale or Tími-derived number: the module simply
 * disappears, which is what acceptance test 18 requires it to survive.
 */
function googleRatingFor(offer) {
  if (!googleRatingsEnabled()) return null;
  const source = matchCard(offer)?.google || offer?.google || offer?.googleRating || null;
  const rating = Number(source?.rating);
  const count = Number(source?.userRatingCount ?? source?.ratingCount);
  if (!Number.isFinite(rating) || !Number.isFinite(count) || count <= 0) return null;
  return { rating: rating.toFixed(1), count, attribution: source.attribution?.text || "Google Maps" };
}

/** The server's masked match-card payload for an offer, when it sends one. */
function matchCard(offer) {
  return offer?.matchCard || (offer?.alias && offer?.timinow ? offer : null);
}

/* --------------------------------------------------------------------- */
/* Temporary match alias assignment (fallback — see ALIAS_LIBRARY).       */
/* --------------------------------------------------------------------- */

function shuffledAliases(count) {
  const pool = [...ALIAS_LIBRARY];
  const random = new Uint32Array(pool.length);
  try { crypto.getRandomValues(random); }
  catch { for (let index = 0; index < random.length; index += 1) random[index] = Math.floor(Math.random() * 2 ** 32); }
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swap = random[index] % (index + 1);
    [pool[index], pool[swap]] = [pool[swap], pool[index]];
  }
  return pool.slice(0, count);
}

/**
 * The alias for one offer within one search session.
 *
 * Assigned the first time a candidate appears and then never reassigned, so
 * a withdrawn candidate cannot rename the others and a late arrival takes an
 * unused name rather than shuffling the board mid-decision.
 */
function aliasForOffer(searchId, offer) {
  const card = matchCard(offer);
  const supplied = card?.alias?.displayName || offer?.matchAlias?.displayName || offer?.matchAlias || offer?.alias?.displayName || offer?.alias;
  if (typeof supplied === "string" && supplied.trim()) return supplied.trim();
  if (!searchId) return "Match";
  const key = offer?.locationId || offer?.location?.id || offer?.id;
  const mapping = state.matchAliases[searchId] || {};
  if (mapping[key]) return mapping[key];
  const taken = new Set(Object.values(mapping));
  const next = shuffledAliases(ALIAS_LIBRARY.length).find((name) => !taken.has(name)) || `Match ${taken.size + 1}`;
  mapping[key] = next;
  // One search session's mappings are kept at a time. Nothing reloads an old
  // search, and retaining them is how a clinic drifts toward a stable alias
  // across sessions — exactly what the library forbids.
  state.matchAliases = { [searchId]: mapping };
  writeStorage(STORAGE_KEYS.matchAliases, state.matchAliases);
  return next;
}

/** The alias attached to the booking the customer actually confirmed. */
function aliasForIntake(intake) {
  if (!intake) return "";
  if (intake.matchAlias) return intake.matchAlias;
  const searchId = intake.sourceSearchId;
  const mapping = searchId ? state.matchAliases[searchId] : null;
  return mapping?.[intake.locationId] || "";
}

function timestampMs(value) {
  if (!value) return Number.NaN;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  return Date.parse(normalized);
}

function formatRelativeTime(iso) {
  if (!iso) return "Not recently confirmed";
  const seconds = Math.max(0, Math.round((Date.now() - timestampMs(iso)) / 1000));
  if (seconds < 60) return `${seconds || 1} sec ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hr ago`;
}

function formatClock(iso) {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(timestampMs(iso)));
}

function initials(name) {
  return String(name).split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function humanize(value) {
  return String(value || "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

const GENERIC_CONCERN = /^(?:(?:my|the)\s+(?:dog|cat|pet|animal)\s+)?(?:isn['’]?t|is not|doesn['’]?t seem|does not seem|hasn['’]?t been)?\s*(?:acting like (?:himself|herself|themself|themselves)|feeling (?:well|good)|doing (?:well|good)|right|normal|himself|herself|themselves|seems? off|sick|unwell|not okay|something(?: is|'s) wrong)[.! ]*$/i;
const OBSERVABLE_DETAIL = /\b(vomit|throw(?:ing)? up|diarrh|stool|feces|cough|wheez|breath|pant|limp|walk|stand|pain|cry|yel[p|l]|bleed|wound|swollen|lump|seiz|collaps|unconscious|urine|urinat|pee|drink|water|eat|food|appetite|eye|ear|skin|rash|itch|scratch|toxin|poison|chocol|medication|fever|temperature|discharge|shak|trembl|letharg|energy|sleep|hiding|aggress|abdomen|belly|leg|paw|mouth)\w*/i;
const QUANTIFIED_DETAIL = /\b(?:\d+|once|twice|three|four|several|every|hourly|constantly|repeatedly|since|for\s+\d+|minutes?|hours?|days?|today|yesterday|morning|tonight)\b/i;
const FUNCTIONAL_DETAIL = /\b(?:won['’]?t|will not|can['’]?t|cannot|unable|refus|less than|more than|stopped|difficulty|struggl|only)\b/i;

function assessConcern(summary, symptoms, startedWhen) {
  const text = String(summary || "").trim();
  const words = text.match(/[a-z0-9'’]+/gi) || [];
  const selected = Array.isArray(symptoms) ? symptoms : [];
  const concrete = OBSERVABLE_DETAIL.test(text);
  const quantified = QUANTIFIED_DETAIL.test(text);
  const functional = FUNCTIONAL_DETAIL.test(text);
  const weakCategoryOnly = selected.every((value) => ["energy_or_behavior", "other_observable"].includes(value));
  if (!selected.length) return { ok: false, message: "Select at least one thing you can observe." };
  if (!startedWhen) return { ok: false, message: "Choose when the change started." };
  if (text.length < 30 || words.length < 6) return { ok: false, message: "Add a little more detail: what changed and how often or how much." };
  if (GENERIC_CONCERN.test(text) || (!concrete && !quantified && !functional)) return { ok: false, message: "Describe something observable—for example eating, breathing, walking, vomiting, stool, urination, pain, or a visible injury." };
  if (weakCategoryOnly && !concrete) return { ok: false, message: "For behavior or energy changes, include the specific action that changed, such as hiding, refusing food, trouble standing, or unusual sleep." };
  const strength = 2 + Number(concrete) + Number(quantified) + Number(functional) + Number(words.length >= 12);
  return { ok: true, strength, message: strength >= 5 ? "Specific enough for a clinic to review" : "Good—one more concrete detail would help" };
}

function showToast(message) {
  const toast = $("[data-toast]");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("is-visible"), 3200);
}

function parseRoute() {
  const raw = location.hash.replace(/^#/, "") || "home";
  const [route] = raw.split("?");
  if (route === "how-it-works" || route === "emergency") return "home";
  if (route === "vets-apply") return "vets";
  return $("[data-screen='" + CSS.escape(route) + "']") ? route : "home";
}

function routeQuery() {
  const raw = location.hash.split("?")[1] || "";
  return new URLSearchParams(raw);
}

function setRoute(route) {
  if (location.hash === `#${route}`) renderRoute();
  else location.hash = route;
}

function clearTimers() {
  window.clearInterval(state.trackerTimer);
  window.clearInterval(state.clinicTimer);
  state.trackerTimer = null;
  state.clinicTimer = null;
}

async function renderRoute() {
  clearTimers();
  releaseMaps();
  $$('dialog[open]').forEach((dialog) => dialog.close());
  document.body.classList.remove("dialog-open");
  let route = parseRoute();
  // A Feature B SMS link ("#tracker?st=<signed token>") has to work for a
  // customer who never signed in on this device — the signed token is the
  // authorization, not a Clerk session. See notifyFirstOfferBySms in
  // src/index.js and the GET /api/searches/by-token route it points at.
  const hasSearchLinkToken = route === "tracker" && Boolean(routeQuery().get("st"));
  if (state.config?.signInRequired && PROTECTED_ROUTES.has(route) && !state.clerk?.user && !hasSearchLinkToken) {
    sessionStorage.setItem("timi_return_route", route);
    route = "sign-in";
  }
  if (state.config?.signInRequired && state.clerk?.user && !state.session) {
    try { state.session = (await api("/api/session")).session; } catch { state.session = null; }
  }
  state.route = route;
  if (renderRoute.lastTrackedRoute !== route) {
    renderRoute.lastTrackedRoute = route;
    track("page_view");
  }

  const render = () => {
    $$('[data-screen]').forEach((screen) => {
      const active = screen.dataset.screen === route;
      screen.classList.toggle("is-active", active);
      screen.setAttribute("aria-hidden", String(!active));
    });
    $("[data-public-header]").hidden = APP_ROUTES.has(route);
    document.body.classList.toggle("app-view", APP_ROUTES.has(route));
    window.scrollTo({ top: 0, behavior: "instant" });
  };
  if (document.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) document.startViewTransition(render);
  else render();

  document.title = ({
    home: "Tími NOW — find veterinary care right now",
    find: "Tell us what is happening · Tími NOW",
    results: "Available veterinary care · Tími NOW",
    tracker: "Live intake request · Tími NOW",
    pets: "Pet profile · Tími NOW",
    vets: "For veterinary teams · Tími NOW",
    "paw-it-forward": "Paw It Forward Fund · Tími NOW",
    clinic: "Clinic console · Tími NOW",
    legal: "Legal center · Tími NOW",
    "sign-in": "Sign in · Tími NOW"
  })[route];

  if (route === "home") {
    const anchor = location.hash.replace("#", "");
    if (["how-it-works", "emergency"].includes(anchor)) requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView());
  }
  if (route === "vets" && location.hash.replace("#", "").split("?")[0] === "vets-apply") {
    requestAnimationFrame(() => document.getElementById("vets-apply")?.scrollIntoView());
  }
  if (route === "legal") {
    const section = routeQuery().get("section") || "terms";
    requestAnimationFrame(() => document.getElementById(section)?.scrollIntoView({ block: "start" }));
  }
  if (route === "find") {
    if (routeQuery().get("care") === "emergency") {
      state.intakeDraft.urgency = "emergency";
      state.intakeStep = 1;
    }
    hydrateIntakeForm();
    renderIntakeStep();
  }
  if (route === "paw-it-forward") await enterPawItForward();
  if (route === "results") await loadLocations();
  if (route === "tracker") {
    const searchLinkToken = routeQuery().get("st");
    if (searchLinkToken) {
      try {
        const resolved = await api(`/api/searches/by-token?token=${encodeURIComponent(searchLinkToken)}`);
        state.currentSearch = resolved.search;
        state.currentIntake = null;
        writeStorage(STORAGE_KEYS.search, state.currentSearch);
      } catch (error) {
        showToast(error.code === "SEARCH_LINK_EXPIRED" ? "This link has expired." : error.message);
      }
    }
    await refreshCurrentIntake();
    state.trackerTimer = window.setInterval(refreshCurrentIntake, 5000);
  }
  if (route === "clinic") {
    renderAccountMenu();
    renderClinicWorkspaceSwitch();
    const denied = state.config?.signInRequired && state.session && state.session.surfaces && !state.session.surfaces.clinic;
    $("[data-clinic-denied]").hidden = !denied;
    $("[data-clinic-console-body]").hidden = denied;
    if (!denied) {
      await loadClinicDashboard();
      state.clinicTimer = window.setInterval(loadClinicDashboard, 15000);
    }
  }
  if (route === "sign-in") await renderSignIn();
  if (APP_ROUTES.has(route) && route !== "sign-in") renderAccountMenu();
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("accept", "application/json");
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (state.config?.signInRequired && state.clerk?.session) {
    let token = null;
    try { token = await state.clerk.session.getToken({ template: "timinow" }); }
    catch { token = await state.clerk.session.getToken(); }
    if (token) headers.set("authorization", `Bearer ${token}`);
  } else if (options.clinic) {
    headers.set("x-demo-role", "clinic");
    headers.set("x-demo-tenant-id", "tenant_hearth");
    headers.set("x-demo-user-id", "demo_clinic_manager");
  }
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error?.message || `Request failed (${response.status})`);
    error.code = data.error?.code;
    error.details = data.error?.details;
    throw error;
  }
  return data;
}

async function loadConfig() {
  try {
    state.config = await api("/api/config");
  } catch {
    state.config = { signInRequired: false, demoMode: true, database: "fixtures" };
  }
  configureMap(state.config.map);
  applyPricingCopy();
  if (state.config.signInRequired) await initializeClerk();
}

/**
 * Every price and version the static markup leaves blank.
 *
 * The HTML ships placeholders rather than numbers so that a screen can never
 * outlive the pricing policy behind it — a page that says "$25" after the fee
 * became $20 is a page that misquotes a charge somebody is about to authorize.
 */
function applyPricingCopy() {
  const fee = fees();
  $$("[data-fee-owner]").forEach((node) => { node.textContent = formatMoney(fee.ownerFeeCents); });
  $$("[data-fee-clinic]").forEach((node) => { node.textContent = formatMoney(fee.clinicFeeCents); });
  $$("[data-fee-disclosure]").forEach((node) => { node.textContent = serviceFeeSentence(); });
  const ownerFee = $("[data-vets-owner-fee]");
  if (ownerFee) ownerFee.textContent = formatMoney(fee.ownerFeeCents);
  const clinicFee = $("[data-vets-clinic-fee]");
  if (clinicFee) clinicFee.textContent = formatMoney(fee.clinicFeeCents);
  const version = $("[data-legal-version]");
  if (version && state.config?.legalVersion) version.textContent = `Version ${state.config.legalVersion}`;
}

async function initializeClerk() {
  if (!state.config.clerkPublishableKey || !state.config.clerkJsUrl) return;
  try {
    const clerkModule = await import(state.config.clerkJsUrl);
    const Clerk = clerkModule.Clerk || clerkModule.default?.Clerk || clerkModule.default;
    state.clerk = new Clerk(state.config.clerkPublishableKey);
    await state.clerk.load();
    state.clerk.addListener(() => renderAccountMenu());
  } catch (error) {
    console.error("Clerk initialization failed", error);
  }
}

/* ---------------------------------------------------------------------- */
/* Custom Clerk-headless auth state machine                               */
/* ---------------------------------------------------------------------- */

function resetAuthFlow() {
  state.auth = {
    step: "identifier",
    signIn: null,
    signUp: null,
    factors: [],
    activeFactor: null,
    flowKind: "sign-in",
    signUpChannel: null,
    signUpIdentifier: "",
    resendAvailableAt: 0,
    resendTimer: null,
    memberships: [],
    pendingRoute: null,
    forceOrgPicker: false
  };
  $("[data-auth-identifier-form]")?.reset();
  $("[data-auth-signup-form]")?.reset();
  clearOtpInputs();
  setAuthStep("identifier");
}

function setAuthStep(step) {
  $$('[data-auth-step]').forEach((panel) => { panel.hidden = panel.dataset.authStep !== step; });
  if (state.auth) state.auth.step = step;
  clearAuthError();
  if (step === "code") requestAnimationFrame(focusFirstOtp);
}

function showAuthError(error) {
  const message = error?.errors?.[0]?.longMessage || error?.message || "Something went wrong. Please try again.";
  const box = $("[data-auth-error]");
  if (!box) return;
  box.querySelector("[data-auth-error-text]").textContent = message;
  box.hidden = false;
}

function clearAuthError() {
  const box = $("[data-auth-error]");
  if (box) box.hidden = true;
}

function setSubmitting(form, submitting, label) {
  const button = form.querySelector(".auth-submit");
  if (!button) return;
  button.disabled = submitting;
  button.textContent = submitting ? "Please wait…" : label;
}

async function renderSignIn() {
  const disabled = $("[data-auth-disabled]");
  const steps = $("[data-auth-steps]");
  if (!state.config?.signInRequired) {
    steps.hidden = true;
    disabled.hidden = false;
    return;
  }
  disabled.hidden = true;
  steps.hidden = false;
  if (!state.clerk) {
    setAuthStep("identifier");
    showAuthError({ errors: [{ longMessage: "Clerk is not configured. Add the Clerk publishable key and issuer before setting SIGN_IN_REQUIRED=true." }] });
    return;
  }
  if (state.auth?.forceOrgPicker) {
    state.auth.forceOrgPicker = false;
    renderOrgPicker(state.clerk.user?.organizationMemberships || []);
    return;
  }
  if (state.clerk.user) {
    await afterAuthenticated();
    return;
  }
  resetAuthFlow();
}

async function afterAuthenticated() {
  try { state.session = (await api("/api/session")).session; }
  catch { state.session = null; }
  const returnRoute = (state.auth && state.auth.pendingRoute) || sessionStorage.getItem("timi_return_route") || "find";
  const memberships = state.clerk.user?.organizationMemberships || [];
  if (returnRoute === "clinic" && !state.clerk.organization) {
    if (memberships.length > 1) {
      if (!state.auth) state.auth = { pendingRoute: null };
      state.auth.pendingRoute = "clinic";
      renderOrgPicker(memberships);
      return;
    }
    if (memberships.length === 1) {
      try {
        await state.clerk.setActive({ organization: memberships[0].organization.id });
        state.session = (await api("/api/session")).session;
      } catch { /* fall through with whatever session we already have */ }
    }
  }
  finalizeRouting(returnRoute);
}

function finalizeRouting(returnRoute) {
  sessionStorage.removeItem("timi_return_route");
  if (state.auth) state.auth.pendingRoute = null;
  renderAccountMenu();
  if (returnRoute === "clinic" && state.session && state.session.surfaces && !state.session.surfaces.clinic) {
    setAuthStep("denied");
    $("[data-auth-denied-message]").textContent = "This account is not part of a veterinary workspace. Sign in with a clinic account, or return to the customer app.";
    return;
  }
  setRoute(returnRoute);
}

function renderOrgPicker(memberships) {
  state.auth.memberships = memberships;
  const list = $("[data-auth-org-list]");
  list.innerHTML = memberships.map((membership, index) => `
    <button class="auth-org-card" type="button" data-org-index="${index}">
      <span class="auth-org-avatar">${escapeHtml(initials(membership.organization?.name || "Org"))}</span>
      <span><strong>${escapeHtml(membership.organization?.name || "Workspace")}</strong><small>${escapeHtml(humanize(membership.role || ""))}</small></span>
    </button>`).join("");
  setAuthStep("organization");
}

function openOrgSwitcher() {
  const memberships = state.clerk?.user?.organizationMemberships || [];
  if (memberships.length < 2) return showToast("This account has only one workspace.");
  if (!state.auth) resetAuthFlow();
  state.auth.pendingRoute = state.route === "sign-in" ? "clinic" : state.route;
  state.auth.forceOrgPicker = true;
  setRoute("sign-in");
}

/** Tími sign-in offers one-time codes only: email codes and phone codes. */
const ALLOWED_FIRST_FACTORS = new Set(["email_code", "phone_code"]);

function strategyLabel(factor) {
  switch (factor.strategy) {
    case "email_code": return { title: "Email me a code", detail: factor.safeIdentifier || "" };
    case "phone_code": return { title: "Text me a code", detail: factor.safeIdentifier || "" };
    default: return { title: humanize(factor.strategy), detail: "" };
  }
}

function renderStrategyStep(signIn) {
  const factors = (signIn.supportedFirstFactors || []).filter((factor) => ALLOWED_FIRST_FACTORS.has(factor.strategy));
  state.auth.factors = factors;
  if (factors.length <= 1) {
    if (factors[0]) return startFactor(factors[0]);
    return showAuthError({ errors: [{ longMessage: "This account has no email or phone number that can receive a one-time code. Contact support to update your account." }] });
  }
  const list = $("[data-auth-strategy-list]");
  list.innerHTML = factors.map((factor, index) => {
    const label = strategyLabel(factor);
    return `<button class="auth-strategy-option" type="button" data-factor-index="${index}"><span>${escapeHtml(label.title)}</span>${label.detail ? `<small>${escapeHtml(label.detail)}</small>` : ""}</button>`;
  }).join("");
  setAuthStep("strategy");
}

async function startFactor(factor) {
  switch (factor.strategy) {
    case "email_code":
    case "phone_code":
      await prepareAndShowCode(factor);
      break;
    default:
      showAuthError({ errors: [{ longMessage: `Unsupported sign-in method: ${humanize(factor.strategy)}` }] });
  }
}

async function prepareAndShowCode(factor) {
  try {
    const params = { strategy: factor.strategy };
    if (factor.emailAddressId) params.emailAddressId = factor.emailAddressId;
    if (factor.phoneNumberId) params.phoneNumberId = factor.phoneNumberId;
    const updated = await state.auth.signIn.prepareFirstFactor(params);
    state.auth.signIn = updated;
    state.auth.activeFactor = factor;
    state.auth.flowKind = "sign-in";
    $("[data-auth-code-lede]").textContent = `Enter the 6-digit code sent to ${factor.safeIdentifier || "you"}.`;
    clearOtpInputs();
    startResendCooldown();
    setAuthStep("code");
  } catch (error) { showAuthError(error); }
}

async function handleSignInResult(signIn) {
  state.auth.signIn = signIn;
  switch (signIn.status) {
    case "complete":
      await completeSignIn(signIn.createdSessionId);
      break;
    case "needs_first_factor":
      renderStrategyStep(signIn);
      break;
    case "needs_second_factor":
      showAuthError({ errors: [{ longMessage: "This account requires a second verification step that isn't supported here yet. Please contact your workspace administrator." }] });
      break;
    case "needs_new_password":
      showAuthError({ errors: [{ longMessage: "Tími sign-in uses one-time codes only; passwords are no longer supported. Contact support if your account still requires one." }] });
      break;
    case "needs_identifier":
      resetAuthFlow();
      break;
    default:
      showAuthError({ errors: [{ longMessage: `Unexpected sign-in status: ${signIn.status}` }] });
  }
}

async function completeSignIn(sessionId) {
  await state.clerk.setActive({ session: sessionId });
  await afterAuthenticated();
}

async function signOut() {
  try { await state.clerk?.signOut(); } catch (error) { console.error("Sign out failed", error); }
  state.session = null;
  closeAccountMenus();
  renderAccountMenu();
  setRoute("home");
}

/* One-time-code input helpers */
function otpInputs() { return $$('[data-otp-input] input'); }
function clearOtpInputs() { otpInputs().forEach((input) => { input.value = ""; }); }
function getOtpValue() { return otpInputs().map((input) => input.value).join(""); }
function focusFirstOtp() { otpInputs()[0]?.focus(); }

async function submitCode() {
  const code = getOtpValue();
  if (code.length !== 6) return;
  try {
    if (state.auth.flowKind === "sign-up") {
      const signUp = state.auth.signUp;
      const result = state.auth.signUpChannel === "phone"
        ? await signUp.attemptPhoneNumberVerification({ code })
        : await signUp.attemptEmailAddressVerification({ code });
      state.auth.signUp = result;
      if (result.status === "complete") await completeSignIn(result.createdSessionId);
      else showAuthError({ errors: [{ longMessage: `Verification incomplete (${humanize(result.status)}).` }] });
    } else {
      const factor = state.auth.activeFactor;
      const attempted = await state.auth.signIn.attemptFirstFactor({ strategy: factor.strategy, code });
      state.auth.signIn = attempted;
      await handleSignInResult(attempted);
    }
  } catch (error) {
    showAuthError(error);
    clearOtpInputs();
    focusFirstOtp();
  }
}

function startResendCooldown() {
  state.auth.resendAvailableAt = Date.now() + 30_000;
  updateResendButton();
  window.clearInterval(state.auth.resendTimer);
  state.auth.resendTimer = window.setInterval(updateResendButton, 1000);
}

function updateResendButton() {
  const button = $("[data-auth-resend]");
  if (!button) return;
  const remaining = Math.ceil((state.auth.resendAvailableAt - Date.now()) / 1000);
  if (remaining > 0) { button.disabled = true; button.textContent = `Resend code (${remaining}s)`; }
  else { button.disabled = false; button.textContent = "Resend code"; window.clearInterval(state.auth.resendTimer); }
}

async function resendCode() {
  try {
    if (state.auth.flowKind === "sign-up") {
      const signUp = state.auth.signUp;
      if (state.auth.signUpChannel === "phone") await signUp.preparePhoneNumberVerification({ strategy: "phone_code" });
      else await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
      startResendCooldown();
    } else if (state.auth.activeFactor) {
      await prepareAndShowCode(state.auth.activeFactor);
    }
  } catch (error) { showAuthError(error); }
}

/* Custom workspace switcher for the clinic console */
function renderClinicWorkspaceSwitch() {
  const button = $("[data-workspace-switch]");
  if (!button) return;
  if (!state.config?.signInRequired || !state.clerk?.user) { button.hidden = true; return; }
  button.hidden = false;
  button.querySelector("[data-workspace-switch-label]").textContent = state.clerk.organization?.name || "Choose workspace";
}

/* Custom header account menu */
function closeAccountMenus() {
  $$('[data-account-panel]').forEach((panel) => { panel.hidden = true; });
}

function renderAccountMenu() {
  const containers = $$('[data-account-menu]');
  const user = state.clerk?.user;
  containers.forEach((container) => {
    if (!state.config?.signInRequired || !user) { container.hidden = true; container.innerHTML = ""; return; }
    container.hidden = false;
    const name = user.fullName || user.username || user.primaryEmailAddress?.emailAddress || "Account";
    const email = user.primaryEmailAddress?.emailAddress || "";
    const orgName = state.clerk.organization?.name;
    const memberships = user.organizationMemberships || [];
    container.innerHTML = `
      <button class="account-menu-trigger" type="button" data-account-toggle aria-haspopup="true" aria-expanded="false">
        <span class="account-avatar">${escapeHtml(initials(name))}</span>
        ${orgName ? `<span class="account-org-label">${escapeHtml(orgName)}</span>` : ""}
      </button>
      <div class="account-menu-panel" data-account-panel hidden>
        <div class="account-menu-identity"><strong>${escapeHtml(name)}</strong>${email ? `<small>${escapeHtml(email)}</small>` : ""}</div>
        ${memberships.length > 1 ? '<button class="account-menu-item" type="button" data-switch-workspace>Switch workspace</button>' : ""}
        <button class="account-menu-item" type="button" data-sign-out>Sign out</button>
      </div>`;
  });
}

function hydrateIntakeForm() {
  const form = $("[data-intake-form]");
  if (!form) return;
  const draft = state.intakeDraft;
  const set = (name, value) => { if (form.elements[name] && value !== undefined && value !== null) form.elements[name].value = value; };
  set("petName", draft.petName); set("species", draft.species); set("breed", draft.breed); set("weightLbs", draft.weightLbs);
  set("ownerName", draft.ownerName); set("ownerPhone", draft.ownerPhone); set("ownerEmail", draft.ownerEmail); set("concernSummary", draft.concernSummary); set("startedWhen", draft.startedWhen);
  const urgency = form.querySelector(`[name="urgency"][value="${CSS.escape(draft.urgency || "same_day")}"]`);
  if (urgency) urgency.checked = true;
  $$('[name="redFlag"]', form).forEach((input) => { input.checked = (draft.redFlags || []).includes(input.value); });
  $$('[name="symptom"]', form).forEach((input) => { input.checked = (draft.symptoms || []).includes(input.value); });
  if (form.elements.legalConsent) form.elements.legalConsent.checked = draft.legalConsent === true;
  if (form.elements.contactConsent) form.elements.contactConsent.checked = draft.contactConsent === true;
  $("[data-location-label]").textContent = draft.position?.label || DEFAULT_POSITION.label;
  $("[data-location-detail]").textContent = draft.position?.detail || DEFAULT_POSITION.detail;
  updateSafetyCallout();
  updateConcernSpecificity();
}

function persistFormDraft() {
  const form = $("[data-intake-form]");
  if (!form) return;
  const values = new FormData(form);
  state.intakeDraft = {
    ...state.intakeDraft,
    petName: String(values.get("petName") || "").trim(),
    species: String(values.get("species") || "dog"),
    breed: String(values.get("breed") || "").trim(),
    weightLbs: Number(values.get("weightLbs")) || null,
    urgency: String(values.get("urgency") || "same_day"),
    symptoms: values.getAll("symptom").map(String),
    startedWhen: String(values.get("startedWhen") || ""),
    concernSummary: String(values.get("concernSummary") || "").trim(),
    redFlags: values.getAll("redFlag").map(String),
    ownerName: String(values.get("ownerName") || "").trim(),
    ownerPhone: String(values.get("ownerPhone") || "").trim(),
    ownerEmail: String(values.get("ownerEmail") || "").trim(),
    legalConsent: values.get("legalConsent") === "on",
    contactConsent: values.get("contactConsent") === "on"
  };
  if (state.intakeDraft.redFlags.length) state.intakeDraft.urgency = "emergency";
  writeStorage(STORAGE_KEYS.draft, state.intakeDraft);
}

function renderIntakeStep() {
  $$('[data-intake-step]').forEach((step) => {
    const active = Number(step.dataset.intakeStep) === state.intakeStep;
    step.hidden = !active;
    step.classList.toggle("is-active", active);
  });
  $("[data-intake-step-label]").textContent = `${state.intakeStep} of 2`;
  $("[data-intake-progress]").style.width = `${state.intakeStep * 50}%`;
  requestAnimationFrame(() => $("[data-intake-step]:not([hidden]) h1")?.focus?.());
}

function validateStep(step) {
  const panel = $(`[data-intake-step="${step}"]`);
  const form = $("[data-intake-form]");
  const concern = form?.elements.concernSummary;
  if (step === 1 && concern) {
    const values = new FormData(form);
    const assessment = assessConcern(values.get("concernSummary"), values.getAll("symptom").map(String), values.get("startedWhen"));
    concern.setCustomValidity(assessment.ok ? "" : assessment.message);
  }
  const fields = $$('input, select, textarea', panel).filter((field) => field.required && !field.checkValidity());
  $$('.field-error', panel).forEach((error) => error.remove());
  if (!fields.length) return true;
  const first = fields[0];
  const error = document.createElement("p");
  error.className = "field-error";
  error.textContent = first.validationMessage || "Complete this field to continue.";
  first.closest("label, fieldset")?.append(error);
  first.focus();
  return false;
}

function updateConcernSpecificity() {
  const form = $("[data-intake-form]");
  const meter = $("[data-specificity-meter]");
  if (!form || !meter) return;
  const values = new FormData(form);
  const assessment = assessConcern(values.get("concernSummary"), values.getAll("symptom").map(String), values.get("startedWhen"));
  meter.classList.toggle("is-ready", assessment.ok);
  meter.querySelector("span").textContent = assessment.message;
  meter.querySelector("i").style.width = assessment.ok ? `${Math.min(100, (assessment.strength || 4) * 18)}%` : "26%";
  form.elements.concernSummary?.setCustomValidity(assessment.ok ? "" : assessment.message);
}

function updateSafetyCallout() {
  const form = $("[data-intake-form]");
  if (!form) return;
  const hasFlag = $$('[name="redFlag"]', form).some((input) => input.checked);
  const emergency = form.elements.urgency?.value === "emergency";
  $("[data-safety-callout]").hidden = !(hasFlag || emergency);
}

async function useLocation() {
  if (!navigator.geolocation) return showToast("Location services are not available in this browser.");
  showToast("Finding your location…");
  navigator.geolocation.getCurrentPosition(
    (position) => {
      state.intakeDraft.position = {
        latitude: Number(position.coords.latitude.toFixed(6)),
        longitude: Number(position.coords.longitude.toFixed(6)),
        label: "Current location",
        detail: `Accurate to about ${Math.round(position.coords.accuracy)} meters`
      };
      writeStorage(STORAGE_KEYS.draft, state.intakeDraft);
      if (state.route === "home") setRoute("find");
      else hydrateIntakeForm();
      showToast("Location updated.");
    },
    () => showToast("We could not access your location. You can continue with the demonstration area."),
    { enableHighAccuracy: true, timeout: 9000, maximumAge: 60_000 }
  );
}

function careType() {
  return state.intakeDraft.urgency === "emergency" || state.intakeDraft.redFlags?.length ? "emergency" : "urgent";
}

async function loadLocations() {
  const list = $("[data-hospital-list]");
  list.innerHTML = '<div class="loading-state"><span class="evander evander-sm" aria-hidden="true"></span><strong>Checking nearby capacity…</strong></div>';
  const position = state.intakeDraft.position || DEFAULT_POSITION;
  const params = new URLSearchParams({ lat: position.latitude, lng: position.longitude, radius: "50", species: state.intakeDraft.species || "dog", care: careType() });
  try {
    const data = await api(`/api/locations?${params}`);
    state.locations = data.locations;
    renderLocations();
  } catch (error) {
    list.innerHTML = `<div class="empty-state"><strong>Availability could not be loaded.</strong><p>${escapeHtml(error.message)}</p><button class="button button-quiet" type="button" data-refresh-results>Try again</button></div>`;
  }
  $("[data-results-context]").textContent = `Searching near ${position.label} for ${state.intakeDraft.petName || "your pet"}.`;
  $("[data-summary-pet]").textContent = `${state.intakeDraft.petName || "Pet"} · ${humanize(state.intakeDraft.species)}`;
  $("[data-summary-urgency]").textContent = humanize(state.intakeDraft.urgency);
  $("[data-summary-area]").textContent = position.label;
}

function sortLocations(locations) {
  const sort = $("[data-sort-results]")?.value || "recommended";
  const copy = [...locations];
  if (sort === "distance") return copy.sort((a, b) => (a.distanceMiles ?? 999) - (b.distanceMiles ?? 999));
  if (sort === "wait") return copy.sort((a, b) => (a.availability.stableWaitMin ?? 9999) - (b.availability.stableWaitMin ?? 9999));
  if (sort === "freshness") return copy.sort((a, b) => Date.parse(b.availability.reportedAt || 0) - Date.parse(a.availability.reportedAt || 0));
  const rank = { available: 0, limited: 1, confirm_first: 2, critical_only: 3, unverified: 4, diverting: 5, closed: 6 };
  return copy.sort((a, b) => (rank[a.availability.intakeStatus] ?? 9) - (rank[b.availability.intakeStatus] ?? 9) || (a.distanceMiles ?? 999) - (b.distanceMiles ?? 999));
}

function waitText(location) {
  const availability = location.availability;
  if (availability.stableWaitMin === null && availability.stableWaitMax === null) return "Not reported";
  if (availability.stableWaitMin === availability.stableWaitMax) return `${availability.stableWaitMin} min`;
  return `${availability.stableWaitMin ?? 0}–${availability.stableWaitMax ?? "?"} min`;
}

function renderLocations() {
  const list = $("[data-hospital-list]");
  const locations = sortLocations(state.locations);
  if (!locations.length) {
    list.innerHTML = '<div class="empty-state"><strong>No matching hospital is reporting nearby.</strong><p>Increase the search area or call the nearest emergency hospital if your pet may be in danger.</p></div>';
    return;
  }
  const eligibleCount = locations.filter((location) => careType() === "emergency" || !["closed", "diverting", "critical_only"].includes(location.availability.intakeStatus)).slice(0, 30).length;
  const launch = $("[data-start-search]");
  if (launch) {
    launch.disabled = eligibleCount === 0;
    launch.textContent = eligibleCount ? `Ask ${eligibleCount} nearby clinic${eligibleCount === 1 ? "" : "s"}` : "No clinics available to ask";
  }
  const launchNote = $("[data-search-launch-note]");
  if (launchNote) launchNote.textContent = `Tími will contact ${eligibleCount} matching clinic${eligibleCount === 1 ? "" : "s"} and show up to five active offers. Nothing is booked until you choose.`;
  renderResultsMap();
  list.innerHTML = locations.map((location) => {
    const status = location.availability.intakeStatus;
    const disabled = ["closed", "diverting"].includes(status) && careType() !== "emergency";
    const capabilities = location.capabilities.slice(0, 4).map((capability) => `<span>${escapeHtml(humanize(capability))}</span>`).join("");
    return `<article class="hospital-card ${location.kind === "emergency" ? "is-emergency" : ""}">
      <div class="hospital-avatar">${escapeHtml(initials(location.name))}</div>
      <div class="hospital-main"><span class="hospital-kind">${escapeHtml(humanize(location.kind))} care</span><h2>${escapeHtml(location.name)}</h2>
        <div class="hospital-meta"><span>${location.distanceMiles ?? "—"} mi away</span><span>${escapeHtml(location.open24Hours ? "Open 24 hours" : "Open now")}</span><span>${escapeHtml(location.phone)}</span></div>
        <div class="hospital-capabilities">${capabilities}</div>
        <div class="freshness-row"><strong>${escapeHtml(humanize(location.availability.source))}</strong><span>Verified ${escapeHtml(formatRelativeTime(location.availability.reportedAt))}</span><span class="confidence">${escapeHtml(humanize(location.availability.confidence))} confidence</span></div>
      </div>
      <div class="capacity-box"><div class="capacity-label"><i class="signal ${escapeHtml(status)}"></i>${escapeHtml(location.availability.label)}</div><div class="wait-range"><small>REPORTED STABLE-PATIENT WAIT</small><strong>${escapeHtml(waitText(location))}</strong></div><div class="card-actions"><button class="button button-quiet" type="button" data-view-location="${escapeHtml(location.id)}">Details</button><span class="candidate-state">${disabled ? "Not contacted" : "Included in search"}</span></div></div>
    </article>`;
  }).join("");
}

function openHospitalDialog(locationId, requestMode = false) {
  const location = state.locations.find((candidate) => candidate.id === locationId);
  if (!location) return;
  state.selectedLocation = location;
  const policy = location.policy || {};
  const content = $("[data-hospital-dialog-content]");
  content.innerHTML = `<p class="eyebrow coral">${escapeHtml(humanize(location.kind))} CARE</p><h2 id="hospital-dialog-title">${escapeHtml(location.name)}</h2><p class="address">${escapeHtml(location.address)} · ${escapeHtml(location.phone)}</p>
    <div class="dialog-capacity"><div><small>CURRENT STATUS</small><strong>${escapeHtml(location.availability.label)}</strong></div><div><small>STABLE-PATIENT WAIT</small><strong>${escapeHtml(waitText(location))}</strong></div><div><small>VERIFIED</small><strong>${escapeHtml(formatRelativeTime(location.availability.reportedAt))}</strong></div><div><small>SOURCE</small><strong>${escapeHtml(humanize(location.availability.source))} · ${escapeHtml(location.availability.confidence)}</strong></div></div>
    <p class="dialog-note">${escapeHtml(location.availability.note || "Hospital staff determine clinical priority after intake. Your actual wait can change when critical patients arrive.")}</p>
    <div class="deposit-box"><strong>${policy.depositRequired ? `${formatMoney(policy.depositAmountCents)} arrival deposit after acceptance` : "No Tími deposit required"}</strong><small>${policy.depositRequired ? `Policy ${escapeHtml(policy.version || "current")}: the full deposit is credited to the clinic invoice. Refund and no-show terms are shown again before payment. ${escapeHtml(serviceFeeSentence())}` : "The clinic will handle veterinary payment directly."}</small></div>
    <p class="dialog-legal">If included in a search, this clinic receives the structured intake under the <a href="#legal?section=terms">Terms</a> and <a href="#legal?section=safety">Veterinary Safety Notice</a>. No clinic is confirmed until you choose an offer.</p>
    <div class="dialog-actions"><a class="button button-quiet" href="tel:${escapeHtml(location.phone.replace(/[^0-9+]/g, ""))}">Call hospital</a><button class="button button-primary" type="button" data-close-dialog>Done</button></div>`;
  const dialog = $("[data-hospital-dialog]");
  dialog.showModal();
  document.body.classList.add("dialog-open");
}

async function startCareSearch() {
  const draft = state.intakeDraft;
  const candidates = sortLocations(state.locations)
    .filter((location) => careType() === "emergency" || !["closed", "diverting", "critical_only"].includes(location.availability.intakeStatus))
    .slice(0, 30);
  if (!candidates.length) return showToast("No matching clinic can be contacted from this search.");
  const button = $("[data-start-search]");
  if (button) { button.disabled = true; button.textContent = "Contacting clinics…"; }
  try {
    const data = await api("/api/searches", {
      method: "POST",
      body: JSON.stringify({
        locationIds: candidates.map((location) => location.id),
        targetLimit: 30,
        radiusMiles: 50,
        pet: { name: draft.petName, species: draft.species, breed: draft.breed, weightLbs: draft.weightLbs },
        owner: { name: draft.ownerName, phone: draft.ownerPhone, email: draft.ownerEmail },
        concernCategory: careType() === "emergency" ? "possible_emergency" : "illness_or_injury",
        concernSummary: draft.concernSummary,
        symptoms: draft.symptoms,
        startedWhen: draft.startedWhen,
        urgency: draft.urgency,
        redFlags: draft.redFlags,
        customerLatitude: draft.position.latitude,
        customerLongitude: draft.position.longitude,
        consentToContact: draft.contactConsent === true,
        legalConsent: draft.legalConsent === true,
        legalVersion: state.config?.legalVersion || ""
      })
    });
    state.currentSearch = data.search;
    state.currentIntake = null;
    writeStorage(STORAGE_KEYS.search, state.currentSearch);
    writeStorage(STORAGE_KEYS.intake, null);
    track("search_started", { clinics: candidates.length });
    setRoute("tracker");
  } catch (error) {
    showToast(error.message);
    if (button) { button.disabled = false; button.textContent = "Ask nearby clinics"; }
  }
}

async function submitIntake(locationId) {
  const location = state.locations.find((candidate) => candidate.id === locationId);
  if (!location) return;
  const draft = state.intakeDraft;
  const policyAck = $("[data-policy-ack]");
  if (policyAck && !policyAck.checked) { policyAck.focus(); return showToast("Acknowledge the clinic and capacity terms before sending."); }
  const button = $(`[data-confirm-request="${CSS.escape(locationId)}"]`);
  if (button) { button.disabled = true; button.textContent = "Sending…"; }
  try {
    const data = await api("/api/intakes", {
      method: "POST",
      body: JSON.stringify({
        locationId,
        pet: { name: draft.petName, species: draft.species, breed: draft.breed, weightLbs: draft.weightLbs },
        owner: { name: draft.ownerName, phone: draft.ownerPhone, email: draft.ownerEmail },
        concernCategory: careType() === "emergency" ? "possible_emergency" : "illness_or_injury",
        concernSummary: draft.concernSummary,
        symptoms: draft.symptoms,
        startedWhen: draft.startedWhen,
        urgency: draft.urgency,
        redFlags: draft.redFlags,
        customerLatitude: draft.position.latitude,
        customerLongitude: draft.position.longitude,
        travelMinutes: Math.max(5, Math.round((location.distanceMiles || 2) * 4)),
        consentToContact: draft.contactConsent === true,
        legalConsent: draft.legalConsent === true,
        legalVersion: state.config?.legalVersion || ""
      })
    });
    state.currentIntake = { ...data.intake, location: data.location };
    writeStorage(STORAGE_KEYS.intake, state.currentIntake);
    $("[data-hospital-dialog]").close();
    document.body.classList.remove("dialog-open");
    setRoute("tracker");
  } catch (error) {
    showToast(error.message);
    if (button) { button.disabled = false; button.textContent = "Send intake request"; }
  }
}

async function refreshCurrentIntake() {
  if (!state.currentIntake?.id && state.currentSearch?.id) {
    await refreshCareSearch();
    return;
  }
  if (!state.currentIntake?.id) {
    $("[data-tracker-title]").textContent = "No active intake request.";
    $("[data-tracker-lede]").textContent = "Return to results to ask a hospital to accept your pet.";
    return;
  }
  if (state.currentIntake.demo || state.currentIntake.id.startsWith("demo_")) {
    const elapsed = Date.now() - timestampMs(state.currentIntake.requestedAt);
    if (state.currentIntake.status === "pending" && elapsed >= 5_000) {
      const now = new Date().toISOString();
      const arrivalMinutes = state.currentIntake.location?.arrivalWindowMinutes || 20;
      state.currentIntake = {
        ...state.currentIntake,
        status: "accepted",
        decisionAt: now,
        arrivalBy: new Date(Date.now() + arrivalMinutes * 60_000).toISOString(),
        clinicNote: "Demo confirmation: the veterinary team reviewed the request and is ready for your arrival.",
        updatedAt: now
      };
      writeStorage(STORAGE_KEYS.intake, state.currentIntake);
      showToast("The veterinary team accepted the demonstration intake.");
    }
    renderTracker();
    return;
  }
  try {
    const data = await api(`/api/intakes/${encodeURIComponent(state.currentIntake.id)}`);
    state.currentIntake = { ...state.currentIntake, ...data.intake };
    writeStorage(STORAGE_KEYS.intake, state.currentIntake);
  } catch (error) {
    if (error.code !== "INTAKE_NOT_FOUND") showToast(error.message);
  }
  renderTracker();
}

async function refreshCareSearch() {
  if (!state.currentSearch?.id) return;
  if (!state.currentSearch.demo && !state.currentSearch.id.startsWith("demo_search_")) {
    try {
      const data = await api(`/api/searches/${encodeURIComponent(state.currentSearch.id)}`);
      state.currentSearch = data.search;
      writeStorage(STORAGE_KEYS.search, state.currentSearch);
      if (state.currentSearch.selectedIntakeId) {
        const intakeData = await api(`/api/intakes/${encodeURIComponent(state.currentSearch.selectedIntakeId)}`);
        const selectedOffer = state.currentSearch.offers?.find((offer) => offer.id === state.currentSearch.selectedOfferId);
        state.currentIntake = { ...intakeData.intake, location: selectedOffer?.location };
        writeStorage(STORAGE_KEYS.intake, state.currentIntake);
        renderTracker();
        return;
      }
    } catch (error) {
      if (error.code !== "SEARCH_NOT_FOUND") showToast(error.message);
    }
  }
  renderCareSearch();
}

function offerWaitText(offer) {
  if (offer.waitMin === null && offer.waitMax === null) return "Not supplied";
  if (offer.waitMin === offer.waitMax) return `${offer.waitMin} min`;
  return `${offer.waitMin ?? 0}–${offer.waitMax ?? "?"} min`;
}

function offerTypeLabel(offer) {
  return ({
    available_now: "Available now",
    available_at: offer.availableAt ? `Available ${formatClock(offer.availableAt)}` : "Available at stated time",
    emergency_intake: "Emergency intake open"
  })[offer.responseType] || "Availability offered";
}

function renderCareSearch() {
  const search = state.currentSearch;
  if (!search) return;
  $("[data-search-stage]").hidden = false;
  $("[data-confirmed-stage]").hidden = true;
  const offers = Array.isArray(search.offers) ? search.offers.filter((offer) => offer.status === "active") : [];
  const progress = search.progress || { candidates: search.targetLimit || 0, contacted: 0, queued: 0, awaiting: 0, declined: 0, offers: offers.length };
  const currentWave = search.currentWave || 1;
  const expandingWaves = currentWave > 1;
  const searchTimedOut = search.status === "expired" && !offers.length;

  $("[data-offer-count]").textContent = `${offers.length} of ${search.maxOffers || 5} offers`;
  // Staged wave routing (Feature A) contacts clinics in small batches rather
  // than all at once, so "contacted" now tracks how many teams have actually
  // been reached so far — a real, growing number, not a bare spinner.
  $("[data-search-progress]").textContent = offers.length >= (search.maxOffers || 5)
    ? "Five clinics can help"
    : expandingWaves
      ? `Contacted ${progress.contacted || 0} of ${progress.candidates || progress.contacted || 0} veterinary teams`
      : "Checking nearby capacity…";
  $("[data-search-progress-detail]").textContent = searchTimedOut
    ? "No clinic confirmed in time. You have not been charged — this search costs you $0."
    : search.status === "expired"
      ? "The response window ended. Start a new search for current capacity."
      : expandingWaves
        ? "We're expanding your search to additional veterinary teams."
        : `${progress.awaiting || 0} awaiting response · ${progress.declined || 0} unavailable`;
  $("[data-tracker-eyebrow]").textContent = offers.length ? "AVAILABILITY OFFERS" : searchTimedOut ? "SEARCH ENDED" : "SEARCH IN PROGRESS";
  $("[data-tracker-title]").textContent = offers.length
    ? `${search.pet?.name || "Your pet"} has ${offers.length} option${offers.length === 1 ? "" : "s"}.`
    : searchTimedOut
      ? "No clinic was able to confirm in time."
      : expandingWaves
        ? "We're expanding your search to additional veterinary teams."
        : "Checking nearby capacity…";
  $("[data-tracker-lede]").textContent = offers.length
    ? "Compare the live offers and choose the clinic that works best. Tími will release every offer you do not select."
    : searchTimedOut
      // Explicit, on purpose: a customer whose search ends with nothing must
      // never have to wonder whether they are about to be billed for it.
      ? "You have not been charged anything — this search cost you $0. You're welcome to try again; capacity changes quickly."
      : `Offers will be collected until ${formatClock(search.collectionExpiresAt || search.searchExpiresAt)} or until five clinics respond. ${search.smsNotifiedAt ? "We texted you a link — it's safe to close this page." : "You may leave this page open; responses update automatically."}`;
  const list = $("[data-offer-list]");
  if (offers.length && renderCareSearch.offersViewedFor !== search.id) {
    renderCareSearch.offersViewedFor = search.id;
    track("offers_viewed", { offers: offers.length });
  }
  if (!offers.length) {
    const waitingHeadline = searchTimedOut ? "No clinic confirmed — you pay $0" : expandingWaves ? "Expanding to more veterinary teams" : "Checking nearby capacity…";
    const waitingBody = searchTimedOut
      ? "Every nearby team we contacted was unavailable in time. Nothing was charged. Capacity changes quickly, so it's worth trying again."
      : search.smsNotifiedAt
        ? "You may leave this page open, or watch for our text — responses update automatically either way."
        : "You may leave this page open; responses update automatically.";
    list.innerHTML = `<div class="empty-state offer-waiting">${searchTimedOut ? "" : '<span class="evander evander-sm" aria-hidden="true"></span>'}<strong>${escapeHtml(waitingHeadline)}</strong><p>${escapeHtml(waitingBody)}</p></div>`;
    return;
  }
  list.innerHTML = offers.map((offer) => matchCardHtml(search, offer)).join("");
}

/**
 * One match card.
 *
 * Three regions, in this order and visually separated on purpose:
 *
 *   1. the temporary match name, with its disclosure in plain persistent
 *      text directly beneath it — not a tooltip, not an icon;
 *   2. Tími's own operational facts (acceptance, travel, wait, capabilities,
 *      species) in their own panel;
 *   3. Google Maps content — the aggregate rating and its count — alone in a
 *      bordered sub-container carrying the Google Maps attribution inside it.
 *
 * The attribution belongs to the rating and nothing else: it never sits under
 * the whole card, never beside the alias, and never implies Google named,
 * supplied, verified, or approved anything. Region 3 is emitted only when
 * there is a live Google rating to show, so switching the module off leaves a
 * complete, usable card behind.
 */
function matchCardHtml(search, offer) {
  const clinic = offer.location || {};
  const emergency = offer.responseType === "emergency_intake";
  const canSelect = ["collecting", "offers_ready"].includes(search.status) && timestampMs(offer.expiresAt) > Date.now();
  const alias = aliasForOffer(search.id, offer);
  const rating = googleRatingFor(offer);
  const facts = matchCard(offer)?.timinow || {};
  const distanceMiles = facts.distanceMiles ?? clinic.distanceMiles;
  const travel = Number.isFinite(Number(facts.travelMinutes))
    ? `${facts.travelMinutes} min away`
    : (distanceMiles == null ? "Travel time not supplied" : `${distanceMiles} mi away`);
  const capabilities = (facts.capabilities || clinic.capabilities || []).slice(0, 3).map((capability) => humanize(capability));
  const species = (facts.species || clinic.species || []).map((entry) => humanize(entry)).join(" & ");
  const accessibleName = [
    `${alias}, temporary TímiNOW match name`,
    rating ? `rating ${rating.rating} based on ${rating.count} Google Maps ratings` : null,
    travel
  ].filter(Boolean).join(", ");

  return `<article class="match-card ${emergency ? "is-emergency" : ""}" aria-label="${escapeHtml(accessibleName)}">
      <div class="match-identity">
        <h3 class="match-alias">${escapeHtml(alias.toUpperCase())}</h3>
        <p class="match-alias-label">Temporary TímiNOW match name</p>
      </div>
      <div class="match-facts">
        <p class="match-facts-source">From Tími NOW</p>
        <p class="match-availability"><span class="signal ${emergency ? "limited" : "available"}" aria-hidden="true"></span>${escapeHtml(offerTypeLabel(offer))} · ${escapeHtml(travel)}</p>
        <dl class="offer-facts">
          <div><dt>${emergency ? "Estimated wait" : "Reported wait"}</dt><dd>${escapeHtml(offerWaitText(offer))}</dd></div>
          <div><dt>Clinic deposit</dt><dd>${offer.depositAmountCents ? formatMoney(offer.depositAmountCents) : "None"}</dd></div>
          <div><dt>Exam fee</dt><dd>${offer.baseExamFeeCents ? `From ${formatMoney(offer.baseExamFeeCents)}` : "Not supplied"}</dd></div>
          <div><dt>Patients seen</dt><dd>${escapeHtml(species || "Dogs & cats")}</dd></div>
        </dl>
        ${capabilities.length ? `<p class="match-capabilities">${capabilities.map((capability) => `<span>${escapeHtml(capability)}</span>`).join("")}</p>` : ""}
        <p class="offer-note">${escapeHtml(offer.clinicNote || (emergency ? "Open for emergency intake; treatment order is determined by clinical triage." : "The clinic reports capacity for this arrival window."))}</p>
      </div>
      ${rating ? `<div class="google-rating"><p class="google-rating-value"><span aria-hidden="true">★</span> ${escapeHtml(rating.rating)} <span class="google-rating-count">(${rating.count.toLocaleString("en-US")} ratings)</span></p><p class="google-rating-attribution">${escapeHtml(rating.attribution)}</p></div>` : ""}
      <div class="offer-card-actions"><small>Held until ${escapeHtml(formatClock(offer.expiresAt))}</small><button class="button button-primary" type="button" data-select-offer="${escapeHtml(offer.id)}" aria-label="Select ${escapeHtml(alias)}, temporary TímiNOW match name" ${canSelect ? "" : "disabled"}>Select this match</button></div>
    </article>`;
}

/* ---------------------------------------------------------------------- */
/* Pre-confirmation.                                                       */
/*                                                                         */
/* Selecting a match never books it. This screen stands between the two,   */
/* always: it names what the customer is about to buy, says plainly that   */
/* the name they chose is temporary and when the real one appears, itemizes */
/* every amount, and requires an explicit press. A saved payment method is  */
/* not a reason to skip a disclosure — there is no path around this screen. */
/* ---------------------------------------------------------------------- */

const BOOKING_CONTRIBUTION_CHOICES = [200, 500, 1000, 2000];

function openMatchConfirmation(offerId) {
  const search = state.currentSearch;
  const offer = search?.offers?.find((candidate) => candidate.id === offerId);
  if (!search || !offer) return;
  state.pendingMatch = {
    offerId,
    alias: aliasForOffer(search.id, offer),
    contributionCents: 0,
    contributionChoice: null,
    assistance: state.assistance?.decision?.result === "APPROVED" ? state.assistance : null
  };
  const toggle = $("[data-booking-contribution-toggle]");
  if (toggle) toggle.checked = false;
  const custom = $("[data-booking-contribution-custom]");
  if (custom) custom.value = "";
  renderMatchConfirmation();
  refreshAssistanceGrant();
  track("match_confirmation_viewed");
  const dialog = $("[data-match-confirm-dialog]");
  dialog.showModal();
  document.body.classList.add("dialog-open");
}

function pendingOffer() {
  const offerId = state.pendingMatch?.offerId;
  return state.currentSearch?.offers?.find((candidate) => candidate.id === offerId) || null;
}

/** True when the customer's Tími fee is covered by an approved application. */
function assistanceCoversFee() {
  return state.pendingMatch?.assistance?.decision?.result === "APPROVED";
}

function renderMatchConfirmation() {
  const pending = state.pendingMatch;
  const offer = pendingOffer();
  if (!pending || !offer) return;
  const covered = assistanceCoversFee();
  const feeCents = covered ? 0 : ownerFeeCents();
  const contributionCents = pending.contributionCents || 0;
  const depositCents = offer.depositAmountCents || 0;
  const chargedToday = feeCents + contributionCents;

  $("[data-match-confirm-lede]").innerHTML =
    `You selected <strong>${escapeHtml(pending.alias)}</strong>, a temporary match name. You’ll see the clinic’s real name, address, phone number, and directions immediately after confirmation.`;

  const rows = [
    `<div><dt>Tími NOW booking fee</dt><dd>${covered ? `${formatMoneyExact(0)} <small>covered by Paw It Forward</small>` : formatMoneyExact(feeCents)}</dd></div>`,
    contributionCents ? `<div><dt>Paw It Forward contribution</dt><dd>${formatMoneyExact(contributionCents)}</dd></div>` : "",
    depositCents ? `<div><dt>Clinic deposit</dt><dd>${formatMoneyExact(depositCents)} <small>charged separately by the clinic after it confirms your arrival window</small></dd></div>` : "",
    `<div class="order-total"><dt>Total charged today</dt><dd>${formatMoneyExact(chargedToday)}</dd></div>`
  ].filter(Boolean).join("");

  $("[data-match-confirm-summary]").innerHTML = `<dl class="order-summary">${rows}</dl>${
    depositCents
      ? `<p class="order-charges">This is <strong>two separate charges</strong>: ${formatMoneyExact(chargedToday)} to Tími NOW now, and the clinic’s ${formatMoneyExact(depositCents)} deposit as its own charge once the clinic confirms your arrival window. Veterinary charges are billed by the clinic.</p>`
      : `<p class="order-charges">One charge of ${formatMoneyExact(chargedToday)} to Tími NOW. The clinic bills any veterinary charges directly.</p>`
  }`;

  renderContributionChoices($("[data-booking-contribution-amounts]"), BOOKING_CONTRIBUTION_CHOICES, pending.contributionChoice, "booking-contribution");
  const customField = $("[data-booking-contribution-custom-field]");
  if (customField) customField.hidden = pending.contributionChoice !== "custom";
  const customInput = $("[data-booking-contribution-custom]");
  if (customInput) {
    customInput.min = String(Math.ceil(fees().minBookingContributionCents / 100));
    customInput.max = String(Math.floor(fees().maxBookingContributionCents / 100));
  }

  const assistanceState = $("[data-assistance-state]");
  const assistanceEntry = $("[data-open-assistance]");
  if (covered) {
    assistanceEntry.hidden = true;
    assistanceState.hidden = false;
    assistanceState.textContent = "Paw It Forward assistance approved for this booking.";
  } else {
    assistanceEntry.hidden = false;
    assistanceState.hidden = true;
  }

  $("[data-match-confirm-legal]").innerHTML = covered
    ? `Your Tími NOW fee is covered for this booking and the clinic will not be charged a Tími referral fee. You remain responsible for the clinic’s deposit and veterinary charges. <a href="#legal?section=fees">Service fee</a> · <a href="#legal?section=deposits">Deposits and refunds</a>`
    : `Tími NOW charges a platform fee for the connection; it is not a veterinary charge and is never billed to insurance. Payment processing is provided by Stripe. <a href="#legal?section=fees">Service fee</a> · <a href="#legal?section=deposits">Deposits and refunds</a>`;

  $("[data-match-confirm-submit]").textContent = chargedToday
    ? `Confirm and pay ${formatMoneyExact(chargedToday)}`
    : "Confirm this match";
}

/** The quick-choice row shared by every contribution surface. */
function renderContributionChoices(container, amounts, selected, name) {
  if (!container) return;
  container.innerHTML = [
    ...amounts.map((cents) => `<button class="pif-amount ${selected === cents ? "is-selected" : ""}" type="button" data-contribution-choice="${cents}" data-contribution-group="${name}" aria-pressed="${selected === cents}">${formatMoney(cents)}</button>`),
    `<button class="pif-amount ${selected === "custom" ? "is-selected" : ""}" type="button" data-contribution-choice="custom" data-contribution-group="${name}" aria-pressed="${selected === "custom"}">Custom</button>`
  ].join("");
}

/** Whole dollars only, and never below the configured minimum. */
function wholeDollarCents(value) {
  const dollars = Math.floor(Number(value));
  return Number.isFinite(dollars) && dollars > 0 ? dollars * 100 : 0;
}

function setBookingContribution(choice) {
  const pending = state.pendingMatch;
  if (!pending) return;
  pending.contributionChoice = choice;
  pending.contributionCents = choice === "custom" ? wholeDollarCents($("[data-booking-contribution-custom]")?.value) : Number(choice) || 0;
  renderMatchConfirmation();
  if (choice === "custom") $("[data-booking-contribution-custom]")?.focus();
}

async function confirmMatchSelection(event) {
  event.preventDefault();
  const pending = state.pendingMatch;
  if (!pending) return;
  const limits = fees();
  if (pending.contributionCents && pending.contributionCents < limits.minBookingContributionCents) {
    return showToast(`A contribution added to a booking starts at ${formatMoney(limits.minBookingContributionCents)}.`);
  }
  if (pending.contributionCents > limits.maxBookingContributionCents) {
    return showToast(`The largest contribution we can take here is ${formatMoney(limits.maxBookingContributionCents)}.`);
  }
  const button = $("[data-match-confirm-submit]");
  button.disabled = true;
  const label = button.textContent;
  button.textContent = "Confirming…";
  try {
    await selectCareOffer(pending.offerId, {
      contributionCents: pending.contributionCents,
      assistanceApplicationId: pending.assistance?.application?.id || null
    });
    if (pending.contributionCents) track("booking_contribution_added", { cents: pending.contributionCents });
    $("[data-match-confirm-dialog]").close();
    document.body.classList.remove("dialog-open");
    state.pendingMatch = null;
  } catch {
    button.disabled = false;
    button.textContent = label;
  }
}

async function selectCareOffer(offerId, checkout = {}) {
  const search = state.currentSearch;
  const offer = search?.offers?.find((candidate) => candidate.id === offerId);
  if (!search || !offer) return;
  const button = $(`[data-select-offer="${CSS.escape(offerId)}"]`);
  if (button) { button.disabled = true; button.textContent = "Confirming…"; }
  try {
    let data;
    if (search.demo || search.id.startsWith("demo_search_")) {
      const now = new Date().toISOString();
      data = {
        intake: {
          id: `demo_intake_${Date.now()}`,
          publicCode: search.publicCode,
          locationId: offer.locationId,
          tenantId: offer.tenantId,
          pet: search.pet,
          owner: search.owner,
          concernCategory: search.concernCategory,
          concernSummary: search.concernSummary,
          urgency: search.urgency,
          redFlags: search.redFlags,
          status: "accepted",
          clinicNote: offer.clinicNote,
          requestedAt: search.requestedAt,
          decisionAt: now,
          requestExpiresAt: offer.expiresAt,
          arrivalBy: offer.arrivalBy,
          policy: offer.policy,
          depositAmountCents: offer.depositAmountCents,
          paymentStatus: offer.depositAmountCents ? "pending" : "not_required",
          sourceSearchId: search.id,
          selectedOfferId: offer.id,
          demo: true
        },
        location: offer.location
      };
      state.currentSearch = { ...search, status: "selected", selectedOfferId: offer.id, selectedIntakeId: data.intake.id, offers: search.offers.map((item) => ({ ...item, status: item.id === offer.id ? "selected" : "released" })) };
    } else {
      data = await api(`/api/searches/${encodeURIComponent(search.id)}/select-offer`, {
        method: "POST",
        body: JSON.stringify({
          offerId,
          // The pre-confirmation screen was shown and pressed. Sent so the
          // server can refuse a selection that never passed through it.
          matchConfirmed: true,
          contributionCents: checkout.contributionCents || 0,
          assistanceApplicationId: checkout.assistanceApplicationId || null,
          legalVersion: state.config?.legalVersion || null
        })
      });
      state.currentSearch = data.search;
    }
    // Kept for the quiet continuity line on the confirmed booking only. The
    // alias never stands in for the clinic in a receipt or any transactional
    // message — those carry the real identity revealed below.
    const alias = state.pendingMatch?.offerId === offerId ? state.pendingMatch.alias : aliasForOffer(search.id, offer);
    state.currentIntake = {
      ...data.intake,
      location: data.location || offer.location,
      matchAlias: data.intake?.matchAlias || alias,
      contributionCents: checkout.contributionCents || data.intake?.contributionCents || 0
    };
    writeStorage(STORAGE_KEYS.search, state.currentSearch);
    writeStorage(STORAGE_KEYS.intake, state.currentIntake);
    track("offer_selected");
    showToast("Match confirmed. The clinic's details are below and the other offers were released.");
    renderTracker();
  } catch (error) {
    showToast(error.message);
    if (button) { button.disabled = false; button.textContent = "Select this match"; }
    throw error;
  }
}

async function cancelCareSearch() {
  const search = state.currentSearch;
  if (!search) return;
  try {
    if (search.demo || search.id.startsWith("demo_search_")) state.currentSearch = { ...search, status: "cancelled", offers: [] };
    else state.currentSearch = (await api(`/api/searches/${encodeURIComponent(search.id)}/status`, { method: "POST", body: JSON.stringify({ status: "cancelled" }) })).search;
    writeStorage(STORAGE_KEYS.search, state.currentSearch);
    renderCareSearch();
    showToast("The search was cancelled and clinic offers were released.");
  } catch (error) { showToast(error.message); }
}

function renderTracker() {
  const intake = state.currentIntake;
  if (!intake) return;
  $("[data-search-stage]").hidden = true;
  $("[data-confirmed-stage]").hidden = false;
  renderTrackerMap();
  const location = intake.location || state.locations.find((candidate) => candidate.id === intake.locationId) || {};
  // The reveal. Everything concealed while the customer was comparing —
  // real name, full address, phone, directions — appears here, together,
  // the moment the booking is confirmed.
  $("[data-tracker-hospital]").textContent = location.name || "Veterinary hospital";
  $("[data-tracker-address]").textContent = location.address || "Location available after confirmation";
  $("[data-tracker-initials]").textContent = initials(location.name || "Veterinary hospital");
  $("[data-tracker-phone]").href = `tel:${String(location.phone || "").replace(/[^0-9+]/g, "")}`;
  const phoneText = $("[data-tracker-phone-text]");
  if (phoneText) phoneText.textContent = location.phone || "";
  const directions = $("[data-tracker-directions]");
  if (directions) {
    const destination = location.latitude && location.longitude
      ? `${location.latitude},${location.longitude}`
      : `${location.name || ""} ${location.address || ""}`.trim();
    directions.href = destination ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}` : "#tracker";
    directions.target = "_blank";
    directions.hidden = !destination;
  }
  // A quiet continuity line, for this booking only, so somebody who chose
  // "Sequoia" ten seconds ago can see that this is the same match. The real
  // clinic identity above it is what every receipt and message uses.
  const continuity = $("[data-match-continuity]");
  const alias = aliasForIntake(intake);
  if (continuity) {
    continuity.hidden = !alias || !location.name;
    continuity.textContent = alias ? `Your “${alias}” match` : "";
  }
  renderBookingReceipt(intake, location);
  renderPostVisitContribution(intake);
  $("[data-request-time]").textContent = `Sent ${formatRelativeTime(intake.requestedAt)}`;
  const decision = $("[data-timeline-decision]");
  const arrival = $("[data-timeline-arrival]");
  const startTrip = $("[data-start-trip]");
  const feedback = $("[data-arrival-feedback]");
  const cancel = $("[data-cancel-intake]");
  startTrip.hidden = true; feedback.hidden = true; cancel.hidden = false;
  decision.classList.remove("complete"); arrival.classList.remove("complete");

  if (intake.status === "pending") {
    $("[data-tracker-eyebrow]").textContent = "REQUEST SENT";
    $("[data-tracker-title]").textContent = "Asking the veterinary team now.";
    $("[data-tracker-lede]").textContent = `This request expires at ${formatClock(intake.requestExpiresAt)} if the clinic cannot respond.`;
  } else if (["accepted", "en_route", "arrived", "triaged", "seen", "completed"].includes(intake.status)) {
    decision.classList.add("complete"); arrival.classList.add("complete");
    decision.querySelector("span").textContent = "✓"; decision.querySelector("small").textContent = "Clinic accepted the intake";
    arrival.querySelector("span").textContent = "✓"; arrival.querySelector("small").textContent = intake.arrivalBy ? `Please arrive by ${formatClock(intake.arrivalBy)}` : "Arrival window confirmed";
    $("[data-tracker-eyebrow]").textContent = intake.status === "accepted" ? "ACCEPTED" : humanize(intake.status);
    $("[data-tracker-title]").textContent = `${intake.pet?.name || "Your pet"} has a place to go.`;
    $("[data-tracker-lede]").textContent = intake.clinicNote || `Arrive by ${formatClock(intake.arrivalBy)}. Hospital staff will determine clinical priority on arrival.`;
    startTrip.hidden = !["accepted"].includes(intake.status);
    feedback.hidden = !["en_route", "arrived", "triaged", "seen"].includes(intake.status);
    cancel.hidden = ["arrived", "triaged", "seen", "completed"].includes(intake.status);
    maybePresentPayment(intake);
  } else {
    $("[data-tracker-eyebrow]").textContent = humanize(intake.status);
    $("[data-tracker-title]").textContent = intake.status === "declined" ? "This clinic cannot safely add another patient." : "This intake is no longer active.";
    $("[data-tracker-lede]").textContent = intake.status === "declined" ? "Return to the live results and Tími will help you try the next appropriate hospital." : "Search again to obtain a fresh capacity confirmation.";
    cancel.hidden = true;
  }
}

/**
 * The in-app receipt for a confirmed booking (§16).
 *
 * Named by the clinic's real identity, never by the alias, and honest about
 * who charges what: Tími's fee and any contribution are one charge from Tími
 * NOW, and the clinic's deposit is the clinic's own.
 */
function renderBookingReceipt(intake, location) {
  const panel = $("[data-booking-receipt]");
  if (!panel) return;
  const confirmed = !["pending", "declined", "cancelled", "expired"].includes(intake.status);
  panel.hidden = !confirmed;
  if (panel.hidden) return;
  const sponsored = Boolean(intake.sponsored || intake.sponsorshipId);
  const feeCents = sponsored ? 0 : (intake.ownerFeeCents ?? ownerFeeCents());
  const contributionCents = intake.contributionCents || 0;
  const depositCents = intake.depositAmountCents || 0;
  $("[data-booking-receipt-rows]").innerHTML = [
    `<div><dt>Tími NOW booking fee</dt><dd>${formatMoneyExact(feeCents)}${sponsored ? " <small>covered by Paw It Forward</small>" : ""}</dd></div>`,
    contributionCents ? `<div><dt>Paw It Forward contribution</dt><dd>${formatMoneyExact(contributionCents)}</dd></div>` : "",
    depositCents ? `<div><dt>Clinic deposit</dt><dd>${formatMoneyExact(depositCents)} <small>charged by ${escapeHtml(location.name || "the clinic")}${intake.paymentStatus === "paid" ? " · paid" : ""}</small></dd></div>` : "",
    `<div class="order-total"><dt>Charged by Tími NOW</dt><dd>${formatMoneyExact(feeCents + contributionCents)}</dd></div>`
  ].filter(Boolean).join("");
  $("[data-booking-receipt-note]").innerHTML = `${escapeHtml(location.name || "The clinic")} bills its own deposit and all veterinary charges${sponsored ? ", which remain your responsibility" : ""}. ${contributionCents ? "This contribution is not represented by TímiNOW as tax deductible. " : ""}Questions about a charge: <a href="mailto:billing@clearkey.solutions">billing@clearkey.solutions</a>.`;
}

function maybePresentPayment(intake) {
  const paymentButton = $("[data-pay-deposit]");
  const paymentNote = $("[data-payment-note]");
  if (!paymentButton || !paymentNote) return;
  const required = intake.policy?.depositRequired && intake.depositAmountCents > 0;
  paymentButton.hidden = !required || intake.paymentStatus === "paid";
  paymentButton.textContent = required ? `Pay ${formatMoney(intake.depositAmountCents)} deposit` : "";
  paymentNote.hidden = !required;
  paymentNote.textContent = intake.paymentStatus === "paid"
    ? "Deposit paid and credited to the clinic invoice."
    : `The clinic requires an arrival deposit before departure. ${serviceFeeSentence()}`;
}

/* ---------------------------------------------------------------------- */
/* Paw It Forward — assistance with the Tími NOW fee.                      */
/*                                                                         */
/* Branch first, then collect. The application asks what the applicant     */
/* would like to verify with, and then asks only for that pathway's        */
/* documents — nobody is made to hand over a tax return to prove a         */
/* termination notice. A refusal is a soft no in plain words, with the     */
/* ordinary paid path offered in the same breath, no error styling and no  */
/* implication that the person is lying.                                   */
/* ---------------------------------------------------------------------- */

/**
 * The four branches the customer chooses between, mapped to the engine's
 * pathway ids. Each branch names only the documents its own pathway needs:
 * once one passes, nothing further is collected.
 */
const ASSISTANCE_PATHWAYS = [
  {
    id: "MEANS_TESTED_BENEFIT",
    label: "A government benefit I currently receive",
    detail: "SNAP, TANF, SSI, a means-tested Medicaid category, or a housing-assistance award.",
    documents: [{ evidenceType: "BENEFIT_AWARD_LETTER", label: "Your current award letter or benefit statement" }]
  },
  {
    id: "RECENT_JOB_LOSS",
    label: "A recent job loss or unemployment benefit",
    detail: "A separation dated within the last 30 days, or a current unemployment determination.",
    documents: [{ evidenceType: "EMPLOYER_TERMINATION_NOTICE", label: "Your termination or separation notice, or your unemployment determination" }]
  },
  {
    id: "AREA_ADJUSTED_INCOME",
    label: "An income or tax document",
    detail: "An IRS return transcript, a payroll verification, or recent consecutive pay stubs.",
    documents: [{ evidenceType: "IRS_RETURN_TRANSCRIPT", label: "Your IRS return transcript, payroll verification, or three most recent consecutive pay stubs" }],
    household: true,
    geography: true
  },
  {
    id: "FINANCIAL_SHOCK",
    label: "An unexpected essential financial obligation",
    detail: "An unexpected essential cost in the last 30 days — medical or dental, an essential vehicle repair, an urgent home safety repair, a funeral, or a disaster loss.",
    documents: [
      { evidenceType: "ITEMIZED_INVOICE", label: "The itemized invoice or bill showing what the charge was for" },
      { evidenceType: "RECEIPT_ITEMIZED", label: "Proof it was paid, or a statement showing it is currently owed" }
    ],
    household: true
  }
];

function assistancePathways() {
  const supplied = state.assistance?.availability?.pathways;
  return Array.isArray(supplied) && supplied.length ? supplied : ASSISTANCE_PATHWAYS;
}

function assistanceBody() {
  return $("[data-assistance-body]");
}

function openAssistanceDialog() {
  const dialog = $("[data-assistance-dialog]");
  if (!dialog.open) { dialog.showModal(); document.body.classList.add("dialog-open"); }
}

/**
 * An approval already on file. Checked when the confirmation screen opens so
 * somebody approved five minutes ago is not asked to apply again — and so the
 * order summary quotes the covered fee rather than one that will not be
 * charged.
 */
async function refreshAssistanceGrant() {
  if (!state.config?.signInRequired) return;
  try {
    const data = await api("/api/hardship/eligibility");
    if (!data.eligible) return;
    state.assistance = { ...(state.assistance || {}), grant: data.grant, decision: { result: "APPROVED", expiresAt: data.grant?.expiresAt || null } };
    if (state.pendingMatch) {
      state.pendingMatch.assistance = state.assistance;
      renderMatchConfirmation();
    }
  } catch { /* no grant, or the service is unavailable: the standard fee stands */ }
}

async function startAssistance() {
  state.assistance = { availability: null, pathway: null, application: null, decision: null };
  $("[data-assistance-heading]").textContent = "Need help with the Tími NOW fee?";
  assistanceBody().innerHTML = '<p class="assistance-loading">Checking whether assistance is available right now…</p>';
  openAssistanceDialog();
  track("assistance_opened");
  try {
    const eligibility = await api("/api/hardship/eligibility");
    state.assistance.availability = { available: true, ...eligibility };
    if (eligibility.eligible) {
      state.assistance.decision = { result: "APPROVED", expiresAt: eligibility.grant?.expiresAt || null, visitsRemaining: eligibility.grant?.visitsRemaining };
      return renderAssistanceDecision();
    }
  } catch (error) {
    // No assistance service on this deployment, or it is down. Say so plainly
    // and ask for nothing — soliciting documents we cannot evaluate is worse
    // than saying no.
    state.assistance.availability = { available: false, reason: error.message };
    assistanceBody().innerHTML = `<p>Paw It Forward assistance is unavailable right now, so we can’t start an application.</p>
      <p class="assistance-note">Nothing was submitted and no documents are needed. Your booking can continue at the standard ${escapeHtml(formatMoney(ownerFeeCents()))} fee.</p>
      <button class="button button-primary" type="button" data-assistance-continue>Back to my booking</button>`;
    return;
  }
  renderAssistanceScope();
}

function renderAssistanceScope() {
  assistanceBody().innerHTML = `<p>Paw It Forward can cover the Tími NOW access fees for this booking — the ${escapeHtml(formatMoney(ownerFeeCents()))} you would pay and the referral fee the clinic would pay.</p>
    <p class="assistance-note">It does not cover the clinic’s deposit or your veterinary charges. Those stay with you, and the clinic sets them.</p>
    <p class="assistance-note">We ask for one kind of proof, and we stop as soon as it checks out. Your documents are never shown to a clinic.</p>
    <div class="assistance-actions"><button class="button button-primary" type="button" data-assistance-submit="scope">Start</button><button class="button button-quiet" type="button" data-assistance-continue>Not now</button></div>`;
}

function renderAssistancePathways() {
  state.assistance.pathway = null;
  assistanceBody().innerHTML = `<p class="assistance-question">What would you like to use to verify eligibility?</p>
    <div class="assistance-pathways">${assistancePathways().map((pathway) => `
      <button class="assistance-pathway" type="button" data-assistance-pathway="${escapeHtml(pathway.id)}">
        <strong>${escapeHtml(pathway.label)}</strong><small>${escapeHtml(pathway.detail || "")}</small>
      </button>`).join("")}</div>
    <p class="assistance-note">Pick one. We only ask for the documents that pathway needs.</p>`;
}

async function chooseAssistancePathway(pathwayId) {
  const pathway = assistancePathways().find((candidate) => candidate.id === pathwayId);
  if (!pathway) return;
  state.assistance.pathway = pathway;
  assistanceBody().innerHTML = '<p class="assistance-loading">Opening your application…</p>';
  try {
    const created = await api("/api/hardship/applications", {
      method: "POST",
      body: JSON.stringify({
        selectedPathway: pathway.id,
        intakeId: state.currentIntake?.id || undefined,
        termsVersion: state.config?.legalVersion || undefined,
        attestationVersion: state.config?.legalVersion || undefined
      })
    });
    state.assistance.application = created.application;
  } catch (error) {
    state.assistance.decision = { result: "NOT_VERIFIED", technical: true, message: error.message };
    return renderAssistanceDecision();
  }
  renderAssistanceIdentity();
}

/**
 * Identity, before documents.
 *
 * The rules will not verify anybody whose identity is unconfirmed, so asking
 * for a benefit letter first would mean collecting a sensitive document that
 * could never have decided anything. The session is embedded by design — see
 * src/hardship/providers.js; bouncing somebody with a sick animal to a
 * vendor's domain is where this flow loses the people it exists for.
 */
async function renderAssistanceIdentity() {
  const application = state.assistance?.application;
  if (!application) return renderAssistancePathways();
  if (application.identityVerified) return renderAssistanceEvidence();
  assistanceBody().innerHTML = '<p class="assistance-loading">Preparing identity verification…</p>';
  try {
    const { session } = await api(`/api/hardship/applications/${encodeURIComponent(application.id)}/identity-session`, {
      method: "POST",
      body: JSON.stringify({ mode: "EMBEDDED", returnUrl: `${location.origin}/#tracker` })
    });
    state.assistance.identitySession = session;
    assistanceBody().innerHTML = `<p class="assistance-question">First, confirm who you are</p>
      <p class="assistance-note">Assistance is one visit per household, so we verify a real, unique person before looking at any document. This checks identity only — never income, and no document image reaches this step.</p>
      <div id="assistance-identity-mount" class="assistance-identity" data-identity-session="${escapeHtml(session?.sessionId || "")}" data-identity-mode="${escapeHtml(session?.mode || "EMBEDDED")}"></div>
      ${session?.mode === "HOSTED" && session?.hostedUrl ? `<p><a class="button button-quiet" href="${escapeHtml(session.hostedUrl)}" target="_blank" rel="noopener">Open identity check</a></p>` : ""}
      <div class="assistance-actions"><button class="button button-primary" type="button" data-assistance-submit="identity">I’ve finished verifying</button><button class="button button-quiet" type="button" data-assistance-back>Choose something else</button></div>`;
  } catch (error) {
    state.assistance.decision = { result: "NOT_VERIFIED", technical: true, message: error.message };
    renderAssistanceDecision();
  }
}

function renderAssistanceEvidence() {
  const pathway = state.assistance?.pathway;
  if (!pathway) return renderAssistancePathways();
  const documents = pathway.documents || [];
  assistanceBody().innerHTML = `<p class="assistance-question">${escapeHtml(pathway.label)}</p>
    <p class="assistance-note">${escapeHtml(pathway.detail || "")}</p>
    <div class="assistance-uploads">${documents.map((document_, index) => `
      <label class="assistance-upload">${escapeHtml(document_.label)}
        <input type="file" accept="image/*,application/pdf" data-assistance-file="${index}" data-evidence-type="${escapeHtml(document_.evidenceType)}">
      </label>`).join("")}</div>
    ${pathway.household ? `<div class="assistance-household">
      <label>People in your household<input type="number" min="1" max="20" step="1" value="1" data-assistance-household></label>
      ${pathway.geography ? '<label>ZIP code<input type="text" inputmode="numeric" maxlength="10" data-assistance-zip></label>' : ""}
      <label class="inline-check"><input type="checkbox" data-assistance-attestation> I confirm every material source of household income is included.</label>
    </div>` : ""}
    <p class="assistance-note">Documents are used only to decide this application. A clinic is never shown them, and is never told why a booking is sponsored.</p>
    <div class="assistance-actions"><button class="button button-primary" type="button" data-assistance-submit="evidence">Check eligibility</button><button class="button button-quiet" type="button" data-assistance-back>Choose something else</button></div>`;
}

/** SHA-256 of the exact bytes, which is what the evidence record is keyed on. */
async function fileDigest(file) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Documents go to storage first and the application records the reference.
 * The upload URL is minted per file by the assistance service; the bytes
 * never pass through the application API.
 */
async function uploadAssistanceDocument(applicationId, input) {
  const file = input.files[0];
  const contentSha256 = await fileDigest(file);
  const ticket = await api(`/api/hardship/applications/${encodeURIComponent(applicationId)}/uploads`, {
    method: "POST",
    body: JSON.stringify({ evidenceType: input.dataset.evidenceType, mimeType: file.type || "application/octet-stream", byteSize: file.size, contentSha256 })
  });
  const upload = await fetch(ticket.uploadUrl, { method: ticket.method || "PUT", headers: ticket.headers || { "content-type": file.type || "application/octet-stream" }, body: file });
  if (!upload.ok) throw new Error("That document could not be uploaded. Please try again.");
  return api(`/api/hardship/applications/${encodeURIComponent(applicationId)}/evidence`, {
    method: "POST",
    body: JSON.stringify({
      evidenceType: input.dataset.evidenceType,
      storageBucket: ticket.bucket,
      storageObjectRef: ticket.objectRef,
      encryptionKeyId: ticket.encryptionKeyId || null,
      contentSha256,
      mimeType: file.type || null,
      byteSize: file.size
    })
  });
}

async function submitAssistanceApplication(stage) {
  const step = stage || document.activeElement?.dataset?.assistanceSubmit;
  if (step === "scope") return renderAssistancePathways();
  if (step === "identity") return renderAssistanceEvidence();
  const pathway = state.assistance?.pathway;
  if (!pathway) return renderAssistancePathways();
  const files = $$("[data-assistance-file]");
  if (files.some((input) => !input.files?.length)) return showToast("Add each document listed so we can check it.");
  const household = $("[data-assistance-household]")?.value;
  const postalCode = $("[data-assistance-zip]")?.value;
  const attested = $("[data-assistance-attestation]");
  if (pathway.household && attested && !attested.checked) return showToast("Confirm the household income statement to continue.");

  assistanceBody().innerHTML = '<p class="assistance-loading">Reading your documents and applying the eligibility rules…</p>';
  try {
    const application = state.assistance.application;
    if (!application) throw new Error("This application is no longer open.");
    for (const input of files) await uploadAssistanceDocument(application.id, input);
    const result = await api(`/api/hardship/applications/${encodeURIComponent(application.id)}/submit`, {
      method: "POST",
      body: JSON.stringify({
        householdSize: household ? Number(household) : undefined,
        householdAttested: Boolean(attested?.checked),
        geography: postalCode ? { areaId: postalCode } : undefined
      })
    });
    state.assistance.application = result.application || application;
    state.assistance.view = result.view || null;
    state.assistance.decision = { result: result.view?.status === "APPROVED" ? "APPROVED" : "NOT_VERIFIED", expiresAt: result.view?.expiresAt, visitsRemaining: result.view?.sponsoredVisitLimit, view: result.view };
  } catch (error) {
    // Anything that stops the check — an upload failure, a provider outage,
    // an application the service refused — lands on the same neutral outcome.
    // The applicant is never shown a reason code or a suspicion.
    state.assistance.decision = { result: "NOT_VERIFIED", technical: true, message: error.message };
  }
  renderAssistanceDecision();
}

function renderAssistanceDecision() {
  const decision = state.assistance?.decision || { result: "NOT_VERIFIED" };
  const view = decision.view || state.assistance?.view || null;
  const approved = decision.result === "APPROVED";
  track("assistance_decision", { result: approved ? "approved" : "not_verified" });
  if (approved) {
    if (state.pendingMatch) state.pendingMatch.assistance = state.assistance;
    $("[data-assistance-heading]").textContent = view?.title || "Paw It Forward assistance approved";
    assistanceBody().innerHTML = `<p>${escapeHtml(view?.message || `Your ${formatMoney(ownerFeeCents())} TímiNOW fee is covered for this booking, and the clinic will not be charged a TímiNOW referral fee. You remain responsible for the clinic's deposit and veterinary charges.`)}</p>
      ${decision.expiresAt ? `<p class="assistance-note">This approval applies to bookings confirmed before ${escapeHtml(new Intl.DateTimeFormat("en-US", { dateStyle: "long" }).format(new Date(timestampMs(decision.expiresAt))))}.</p>` : ""}
      ${Number.isFinite(decision.visitsRemaining) ? `<p class="assistance-note">Sponsored visits available: ${decision.visitsRemaining}.</p>` : ""}
      <button class="button button-primary" type="button" data-assistance-continue>Back to my booking</button>`;
    return;
  }
  // The exact program copy, served by the assistance service where it exists
  // and reproduced here where it does not. The fee inside it is built from the
  // live pricing policy: a hardcoded amount would quote a price the ledger no
  // longer charges. No red, no error styling, no implication of dishonesty —
  // and the ordinary paid path is offered in the same breath.
  const fee = formatMoney(ownerFeeCents());
  const message = view?.message
    || `TímiNOW could not independently verify your hardship at this time. This booking will require our standard ${fee} fee. We know this isn’t what you wanted to hear; if you feel we’ve made a mistake, email hardship@timinow.pet and we will have a human evaluate your case for future bookings.`;
  $("[data-assistance-heading]").textContent = view?.title || "We could not verify your hardship";
  assistanceBody().innerHTML = `<p class="assistance-soft-no">${escapeHtml(message).replace("hardship@timinow.pet", '<a href="mailto:hardship@timinow.pet">hardship@timinow.pet</a>')}</p>
    <div class="assistance-actions"><button class="button button-primary" type="button" data-assistance-continue>Pay ${escapeHtml(fee)} &amp; continue</button></div>
    <p class="assistance-note">Your saved payment method is used at confirmation. Nothing is charged until you press confirm on your booking.</p>`;
}

/* ---------------------------------------------------------------------- */
/* Paw It Forward — contributions.                                         */
/* ---------------------------------------------------------------------- */

const POST_VISIT_CHOICES = [200, 500, 1000, 2000];
const PORTAL_CHOICES = [1000, 2000, 3500, 7000, 10000];

/**
 * One contribution endpoint for both the portal and the after-visit card.
 *
 * The record is created first and paid second: the fund only ever posts money
 * Stripe has confirmed, so a draft contribution with no successful payment is
 * simply a draft, not a number in anybody's total.
 */
async function createContribution(payload) {
  const created = await api("/api/fund/contributions", { method: "POST", body: JSON.stringify({ consent: true, ...payload }) });
  const contribution = created.contribution || created;
  const payment = await api(`/api/fund/contributions/${encodeURIComponent(contribution.contributionId || contribution.id)}/payment`, { method: "POST" });
  return { contribution, ...payment };
}

function renderPostVisitContribution(intake) {
  const panel = $("[data-post-visit-contribution]");
  if (!panel) return;
  const finished = ["seen", "completed"].includes(intake.status);
  const alreadyGave = (intake.contributionCents || 0) > 0;
  const dismissed = Boolean(readStorage(STORAGE_KEYS.postVisitContribution, {})[intake.id]);
  panel.hidden = !finished || alreadyGave || dismissed;
  if (panel.hidden) return;
  renderContributionChoices($("[data-post-visit-amounts]"), POST_VISIT_CHOICES, state.postVisitContribution.choice, "post-visit-contribution");
  $("[data-post-visit-custom-field]").hidden = state.postVisitContribution.choice !== "custom";
  $("[data-post-visit-submit]").disabled = !state.postVisitContribution.cents;
  $("[data-post-visit-submit]").textContent = state.postVisitContribution.cents ? `Contribute ${formatMoney(state.postVisitContribution.cents)}` : "Contribute";
}

function setPostVisitContribution(choice) {
  state.postVisitContribution.choice = choice;
  state.postVisitContribution.cents = choice === "custom" ? wholeDollarCents($("[data-post-visit-custom]")?.value) : Number(choice) || 0;
  if (state.currentIntake) renderPostVisitContribution(state.currentIntake);
  if (choice === "custom") $("[data-post-visit-custom]")?.focus();
}

function dismissPostVisitContribution() {
  const intake = state.currentIntake;
  if (!intake) return;
  writeStorage(STORAGE_KEYS.postVisitContribution, { ...readStorage(STORAGE_KEYS.postVisitContribution, {}), [intake.id]: true });
  $("[data-post-visit-contribution]").hidden = true;
}

async function submitPostVisitContribution() {
  const intake = state.currentIntake;
  const amountCents = state.postVisitContribution.cents;
  if (!intake || !amountCents) return;
  const minimum = fees().minBookingContributionCents;
  if (amountCents < minimum) return showToast(`Contributions attached to a booking start at ${formatMoney(minimum)}.`);
  const button = $("[data-post-visit-submit]");
  button.disabled = true;
  try {
    const data = await createContribution({
      amountCents,
      source: "STANDALONE",
      intakeId: intake.id,
      receiptEmail: intake.owner?.email || undefined,
      recognition: "ANONYMOUS",
      termsVersion: state.config?.legalVersion || null
    });
    track("post_visit_contribution", { cents: amountCents });
    await presentContribution(data, { context: "post-visit", amountCents });
  } catch (error) {
    showToast(error.message);
    button.disabled = false;
  }
}

/**
 * A created contribution either needs a card or it does not: a demo
 * deployment and a wallet-completed Checkout both come back settled, and
 * only a Stripe client secret opens the payment dialog.
 */
async function presentContribution(data, options) {
  const { context, amountCents } = options;
  state.contribution = { ...data, ...options };
  if (!data?.clientSecret) {
    // No card needed: a demo deployment, or a contribution the service has
    // already settled. Anything else would have thrown before reaching here.
    completeContribution(data, options);
    return;
  }
  $("[data-contribution-summary]").textContent = `${formatMoney(amountCents)} to the Tími NOW Paw It Forward Fund.`;
  $("[data-contribution-submit]").textContent = `Pay ${formatMoney(amountCents)}`;
  $("[data-contribution-element]").replaceChildren();
  const dialog = $("[data-contribution-dialog]");
  dialog.showModal();
  document.body.classList.add("dialog-open");
  try {
    const Stripe = await loadStripe();
    if (!state.config?.stripePublishableKey) throw new Error("Payments are not configured on this deployment.");
    state.stripe = Stripe(state.config.stripePublishableKey);
    state.stripeElements = state.stripe.elements({ clientSecret: data.clientSecret, appearance: { theme: "stripe", variables: { colorPrimary: "#2357d9", borderRadius: "10px" } } });
    state.stripeElements.create("payment").mount("[data-contribution-element]");
  } catch (error) {
    showToast(error.message);
    dialog.close();
    document.body.classList.remove("dialog-open");
  }
}

async function confirmContributionPayment(event) {
  event.preventDefault();
  const button = $("[data-contribution-submit]");
  button.disabled = true;
  const label = button.textContent;
  button.textContent = "Processing…";
  try {
    if (!state.stripeElements) throw new Error("The payment form is not ready yet.");
    const result = await state.stripe.confirmPayment({ elements: state.stripeElements, confirmParams: { return_url: `${location.origin}/#paw-it-forward` }, redirect: "if_required" });
    if (result.error) throw new Error(result.error.message);
    $("[data-contribution-dialog]").close();
    document.body.classList.remove("dialog-open");
    completeContribution(state.contribution, state.contribution);
    track("contribution_paid", { cents: state.contribution?.amountCents || 0 });
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

function completeContribution(data, { context, amountCents }) {
  if (context === "post-visit") {
    const intake = state.currentIntake;
    if (intake) {
      state.currentIntake = { ...intake, contributionCents: (intake.contributionCents || 0) + amountCents };
      writeStorage(STORAGE_KEYS.intake, state.currentIntake);
      renderPostVisitContribution(state.currentIntake);
    }
    showToast("Thank you. Your contribution helps cover Tími NOW access for another pet owner.");
    return;
  }
  const contribution = data?.contribution || {};
  $("[data-pif-form]").hidden = true;
  const success = $("[data-pif-success]");
  success.hidden = false;
  $("[data-pif-success-amount]").textContent = formatMoneyExact(contribution.amountCents || amountCents);
  const receiptEmail = contribution.receiptEmail || state.contribution?.receiptEmail;
  $("[data-pif-success-receipt]").textContent = receiptEmail ? `Emailed to ${receiptEmail}` : "A receipt is on its way to the address you gave us.";
  const recognitionName = contribution.recognitionName || state.contribution?.recognitionName;
  $("[data-pif-success-recognition]").textContent = ({
    ANONYMOUS: "Anonymous — no public attribution",
    FIRST_NAME_LAST_INITIAL: recognitionName ? `Listed as ${recognitionName}` : "First name and last initial",
    ORGANIZATION: recognitionName ? `Listed as ${recognitionName}` : "Organization name"
  })[contribution.recognition || state.contribution?.recognition || "ANONYMOUS"];
  success.scrollIntoView({ block: "start" });
}

/* -------------------------------------------------- the public portal --- */

async function enterPawItForward() {
  const fee = fees();
  $("[data-pif-impact-explainer]").textContent =
    `Community contributions combine to cover Tími NOW access for pet owners experiencing verified financial hardship. ${formatMoney(fee.sponsorshipFundCents)} funds the community portion of one completed sponsored connection, and Tími NOW contributes the remaining ${formatMoney(fee.timiMatchCents)}.`;
  $("[data-pif-limits]").textContent = `Whole dollars only. Minimum ${formatMoney(fee.minStandaloneContributionCents)}, maximum ${formatMoney(fee.maxStandaloneContributionCents)}.`;
  const custom = $("[data-pif-custom]");
  if (custom) {
    custom.min = String(Math.ceil(fee.minStandaloneContributionCents / 100));
    custom.max = String(Math.floor(fee.maxStandaloneContributionCents / 100));
  }
  renderContributionChoices($("[data-pif-amounts]"), PORTAL_CHOICES, state.portalContribution.choice, "portal-contribution");
  await loadFundImpact();
}

/**
 * Impact totals are whatever the server chose to publish, rendered as they
 * arrive. The client computes nothing here: a reservation is not a visit,
 * and only the reconciliation that produced these numbers knows which is
 * which.
 */
async function loadFundImpact() {
  const mount = $("[data-pif-impact]");
  const note = $("[data-pif-impact-note]");
  try {
    const data = await api("/api/fund/impact");
    const impact = data.impact || data;
    const tiles = [
      Number.isFinite(impact.completedConnections) ? { label: "Completed sponsored connections", value: impact.completedConnections.toLocaleString("en-US") } : null,
      Number.isFinite(impact.communityDollarsConsumedCents) ? { label: "Community dollars used for completed connections", value: formatMoney(impact.communityDollarsConsumedCents) } : null,
      Number.isFinite(impact.timiMatchTotalCents) ? { label: "Tími NOW match value", value: formatMoney(impact.timiMatchTotalCents) } : null
    ].filter(Boolean);
    if (impact.explanation) $("[data-pif-impact-explainer]").textContent = impact.explanation;
    if (impact.published === false || !tiles.length) {
      mount.innerHTML = `<p class="microcopy">Totals are published once at least ${escapeHtml(String(impact.minimumConnections || 5))} completed connections have been reconciled — below that, a public number could identify the people it counts.</p>`;
      return;
    }
    mount.innerHTML = tiles.map((tile) => `<article><small>${escapeHtml(tile.label)}</small><strong>${escapeHtml(tile.value)}</strong></article>`).join("");
    if (impact.asOf) note.textContent = `Completed, reconciled connections only, as of ${new Intl.DateTimeFormat("en-US", { dateStyle: "long" }).format(new Date(timestampMs(impact.asOf)))}${impact.delayHours ? ` (published on a ${impact.delayHours}-hour delay)` : ""}. Reservations, pending bookings, and applications are never counted as visits funded.`;
  } catch {
    mount.innerHTML = '<p class="microcopy">Impact totals are unavailable right now. Contributions are unaffected.</p>';
  }
}

function setPortalContribution(choice) {
  state.portalContribution.choice = choice;
  state.portalContribution.cents = choice === "custom" ? wholeDollarCents($("[data-pif-custom]")?.value) : Number(choice) || 0;
  renderContributionChoices($("[data-pif-amounts]"), PORTAL_CHOICES, choice, "portal-contribution");
  $("[data-pif-custom-field]").hidden = choice !== "custom";
  if (choice === "custom") $("[data-pif-custom]")?.focus();
}

function resetPortalContribution() {
  state.portalContribution = { choice: null, cents: 0 };
  const form = $("[data-pif-form]");
  form.reset();
  form.hidden = false;
  $("[data-pif-success]").hidden = true;
  $("[data-pif-recognition-name]").hidden = true;
  $("[data-pif-custom-field]").hidden = true;
  renderContributionChoices($("[data-pif-amounts]"), PORTAL_CHOICES, null, "portal-contribution");
  form.scrollIntoView({ block: "start" });
}

async function submitPortalContribution(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const error = $("[data-pif-error]");
  const limits = fees();
  const amountCents = state.portalContribution.choice === "custom"
    ? wholeDollarCents(form.elements.customAmount.value)
    : state.portalContribution.cents;
  const email = form.elements.email.value.trim();
  const recognition = form.elements.recognition.value;
  const recognitionName = form.elements.recognitionName.value.trim();
  const fail = (message) => { error.hidden = false; error.textContent = message; };
  error.hidden = true;

  if (!amountCents) return fail("Choose an amount to contribute.");
  if (amountCents < limits.minStandaloneContributionCents) return fail(`Contributions here start at ${formatMoney(limits.minStandaloneContributionCents)}.`);
  if (amountCents > limits.maxStandaloneContributionCents) return fail(`For a contribution above ${formatMoney(limits.maxStandaloneContributionCents)}, email hello@timinow.pet and we will arrange it.`);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("Add an email address so we can send your receipt.");
  if (recognition !== "ANONYMOUS" && !recognitionName) return fail("Add the name you would like shown, or choose Anonymous.");
  if (!form.elements.consent.checked) return fail("Please accept the program terms to continue.");

  const button = form.querySelector("button[type='submit']");
  button.disabled = true;
  button.textContent = "Preparing payment…";
  try {
    const data = await createContribution({
      amountCents,
      source: "STANDALONE",
      receiptEmail: email,
      recognition,
      recognitionName: recognition === "ANONYMOUS" ? null : recognitionName,
      termsVersion: state.config?.legalVersion || null,
      consent: true
    });
    track("portal_contribution_started", { cents: amountCents });
    await presentContribution(data, { context: "portal", amountCents, receiptEmail: email, recognition, recognitionName });
  } catch (requestError) {
    fail(requestError.message);
  } finally {
    button.disabled = false;
    button.textContent = "Continue to secure payment";
  }
}

async function updateIntakeStatus(status) {
  if (!state.currentIntake?.id) return;
  if (state.currentIntake.demo || state.currentIntake.id.startsWith("demo_")) {
    state.currentIntake = { ...state.currentIntake, status, updatedAt: new Date().toISOString() };
    writeStorage(STORAGE_KEYS.intake, state.currentIntake);
    renderTracker();
    return;
  }
  try {
    const data = await api(`/api/intakes/${encodeURIComponent(state.currentIntake.id)}/status`, { method: "POST", body: JSON.stringify({ status }) });
    state.currentIntake = { ...state.currentIntake, ...data.intake };
    writeStorage(STORAGE_KEYS.intake, state.currentIntake);
    renderTracker();
  } catch (error) { showToast(error.message); }
}

async function recordObservation(milestone) {
  const intake = state.currentIntake;
  if (!intake) return;
  if (intake.demo || intake.id.startsWith("demo_")) {
    if (["arrived", "triaged", "seen"].includes(milestone)) {
      state.currentIntake = { ...intake, status: milestone, updatedAt: new Date().toISOString() };
      writeStorage(STORAGE_KEYS.intake, state.currentIntake);
      renderTracker();
    }
    showToast(`Thank you. ${humanize(milestone)} was recorded in this demo.`);
    return;
  }
  try {
    await api("/api/observations", { method: "POST", body: JSON.stringify({ intakeId: intake.id, locationId: intake.locationId, milestone }) });
    await refreshCurrentIntake();
    showToast(`Thank you. ${humanize(milestone)} was recorded.`);
  } catch (error) { showToast(error.message); }
}

async function startPayment() {
  const intake = state.currentIntake;
  if (!intake) return;
  const policy = intake.policy || {};
  const clinic = intake.location?.name || "the selected clinic";
  $("[data-payment-disclosure]").textContent = `${clinic} requires ${formatMoney(intake.depositAmountCents)}. The full amount is credited to its invoice. Free cancellation: ${policy.freeCancelMinutes ?? 0} minutes; later refund and no-show handling follow clinic policy ${policy.version || "current"}. ${serviceFeeSentence()}`;
  $("[data-payment-policy-ack]").textContent = `I authorize the ${formatMoney(intake.depositAmountCents)} deposit and agree to clinic policy ${policy.version || "current"}, including its cancellation, refund, and no-show terms.`;
  const form = $("[data-payment-form]");
  state.stripeElements = null;
  $("[data-payment-element]").replaceChildren();
  form.reset();
  form.querySelector("button[type='submit']").textContent = intake.demo || intake.id.startsWith("demo_") ? "Complete demo deposit" : "Continue to secure payment";
  const dialog = $("[data-payment-dialog]");
  dialog.showModal(); document.body.classList.add("dialog-open");
}

async function loadStripe() {
  if (window.Stripe) return window.Stripe;
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://js.stripe.com/v3";
    script.onload = resolve;
    script.onerror = reject;
    document.head.append(script);
  });
  return window.Stripe;
}

async function openStripePayment(clientSecret) {
  if (!state.config.stripePublishableKey) throw new Error("Stripe publishable key is not configured.");
  const Stripe = await loadStripe();
  state.stripe = Stripe(state.config.stripePublishableKey);
  state.stripeElements = state.stripe.elements({ clientSecret, appearance: { theme: "stripe", variables: { colorPrimary: "#2357d9", borderRadius: "10px" } } });
  const dialog = $("[data-payment-dialog]");
  if (!dialog.open) dialog.showModal();
  document.body.classList.add("dialog-open");
  const paymentElement = state.stripeElements.create("payment");
  paymentElement.mount("[data-payment-element]");
}

async function confirmStripePayment(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type='submit']");
  button.disabled = true; button.textContent = "Processing…";
  const intake = state.currentIntake;
  if (intake.demo || intake.id.startsWith("demo_")) {
    state.currentIntake = { ...intake, paymentStatus: "paid", paymentProviderId: `demo_payment_${Date.now()}`, updatedAt: new Date().toISOString() };
    writeStorage(STORAGE_KEYS.intake, state.currentIntake);
    $("[data-payment-dialog]").close(); document.body.classList.remove("dialog-open");
    renderTracker();
    button.disabled = false; button.textContent = "Complete demo deposit";
    track("deposit_paid", { mode: "demo" });
    return showToast("Demonstration deposit completed. No card was charged.");
  }
  if (!state.stripeElements) {
    try {
      const data = await api(`/api/intakes/${encodeURIComponent(intake.id)}/payment`, { method: "POST" });
      state.currentIntake = { ...state.currentIntake, ...data.intake };
      if (["none", "paid", "demo"].includes(data.mode)) {
        writeStorage(STORAGE_KEYS.intake, state.currentIntake); renderTracker(); $("[data-payment-dialog]").close();
        return showToast(data.mode === "demo" ? "Demonstration deposit completed." : "Deposit status updated.");
      }
      await openStripePayment(data.clientSecret);
      button.disabled = false; button.textContent = `Pay ${formatMoney(intake.depositAmountCents)} deposit`;
      return;
    } catch (error) { showToast(error.message); button.disabled = false; button.textContent = "Continue to secure payment"; return; }
  }
  const result = await state.stripe.confirmPayment({ elements: state.stripeElements, confirmParams: { return_url: `${location.origin}/#tracker` }, redirect: "if_required" });
  if (result.error) { showToast(result.error.message); button.disabled = false; button.textContent = "Pay deposit"; return; }
  track("deposit_paid", { mode: "stripe" });
  $("[data-payment-dialog]").close(); document.body.classList.remove("dialog-open");
  await api(`/api/intakes/${encodeURIComponent(state.currentIntake.id)}/payment-status`);
  await refreshCurrentIntake();
}

async function loadClinicDashboard() {
  try {
    const data = await api("/api/clinic/dashboard", { clinic: true });
    if (state.config?.database === "fixtures") {
      const availability = readStorage(STORAGE_KEYS.clinicAvailability, null);
      if (availability?.expiresAt && timestampMs(availability.expiresAt) > Date.now()) {
        data.location.availability = availability;
      }
      const decisions = readStorage(STORAGE_KEYS.clinicDecisions, {});
      data.requests = data.requests.map((request) => decisions[request.id] ? { ...request, ...decisions[request.id] } : request);
      data.metrics = clinicMetrics(data.requests);
    }
    renderClinicDashboard(data);
  } catch (error) {
    $("[data-request-list]").innerHTML = `<div class="empty-state"><strong>Clinic data could not be loaded.</strong><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function renderClinicDashboard(data) {
  state.clinicData = data;
  const { location, requests, metrics } = data;
  announceNewClinicRequests(requests);
  $("[data-clinic-name]").textContent = location.name;
  $("[data-clinic-status]").textContent = location.availability.label;
  $("[data-clinic-freshness]").textContent = `Confirmed ${formatRelativeTime(location.availability.reportedAt)} · expires ${formatClock(location.availability.expiresAt)}`;
  const signal = $("[data-clinic-signal]");
  signal.className = `large-signal ${location.availability.intakeStatus}`;
  const form = $("[data-availability-form]");
  const statusRadio = form.querySelector(`[name="intakeStatus"][value="${CSS.escape(location.availability.intakeStatus)}"]`);
  if (statusRadio) statusRadio.checked = true;
  if (location.availability.stableWaitMin !== null) form.elements.stableWaitMin.value = location.availability.stableWaitMin;
  if (location.availability.stableWaitMax !== null) form.elements.stableWaitMax.value = location.availability.stableWaitMax;
  if (location.availability.capacityCount !== null) form.elements.capacityCount.value = location.availability.capacityCount;
  form.elements.acceptsCritical.checked = location.availability.acceptsCritical;
  form.elements.note.value = location.availability.note || "";
  $("[data-metric-pending]").textContent = metrics.pending;
  $("[data-metric-active]").textContent = metrics.activeArrivals;
  $("[data-metric-completed]").textContent = metrics.completedToday;
  $("[data-metric-declined]").textContent = metrics.declinedToday;
  $("[data-request-count]").textContent = `${metrics.pending} request${metrics.pending === 1 ? "" : "s"}`;
  $("[data-ops-source]").textContent = humanize(location.availability.source);
  $("[data-ops-confidence]").textContent = humanize(location.availability.confidence);
  $("[data-ops-wait]").textContent = waitText(location);
  $("[data-ops-critical]").textContent = location.availability.acceptsCritical ? "Accepting" : "Not accepting";
  const policy = location.policy || {};
  $("[data-policy-deposit]").textContent = policy.depositRequired ? formatMoney(policy.depositAmountCents) : "None";
  $("[data-policy-cancel]").textContent = `${policy.freeCancelMinutes || 0} min`;
  $("[data-policy-completed]").textContent = formatMoney(policy.completedPlatformFeeCents);
  $("[data-policy-noshow]").textContent = formatMoney(policy.noShowPlatformFeeCents);
  renderClinicRequests(requests);
}

function clinicMetrics(requests) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    pending: requests.filter((item) => item.status === "pending").length,
    activeArrivals: requests.filter((item) => ["accepted", "en_route", "arrived", "triaged"].includes(item.status)).length,
    completedToday: requests.filter((item) => item.status === "completed" && item.updatedAt?.startsWith(today)).length,
    declinedToday: requests.filter((item) => item.status === "declined" && item.updatedAt?.startsWith(today)).length
  };
}

function announceNewClinicRequests(requests) {
  const pending = requests.filter((intake) => intake.status === "pending");
  if (state.clinicInitialized && "Notification" in window && Notification.permission === "granted") {
    pending.filter((intake) => !state.knownClinicRequests.has(intake.id)).forEach((intake) => {
      new Notification(`New ${humanize(intake.urgency)} intake for ${intake.pet.name}`, {
        body: intake.concernSummary,
        icon: "/assets/icons/icon.svg",
        tag: intake.id
      });
    });
  }
  pending.forEach((intake) => state.knownClinicRequests.add(intake.id));
  state.clinicInitialized = true;
}

async function enableClinicAlerts() {
  if (!("Notification" in window)) return showToast("This browser does not support desktop alerts.");
  const permission = await Notification.requestPermission();
  showToast(permission === "granted" ? "Clinic intake alerts are enabled." : "Notification permission was not granted.");
}

/**
 * What a clinic is told about a sponsored booking, and the whole of it.
 *
 * Three lines: that it is sponsored, that the referral fee is zero, and that
 * the patient still owes the clinic its deposit and charges. A clinic never
 * sees income, benefit type, documents, hardship reason, or the application —
 * so none of that is fetched, held, or rendered anywhere on this surface.
 */
function sponsoredNoticeHtml(intake) {
  if (!intake?.sponsored && intake?.sponsorship?.state !== "RESERVED" && !intake?.sponsorshipId) return "";
  return `<p class="sponsored-notice"><strong>Paw It Forward sponsored booking</strong><span>Tími NOW referral fee: $0</span><span>Patient remains responsible for your normal deposit and veterinary charges.</span></p>`;
}

function renderClinicRequests(requests) {
  const list = $("[data-request-list]");
  if (!requests.length) {
    list.innerHTML = '<div class="empty-state"><strong>No requests waiting.</strong><p>New requests appear here and can be accepted in one tap.</p></div>';
    return;
  }
  list.innerHTML = requests.slice(0, 12).map((intake) => `<article class="request-card"><span class="request-urgency">${escapeHtml(intake.urgency === "emergency" ? "ER" : "NOW")}</span><div><h3>${escapeHtml(intake.pet.name)} · ${escapeHtml(humanize(intake.species || intake.pet.species))}</h3>${sponsoredNoticeHtml(intake)}<p>${escapeHtml(intake.concernSummary)}</p><small>${escapeHtml(intake.owner.name)} · ${escapeHtml(intake.travelMinutes ? `${intake.travelMinutes} min away` : "travel time unknown")} · ${escapeHtml(intake.searchTarget ? "Multi-clinic search" : humanize(intake.status))}</small></div>${intake.status === "pending" ? `<button type="button" data-review-intake="${escapeHtml(intake.id)}" data-pet-name="${escapeHtml(intake.pet.name)}" data-search-target="${intake.searchTarget ? "true" : "false"}">Review</button>` : `<span class="hospital-kind">${escapeHtml(humanize(intake.status))}</span>`}</article>`).join("");
}

async function publishAvailability(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const button = form.querySelector("button[type='submit']");
  button.disabled = true; button.textContent = "Publishing…";
  try {
    const data = await api("/api/clinic/availability", { clinic: true, method: "POST", body: JSON.stringify({
      intakeStatus: values.get("intakeStatus"),
      stableWaitMin: Number(values.get("stableWaitMin")),
      stableWaitMax: Number(values.get("stableWaitMax")),
      capacityCount: Number(values.get("capacityCount")),
      ttlMinutes: Number(values.get("ttlMinutes")),
      acceptsCritical: values.get("acceptsCritical") === "on",
      note: values.get("note")
    }) });
    if (data.demo) writeStorage(STORAGE_KEYS.clinicAvailability, data.location.availability);
    showToast(data.demo ? "Demo capacity was published in this browser." : "Live capacity was published.");
    await loadClinicDashboard();
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; button.textContent = "Publish live status"; }
}

function openDecisionDialog(intakeId, petName, searchTarget = false) {
  const dialog = $("[data-decision-dialog]");
  const form = $("[data-decision-form]");
  form.reset();
  form.elements.intakeId.value = intakeId;
  form.elements.requestType.value = searchTarget ? "search" : "intake";
  $("[data-decision-title]").textContent = searchTarget ? `Offer availability for ${petName}` : `Accept ${petName}?`;
  $("[data-accept-decision-label]").textContent = searchTarget ? "Make an availability offer" : "Accept this arrival";
  syncDecisionFields();
  dialog.showModal(); document.body.classList.add("dialog-open");
}

function syncDecisionFields() {
  const form = $("[data-decision-form]");
  if (!form) return;
  const isSearch = form.elements.requestType.value === "search";
  const isAccept = form.elements.decision.value === "accept";
  $("[data-offer-fields]").hidden = !(isSearch && isAccept);
  form.elements.availableAt.required = isSearch && isAccept && form.elements.responseType.value === "available_at";
  const button = form.querySelector("button[type='submit']");
  button.textContent = isAccept ? (isSearch ? "Send availability offer" : "Accept arrival") : "Decline request";
}

async function submitDecision(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const intakeId = values.get("intakeId");
  const isSearch = values.get("requestType") === "search";
  const availableAtValue = values.get("availableAt");
  const availableAt = availableAtValue && Number.isFinite(Date.parse(availableAtValue)) ? new Date(availableAtValue).toISOString() : null;
  const button = form.querySelector("button[type='submit']");
  button.disabled = true; button.textContent = "Sending…";
  try {
    const endpoint = isSearch
      ? `/api/clinic/search-targets/${encodeURIComponent(intakeId)}/decision`
      : `/api/clinic/intakes/${encodeURIComponent(intakeId)}/decision`;
    const data = await api(endpoint, { clinic: true, method: "POST", body: JSON.stringify({
      decision: isSearch && values.get("decision") === "accept" ? "offer" : values.get("decision"),
      responseType: values.get("responseType"),
      availableAt,
      arrivalWindowMinutes: Number(values.get("arrivalWindowMinutes")),
      holdMinutes: Number(values.get("holdMinutes")),
      waitMin: Number(values.get("waitMin")),
      waitMax: Number(values.get("waitMax")),
      note: values.get("note")
    }) });
    if (data.demo) {
      const decisions = readStorage(STORAGE_KEYS.clinicDecisions, {});
      decisions[intakeId] = data.intake;
      writeStorage(STORAGE_KEYS.clinicDecisions, decisions);
    }
    $("[data-decision-dialog]").close(); document.body.classList.remove("dialog-open");
    showToast(isSearch && values.get("decision") === "accept" ? "Availability offer sent. The owner can compare it with other clinics." : "The pet owner was updated.");
    await loadClinicDashboard();
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; button.textContent = "Send decision"; }
}

document.addEventListener("click", (event) => {
  const routeButton = event.target.closest("[data-route]");
  if (routeButton) setRoute(routeButton.dataset.route);
  const locationButton = event.target.closest("[data-use-location]");
  if (locationButton) useLocation();
  const next = event.target.closest("[data-next-step]");
  if (next && validateStep(state.intakeStep)) { persistFormDraft(); state.intakeStep = Math.min(2, state.intakeStep + 1); renderIntakeStep(); }
  const previous = event.target.closest("[data-prev-step]");
  if (previous) { persistFormDraft(); state.intakeStep = Math.max(1, state.intakeStep - 1); renderIntakeStep(); }
  const refreshResults = event.target.closest("[data-refresh-results]");
  if (refreshResults) loadLocations();
  const startSearch = event.target.closest("[data-start-search]");
  if (startSearch) startCareSearch();
  const viewLocation = event.target.closest("[data-view-location]");
  if (viewLocation) openHospitalDialog(viewLocation.dataset.viewLocation, false);
  const requestLocation = event.target.closest("[data-request-location]");
  if (requestLocation) openHospitalDialog(requestLocation.dataset.requestLocation, true);
  const confirmRequest = event.target.closest("[data-confirm-request]");
  if (confirmRequest) submitIntake(confirmRequest.dataset.confirmRequest);
  const selectOffer = event.target.closest("[data-select-offer]");
  if (selectOffer) openMatchConfirmation(selectOffer.dataset.selectOffer);
  const aliasExplainer = event.target.closest("[data-alias-explainer]");
  if (aliasExplainer) {
    const panel = $("#alias-explainer");
    const open = panel.hidden;
    panel.hidden = !open;
    aliasExplainer.setAttribute("aria-expanded", String(open));
    if (open) track("alias_explainer_opened");
  }
  const contributionChoice = event.target.closest("[data-contribution-choice]");
  if (contributionChoice) {
    const raw = contributionChoice.dataset.contributionChoice;
    const choice = raw === "custom" ? "custom" : Number(raw);
    if (contributionChoice.dataset.contributionGroup === "booking-contribution") setBookingContribution(choice);
    if (contributionChoice.dataset.contributionGroup === "portal-contribution") setPortalContribution(choice);
    if (contributionChoice.dataset.contributionGroup === "post-visit-contribution") setPostVisitContribution(choice);
  }
  const openAssistance = event.target.closest("[data-open-assistance]");
  if (openAssistance) startAssistance();
  const assistancePathway = event.target.closest("[data-assistance-pathway]");
  if (assistancePathway) chooseAssistancePathway(assistancePathway.dataset.assistancePathway);
  const assistanceBack = event.target.closest("[data-assistance-back]");
  if (assistanceBack) renderAssistancePathways();
  const assistanceSubmit = event.target.closest("[data-assistance-submit]");
  if (assistanceSubmit) submitAssistanceApplication(assistanceSubmit.dataset.assistanceSubmit);
  const assistanceClose = event.target.closest("[data-assistance-continue]");
  if (assistanceClose) {
    $("[data-assistance-dialog]").close();
    renderMatchConfirmation();
  }
  const postVisitSubmit = event.target.closest("[data-post-visit-submit]");
  if (postVisitSubmit) submitPostVisitContribution();
  const postVisitDismiss = event.target.closest("[data-post-visit-dismiss]");
  if (postVisitDismiss) dismissPostVisitContribution();
  const pifReset = event.target.closest("[data-pif-reset]");
  if (pifReset) resetPortalContribution();
  const cancelSearch = event.target.closest("[data-cancel-search]");
  if (cancelSearch && confirm("Cancel this search and release every clinic offer?")) cancelCareSearch();
  const startTrip = event.target.closest("[data-start-trip]");
  if (startTrip) updateIntakeStatus("en_route");
  const cancel = event.target.closest("[data-cancel-intake]");
  if (cancel && confirm("Cancel this intake request?")) updateIntakeStatus("cancelled");
  const observation = event.target.closest("[data-observation]");
  if (observation) recordObservation(observation.dataset.observation);
  const pay = event.target.closest("[data-pay-deposit]");
  if (pay) startPayment();
  const refreshClinic = event.target.closest("[data-refresh-clinic]");
  if (refreshClinic) loadClinicDashboard();
  const enableAlerts = event.target.closest("[data-enable-alerts]");
  if (enableAlerts) enableClinicAlerts();
  const review = event.target.closest("[data-review-intake]");
  if (review) openDecisionDialog(review.dataset.reviewIntake, review.dataset.petName, review.dataset.searchTarget === "true");
  const closeDialog = event.target.closest("[data-close-dialog]");
  if (closeDialog) { closeDialog.closest("dialog")?.close(); document.body.classList.remove("dialog-open"); }
  const toastButton = event.target.closest("[data-toast-message]");
  if (toastButton) showToast(toastButton.dataset.toastMessage);

  const authBack = event.target.closest("[data-auth-back]");
  if (authBack) setAuthStep("identifier");
  const authToggleMode = event.target.closest("[data-auth-toggle-mode]");
  if (authToggleMode) {
    const currentStep = event.target.closest("[data-auth-step]")?.dataset.authStep;
    setAuthStep(currentStep === "sign-up" ? "identifier" : "sign-up");
  }
  const codeSubmit = event.target.closest("[data-auth-code-submit]");
  if (codeSubmit) submitCode();
  const resendButton = event.target.closest("[data-auth-resend]");
  if (resendButton && !resendButton.disabled) resendCode();
  const factorOption = event.target.closest("[data-factor-index]");
  if (factorOption) {
    const factor = state.auth?.factors?.[Number(factorOption.dataset.factorIndex)];
    if (factor) startFactor(factor);
  }
  const orgCard = event.target.closest("[data-org-index]");
  if (orgCard) selectOrganization(orgCard);
  const workspaceSwitch = event.target.closest("[data-workspace-switch]");
  if (workspaceSwitch) openOrgSwitcher();

  const accountToggle = event.target.closest("[data-account-toggle]");
  if (accountToggle) {
    const panel = accountToggle.nextElementSibling;
    const wasOpen = panel && !panel.hidden;
    closeAccountMenus();
    if (panel) { panel.hidden = wasOpen; accountToggle.setAttribute("aria-expanded", String(!wasOpen)); }
  } else if (!event.target.closest("[data-account-panel]")) {
    closeAccountMenus();
  }
  const switchWorkspaceItem = event.target.closest("[data-switch-workspace]");
  if (switchWorkspaceItem) openOrgSwitcher();
  const signOutItem = event.target.closest("[data-sign-out]");
  if (signOutItem) signOut();
});

async function selectOrganization(button) {
  const membership = state.auth?.memberships?.[Number(button.dataset.orgIndex)];
  if (!membership) return;
  button.disabled = true;
  try {
    await state.clerk.setActive({ organization: membership.organization.id });
    try { state.session = (await api("/api/session")).session; } catch { state.session = null; }
    finalizeRouting((state.auth && state.auth.pendingRoute) || "find");
  } catch (error) {
    showAuthError(error);
    button.disabled = false;
  }
}

$("[data-auth-identifier-form]")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const identifier = form.elements.identifier.value.trim();
  if (!identifier) return;
  setSubmitting(form, true, "Continue");
  try {
    const signIn = await state.clerk.client.signIn.create({ identifier });
    state.auth.signIn = signIn;
    state.auth.flowKind = "sign-in";
    await handleSignInResult(signIn);
  } catch (error) { showAuthError(error); }
  finally { setSubmitting(form, false, "Continue"); }
});

$("[data-auth-signup-form]")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const firstName = String(values.get("firstName") || "").trim();
  const lastName = String(values.get("lastName") || "").trim();
  const identifier = String(values.get("identifier") || "").trim();
  const isPhone = identifier.includes("@") === false && /^[+0-9()\-\s]{7,}$/.test(identifier);
  setSubmitting(form, true, "Create account");
  try {
    const payload = { firstName, lastName };
    if (isPhone) payload.phoneNumber = identifier; else payload.emailAddress = identifier;
    const signUp = await state.clerk.client.signUp.create(payload);
    state.auth.signUp = signUp;
    state.auth.flowKind = "sign-up";
    state.auth.signUpChannel = isPhone ? "phone" : "email";
    state.auth.signUpIdentifier = identifier;
    if (isPhone) await signUp.preparePhoneNumberVerification({ strategy: "phone_code" });
    else await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
    $("[data-auth-code-lede]").textContent = `Enter the 6-digit code sent to ${identifier}.`;
    clearOtpInputs();
    startResendCooldown();
    setAuthStep("code");
  } catch (error) { showAuthError(error); }
  finally { setSubmitting(form, false, "Create account"); }
});

$("[data-otp-input]")?.addEventListener("input", (event) => {
  const input = event.target;
  if (!input.matches("input")) return;
  input.value = input.value.replace(/\D/g, "").slice(-1);
  const inputs = otpInputs();
  const index = inputs.indexOf(input);
  if (input.value && index < inputs.length - 1) inputs[index + 1].focus();
  if (getOtpValue().length === 6) submitCode();
});

$("[data-otp-input]")?.addEventListener("keydown", (event) => {
  if (event.key !== "Backspace") return;
  const input = event.target;
  if (!input.matches("input")) return;
  const inputs = otpInputs();
  const index = inputs.indexOf(input);
  if (!input.value && index > 0) inputs[index - 1].focus();
});

$("[data-otp-input]")?.addEventListener("paste", (event) => {
  const text = (event.clipboardData || window.clipboardData).getData("text").replace(/\D/g, "").slice(0, 6);
  if (!text) return;
  event.preventDefault();
  const inputs = otpInputs();
  text.split("").forEach((digit, index) => { if (inputs[index]) inputs[index].value = digit; });
  inputs[Math.min(text.length, inputs.length - 1)]?.focus();
  if (text.length === 6) submitCode();
});

$("[data-intake-form]")?.addEventListener("change", (event) => {
  if (event.target.matches('[name="redFlag"], [name="urgency"]')) updateSafetyCallout();
  if (event.target.matches('[name="symptom"], [name="startedWhen"]')) updateConcernSpecificity();
});

$("[data-intake-form]")?.addEventListener("input", (event) => {
  if (event.target.matches('[name="concernSummary"]')) updateConcernSpecificity();
});

$("[data-intake-form]")?.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!validateStep(2)) return;
  persistFormDraft();
  setRoute("results");
});

$("[data-provider-form]")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const errorBox = $("[data-provider-error]");
  if (errorBox) errorBox.hidden = true;
  if (!form.reportValidity()) return;
  const values = new FormData(form);
  const payload = {
    practiceName: String(values.get("practiceName") || "").trim(),
    contactName: String(values.get("contactName") || "").trim(),
    email: String(values.get("email") || "").trim(),
    phone: String(values.get("phone") || "").trim(),
    city: String(values.get("city") || "").trim(),
    state: String(values.get("state") || "").trim()
  };
  const species = String(values.get("species") || "").trim();
  const message = String(values.get("message") || "").trim();
  if (species) payload.species = species;
  if (message) payload.message = message;
  const button = form.querySelector("button[type='submit']");
  const buttonHtml = button.innerHTML;
  button.disabled = true;
  button.textContent = "Sending…";
  try {
    await api("/api/provider-applications", { method: "POST", body: JSON.stringify(payload) });
    track("provider_application_submitted");
    form.hidden = true;
    const success = $("[data-provider-success]");
    if (success) { success.hidden = false; success.scrollIntoView({ block: "nearest" }); }
  } catch (error) {
    if (errorBox) {
      errorBox.textContent = error.message || "The request could not be sent. Please check the form and try again.";
      errorBox.hidden = false;
    }
    button.disabled = false;
    button.innerHTML = buttonHtml;
  }
});

$("[data-sort-results]")?.addEventListener("change", renderLocations);
$("[data-availability-form]")?.addEventListener("submit", publishAvailability);
$("[data-decision-form]")?.addEventListener("submit", submitDecision);
$("[data-match-confirm-form]")?.addEventListener("submit", confirmMatchSelection);
$("[data-assistance-form]")?.addEventListener("submit", (event) => event.preventDefault());
$("[data-contribution-form]")?.addEventListener("submit", confirmContributionPayment);
$("[data-pif-form]")?.addEventListener("submit", submitPortalContribution);
$("[data-booking-contribution-toggle]")?.addEventListener("change", (event) => {
  $("[data-booking-contribution-body]").hidden = !event.target.checked;
  if (!event.target.checked && state.pendingMatch) {
    state.pendingMatch.contributionChoice = null;
    state.pendingMatch.contributionCents = 0;
  }
  renderMatchConfirmation();
});
$("[data-booking-contribution-custom]")?.addEventListener("input", () => {
  if (state.pendingMatch?.contributionChoice === "custom") {
    state.pendingMatch.contributionCents = wholeDollarCents($("[data-booking-contribution-custom]").value);
    renderMatchConfirmation();
    $("[data-booking-contribution-custom]").focus();
  }
});
$("[data-post-visit-custom]")?.addEventListener("input", (event) => {
  if (state.postVisitContribution.choice !== "custom") return;
  state.postVisitContribution.cents = wholeDollarCents(event.target.value);
  const submit = $("[data-post-visit-submit]");
  submit.disabled = !state.postVisitContribution.cents;
  submit.textContent = state.postVisitContribution.cents ? `Contribute ${formatMoney(state.postVisitContribution.cents)}` : "Contribute";
});
$("[data-pif-custom]")?.addEventListener("input", (event) => {
  if (state.portalContribution.choice === "custom") state.portalContribution.cents = wholeDollarCents(event.target.value);
});
$("[data-pif-form]")?.addEventListener("change", (event) => {
  if (event.target.name !== "recognition") return;
  $("[data-pif-recognition-name]").hidden = event.target.value === "ANONYMOUS";
});

$("[data-decision-form]")?.addEventListener("change", (event) => {
  if (event.target.matches('[name="decision"], [name="responseType"]')) syncDecisionFields();
});
$("[data-payment-form]")?.addEventListener("submit", confirmStripePayment);

$$('dialog').forEach((dialog) => {
  dialog.addEventListener("close", () => document.body.classList.remove("dialog-open"));
  dialog.addEventListener("click", (event) => {
    const rectangle = dialog.getBoundingClientRect();
    if (event.clientX < rectangle.left || event.clientX > rectangle.right || event.clientY < rectangle.top || event.clientY > rectangle.bottom) dialog.close();
  });
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault(); state.deferredInstall = event; $("[data-install]").hidden = false;
});
$("[data-install]")?.addEventListener("click", async () => {
  if (!state.deferredInstall) return;
  state.deferredInstall.prompt(); await state.deferredInstall.userChoice; state.deferredInstall = null; $("[data-install]").hidden = true;
});

window.addEventListener("hashchange", () => { if (state.route === "find") persistFormDraft(); renderRoute(); });
window.addEventListener("load", async () => {
  try {
    await loadConfig();
    await renderRoute();
  } finally {
    hideBootSplash();
  }
});

if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));

/* ============================== map and navigation ============================== */

/**
 * The map is optional infrastructure: when no Mapbox token is configured the
 * panels stay hidden and every existing text-based flow still works.
 */
function mapPanel(selector) {
  const panel = $(selector);
  if (!panel) return null;
  if (!mapAvailable()) {
    panel.hidden = true;
    return null;
  }
  panel.hidden = false;
  return panel;
}

async function renderResultsMap() {
  const panel = mapPanel("[data-results-map-panel]");
  if (!panel) return;
  const container = $("[data-results-map]", panel);
  const clinics = sortLocations(state.locations).slice(0, 30);
  if (!clinics.length) {
    panel.hidden = true;
    return;
  }
  try {
    state.resultsMap?.destroy();
    state.resultsMap = await renderClinicMap(container, {
      origin: state.intakeDraft.position,
      clinics,
      onSelect: (clinic) => openHospitalDialog(clinic.id)
    });
  } catch (error) {
    panel.hidden = true;
    console.warn("Map unavailable", error.message);
  }
}

async function renderTrackerMap() {
  const panel = mapPanel("[data-tracker-map-panel]");
  if (!panel) return;
  const intake = state.currentIntake;
  const location = intake?.location || state.locations.find((candidate) => candidate.id === intake?.locationId);
  if (!location || !Number.isFinite(location.latitude)) {
    panel.hidden = true;
    return;
  }
  const origin = state.intakeDraft.position;
  try {
    state.trackerMap?.destroy();
    state.trackerMap = await renderClinicMap($("[data-tracker-map]", panel), {
      origin,
      clinics: [location]
    });
    await refreshRoute(origin, location);
  } catch (error) {
    panel.hidden = true;
    console.warn("Tracker map unavailable", error.message);
  }
}

async function refreshRoute(origin, location) {
  if (!state.trackerMap || !origin) return;
  try {
    const route = await fetchRoute(origin, location, { preferences: state.navigationPreferences });
    state.activeRoute = { ...route, clinic: location };
    drawRoute(state.trackerMap.map, route);
    const summary = $("[data-route-summary]");
    if (summary) {
      summary.hidden = false;
      $("[data-route-eta]", summary).textContent = `${formatDuration(route.durationSeconds)} away`;
      $("[data-route-distance]", summary).textContent =
        `${formatDistance(route.distanceMeters, state.navigationPreferences.units)} · ${location.name}`;
    }
    state.trackerMap.map.fitBounds(routeBounds(route), { padding: 48, duration: 0 });
  } catch (error) {
    console.warn("Route unavailable", error.message);
  }
}

function routeBounds(route) {
  const coordinates = route.geometry?.coordinates || [];
  return coordinates.reduce(
    (bounds, point) => [
      [Math.min(bounds[0][0], point[0]), Math.min(bounds[0][1], point[1])],
      [Math.max(bounds[1][0], point[0]), Math.max(bounds[1][1], point[1])]
    ],
    [[180, 90], [-180, -90]]
  );
}

/**
 * Which speaking register the current trip is in. Derived from the intake's
 * urgency rather than a setting, so a driver never has to think about it: the
 * playful lines simply do not exist on an emergency run.
 */
function navigationTone() {
  return toneFor(state.currentIntake?.urgency || state.intakeDraft?.urgency || "same_day");
}

function persistNavigationPreferences() {
  writeStorage(STORAGE_KEYS.navigation, state.navigationPreferences);
}

function populateVoicePicker() {
  const picker = $("[data-navigation-voice-picker]");
  if (!picker || !VoiceGuide.supported()) return;
  const voices = VoiceGuide.voices(navigator.language || "en");
  if (!voices.length) return;
  picker.innerHTML = voices
    .map((voice) => `<option value="${escapeHtml(voice.voiceURI)}">${escapeHtml(voice.name)}${voice.local ? "" : " (network)"}</option>`)
    .join("");
  if (state.navigationPreferences.voiceURI) picker.value = state.navigationPreferences.voiceURI;
}

function startNavigation() {
  const route = state.activeRoute;
  if (!route) return;
  const panel = $("[data-navigation-panel]");
  if (!panel) return;
  panel.hidden = false;
  state.navigationActive = true;
  state.voiceGuide = new VoiceGuide({
    enabled: state.navigationPreferences.voiceEnabled,
    rate: state.navigationPreferences.rate,
    voiceURI: state.navigationPreferences.voiceURI,
    tone: navigationTone()
  });
  populateVoicePicker();
  renderNavigationSteps(route);

  const pet = state.currentIntake?.pet?.name || "your pet";
  state.voiceGuide.say(
    announcement("start", { tone: navigationTone(), clinic: route.clinic.name, pet }),
    { force: true }
  );

  if (navigator.geolocation) {
    state.navigationWatchId = navigator.geolocation.watchPosition(
      (position) => advanceNavigation(position.coords),
      () => {},
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
    );
  }
  updateIntakeStatus("en_route").catch(() => {});
}

function renderNavigationSteps(route) {
  const list = $("[data-navigation-steps]");
  if (!list) return;
  list.innerHTML = route.steps
    .map((step) => `<li><strong>${escapeHtml(phraseInstruction(step, { clinic: route.clinic.name }))}</strong>` +
      `<small>${escapeHtml(formatDistance(step.distanceMeters, state.navigationPreferences.units))}</small></li>`)
    .join("");
  const first = route.steps[0];
  if (first) {
    $("[data-navigation-instruction]").textContent = phraseInstruction(first, { clinic: route.clinic.name });
    $("[data-navigation-distance]").textContent = formatDistance(first.distanceMeters, state.navigationPreferences.units);
    $("[data-maneuver-glyph]").textContent = maneuverGlyph(first);
  }
}

function maneuverGlyph(step) {
  const modifier = String(step.modifier || "").toLowerCase();
  if (step.type === "arrive") return "◎";
  if (modifier.includes("left")) return modifier.includes("slight") ? "↰" : "←";
  if (modifier.includes("right")) return modifier.includes("slight") ? "↱" : "→";
  if (modifier.includes("uturn")) return "↺";
  return "↑";
}

/**
 * Advance the banner as the driver moves. Deliberately simple: the browser has
 * no map-matching engine, so this snaps to the nearest upcoming maneuver rather
 * than pretending to do full route-following. The native clients use Mapbox's
 * real navigator for that.
 */
function advanceNavigation(coordinates) {
  const route = state.activeRoute;
  if (!route || !state.navigationActive) return;
  const remaining = route.steps.filter((step) => step.location);
  if (!remaining.length) return;

  let closest = remaining[0];
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const step of remaining) {
    const distance = haversineMeters(coordinates.latitude, coordinates.longitude, step.location[1], step.location[0]);
    if (distance < closestDistance) {
      closestDistance = distance;
      closest = step;
    }
  }

  const clinic = route.clinic.name;
  $("[data-navigation-instruction]").textContent = phraseInstruction(closest, { clinic });
  $("[data-navigation-distance]").textContent = formatDistance(closestDistance, state.navigationPreferences.units);
  $("[data-maneuver-glyph]").textContent = maneuverGlyph(closest);

  if (closestDistance < 220) {
    state.voiceGuide?.say(phraseInstruction(closest, { clinic }));
  }

  const toClinic = haversineMeters(coordinates.latitude, coordinates.longitude, route.clinic.latitude, route.clinic.longitude);
  if (toClinic < 900) {
    state.voiceGuide?.say(announcement("approaching", {
      tone: navigationTone(),
      clinic,
      pet: state.currentIntake?.pet?.name,
      kind: humanize(route.clinic.kind || "main")
    }));
  }
  if (toClinic < 120) {
    state.voiceGuide?.say(
      announcement("arrival", {
        tone: navigationTone(),
        clinic,
        pet: state.currentIntake?.pet?.name
      }),
      { force: true }
    );
    endNavigation();
    recordObservation("arrived").catch(() => {});
  }
}

function endNavigation() {
  state.navigationActive = false;
  state.voiceGuide?.stop();
  state.voiceGuide = null;
  if (state.navigationWatchId !== null && navigator.geolocation) {
    navigator.geolocation.clearWatch(state.navigationWatchId);
    state.navigationWatchId = null;
  }
  const panel = $("[data-navigation-panel]");
  if (panel) panel.hidden = true;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const earthRadius = 6371000;
  const latitudeDelta = toRadians(lat2 - lat1);
  const longitudeDelta = toRadians(lon2 - lon1);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.sqrt(a));
}

$("[data-start-navigation]")?.addEventListener("click", startNavigation);
$("[data-end-navigation]")?.addEventListener("click", endNavigation);
$("[data-navigation-voice]")?.addEventListener("change", (event) => {
  state.navigationPreferences.voiceEnabled = event.target.checked;
  if (state.voiceGuide) state.voiceGuide.preferences.enabled = event.target.checked;
  persistNavigationPreferences();
});
$("[data-navigation-voice-picker]")?.addEventListener("change", (event) => {
  state.navigationPreferences.voiceURI = event.target.value;
  if (state.voiceGuide) state.voiceGuide.preferences.voiceURI = event.target.value;
  persistNavigationPreferences();
});
$("[data-navigation-rate]")?.addEventListener("input", (event) => {
  state.navigationPreferences.rate = Number(event.target.value);
  if (state.voiceGuide) state.voiceGuide.preferences.rate = state.navigationPreferences.rate;
  persistNavigationPreferences();
});
$("[data-navigation-units]")?.addEventListener("change", (event) => {
  state.navigationPreferences.units = event.target.value;
  persistNavigationPreferences();
  if (state.activeRoute) renderNavigationSteps(state.activeRoute);
});
$$("[data-navigation-avoid]").forEach((input) => {
  const key = `avoid${input.dataset.navigationAvoid.charAt(0).toUpperCase()}${input.dataset.navigationAvoid.slice(1)}`;
  input.checked = Boolean(state.navigationPreferences[key]);
  input.addEventListener("change", () => {
    state.navigationPreferences[key] = input.checked;
    persistNavigationPreferences();
    const intake = state.currentIntake;
    const location = intake?.location || state.locations.find((candidate) => candidate.id === intake?.locationId);
    if (location) refreshRoute(state.intakeDraft.position, location);
  });
});
if (VoiceGuide.supported()) speechSynthesis.addEventListener?.("voiceschanged", populateVoicePicker);

/**
 * Tear down any live map before a route change. WebGL contexts are a limited
 * browser resource, so leaving them attached to hidden screens eventually
 * refuses to create new ones.
 */
function releaseMaps() {
  if (state.navigationActive) endNavigation();
  state.resultsMap?.destroy();
  state.resultsMap = null;
  state.trackerMap?.destroy();
  state.trackerMap = null;
  state.activeRoute = null;
  const summary = $("[data-route-summary]");
  if (summary) summary.hidden = true;
}
