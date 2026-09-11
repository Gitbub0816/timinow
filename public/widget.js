/**
 * Tími clinic availability widget — embed script, v2.
 *
 * A clinic pastes this onto its own public website (snippets are generated
 * by the Widget Studio in the provider portal):
 *
 *   <script src="https://timinow.pet/widget.js"
 *           data-timi-widget="wgt_…"        (widget token — the API key)
 *           data-timi-client="tenant_…"     (tenant/client id)
 *           data-timi-package="pkg_…"></script>
 *
 * The package id names a design saved in the Studio: one of ten layouts, a
 * color variant, a width, optional Tími elements (coverage line, Paw It
 * Forward donate button, reserve CTA), and a fine-tuning options layer —
 * accent color, corner shape, frame weight, hard shadow, text scale,
 * alignment, a custom heading, and a freshness toggle. The server resolves
 * the package — this script never trusts a package id by itself — and an
 * unknown or revoked package renders the default design rather than
 * nothing.
 *
 * Brand rules baked in here:
 *   - Every design carries a visible, CLICKABLE "Powered by Tími" credit.
 *     It is rendered unconditionally; there is no configuration that removes
 *     it, and hiding it is a violation of the widget terms (docs/WIDGET.md).
 *   - No emoji anywhere — status is an SVG dot plus words.
 *   - The default look is Tími's own: ink frames, hard offset shadows,
 *     Georgia serif display lines, paper cream. The options layer can relax
 *     it (hairline frame, no shadow) but never un-brand it.
 *
 * Security stance unchanged from v1: no cookies, nothing collected from the
 * visitor, and every DOM node is built with createElement/textContent —
 * never innerHTML — so nothing the status endpoint returns can execute as
 * markup even if it were compromised. The custom heading is free text from
 * the clinic's own Studio; it renders through textContent like everything
 * else.
 *
 * The Studio and the demo gallery render previews through the same code:
 * `window.TimiWidget.render(container, data, config)` draws any design from
 * data already in hand, no fetch — so a preview is pixel-identical to the
 * real embed by construction.
 */
(function () {
  "use strict";

  /* ------------------------------------------------------------ palette --- */

  var STATUS_COLOR = {
    accepting: "#12845D",
    diverting: "#B7791F",
    full: "#BD3E31",
    unavailable: "#6F7483"
  };

  var COPY = {
    accepting: {
      label: "Accepting urgent patients",
      short: "Open for urgent care",
      word: "Open",
      poster: "We can see you now.",
      friendly: "We have room for urgent visits right now.",
      cta: "Request care"
    },
    diverting: {
      label: "Diverting right now",
      short: "Diverting right now",
      word: "Diverting",
      poster: "We’re helping you find care.",
      friendly: "We’re full, but care is close by — let us route you.",
      cta: "Find available care"
    },
    full: {
      label: "At capacity right now",
      short: "At capacity",
      word: "Full",
      poster: "We’re at capacity.",
      friendly: "Every table is taken right now — nearby teams may have room.",
      cta: "Find available care"
    },
    unavailable: {
      label: "Status unavailable",
      short: "Status unavailable",
      word: "—",
      poster: "Checking our status…",
      friendly: "We can’t show a live status right now.",
      cta: "Check availability"
    }
  };

  var DESIGNS = ["badge", "card", "banner", "poster", "ticker", "stack", "window", "paws", "ledger", "night"];
  var VARIANTS = ["cream", "ink", "blue", "coral", "forest"];
  var SIZES = { compact: "240px", standard: "320px", full: "none" };

  // The fine-tuning layer. Vocabularies mirror src/widget.js server-side;
  // anything unknown lands on the default so a stale embed keeps rendering.
  var OPTION_VOCAB = {
    accent: ["blue", "coral", "gold", "green"],
    corners: ["sharp", "rounded", "pill"],
    frame: ["hairline", "ink", "bold"],
    shadow: ["none", "hard"],
    scale: ["cozy", "standard", "roomy"],
    align: ["left", "center"]
  };
  var OPTION_DEFAULTS = { accent: "blue", corners: "rounded", frame: "ink", shadow: "hard", scale: "standard", align: "left" };
  var SCALE_ZOOM = { cozy: "0.9", standard: "1", roomy: "1.12" };

  /* ---------------------------------------------------------------- css --- */

  var STYLE_ID = "timi-widget-style-v2";
  var SERIF = "Georgia,'Times New Roman',serif";
  var SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif";

  var STYLE_TEXT = [
    // Root: option tokens first (frame, radius, shadow), then variants.
    ".timi-w{font-family:", SANS, ";box-sizing:border-box;line-height:1.45;color:var(--tw-fg);display:block;text-align:left;",
    "--tw-radius:14px;--tw-framew:2px;--tw-framec:var(--tw-fg);--tw-shadow:4px 4px 0 var(--tw-framec)}",
    ".timi-w *{box-sizing:border-box;margin:0;padding:0}",
    ".timi-w--cream{--tw-bg:#FFFAF0;--tw-fg:#111B3B;--tw-muted:#6F7483;--tw-line:#D9D8D2;--tw-accent:#2357D9;--tw-btn:#2357D9;--tw-btnfg:#FFFAF0;--tw-soft:#F3F5FA}",
    ".timi-w--ink{--tw-bg:#111B3B;--tw-fg:#FFFAF0;--tw-muted:rgba(255,250,240,.66);--tw-line:rgba(255,250,240,.22);--tw-accent:#F7C84B;--tw-btn:#F25F4C;--tw-btnfg:#FFFAF0;--tw-soft:#1A2750}",
    ".timi-w--blue{--tw-bg:#E5ECFF;--tw-fg:#111B3B;--tw-muted:#3F4862;--tw-line:#B9C6EE;--tw-accent:#173C9A;--tw-btn:#2357D9;--tw-btnfg:#FFFAF0;--tw-soft:#F4F7FF}",
    ".timi-w--coral{--tw-bg:#FFE5DF;--tw-fg:#111B3B;--tw-muted:#7A4A42;--tw-line:#F0BDB2;--tw-accent:#BD3E31;--tw-btn:#F25F4C;--tw-btnfg:#FFFAF0;--tw-soft:#FFF4F1}",
    ".timi-w--forest{--tw-bg:#E9F7F1;--tw-fg:#0C3B2B;--tw-muted:#4A6E60;--tw-line:#BCE0D0;--tw-accent:#12845D;--tw-btn:#12845D;--tw-btnfg:#FFFAF0;--tw-soft:#F4FBF8}",

    // Option modifiers — declared AFTER the variants so accents override the
    // variant's own button color at equal specificity.
    ".timi-wo-accent-blue{--tw-accent:#2357D9;--tw-btn:#2357D9;--tw-btnfg:#FFFAF0}",
    ".timi-wo-accent-coral{--tw-accent:#BD3E31;--tw-btn:#F25F4C;--tw-btnfg:#FFFAF0}",
    ".timi-wo-accent-gold{--tw-accent:#B7791F;--tw-btn:#F7C84B;--tw-btnfg:#111B3B}",
    ".timi-wo-accent-green{--tw-accent:#12845D;--tw-btn:#12845D;--tw-btnfg:#FFFAF0}",
    ".timi-wo-frame-hairline{--tw-framew:1.5px;--tw-framec:var(--tw-line);--tw-shadow:4px 4px 0 rgba(17,27,59,.14)}",
    ".timi-wo-frame-ink{--tw-framew:2px;--tw-framec:var(--tw-fg)}",
    ".timi-wo-frame-bold{--tw-framew:3px;--tw-framec:var(--tw-fg)}",
    ".timi-wo-shadow-none{--tw-shadow:none}",
    ".timi-wo-corners-sharp{--tw-radius:4px}",
    ".timi-wo-corners-rounded{--tw-radius:14px}",
    ".timi-wo-corners-pill{--tw-radius:22px}",
    ".timi-wo-align-center{text-align:center}",
    ".timi-wo-align-center .timi-w-status,.timi-wo-align-center .timi-w-actions,.timi-wo-align-center .timi-w-links{justify-content:center}",
    ".timi-wo-align-center .timi-wd--paws{flex-direction:column;align-items:center}",

    // Shared atoms.
    ".timi-w-dot{display:inline-block;flex:none;border-radius:50%}",
    ".timi-w-cta{display:inline-block;font-size:13px;font-weight:800;text-decoration:none;color:var(--tw-btnfg);background:var(--tw-btn);border:var(--tw-framew) solid var(--tw-framec);border-radius:calc(var(--tw-radius) - 4px);padding:9px 16px}",
    ".timi-w-cta:hover{filter:brightness(.92)}",
    ".timi-w-donate{display:inline-block;font-size:12px;font-weight:800;text-decoration:none;color:#111B3B;background:#F7C84B;border:var(--tw-framew) solid var(--tw-framec);border-radius:calc(var(--tw-radius) - 4px);padding:7px 13px}",
    ".timi-w-donate:hover{filter:brightness(.95)}",
    ".timi-w-powered{display:inline-block;font-size:10.5px;letter-spacing:.02em;color:var(--tw-muted);text-decoration:none}",
    ".timi-w-powered:hover{color:var(--tw-accent);text-decoration:underline}",
    ".timi-w-powered strong{font-family:", SERIF, ";font-weight:700;font-size:12px;letter-spacing:0}",
    ".timi-w-fresh{font-size:11.5px;color:var(--tw-muted)}",
    ".timi-w-coverage{font-size:11.5px;color:var(--tw-muted)}",
    ".timi-w-eyebrow{font-size:10px;font-weight:800;letter-spacing:.11em;text-transform:uppercase;color:var(--tw-muted)}",
    "@keyframes timi-w-pulse{0%{box-shadow:0 0 0 0 rgba(18,132,93,.45)}70%{box-shadow:0 0 0 7px rgba(18,132,93,0)}100%{box-shadow:0 0 0 0 rgba(18,132,93,0)}}",

    // 1 · badge — an inline pill. Pills keep their shape and skip the shadow.
    ".timi-wd--badge{display:inline-flex;align-items:center;gap:8px;background:var(--tw-bg);border:var(--tw-framew) solid var(--tw-framec);border-radius:999px;padding:7px 13px;font-size:12.5px;font-weight:700;text-decoration:none;color:var(--tw-fg)}",
    ".timi-wd--badge .timi-w-powered{border-left:1px solid var(--tw-line);padding-left:8px}",

    // 2 · card — the classic status card, serif headline, hard shadow.
    ".timi-wd--card{background:var(--tw-bg);border:var(--tw-framew) solid var(--tw-framec);border-radius:var(--tw-radius);box-shadow:var(--tw-shadow);padding:16px 17px}",
    ".timi-wd--card .timi-w-status{display:flex;align-items:center;gap:9px;font-family:", SERIF, ";font-size:17.5px;font-weight:700;margin:7px 0 4px}",
    ".timi-wd--card .timi-w-actions{display:flex;flex-wrap:wrap;gap:8px;margin:11px 0 9px}",

    // 3 · banner — a horizontal strip.
    ".timi-wd--banner{background:var(--tw-bg);border:var(--tw-framew) solid var(--tw-framec);border-radius:var(--tw-radius);box-shadow:var(--tw-shadow);padding:12px 16px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}",
    ".timi-wd--banner .timi-w-main{flex:1;min-width:150px}",
    ".timi-wd--banner .timi-w-status{display:flex;align-items:center;gap:8px;font-family:", SERIF, ";font-size:16px;font-weight:700}",
    ".timi-wd--banner .timi-w-side{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",

    // 4 · poster — serif display, the loudest brand statement.
    ".timi-wd--poster{background:var(--tw-bg);border:var(--tw-framew) solid var(--tw-framec);border-radius:var(--tw-radius);box-shadow:var(--tw-shadow);padding:22px 20px}",
    ".timi-wd--poster .timi-w-head{font-family:", SERIF, ";font-size:25px;line-height:1.12;font-weight:700;margin:8px 0 6px}",
    ".timi-wd--poster .timi-w-actions{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 10px}",

    // 5 · ticker — a slim live strip; the whole thing is the link.
    ".timi-wd--ticker{display:flex;align-items:center;gap:9px;background:var(--tw-bg);border:var(--tw-framew) solid var(--tw-framec);border-radius:999px;padding:9px 15px;text-decoration:none;color:var(--tw-fg);font-size:12.5px;font-weight:700}",
    ".timi-wd--ticker .timi-w-fresh{margin-left:2px}",
    ".timi-wd--ticker .timi-w-powered{margin-left:auto;padding-left:10px}",
    ".timi-wd--ticker .timi-w-dot--live{animation:timi-w-pulse 2.2s infinite}",

    // 6 · stack — a stat tile.
    ".timi-wd--stack{background:var(--tw-bg);border:var(--tw-framew) solid var(--tw-framec);border-radius:var(--tw-radius);box-shadow:var(--tw-shadow);padding:17px;text-align:center}",
    ".timi-wd--stack .timi-w-word{font-family:", SERIF, ";font-size:36px;font-weight:700;line-height:1.05;margin:7px 0 3px}",
    ".timi-wd--stack .timi-w-links{margin:10px 0 8px;display:flex;justify-content:center;gap:12px;flex-wrap:wrap}",
    ".timi-wd--stack .timi-w-textlink{font-size:12.5px;font-weight:800;color:var(--tw-accent);text-decoration:underline}",

    // 7 · window — a storefront sign: double frame, centered serif.
    ".timi-wd--window{background:var(--tw-bg);border:var(--tw-framew) solid var(--tw-framec);border-radius:calc(var(--tw-radius) / 2);box-shadow:var(--tw-shadow);padding:6px}",
    ".timi-wd--window .timi-w-inner{border:1px solid var(--tw-line);border-radius:3px;padding:18px 15px;text-align:center}",
    ".timi-wd--window .timi-w-sign{font-family:", SERIF, ";font-size:19px;font-weight:700;margin:6px 0 2px;padding-bottom:5px;display:inline-block;border-bottom:3px solid var(--tw-statuscolor,var(--tw-accent))}",

    // 8 · paws — friendly, icon-led.
    ".timi-wd--paws{background:var(--tw-bg);border:var(--tw-framew) solid var(--tw-framec);border-radius:var(--tw-radius);box-shadow:var(--tw-shadow);padding:15px 16px;display:flex;gap:13px;align-items:flex-start}",
    ".timi-wd--paws .timi-w-pawtile{flex:none;width:44px;height:44px;border-radius:calc(var(--tw-radius) - 2px);background:var(--tw-soft);border:1.5px solid var(--tw-line);display:flex;align-items:center;justify-content:center}",
    ".timi-wd--paws .timi-w-friendly{font-family:", SERIF, ";font-size:15px;font-weight:700;line-height:1.35;margin:1px 0 4px}",
    ".timi-wd--paws .timi-w-actions{display:flex;flex-wrap:wrap;gap:8px;margin:9px 0 7px}",

    // 9 · ledger — labeled rows with dotted leaders.
    ".timi-wd--ledger{background:var(--tw-bg);border:var(--tw-framew) solid var(--tw-framec);border-radius:var(--tw-radius);box-shadow:var(--tw-shadow);padding:15px 16px}",
    ".timi-wd--ledger .timi-w-row{display:flex;align-items:baseline;gap:8px;font-size:12.5px;padding:5px 0}",
    ".timi-wd--ledger .timi-w-row+.timi-w-row{border-top:1px dotted var(--tw-line)}",
    ".timi-wd--ledger .timi-w-key{font-size:10px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:var(--tw-muted);flex:none}",
    ".timi-wd--ledger .timi-w-val{margin-left:auto;font-weight:700;display:flex;align-items:center;gap:7px;text-align:right}",
    ".timi-wd--ledger .timi-w-actions{display:flex;flex-wrap:wrap;gap:8px;margin:11px 0 8px}",

    // 10 · night — after-hours: always dark, gold-ringed dot; the accent
    // option still recolors its button.
    ".timi-wd--night{background:#0B1229;border:var(--tw-framew) solid #273258;border-radius:var(--tw-radius);box-shadow:var(--tw-shadow);--tw-framec:#273258;--tw-fg:#FFFAF0;--tw-muted:rgba(255,250,240,.6);--tw-line:rgba(255,250,240,.16);--tw-soft:#141D3D;color:#FFFAF0;padding:18px}",
    ".timi-wd--night .timi-w-head{font-family:", SERIF, ";font-size:19px;font-weight:700;margin:8px 0 3px}",
    ".timi-wd--night .timi-w-dotring{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;border:1.5px solid #F7C84B}",
    ".timi-wd--night .timi-w-actions{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 9px}"
  ].join("");

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    // Static, hard-coded CSS only — never built from data this script fetched.
    style.textContent = STYLE_TEXT;
    document.head.appendChild(style);
  }

  /* -------------------------------------------------------------- pieces --- */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function statusOf(data) {
    return COPY[data && data.status] ? data.status : "unavailable";
  }

  function dot(status, size, live) {
    var node = el("span", "timi-w-dot" + (live && status === "accepting" ? " timi-w-dot--live" : ""));
    node.style.width = size + "px";
    node.style.height = size + "px";
    node.style.background = STATUS_COLOR[status];
    return node;
  }

  /** A small paw, drawn rather than typed — no emoji in the brand. */
  function pawIcon(color) {
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "24");
    svg.setAttribute("height", "24");
    svg.setAttribute("aria-hidden", "true");
    var parts = [
      ["ellipse", { cx: "7", cy: "8.4", rx: "2.1", ry: "2.7" }],
      ["ellipse", { cx: "12", cy: "6.8", rx: "2.1", ry: "2.7" }],
      ["ellipse", { cx: "17", cy: "8.4", rx: "2.1", ry: "2.7" }],
      ["path", { d: "M12 11c-3.4 0-6.2 2.5-6.2 5.2 0 1.7 1.3 2.8 3 2.8 1.2 0 2-.5 3.2-.5s2 .5 3.2.5c1.7 0 3-1.1 3-2.8C18.2 13.5 15.4 11 12 11z" }]
    ];
    for (var i = 0; i < parts.length; i++) {
      var shape = document.createElementNS(NS, parts[i][0]);
      var attrs = parts[i][1];
      for (var key in attrs) shape.setAttribute(key, attrs[key]);
      shape.setAttribute("fill", color);
      svg.appendChild(shape);
    }
    return svg;
  }

  function link(href, className, text) {
    var a = document.createElement("a");
    a.className = className;
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    if (text) a.textContent = text;
    return a;
  }

  /** The mandatory credit. Rendered by every design, always clickable. */
  function powered(data, fallbackOrigin) {
    var a = link((data && data.poweredByLink) || fallbackOrigin || "https://timinow.pet", "timi-w-powered");
    a.appendChild(document.createTextNode("Powered by "));
    a.appendChild(el("strong", null, "Tími"));
    return a;
  }

  function ctaHref(data, fallbackOrigin) {
    return (data && data.link) || fallbackOrigin || "https://timinow.pet";
  }

  function hasElement(config, name) {
    return config && config.elements && config.elements.indexOf(name) !== -1;
  }

  function ctaLabel(status, config) {
    if (hasElement(config, "reserve") && status === "accepting") return "Reserve a spot";
    return COPY[status].cta;
  }

  /** The clinic's custom heading (Studio options) or the design's own. */
  function eyebrowText(config, fallback) {
    var heading = config && config.options && config.options.heading;
    return heading ? String(heading).slice(0, 40) : fallback;
  }

  function freshnessNode(data, config, className) {
    if (config && config.options && config.options.showFreshness === false) return null;
    if (!data || !data.freshness) return null;
    return el("div", className || "timi-w-fresh", data.freshness);
  }

  function maybeCoverage(data, config) {
    if (!hasElement(config, "coverage") || !data || !data.coverage) return null;
    return el("span", "timi-w-coverage", "Serving the " + data.coverage + " area");
  }

  function maybeDonate(data, config) {
    if (!hasElement(config, "donate") || !data || !data.donateLink) return null;
    return link(data.donateLink, "timi-w-donate", "Give to Paw It Forward");
  }

  /* ------------------------------------------------------------- designs --- */
  /* Each returns the design's root node. `data` is the status payload,
     `config` the resolved package, `origin` the script's own origin. */

  var RENDERERS = {
    badge: function (data, config, origin) {
      var status = statusOf(data);
      var root = link(ctaHref(data, origin), "timi-w-badgelink timi-wd--badge");
      root.appendChild(dot(status, 9, true));
      root.appendChild(el("span", null, COPY[status].short));
      root.appendChild(powered(data, origin));
      return root;
    },

    card: function (data, config, origin) {
      var status = statusOf(data);
      var root = el("div", "timi-wd--card");
      root.appendChild(el("span", "timi-w-eyebrow", eyebrowText(config, "Live intake status")));
      var line = el("div", "timi-w-status");
      line.appendChild(dot(status, 11, true));
      line.appendChild(el("span", null, COPY[status].label));
      root.appendChild(line);
      var fresh = freshnessNode(data, config);
      if (fresh) root.appendChild(fresh);
      var coverage = maybeCoverage(data, config);
      if (coverage) { root.appendChild(el("div")).appendChild(coverage); }
      var actions = el("div", "timi-w-actions");
      actions.appendChild(link(ctaHref(data, origin), "timi-w-cta", ctaLabel(status, config)));
      var donate = maybeDonate(data, config);
      if (donate) actions.appendChild(donate);
      root.appendChild(actions);
      root.appendChild(powered(data, origin));
      return root;
    },

    banner: function (data, config, origin) {
      var status = statusOf(data);
      var root = el("div", "timi-wd--banner");
      var main = el("div", "timi-w-main");
      var line = el("div", "timi-w-status");
      line.appendChild(dot(status, 10, true));
      line.appendChild(el("span", null, COPY[status].label));
      main.appendChild(line);
      var fresh = freshnessNode(data, config);
      if (fresh) main.appendChild(fresh);
      var coverage = maybeCoverage(data, config);
      if (coverage) main.appendChild(coverage);
      main.appendChild(el("div")).appendChild(powered(data, origin));
      root.appendChild(main);
      var side = el("div", "timi-w-side");
      side.appendChild(link(ctaHref(data, origin), "timi-w-cta", ctaLabel(status, config)));
      var donate = maybeDonate(data, config);
      if (donate) side.appendChild(donate);
      root.appendChild(side);
      return root;
    },

    poster: function (data, config, origin) {
      var status = statusOf(data);
      var root = el("div", "timi-wd--poster");
      var line = el("div", "timi-w-status");
      line.style.display = "flex";
      line.style.alignItems = "center";
      line.style.gap = "8px";
      line.appendChild(dot(status, 11, true));
      line.appendChild(el("span", "timi-w-eyebrow", eyebrowText(config, "Live intake status")));
      root.appendChild(line);
      root.appendChild(el("div", "timi-w-head", COPY[status].poster));
      var fresh = freshnessNode(data, config);
      if (fresh) root.appendChild(fresh);
      var coverage = maybeCoverage(data, config);
      if (coverage) root.appendChild(coverage);
      var actions = el("div", "timi-w-actions");
      actions.appendChild(link(ctaHref(data, origin), "timi-w-cta", ctaLabel(status, config)));
      var donate = maybeDonate(data, config);
      if (donate) actions.appendChild(donate);
      root.appendChild(actions);
      root.appendChild(powered(data, origin));
      return root;
    },

    ticker: function (data, config, origin) {
      var status = statusOf(data);
      var root = link(ctaHref(data, origin), "timi-wd--ticker");
      root.appendChild(dot(status, 9, true));
      root.appendChild(el("span", null, COPY[status].short));
      var fresh = freshnessNode(data, config, "timi-w-fresh");
      if (fresh) { fresh.textContent = "· " + fresh.textContent; root.appendChild(fresh); }
      root.appendChild(powered(data, origin));
      return root;
    },

    stack: function (data, config, origin) {
      var status = statusOf(data);
      var root = el("div", "timi-wd--stack");
      root.appendChild(el("span", "timi-w-eyebrow", eyebrowText(config, "Intake status")));
      var word = el("div", "timi-w-word", COPY[status].word);
      word.style.color = STATUS_COLOR[status];
      root.appendChild(word);
      var fresh = freshnessNode(data, config);
      if (fresh) root.appendChild(fresh);
      var coverage = maybeCoverage(data, config);
      if (coverage) root.appendChild(coverage);
      var links = el("div", "timi-w-links");
      links.appendChild(link(ctaHref(data, origin), "timi-w-textlink", ctaLabel(status, config)));
      var donate = maybeDonate(data, config);
      if (donate) links.appendChild(donate);
      root.appendChild(links);
      root.appendChild(powered(data, origin));
      return root;
    },

    window: function (data, config, origin) {
      var status = statusOf(data);
      var root = el("div", "timi-wd--window");
      root.style.setProperty("--tw-statuscolor", STATUS_COLOR[status]);
      var inner = el("div", "timi-w-inner");
      inner.appendChild(el("span", "timi-w-eyebrow", eyebrowText(config, "Today at this clinic")));
      inner.appendChild(el("div"));
      inner.appendChild(el("div", "timi-w-sign", COPY[status].label));
      var fresh = freshnessNode(data, config);
      if (fresh) inner.appendChild(fresh);
      var coverage = maybeCoverage(data, config);
      if (coverage) inner.appendChild(coverage);
      var actions = el("div");
      actions.style.margin = "11px 0 8px";
      actions.appendChild(link(ctaHref(data, origin), "timi-w-cta", ctaLabel(status, config)));
      var donate = maybeDonate(data, config);
      if (donate) { donate.style.marginLeft = "8px"; actions.appendChild(donate); }
      inner.appendChild(actions);
      inner.appendChild(powered(data, origin));
      root.appendChild(inner);
      return root;
    },

    paws: function (data, config, origin) {
      var status = statusOf(data);
      var root = el("div", "timi-wd--paws");
      var tile = el("div", "timi-w-pawtile");
      tile.appendChild(pawIcon(STATUS_COLOR[status]));
      root.appendChild(tile);
      var body = el("div");
      body.appendChild(el("div", "timi-w-friendly", COPY[status].friendly));
      var fresh = freshnessNode(data, config);
      if (fresh) body.appendChild(fresh);
      var coverage = maybeCoverage(data, config);
      if (coverage) body.appendChild(coverage);
      var actions = el("div", "timi-w-actions");
      actions.appendChild(link(ctaHref(data, origin), "timi-w-cta", ctaLabel(status, config)));
      var donate = maybeDonate(data, config);
      if (donate) actions.appendChild(donate);
      body.appendChild(actions);
      body.appendChild(powered(data, origin));
      root.appendChild(body);
      return root;
    },

    ledger: function (data, config, origin) {
      var status = statusOf(data);
      var root = el("div", "timi-wd--ledger");
      root.appendChild(el("span", "timi-w-eyebrow", eyebrowText(config, "Clinic availability")));
      var statusRow = el("div", "timi-w-row");
      statusRow.appendChild(el("span", "timi-w-key", "Status"));
      var value = el("span", "timi-w-val");
      value.appendChild(dot(status, 9, true));
      value.appendChild(el("span", null, COPY[status].short));
      statusRow.appendChild(value);
      root.appendChild(statusRow);
      var showFresh = !(config && config.options && config.options.showFreshness === false);
      if (showFresh && data && data.freshness) {
        var freshRow = el("div", "timi-w-row");
        freshRow.appendChild(el("span", "timi-w-key", "Updated"));
        freshRow.appendChild(el("span", "timi-w-val", data.freshness.replace(/^Updated\s*/i, "")));
        root.appendChild(freshRow);
      }
      if (hasElement(config, "coverage") && data && data.coverage) {
        var coverageRow = el("div", "timi-w-row");
        coverageRow.appendChild(el("span", "timi-w-key", "Coverage"));
        coverageRow.appendChild(el("span", "timi-w-val", data.coverage + " area"));
        root.appendChild(coverageRow);
      }
      var actions = el("div", "timi-w-actions");
      actions.appendChild(link(ctaHref(data, origin), "timi-w-cta", ctaLabel(status, config)));
      var donate = maybeDonate(data, config);
      if (donate) actions.appendChild(donate);
      root.appendChild(actions);
      root.appendChild(powered(data, origin));
      return root;
    },

    night: function (data, config, origin) {
      var status = statusOf(data);
      var root = el("div", "timi-wd--night");
      var line = el("div");
      line.style.display = "flex";
      line.style.alignItems = "center";
      line.style.gap = "9px";
      var ring = el("span", "timi-w-dotring");
      ring.appendChild(dot(status, 10, true));
      line.appendChild(ring);
      line.appendChild(el("span", "timi-w-eyebrow", eyebrowText(config, "Live intake status")));
      root.appendChild(line);
      root.appendChild(el("div", "timi-w-head", COPY[status].label));
      var fresh = freshnessNode(data, config);
      if (fresh) root.appendChild(fresh);
      var coverage = maybeCoverage(data, config);
      if (coverage) root.appendChild(coverage);
      var actions = el("div", "timi-w-actions");
      actions.appendChild(link(ctaHref(data, origin), "timi-w-cta", ctaLabel(status, config)));
      var donate = maybeDonate(data, config);
      if (donate) actions.appendChild(donate);
      root.appendChild(actions);
      root.appendChild(powered(data, origin));
      return root;
    }
  };

  /* -------------------------------------------------------------- render --- */

  function normalizeOptions(raw) {
    raw = raw && typeof raw === "object" ? raw : {};
    var options = {};
    for (var key in OPTION_VOCAB) {
      options[key] = OPTION_VOCAB[key].indexOf(raw[key]) !== -1 ? raw[key] : OPTION_DEFAULTS[key];
    }
    options.heading = typeof raw.heading === "string" ? raw.heading.slice(0, 40) : "";
    options.showFreshness = raw.showFreshness === undefined ? true : Boolean(raw.showFreshness);
    return options;
  }

  function normalizeConfig(config) {
    config = config || {};
    return {
      design: DESIGNS.indexOf(config.design) !== -1 ? config.design : "card",
      variant: VARIANTS.indexOf(config.variant) !== -1 ? config.variant : "cream",
      size: SIZES[config.size] ? config.size : "standard",
      elements: Array.isArray(config.elements) ? config.elements : [],
      options: normalizeOptions(config.options)
    };
  }

  function render(container, data, config, origin) {
    ensureStyle();
    config = normalizeConfig(config || (data && data.package));
    container.textContent = "";
    var options = config.options;
    var shell = el("div", [
      "timi-w",
      "timi-w--" + config.variant,
      "timi-wo-accent-" + options.accent,
      "timi-wo-frame-" + options.frame,
      "timi-wo-shadow-" + options.shadow,
      "timi-wo-corners-" + options.corners,
      "timi-wo-align-" + options.align
    ].join(" "));
    var maxWidth = SIZES[config.size];
    if (maxWidth !== "none") shell.style.maxWidth = maxWidth;
    if (SCALE_ZOOM[options.scale] && SCALE_ZOOM[options.scale] !== "1") shell.style.zoom = SCALE_ZOOM[options.scale];
    var renderer = RENDERERS[config.design] || RENDERERS.card;
    shell.appendChild(renderer(data || {}, config, origin));
    container.appendChild(shell);
  }

  /* --------------------------------------------------------------- mount --- */

  var thisScript = document.currentScript;
  var scriptOrigin = null;
  if (thisScript) {
    try { scriptOrigin = new URL(thisScript.src).origin; } catch (error) { scriptOrigin = null; }
  }

  // The Studio and the demo gallery import this same file and call render()
  // with data in hand, so previews cannot drift from real embeds.
  window.TimiWidget = {
    render: function (container, data, config) {
      render(container, data, config, (data && data.poweredByLink) || scriptOrigin || "https://timinow.pet");
    },
    designs: DESIGNS.slice(),
    variants: VARIANTS.slice(),
    sizes: Object.keys(SIZES),
    optionVocab: JSON.parse(JSON.stringify(OPTION_VOCAB)),
    optionDefaults: JSON.parse(JSON.stringify(OPTION_DEFAULTS))
  };

  if (!thisScript || !scriptOrigin) return;
  var token = thisScript.getAttribute("data-timi-widget");
  if (!token) return;
  var packageId = thisScript.getAttribute("data-timi-package") || "";
  var clientId = thisScript.getAttribute("data-timi-client") || "";
  var mountSelector = thisScript.getAttribute("data-timi-mount");

  function mount() {
    var container = mountSelector ? document.querySelector(mountSelector) : null;
    if (!container) {
      container = el("div");
      if (thisScript.parentNode) thisScript.parentNode.insertBefore(container, thisScript.nextSibling);
      else return;
    }

    var statusUrl = scriptOrigin + "/api/widget/" + encodeURIComponent(token) + "/status";
    var query = [];
    if (packageId) query.push("package=" + encodeURIComponent(packageId));
    if (clientId) query.push("client=" + encodeURIComponent(clientId));
    if (query.length) statusUrl += "?" + query.join("&");

    fetch(statusUrl, { credentials: "omit" })
      .then(function (response) {
        if (!response.ok) throw new Error("widget status request failed");
        return response.json();
      })
      .then(function (data) { render(container, data, data.package, scriptOrigin); })
      .catch(function () { render(container, { status: "unavailable" }, null, scriptOrigin); });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
