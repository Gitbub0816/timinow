/**
 * Widget demo — a fake clinic website with the Tími availability widget on it.
 *
 * Exists so anyone can see what the embed looks like in situ without owning a
 * clinic website or minting a token: a fictional practice homepage
 * ("Hearthside Animal Hospital", clearly labeled a demo) with the widget in
 * the sidebar, plus all four states side by side.
 *
 * Three routes, nothing else:
 *   GET /                      the demo page
 *   GET /widget.js             the REAL embed script, proxied from the
 *                              customer Worker so this page always previews
 *                              the exact bytes a clinic would embed — no
 *                              copy to drift.
 *   GET /api/widget/:t/status  fake statuses for the four demo tokens. The
 *                              embed script calls the origin it was served
 *                              from, which is this Worker, so the demo needs
 *                              no real token and touches no real data. The
 *                              response shape mirrors buildStatusPayload in
 *                              src/widget.js.
 *
 * No database, no auth, no cookies, no state.
 */

const CUSTOMER_ORIGIN_FALLBACK = "https://timinow.pet";

const DEMO_STATUSES = {
  "demo-accepting": { status: "accepting", freshness: "Updated in the last hour" },
  "demo-diverting": { status: "diverting", freshness: "Updated in the last hour" },
  "demo-full": { status: "full", freshness: "Updated today" },
  "demo-unavailable": { status: "unavailable", freshness: null }
};

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
const SECURITY_HEADERS = {
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex"
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
 * edge for ten minutes. If the fetch fails the page still loads — the mounts
 * just stay empty, exactly like a clinic site would behave offline. */
async function serveWidgetScript(env) {
  try {
    const response = await fetch(`${customerOrigin(env)}/widget.js`, {
      cf: { cacheTtl: 600, cacheEverything: true }
    });
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

function demoStatus(token, env) {
  const demo = DEMO_STATUSES[token];
  if (!demo) {
    return new Response(JSON.stringify({ error: { code: "WIDGET_NOT_FOUND", message: "This widget link is no longer active." } }), {
      status: 404, headers: { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS }
    });
  }
  return new Response(JSON.stringify({
    status: demo.status,
    freshness: demo.freshness,
    link: customerOrigin(env),
    generatedAt: new Date().toISOString()
  }), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS } });
}

function demoPage(env, url) {
  // ?token=… previews a REAL token: that card's script loads from the
  // customer Worker, so its status comes from production. Constrained to the
  // real token alphabet so nothing else can ride into the attribute.
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
  :root { --ink:#111B3B; --paper:#FFFAF0; --muted:#6F7483; --blue:#2357D9; --coral:#F25F4C; --line:#D9D8D2; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif; color:var(--ink); background:#f6f4ee; line-height:1.55; }
  .demo-banner { background:var(--ink); color:var(--paper); font-size:13px; padding:8px 16px; text-align:center; }
  .demo-banner strong { color:#F7C84B; }
  header.site { background:white; border-bottom:1px solid var(--line); padding:18px 24px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; }
  .clinic-name { font-family:Georgia,serif; font-size:24px; margin:0; }
  .clinic-name small { display:block; font-family:inherit; font-size:12px; color:var(--muted); font-weight:normal; }
  nav.fake a { color:var(--muted); text-decoration:none; margin-left:18px; font-size:14px; }
  .hero { background:white; padding:48px 24px; border-bottom:1px solid var(--line); }
  .shell { max-width:960px; margin:0 auto; }
  .hero h2 { font-family:Georgia,serif; font-size:34px; margin:0 0 10px; }
  .hero p { color:var(--muted); max-width:520px; margin:0; }
  main { display:grid; grid-template-columns: 1fr 300px; gap:28px; max-width:960px; margin:32px auto; padding:0 24px; }
  @media (max-width:760px){ main { grid-template-columns:1fr; } }
  .content h3 { font-family:Georgia,serif; }
  .content p { color:var(--muted); }
  aside .widget-slot { margin-bottom:14px; }
  .slot-label { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); margin:0 0 6px; }
  section.states { max-width:960px; margin:16px auto 48px; padding:24px; background:white; border:1px solid var(--line); border-radius:14px; }
  section.states h3 { font-family:Georgia,serif; margin-top:0; }
  .state-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); gap:18px; }
  pre.embed { background:#0f172a; color:#e2e8f0; font-size:12.5px; padding:14px 16px; border-radius:10px; overflow-x:auto; }
  .try-real { margin-top:18px; padding-top:18px; border-top:1px solid var(--line); }
  .try-real input { padding:8px 10px; border:1px solid var(--line); border-radius:8px; width:min(340px, 100%); font-size:13px; }
  .try-real button { padding:8px 14px; border:0; border-radius:8px; background:var(--blue); color:white; font-weight:600; font-size:13px; cursor:pointer; margin-left:6px; }
  footer.site { text-align:center; color:var(--muted); font-size:12px; padding:24px; }
</style>
</head>
<body>
  <div class="demo-banner">This is a <strong>Tími demo</strong> — a fictional clinic website showing how the availability widget looks embedded on a practice's own site.</div>

  <header class="site">
    <h1 class="clinic-name">Hearthside Animal Hospital <small>Fictional practice · demo only</small></h1>
    <nav class="fake" aria-hidden="true"><a href="#">Services</a><a href="#">Our team</a><a href="#">Contact</a></nav>
  </header>

  <div class="hero"><div class="shell">
    <h2>Caring for your pets, seven days a week.</h2>
    <p>Urgent-care appointments, dental cleanings, and wellness exams for dogs, cats, and pocket pets. Walk-ins welcome when capacity allows — check our live status.</p>
  </div></div>

  <main>
    <div class="content">
      <h3>Welcome</h3>
      <p>This column stands in for the clinic's own content — the point of the page is the card on the right: a real Tími widget, rendered by the exact same script a clinic pastes into its site, one line of HTML with a token.</p>
      <p>The card updates from the clinic's published intake status, shows how fresh that status is, and hands pet owners a "Request care" path when the practice is accepting. It never shows capacity numbers or anything about other customers.</p>
    </div>
    <aside>
      <p class="slot-label">Live status (demo data)</p>
      <div class="widget-slot" id="sidebar-widget"></div>
      ${realToken ? `<p class="slot-label">Your real token</p><div class="widget-slot" id="real-widget"></div>` : ""}
    </aside>
  </main>

  <section class="states"><div>
    <h3>All four states</h3>
    <div class="state-grid">
      <div><p class="slot-label">Accepting</p><div id="state-accepting"></div></div>
      <div><p class="slot-label">Diverting</p><div id="state-diverting"></div></div>
      <div><p class="slot-label">At capacity</p><div id="state-full"></div></div>
      <div><p class="slot-label">Status unavailable</p><div id="state-unavailable"></div></div>
    </div>

    <h3 style="margin-top:28px;">The embed a clinic actually pastes</h3>
    <pre class="embed">&lt;script src="${escapeHtml(origin)}/widget.js"
        data-timi-widget="YOUR_TOKEN"&gt;&lt;/script&gt;</pre>
    <p style="color:var(--muted); font-size:13px;">Tokens are minted in the clinic console (Settings → Website widget) and can be pinned to the clinic's own domain. Full details in docs/WIDGET.md.</p>

    <div class="try-real">
      <p class="slot-label">Have a real token? Preview it against production:</p>
      <form method="get">
        <input type="text" name="token" placeholder="wgt_…" value="${escapeHtml(realToken)}" maxlength="200">
        <button type="submit">Preview</button>
      </form>
    </div>
  </div></section>

  <footer class="site">Tími NOW widget demo · nothing on this page is a real veterinary practice.</footer>

  <!-- Demo cards: the script is served by THIS Worker, so its status calls
       land on the fake /api/widget/:token/status routes above. -->
  <script src="/widget.js" data-timi-widget="demo-accepting" data-timi-mount="#sidebar-widget"></script>
  <script src="/widget.js" data-timi-widget="demo-accepting" data-timi-mount="#state-accepting"></script>
  <script src="/widget.js" data-timi-widget="demo-diverting" data-timi-mount="#state-diverting"></script>
  <script src="/widget.js" data-timi-widget="demo-full" data-timi-mount="#state-full"></script>
  <script src="/widget.js" data-timi-widget="demo-unavailable" data-timi-mount="#state-unavailable"></script>
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
    if (statusMatch) return demoStatus(decodeURIComponent(statusMatch[1]), env);
    if (url.pathname === "/") return demoPage(env, url);
    return new Response("Not found", { status: 404, headers: SECURITY_HEADERS });
  }
};
