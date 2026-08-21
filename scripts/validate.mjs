import { access, readFile } from "node:fs/promises";

const requiredFiles = [
  "public/index.html",
  "public/styles.css",
  "public/app.js",
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
  "migrations/0001_initial.sql",
  "migrations/0002_seed.sql",
  "scripts/smoke.mjs",
  "scripts/auth-test.mjs",
  "scripts/e2e.mjs",
  "docs/MVP-ARCHITECTURE.md",
  "docs/PAYMENTS-AND-TENANT-POLICIES.md",
  "docs/INTEGRATION-COST-MATRIX.md",
  "wrangler.jsonc",
  "wrangler.d1.example.jsonc"
];

await Promise.all(requiredFiles.map((file) => access(file)));

const html = await readFile("public/index.html", "utf8");
const app = await readFile("public/app.js", "utf8");
const worker = await readFile("src/index.js", "utf8");
const migration = await readFile("migrations/0001_initial.sql", "utf8");
const manifest = JSON.parse(await readFile("public/manifest.webmanifest", "utf8"));
const wrangler = await readFile("wrangler.jsonc", "utf8");
const wranglerD1Example = await readFile("wrangler.d1.example.jsonc", "utf8");

const screens = [...html.matchAll(/data-screen="([^"]+)"/g)].map((match) => match[1]);
const expectedScreens = ["home", "find", "results", "tracker", "pets", "clinic", "sign-in", "legal"];
for (const screen of expectedScreens) {
  if (!screens.includes(screen)) throw new Error(`Missing application screen: ${screen}`);
}

const requiredTables = ["tenants", "locations", "availability_reports", "tenant_policies", "intake_requests", "intake_events", "customer_observations", "notification_outbox"];
for (const table of requiredTables) {
  if (!migration.includes(`CREATE TABLE IF NOT EXISTS ${table}`)) throw new Error(`Missing D1 table: ${table}`);
}

const requiredRoutes = ["/api/config", "/api/locations", "/api/intakes", "/api/observations", "/api/clinic/dashboard", "/api/clinic/availability"];
for (const route of requiredRoutes) {
  if (!worker.includes(route)) throw new Error(`Missing API route: ${route}`);
}

if (!wrangler.includes('"SIGN_IN_REQUIRED": "false"')) throw new Error("SIGN_IN_REQUIRED must default to the exact string false");
if (wrangler.includes('"d1_databases"')) throw new Error("The default Cloudflare deployment must not require a D1 binding");
if (!wranglerD1Example.includes('"d1_databases"') || !wranglerD1Example.includes("REPLACE_WITH_YOUR_D1_DATABASE_ID")) throw new Error("The opt-in D1 configuration template is incomplete");
if (!app.includes("state.config?.signInRequired")) throw new Error("The client is not enforcing the runtime sign-in configuration");
if (manifest.display !== "standalone") throw new Error("PWA manifest must use standalone display mode");
if (!manifest.icons?.length) throw new Error("PWA manifest requires at least one icon");
if (!html.includes('<main id="main">')) throw new Error("Missing main landmark");
if (/appointment slot|choose an opening|book an appointment/i.test(html)) throw new Error("Scheduling language remains in the real-time intake interface");

console.log(`Validated ${requiredFiles.length} files, ${screens.length} screens, ${requiredTables.length} D1 tables, and ${requiredRoutes.length} API groups.`);
