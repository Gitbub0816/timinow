import { access, readFile } from "node:fs/promises";

const requiredFiles = [
  "public/index.html",
  "public/styles.css",
  "public/app.js",
  "public/map.js",
  "apps/customer-mobile/Sources/TimiNowUI/Resources/instruction-phrases.json",
  "public/manifest.webmanifest",
  "public/sw.js",
  "public/assets/brand/timinow-wordmark.png",
  "public/assets/art/find-care-hero.png",
  "public/assets/art/clinic-operations.png",
  "public/assets/icons/icon.svg",
  "src/index.js",
  "src/auth.js",
  "src/catalog.js",
  "src/db.js",
  "src/clerk.js",
  "src/session.js",
  "src/tenancy.js",
  "src/tenant-admin.js",
  "migrations/0001_initial.sql",
  "migrations/0002_seed.sql",
  "migrations/0003_multi_offer_search.sql",
  "migrations/0004_tenancy_admin.sql",
  "scripts/smoke.mjs",
  "scripts/auth-test.mjs",
  "scripts/tenancy-test.mjs",
  "scripts/syntax.mjs",
  "scripts/e2e.mjs",
  "docs/MVP-ARCHITECTURE.md",
  "docs/PAYMENTS-AND-TENANT-POLICIES.md",
  "docs/INTEGRATION-COST-MATRIX.md",
  "wrangler.jsonc",
  "wrangler.local.example.jsonc",
  "wrangler.vet.jsonc",
  "wrangler.admin.jsonc",
  "apps/vet-web/public/index.html",
  "apps/vet-web/public/app.js",
  "apps/vet-web/src/index.js",
  "apps/admin-console/public/index.html",
  "apps/admin-console/public/app.js",
  "apps/admin-console/src/index.js"
];

await Promise.all(requiredFiles.map((file) => access(file)));

const html = await readFile("public/index.html", "utf8");
const app = await readFile("public/app.js", "utf8");
const customerMap = await readFile("public/map.js", "utf8");
const worker = await readFile("src/index.js", "utf8");
const migration = await readFile("migrations/0001_initial.sql", "utf8");
const multiOfferMigration = await readFile("migrations/0003_multi_offer_search.sql", "utf8");
const manifest = JSON.parse(await readFile("public/manifest.webmanifest", "utf8"));
const wrangler = await readFile("wrangler.jsonc", "utf8");
const wranglerLocalExample = await readFile("wrangler.local.example.jsonc", "utf8");
const wranglerVet = await readFile("wrangler.vet.jsonc", "utf8");
const wranglerAdmin = await readFile("wrangler.admin.jsonc", "utf8");
const tenancyMigration = await readFile("migrations/0004_tenancy_admin.sql", "utf8");
const vetApp = await readFile("apps/vet-web/public/app.js", "utf8");
const adminApp = await readFile("apps/admin-console/public/app.js", "utf8");
const adminWorker = await readFile("apps/admin-console/src/index.js", "utf8");

/** The one production map style every surface must render. */
const MAP_STYLE_URL = "mapbox://styles/calebowen2019/cmt3nci25004d01sya8qxcb4u";

const screens = [...html.matchAll(/data-screen="([^"]+)"/g)].map((match) => match[1]);
const expectedScreens = ["home", "find", "results", "tracker", "pets", "clinic", "sign-in", "legal"];
for (const screen of expectedScreens) {
  if (!screens.includes(screen)) throw new Error(`Missing application screen: ${screen}`);
}

const requiredTables = ["tenants", "locations", "availability_reports", "tenant_policies", "intake_requests", "intake_events", "customer_observations", "notification_outbox", "care_searches", "care_search_targets", "care_offers", "platform_admins", "tenant_members", "tenant_invitations", "admin_audit_log"];
for (const table of requiredTables) {
  if (!`${migration}\n${multiOfferMigration}\n${tenancyMigration}`.includes(`CREATE TABLE IF NOT EXISTS ${table}`)) throw new Error(`Missing D1 table: ${table}`);
}

const requiredRoutes = ["/api/config", "/api/locations", "/api/intakes", "/api/searches", "select-offer", "/api/observations", "/api/clinic/dashboard", "/api/clinic/availability", "search-targets", "/api/session", "/api/tenant/members"];
for (const route of requiredRoutes) {
  if (!worker.includes(route)) throw new Error(`Missing API route: ${route}`);
}

// Production posture: authentication is enforced and the Worker is bound to the
// real D1 database. The demo-safe defaults these checks used to assert are gone.
if (!wrangler.includes('"SIGN_IN_REQUIRED": "true"')) throw new Error("SIGN_IN_REQUIRED must be the exact string true in production");
if (!wrangler.includes('"DEMO_MODE": "false"')) throw new Error("DEMO_MODE must be the exact string false in production");
if (!wrangler.includes('"d1_databases"')) throw new Error("The production deployment must bind the D1 database");
if (wrangler.includes("REPLACE_WITH_YOUR_D1_DATABASE_ID")) throw new Error("wrangler.jsonc still contains the placeholder D1 database id");
if (!wranglerLocalExample.includes('"d1_databases"') || !wranglerLocalExample.includes("REPLACE_WITH_YOUR_D1_DATABASE_ID")) throw new Error("The local development configuration template is incomplete");

// The veterinary console and the admin console deploy as their own Workers so the
// platform operator surface never shares an origin with the public application.
if (!wranglerVet.includes('"name": "timinow-vet"')) throw new Error("The veterinary Worker must deploy under its own name");
if (!wranglerAdmin.includes('"name": "timinow-admin"')) throw new Error("The admin Worker must deploy under its own name");
for (const [label, config] of [["veterinary", wranglerVet], ["admin", wranglerAdmin]]) {
  if (!config.includes('"SIGN_IN_REQUIRED": "true"')) throw new Error(`The ${label} Worker must always require sign-in`);
  if (!config.includes('"d1_databases"')) throw new Error(`The ${label} Worker must bind the D1 database`);
}
if (!wranglerAdmin.includes("PLATFORM_ADMIN_USER_IDS")) throw new Error("The admin Worker must declare the platform operator allowlist");

// Tenant creation is a platform-operator capability and must exist nowhere else.
if (!adminWorker.includes("/api/admin/tenants")) throw new Error("The admin Worker must expose tenant creation");
if (worker.includes("/api/admin/tenants")) throw new Error("Tenant creation must not be reachable from the customer Worker");
if (vetApp.includes("/api/admin/tenants")) throw new Error("Tenant creation must not be reachable from the veterinary console");

// Every Clerk surface must be custom UI. Clerk's own prebuilt components are banned.
const clerkComponentPattern = /mountSignIn|mountSignUp|mountUserButton|mountOrganizationSwitcher|mountOrganizationProfile|mountUserProfile|mountOrganizationList|<SignIn|<SignUp|openSignIn\(/;
for (const [label, source] of [["customer", app], ["veterinary", vetApp], ["admin", adminApp]]) {
  if (clerkComponentPattern.test(source)) throw new Error(`The ${label} surface must not mount a prebuilt Clerk component`);
}

// The production map style is pinned identically across every surface.
for (const [label, source] of [["customer Worker", wrangler], ["veterinary Worker", wranglerVet], ["admin Worker", wranglerAdmin]]) {
  if (!source.includes(MAP_STYLE_URL)) throw new Error(`The ${label} must pin the production Mapbox style URL`);
}
if (!customerMap.includes("mapbox-gl")) throw new Error("The customer map module must load Mapbox GL JS");
if (!customerMap.includes("directions/v5/mapbox")) throw new Error("The customer map module must request driving directions");
if (!app.includes("renderClinicMap")) throw new Error("The customer application must render the clinic map");
if (!app.includes("startNavigation")) throw new Error("The customer application must offer turn-by-turn navigation");

// The web client and the native client must speak the same words. Rather than
// compare the two tables field by field, regenerate the native copy from the
// web source and require it to be byte-identical — the same guarantee, and it
// also catches a formatting drift that a field comparison would miss.
const { NATIVE_PHRASE_PATH, serializedPhraseTable } = await import("./sync-phrases.mjs");
const nativePhrases = await readFile(NATIVE_PHRASE_PATH, "utf8");
if (nativePhrases !== serializedPhraseTable()) {
  throw new Error(`${NATIVE_PHRASE_PATH} is out of date with public/map.js — run: npm run sync:phrases`);
}

// Personality must scale inversely with urgency. A pun that is warm on the way
// to a limp check-up is grotesque on the way to a collapse, so the emergency
// register carries none — this is a product rule, not a style preference.
const { TIMI_ANNOUNCEMENTS } = await import("../public/map.js");
const registers = ["calm", "urgent", "emergency"];
const moments = ["start", "halfway", "approaching", "arrival"];
for (const register of registers) {
  const lines = TIMI_ANNOUNCEMENTS[register];
  if (!lines) throw new Error(`Missing navigation speaking register: ${register}`);
  for (const moment of moments) {
    if (!lines[moment]) throw new Error(`Register ${register} is missing its ${moment} line`);
  }
}
const PLAYFUL = /\bpaws?\b|\bfetch(?:ing)?\b|\bfur\b|\btail\b|\bpurr|\bwhisker/i;
for (const moment of moments) {
  if (PLAYFUL.test(TIMI_ANNOUNCEMENTS.emergency[moment])) {
    throw new Error(`The emergency register must not be playful, but its ${moment} line is`);
  }
  if (PLAYFUL.test(TIMI_ANNOUNCEMENTS.urgent[moment])) {
    throw new Error(`The urgent register must stay plain, but its ${moment} line is playful`);
  }
}
if (!moments.some((moment) => PLAYFUL.test(TIMI_ANNOUNCEMENTS.calm[moment]))) {
  throw new Error("The calm register should carry the brand's personality, but reads entirely plain");
}

console.log(`Validated ${requiredFiles.length} files, ${screens.length} screens, ${requiredTables.length} D1 tables, and ${requiredRoutes.length} API groups.`);
