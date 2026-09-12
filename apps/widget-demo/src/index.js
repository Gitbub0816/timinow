/**
 * Widget gallery + demo clinic site.
 *
 * Two pages, no database, no auth, no state:
 *
 *   GET /            the GALLERY — all ten widget designs rendered live by
 *                    the real embed script, with switchers for state, color
 *                    variant, and the optional Tími elements. This is the
 *                    "market" a clinic browses before opening the Widget
 *                    Studio in the provider portal.
 *   GET /clinic      the fictional practice homepage ("Hearthside Animal
 *                    Hospital", clearly labeled a demo) with a widget
 *                    embedded in situ.
 *
 * Faked plumbing so no real token or package is needed:
 *
 *   GET /widget.js                     the REAL embed script, proxied from
 *                                      the customer Worker — no copy to
 *                                      drift.
 *   GET /api/widget/:token/status      demo tokens name the state
 *                                      (demo-accepting …); a ?package= of
 *                                      the form pkg-demo-{design}-{variant}
 *                                      [-rich] is decoded into a package
 *                                      config, mirroring what the customer
 *                                      Worker returns for a saved Studio
 *                                      package.
 */

const CUSTOMER_ORIGIN_FALLBACK = "https://timinow.pet";

const DESIGNS = ["badge", "card", "banner", "poster", "ticker", "stack", "window", "paws", "ledger", "night"];
const DESIGN_LABEL = {
  badge: "Badge", card: "Card", banner: "Banner", poster: "Poster", ticker: "Ticker",
  stack: "Stat tile", window: "Window sign", paws: "Paws", ledger: "Ledger", night: "After hours"
};
const VARIANTS = ["cream", "ink", "blue", "coral", "forest"];
const STATES = ["accepting", "diverting", "full", "unavailable"];

const STATE_FRESHNESS = {
  accepting: "Updated 4 minutes ago",
  diverting: "Updated 12 minutes ago",
  full: "Updated 26 minutes ago",
  unavailable: null
};

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
// Kept in step with docs/SUBPROCESSORS.md by scripts/check-subprocessors.mjs
// — see the identical comment in src/index.js (the customer Worker). This
// gallery only ever loads the customer Worker's own widget.js.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://timinow.pet",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' https://timinow.pet",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

const SECURITY_HEADERS = {
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), payment=(), geolocation=()",
  "content-security-policy": CONTENT_SECURITY_POLICY
};

function customerOrigin(env) {
  const configured = String(env?.CUSTOMER_APP_URL || "").trim();
  try {
    return configured ? new URL(configured).origin : CUSTOMER_ORIGIN_FALLBACK;
  } catch {
    return CUSTOMER_ORIGIN_FALLBACK;
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** The real embed script, fetched from the customer Worker and cached at the
 * edge for ten minutes. If the fetch fails the pages still load — the mounts
 * just stay empty, exactly like a clinic site would behave offline. */
async function serveWidgetScript(env) {
  try {
    const response = await fetch(`${customerOrigin(env)}/widget.js`, { cf: { cacheTtl: 600, cacheEverything: true } });
    if (!response.ok) throw new Error(`upstream ${response.status}`);
    return new Response(await response.text(), {
      headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=600", ...SECURITY_HEADERS }
    });
  } catch {
    return new Response("/* Tími widget script unavailable — is the customer Worker deployed? */", {
      status: 502,
      headers: { "content-type": "text/javascript; charset=utf-8", ...SECURITY_HEADERS }
    });
  }
}

const ACCENTS = ["blue", "coral", "gold", "green"];
const FRAMES = ["hairline", "ink", "bold"];

/** Demo package ids mirror what the customer Worker returns for a real
 * Studio package. Two formats:
 *   pkg-demo.{design}.{variant}.{accent}.{frame}.{rich|pure}   (the gallery)
 *   pkg-demo-{design}-{variant}[-rich]                         (legacy)
 */
function demoPackage(packageId) {
  const dotted = /^pkg-demo\.([a-z]+)\.([a-z]+)\.([a-z]+)\.([a-z]+)\.(rich|pure)$/.exec(packageId || "");
  if (dotted && DESIGNS.includes(dotted[1]) && VARIANTS.includes(dotted[2]) && ACCENTS.includes(dotted[3]) && FRAMES.includes(dotted[4])) {
    return {
      design: dotted[1],
      variant: dotted[2],
      size: "standard",
      elements: dotted[5] === "rich" ? ["coverage", "donate", "reserve"] : [],
      options: { accent: dotted[3], frame: dotted[4] }
    };
  }
  const match = /^pkg-demo-([a-z]+)-([a-z]+)(-rich)?$/.exec(packageId || "");
  if (!match || !DESIGNS.includes(match[1]) || !VARIANTS.includes(match[2])) return null;
  return {
    design: match[1],
    variant: match[2],
    size: "standard",
    elements: match[3] ? ["coverage", "donate", "reserve"] : []
  };
}

function demoStatus(token, url, env) {
  const state = /^demo-(accepting|diverting|full|unavailable)$/.exec(token || "")?.[1];
  if (!state) {
    return new Response(JSON.stringify({ error: { code: "WIDGET_NOT_FOUND", message: "This widget link is no longer active." } }), {
      status: 404, headers: { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS }
    });
  }
  const origin = customerOrigin(env);
  return new Response(JSON.stringify({
    status: state,
    freshness: STATE_FRESHNESS[state],
    link: origin,
    coverage: "East Bay",
    donateLink: `${origin}/#paw-it-forward`,
    poweredByLink: origin,
    package: demoPackage(url.searchParams.get("package")),
    generatedAt: new Date().toISOString()
  }), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS } });
}

/* -------------------------------------------------------------- gallery --- */

const PAGE_CSS = `
  :root { --ink:#111B3B; --paper:#FFFAF0; --muted:#5B6072; --blue:#2357D9; --coral:#F25F4C; --gold:#F7C84B; --line:#D9D8D2; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif; color:var(--ink); background:#f3f1ea; line-height:1.5; }
  .demo-banner { background:var(--ink); color:var(--paper); font-size:13px; padding:8px 16px; text-align:center; }
  .demo-banner a { color:var(--gold); }
  .shell { max-width:1080px; margin:0 auto; padding:0 20px; }
  header.hero { padding:40px 0 10px; }
  header.hero h1 { font-family:Georgia,serif; font-size:34px; margin:0 0 8px; }
  header.hero p { color:var(--muted); max-width:640px; margin:0; }
  .toolbar { position:sticky; top:0; z-index:5; background:rgba(243,241,234,.96); backdrop-filter:blur(4px); padding:14px 0; margin-top:18px; border-bottom:1px solid var(--line); }
  .toolbar .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:8px; }
  .toolbar .row:last-child { margin-bottom:0; }
  .toolbar span.k { font-size:11px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); width:70px; }
  .chip { display:inline-flex; align-items:center; gap:6px; font-size:12.5px; font-weight:600; color:var(--ink); text-decoration:none; background:white; border:1.5px solid var(--line); border-radius:999px; padding:5px 13px; }
  .chip.is-on { border-color:var(--ink); box-shadow:2px 2px 0 var(--ink); }
  .chip i { width:11px; height:11px; border-radius:50%; border:1px solid var(--line); display:inline-block; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(330px, 1fr)); gap:22px; padding:26px 0 10px; }
  .tile { background:white; border:1.5px solid var(--line); border-radius:16px; padding:18px; }
  .tile h3 { font-family:Georgia,serif; margin:0 0 2px; font-size:17px; }
  .tile p.hint { color:var(--muted); font-size:12px; margin:0 0 14px; }
  .tile .mount { min-height:90px; display:flex; align-items:center; }
  .tile .mount > div { flex:1; }
  .tile code { display:block; margin-top:12px; font-size:10.5px; color:var(--muted); word-break:break-all; }
  section.how { background:white; border:1.5px solid var(--line); border-radius:16px; padding:24px; margin:24px 0 48px; }
  section.how h2 { font-family:Georgia,serif; margin:0 0 8px; }
  section.how p { color:var(--muted); font-size:14px; }
  pre.embed { background:#0f172a; color:#e2e8f0; font-size:12.5px; padding:14px 16px; border-radius:10px; overflow-x:auto; }
  .try-real input { padding:8px 10px; border:1px solid var(--line); border-radius:8px; width:min(340px,100%); font-size:13px; }
  .try-real button { padding:8px 14px; border:0; border-radius:8px; background:var(--blue); color:white; font-weight:600; font-size:13px; cursor:pointer; margin-left:6px; }
  footer.site { text-align:center; color:var(--muted); font-size:12px; padding:24px; }
`;

const VARIANT_SWATCH = { cream: "#FFFAF0", ink: "#111B3B", blue: "#E5ECFF", coral: "#FFE5DF", forest: "#E9F7F1" };
const DESIGN_HINT = {
  badge: "An inline pill for a header or footer.",
  card: "The classic status card — the default design.",
  banner: "A wide strip for the top of a page.",
  poster: "A big serif statement with a hard shadow.",
  ticker: "A slim live strip; the whole thing is the link.",
  stack: "One big word: Open, Diverting, Full.",
  window: "A framed storefront sign, centered.",
  paws: "Friendly and conversational, paw icon included.",
  ledger: "Labeled rows — status, updated, coverage.",
  night: "After hours: dark navy, gold-ringed dot."
};

function pick(url, key, allowed, fallback) {
  const value = url.searchParams.get(key) || "";
  return allowed.includes(value) ? value : fallback;
}

function galleryPage(env, url) {
  const state = pick(url, "state", STATES, "accepting");
  const variant = pick(url, "variant", VARIANTS, "cream");
  const accent = pick(url, "accent", ACCENTS, "blue");
  const frame = pick(url, "frame", FRAMES, "ink");
  const rich = url.searchParams.get("elements") === "rich";
  const origin = customerOrigin(env);
  const qs = (overrides) => {
    const params = new URLSearchParams({ state, variant, accent, frame, ...(rich ? { elements: "rich" } : {}) });
    for (const [key, value] of Object.entries(overrides)) {
      if (value === null) params.delete(key); else params.set(key, value);
    }
    const text = params.toString();
    return text ? `/?${text}` : "/";
  };

  const tiles = DESIGNS.map((design) => {
    return `
      <div class="tile">
        <h3>${escapeHtml(DESIGN_LABEL[design])}</h3>
        <p class="hint">${escapeHtml(DESIGN_HINT[design])}</p>
        <div class="mount" id="mount-${design}"></div>
        <code>design: ${design} · variant: ${variant} · accent: ${accent} · frame: ${frame}${rich ? " · elements: coverage, donate, reserve" : ""}</code>
      </div>`;
  }).join("");

  const mounts = DESIGNS.map((design) => {
    const packageId = `pkg-demo.${design}.${variant}.${accent}.${frame}.${rich ? "rich" : "pure"}`;
    return `<script src="/widget.js" data-timi-widget="demo-${state}" data-timi-package="${packageId}" data-timi-mount="#mount-${design}"></script>`;
  }).join("\n  ");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Tími widget gallery</title>
<style>${PAGE_CSS}</style>
</head>
<body>
  <div class="demo-banner">Tími widget gallery — every design below is rendered by the <strong>real embed script</strong> with demo data. See one on a fake clinic site: <a href="/clinic?state=${state}">the in-situ demo</a>.</div>

  <div class="shell">
    <header class="hero">
      <h1>Ten widgets. One live status.</h1>
      <p>Every design carries your live intake status, links pet owners into Tími, and wears a clickable "Powered by Tími" credit. Clinics build the exact one they want — design, color, width, elements — in the provider portal's Widget Studio, which generates the embed code.</p>
    </header>

    <h2>Every design, live</h2>
    <div class="toolbar">
      <div class="row"><span class="k">State</span>${STATES.map((candidate) => `<a class="chip ${candidate === state ? "is-on" : ""}" href="${qs({ state: candidate })}"${candidate === state ? ' aria-current="true"' : ""}>${candidate}</a>`).join("")}</div>
      <div class="row"><span class="k">Variant</span>${VARIANTS.map((candidate) => `<a class="chip ${candidate === variant ? "is-on" : ""}" href="${qs({ variant: candidate })}"${candidate === variant ? ' aria-current="true"' : ""}><i style="background:${VARIANT_SWATCH[candidate]}"></i>${candidate}</a>`).join("")}</div>
      <div class="row"><span class="k">Accent</span>${ACCENTS.map((candidate) => `<a class="chip ${candidate === accent ? "is-on" : ""}" href="${qs({ accent: candidate })}"${candidate === accent ? ' aria-current="true"' : ""}><i style="background:${{ blue: "#2357D9", coral: "#F25F4C", gold: "#F7C84B", green: "#12845D" }[candidate]}"></i>${candidate}</a>`).join("")}</div>
      <div class="row"><span class="k">Frame</span>${FRAMES.map((candidate) => `<a class="chip ${candidate === frame ? "is-on" : ""}" href="${qs({ frame: candidate })}"${candidate === frame ? ' aria-current="true"' : ""}>${candidate}</a>`).join("")}</div>
      <div class="row"><span class="k">Elements</span>
        <a class="chip ${rich ? "" : "is-on"}" href="${qs({ elements: null })}"${rich ? "" : ' aria-current="true"'}>Pure status</a>
        <a class="chip ${rich ? "is-on" : ""}" href="${qs({ elements: "rich" })}"${rich ? ' aria-current="true"' : ""}>+ coverage, donate, reserve</a>
      </div>
    </div>

    <div class="grid">${tiles}</div>

    <section class="how">
      <h2>How a clinic gets one</h2>
      <p>In the provider portal (providers.timinow.pet → Widget studio) an administrator builds the widget, saves it as a <strong>package</strong>, and copies a snippet like this — with their own token, client id, and package id filled in:</p>
      <pre class="embed">&lt;script src="${escapeHtml(origin)}/widget.js"
        data-timi-widget="YOUR_WIDGET_TOKEN"
        data-timi-client="tenant_…"
        data-timi-package="pkg_…"&gt;&lt;/script&gt;</pre>
      <div class="try-real">
        <p style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)">Have a real token? Preview it against production:</p>
        <form method="get" action="/clinic">
          <input type="text" name="token" placeholder="wgt_…" maxlength="200">
          <button type="submit">Preview on the demo site</button>
        </form>
      </div>
    </section>
  </div>

  <footer class="site">Tími NOW widget gallery · demo data only.</footer>

  ${mounts}
</body>
</html>`;
  return new Response(html, { headers: { ...HTML_HEADERS, ...SECURITY_HEADERS } });
}

/* --------------------------------------------------------- clinic page --- */

function clinicPage(env, url) {
  const state = pick(url, "state", STATES, "accepting");
  const rawToken = url.searchParams.get("token") || "";
  const realToken = /^[A-Za-z0-9_\-]{1,200}$/.test(rawToken) ? rawToken : "";
  const origin = customerOrigin(env);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Hearthside Animal Hospital — Tími widget demo</title>
<style>
  ${PAGE_CSS}
  header.site { background:white; border-bottom:1px solid var(--line); padding:18px 24px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; }
  .clinic-name { font-family:Georgia,serif; font-size:24px; margin:0; }
  .clinic-name small { display:block; font-size:12px; color:var(--muted); font-weight:normal; }
  nav.fake a { color:var(--muted); text-decoration:none; margin-left:18px; font-size:14px; }
  .hero2 { background:white; padding:44px 24px; border-bottom:1px solid var(--line); }
  .hero2 h2 { font-family:Georgia,serif; font-size:32px; margin:0 0 10px; }
  .hero2 p { color:var(--muted); max-width:520px; margin:0; }
  main.clinic { display:grid; grid-template-columns:1fr 320px; gap:28px; max-width:960px; margin:32px auto; padding:0 24px; }
  @media (max-width:760px){ main.clinic { grid-template-columns:1fr; } }
  .slot-label { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); margin:0 0 6px; }
</style>
</head>
<body>
  <div class="demo-banner">A <strong>fictional clinic website</strong> showing the widget in situ. Back to <a href="/">the design gallery</a>.</div>
  <header class="site">
    <h1 class="clinic-name">Hearthside Animal Hospital <small>Fictional practice · demo only</small></h1>
    <nav class="fake" aria-hidden="true"><a href="#" tabindex="-1">Services</a><a href="#" tabindex="-1">Our team</a><a href="#" tabindex="-1">Contact</a></nav>
  </header>
  <div class="hero2"><div class="shell">
    <h2>Caring for your pets, seven days a week.</h2>
    <p>Urgent-care appointments, dental cleanings, and wellness exams. Walk-ins welcome when capacity allows — check our live status.</p>
  </div></div>
  <main class="clinic">
    <div>
      <h3 style="font-family:Georgia,serif">Welcome</h3>
      <p style="color:var(--muted)">This column stands in for the clinic's own content — the point is the card on the right: the real embed script, one line of HTML, live status. Switch its state from the gallery's toolbar (<a href="/?state=${state}">back to gallery</a>).</p>
    </div>
    <aside>
      <p class="slot-label">Live status (demo data)</p>
      <div id="sidebar-widget"></div>
      ${realToken ? `<p class="slot-label" style="margin-top:14px">Your real token (production data)</p><div id="real-widget"></div>` : ""}
    </aside>
  </main>
  <footer class="site">Tími NOW widget demo · nothing on this page is a real veterinary practice.</footer>
  <script src="/widget.js" data-timi-widget="demo-${state}" data-timi-package="pkg-demo-card-cream-rich" data-timi-mount="#sidebar-widget"></script>
  ${realToken ? `<script src="${escapeHtml(origin)}/widget.js" data-timi-widget="${escapeHtml(realToken)}" data-timi-mount="#real-widget"></script>` : ""}
</body>
</html>`;
  return new Response(html, { headers: { ...HTML_HEADERS, ...SECURITY_HEADERS } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    if (url.pathname === "/api/health") {
      return new Response(JSON.stringify({ ok: true, service: "timinow-widget-demo", build: env.GIT_SHA || null }), {
        headers: { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS }
      });
    }
    if (url.pathname === "/widget.js") return serveWidgetScript(env);
    const statusMatch = url.pathname.match(/^\/api\/widget\/([^/]+)\/status$/);
    if (statusMatch) return demoStatus(decodeURIComponent(statusMatch[1]), url, env);
    if (url.pathname === "/clinic") return clinicPage(env, url);
    if (url.pathname === "/") return galleryPage(env, url);
    return new Response("Not found", { status: 404, headers: SECURITY_HEADERS });
  }
};
