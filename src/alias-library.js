/**
 * The 250 temporary match aliases.
 *
 * A pet owner comparing clinics before confirming sees "Sequoia", not a
 * business name — so that the comparison happens inside Tími rather than in
 * a maps search that cuts Tími, and the clinic's availability commitment,
 * out of the trip entirely.
 *
 * An alias is a *temporary label for one search session*. It is never a
 * clinic name, never permanent, never a rank, and never something Google
 * supplied. Billing, routing, audit, support and clinic messages use
 * immutable ids; this file only ever decides what a card is called for the
 * next thirty minutes.
 *
 * The list is transcribed verbatim from the approved library (Temporary
 * Match Alias Library v1.0, §5) — all 250 words, in their ten categories of
 * twenty-five. It is data, not a suggestion: adding, dropping, or
 * substituting a word here is a product/legal decision, because every entry
 * has been through profanity, trademark, chain-collision, and pronunciation
 * screening. To retire one, deactivate it (match_aliases.active = 0, or the
 * denylist) — never delete it, or historical sessions stop being auditable.
 *
 * The words themselves are constrained by §6: no personal names, no
 * veterinary or medical terms, no brands, no places in an active market, no
 * quality or speed claims, nothing bleak. That is why the pool is trees,
 * weather and stones.
 */

/** Bump only alongside a reviewed change to the word list. Sessions record
 * the version they were assigned under, so an old mapping stays readable. */
export const ALIAS_LIBRARY_VERSION = 1;

const CATEGORY_SOURCE = [
  {
    code: "TREES_WOODLAND",
    label: "Trees and woodland",
    // Spec §5.1, entries 1–25.
    words: [
      "Alder", "Aspen", "Banyan", "Birch", "Bramble",
      "Canopy", "Cedar", "Cypress", "Dogwood", "Elmwood",
      "Fernwood", "Grove", "Hawthorn", "Hemlock", "Hickory",
      "Juniper", "Linden", "Magnolia", "Maple", "Oakwood",
      "Pinecrest", "Redwood", "Sequoia", "Sycamore", "Willow"
    ]
  },
  {
    code: "FLOWERS_BOTANICALS",
    label: "Flowers and botanicals",
    // Spec §5.2, entries 26–50.
    words: [
      "Amaranth", "Aster", "Azalea", "Bluebell", "Camellia",
      "Clover", "Dahlia", "Dandelion", "Flora", "Gardenia",
      "Heather", "Hibiscus", "Hollyhock", "Hyacinth", "Iris",
      "Jasmine", "Lavender", "Lilac", "Lotus", "Marigold",
      "Orchid", "Peony", "Primrose", "Verbena", "Wisteria"
    ]
  },
  {
    code: "HERBS_GRASSES",
    label: "Herbs, grasses, and greenery",
    // Spec §5.3, entries 51–75.
    words: [
      "Basil", "Briar", "Bulrush", "Chamomile", "Chicory",
      "Coriander", "Fennel", "Fern", "Flax", "Ginger",
      "Ivy", "Laurel", "Lemongrass", "Meadowgrass", "Mintleaf",
      "Moss", "Nettle", "Oregano", "Parsley", "Reed",
      "Rosemary", "Sagebrush", "Sorrel", "Thyme", "Yarrow"
    ]
  },
  {
    code: "SKY_LIGHT",
    label: "Sky and light",
    // Spec §5.4, entries 76–100.
    words: [
      "Afterglow", "Aurora", "Beacon", "Bluehour", "Borealis",
      "Celestial", "Cirrus", "Comet", "Daybreak", "Daylight",
      "Eclipse", "Equinox", "Halo", "Horizon", "Lumen",
      "Meridian", "Moonbeam", "Nova", "Radiance", "Skylark",
      "Solstice", "Starlight", "Sunbeam", "Sundial", "Twilight"
    ]
  },
  {
    code: "WATER_COAST",
    label: "Water and coast",
    // Spec §5.5, entries 101–125.
    words: [
      "Brook", "Cascade", "Cove", "Current", "Delta",
      "Dewdrop", "Estuary", "Fjord", "Harbor", "Headwater",
      "Lagoon", "Lakeshore", "Marina", "Mist", "Oasis",
      "Pebble", "Rainfall", "Ripple", "Riverbend", "Seabreeze",
      "Shoal", "Springtide", "Stream", "Tidepool", "Waterfall"
    ]
  },
  {
    code: "TERRAIN_LANDSCAPE",
    label: "Terrain and landscape",
    // Spec §5.6, entries 126–150.
    words: [
      "Arroyo", "Bluff", "Canyon", "Canyonland", "Cliffside",
      "Crest", "Dune", "Fieldstone", "Foothill", "Glen",
      "Granite", "Highland", "Hillcrest", "Meadow", "Mesa",
      "Moorland", "Overlook", "Prairie", "Ridgeline", "Sandstone",
      "Sierra", "Summit", "Timberline", "Vale", "Wildland"
    ]
  },
  {
    code: "WEATHER_SEASONS",
    label: "Weather and seasons",
    // Spec §5.7, entries 151–175.
    words: [
      "Autumn", "Breeze", "Cloudburst", "Cloudlet", "Coolwind",
      "Drizzle", "Evergreen", "Fairweather", "Frost", "Goldleaf",
      "Hailstone", "Midsummer", "Monsoon", "Northwind", "Raincloud",
      "Raindrop", "Snowdrop", "Snowfall", "Spring", "Starfall",
      "Sunshower", "Tempest", "Tradewind", "Westwind", "Wintergreen"
    ]
  },
  {
    code: "STONE_EARTH",
    label: "Stone, earth, and natural materials",
    // Spec §5.8, entries 176–200.
    words: [
      "Amber", "Amethyst", "Basalt", "Copper", "Coral",
      "Crystal", "Ember", "Flint", "Garnet", "Goldstone",
      "Ironwood", "Jade", "Jasper", "Limestone", "Marble",
      "Moonstone", "Obsidian", "Onyx", "Opal", "Pearl",
      "Quartz", "Riverstone", "Slate", "Topaz", "Travertine"
    ]
  },
  {
    code: "WARM_ABSTRACT",
    label: "Warm abstract words",
    // Spec §5.9, entries 201–225.
    words: [
      "Accord", "Amity", "Brightway", "Candor", "Compass",
      "Everwell", "Flourish", "Harmony", "Haven", "Hearth",
      "Kindred", "Lantern", "Lucent", "Mosaic", "Northstar",
      "Openway", "Promise", "Quietude", "Reverie", "Serenade",
      "Stillwater", "Tranquil", "Unity", "Vantage", "Wayfinder"
    ]
  },
  {
    code: "MOVEMENT_MUSIC",
    label: "Movement, music, and gentle imagery",
    // Spec §5.10, entries 226–250.
    words: [
      "Cadence", "Chime", "Drift", "Echo", "Feather",
      "Firefly", "Glide", "Hummingbird", "Lilt", "Melody",
      "Murmur", "Nightingale", "Overture", "Passage", "Rhapsody",
      "Rhythm", "Skylight", "Sparrow", "Tapestry", "Tempo",
      "Wander", "Whimsy", "Wingspan", "Zephyr", "Zenith"
    ]
  }
];

/** The ten categories, in library order. */
export const ALIAS_CATEGORIES = Object.freeze(
  CATEGORY_SOURCE.map((category) => Object.freeze({ code: category.code, label: category.label }))
);

/**
 * Every alias, frozen. `slug` is the stable machine identifier (and the
 * seeded row id in match_aliases); `displayName` is the only string a
 * customer ever sees.
 */
export const ALIAS_LIBRARY = Object.freeze(
  CATEGORY_SOURCE.flatMap((category) =>
    category.words.map((word) =>
      Object.freeze({ slug: word.toLowerCase(), displayName: word, category: category.code })
    )
  )
);

const BY_SLUG = new Map(ALIAS_LIBRARY.map((alias) => [alias.slug, alias]));

/** One alias by slug, or null. */
export function aliasBySlug(slug) {
  return BY_SLUG.get(String(slug || "").toLowerCase()) || null;
}

/** Aliases in one category. */
export function aliasesInCategory(code) {
  return ALIAS_LIBRARY.filter((alias) => alias.category === code);
}
