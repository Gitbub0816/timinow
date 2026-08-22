/**
 * Tími NOW map and navigation module.
 *
 * Self-contained so it can be wired into any surface without touching that
 * surface's application code. Everything renders in the Tími production style;
 * turn-by-turn guidance reuses the same style so the navigation view and the
 * clinic map never look like two different products.
 *
 * The Mapbox library is loaded on demand — a customer who never opens the map
 * never pays for the download.
 */

const GL_VERSION = "v3.15.0";
const GL_SCRIPT = `https://api.mapbox.com/mapbox-gl-js/${GL_VERSION}/mapbox-gl.js`;
const GL_STYLESHEET = `https://api.mapbox.com/mapbox-gl-js/${GL_VERSION}/mapbox-gl.css`;
const DIRECTIONS_ENDPOINT = "https://api.mapbox.com/directions/v5/mapbox";

const TOKENS = {
  ink: "#111B3B",
  blue: "#2357D9",
  coral: "#F25F4C",
  gold: "#F7C84B",
  paper: "#FFFAF0",
  muted: "#6F7483"
};

let libraryPromise = null;
let mapConfig = { token: null, styleUrl: null, navigationStyleUrl: null };

/** Called once with the `map` block from `GET /api/config`. */
export function configureMap(config) {
  mapConfig = {
    token: config?.token || null,
    styleUrl: config?.styleUrl || null,
    navigationStyleUrl: config?.navigationStyleUrl || config?.styleUrl || null
  };
  return mapConfig;
}

export function mapAvailable() {
  return Boolean(mapConfig.token && mapConfig.styleUrl);
}

/**
 * Load Mapbox GL JS once. Resolves to the global `mapboxgl` with the access
 * token already applied.
 */
export function loadMapbox() {
  if (!mapAvailable()) return Promise.reject(new Error("MAP_NOT_CONFIGURED"));
  if (libraryPromise) return libraryPromise;

  libraryPromise = new Promise((resolve, reject) => {
    if (!document.querySelector(`link[data-mapbox-css]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = GL_STYLESHEET;
      link.dataset.mapboxCss = "true";
      document.head.appendChild(link);
    }
    if (globalThis.mapboxgl) {
      globalThis.mapboxgl.accessToken = mapConfig.token;
      resolve(globalThis.mapboxgl);
      return;
    }
    const script = document.createElement("script");
    script.src = GL_SCRIPT;
    script.async = true;
    script.onload = () => {
      if (!globalThis.mapboxgl) {
        reject(new Error("Mapbox GL failed to initialize"));
        return;
      }
      globalThis.mapboxgl.accessToken = mapConfig.token;
      resolve(globalThis.mapboxgl);
    };
    script.onerror = () => reject(new Error("Mapbox GL could not be downloaded"));
    document.head.appendChild(script);
  }).catch((error) => {
    libraryPromise = null;
    throw error;
  });

  return libraryPromise;
}

function markerElement({ label, tone = "blue", title }) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = `map-pin map-pin-${tone}`;
  element.setAttribute("aria-label", title || String(label));
  element.textContent = String(label);
  return element;
}

/**
 * Render clinic pins with the customer's position. Returns a small handle so the
 * caller can refit, highlight a clinic, or tear the map down.
 */
export async function renderClinicMap(container, { origin, clinics = [], onSelect, interactive = true } = {}) {
  const mapboxgl = await loadMapbox();
  container.innerHTML = "";

  const map = new mapboxgl.Map({
    container,
    style: mapConfig.styleUrl,
    center: [origin?.longitude ?? -122.0808, origin?.latitude ?? 37.6688],
    zoom: 11,
    attributionControl: true,
    interactive,
    cooperativeGestures: true
  });
  map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");

  const markers = new Map();

  if (origin) {
    new mapboxgl.Marker({ element: markerElement({ label: "•", tone: "ink", title: "Your location" }) })
      .setLngLat([origin.longitude, origin.latitude])
      .addTo(map);
  }

  clinics.forEach((clinic, index) => {
    if (!Number.isFinite(clinic.longitude) || !Number.isFinite(clinic.latitude)) return;
    const tone = clinic.availability?.intakeStatus === "available" ? "blue"
      : ["limited", "confirm_first"].includes(clinic.availability?.intakeStatus) ? "gold"
        : "coral";
    const element = markerElement({ label: index + 1, tone, title: clinic.name });
    element.addEventListener("click", () => onSelect?.(clinic));
    const marker = new mapboxgl.Marker({ element })
      .setLngLat([clinic.longitude, clinic.latitude])
      .setPopup(new mapboxgl.Popup({ offset: 18, closeButton: false }).setHTML(
        `<strong>${escapeHtml(clinic.name)}</strong><br><span>${escapeHtml(clinic.availability?.label || "")}</span>`
      ))
      .addTo(map);
    markers.set(clinic.id, marker);
  });

  const fit = () => {
    const points = clinics
      .filter((clinic) => Number.isFinite(clinic.longitude) && Number.isFinite(clinic.latitude))
      .map((clinic) => [clinic.longitude, clinic.latitude]);
    if (origin) points.push([origin.longitude, origin.latitude]);
    if (points.length < 2) return;
    const bounds = points.reduce(
      (accumulator, point) => accumulator.extend(point),
      new mapboxgl.LngLatBounds(points[0], points[0])
    );
    map.fitBounds(bounds, { padding: 56, maxZoom: 14, duration: 0 });
  };

  map.on("load", fit);

  return {
    map,
    fit,
    highlight(clinicId) {
      markers.forEach((marker, id) => {
        marker.getElement().classList.toggle("is-active", id === clinicId);
      });
      const marker = markers.get(clinicId);
      if (marker) map.easeTo({ center: marker.getLngLat(), zoom: 13 });
    },
    destroy() {
      markers.clear();
      map.remove();
    }
  };
}

/**
 * Fetch a driving route. `profile` is `driving-traffic` by default so the ETA
 * reflects conditions on the way to an emergency.
 */
export async function fetchRoute(origin, destination, { profile = "driving-traffic", preferences = {} } = {}) {
  if (!mapConfig.token) throw new Error("MAP_NOT_CONFIGURED");
  const coordinates = `${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}`;
  const url = new URL(`${DIRECTIONS_ENDPOINT}/${profile}/${coordinates}`);
  url.searchParams.set("access_token", mapConfig.token);
  url.searchParams.set("geometries", "geojson");
  url.searchParams.set("overview", "full");
  url.searchParams.set("steps", "true");
  url.searchParams.set("banner_instructions", "true");
  url.searchParams.set("voice_instructions", "true");
  url.searchParams.set("voice_units", preferences.units === "metric" ? "metric" : "imperial");
  url.searchParams.set("annotations", "duration,distance,congestion");

  const avoid = [];
  if (preferences.avoidTolls) avoid.push("toll");
  if (preferences.avoidHighways) avoid.push("motorway");
  if (preferences.avoidFerries) avoid.push("ferry");
  if (avoid.length) url.searchParams.set("exclude", avoid.join(","));

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Directions request failed (${response.status})`);
  const body = await response.json();
  const route = body.routes?.[0];
  if (!route) throw new Error("No driving route to that hospital was found.");

  return {
    geometry: route.geometry,
    distanceMeters: route.distance,
    durationSeconds: route.duration,
    durationTypicalSeconds: route.duration_typical ?? route.duration,
    steps: (route.legs?.[0]?.steps || []).map((step) => ({
      instruction: step.maneuver?.instruction || "",
      type: step.maneuver?.type || "",
      modifier: step.maneuver?.modifier || "",
      distanceMeters: step.distance,
      durationSeconds: step.duration,
      location: step.maneuver?.location || null,
      voiceInstructions: step.voiceInstructions || [],
      bannerInstructions: step.bannerInstructions || []
    }))
  };
}

/** Draw (or redraw) a route line on an existing map, in the Tími palette. */
export function drawRoute(map, route, { sourceId = "timi-route" } = {}) {
  const data = { type: "Feature", properties: {}, geometry: route.geometry };
  const casingId = `${sourceId}-casing`;

  if (map.getSource(sourceId)) {
    map.getSource(sourceId).setData(data);
    return;
  }

  const paint = () => {
    map.addSource(sourceId, { type: "geojson", data });
    map.addLayer({
      id: casingId,
      type: "line",
      source: sourceId,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": TOKENS.ink, "line-width": 9, "line-opacity": 0.9 }
    });
    map.addLayer({
      id: sourceId,
      type: "line",
      source: sourceId,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": TOKENS.blue, "line-width": 5 }
    });
  };

  if (map.isStyleLoaded()) paint();
  else map.once("load", paint);
}

export function clearRoute(map, { sourceId = "timi-route" } = {}) {
  const casingId = `${sourceId}-casing`;
  if (map.getLayer(sourceId)) map.removeLayer(sourceId);
  if (map.getLayer(casingId)) map.removeLayer(casingId);
  if (map.getSource(sourceId)) map.removeSource(sourceId);
}

/* ------------------------------------------------------------ guidance --- */

/**
 * Driving-instruction phrasing.
 *
 * Kept as data so the wording can change without touching the guidance engine,
 * and so the native clients can mirror the same table byte for byte —
 * `scripts/validate.mjs` fails the build if web and iOS ever drift.
 *
 * Two rules govern the tone, and they are structural rather than stylistic:
 *
 * 1. **Maneuvers are never funny.** A driver gets one pass at "turn left onto
 *    Foothill" while their pet is in the back seat. These read naturally, the
 *    way a person would say them, and nothing more.
 * 2. **Personality scales inversely with urgency.** Tími's own announcements
 *    come in three registers. A pun that is warm on the way to a limp check-up
 *    is grotesque on the way to a collapse, so the emergency register has none.
 */
// Animal-flavoured, and only in the framing. The maneuver itself — the side,
// the modifier, the road name — is never the joke. A driver working out
// whether "paws" means pause is a driver not watching the road, so the pun
// goes around the instruction and never inside it.
export const INSTRUCTION_PHRASES = {
  depart: "And we're off — hoof it {side} on {road}",
  arrive: "That's {clinic}, right there",
  turn: "Take the {modifier} onto {road}",
  merge: "Join the pack — merge {side} onto {road}",
  "on ramp": "Hop on the ramp on the {side} toward {road}",
  "off ramp": "Peel off on the {side} toward {road}",
  fork: "Keep {side} at the fork",
  roundabout: "Round you go, then out onto {road}",
  continue: "Stay on {road} — nice and steady",
  "new name": "Same road, new collar — it's {road} now"
};

/**
 * Pairings the generic template cannot say naturally. "Take the U-turn onto
 * Foothill" is not English, and a ramp does not need to know the difference
 * between a right and a slight right.
 */
export const INSTRUCTION_OVERRIDES = {
  "turn:uturn": "Turn around when it's safe to",
  "turn:straight": "Keep straight onto {road}",
  "continue:uturn": "Turn around when it's safe to",
  "fork:straight": "Keep straight at the fork",
  "depart:uturn": "Start out by turning around when it's safe",
  "merge:straight": "Merge onto {road}",
  "on ramp:straight": "Hop on the ramp toward {road}",
  "off ramp:straight": "Take the exit toward {road}"
};

/** Mapbox's raw direction values, said the way a person says them. */
export const MODIFIER_WORDS = {
  left: "left",
  right: "right",
  "slight left": "slight left",
  "slight right": "slight right",
  "sharp left": "sharp left",
  "sharp right": "sharp right",
  straight: "straight ahead",
  uturn: "U-turn"
};

/**
 * The same directions reduced to a side. Ramps, merges, and forks only need to
 * know which way to lean; "take the exit on the slight right" is noise.
 */
export const SIDE_WORDS = {
  left: "left",
  right: "right",
  "slight left": "left",
  "slight right": "right",
  "sharp left": "left",
  "sharp right": "right",
  straight: "straight",
  uturn: "left"
};

/**
 * Lines Tími adds that a navigation SDK would never say, in three registers.
 *
 * `calm`      — stable, same-day concerns. Warm, and allowed one light pun.
 * `urgent`    — time-sensitive but stable. Warm, focused, no wordplay.
 * `emergency` — red flags present. Clear and nothing else. Do not add
 *               personality to this register; someone hearing it is frightened.
 */
export const TIMI_ANNOUNCEMENTS = {
  calm: {
    start: "Off we go. {clinic} is expecting {pet}, so the hard part is already behind you — this bit is just the tail end.",
    halfway: "About {minutes} minutes out, and {pet} is in good paws from here.",
    approaching: "{clinic} is just ahead. Look for the {kind} entrance.",
    arrival: "You made it. Tell the front desk you're the Tími arrival for {pet}. Nicely done — that was a fetching bit of driving."
  },
  urgent: {
    start: "On our way to {clinic}. They know {pet} is coming.",
    halfway: "About {minutes} minutes to {clinic}. You're doing great — no need to rush the herd.",
    approaching: "{clinic} is just ahead. Look for the {kind} entrance.",
    arrival: "You've arrived. Tell the front desk you're the Tími arrival for {pet}."
  },
  emergency: {
    start: "Heading to {clinic} now. They are expecting {pet}. Drive safely.",
    halfway: "{minutes} minutes to {clinic}.",
    approaching: "{clinic} is ahead. Go to the {kind} entrance.",
    arrival: "You've arrived. Go straight in and say {pet} is the Tími emergency arrival."
  }
};

/** Map a care urgency onto a speaking register. */
export function toneFor(urgency) {
  if (urgency === "emergency") return "emergency";
  if (urgency === "urgent") return "urgent";
  return "calm";
}

/**
 * Fill `{token}` placeholders.
 *
 * Returns null when any placeholder cannot be resolved. A half-filled
 * instruction is worse than no instruction at all — the caller falls back to
 * the navigation SDK's own wording, which is always complete even when it is
 * less warm.
 */
function fill(template, values) {
  let complete = true;
  const filled = String(template || "").replace(/\{(\w+)\}/g, (match, key) => {
    const value = (values[key] ?? "").toString().trim();
    if (!value) { complete = false; return ""; }
    return value;
  });
  return complete ? filled.replace(/\s{2,}/g, " ").trim() : null;
}

/**
 * Rewrite a Mapbox instruction into Tími's voice. Falls back to Mapbox's own
 * wording whenever the maneuver has no entry in the phrase table, so an SDK
 * update that adds a maneuver degrades to correct-but-plain rather than silent.
 */
export function phraseInstruction(step, context = {}) {
  const modifierKey = String(step.modifier || "").toLowerCase();
  const template = INSTRUCTION_OVERRIDES[`${step.type}:${modifierKey}`] || INSTRUCTION_PHRASES[step.type];
  if (!template) return step.instruction;
  const phrased = fill(template, {
    modifier: MODIFIER_WORDS[modifierKey] || modifierKey,
    side: SIDE_WORDS[modifierKey] || "",
    road: context.road || step.instruction.replace(/^.*?\bonto\s+/i, "") || "",
    clinic: context.clinic || "the hospital"
  });
  return phrased || step.instruction;
}

/** One of Tími's own announcements, in the register the urgency calls for. */
export function announcement(key, { tone = "calm", clinic, pet, minutes, kind } = {}) {
  const register = TIMI_ANNOUNCEMENTS[tone] || TIMI_ANNOUNCEMENTS.calm;
  const template = register[key];
  if (!template) return null;
  return fill(template, {
    clinic: clinic || "the hospital",
    pet: pet || "your pet",
    minutes: minutes === undefined || minutes === null ? "" : String(minutes),
    kind: kind || "main"
  });
  // A null here means a placeholder went unfilled — for example `halfway`
  // without a minutes estimate. The caller simply says nothing, which is the
  // right behaviour for an optional flourish.
}

/**
 * Wrap a line in SSML so a cloud voice breathes instead of sprinting.
 *
 * Navigation text-to-speech defaults are tuned for terse maneuvers; Tími's
 * announcements are whole sentences, and read at the default rate they land as
 * one anxious run-on. A short pause at each sentence boundary and a slightly
 * relaxed rate is most of what makes a synthetic voice sound human.
 */
export function ssmlFor(text, { tone = "calm" } = {}) {
  const rate = tone === "emergency" ? "100%" : tone === "urgent" ? "97%" : "94%";
  const escaped = String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const paced = escaped.replace(/([.!?])\s+/g, '$1<break time="320ms"/> ');
  return `<speak><prosody rate="${rate}">${paced}</prosody></speak>`;
}

/**
 * Browser voice guidance. Uses the Web Speech API, which is the web equivalent
 * of the native voice controller — same phrase tables, same registers.
 */
export class VoiceGuide {
  constructor(preferences = {}) {
    this.preferences = { enabled: true, rate: 1, pitch: 1, voiceURI: null, tone: "calm", ...preferences };
    this.spoken = new Set();
  }

  static supported() {
    return typeof globalThis.speechSynthesis !== "undefined";
  }

  /**
   * Voices the user can choose between, best first.
   *
   * Browsers expose a long, unordered list in which the most natural voices are
   * rarely at the top. Ranking them means the default a driver hears is the
   * best one their device has, without anyone opening a settings screen.
   */
  static voices(language = "en") {
    if (!VoiceGuide.supported()) return [];
    return speechSynthesis.getVoices()
      .filter((voice) => voice.lang.toLowerCase().startsWith(language.toLowerCase()))
      .map((voice) => ({
        name: voice.name,
        voiceURI: voice.voiceURI,
        lang: voice.lang,
        local: voice.localService,
        quality: VoiceGuide.rank(voice)
      }))
      .sort((a, b) => b.quality - a.quality || a.name.localeCompare(b.name));
  }

  /** Higher is more natural. Names are the only quality signal the API gives. */
  static rank(voice) {
    const name = `${voice.name} ${voice.voiceURI}`.toLowerCase();
    let score = 0;
    if (/natural|neural/.test(name)) score += 6;
    if (/premium|enhanced/.test(name)) score += 5;
    if (/google|siri/.test(name)) score += 3;
    if (/multilingual/.test(name)) score += 1;
    // Network voices are usually the higher-fidelity ones.
    if (!voice.localService) score += 2;
    if (/compact|espeak|novelty/.test(name)) score -= 6;
    return score;
  }

  /** The best available voice, used until the driver picks one themselves. */
  static bestVoice(language = "en") {
    return VoiceGuide.voices(language)[0] || null;
  }

  say(text, { force = false } = {}) {
    if (!this.preferences.enabled || !VoiceGuide.supported() || !text) return;
    if (!force && this.spoken.has(text)) return;
    this.spoken.add(text);
    const utterance = new SpeechSynthesisUtterance(text);
    // A shade under conversational, so a whole sentence lands as speech rather
    // than an announcement. The emergency register keeps full pace.
    const toneRate = this.preferences.tone === "emergency" ? 1 : 0.95;
    utterance.rate = this.preferences.rate * toneRate;
    utterance.pitch = this.preferences.pitch;
    const chosen = this.preferences.voiceURI
      ? speechSynthesis.getVoices().find((candidate) => candidate.voiceURI === this.preferences.voiceURI)
      : null;
    const fallback = chosen ? null : VoiceGuide.bestVoice((navigator.language || "en").slice(0, 2));
    const voice = chosen
      || (fallback && speechSynthesis.getVoices().find((candidate) => candidate.voiceURI === fallback.voiceURI));
    if (voice) utterance.voice = voice;
    speechSynthesis.speak(utterance);
  }

  stop() {
    if (VoiceGuide.supported()) speechSynthesis.cancel();
    this.spoken.clear();
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

export function formatDistance(meters, units = "imperial") {
  if (!Number.isFinite(meters)) return "—";
  if (units === "metric") {
    return meters < 1000 ? `${Math.round(meters / 10) * 10} m` : `${(meters / 1000).toFixed(1)} km`;
  }
  const feet = meters * 3.28084;
  return feet < 1000 ? `${Math.round(feet / 10) * 10} ft` : `${(feet / 5280).toFixed(1)} mi`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
}

export { TOKENS as MAP_TOKENS };
