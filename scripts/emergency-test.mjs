/**
 * The emergency-hospital lookup, with Mapbox stubbed.
 *
 * The point of this feature is that it reaches past the Tími network, so the
 * things worth pinning are exactly the ones that would quietly stop doing that:
 * the filtering that keeps roads out, the deduplication that keeps one building
 * from appearing four times, and the ordering that puts a real emergency
 * hospital above a day clinic that happens to be closer.
 */
import { findEmergencyVeterinaryPlaces, milesBetween } from "../src/mapbox-places.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function feature(name, { phone, lat, lon, categories = ["services", "veterinary"] } = {}) {
  return {
    properties: {
      name,
      mapbox_id: `id_${name.replace(/\W/g, "")}`,
      full_address: `${name} address`,
      poi_category: categories,
      metadata: phone ? { phone } : {},
      coordinates: { latitude: lat, longitude: lon }
    }
  };
}

const origin = { latitude: 37.6688, longitude: -122.0808 };
const near = (miles) => ({ lat: origin.latitude + miles / 69, lon: origin.longitude });

let requested = [];
function stubMapbox(featuresByQuery) {
  requested = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    const query = parsed.searchParams.get("q");
    requested.push({ query, bbox: parsed.searchParams.get("bbox"), proximity: parsed.searchParams.get("proximity") });
    return new Response(JSON.stringify({ features: featuresByQuery[query] || [] }), { status: 200 });
  };
}

const realFetch = globalThis.fetch;
const env = { MAPBOX_PUBLIC_TOKEN: "pk.test" };

/* ------------------------------------------------- distance and bounds --- */

assert(Math.abs(milesBetween(37.6688, -122.0808, 37.6688, -122.0808)) < 0.001, "A point is zero miles from itself");
assert(Math.abs(milesBetween(37.6688, -122.0808, 38.6688, -122.0808) - 69) < 1, "A degree of latitude is about 69 miles");

/* ------------------------------------------------------------ filtering --- */

stubMapbox({
  "emergency vet": [
    feature("Bay Emergency Animal Hospital", { phone: "+15105550100", ...near(4) }),
    // A forward search for a hospital returns roads named after one.
    feature("Hospital Drive", { ...near(1), categories: [] }),
    feature("Emergency Lane", { ...near(2), categories: ["address"] })
  ]
});
let places = await findEmergencyVeterinaryPlaces(env, { ...origin, radiusMiles: 60 });
assert(places.length === 1, `Roads must not be listed as hospitals: ${JSON.stringify(places.map((p) => p.name))}`);
assert(places[0].name === "Bay Emergency Animal Hospital", "The hospital must survive the filter");
assert(places[0].phone === "+15105550100", "The phone number must come through — it is the point of the row");

/* --------------------------------------------------------------- bounds --- */

const box = requested[0].bbox.split(",").map(Number);
assert(box[0] < origin.longitude && box[2] > origin.longitude, "The bounding box must contain the customer");
assert(box[1] < origin.latitude && box[3] > origin.latitude, "The bounding box must contain the customer");
assert(requested.length >= 5, "Recall comes from asking several ways; one query is not enough");

// Anything the box lets through but the radius does not.
stubMapbox({ "emergency vet": [feature("Far Emergency Vet", { phone: "+15105550111", ...near(90) })] });
places = await findEmergencyVeterinaryPlaces(env, { ...origin, radiusMiles: 60 });
assert(places.length === 0, "A hospital beyond the radius must be dropped, not merely sorted last");

/* ---------------------------------------------------------- duplication --- */

// One building, four listings — Mapbox returns near-duplicates constantly, and
// the same place answering three different queries is the normal case.
stubMapbox({
  "emergency vet": [feature("VEG ER for Pets", { phone: "+1 (925) 718-7771", ...near(9) })],
  "veterinary emergency": [feature("VEG ER For Pets", { phone: "+19257187771", ...near(9) })],
  "pet emergency": [feature("Veterinary Emergency Group", { phone: "925-718-7771", ...near(9) })],
  "24 hour animal hospital": [feature("Some Animal Hospital", { ...near(9) })]
});
places = await findEmergencyVeterinaryPlaces(env, { ...origin, radiusMiles: 60 });
assert(places.filter((p) => /VEG|Veterinary Emergency/.test(p.name)).length === 1, "One phone number is one hospital, however it is punctuated");

/* -------------------------------------------------------------- ranking --- */

stubMapbox({
  "emergency vet": [
    feature("Neighbourhood Pet Clinic", { phone: "+15105550001", ...near(1) }),
    feature("Regional Animal Emergency Hospital", { phone: "+15105550002", ...near(25) })
  ]
});
places = await findEmergencyVeterinaryPlaces(env, { ...origin, radiusMiles: 60 });
assert(places[0].name === "Regional Animal Emergency Hospital", "An emergency hospital 25 miles away beats a day clinic one mile away — that is what the button is for");
assert(places[0].emergencyNamed === true && places[1].emergencyNamed === false, "The label must say which is which");

// With enough real emergency hospitals, the day clinics stop appearing at all.
stubMapbox({
  "emergency vet": [
    feature("Emergency Vet A", { phone: "+15105550010", ...near(3) }),
    feature("Emergency Vet B", { phone: "+15105550011", ...near(4) }),
    feature("Animal Emergency C", { phone: "+15105550012", ...near(5) }),
    feature("24 Hour Animal Hospital D", { phone: "+15105550013", ...near(6) }),
    feature("Quiet Day Practice", { phone: "+15105550014", ...near(1) })
  ]
});
places = await findEmergencyVeterinaryPlaces(env, { ...origin, radiusMiles: 60 });
assert(!places.some((p) => p.name === "Quiet Day Practice"), "Once there are four real emergency hospitals, a day clinic is padding nobody needs");

// And with barely any, a day clinic beats an empty screen.
stubMapbox({ "emergency vet": [feature("Quiet Day Practice", { phone: "+15105550014", ...near(1) })] });
places = await findEmergencyVeterinaryPlaces(env, { ...origin, radiusMiles: 60 });
assert(places.length === 1 && places[0].emergencyNamed === false, "Somewhere rural, a clinic that might answer the phone beats nothing");

/* --------------------------------------------------------- failing soft --- */

globalThis.fetch = async () => new Response("upstream on fire", { status: 502 });
places = await findEmergencyVeterinaryPlaces(env, { ...origin, radiusMiles: 60 });
assert(Array.isArray(places) && places.length === 0, "A Mapbox failure must leave the Tími network showing, not blow up the screen");

globalThis.fetch = async () => { throw new Error("network down"); };
places = await findEmergencyVeterinaryPlaces(env, { ...origin, radiusMiles: 60 });
assert(places.length === 0, "A thrown fetch must be caught for the same reason");

places = await findEmergencyVeterinaryPlaces({}, { ...origin, radiusMiles: 60 });
assert(places.length === 0, "No Mapbox token configured is a short list, not an error");

globalThis.fetch = realFetch;
console.log("Emergency lookup tests passed: distance, bounding box, road filtering, radius, deduplication by phone, emergency-first ranking, day-clinic padding only when thin, and failing soft.");
