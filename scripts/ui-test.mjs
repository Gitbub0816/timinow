/**
 * Browser tests for the three web surfaces.
 *
 * Kept out of `npm run check` because it needs Playwright and a Chromium
 * binary, which the Worker test suite deliberately does not depend on. Run it
 * with `npm run test:ui` after `npm install -D playwright`.
 *
 * It catches the class of failure a syntax check cannot: a module that throws
 * on import, a screen that never renders, a selector the code talks to that no
 * longer exists in the markup — and, most importantly, whether the veterinary
 * console's always-on-top floating window actually opens and populates.
 */
import http from "node:http";
import { readFile, access } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("Playwright is not installed. Run: npm install -D playwright");
  process.exit(2);
}

const EXECUTABLE = process.env.CHROMIUM_PATH || await firstExisting([
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/opt/pw-browsers/chromium/chrome-linux/chrome"
]);

async function firstExisting(candidates) {
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* keep looking */ }
  }
  return undefined;
}

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png"
};

const DASHBOARD = {
  location: { id: "loc_hearth", name: "Hearth & Paw Urgent Care", address: "1555 B Street, Hayward, CA", phone: "(510) 555-0194" },
  availability: {
    intakeStatus: "available", label: "Available now", stableWaitMin: 15, stableWaitMax: 35,
    capacityCount: 3, acceptsCritical: true, source: "hospital", confidence: "high", note: "Accepting arrivals."
  },
  metrics: { pending: 2, activeArrivals: 1, completedToday: 4, declinedToday: 0 },
  requests: [
    {
      id: "search_1", searchTarget: true, status: "pending", urgency: "urgent",
      pet: { name: "Milo", species: "dog", breed: "German shepherd", weightLbs: 78 },
      owner: { name: "Avery Cole", phone: "(510) 555-0111" },
      concernSummary: "Vomited three times since 7 AM and will not drink water.",
      travelMinutes: 11, requestedAt: new Date().toISOString()
    },
    {
      id: "search_2", searchTarget: true, status: "pending", urgency: "emergency", redFlags: ["breathing_difficulty"],
      pet: { name: "Juniper", species: "cat", breed: "Domestic shorthair", weightLbs: 9 },
      owner: { name: "Morgan Lee", phone: "(510) 555-0122" },
      concernSummary: "Open-mouth breathing at rest with blue-tinged gums.",
      travelMinutes: 17, requestedAt: new Date().toISOString()
    }
  ]
};

const CLINIC_SESSION = {
  authenticated: true,
  user: { id: "user_1", email: "vet@example.com", name: "Sam Rivera", role: "org:admin", permissions: [] },
  organization: { id: "org_1", slug: "hearth-paw" },
  tenant: { id: "tenant_hearth", name: "Hearth & Paw Veterinary", slug: "hearth-paw", status: "active" },
  location: DASHBOARD.location,
  platformAdmin: false,
  surfaces: { customer: true, clinic: true, admin: false },
  repairedMetadata: []
};

function serve(root, config, extra = {}) {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const send = (payload) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    if (url.pathname === "/api/config") return send(config);
    if (extra[url.pathname]) return send(extra[url.pathname]);
    if (url.pathname.startsWith("/api/")) return send({ locations: [], requests: [], tenants: [], session: null });
    const target = url.pathname === "/" ? "/index.html" : url.pathname;
    try {
      const body = await readFile(join(root, normalize(target).replace(/^(\.\.[/\\])+/, "")));
      response.writeHead(200, { "content-type": TYPES[extname(target)] || "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end("not found");
    }
  });
}

/** Network failures reaching third-party CDNs are environmental, not defects. */
function isEnvironmental(message) {
  return /favicon|manifest|sw\.js|ServiceWorker|mapbox|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED/i.test(message);
}

const failures = [];

async function withPage(root, port, config, extra, work) {
  const server = serve(root, config, extra);
  await new Promise((resolve) => server.listen(port, resolve));
  const browser = await chromium.launch({
    executablePath: EXECUTABLE,
    args: ["--enable-features=DocumentPictureInPictureAPI"]
  });
  try {
    const context = await browser.newContext({ permissions: ["notifications"] });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(`http://localhost:${port}/${config.startHash || ""}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    await work(page);
    const real = errors.filter((error) => !isEnvironmental(error));
    if (real.length) failures.push(`${root}: ${real.join(" | ")}`);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function expectPresent(page, label, selector) {
  const count = await page.locator(selector).count();
  if (!count) failures.push(`${label} is missing (${selector})`);
  console.log(`  ${count ? "ok     " : "MISSING"} ${label}`);
}

const publicConfig = {
  signInRequired: true, clerkPublishableKey: "", clerkJsUrl: "", demoMode: false, database: "d1",
  surface: "customer", map: { token: "", styleUrl: "mapbox://styles/x/y" }
};

console.log("\ncustomer PWA — sign-in");
await withPage("public", 8801, { ...publicConfig, startHash: "#sign-in" }, {}, async (page) => {
  await expectPresent(page, "sign-in screen", '[data-screen="sign-in"]');
  await expectPresent(page, "identifier step", '[data-auth-step="identifier"]');
  await expectPresent(page, "one-time-code step", '[data-auth-step="code"]');
  await expectPresent(page, "workspace picker step", '[data-auth-step="organization"]');
  const banned = await page.evaluate(() => document.body.innerHTML.includes("cl-rootBox") || Boolean(document.querySelector(".cl-component,[data-clerk-component]")));
  if (banned) failures.push("a prebuilt Clerk component rendered on the customer sign-in screen");
  console.log(`  ${banned ? "FAIL   " : "ok     "} no Clerk-rendered component`);
});

console.log("\ncustomer PWA — results and map");
await withPage("public", 8802, { ...publicConfig, signInRequired: false, startHash: "#results" }, {}, async (page) => {
  await expectPresent(page, "results screen", '[data-screen="results"]');
  await expectPresent(page, "map panel", "[data-results-map-panel]");
  await expectPresent(page, "hospital list", "[data-hospital-list]");
});

console.log("\ncustomer PWA — tracker and navigation");
await withPage("public", 8803, { ...publicConfig, signInRequired: false, startHash: "#tracker" }, {}, async (page) => {
  await expectPresent(page, "tracker map panel", "[data-tracker-map-panel]");
  await expectPresent(page, "navigation panel", "[data-navigation-panel]");
  await expectPresent(page, "spoken-directions toggle", "[data-navigation-voice]");
  await expectPresent(page, "route preferences", "[data-navigation-avoid]");
});

console.log("\nveterinary console — floating always-on-top window");
await withPage(
  "apps/vet-web/public",
  8804,
  { ...publicConfig, surface: "clinic", signInRequired: false, startHash: "#console" },
  { "/api/session": { session: CLINIC_SESSION }, "/api/clinic/dashboard": DASHBOARD },
  async (page) => {
    const supported = await page.evaluate(() => "documentPictureInPicture" in window);
    console.log(`  ${supported ? "ok     " : "skip   "} Document Picture-in-Picture available`);
    await expectPresent(page, "open floating console control", '[data-action="open-mini"]');
    if (!supported) return;

    await page.locator('[data-action="open-mini"]').first().click();
    await page.waitForTimeout(800);
    const mini = await page.evaluate(() => {
      const win = window.documentPictureInPicture?.window;
      if (!win) return { opened: false };
      const doc = win.document;
      return {
        opened: true,
        pending: doc.querySelector("[data-mini-pending]")?.textContent,
        clinic: doc.querySelector("[data-mini-clinic]")?.textContent,
        items: doc.querySelectorAll(".mini-item").length,
        emergencies: doc.querySelectorAll(".mini-item.is-emergency").length,
        styled: win.getComputedStyle(doc.querySelector(".mini-root") || doc.body).backgroundColor
      };
    });
    if (!mini.opened) { failures.push("the floating console did not open"); console.log("  FAIL    floating console opened"); return; }
    console.log(`  ok      floating console opened (${mini.items} requests, ${mini.emergencies} emergency, background ${mini.styled})`);
    if (mini.pending !== "2") failures.push(`the floating console showed ${mini.pending} pending requests, expected 2`);
    if (mini.items !== 2) failures.push(`the floating console listed ${mini.items} requests, expected 2`);
    if (mini.emergencies !== 1) failures.push("the floating console did not flag the emergency request");
    // Styles must be cloned across; an unstyled PiP document means cloneStylesInto broke.
    if (!mini.styled || mini.styled === "rgba(0, 0, 0, 0)") failures.push("the floating console inherited no styling");
  }
);

console.log("\nadmin console");
await withPage("apps/admin-console/public", 8805, { ...publicConfig, surface: "admin" },
  { "/api/admin/bootstrap": { platformAdmin: false, actor: { id: "user_1", email: "operator@example.com" } } },
  async (page) => {
    await expectPresent(page, "sign-in surface", '[data-screen="sign-in"], [data-view="sign-in"], #sign-in');
    await expectPresent(page, "tenants surface", '[data-screen="tenants"], [data-view="tenants"], #tenants');
  });

if (failures.length) {
  console.error(`\n${failures.length} browser test failure(s):\n${failures.map((failure) => `  - ${failure}`).join("\n")}`);
  process.exit(1);
}
console.log("\nBrowser tests passed: custom sign-in on every surface, the customer map and navigation panels, and the always-on-top veterinary queue.");
