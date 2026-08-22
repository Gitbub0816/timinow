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
 * Driving-instruction phrasing. Kept as data so wording can be changed without
 * touching the guidance engine, and so the same table can be mirrored into the
 * native clients.
 */
export const INSTRUCTION_PHRASES = {
  depart: "Head {modifier} on {road}",
  arrive: "You've arrived at {clinic}",
  turn: "Turn {modifier} onto {road}",
  merge: "Merge {modifier} onto {road}",
  "on ramp": "Take the ramp {modifier} onto {road}",
  "off ramp": "Take the exit {modifier} toward {road}",
  fork: "Keep {modifier} at the fork",
  roundabout: "At the roundabout, take the exit onto {road}",
  continue: "Continue on {road}",
  "new name": "Continue onto {road}"
};

/** Sentences Tími adds that Mapbox would never say. */
export const TIMI_ANNOUNCEMENTS = {
  start: "Heading to {clinic}. The team is expecting {pet}.",
  halfway: "About {minutes} minutes to {clinic}.",
  approaching: "{clinic} is coming up. Look for the {kind} entrance.",
  arrival: "You've arrived at {clinic}. Tell the front desk you're the Tími arrival for {pet}."
};

function fill(template, values) {
  return String(template || "").replace(/\{(\w+)\}/g, (match, key) => (values[key] ?? "").toString().trim() || match);
}

/**
 * Rewrite a Mapbox instruction into Tími's voice. Falls back to Mapbox's own
 * wording whenever the maneuver has no entry in the phrase table.
 */
export function phraseInstruction(step, context = {}) {
  const template = INSTRUCTION_PHRASES[step.type];
  if (!template) return step.instruction;
  const phrased = fill(template, {
    modifier: step.modifier || "",
    road: context.road || step.instruction.replace(/^.*?\bonto\s+/i, "") || "the road",
    clinic: context.clinic || "the hospital"
  });
  return phrased.replace(/\s{2,}/g, " ").trim();
}

/**
 * Browser voice guidance. Uses the Web Speech API, which is the web equivalent
 * of the native voice controller — same phrase tables, same preferences.
 */
export class VoiceGuide {
  constructor(preferences = {}) {
    this.preferences = { enabled: true, rate: 1, pitch: 1, voiceURI: null, ...preferences };
    this.spoken = new Set();
  }

  static supported() {
    return typeof globalThis.speechSynthesis !== "undefined";
  }

  /** Voices the user can choose between, for a settings picker. */
  static voices(language = "en") {
    if (!VoiceGuide.supported()) return [];
    return speechSynthesis.getVoices()
      .filter((voice) => voice.lang.toLowerCase().startsWith(language.toLowerCase()))
      .map((voice) => ({ name: voice.name, voiceURI: voice.voiceURI, lang: voice.lang, local: voice.localService }));
  }

  say(text, { force = false } = {}) {
    if (!this.preferences.enabled || !VoiceGuide.supported() || !text) return;
    if (!force && this.spoken.has(text)) return;
    this.spoken.add(text);
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = this.preferences.rate;
    utterance.pitch = this.preferences.pitch;
    const voice = speechSynthesis.getVoices().find((candidate) => candidate.voiceURI === this.preferences.voiceURI);
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
