/**
 * Tími clinic availability widget — embed script.
 *
 * A clinic pastes this onto its own public website:
 *
 *   <script src="https://timinow.pet/widget.js" data-timi-widget="TOKEN"></script>
 *
 * It renders one status card and nothing else: no cookies, no tracking pixel
 * of its own, no data collected from the visitor. Every DOM node it creates
 * is built with createElement/textContent — never innerHTML — so nothing the
 * status endpoint returns can execute as markup, even if it were compromised.
 * See docs/WIDGET.md for what this can and cannot access.
 */
(function () {
  "use strict";

  var thisScript = document.currentScript;
  if (!thisScript) return;
  var token = thisScript.getAttribute("data-timi-widget");
  if (!token) return;
  var mountSelector = thisScript.getAttribute("data-timi-mount");

  var origin;
  try { origin = new URL(thisScript.src).origin; } catch (error) { return; }

  var STATUS_LABEL = {
    accepting: "🟢 Accepting urgent patients",
    diverting: "🟠 Diverting to another team",
    full: "🔴 Currently at capacity",
    unavailable: "⚪ Status unavailable"
  };
  var STATUS_HEADLINE = {
    accepting: "Today's Intake Status",
    diverting: "Today's Intake Status",
    full: "Today's Intake Status",
    unavailable: "Today's Intake Status"
  };
  var CTA_LABEL = {
    accepting: "Request Care",
    diverting: "Find another available veterinary team",
    full: "Find another available veterinary team",
    unavailable: "Check current availability"
  };

  var STYLE_ID = "timi-widget-style";
  var STYLE_TEXT = [
    ".timi-widget-card{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;",
    "max-width:280px;border:1px solid #D9D8D2;border-radius:12px;padding:16px;background:#FFFAF0;",
    "color:#111B3B;box-sizing:border-box;line-height:1.4}",
    ".timi-widget-card *{box-sizing:border-box}",
    ".timi-widget-title{display:block;font-size:11px;letter-spacing:.04em;text-transform:uppercase;",
    "color:#6F7483;margin:0 0 8px}",
    ".timi-widget-badge{display:block;font-size:15px;font-weight:600;margin:0 0 6px}",
    ".timi-widget-freshness{display:block;font-size:12px;color:#6F7483;margin:0 0 12px}",
    ".timi-widget-cta{display:inline-block;font-size:13px;font-weight:600;text-decoration:none;",
    "color:#FFFAF0;background:#2357D9;border-radius:8px;padding:8px 14px;margin-bottom:8px}",
    ".timi-widget-cta:hover{background:#173C9A}",
    ".timi-widget-footer{display:block;font-size:10px;color:#6F7483;text-decoration:none;margin-top:2px}"
  ].join("");

  function el(tag, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    // Static, hard-coded CSS only — never built from data this script fetched.
    style.textContent = STYLE_TEXT;
    document.head.appendChild(style);
  }

  function render(container, data) {
    container.textContent = "";
    var status = STATUS_LABEL[data && data.status] ? data.status : "unavailable";

    var card = el("div", "timi-widget-card");
    var title = el("span", "timi-widget-title");
    title.textContent = STATUS_HEADLINE[status];
    card.appendChild(title);

    var badge = el("span", "timi-widget-badge");
    badge.textContent = STATUS_LABEL[status];
    card.appendChild(badge);

    if (data && data.freshness) {
      var freshness = el("span", "timi-widget-freshness");
      freshness.textContent = data.freshness;
      card.appendChild(freshness);
    }

    var cta = document.createElement("a");
    cta.className = "timi-widget-cta";
    cta.href = data && data.link ? data.link : origin + "/";
    cta.target = "_blank";
    cta.rel = "noopener noreferrer";
    cta.textContent = CTA_LABEL[status];
    card.appendChild(cta);

    var footer = document.createElement("a");
    footer.className = "timi-widget-footer";
    footer.href = origin + "/";
    footer.target = "_blank";
    footer.rel = "noopener noreferrer";
    footer.textContent = "Powered by Tími";
    card.appendChild(footer);

    container.appendChild(card);
  }

  function mount() {
    ensureStyle();
    var container = mountSelector ? document.querySelector(mountSelector) : null;
    if (!container) {
      container = el("div");
      if (thisScript.parentNode) thisScript.parentNode.insertBefore(container, thisScript.nextSibling);
      else return;
    }

    fetch(origin + "/api/widget/" + encodeURIComponent(token) + "/status", { credentials: "omit" })
      .then(function (response) {
        if (!response.ok) throw new Error("widget status request failed");
        return response.json();
      })
      .then(function (data) { render(container, data); })
      .catch(function () { render(container, { status: "unavailable" }); });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
