/**
 * Emergency veterinary hospitals from map data, not only from the Tími network.
 *
 * The "possible emergency" button used to list the enrolled providers that
 * happen to be emergency-capable. In a city where Tími has three partners that
 * is a list of three, and the nearest emergency hospital — a real building,
 * open now, with a phone that a person could be ringing from the car — is not
 * on it. When the answer is "drive now", the network's boundaries are not the
 * customer's problem.
 *
 * ## Why forward search and not the category endpoint
 *
 * Mapbox has a `veterinarian` category, and it returns the nearest
 * veterinarians — which is almost entirely general practices. Asked for 25
 * around Hayward it returns twenty-five day clinics and no emergency hospital
 * at all, because emergency hospitals are rare and therefore never among the
 * nearest twenty-five of anything. There is no `emergency_veterinarian`
 * category.
 *
 * So this runs several forward searches instead, each phrased the way an
 * emergency hospital names itself, all constrained to a bounding box around the
 * customer. The union is deduplicated and ranked by distance. Recall comes from
 * the number of phrasings, which is why there are several rather than one.
 *
 * ## What is deliberately not done
 *
 * Nothing here decides whether a hospital is open, has capacity, or will see an
 * animal. It is map data: a name, an address, a phone number and a point. The
 * clients say so, because presenting a POI listing as a triaged recommendation
 * would be the worst kind of wrong.
 */

const SEARCH_BOX = "https://api.mapbox.com/search/searchbox/v1/forward";

/**
 * One query per way an emergency hospital tends to be named. Mapbox ranks by
 * text relevance within the box, so "emergency vet" and "veterinary emergency"
 * genuinely return different places.
 */
const EMERGENCY_QUERIES = [
  "emergency vet",
  "veterinary emergency",
  "animal emergency hospital",
  "pet emergency",
  "24 hour animal hospital",
  "veterinary specialty and emergency",
  "animal urgent care"
];

/** Signals in a name that the place takes emergencies. */
const EMERGENCY_NAME = /\b(emergency|emergencies|urgent|24[\s-]?hour|24\/7|critical care|specialt|referral|\ber\b|\bveg\b)/i;

/** A Mapbox POI category that means "this is a veterinary place". */
const VETERINARY_CATEGORY = /vet/i;

const EARTH_RADIUS_MILES = 3958.7613;

export function milesBetween(latA, lonA, latB, lonB) {
  const toRadians = (value) => (value * Math.PI) / 180;
  const dLat = toRadians(latB - latA);
  const dLon = toRadians(lonB - lonA);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(latA)) * Math.cos(toRadians(latB)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * A box that contains everything within `radiusMiles`. Longitude degrees
 * shrink with latitude, so the width is divided by cos(lat) — without that the
 * box is far too narrow near the poles and slightly too narrow everywhere else.
 */
function boundingBox(latitude, longitude, radiusMiles) {
  const latDelta = radiusMiles / 69;
  const shrink = Math.max(0.2, Math.cos((latitude * Math.PI) / 180));
  const lonDelta = radiusMiles / (69 * shrink);
  const clampLat = (value) => Math.max(-90, Math.min(90, value));
  const clampLon = (value) => Math.max(-180, Math.min(180, value));
  return [
    clampLon(longitude - lonDelta),
    clampLat(latitude - latDelta),
    clampLon(longitude + lonDelta),
    clampLat(latitude + latDelta)
  ].map((value) => value.toFixed(5)).join(",");
}

/**
 * A phone number reduced to something two listings of the same hospital agree
 * on. Map data writes the same number as "+19257187771", "925-718-7771" and
 * "(925) 718-7771"; the trailing ten digits are what they have in common, and
 * comparing the raw strings makes one hospital look like three.
 */
export function phoneKey(phone) {
  const digits = String(phone || "").replace(/[^0-9]/g, "");
  if (!digits) return "";
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/** Two listings for one building: same phone, or same name at the same point. */
function dedupeKey(place) {
  const phone = phoneKey(place.phone);
  if (phone) return `phone:${phone}`;
  const name = place.name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return `place:${name}:${place.latitude.toFixed(3)}:${place.longitude.toFixed(3)}`;
}

function placeFromFeature(feature, origin) {
  const properties = feature?.properties;
  if (!properties?.name) return null;
  const coordinates = properties.coordinates;
  const latitude = Number(coordinates?.latitude);
  const longitude = Number(coordinates?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  // A forward search for "24 hour animal hospital" cheerfully returns a street
  // called Hospital Drive. Requiring a veterinary category, or failing that a
  // veterinary word in the name, is what keeps roads out of the list.
  const categories = Array.isArray(properties.poi_category) ? properties.poi_category : [];
  const veterinary = categories.some((value) => VETERINARY_CATEGORY.test(String(value)))
    || /\b(vet|veterinar|animal hospital|pet hospital|animal emergency)/i.test(properties.name);
  if (!veterinary) return null;

  return {
    id: `map_${properties.mapbox_id || `${latitude},${longitude}`}`,
    source: "map",
    partner: false,
    name: properties.name,
    address: properties.full_address || properties.address || null,
    phone: properties.metadata?.phone || null,
    latitude,
    longitude,
    distanceMiles: Number(milesBetween(origin.latitude, origin.longitude, latitude, longitude).toFixed(1)),
    /**
     * Whether the name says it takes emergencies. A hint for ordering and for
     * the client's label — never a claim that the place is open or equipped,
     * which map data cannot tell us.
     */
    emergencyNamed: EMERGENCY_NAME.test(properties.name)
  };
}

/**
 * Emergency-capable veterinary places near a point, from Mapbox.
 *
 * Returns `[]` rather than throwing when no token is configured or Mapbox is
 * unreachable: the caller still has the Tími network to show, and an emergency
 * screen that fails closed is worse than one that is short.
 */
export async function findEmergencyVeterinaryPlaces(env, { latitude, longitude, radiusMiles = 60, limit = 10 }) {
  const token = env.MAPBOX_PUBLIC_TOKEN;
  if (!token) return [];
  const bbox = boundingBox(latitude, longitude, radiusMiles);
  const origin = { latitude, longitude };

  const responses = await Promise.all(EMERGENCY_QUERIES.map(async (query) => {
    const url = new URL(SEARCH_BOX);
    url.searchParams.set("q", query);
    url.searchParams.set("access_token", token);
    url.searchParams.set("proximity", `${longitude},${latitude}`);
    url.searchParams.set("bbox", bbox);
    url.searchParams.set("limit", "10");
    url.searchParams.set("language", "en");
    try {
      const response = await fetch(url, { headers: { accept: "application/json" } });
      if (!response.ok) return [];
      const payload = await response.json();
      return Array.isArray(payload.features) ? payload.features : [];
    } catch (error) {
      console.warn(JSON.stringify({ event: "mapbox_search_failed", query, message: error.message }));
      return [];
    }
  }));

  const found = new Map();
  for (const feature of responses.flat()) {
    const place = placeFromFeature(feature, origin);
    if (!place) continue;
    if (place.distanceMiles > radiusMiles) continue;
    const key = dedupeKey(place);
    const existing = found.get(key);
    // Prefer the listing that carries a phone number, then the one whose name
    // says emergency: two records for one building often differ in exactly
    // those, and the useful one is the one somebody can ring.
    if (!existing
      || (!existing.phone && place.phone)
      || (!existing.emergencyNamed && place.emergencyNamed)) {
      found.set(key, place);
    }
  }

  const ranked = [...found.values()]
    .sort((a, b) => Number(b.emergencyNamed) - Number(a.emergencyNamed) || a.distanceMiles - b.distanceMiles);

  // Places whose name says emergency, and — only if there are barely any —
  // ordinary practices to pad the list out. In a city that means the list is
  // emergency hospitals and nothing else; somewhere rural it means a day
  // clinic that might answer the phone beats an empty screen. Four is the
  // floor because below that the screen stops looking like a list at all.
  const named = ranked.filter((place) => place.emergencyNamed);
  const rest = ranked.filter((place) => !place.emergencyNamed);
  const minimum = 4;
  const padded = named.length >= minimum ? named : [...named, ...rest.slice(0, minimum - named.length)];
  return padded.slice(0, limit);
}
