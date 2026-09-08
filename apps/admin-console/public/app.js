/**
 * Tími platform operator console — client application.
 *
 * Hash-routed single-page app. No prebuilt Clerk component is ever mounted:
 * Clerk loads headless and every sign-in step is driven through
 * `clerk.client.signIn` directly, per docs/PLATFORM-CONTRACT.md's
 * "Authentication UI rule".
 */

const state = {
  config: null,
  clerk: null,
  signIn: null,
  pendingFactor: null,
  bootstrap: null,
  route: { screen: "tenants" },
  /** Survives a re-render so "mark reconciled" returns to the same view. */
  ledgerFilters: { tenantId: "", kind: "", from: "", to: "", intakeId: "", unreconciled: false },
  map: null,
  marker: null,
  /** Tenant id → name, filled lazily wherever a clinic screen needs to show a
   * name next to an id the underlying route only returns as an id. */
  tenantNames: null,
  pifTab: "fund"
};

/* ----------------------------------------------------------- analytics --- */
/* First-party, cookieless beacon: an event name, a path, optional coarse
   metadata — never an identifier. A failed beacon never affects the console. */
const track = (() => {
  const queue = [];
  let flushTimer = null;
  function deliver(events) {
    if (!events.length) return;
    const body = JSON.stringify({ events });
    try {
      if (navigator.sendBeacon && navigator.sendBeacon("/api/analytics", new Blob([body], { type: "application/json" }))) return;
    } catch { /* fall through to fetch */ }
    try {
      fetch("/api/analytics", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true, credentials: "omit" }).catch(() => {});
    } catch { /* analytics must never break the console */ }
  }
  function flush() {
    clearTimeout(flushTimer);
    flushTimer = null;
    while (queue.length) deliver(queue.splice(0, 25));
  }
  try {
    addEventListener("pagehide", flush);
    addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
  } catch { /* ignore */ }
  return (name, meta) => {
    try {
      if (!/^[a-z0-9_.:-]{1,40}$/i.test(String(name))) return;
      const event = { name: String(name), path: `#${state.route?.screen || "tenants"}` };
      if (meta && typeof meta === "object") event.meta = meta;
      queue.push(event);
      if (!flushTimer) flushTimer = setTimeout(flush, 400);
    } catch { /* analytics must never break the console */ }
  };
})();

/* --------------------------------------------------------------- utils --- */

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const escapeAttr = escapeHtml;

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
function formatDateTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function formatCents(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}
function initials(email) {
  if (!email) return "?";
  const name = email.split("@")[0] || email;
  return name.slice(0, 2).toUpperCase();
}

/** A `.pill` in one of five tones, built from the same tokens the rest of the
 * console already uses for status color — no new CSS classes needed per
 * status vocabulary (application status, contract status, lifecycle state,
 * founding status, reconciliation verdict, …). */
const TONE_COLORS = {
  good: ["var(--good-soft)", "var(--good-dark)"],
  bad: ["var(--coral-soft)", "var(--coral-dark)"],
  warn: ["var(--gold-soft)", "var(--ink)"],
  info: ["var(--blue-soft)", "var(--blue-dark)"],
  neutral: ["var(--canvas)", "var(--muted)"]
};
function tonePill(label, tone = "neutral") {
  const [bg, fg] = TONE_COLORS[tone] || TONE_COLORS.neutral;
  return `<span class="pill" style="background:${bg}; color:${fg}; border:1px solid var(--line);">${escapeHtml(label)}</span>`;
}
function labelize(value) {
  return String(value ?? "").replaceAll("_", " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
}

let toastTimer = null;
function toast(message, isError = false) {
  const el = document.querySelector("[data-toast]");
  el.textContent = message;
  el.classList.toggle("is-error", Boolean(isError));
  el.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("is-visible"), 4200);
}

function showScreen(name) {
  document.querySelectorAll(".screen").forEach((el) => el.classList.toggle("is-active", el.dataset.screen === name));
  window.scrollTo(0, 0);
}

async function apiFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers["content-type"]) headers["content-type"] = "application/json";
  if (state.config?.signInRequired && state.clerk?.session) {
    try {
      const token = await state.clerk.session.getToken();
      if (token) headers.authorization = `Bearer ${token}`;
    } catch (error) {
      console.warn("Unable to read Clerk session token", error);
    }
  }
  const response = await fetch(path, { ...options, headers });
  let data = null;
  try {
    data = await response.json();
  } catch {
    /* no JSON body */
  }
  if (!response.ok) {
    const error = new Error(data?.error?.message || `Request failed (${response.status})`);
    error.code = data?.error?.code;
    error.status = response.status;
    error.details = data?.error?.details;
    throw error;
  }
  return data;
}

/* ------------------------------------------------------------- routing --- */

function parseHash() {
  const raw = location.hash.replace(/^#/, "");
  if (raw === "" || raw === "tenants") return { screen: "tenants" };
  if (raw === "tenants/new") return { screen: "tenants-new" };
  const detailMatch = raw.match(/^tenants\/([^/]+)$/);
  if (detailMatch) return { screen: "tenant-detail", id: decodeURIComponent(detailMatch[1]) };
  if (raw === "operators") return { screen: "operators" };
  if (raw === "audit") return { screen: "audit" };
  if (raw === "errors") return { screen: "errors" };
  if (raw === "ledger") return { screen: "ledger" };
  if (raw === "analytics") return { screen: "analytics" };
  if (raw === "applications") return { screen: "applications" };
  if (raw === "markets") return { screen: "markets" };
  const marketDetailMatch = raw.match(/^markets\/([^/]+)$/);
  if (marketDetailMatch) return { screen: "market-detail", id: decodeURIComponent(marketDetailMatch[1]) };
  if (raw === "metrics") return { screen: "metrics" };
  if (raw === "clinic-applications") return { screen: "clinic-applications" };
  if (raw === "clinic-contracts") return { screen: "clinic-contracts" };
  const clinicContractDetailMatch = raw.match(/^clinic-contracts\/([^/]+)$/);
  if (clinicContractDetailMatch) return { screen: "clinic-contract-detail", id: decodeURIComponent(clinicContractDetailMatch[1]) };
  if (raw === "pif") return { screen: "pif", tab: "fund" };
  const pifMatch = raw.match(/^pif\/(fund|custody|reconciliation)$/);
  if (pifMatch) return { screen: "pif", tab: pifMatch[1] };
  return { screen: "tenants" };
}

function updateNavActive() {
  const top = ["operators", "audit", "errors", "ledger", "analytics", "applications", "metrics", "clinic-applications", "clinic-contracts", "pif"].includes(state.route.screen)
    ? state.route.screen
    : ["markets", "market-detail"].includes(state.route.screen) ? "markets"
    : state.route.screen === "clinic-contract-detail" ? "clinic-contracts"
    : "tenants";
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === top));
}

async function route() {
  showScreen("loading");
  if (state.config?.signInRequired && !state.clerk?.session) {
    resetSignInForm();
    showScreen("sign-in");
    return;
  }
  await checkBootstrapAndRoute();
}

async function checkBootstrapAndRoute() {
  try {
    state.bootstrap = await apiFetch("/api/admin/bootstrap");
  } catch (error) {
    toast(error.message, true);
    state.bootstrap = { platformAdmin: false, actor: {} };
  }
  renderAccountMenu();
  if (!state.bootstrap.platformAdmin) {
    document.querySelector("[data-operator-nav]").hidden = true;
    renderUnauthorized();
    showScreen("unauthorized");
    return;
  }
  document.querySelector("[data-operator-nav]").hidden = false;
  if (!checkBootstrapAndRoute.trackedOpen) {
    checkBootstrapAndRoute.trackedOpen = true;
    track("console_opened");
  }
  await renderRoute();
}

async function renderRoute() {
  state.route = parseHash();
  updateNavActive();
  if (renderRoute.lastTrackedScreen !== state.route.screen) {
    renderRoute.lastTrackedScreen = state.route.screen;
    track("page_view");
  }
  if (state.route.screen === "tenants-new") {
    showScreen("tenants-new");
    initTenantForm();
    return;
  }
  if (state.route.screen === "tenant-detail") {
    showScreen("tenant-detail");
    await loadTenantDetail(state.route.id);
    return;
  }
  if (state.route.screen === "operators") {
    showScreen("operators");
    await loadOperators();
    return;
  }
  if (state.route.screen === "audit") {
    showScreen("audit");
    await loadAudit();
    return;
  }
  if (state.route.screen === "errors") {
    showScreen("errors");
    await loadClientErrors();
    return;
  }
  if (state.route.screen === "ledger") {
    showScreen("ledger");
    await loadLedger();
    return;
  }
  if (state.route.screen === "analytics") {
    showScreen("analytics");
    await loadAnalytics();
    return;
  }
  if (state.route.screen === "applications") {
    showScreen("applications");
    await loadApplications();
    return;
  }
  if (state.route.screen === "markets") {
    showScreen("markets");
    await loadMarkets();
    return;
  }
  if (state.route.screen === "market-detail") {
    showScreen("market-detail");
    await loadMarketDetail(state.route.id);
    return;
  }
  if (state.route.screen === "metrics") {
    showScreen("metrics");
    await loadMetrics();
    return;
  }
  if (state.route.screen === "clinic-applications") {
    showScreen("clinic-applications");
    await loadClinicApplications();
    return;
  }
  if (state.route.screen === "clinic-contracts") {
    showScreen("clinic-contracts");
    await loadClinicContracts();
    return;
  }
  if (state.route.screen === "clinic-contract-detail") {
    showScreen("clinic-contract-detail");
    await loadClinicContractDetail(state.route.id);
    return;
  }
  if (state.route.screen === "pif") {
    showScreen("pif");
    await loadPif(state.route.tab || "fund");
    return;
  }
  showScreen("tenants");
  await loadTenants();
}

/* --------------------------------------------------------------- clerk --- */

async function initClerk() {
  if (!state.config.clerkPublishableKey || !state.config.clerkJsUrl) return;
  try {
    const mod = await import(/* webpackIgnore: true */ state.config.clerkJsUrl);
    const Clerk = mod.Clerk || mod.default?.Clerk || mod.default;
    state.clerk = new Clerk(state.config.clerkPublishableKey);
    await state.clerk.load();
  } catch (error) {
    console.error("Clerk initialization failed", error);
  }
}

function showStep(step) {
  ["identifier", "strategy", "code"].forEach((s) => {
    const el = document.querySelector(`[data-step="${s}"]`);
    if (el) el.hidden = s !== step;
  });
  document.querySelectorAll('[data-step="identifier-extras"]').forEach((el) => {
    el.hidden = step !== "identifier";
  });
}

function clearSignInError() {
  document.querySelector("[data-sign-in-error]").hidden = true;
}
function showSignInError(error) {
  const el = document.querySelector("[data-sign-in-error]");
  el.textContent = error?.errors?.[0]?.longMessage || error?.errors?.[0]?.message || error?.message || "Something went wrong. Try again.";
  el.hidden = false;
}

function resetSignInForm() {
  state.signIn = null;
  state.pendingFactor = null;
  clearSignInError();
  document.querySelector('form[data-step="identifier"]')?.reset();
  document.querySelector('form[data-step="code"]')?.reset();
  showStep("identifier");
  document.querySelector("[data-clerk-missing]").hidden = Boolean(state.config?.clerkPublishableKey) || !state.config?.signInRequired;
}

function renderStrategyChoices(attempt) {
  const list = document.querySelector("[data-strategy-list]");
  list.innerHTML = "";
  document.querySelector("[data-strategy-identity]").textContent = attempt.identifier ? `Continuing as ${attempt.identifier}` : "";
  const seen = new Set();
  // One-time codes only: email and phone. Passwords, passkeys, and OAuth are
  // not offered on any Tími web surface.
  const supported = (attempt.supportedFirstFactors || []).filter((factor) => {
    if (!["email_code", "phone_code"].includes(factor.strategy)) return false;
    if (seen.has(factor.strategy)) return false;
    seen.add(factor.strategy);
    return true;
  });
  for (const factor of supported) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button";
    button.textContent = factor.strategy === "email_code"
      ? `Email a code to ${factor.safeIdentifier || "your inbox"}`
      : `Text a code to ${factor.safeIdentifier || "your phone"}`;
    button.addEventListener("click", () => chooseStrategy(factor));
    list.appendChild(button);
  }
  if (!supported.length) {
    list.innerHTML = '<p class="sign-in-error" style="margin:0;">This account has no email or phone number that can receive a one-time code.</p>';
  }
}

async function chooseStrategy(factor) {
  clearSignInError();
  try {
    await state.signIn.prepareFirstFactor(
      factor.strategy === "email_code"
        ? { strategy: "email_code", emailAddressId: factor.emailAddressId }
        : { strategy: "phone_code", phoneNumberId: factor.phoneNumberId }
    );
    state.pendingFactor = factor;
    document.querySelector("[data-code-lede]").textContent = `Enter the 6-digit code sent to ${factor.safeIdentifier || "you"}.`;
    showStep("code");
  } catch (error) {
    showSignInError(error);
  }
}

async function completeSignIn(result) {
  await state.clerk.setActive({ session: result.createdSessionId });
  if (!location.hash || location.hash === "#sign-in") location.hash = "#tenants";
  await route();
}

/* -------------------------------------------------------- account menu --- */

function renderAccountMenu() {
  const email = state.bootstrap?.actor?.email || "";
  document.querySelector("[data-account-avatar]").textContent = initials(email);
  document.querySelector("[data-account-email]").textContent = email || "Signed in";
  document.querySelector("[data-account-dropdown-email]").textContent = email || "";
  document.querySelector("[data-account-menu]").hidden = false;
}

function renderUnauthorized() {
  const actor = state.bootstrap?.actor || {};
  document.querySelector("[data-unauthorized-avatar]").textContent = initials(actor.email);
  document.querySelector("[data-unauthorized-email]").textContent = actor.email || "No email on file";
  document.querySelector("[data-unauthorized-id]").textContent = actor.id ? `Clerk user id: ${actor.id}` : "";
}

/* ------------------------------------------------------------------ map --- */

function initMap() {
  const mapEl = document.getElementById("tenant-map");
  const notice = document.querySelector("[data-map-notice]");
  const token = state.config?.map?.token;
  if (!token || typeof window.mapboxgl === "undefined") {
    mapEl.hidden = true;
    notice.hidden = false;
    return;
  }
  mapEl.hidden = false;
  notice.hidden = true;
  if (state.map) {
    state.map.resize();
    return;
  }
  window.mapboxgl.accessToken = token;
  state.map = new window.mapboxgl.Map({
    container: "tenant-map",
    style: state.config.map.styleUrl,
    center: [-122.27, 37.8],
    zoom: 9
  });
  state.map.addControl(new window.mapboxgl.NavigationControl(), "top-right");
  state.map.on("click", (event) => setMarker(event.lngLat.lat, event.lngLat.lng));
}

function setMarker(lat, lng) {
  const form = document.querySelector('form[data-form="create-tenant"]');
  form.loc_latitude.value = lat.toFixed(6);
  form.loc_longitude.value = lng.toFixed(6);
  if (!state.marker) {
    state.marker = new window.mapboxgl.Marker({ color: "#F25F4C", draggable: true });
    state.marker.on("dragend", () => {
      const pos = state.marker.getLngLat();
      form.loc_latitude.value = pos.lat.toFixed(6);
      form.loc_longitude.value = pos.lng.toFixed(6);
    });
  }
  state.marker.setLngLat([lng, lat]).addTo(state.map);
}

function initTenantForm() {
  const form = document.querySelector('form[data-form="create-tenant"]');
  form.reset();
  form.querySelector("[data-form-errors]").hidden = true;
  initMap();
}

/* -------------------------------------------------------------- tenants --- */

async function loadTenants() {
  const container = document.querySelector("[data-tenants-table]");
  container.innerHTML = '<div class="loading-state"><span class="spinner" aria-hidden="true"></span><p>Loading tenants…</p></div>';
  try {
    const { tenants } = await apiFetch("/api/admin/tenants");
    renderTenantsTable(tenants);
  } catch (error) {
    container.innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function renderTenantsTable(tenants) {
  const container = document.querySelector("[data-tenants-table]");
  if (!tenants.length) {
    container.innerHTML = '<div class="table-wrap"><table class="data-table"><tbody><tr class="empty-row"><td>No tenants yet. Create the first one.</td></tr></tbody></table></div>';
    return;
  }
  const rows = tenants.map((t) => `
    <tr>
      <td><a class="row-link" href="#tenants/${encodeURIComponent(t.id)}">${escapeHtml(t.name)}</a></td>
      <td>${escapeHtml(t.slug)}</td>
      <td><span class="pill status-${escapeAttr(t.status)}">${escapeHtml(t.status)}</span></td>
      <td>${t.locationCount ?? 0}</td>
      <td>${t.memberCount ?? 0}</td>
      <td>${formatDate(t.createdAt)}</td>
    </tr>`).join("");
  container.innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>Name</th><th>Slug</th><th>Status</th><th>Locations</th><th>Members</th><th>Created</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

/** Tenant id → name, loaded once and reused by every screen that only gets an
 * id back from its own route (clinic contracts chief among them). */
async function ensureTenantNames() {
  if (state.tenantNames) return state.tenantNames;
  try {
    const { tenants } = await apiFetch("/api/admin/tenants");
    state.tenantNames = Object.fromEntries((tenants || []).map((t) => [t.id, t.name]));
  } catch {
    state.tenantNames = {};
  }
  return state.tenantNames;
}
function tenantLabel(tenantId) {
  return (state.tenantNames && state.tenantNames[tenantId]) || tenantId;
}

/* ------------------------------------------------------------ operators --- */

async function loadOperators() {
  const mount = document.querySelector("[data-operators-body]");
  mount.innerHTML = '<div class="loading-state"><span class="spinner" aria-hidden="true"></span><p>Loading operators…</p></div>';
  try {
    const { admins = [] } = await apiFetch("/api/admin/platform-admins");
    renderOperators(admins);
  } catch (error) {
    mount.innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function operatorRow(admin) {
  const isSelf = state.bootstrap?.actor?.id === admin.clerkUserId;
  return `<div class="member-row">
    <div class="who"><strong>${escapeHtml(admin.label || admin.email || admin.clerkUserId)}</strong><small>${escapeHtml(admin.email || admin.clerkUserId)}</small></div>
    <div class="member-actions">
      ${isSelf
        ? '<span class="hint">This is you</span>'
        : `<button class="button button-small button-danger" type="button" data-remove-operator="${escapeAttr(admin.clerkUserId)}">Remove</button>`}
    </div>
  </div>`;
}

function renderOperators(admins) {
  const mount = document.querySelector("[data-operators-body]");
  mount.innerHTML = `
    <form class="form-grid two-col" data-form="add-operator" style="margin-bottom:1.25rem;">
      <label class="field"><span>Email</span><input type="email" name="email" required placeholder="name@clinic.com"></label>
      <label class="field"><span>Label (optional)</span><input type="text" name="label" placeholder="How you'll recognize them"></label>
      <div class="form-actions"><button class="button" type="submit">Add operator</button></div>
      <p class="hint" data-form-errors hidden></p>
    </form>
    <div class="panel">
      ${admins.length
        ? admins.map(operatorRow).join("")
        : '<div class="empty-state"><p>No operators recorded in the database yet. Anyone named in this Worker’s PLATFORM_ADMIN_USER_IDS or PLATFORM_ADMIN_EMAILS variables also has access, but is not listed here — that allowlist only changes with a redeploy.</p></div>'}
    </div>
  `;
  wireOperatorEvents();
}

function wireOperatorEvents() {
  document.querySelector('form[data-form="add-operator"]').addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    const errorsBox = form.querySelector("[data-form-errors]");
    errorsBox.hidden = true;
    const email = form.email.value.trim();
    const label = form.label.value.trim();
    const submitButton = form.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    try {
      await apiFetch("/api/admin/platform-admins", { method: "POST", body: JSON.stringify({ email, label }) });
      toast(`${email} can now sign in as a platform operator.`);
      await loadOperators();
    } catch (error) {
      errorsBox.textContent = error.message;
      errorsBox.hidden = false;
      submitButton.disabled = false;
    }
  });

  document.querySelectorAll("[data-remove-operator]").forEach((button) => {
    button.addEventListener("click", async () => {
      const clerkUserId = button.dataset.removeOperator;
      if (!window.confirm("Remove this operator's platform access?")) return;
      button.disabled = true;
      try {
        await apiFetch(`/api/admin/platform-admins/${encodeURIComponent(clerkUserId)}`, { method: "DELETE" });
        toast("Operator removed.");
        await loadOperators();
      } catch (error) {
        toast(error.message, true);
        button.disabled = false;
      }
    });
  });
}

/* ---------------------------------------------------------------- audit --- */

async function loadAudit() {
  const container = document.querySelector("[data-audit-list]");
  container.innerHTML = '<div class="loading-state"><span class="spinner" aria-hidden="true"></span><p>Loading audit log…</p></div>';
  try {
    const { audit = [] } = await apiFetch("/api/admin/audit?limit=100");
    container.innerHTML = audit.length
      ? `<div class="panel"><div class="audit-list">${audit.map(renderPlatformAuditRow).join("")}</div></div>`
      : '<div class="empty-state"><p>No actions recorded yet.</p></div>';
  } catch (error) {
    container.innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function renderAuditRow(row) {
  const detail = row.detail && Object.keys(row.detail).length ? escapeHtml(JSON.stringify(row.detail)) : "";
  return `<div class="audit-row">
    <time>${formatDateTime(row.createdAt)}</time>
    <div><span class="action">${escapeHtml(row.action)}</span><div class="detail">${escapeHtml(row.target || "")}${detail ? ` · ${detail}` : ""}</div></div>
    <span class="pill role-member">${escapeHtml(row.actorScope)}</span>
  </div>`;
}

function renderPlatformAuditRow(row) {
  const detail = row.detail && Object.keys(row.detail).length ? escapeHtml(JSON.stringify(row.detail)) : "";
  return `<div class="audit-row">
    <time>${formatDateTime(row.createdAt)}</time>
    <div><span class="action">${escapeHtml(row.action)}</span><div class="detail">${escapeHtml(row.tenantName || row.tenantId || "platform")} · ${escapeHtml(row.target || "")}${detail ? ` · ${detail}` : ""}</div></div>
    <span class="pill role-member">${escapeHtml(row.actorScope)}</span>
  </div>`;
}

/* ------------------------------------------------------- tenant detail --- */

function renderLocationCard(loc) {
  return `<div class="location-card">
    <h3>${escapeHtml(loc.name)} <span class="pill role-member">${escapeHtml(loc.kind)}</span></h3>
    <p>${escapeHtml(loc.addressLine1)}, ${escapeHtml(loc.city)}, ${escapeHtml(loc.region)} ${escapeHtml(loc.postalCode)} · ${escapeHtml(loc.phone)}</p>
    <p>${loc.species.map(escapeHtml).join(", ")}${loc.capabilities.length ? " · " + loc.capabilities.map(escapeHtml).join(", ") : ""}</p>
    ${loc.staffingLevel === "veterinary_technician"
      ? `<p class="hint"><strong>Veterinary technician staffed.</strong> Customers see the standard scope-of-practice notice before choosing this provider.${loc.staffingNote ? " " + escapeHtml(loc.staffingNote) : ""}</p>`
      : ""}
  </div>`;
}

function renderMemberRow(member) {
  return `<div class="member-row">
    <div class="who"><strong>${escapeHtml(member.displayName || member.email || member.clerkUserId)}</strong><small>${escapeHtml(member.email || "")}</small></div>
    <select data-role-select data-user="${escapeAttr(member.clerkUserId)}">
      <option value="org:member" ${member.role === "org:member" ? "selected" : ""}>Member</option>
      <option value="org:admin" ${member.role === "org:admin" ? "selected" : ""}>Administrator</option>
    </select>
    <div class="member-actions"><button class="button button-small button-danger" type="button" data-remove-member="${escapeAttr(member.clerkUserId)}">Remove</button></div>
  </div>`;
}

function renderAddLocationForm() {
  return `<form data-form="add-location" class="form-grid two-col" style="margin-bottom:1.25rem;">
    <label class="field wide"><span>Location name *</span><input type="text" name="name" required></label>
    <label class="field"><span>Kind *</span>
      <select name="kind" required>
        <option value="general">General practice</option>
        <option value="urgent" selected>Urgent care</option>
        <option value="emergency">Emergency</option>
        <option value="specialty">Specialty</option>
      </select>
    </label>
    <label class="field"><span>Phone *</span><input type="tel" name="phone" required></label>
    <label class="field wide"><span>Address line 1 *</span><input type="text" name="addressLine1" required></label>
    <label class="field"><span>City *</span><input type="text" name="city" required></label>
    <label class="field"><span>State / region *</span><input type="text" name="region" required></label>
    <label class="field"><span>Postal code *</span><input type="text" name="postalCode" required></label>
    <label class="field"><span>Latitude *</span><input type="number" step="0.000001" name="latitude" required></label>
    <label class="field"><span>Longitude *</span><input type="number" step="0.000001" name="longitude" required></label>
    <fieldset class="wide"><legend>Species treated *</legend><div class="form-grid three-col">
      <label class="checkbox-row"><input type="checkbox" name="species" value="dog" checked> Dog</label>
      <label class="checkbox-row"><input type="checkbox" name="species" value="cat" checked> Cat</label>
      <label class="checkbox-row"><input type="checkbox" name="species" value="bird"> Bird</label>
      <label class="checkbox-row"><input type="checkbox" name="species" value="rabbit"> Rabbit</label>
    </div></fieldset>
    <label class="field wide"><span>Capabilities<span class="hint"> — comma separated</span></span><input type="text" name="capabilities"></label>
    <div class="form-actions wide" style="margin-top:0;"><button class="button button-primary" type="submit">Add location</button></div>
  </form>`;
}

async function loadTenantDetail(tenantId) {
  const container = document.querySelector("[data-tenant-detail-body]");
  container.innerHTML = '<div class="loading-state"><span class="spinner" aria-hidden="true"></span><p>Loading tenant…</p></div>';
  try {
    const data = await apiFetch(`/api/admin/tenants/${encodeURIComponent(tenantId)}`);
    renderTenantDetail(data);
  } catch (error) {
    container.innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function renderTenantDetail(data) {
  const { tenant, locations, members, policy, audit } = data;
  const container = document.querySelector("[data-tenant-detail-body]");
  container.innerHTML = `
    <div class="page-head">
      <div>
        <p class="eyebrow">${escapeHtml(tenant.slug)}</p>
        <h1 class="page-title">${escapeHtml(tenant.name)}</h1>
      </div>
      <span class="pill status-${escapeAttr(tenant.status)}">${escapeHtml(tenant.status)}</span>
    </div>

    <div class="tenant-summary">
      <span><small>Locations</small><strong>${locations.length}</strong></span>
      <span><small>Active members</small><strong>${members.length}</strong></span>
      <span><small>Created</small><strong>${formatDate(tenant.createdAt)}</strong></span>
      <span><small>Clerk org</small><strong style="font-size:.75rem; word-break:break-all;">${escapeHtml(tenant.clerkOrgId || "—")}</strong></span>
    </div>

    <div class="panel">
      <h2>Workspace settings</h2>
      <form data-form="rename-tenant" class="form-grid two-col">
        <label class="field"><span>Name</span><input type="text" name="name" value="${escapeAttr(tenant.name)}"></label>
        <label class="field"><span>Status</span>
          <select name="status">
            <option value="active" ${tenant.status === "active" ? "selected" : ""}>Active</option>
            <option value="suspended" ${tenant.status === "suspended" ? "selected" : ""}>Suspended</option>
          </select>
        </label>
        <div class="form-actions wide" style="margin-top:0;"><button class="button button-primary" type="submit">Save changes</button></div>
      </form>
    </div>

    <div class="panel">
      <div class="page-head" style="margin-bottom: 1rem;">
        <h2 style="margin:0;">Locations</h2>
        <button class="button button-small" type="button" data-toggle="add-location">+ Add location</button>
      </div>
      <div data-add-location-form hidden>${renderAddLocationForm()}</div>
      <div>${locations.map(renderLocationCard).join("") || '<p class="page-lede">No locations yet.</p>'}</div>
    </div>

    <div class="panel">
      <h2>People</h2>
      <form data-form="add-member" class="form-grid two-col" style="margin-bottom: 1.25rem;">
        <label class="field"><span>Email</span><input type="email" name="email" required></label>
        <label class="field"><span>Role</span>
          <select name="role"><option value="org:member">Member</option><option value="org:admin">Administrator</option></select>
        </label>
        <div class="form-actions wide" style="margin-top:0;"><button class="button button-primary" type="submit">Add to workspace</button></div>
      </form>
      <div>${members.length ? members.map(renderMemberRow).join("") : '<p class="page-lede">No active members.</p>'}</div>
    </div>

    <div class="panel">
      <h2>Deposit policy<span class="hint"> — version ${policy?.version ?? "—"}</span></h2>
      ${policy ? `
        <div class="tenant-summary">
          <span><small>Deposit</small><strong>${policy.depositRequired ? formatCents(policy.depositAmountCents) : "Not required"}</strong></span>
          <span><small>Refundable</small><strong>${policy.depositRefundable ? "Yes" : "No"}</strong></span>
          <span><small>Free cancel</small><strong>${policy.freeCancelMinutes} min</strong></span>
          <span><small>Completed fee</small><strong>${formatCents(policy.completedPlatformFeeCents)}</strong></span>
          <span><small>No-show fee</small><strong>${formatCents(policy.noShowPlatformFeeCents)}</strong></span>
          <span><small>Late-cancel fee</small><strong>${formatCents(policy.lateCancelPlatformFeeCents)}</strong></span>
        </div>` : '<p class="page-lede">No policy on record.</p>'}
    </div>

    <div class="panel" data-connect-panel>
      <h2>Stripe Connect</h2>
      <p class="page-lede">Loading connected account…</p>
    </div>

    <div class="panel">
      <h2>Audit trail</h2>
      <div class="audit-list">${audit.length ? audit.map(renderAuditRow).join("") : '<p class="page-lede">No recorded actions yet.</p>'}</div>
    </div>
  `;
  wireTenantDetailEvents(tenant.id);
  loadConnectStatus(tenant.id);
}

/* -------------------------------------------------------------- connect --- */

/**
 * Whether this clinic can actually be paid.
 *
 * Loaded after the rest of the page rather than with it: the Worker refreshes
 * the account from Stripe on every read, so this is the one panel that can be
 * slow, and blocking the whole workspace view on a Stripe round trip would
 * make every other tab feel broken when Stripe is having a bad day.
 */
async function loadConnectStatus(tenantId) {
  const panel = document.querySelector("[data-connect-panel]");
  if (!panel) return;
  try {
    const data = await apiFetch(`/api/admin/tenants/${encodeURIComponent(tenantId)}/stripe`);
    panel.innerHTML = renderConnectPanel(tenantId, data);
    wireConnectPanel(tenantId);
  } catch (error) {
    panel.innerHTML = `<h2>Stripe Connect</h2><p class="page-lede">${escapeHtml(error.message)}</p>`;
  }
}

const CONNECT_LABELS = {
  not_started: "Not started",
  in_progress: "Onboarding in progress",
  restricted: "Waiting on Stripe",
  complete: "Ready to receive transfers",
  disabled: "Disabled by Stripe"
};

function renderConnectPanel(tenantId, data) {
  const { account, earnings, refreshError, stripeConfigured } = data;
  if (!stripeConfigured) {
    return `<h2>Stripe Connect</h2><p class="page-lede">This console has no STRIPE_SECRET_KEY, so no connected account can be created or read. See docs/STRIPE.md.</p>`;
  }
  if (!account) {
    return `<h2>Stripe Connect</h2>
      <p class="page-lede">This clinic has no connected account, so nothing can be transferred to it. Deposits would still be collected — Tími is the merchant of record — and the clinic's share would sit in the platform balance until it onboards.</p>
      <button class="button button-primary" type="button" data-connect-onboard>Start embedded onboarding</button>
      <div data-connect-embed hidden style="margin-top:1.25rem;"></div>`;
  }

  // The one question that matters, answered first and in words rather than as
  // a capability string nobody outside Stripe reads the same way.
  const verdict = account.transfersEnabled
    ? "This clinic can receive transfers."
    : "This clinic CANNOT receive transfers. Settled intakes stay unsettled and are retried by the sweep until it can.";
  const due = [
    ...(account.requirements?.currently_due || []),
    ...(account.requirements?.past_due || [])
  ];

  return `<h2>Stripe Connect<span class="hint"> — ${escapeHtml(CONNECT_LABELS[account.onboardingStatus] || account.onboardingStatus)}</span></h2>
    <p class="page-lede">${escapeHtml(verdict)}</p>
    ${refreshError ? `<p class="page-lede">Could not refresh from Stripe just now (${escapeHtml(refreshError)}); showing the last known answer.</p>` : ""}
    <div class="tenant-summary">
      <span><small>Account</small><strong style="font-size:.75rem; word-break:break-all;">${escapeHtml(account.stripeAccountId)}</strong></span>
      <span><small>Accounts API</small><strong>${escapeHtml(account.accountsApi)}</strong></span>
      <span><small>Transfers</small><strong>${escapeHtml(account.transfersStatus)}</strong></span>
      <span><small>Payouts</small><strong>${escapeHtml(account.payoutsStatus)}</strong></span>
      <span><small>Transferred</small><strong>${formatCents(earnings.transferredCents)}</strong></span>
      <span><small>Paid out by Stripe</small><strong>${formatCents(earnings.paidOutCents)}</strong></span>
      <span><small>Awaiting payout</small><strong>${formatCents(earnings.awaitingPayoutCents)}</strong></span>
      <span><small>Checked</small><strong>${escapeHtml(formatDateTime(account.capabilitiesRefreshedAt))}</strong></span>
    </div>
    ${account.disabledReason ? `<p class="page-lede">Stripe reason: ${escapeHtml(account.disabledReason)}</p>` : ""}
    ${due.length ? `<p class="page-lede">Stripe still needs: ${escapeHtml(due.join(", "))}</p>` : ""}
    ${account.transfersEnabled ? "" : `<button class="button button-primary" type="button" data-connect-onboard>Continue embedded onboarding</button>`}
    <div data-connect-embed hidden style="margin-top:1.25rem;"></div>`;
}

/**
 * Mount Stripe's own onboarding component inside this page.
 *
 * Embedded, never a redirect and never a form of our own. A redirect drops
 * the operator (or the clinic sitting with them) onto a Stripe-hosted page at
 * the exact moment we are asking a business for its bank details, and an
 * API-onboarding form would mean maintaining KYC fields per country forever.
 */
function wireConnectPanel(tenantId) {
  const button = document.querySelector("[data-connect-onboard]");
  if (!button) return;
  button.addEventListener("click", async () => {
    button.disabled = true;
    const mount = document.querySelector("[data-connect-embed]");
    mount.hidden = false;
    mount.innerHTML = '<p class="page-lede">Opening Stripe onboarding…</p>';
    try {
      const session = await apiFetch(`/api/admin/tenants/${encodeURIComponent(tenantId)}/stripe/onboarding-session`, { method: "POST", body: "{}" });
      if (!session.publishableKey) throw new Error("No Stripe publishable key is configured on this console.");
      const { loadConnectAndInitialize } = await import(/* webpackIgnore: true */ "https://cdn.jsdelivr.net/npm/@stripe/connect-js@3/+esm");
      const connect = loadConnectAndInitialize({
        publishableKey: session.publishableKey,
        // Called again whenever the component needs a fresh session, which is
        // why the endpoint mints one per call and stores none.
        fetchClientSecret: async () => {
          const next = await apiFetch(`/api/admin/tenants/${encodeURIComponent(tenantId)}/stripe/onboarding-session`, { method: "POST", body: "{}" });
          return next.clientSecret;
        }
      });
      mount.innerHTML = "";
      const component = connect.create("account-onboarding");
      component.setOnExit(() => {
        // Exiting is not finishing. Re-read the account rather than assuming.
        loadConnectStatus(tenantId);
      });
      mount.appendChild(component);
      void session;
    } catch (error) {
      mount.innerHTML = `<p class="page-lede">${escapeHtml(error.message)}</p>`;
    } finally {
      button.disabled = false;
    }
  });
}

function wireTenantDetailEvents(tenantId) {
  const root = document.querySelector("[data-tenant-detail-body]");

  root.querySelector('form[data-form="rename-tenant"]').addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    try {
      await apiFetch(`/api/admin/tenants/${encodeURIComponent(tenantId)}`, {
        method: "PATCH",
        body: JSON.stringify({ name: form.name.value.trim(), status: form.status.value })
      });
      toast("Workspace updated.");
      await loadTenantDetail(tenantId);
    } catch (error) {
      toast(error.message, true);
    }
  });

  root.querySelector('[data-toggle="add-location"]').addEventListener("click", () => {
    const el = root.querySelector("[data-add-location-form]");
    el.hidden = !el.hidden;
  });

  const addLocationForm = root.querySelector('form[data-form="add-location"]');
  addLocationForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    const species = [...form.querySelectorAll('input[name="species"]:checked')].map((i) => i.value);
    const capabilities = (form.capabilities.value || "").split(",").map((s) => s.trim()).filter(Boolean);
    const payload = {
      name: form.name.value.trim(),
      kind: form.kind.value,
      addressLine1: form.addressLine1.value.trim(),
      city: form.city.value.trim(),
      region: form.region.value.trim(),
      postalCode: form.postalCode.value.trim(),
      phone: form.phone.value.trim(),
      latitude: Number(form.latitude.value),
      longitude: Number(form.longitude.value),
      species,
      capabilities
    };
    try {
      await apiFetch(`/api/admin/tenants/${encodeURIComponent(tenantId)}/locations`, { method: "POST", body: JSON.stringify(payload) });
      toast("Location added.");
      await loadTenantDetail(tenantId);
    } catch (error) {
      toast(error.message, true);
    }
  });

  root.querySelector('form[data-form="add-member"]').addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    const email = form.email.value.trim();
    const role = form.role.value;
    try {
      if (role === "org:admin") {
        await apiFetch(`/api/admin/tenants/${encodeURIComponent(tenantId)}/admins`, { method: "POST", body: JSON.stringify({ email }) });
      } else {
        await apiFetch(`/api/tenant/members?tenantId=${encodeURIComponent(tenantId)}`, { method: "POST", body: JSON.stringify({ email, role }) });
      }
      toast(`${email} added.`);
      await loadTenantDetail(tenantId);
    } catch (error) {
      toast(error.message, true);
    }
  });

  root.querySelectorAll("[data-role-select]").forEach((select) => {
    select.addEventListener("change", async () => {
      const userId = select.dataset.user;
      try {
        await apiFetch(`/api/tenant/members/${encodeURIComponent(userId)}?tenantId=${encodeURIComponent(tenantId)}`, {
          method: "PATCH",
          body: JSON.stringify({ role: select.value })
        });
        toast("Role updated.");
      } catch (error) {
        toast(error.message, true);
        await loadTenantDetail(tenantId);
      }
    });
  });

  root.querySelectorAll("[data-remove-member]").forEach((button) => {
    button.addEventListener("click", async () => {
      const userId = button.dataset.removeMember;
      if (!window.confirm("Remove this person from the workspace?")) return;
      try {
        await apiFetch(`/api/tenant/members/${encodeURIComponent(userId)}?tenantId=${encodeURIComponent(tenantId)}`, { method: "DELETE" });
        toast("Removed from workspace.");
        await loadTenantDetail(tenantId);
      } catch (error) {
        toast(error.message, true);
      }
    });
  });
}

/* -------------------------------------------------------- static wiring --- */

function wireStaticHandlers() {
  document.querySelector('form[data-step="identifier"]').addEventListener("submit", async (event) => {
    event.preventDefault();
    clearSignInError();
    if (!state.clerk) return;
    const identifier = event.target.identifier.value.trim();
    if (!identifier) return;
    try {
      const attempt = await state.clerk.client.signIn.create({ identifier });
      state.signIn = attempt;
      if (attempt.status === "complete") {
        await completeSignIn(attempt);
        return;
      }
      renderStrategyChoices(attempt);
      showStep("strategy");
    } catch (error) {
      showSignInError(error);
    }
  });

  document.querySelectorAll("[data-back-to]").forEach((button) => {
    button.addEventListener("click", () => {
      clearSignInError();
      showStep(button.dataset.backTo);
    });
  });

  document.querySelector('form[data-step="code"]').addEventListener("submit", async (event) => {
    event.preventDefault();
    clearSignInError();
    try {
      const strategy = state.pendingFactor?.strategy || "email_code";
      const result = await state.signIn.attemptFirstFactor({ strategy, code: event.target.code.value.trim() });
      if (result.status === "complete") await completeSignIn(result);
      else showSignInError(new Error("That code was not accepted."));
    } catch (error) {
      showSignInError(error);
    }
  });

  document.querySelector("[data-account-trigger]").addEventListener("click", () => {
    const dropdown = document.querySelector("[data-account-dropdown]");
    dropdown.hidden = !dropdown.hidden;
  });
  document.addEventListener("click", (event) => {
    const menu = document.querySelector("[data-account-menu]");
    if (!menu.contains(event.target)) document.querySelector("[data-account-dropdown]").hidden = true;
  });
  document.querySelector("[data-sign-out]").addEventListener("click", async () => {
    document.querySelector("[data-account-dropdown]").hidden = true;
    try {
      await state.clerk?.signOut();
    } finally {
      location.hash = "";
      await route();
    }
  });

  document.querySelector("[data-retry-bootstrap]").addEventListener("click", () => checkBootstrapAndRoute());

  document.querySelector('form[data-form="create-tenant"]').addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    const errorsBox = form.querySelector("[data-form-errors]");
    errorsBox.hidden = true;
    errorsBox.innerHTML = "";
    const submitButton = form.querySelector("[data-submit-create]");
    submitButton.disabled = true;

    const species = [...form.querySelectorAll('input[name="species"]:checked')].map((i) => i.value);
    const capabilities = (form.loc_capabilities.value || "").split(",").map((s) => s.trim()).filter(Boolean);
    const payload = {
      name: form.name.value.trim(),
      slug: form.slug.value.trim() || undefined,
      contactEmail: form.contactEmail.value.trim() || undefined,
      adminEmail: form.adminEmail.value.trim() || undefined,
      location: {
        name: form.loc_name.value.trim(),
        kind: form.loc_kind.value,
        addressLine1: form.loc_address.value.trim(),
        city: form.loc_city.value.trim(),
        region: form.loc_region.value.trim(),
        postalCode: form.loc_postal.value.trim(),
        phone: form.loc_phone.value.trim(),
        latitude: Number(form.loc_latitude.value),
        longitude: Number(form.loc_longitude.value),
        timezone: form.loc_timezone.value.trim() || undefined,
        open24Hours: form.loc_open24.checked,
        acceptsWalkIns: form.loc_walkins.checked,
        autoAccept: form.loc_autoaccept.checked,
        arrivalWindowMinutes: Number(form.loc_arrival.value) || 20,
        species,
        capabilities,
        staffingLevel: form.loc_techstaffed.checked ? "veterinary_technician" : "veterinarian",
        staffingNote: form.loc_staffingnote.value.trim() || undefined,
        baseExamFeeCents: form.loc_examfee.value ? Math.round(Number(form.loc_examfee.value) * 100) : undefined
      },
      policy: {
        depositRequired: form.pol_required.checked,
        depositAmountCents: Math.round(Number(form.pol_amount.value || 0) * 100),
        depositRefundable: form.pol_refundable.checked,
        freeCancelMinutes: Number(form.pol_freecancel.value) || 0,
        completedPlatformFeeCents: Math.round(Number(form.pol_completed.value || 0) * 100),
        noShowPlatformFeeCents: Math.round(Number(form.pol_noshow.value || 0) * 100),
        lateCancelPlatformFeeCents: Math.round(Number(form.pol_latecancel.value || 0) * 100)
      }
    };

    try {
      const result = await apiFetch("/api/admin/tenants", { method: "POST", body: JSON.stringify(payload) });
      // Seated, invited, failed and never-attempted all used to produce the
      // same green toast, so a workspace nobody could sign into looked exactly
      // like one that worked.
      toast(`${payload.name} was created. ${describeAdminResult(result.admin)}`);
      location.hash = `#tenants/${encodeURIComponent(result.tenant.id)}`;
    } catch (error) {
      if (Array.isArray(error.details) && error.details.length) {
        errorsBox.innerHTML = `<strong>Fix the following before continuing:</strong><ul>${error.details.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ul>`;
      } else {
        errorsBox.textContent = error.message;
      }
      errorsBox.hidden = false;
      window.scrollTo({ top: 0, behavior: "smooth" });
    } finally {
      submitButton.disabled = false;
    }
  });

  document.querySelector('form[data-form="error-lookup"]')?.addEventListener("submit", (event) => {
    event.preventDefault();
    loadClientErrors(event.target.reference.value.trim().toUpperCase());
  });

  document.querySelector('form[data-form="ledger-filter"]')?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.target;
    loadLedger({
      tenantId: form.tenantId.value,
      kind: form.kind.value,
      // Dates are inclusive at both ends, so the upper bound is pushed to the
      // end of the day. Without this, "to 3 March" silently excludes
      // everything that happened on 3 March.
      from: form.from.value ? `${form.from.value}T00:00:00.000Z` : "",
      to: form.to.value ? `${form.to.value}T23:59:59.999Z` : "",
      intakeId: form.intakeId.value.trim(),
      unreconciled: form.unreconciled.checked
    });
  });

  document.querySelector('form[data-form="analytics-range"]')?.addEventListener("change", () => loadAnalytics());
  document.querySelector('form[data-form="analytics-range"]')?.addEventListener("submit", (event) => { event.preventDefault(); loadAnalytics(); });

  document.querySelector("[data-open-create-market]")?.addEventListener("click", () => {
    document.querySelector('form[data-form="create-market"]').reset();
    document.querySelector("[data-market-form-errors]").hidden = true;
    document.querySelector("[data-create-market-modal]").hidden = false;
  });
  document.querySelector("[data-close-create-market]")?.addEventListener("click", () => {
    document.querySelector("[data-create-market-modal]").hidden = true;
  });
  document.querySelector('form[data-form="create-market"]')?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    const errorsBox = form.querySelector("[data-market-form-errors]");
    errorsBox.hidden = true;
    const payload = {
      name: form.name.value.trim(),
      centerLatitude: Number(form.centerLatitude.value),
      centerLongitude: Number(form.centerLongitude.value),
      radiusKm: Number(form.radiusKm.value),
      notes: form.notes.value.trim() || undefined
    };
    try {
      const { market } = await apiFetch("/api/admin/markets", { method: "POST", body: JSON.stringify(payload) });
      document.querySelector("[data-create-market-modal]").hidden = true;
      toast(`${market.name} was created.`);
      location.hash = `#markets/${encodeURIComponent(market.id)}`;
    } catch (error) {
      errorsBox.textContent = Array.isArray(error.details) ? error.details.join(" ") : error.message;
      errorsBox.hidden = false;
    }
  });

  document.querySelector('form[data-form="metrics-filter"]')?.addEventListener("submit", (event) => {
    event.preventDefault();
    loadMetrics();
  });

  document.querySelector('[data-toggle="alert-thresholds"]')?.addEventListener("click", () => {
    const el = document.querySelector("[data-alert-thresholds-body]");
    el.hidden = !el.hidden;
    if (!el.hidden) loadAlertThresholds();
  });
  document.querySelector('[data-toggle="readiness-config"]')?.addEventListener("click", () => {
    const el = document.querySelector("[data-readiness-config-body]");
    el.hidden = !el.hidden;
    if (!el.hidden) loadReadinessConfig();
  });

  document.querySelector('form[data-form="clinic-application-filter"]')?.addEventListener("change", () => loadClinicApplications());
  document.querySelector('form[data-form="clinic-contract-filter"]')?.addEventListener("change", () => loadClinicContracts());

  document.querySelectorAll("[data-pif-tab]").forEach((button) => {
    button.addEventListener("click", () => { location.hash = `#pif/${button.dataset.pifTab}`; });
  });

  document.querySelector("[data-action-modal]")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeActionModal();
  });

  window.addEventListener("hashchange", route);
}

/* ----------------------------------------------------------------- boot --- */

/**
 * What actually happened to the first administrator. The Worker has always
 * returned this; nothing read it.
 */
/**
 * The other half of the app's one-sentence failure message.
 *
 * Grouped first — the same failure forty-seven times is one problem, not
 * forty-seven — then the raw rows underneath, newest first.
 */
async function loadClientErrors(reference = "") {
  const groupsMount = document.querySelector("[data-error-groups]");
  const listMount = document.querySelector("[data-error-list]");
  listMount.innerHTML = '<p class="page-lede">Loading…</p>';
  try {
    const query = reference ? `?reference=${encodeURIComponent(reference)}` : "";
    const { errors = [], groups = [] } = await apiFetch(`/api/admin/client-errors${query}`);
    groupsMount.innerHTML = groups.length
      ? `<div class="panel"><h2>Most frequent, last 7 days</h2>${groups.map((group) => `
          <div class="member-row">
            <div class="who"><strong>${escapeHtml(group.code || "no code")} · ${escapeHtml(String(group.status ?? "—"))}</strong><small>${escapeHtml(group.surface)} · ${escapeHtml(group.path || "no route")}</small></div>
            <div><strong>${group.total}</strong> <small>last ${escapeHtml(formatDateTime(group.lastSeen))}</small></div>
          </div>`).join("")}</div>`
      : "";
    listMount.innerHTML = errors.length
      ? `<div class="panel"><h2>${reference ? `Reference ${escapeHtml(reference)}` : "Most recent"}</h2>${errors.map(renderClientError).join("")}</div>`
      : `<div class="panel"><p class="page-lede">${reference ? "No report carries that reference." : "No client errors recorded."}</p></div>`;
  } catch (error) {
    listMount.innerHTML = `<div class="panel"><p class="page-lede">${escapeHtml(error.message)}</p></div>`;
  }
}

function renderClientError(item) {
  const detail = Object.entries(item.detail || {}).map(([key, value]) => `${escapeHtml(key)}=${escapeHtml(String(value))}`).join(" · ");
  return `<div class="member-row">
    <div class="who">
      <strong>${escapeHtml(item.code || "no code")} · ${escapeHtml(String(item.status ?? "—"))} · ${escapeHtml(item.reference)}</strong>
      <small>${escapeHtml(item.surface)}${item.appVersion ? ` ${escapeHtml(item.appVersion)}` : ""} · ${escapeHtml(item.path || "no route")} · ${escapeHtml(formatDateTime(item.occurredAt))}</small>
      <small>${escapeHtml(item.message || "")}</small>
      ${detail ? `<small>${detail}</small>` : ""}
    </div>
  </div>`;
}

/* --------------------------------------------------------------- ledger --- */

const LEDGER_LABELS = {
  deposit_pending: "Deposit pending",
  deposit_captured: "Deposit captured",
  deposit_failed: "Deposit failed",
  deposit_canceled: "Deposit cancelled",
  clinic_transfer: "Transfer to clinic",
  transfer_reversed: "Transfer reversed",
  platform_fee: "Tími fee",
  customer_refund: "Customer refund",
  clinic_payout: "Clinic payout",
  dispute: "Dispute",
  adjustment: "Adjustment"
};

/**
 * The ledger screen.
 *
 * The totals come from the Worker and cover the whole filtered set, not the
 * rows on screen. A running total of the visible 200 out of four thousand is
 * a number that looks authoritative and is wrong, which is worse than showing
 * none.
 */
async function loadLedger(overrides = {}) {
  const totalsMount = document.querySelector("[data-ledger-totals]");
  const listMount = document.querySelector("[data-ledger-list]");
  listMount.innerHTML = '<div class="loading-state"><span class="spinner" aria-hidden="true"></span><p>Loading ledger…</p></div>';
  const filters = { ...state.ledgerFilters, ...overrides };
  state.ledgerFilters = filters;

  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== "" && value !== null && value !== undefined && value !== false) query.set(key, String(value));
  }
  query.set("limit", "300");

  try {
    const data = await apiFetch(`/api/admin/ledger?${query.toString()}`);
    renderLedgerTenantOptions(data.tenants || [], filters.tenantId);
    totalsMount.innerHTML = renderLedgerTotals(data.totals);
    listMount.innerHTML = data.entries.length
      ? `<div class="panel">
           <div class="page-head" style="margin-bottom:1rem;">
             <h2 style="margin:0;">${data.entries.length} entr${data.entries.length === 1 ? "y" : "ies"}</h2>
             <button class="button button-small" type="button" data-ledger-reconcile>Mark selected reconciled</button>
           </div>
           ${data.entries.map(renderLedgerRow).join("")}
         </div>`
      : '<div class="empty-state"><p>No ledger entries match that filter. Nothing has moved, or the filter is too narrow.</p></div>';
    wireLedgerActions();
  } catch (error) {
    totalsMount.innerHTML = "";
    listMount.innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function renderLedgerTenantOptions(tenants, selected) {
  const select = document.querySelector("[data-ledger-tenants]");
  if (!select || select.dataset.filled === "true") return;
  select.innerHTML = `<option value="">All clinics</option>${tenants.map((tenant) => `<option value="${escapeAttr(tenant.id)}" ${tenant.id === selected ? "selected" : ""}>${escapeHtml(tenant.name)}${tenant.stripeAccountId ? "" : " (no Stripe account)"}</option>`).join("")}`;
  select.dataset.filled = "true";
}

function renderLedgerTotals(totals) {
  if (!totals) return "";
  return `<div class="tenant-summary" style="margin-bottom:1.25rem;">
    <span><small>Entries</small><strong>${totals.entries}</strong></span>
    <span><small>In (to Tími)</small><strong>${formatCents(totals.inCents)}</strong></span>
    <span><small>Out (to clinics and customers)</small><strong>${formatCents(totals.outCents)}</strong></span>
    <span><small>Net held</small><strong>${formatCents(totals.netCents)}</strong></span>
    <span><small>Tími fees retained</small><strong>${formatCents(totals.platformFeeCents)}</strong></span>
    <span><small>Transferred to clinics</small><strong>${formatCents(totals.transferredCents)}</strong></span>
    <span><small>Refunded to customers</small><strong>${formatCents(totals.refundedCents)}</strong></span>
    <span><small>Unreconciled</small><strong>${totals.unreconciledEntries} · ${formatCents(totals.unreconciledInCents + totals.unreconciledOutCents)}</strong></span>
  </div>`;
}

/**
 * One row. Every Stripe id it has is on screen, because the reason somebody
 * opened this page is to paste one of them into Stripe.
 */
function renderLedgerRow(entry) {
  const ids = [
    ["pi", entry.paymentIntentId],
    ["ch", entry.chargeId],
    ["tr", entry.transferId],
    ["re", entry.refundId],
    ["po", entry.payoutId],
    ["txn", entry.balanceTransactionId],
    ["acct", entry.stripeAccountId],
    ["group", entry.transferGroup],
    ["evt", entry.stripeEventId]
  ].filter(([, value]) => Boolean(value))
    .map(([label, value]) => `${escapeHtml(label)} ${escapeHtml(value)}`)
    .join(" · ");
  const sign = entry.direction === "in" ? "+" : "−";
  return `<div class="member-row">
    <div class="who">
      <strong>${escapeHtml(LEDGER_LABELS[entry.kind] || entry.kind)} · ${escapeHtml(entry.status)}</strong>
      <small>${escapeHtml(formatDateTime(entry.occurredAt))}${entry.intakeId ? ` · <a href="#ledger" data-ledger-intake="${escapeAttr(entry.intakeId)}">${escapeHtml(entry.intakeId)}</a>` : ""}${entry.availableOn ? ` · available ${escapeHtml(formatDate(entry.availableOn))}` : ""}</small>
      <small style="word-break:break-all;">${ids || "no Stripe object"}</small>
      ${entry.feeCents ? `<small>Stripe fee ${formatCents(entry.feeCents)} · net ${formatCents(entry.netCents)}</small>` : ""}
    </div>
    <div style="text-align:right;">
      <strong>${sign}${formatCents(entry.amountCents)}</strong>
      <small style="display:block;">${entry.reconciled ? "reconciled" : `<label style="display:inline-flex; gap:.3rem; align-items:center;"><input type="checkbox" data-ledger-select value="${escapeAttr(entry.id)}"> unreconciled</label>`}</small>
    </div>
  </div>`;
}

function wireLedgerActions() {
  document.querySelector("[data-ledger-reconcile]")?.addEventListener("click", async (event) => {
    const ids = [...document.querySelectorAll("[data-ledger-select]:checked")].map((input) => input.value);
    if (!ids.length) { toast("Select the entries you have matched against a Stripe payout.", true); return; }
    event.target.disabled = true;
    try {
      const { reconciled } = await apiFetch("/api/admin/ledger/reconcile", { method: "POST", body: JSON.stringify({ ids }) });
      toast(`${reconciled} entr${reconciled === 1 ? "y" : "ies"} marked reconciled.`);
      await loadLedger();
    } catch (error) {
      toast(error.message, true);
    } finally {
      event.target.disabled = false;
    }
  });

  document.querySelectorAll("[data-ledger-intake]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      // Everything Tími did for one intake, which is the natural unit when a
      // customer says a number does not look right.
      document.querySelector('form[data-form="ledger-filter"]').intakeId.value = link.dataset.ledgerIntake;
      loadLedger({ intakeId: link.dataset.ledgerIntake, tenantId: "" });
    });
  });
}

/* ------------------------------------------------------------ analytics --- */

/**
 * First-party analytics summary. Visitors are daily-rotating anonymous
 * hashes, so per-day visitor counts are honest but cannot be summed into
 * "unique visitors" across the window — the total is labelled visitor-days.
 */
async function loadAnalytics() {
  const mount = document.querySelector("[data-analytics-body]");
  mount.innerHTML = '<div class="loading-state"><span class="spinner" aria-hidden="true"></span><p>Loading analytics…</p></div>';
  const days = Number(document.querySelector('form[data-form="analytics-range"]')?.days?.value) || 7;
  try {
    const data = await apiFetch(`/api/admin/analytics/summary?days=${encodeURIComponent(days)}`);
    renderAnalytics(data);
  } catch (error) {
    mount.innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function countLines(rows, labelKey) {
  if (!rows?.length) return '<p class="page-lede">Nothing recorded yet.</p>';
  const max = Math.max(...rows.map((row) => Number(row.count) || 0), 1);
  return `<div class="count-list">${rows.map((row) => `
    <div>
      <div class="count-line"><span>${escapeHtml(row[labelKey] || "—")}</span><span>${Number(row.count) || 0}</span></div>
      <span class="count-bar"><i style="width:${Math.max(2, Math.round(((Number(row.count) || 0) / max) * 100))}%"></i></span>
    </div>`).join("")}</div>`;
}

function renderAnalytics(data) {
  const mount = document.querySelector("[data-analytics-body]");
  const days = data.days || [];
  const totalEvents = days.reduce((sum, day) => sum + (Number(day.events) || 0), 0);
  const totalVisitorDays = days.reduce((sum, day) => sum + (Number(day.visitors) || 0), 0);
  const busiest = days.reduce((top, day) => ((Number(day.events) || 0) > (Number(top?.events) || 0) ? day : top), null);
  const maxDayEvents = Math.max(...days.map((day) => Number(day.events) || 0), 1);
  const surfaces = data.surfaces || [];

  mount.innerHTML = `
    <div class="stat-row">
      <span><small>Events</small><strong>${totalEvents}</strong></span>
      <span><small>Visitor-days</small><strong>${totalVisitorDays}</strong></span>
      <span><small>Busiest day</small><strong>${busiest ? escapeHtml(formatDate(busiest.date)) : "—"}</strong></span>
      <span><small>Surfaces reporting</small><strong>${surfaces.length}</strong></span>
    </div>
    <div class="grid-2">
      <div class="panel">
        <h2>Per day</h2>
        <div class="table-wrap" style="border:1px solid var(--line); box-shadow:none;">
          <table class="data-table" style="min-width:0;">
            <thead><tr><th>Date</th><th>Visitors</th><th>Events</th><th style="width:38%"></th></tr></thead>
            <tbody>${days.length ? days.map((day) => `
              <tr>
                <td>${escapeHtml(formatDate(day.date))}</td>
                <td>${Number(day.visitors) || 0}</td>
                <td>${Number(day.events) || 0}</td>
                <td><span class="count-bar"><i style="width:${Math.max(2, Math.round(((Number(day.events) || 0) / maxDayEvents) * 100))}%"></i></span></td>
              </tr>`).join("") : '<tr class="empty-row"><td colspan="4">No events in this window.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
      <div>
        <div class="panel">
          <h2>Surfaces</h2>
          ${surfaces.length ? `<div class="count-list">${surfaces.map((surface) => `
            <div class="count-line"><span>${escapeHtml(surface.surface || "unknown")}</span><span>${Number(surface.events) || 0} events · ${Number(surface.visitors) || 0} visitors</span></div>`).join("")}</div>` : '<p class="page-lede">Nothing recorded yet.</p>'}
        </div>
        <div class="panel">
          <h2>Top events</h2>
          ${countLines(data.names, "name")}
        </div>
        <div class="panel">
          <h2>Top paths</h2>
          ${countLines(data.paths, "path")}
        </div>
      </div>
    </div>`;
}

/* ------------------------------------------------- provider applications --- */

const APPLICATION_STATUSES = ["new", "contacted", "closed"];

async function loadApplications() {
  const mount = document.querySelector("[data-applications-body]");
  mount.innerHTML = '<div class="loading-state"><span class="spinner" aria-hidden="true"></span><p>Loading applications…</p></div>';
  try {
    const data = await apiFetch("/api/admin/provider-applications");
    renderApplications(data.applications || []);
  } catch (error) {
    mount.innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function renderApplications(applications) {
  const mount = document.querySelector("[data-applications-body]");
  if (!applications.length) {
    mount.innerHTML = '<div class="table-wrap"><table class="data-table"><tbody><tr class="empty-row"><td>No provider applications yet. They arrive from the public site\'s "For veterinary teams" page.</td></tr></tbody></table></div>';
    return;
  }
  const rows = applications.map((application) => `
    <tr>
      <td><strong>${escapeHtml(application.practiceName || "—")}</strong>${application.species ? `<br><small style="color:var(--muted);">${escapeHtml(application.species)}</small>` : ""}</td>
      <td>${escapeHtml(application.contactName || "—")}<br><small style="color:var(--muted);"><a href="mailto:${escapeAttr(application.email || "")}" style="color:var(--blue);">${escapeHtml(application.email || "")}</a> · ${escapeHtml(application.phone || "")}</small></td>
      <td>${escapeHtml(application.city || "—")}, ${escapeHtml(application.state || "—")}</td>
      <td style="max-width:280px;">${application.message ? `<small>${escapeHtml(application.message)}</small>` : '<small style="color:var(--muted);">—</small>'}</td>
      <td>${formatDate(application.createdAt)}</td>
      <td>
        <select data-application-status data-id="${escapeAttr(application.id)}">
          ${APPLICATION_STATUSES.map((status) => `<option value="${status}" ${application.status === status ? "selected" : ""}>${status}</option>`).join("")}
        </select>
      </td>
    </tr>`).join("");
  mount.innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>Practice</th><th>Contact</th><th>Location</th><th>Message</th><th>Received</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  mount.querySelectorAll("[data-application-status]").forEach((select) => {
    select.addEventListener("change", async () => {
      select.disabled = true;
      try {
        await apiFetch(`/api/admin/provider-applications/${encodeURIComponent(select.dataset.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ status: select.value })
        });
        toast(`Marked ${select.value}.`);
      } catch (error) {
        toast(error.message, true);
        await loadApplications();
        return;
      } finally {
        select.disabled = false;
      }
    });
  });
}

/* -------------------------------------------------- clinic applications --- */
/**
 * Join requests from the public clinic sign-up portal (`POST
 * /api/clinic-applications`). Distinct from the "Applications" screen, which
 * is the older provider-interest lead form — a different table, a different
 * lifecycle, and no review action of its own.
 */
const CLINIC_APPLICATION_TONE = {
  SUBMITTED: "info", REVIEWING: "warn", APPROVED: "good", DECLINED: "bad", WITHDRAWN: "neutral"
};

async function loadClinicApplications() {
  const mount = document.querySelector("[data-clinic-applications-body]");
  mount.innerHTML = '<div class="loading-state"><span class="spinner" aria-hidden="true"></span><p>Loading clinic applications…</p></div>';
  const status = document.querySelector('form[data-form="clinic-application-filter"]')?.status?.value || "";
  try {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    const [{ applications = [] }] = await Promise.all([
      apiFetch(`/api/admin/clinic-applications${query}`),
      ensureTenantNames()
    ]);
    renderClinicApplications(applications);
  } catch (error) {
    mount.innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function clinicApplicationCard(app) {
  const address = [app.addressLine1, app.city, app.region, app.postalCode].filter(Boolean).join(", ");
  const canDecide = app.status === "SUBMITTED" || app.status === "REVIEWING";
  return `<div class="panel" data-application-card="${escapeAttr(app.id)}">
    <div class="page-head" style="margin-bottom:.6rem; align-items:flex-start;">
      <div>
        <h2 style="margin-bottom:.2rem;">${escapeHtml(app.practiceName)}${app.wantsFounding ? ' <span class="hint">— wants founding status</span>' : ""}</h2>
        <p class="page-lede" style="margin:0;">${escapeHtml(app.contactName)} · <a href="mailto:${escapeAttr(app.email)}" style="color:var(--blue);">${escapeHtml(app.email)}</a> · ${escapeHtml(app.phone)}</p>
      </div>
      ${tonePill(app.status, CLINIC_APPLICATION_TONE[app.status] || "neutral")}
    </div>
    <p class="page-lede" style="margin:0 0 .4rem;">${escapeHtml(address || "No address given")}${app.kind ? ` · ${escapeHtml(app.kind)}` : ""}${app.website ? ` · <a href="${escapeAttr(app.website)}" target="_blank" rel="noopener" style="color:var(--blue);">${escapeHtml(app.website)}</a>` : ""}</p>
    ${(app.species?.length || app.capabilities?.length) ? `<p class="page-lede" style="margin:0 0 .4rem;">${[...(app.species || []), ...(app.capabilities || [])].map(escapeHtml).join(", ")}</p>` : ""}
    ${app.license?.number ? `<p class="page-lede" style="margin:0 0 .4rem;">License ${escapeHtml(app.license.number)}${app.license.authority ? ` (${escapeHtml(app.license.authority)})` : ""}${app.license.expiresOn ? `, expires ${escapeHtml(formatDate(app.license.expiresOn))}` : ""}</p>` : ""}
    ${app.notes ? `<p class="page-lede" style="margin:0 0 .4rem;">“${escapeHtml(app.notes)}”</p>` : ""}
    <p class="page-lede" style="margin:0 0 .8rem; font-size:.68rem;">Received ${escapeHtml(formatDateTime(app.createdAt))}${app.reviewedAt ? ` · last reviewed ${escapeHtml(formatDateTime(app.reviewedAt))}${app.reviewedBy ? ` by ${escapeHtml(app.reviewedBy)}` : ""}` : ""}</p>
    ${app.status === "DECLINED" && app.declineReason ? `<p class="page-lede" style="margin:0 0 .8rem;"><strong>Decline reason:</strong> ${escapeHtml(app.declineReason)}</p>` : ""}
    ${app.status === "APPROVED" && app.createdTenantId ? `<p class="page-lede" style="margin:0 0 .8rem;"><strong>Created tenant:</strong> <a class="row-link" href="#tenants/${encodeURIComponent(app.createdTenantId)}">${escapeHtml(tenantLabel(app.createdTenantId))}</a> · <a class="row-link" href="#clinic-contracts/${encodeURIComponent(app.createdTenantId)}">contract profile</a></p>` : ""}
    ${canDecide ? `<div class="form-actions" style="justify-content:flex-start; margin-top:0;">
      ${app.status === "SUBMITTED" ? `<button class="button button-small" type="button" data-app-action="review" data-app-id="${escapeAttr(app.id)}">Start review</button>` : ""}
      <button class="button button-small button-primary" type="button" data-app-action="approve" data-app-id="${escapeAttr(app.id)}">Approve</button>
      <button class="button button-small button-danger" type="button" data-app-action="decline" data-app-id="${escapeAttr(app.id)}">Decline</button>
      <button class="button button-small" type="button" data-app-action="withdraw" data-app-id="${escapeAttr(app.id)}">Mark withdrawn</button>
    </div>` : ""}
  </div>`;
}

function renderClinicApplications(applications) {
  const mount = document.querySelector("[data-clinic-applications-body]");
  mount.innerHTML = applications.length
    ? applications.map(clinicApplicationCard).join("")
    : '<div class="empty-state"><p>No clinic applications match this filter.</p></div>';
  wireClinicApplicationEvents();
}

async function decideClinicApplication(id, body) {
  await apiFetch(`/api/admin/clinic-applications/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify(body) });
}

function wireClinicApplicationEvents() {
  document.querySelectorAll("[data-app-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.appId;
      const action = button.dataset.appAction;
      if (action === "review") {
        button.disabled = true;
        try {
          await decideClinicApplication(id, { action: "review" });
          toast("Marked reviewing.");
          await loadClinicApplications();
        } catch (error) {
          toast(error.message, true);
          button.disabled = false;
        }
        return;
      }
      if (action === "approve") {
        openActionModal({
          title: "Approve clinic application",
          lede: "Creates the tenant (and, if a plan other than standard is chosen, its pricing assignment). This does not create a location — add one from the new tenant's page afterward.",
          fields: [
            { name: "tenantName", label: "Workspace name", type: "text" },
            { name: "plan", label: "Pricing plan", type: "select", options: ["STANDARD", "FOUNDING", "CUSTOM"], value: "STANDARD", blank: false },
            { name: "customFeeCents", label: "Custom clinic fee", type: "money", hint: "USD, required if plan is Custom" },
            { name: "contractId", label: "Contract reference", type: "text", hint: "required if plan is Founding or Custom" },
            { name: "note", label: "Note", type: "textarea" }
          ],
          submitLabel: "Approve",
          onSubmit: async (payload) => {
            await decideClinicApplication(id, { action: "approve", ...payload });
            state.tenantNames = null; // a new tenant just came into existence
            toast("Application approved. Tenant created.");
            await loadClinicApplications();
          }
        });
        return;
      }
      if (action === "decline") {
        openActionModal({
          title: "Decline clinic application",
          fields: [{ name: "reason", label: "Reason", type: "textarea", required: true }],
          submitLabel: "Decline",
          onSubmit: async (payload) => {
            await decideClinicApplication(id, { action: "decline", ...payload });
            toast("Application declined.");
            await loadClinicApplications();
          }
        });
        return;
      }
      if (action === "withdraw") {
        openActionModal({
          title: "Mark application withdrawn",
          lede: "For when the practice tells you they're no longer applying.",
          fields: [{ name: "reason", label: "Reason", type: "textarea" }],
          submitLabel: "Mark withdrawn",
          onSubmit: async (payload) => {
            await decideClinicApplication(id, { action: "withdraw", ...payload });
            toast("Application marked withdrawn.");
            await loadClinicApplications();
          }
        });
      }
    });
  });
}

/* ------------------------------------------------------ clinic contracts --- */

const CONTRACT_STATUS_TONE = {
  DRAFT: "neutral", PENDING_SIGNATURE: "warn", EXECUTED: "good", SUPERSEDED: "neutral", TERMINATED: "bad", VOID: "bad"
};
const FOUNDING_STATUS_TONE = {
  NOT_APPLICABLE: "neutral", ACTIVE: "good", TEMPORARILY_INACTIVE: "warn",
  SEPARATED_ELIGIBLE_TO_RESTORE: "warn", REVOKED_FOR_CAUSE: "bad"
};
const LIFECYCLE_TONE = {
  PENDING_CONTRACT: "neutral", PENDING_ONBOARDING: "warn", ACTIVE: "good", TEMPORARILY_INACTIVE: "warn",
  SUSPENDED: "bad", VOLUNTARY_SEPARATION_PENDING: "warn", SEPARATED: "bad", TERMINATED_FOR_CAUSE: "bad", REJOIN_REVIEW: "info"
};

const CAUSE_CATEGORIES = [
  "FRAUD", "VISIT_OR_PAYMENT_FALSIFICATION", "INTENTIONAL_FEE_CIRCUMVENTION", "PAW_IT_FORWARD_FUND_MISUSE",
  "DEPOSIT_DOUBLE_COLLECTION", "MATERIAL_SECURITY_ABUSE", "MATERIAL_UNLAWFUL_CONDUCT", "UNCURED_MATERIAL_BREACH"
];
const CONTRACT_STATUSES = ["DRAFT", "PENDING_SIGNATURE", "EXECUTED", "SUPERSEDED", "TERMINATED", "VOID"];
const DEPOSIT_ELECTIONS = ["NO_DEPOSIT_REQUIRED", "WAIVE_FOR_PAW_IT_FORWARD", "ACCEPT_PIF_GUARANTEE", "CUSTOMER_FUNDED_DEPOSIT"];
const REPRESENTATIVE_ROLES = [
  "AUTHORIZED_REPRESENTATIVE", "AUTHORIZED_SIGNER", "BILLING_CONTACT",
  "LEGAL_NOTICE_CONTACT", "PRACTICE_ADMINISTRATOR", "MEDICAL_DIRECTOR", "STAFF_USER"
];
const AUTHORITY_SCOPES = ["ROUTINE", "ACTUAL_AUTHORITY_TO_BIND"];
const MANAGEMENT_EVENT_TYPES = [
  "OWNER_CONTROL", "LEGAL_ENTITY", "MANAGEMENT_COMPANY", "ADMINISTRATOR",
  "MEDICAL_DIRECTOR", "BILLING", "AUTHORIZED_REPRESENTATIVE"
];

async function loadClinicContracts() {
  const mount = document.querySelector("[data-clinic-contracts-body]");
  mount.innerHTML = '<div class="loading-state"><span class="spinner" aria-hidden="true"></span><p>Loading clinic contracts…</p></div>';
  const status = document.querySelector('form[data-form="clinic-contract-filter"]')?.status?.value || "";
  try {
    await ensureTenantNames();
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    const { contracts = [] } = await apiFetch(`/api/admin/clinic-contracts${query}`);
    renderClinicContracts(contracts);
  } catch (error) {
    mount.innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function renderClinicContracts(contracts) {
  const mount = document.querySelector("[data-clinic-contracts-body]");
  if (!contracts.length) {
    mount.innerHTML = '<div class="table-wrap"><table class="data-table"><tbody><tr class="empty-row"><td>No contracts match this filter. Record one from a clinic\'s contract profile.</td></tr></tbody></table></div>';
    return;
  }
  const rows = contracts.map((c) => `
    <tr>
      <td><a class="row-link" href="#clinic-contracts/${encodeURIComponent(c.tenantId)}">${escapeHtml(tenantLabel(c.tenantId))}</a><br><small style="color:var(--muted);">${escapeHtml(c.clinicLegalName)}</small></td>
      <td>${tonePill(c.status, CONTRACT_STATUS_TONE[c.status] || "neutral")}</td>
      <td>${escapeHtml(c.agreementVersion)}</td>
      <td>${c.effectiveDate ? escapeHtml(formatDate(c.effectiveDate)) : "—"}</td>
      <td>${c.depositElection ? escapeHtml(labelize(c.depositElection)) : "—"}</td>
      <td>${formatDate(c.createdAt)}</td>
    </tr>`).join("");
  mount.innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>Clinic</th><th>Status</th><th>Agreement version</th><th>Effective</th><th>Deposit election</th><th>Recorded</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

/* ----------------------------------------------- clinic contract detail --- */
/**
 * The full addendum §19 profile for one clinic: its agreement, founding
 * status, lifecycle, representatives, management history, separation, and
 * rejoin requests — plus every lifecycle-changing action the backend exposes
 * (src/clinic-contracts.js `handleClinicContractUpdate`), each through the
 * generic action modal above.
 */
async function loadClinicContractDetail(tenantId) {
  const mount = document.querySelector("[data-clinic-contract-detail-body]");
  mount.innerHTML = '<div class="loading-state"><span class="spinner" aria-hidden="true"></span><p>Loading clinic…</p></div>';
  try {
    const [{ profile }] = await Promise.all([
      apiFetch(`/api/admin/clinics/${encodeURIComponent(tenantId)}/contract`),
      ensureTenantNames()
    ]);
    renderClinicContractDetail(tenantId, profile);
  } catch (error) {
    mount.innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function contractAction(tenantId, action, payload) {
  return apiFetch(`/api/admin/clinics/${encodeURIComponent(tenantId)}/contract`, {
    method: "POST", body: JSON.stringify({ action, ...payload })
  });
}
function reloadClinicContractDetail(tenantId) { return loadClinicContractDetail(tenantId); }

function renderContractPanel(tenantId, contract) {
  return `<div class="panel">
    <div class="page-head" style="margin-bottom:.6rem;">
      <h2 style="margin:0;">Agreement</h2>
      ${contract ? tonePill(contract.status, CONTRACT_STATUS_TONE[contract.status] || "neutral") : ""}
    </div>
    ${contract ? `
      <div class="tenant-summary">
        <span><small>Legal name</small><strong style="font-size:.85rem;">${escapeHtml(contract.clinicLegalName)}</strong></span>
        <span><small>DBA</small><strong style="font-size:.85rem;">${escapeHtml(contract.clinicDba || "—")}</strong></span>
        <span><small>Agreement version</small><strong style="font-size:.85rem;">${escapeHtml(contract.agreementVersion)}</strong></span>
        <span><small>Effective</small><strong style="font-size:.85rem;">${contract.effectiveDate ? escapeHtml(formatDate(contract.effectiveDate)) : "—"}</strong></span>
        <span><small>Deposit election</small><strong style="font-size:.85rem;">${contract.depositElection ? escapeHtml(labelize(contract.depositElection)) : "—"}</strong></span>
        <span><small>Contracting entity</small><strong style="font-size:.75rem;">${escapeHtml(contract.contractingEntity)}</strong></span>
        <span><small>Authorized signer</small><strong style="font-size:.75rem;">${contract.authorizedSigner ? escapeHtml(`${contract.authorizedSigner.name}${contract.authorizedSigner.title ? `, ${contract.authorizedSigner.title}` : ""}`) : "—"}</strong></span>
        <span><small>Document</small><strong style="font-size:.7rem; word-break:break-all;">${escapeHtml(contract.agreementDocumentId || "—")}</strong></span>
      </div>
      ${contract.notes ? `<p class="page-lede">${escapeHtml(contract.notes)}</p>` : ""}
    ` : '<p class="page-lede">No agreement recorded yet for this clinic.</p>'}
    <div class="form-actions" style="justify-content:flex-start; margin-top:.5rem;">
      <button class="button button-small button-primary" type="button" data-contract-action="record_contract">${contract ? "Record new agreement" : "Record agreement"}</button>
    </div>
  </div>`;
}

function renderFoundingPanel(founding, pricing) {
  return `<div class="panel">
    <div class="page-head" style="margin-bottom:.6rem;">
      <h2 style="margin:0;">Founding status &amp; pricing</h2>
      ${tonePill(founding.status, FOUNDING_STATUS_TONE[founding.status] || "neutral")}
    </div>
    <div class="tenant-summary">
      <span><small>Plan</small><strong style="font-size:.85rem;">${escapeHtml(pricing.plan)}</strong></span>
      <span><small>Applicable fee</small><strong style="font-size:.85rem;">${formatCents(pricing.applicableFeeCents)}</strong></span>
      <span><small>Reason</small><strong style="font-size:.7rem;">${escapeHtml(labelize(pricing.reason || ""))}</strong></span>
      <span><small>Good standing</small><strong style="font-size:.85rem;">${founding.goodStanding ? "Yes" : "No"}</strong></span>
      <span><small>Rejoin eligible</small><strong style="font-size:.85rem;">${founding.rejoinEligible ? "Yes" : "No"}</strong></span>
      <span><small>Granted</small><strong style="font-size:.75rem;">${founding.grantedAt ? escapeHtml(formatDate(founding.grantedAt)) : "—"}</strong></span>
    </div>
    ${founding.history?.length ? `
      <h3 style="font-size:.8rem; margin: .8rem 0 .4rem;">History</h3>
      <div class="audit-list">${founding.history.slice(0, 10).map((h) => `
        <div class="audit-row">
          <time>${formatDateTime(h.effectiveAt)}</time>
          <div><span class="action">${escapeHtml(labelize(h.status))}</span><div class="detail">${escapeHtml(h.reason || h.causeCategory || "")}</div></div>
          <span class="pill role-member">${escapeHtml(h.recordedBy || "system")}</span>
        </div>`).join("")}</div>` : ""}
    <div class="form-actions" style="justify-content:flex-start; margin-top:.8rem; flex-wrap:wrap;">
      <button class="button button-small" type="button" data-contract-action="grant_founding">Grant founding status</button>
      <button class="button button-small" type="button" data-contract-action="set_founding_status">Change founding status</button>
      <button class="button button-small" type="button" data-contract-action="surrender_founding">Surrender founding status</button>
      <button class="button button-small button-danger" type="button" data-contract-action="revoke_founding_for_cause">Revoke for cause</button>
    </div>
  </div>`;
}

function renderLifecyclePanel(lifecycle, events) {
  return `<div class="panel">
    <div class="page-head" style="margin-bottom:.6rem;">
      <h2 style="margin:0;">Lifecycle</h2>
      ${lifecycle ? tonePill(lifecycle.status, LIFECYCLE_TONE[lifecycle.status] || "neutral") : tonePill("PENDING_CONTRACT", "neutral")}
    </div>
    ${lifecycle ? `<p class="page-lede">${escapeHtml(lifecycle.reason || "")}${lifecycle.activeForReferrals ? " · active for referrals" : " · not receiving referrals"}</p>` : ""}
    ${events?.length ? `
      <div class="audit-list">${events.slice(0, 8).map((e) => `
        <div class="audit-row">
          <time>${formatDateTime(e.effectiveAt)}</time>
          <div><span class="action">${escapeHtml(labelize(e.fromStatus || "—"))} → ${escapeHtml(labelize(e.toStatus))}</span><div class="detail">${escapeHtml(e.reason || "")}</div></div>
          <span class="pill role-member">${escapeHtml(e.triggerSource)}</span>
        </div>`).join("")}</div>` : '<p class="page-lede">No lifecycle events yet.</p>'}
    <div class="form-actions" style="justify-content:flex-start; margin-top:.8rem;">
      <button class="button button-small" type="button" data-contract-action="set_lifecycle">Change lifecycle status</button>
    </div>
  </div>`;
}

function renderSeparationPanel(tenantId, separation, obligations, windDown, rejoinRequests) {
  const obligationsBad = obligations?.uncured;
  return `<div class="panel">
    <h2>Separation &amp; wind-down</h2>
    ${separation ? `
      <div class="tenant-summary">
        <span><small>Kind</small><strong style="font-size:.85rem;">${escapeHtml(labelize(separation.kind))}</strong></span>
        <span><small>Initiated by</small><strong style="font-size:.85rem;">${escapeHtml(labelize(separation.initiatedBy))}</strong></span>
        <span><small>Cause</small><strong style="font-size:.75rem;">${escapeHtml(separation.causeCategory ? labelize(separation.causeCategory) : "—")}</strong></span>
        <span><small>Effective</small><strong style="font-size:.85rem;">${separation.effectiveAt ? escapeHtml(formatDate(separation.effectiveAt)) : "—"}</strong></span>
        <span><small>Wind-down complete</small><strong style="font-size:.85rem;">${separation.windDownComplete ? "Yes" : "No"}</strong></span>
        <span><small>Obligations cleared</small><strong style="font-size:.85rem;">${separation.obligationsCleared ? "Yes" : "No"}</strong></span>
      </div>
      ${separation.reason ? `<p class="page-lede">${escapeHtml(separation.reason)}</p>` : ""}
    ` : '<p class="page-lede">This clinic has never been separated from the platform.</p>'}
    <p class="page-lede" style="${obligationsBad ? "color:var(--coral-dark); font-weight:700;" : ""}">
      Surviving obligations: ${obligations.outstandingReceivableCount} unpaid fee${obligations.outstandingReceivableCount === 1 ? "" : "s"} (${formatCents(obligations.outstandingReceivableCents)}), ${obligations.openInvoiceCount} open invoice${obligations.openInvoiceCount === 1 ? "" : "s"} (${formatCents(obligations.openInvoiceCents)}).
    </p>
    ${windDown?.length ? `<p class="page-lede">${windDown.length} booking${windDown.length === 1 ? "" : "s"} still to be seen through before this clinic can go fully quiet.</p>` : ""}
    <div class="form-actions" style="justify-content:flex-start; margin-top:.5rem; flex-wrap:wrap;">
      <button class="button button-small button-danger" type="button" data-contract-action="separate">Separate this clinic</button>
      ${separation && !separation.windDownComplete ? `<button class="button button-small" type="button" data-contract-action="complete_wind_down">Mark wind-down complete</button>` : ""}
    </div>

    <h3 style="font-size:.9rem; margin: 1.2rem 0 .4rem;">Rejoin requests</h3>
    ${rejoinRequests?.length ? rejoinRequests.map((r) => `
      <div class="member-row">
        <div class="who"><strong>${escapeHtml(r.requestedByName || r.requestedByEmail || "—")}</strong><small>${escapeHtml(formatDateTime(r.requestedAt))} · ${escapeHtml(r.status)}${r.foundingRestored ? " · founding restored" : ""}</small></div>
      </div>`).join("") : '<p class="page-lede">No rejoin requests on file.</p>'}
    <div class="form-actions" style="justify-content:flex-start; margin-top:.5rem; flex-wrap:wrap;">
      <button class="button button-small" type="button" data-contract-action="request_rejoin">Record a rejoin request</button>
      <button class="button button-small" type="button" data-contract-action="restore_founding">Decide founding restoration</button>
    </div>
  </div>`;
}

function renderRepresentativesPanel(tenantId, representatives) {
  return `<div class="panel">
    <h2>Authorized representatives</h2>
    ${representatives.length ? representatives.map((r) => `
      <div class="member-row">
        <div class="who"><strong>${escapeHtml(r.name)}</strong><small>${escapeHtml(r.email)} · ${escapeHtml(labelize(r.role))} · ${escapeHtml(labelize(r.authorityScope))}</small></div>
        <div class="member-actions"><button class="button button-small button-danger" type="button" data-end-representative="${escapeAttr(r.id)}">End</button></div>
      </div>`).join("") : '<p class="page-lede">No active representatives on file.</p>'}
    <div class="form-actions" style="justify-content:flex-start; margin-top:.8rem;">
      <button class="button button-small" type="button" data-contract-action="add_representative">Add representative</button>
    </div>
  </div>`;
}

function renderManagementEventsPanel(events) {
  return `<div class="panel">
    <h2>Management &amp; ownership changes</h2>
    <p class="page-lede">§3/§9: none of these, by themselves, end the agreement or the founding waiver.</p>
    ${events.length ? `<div class="audit-list">${events.slice(0, 10).map((e) => `
      <div class="audit-row">
        <time>${formatDateTime(e.effectiveAt)}</time>
        <div><span class="action">${escapeHtml(labelize(e.eventType))}</span><div class="detail">${escapeHtml(e.oldValue || "—")} → ${escapeHtml(e.newValue || "—")}${e.requiresSuccessorReview ? " · needs successor review" : ""}</div></div>
        <span class="pill role-member">${escapeHtml(e.recordedBy || "—")}</span>
      </div>`).join("")}</div>` : '<p class="page-lede">No management changes recorded.</p>'}
    <div class="form-actions" style="justify-content:flex-start; margin-top:.8rem;">
      <button class="button button-small" type="button" data-contract-action="record_management_event">Record a management change</button>
    </div>
  </div>`;
}

function renderClinicContractDetail(tenantId, profile) {
  const mount = document.querySelector("[data-clinic-contract-detail-body]");
  const { contract, founding, pricing, lifecycle, lifecycleEvents, representatives, managementEvents, separation, survivingObligations, windDownBookings, rejoinRequests } = profile;
  mount.innerHTML = `
    <div class="page-head">
      <div>
        <p class="eyebrow">Clinic contract profile</p>
        <h1 class="page-title">${escapeHtml(tenantLabel(tenantId))}</h1>
      </div>
    </div>
    <div class="grid-2">
      <div>
        ${renderContractPanel(tenantId, contract)}
        ${renderFoundingPanel(founding, pricing)}
        ${renderLifecyclePanel(lifecycle, lifecycleEvents)}
      </div>
      <div>
        ${renderRepresentativesPanel(tenantId, representatives)}
        ${renderManagementEventsPanel(managementEvents)}
        ${renderSeparationPanel(tenantId, separation, survivingObligations, windDownBookings, rejoinRequests)}
      </div>
    </div>`;
  wireClinicContractActions(tenantId, profile);
}

/** Field specs for every `handleClinicContractUpdate` action. Kept as data so
 * the generic action modal can render and submit each one uniformly. */
function contractActionSpec(action, profile) {
  const latestSeparationId = profile.separation?.id || null;
  const latestRejoinId = profile.rejoinRequests?.[0]?.id || null;
  switch (action) {
    case "record_contract":
      return {
        title: "Record an executed agreement",
        lede: "A new EXECUTED agreement supersedes whichever one is currently in force.",
        submitLabel: "Record agreement",
        fields: [
          { name: "clinicLegalName", label: "Clinic legal name", required: true, value: profile.contract?.clinicLegalName },
          { name: "clinicDba", label: "DBA", value: profile.contract?.clinicDba },
          { name: "entityType", label: "Entity type", hint: "e.g. LLC, PC" },
          { name: "stateOfOrganization", label: "State of organization" },
          { name: "agreementVersion", label: "Agreement version", required: true },
          { name: "agreementDocumentId", label: "Agreement document id" },
          { name: "esignEnvelopeId", label: "E-sign envelope id" },
          { name: "authorizedSignerName", label: "Authorized signer name" },
          { name: "authorizedSignerTitle", label: "Authorized signer title" },
          { name: "authorizedSignerEmail", label: "Authorized signer email", type: "email" },
          { name: "effectiveDate", label: "Effective date", type: "date" },
          { name: "status", label: "Status", type: "select", options: CONTRACT_STATUSES, value: "EXECUTED", blank: false },
          { name: "legalNoticeEmail", label: "Legal notice email", type: "email" },
          { name: "billingContactName", label: "Billing contact name" },
          { name: "billingContactEmail", label: "Billing contact email", type: "email" },
          { name: "depositElection", label: "Deposit election (§15)", type: "select", options: DEPOSIT_ELECTIONS, hint: "required if status is Executed" },
          { name: "notes", label: "Notes", type: "textarea" }
        ]
      };
    case "add_representative":
      return {
        title: "Add an authorized representative",
        submitLabel: "Add representative",
        fields: [
          { name: "name", label: "Name", required: true },
          { name: "email", label: "Email", type: "email", required: true },
          { name: "title", label: "Title" },
          { name: "phone", label: "Phone" },
          { name: "role", label: "Role", type: "select", options: REPRESENTATIVE_ROLES, value: "AUTHORIZED_REPRESENTATIVE", blank: false },
          { name: "authorityScope", label: "Authority scope", type: "select", options: AUTHORITY_SCOPES, value: "ROUTINE", blank: false },
          { name: "authoritySourceDocumentId", label: "Authority source document", hint: "required if scope is actual authority to bind" },
          { name: "reason", label: "Reason", type: "textarea" }
        ]
      };
    case "record_management_event":
      return {
        title: "Record a management or ownership change",
        lede: "§3/§9: recording this cannot, by itself, end the agreement or the founding waiver.",
        submitLabel: "Record change",
        fields: [
          { name: "eventType", label: "Event type", type: "select", options: MANAGEMENT_EVENT_TYPES, blank: false },
          { name: "oldValue", label: "Previous" },
          { name: "newValue", label: "New" },
          { name: "effectiveAt", label: "Effective", type: "date" },
          { name: "noticeReceivedAt", label: "Notice received", type: "date" },
          { name: "sourceDocumentId", label: "Source document" },
          { name: "note", label: "Note", type: "textarea" }
        ]
      };
    case "grant_founding":
      return {
        title: "Grant founding clinic status",
        lede: "§9: an express written designation. A source document is required.",
        submitLabel: "Grant founding status",
        fields: [
          { name: "sourceDocumentId", label: "Source document id", required: true },
          { name: "effectiveAt", label: "Effective date", type: "date" },
          { name: "reason", label: "Reason", type: "textarea" }
        ]
      };
    case "set_founding_status":
      return {
        title: "Change founding status",
        lede: "Moves between the non-terminal founding states. The FOUNDING pricing plan and the fee waiver are preserved through all of them (§9) — use \"Revoke for cause\" to actually end the waiver.",
        submitLabel: "Save status",
        fields: [
          { name: "status", label: "Status", type: "select", options: ["NOT_APPLICABLE", "ACTIVE", "TEMPORARILY_INACTIVE", "SEPARATED_ELIGIBLE_TO_RESTORE"], blank: false },
          { name: "reason", label: "Reason", type: "textarea" },
          { name: "sourceDocumentId", label: "Source document" }
        ]
      };
    case "surrender_founding":
      return {
        title: "Surrender founding status",
        lede: "§9(d): the Parties may agree in writing to surrender the privilege. Requires a clinic representative with actual authority to bind, and a writing.",
        submitLabel: "Record surrender",
        confirmText: "The clinic representative named below has actual authority to bind the clinic, and I have the writing on file.",
        fields: [
          { name: "requestedByEmail", label: "Requested by (representative email)", type: "email", required: true },
          { name: "sourceDocumentId", label: "Source document id", required: true },
          { name: "reason", label: "Reason", type: "textarea" }
        ]
      };
    case "revoke_founding_for_cause":
      return {
        title: "Revoke founding status for cause",
        lede: "§9/§28: prospective only — visits already waived are not re-billed. Closes rejoin eligibility unless later restored in writing.",
        submitLabel: "Revoke for cause",
        confirmText: "I understand this ends the clinic's $0 founding rate going forward and closes automatic rejoin eligibility.",
        fields: [
          { name: "causeCategory", label: "Cause category", type: "select", options: CAUSE_CATEGORIES, blank: false },
          { name: "sourceDocumentId", label: "Source document id" },
          { name: "reason", label: "Reason", type: "textarea", required: true }
        ]
      };
    case "set_lifecycle":
      return {
        title: "Change lifecycle status",
        lede: "Separating or terminating a clinic is not available here — use \"Separate this clinic\", which records the required notice and wind-down.",
        submitLabel: "Save status",
        fields: [
          { name: "status", label: "Status", type: "select", options: ["PENDING_CONTRACT", "PENDING_ONBOARDING", "ACTIVE", "TEMPORARILY_INACTIVE", "SUSPENDED", "REJOIN_REVIEW"], blank: false },
          { name: "reason", label: "Reason", type: "textarea" },
          { name: "suspensionReason", label: "Suspension reason", hint: "if suspending" }
        ]
      };
    case "separate":
      return {
        title: "Separate this clinic from the platform",
        lede: "Ends the clinic's participation. Already-confirmed bookings are still seen through (§27); a voluntary separation with pending bookings lands in a wind-down state rather than closing immediately.",
        submitLabel: "Separate clinic",
        confirmText: "I understand this ends the clinic's participation and cannot be undone from this screen.",
        fields: [
          { name: "kind", label: "Kind", type: "select", options: ["VOLUNTARY", "WITHOUT_CAUSE", "FOR_CAUSE"], blank: false },
          { name: "causeCategory", label: "Cause category", type: "select", options: CAUSE_CATEGORIES, hint: "required if kind is For Cause" },
          { name: "initiatedBy", label: "Initiated by", type: "select", options: ["CLINIC", "CLEARKEY"], value: "CLINIC", blank: false },
          { name: "reason", label: "Reason", type: "textarea", required: true },
          { name: "noticeReceivedAt", label: "Notice received", type: "date" },
          { name: "effectiveAt", label: "Effective date", type: "date" },
          { name: "sourceDocumentId", label: "Source document" }
        ]
      };
    case "complete_wind_down":
      return {
        title: "Mark wind-down complete",
        submitLabel: "Mark complete",
        fields: [
          { name: "separationEventId", label: "Separation event id", required: true, value: latestSeparationId },
          { name: "reason", label: "Reason", type: "textarea" }
        ]
      };
    case "request_rejoin":
      return {
        title: "Record a rejoin request",
        submitLabel: "Record request",
        fields: [
          { name: "requestedByName", label: "Requested by (name)" },
          { name: "requestedByEmail", label: "Requested by (email)", type: "email" },
          { name: "claimsSameLegalEntity", label: "Claims to be the same contracting legal entity", type: "checkbox" },
          { name: "claimsSamePractice", label: "Claims to be substantially the same practice", type: "checkbox" }
        ]
      };
    case "restore_founding":
      return {
        title: "Decide founding restoration on rejoin",
        lede: "§9: restored only if the same legal entity and substantially the same practice rejoin, with no prior Cause loss, no uncured obligations, and no circumvention or written surrender.",
        submitLabel: "Decide",
        fields: [
          { name: "rejoinRequestId", label: "Rejoin request id", value: latestRejoinId, hint: "defaults to the most recent request" },
          { name: "verifiedSameLegalEntity", label: "Verified: same contracting legal entity", type: "checkbox" },
          { name: "verifiedSamePractice", label: "Verified: substantially the same practice", type: "checkbox" },
          { name: "expressWrittenRestoration", label: "An express written restoration exists (required only if previously revoked for Cause)", type: "checkbox" },
          { name: "sourceDocumentId", label: "Source document id" },
          { name: "reason", label: "Reason", type: "textarea" }
        ]
      };
    default:
      return null;
  }
}

function wireClinicContractActions(tenantId, profile) {
  document.querySelectorAll("[data-contract-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.contractAction;
      const spec = contractActionSpec(action, profile);
      if (!spec) return;
      openActionModal({
        ...spec,
        onSubmit: async (payload) => {
          await contractAction(tenantId, action, payload);
          toast("Saved.");
          await reloadClinicContractDetail(tenantId);
        }
      });
    });
  });
  document.querySelectorAll("[data-end-representative]").forEach((button) => {
    button.addEventListener("click", () => {
      openActionModal({
        title: "End this representative's authority",
        submitLabel: "End authority",
        fields: [
          { name: "endReason", label: "Reason", value: "DEPARTED" }
        ],
        onSubmit: async (payload) => {
          await contractAction(tenantId, "end_representative", { representativeId: button.dataset.endRepresentative, ...payload });
          toast("Representative's authority ended.");
          await reloadClinicContractDetail(tenantId);
        }
      });
    });
  });
}

/* -------------------------------------------------------------- markets --- */

const MARKET_STATES = ["green", "yellow", "red"];
const ACTIVATIONS = ["active_marketing", "soft", "inactive"];
const ACTIVATION_LABEL = { active_marketing: "Active marketing", soft: "Soft launch", inactive: "Inactive" };

function statePill(marketState) {
  return `<span class="pill market-${escapeAttr(marketState)}"><span class="state-dot market-${escapeAttr(marketState)}"></span>${escapeHtml(marketState)}</span>`;
}
function activationPill(activation) {
  return `<span class="pill activation-${escapeAttr(activation)}">${escapeHtml(ACTIVATION_LABEL[activation] || activation)}</span>`;
}
function fmtPct(value) { return value === null || value === undefined ? "—" : `${value}%`; }
function fmtMin(value) { return value === null || value === undefined ? "—" : `${value} min`; }
/** A single-hue magnitude bar, the same visual language renderAnalytics
 * already uses for count-by-day — one series never needs a legend. */
function bar(value, max) {
  const width = max > 0 ? Math.max(2, Math.round((Number(value) / max) * 100)) : 2;
  return `<span class="count-bar"><i style="width:${width}%"></i></span>`;
}

async function loadMarkets() {
  const mount = document.querySelector("[data-markets-body]");
  mount.innerHTML = '<div class="loading-state"><span class="spinner" aria-hidden="true"></span><p>Loading markets…</p></div>';
  try {
    const [{ markets }, unassigned] = await Promise.all([
      apiFetch("/api/admin/markets"),
      apiFetch("/api/admin/markets/unassigned-locations").catch(() => ({ locations: [] }))
    ]);
    renderMarkets(markets || []);
    renderUnassignedLocations(unassigned.locations || []);
  } catch (error) {
    mount.innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function renderMarkets(markets) {
  const mount = document.querySelector("[data-markets-body]");
  if (!markets.length) {
    mount.innerHTML = '<div class="table-wrap"><table class="data-table"><tbody><tr class="empty-row"><td>No markets yet. Create one to start assigning clinics and tracking readiness.</td></tr></tbody></table></div>';
    return;
  }
  const rows = markets.map((market) => `
    <tr>
      <td><a class="row-link" href="#markets/${encodeURIComponent(market.id)}">${escapeHtml(market.name)}</a></td>
      <td>${statePill(market.state)}</td>
      <td>${activationPill(market.activation)}</td>
      <td>${Number(market.locationCount || 0)}</td>
      <td>${market.radiusKm} km</td>
      <td>${market.stateSetAt ? formatDate(market.stateSetAt) : "—"}</td>
    </tr>`).join("");
  mount.innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>Market</th><th>State</th><th>Activation</th><th>Clinics</th><th>Radius</th><th>State set</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderUnassignedLocations(locations) {
  const mount = document.querySelector("[data-unassigned-locations]");
  if (!locations.length) {
    mount.innerHTML = '<p class="page-lede">Every active clinic is assigned to a market.</p>';
    return;
  }
  mount.innerHTML = locations.map((location) => `
    <div class="location-pick-row">
      <span><strong>${escapeHtml(location.name)}</strong> — ${escapeHtml(location.city || "")}, ${escapeHtml(location.region || "")}
        ${location.suggestedMarket ? `<br><small style="color:var(--muted);">Suggested: ${escapeHtml(location.suggestedMarket.name)} (${location.suggestedMarket.distanceKm} km from center)</small>` : ""}
      </span>
      ${location.suggestedMarket ? `<button class="button button-small" type="button" data-quick-assign="${escapeAttr(location.id)}" data-quick-market="${escapeAttr(location.suggestedMarket.id)}">Assign to ${escapeHtml(location.suggestedMarket.name)}</button>` : '<span class="hint">No market in range</span>'}
    </div>`).join("");
  mount.querySelectorAll("[data-quick-assign]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await apiFetch(`/api/admin/markets/${encodeURIComponent(button.dataset.quickMarket)}/locations`, {
          method: "POST", body: JSON.stringify({ locationId: button.dataset.quickAssign })
        });
        toast("Location assigned.");
        await loadMarkets();
      } catch (error) {
        toast(error.message, true);
        button.disabled = false;
      }
    });
  });
}

/**
 * The one shared configuration `computeReadinessReport` (src/markets.js)
 * checks every market against — not per-market, so it lives on the markets
 * list rather than nested in a single market's detail page.
 */
async function loadReadinessConfig() {
  const mount = document.querySelector("[data-readiness-config-body]");
  mount.innerHTML = '<p class="page-lede">Loading…</p>';
  try {
    const { config } = await apiFetch("/api/admin/markets/readiness-config");
    renderReadinessConfig(config);
  } catch (error) {
    mount.innerHTML = `<p class="page-lede">${escapeHtml(error.message)}</p>`;
  }
}

function renderReadinessConfig(config) {
  const mount = document.querySelector("[data-readiness-config-body]");
  mount.innerHTML = `
    <form data-form="readiness-config" class="form-grid two-col">
      <label class="field"><span>Minimum active clinics</span><input type="number" name="minActiveClinics" min="1" max="500" value="${config.minActiveClinics}"></label>
      <label class="field"><span>Target active clinics</span><input type="number" name="targetActiveClinics" min="1" max="500" value="${config.targetActiveClinics}"></label>
      <label class="field"><span>Minimum offer rate (%)</span><input type="number" name="minOfferRatePct" min="0" max="100" value="${config.minOfferRatePct}"></label>
      <label class="field"><span>Max median time to first offer (min)</span><input type="number" name="maxMedianFirstOfferMinutes" min="0" max="1440" value="${config.maxMedianFirstOfferMinutes}"></label>
      <label class="field"><span>Max single-clinic booking share (%)</span><input type="number" name="maxSingleClinicSharePct" min="0" max="100" value="${config.maxSingleClinicSharePct}"></label>
      <label class="field"><span>Lookback window (days)</span><input type="number" name="lookbackDays" min="1" max="365" value="${config.lookbackDays}"></label>
      <div class="form-actions wide" style="margin-top:0;"><button class="button button-primary" type="submit">Save thresholds</button></div>
    </form>`;
  mount.querySelector('form[data-form="readiness-config"]').addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    try {
      const { config: saved } = await apiFetch("/api/admin/markets/readiness-config", {
        method: "PATCH",
        body: JSON.stringify({
          minActiveClinics: Number(form.minActiveClinics.value),
          targetActiveClinics: Number(form.targetActiveClinics.value),
          minOfferRatePct: Number(form.minOfferRatePct.value),
          maxMedianFirstOfferMinutes: Number(form.maxMedianFirstOfferMinutes.value),
          maxSingleClinicSharePct: Number(form.maxSingleClinicSharePct.value),
          lookbackDays: Number(form.lookbackDays.value)
        })
      });
      toast("Readiness thresholds saved.");
      renderReadinessConfig(saved);
    } catch (error) {
      toast(error.message, true);
    }
  });
}

async function loadMarketDetail(marketId) {
  const mount = document.querySelector("[data-market-detail-body]");
  mount.innerHTML = '<div class="loading-state"><span class="spinner" aria-hidden="true"></span><p>Loading market…</p></div>';
  try {
    const [{ market, locations }, { report }, unassigned] = await Promise.all([
      apiFetch(`/api/admin/markets/${encodeURIComponent(marketId)}`),
      apiFetch(`/api/admin/markets/${encodeURIComponent(marketId)}/readiness`),
      apiFetch("/api/admin/markets/unassigned-locations").catch(() => ({ locations: [] }))
    ]);
    renderMarketDetail(market, locations, report, unassigned.locations || []);
  } catch (error) {
    mount.innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function readinessCheckRow(label, pass, valueText) {
  return `<div class="readiness-check"><span class="mark ${pass ? "pass" : "fail"}">${pass ? "✓" : "✗"}</span><span>${escapeHtml(label)}</span><span class="value">${escapeHtml(valueText)}</span></div>`;
}

function renderMarketDetail(market, locations, report, unassignedLocations) {
  const mount = document.querySelector("[data-market-detail-body]");
  const m = report?.metrics || {};
  const checks = report?.checks || {};
  const coverage = m.timeOfDayCoverage || {};
  mount.innerHTML = `
    <div class="page-head">
      <div>
        <p class="eyebrow">Market</p>
        <h1 class="page-title">${escapeHtml(market.name)}</h1>
        <p class="page-lede">${statePill(market.state)} ${activationPill(market.activation)} · set ${market.stateSetAt ? formatDateTime(market.stateSetAt) : "never"}${market.stateSetBy ? ` by ${escapeHtml(market.stateSetBy)}` : ""}</p>
      </div>
    </div>
    <div class="grid-2">
      <div>
        <div class="panel">
          <h2>Readiness — computed vs. set</h2>
          <p class="page-lede">Over the last ${report?.lookbackDays ?? 30} days. Recomputed on every load; only the form below ever changes the market's actual state.</p>
          <div class="stat-row" style="margin-top:.5rem;">
            <span><small>Computed recommendation</small><strong>${report ? statePill(report.recommendedState) : "—"}</strong></span>
            <span><small>Current state</small><strong>${statePill(market.state)}</strong></span>
          </div>
          <div class="readiness-checks">
            ${readinessCheckRow(`Active clinics (target ${report?.thresholds?.targetActiveClinics ?? "—"}, min ${report?.thresholds?.minActiveClinics ?? "—"})`, checks.meetsTargetClinicCount, String(m.activeClinicCount ?? 0))}
            ${readinessCheckRow(`Searches receiving ≥1 offer (target ${fmtPct(report?.thresholds?.minOfferRatePct)})`, checks.meetsOfferRate, `${fmtPct(m.offerRatePct)} (${m.searchesWithOffer ?? 0}/${m.totalSearches ?? 0})`)}
            ${readinessCheckRow(`Median time to first offer (target ≤ ${fmtMin(report?.thresholds?.maxMedianFirstOfferMinutes)})`, checks.meetsFirstOfferTime, fmtMin(m.medianFirstOfferMinutes))}
            ${readinessCheckRow("Day / evening / night coverage", checks.meetsTimeOfDayCoverage, ["day", "evening", "night"].map((k) => `${k}:${coverage[k] ? "✓" : "✗"}`).join(" "))}
            ${readinessCheckRow(`Busiest clinic's share of bookings (flag > ${fmtPct(report?.thresholds?.maxSingleClinicSharePct)})`, checks.meetsConcentration, fmtPct(m.concentrationPct))}
          </div>
        </div>

        <div class="panel">
          <h2>Set state</h2>
          <p class="page-lede">Always an explicit choice — the computed recommendation above is never written automatically.</p>
          <form data-form="market-state" class="form-grid two-col">
            <label class="field"><span>State</span><select name="state">${MARKET_STATES.map((s) => `<option value="${s}" ${market.state === s ? "selected" : ""}>${s}</option>`).join("")}</select></label>
            <label class="field"><span>Activation</span><select name="activation">${ACTIVATIONS.map((a) => `<option value="${a}" ${market.activation === a ? "selected" : ""}>${ACTIVATION_LABEL[a]}</option>`).join("")}</select></label>
            <div class="field wide" style="text-align:right;"><button class="button button-primary" type="submit">Save state</button></div>
          </form>
        </div>

        <div class="panel">
          <h2>Market boundary</h2>
          <form data-form="market-edit" class="form-grid two-col">
            <label class="field wide"><span>Name</span><input type="text" name="name" value="${escapeAttr(market.name)}"></label>
            <label class="field"><span>Center latitude</span><input type="number" name="centerLatitude" step="0.000001" value="${market.centerLatitude}"></label>
            <label class="field"><span>Center longitude</span><input type="number" name="centerLongitude" step="0.000001" value="${market.centerLongitude}"></label>
            <label class="field"><span>Radius (km)</span><input type="number" name="radiusKm" min="1" max="500" value="${market.radiusKm}"></label>
            <label class="field wide"><span>Notes</span><input type="text" name="notes" maxlength="2000" value="${escapeAttr(market.notes || "")}"></label>
            <div class="field wide" style="text-align:right;"><button class="button" type="submit">Save boundary</button></div>
          </form>
        </div>
      </div>

      <div>
        <div class="panel">
          <h2>Assigned clinics (${locations.length})</h2>
          ${locations.length ? locations.map((location) => `
            <div class="location-pick-row">
              <span><strong>${escapeHtml(location.name)}</strong> — ${escapeHtml(location.city || "")}, ${escapeHtml(location.region || "")}${location.active ? "" : " · inactive"}</span>
              <button class="button button-small button-danger" type="button" data-unassign-location="${escapeAttr(location.id)}">Unassign</button>
            </div>`).join("") : '<p class="page-lede">No clinics assigned yet.</p>'}
        </div>

        <div class="panel">
          <h2>Assign a clinic</h2>
          ${unassignedLocations.length ? `
            <form data-form="assign-location" class="form-grid">
              <label class="field"><span>Unassigned location</span>
                <select name="locationId">${unassignedLocations.map((l) => `<option value="${escapeAttr(l.id)}">${escapeHtml(l.name)} — ${escapeHtml(l.city || "")}</option>`).join("")}</select>
              </label>
              <button class="button" type="submit">Assign to this market</button>
            </form>` : '<p class="page-lede">No unassigned clinics available.</p>'}
        </div>
      </div>
    </div>`;

  mount.querySelector('form[data-form="market-state"]').addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    try {
      await apiFetch(`/api/admin/markets/${encodeURIComponent(market.id)}/state`, {
        method: "POST", body: JSON.stringify({ state: form.state.value, activation: form.activation.value })
      });
      toast("Market state saved.");
      await loadMarketDetail(market.id);
    } catch (error) { toast(error.message, true); }
  });

  mount.querySelector('form[data-form="market-edit"]').addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    try {
      await apiFetch(`/api/admin/markets/${encodeURIComponent(market.id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: form.name.value.trim(),
          centerLatitude: Number(form.centerLatitude.value),
          centerLongitude: Number(form.centerLongitude.value),
          radiusKm: Number(form.radiusKm.value),
          notes: form.notes.value.trim() || undefined
        })
      });
      toast("Market boundary saved.");
      await loadMarketDetail(market.id);
    } catch (error) { toast(error.message, true); }
  });

  mount.querySelector('form[data-form="assign-location"]')?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await apiFetch(`/api/admin/markets/${encodeURIComponent(market.id)}/locations`, {
        method: "POST", body: JSON.stringify({ locationId: event.target.locationId.value })
      });
      toast("Clinic assigned.");
      await loadMarketDetail(market.id);
    } catch (error) { toast(error.message, true); }
  });

  mount.querySelectorAll("[data-unassign-location]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await apiFetch(`/api/admin/locations/${encodeURIComponent(button.dataset.unassignLocation)}/market`, { method: "DELETE" });
        toast("Clinic unassigned.");
        await loadMarketDetail(market.id);
      } catch (error) {
        toast(error.message, true);
        button.disabled = false;
      }
    });
  });
}

/* -------------------------------------------------------------- metrics --- */

/** Populated once per session — filter options do not change while the
 * dashboard is open. */
async function ensureMetricsFilterOptions() {
  if (state.metricsFilterOptionsLoaded) return;
  try {
    const [{ markets }, { tenants }] = await Promise.all([
      apiFetch("/api/admin/markets"),
      apiFetch("/api/admin/tenants")
    ]);
    const marketSelect = document.querySelector("[data-metrics-markets]");
    for (const market of markets || []) {
      const option = document.createElement("option");
      option.value = market.id;
      option.textContent = market.name;
      marketSelect.appendChild(option);
    }
    const tenantSelect = document.querySelector("[data-metrics-tenants]");
    for (const tenant of tenants || []) {
      const option = document.createElement("option");
      option.value = tenant.id;
      option.textContent = tenant.name;
      tenantSelect.appendChild(option);
    }
    state.metricsFilterOptionsLoaded = true;
  } catch { /* filters remain "All" if this fails; the dashboard still works */ }
}

async function loadMetrics() {
  await ensureMetricsFilterOptions();
  const mount = document.querySelector("[data-metrics-body]");
  mount.innerHTML = '<div class="loading-state"><span class="spinner" aria-hidden="true"></span><p>Loading metrics…</p></div>';
  const form = document.querySelector('form[data-form="metrics-filter"]');
  const params = new URLSearchParams();
  if (form.from.value) params.set("from", `${form.from.value}T00:00:00.000Z`);
  if (form.to.value) params.set("to", `${form.to.value}T23:59:59.999Z`);
  if (form.market.value) params.set("market", form.market.value);
  if (form.tenant.value) params.set("tenant", form.tenant.value);
  try {
    const [metrics, alerts] = await Promise.all([
      apiFetch(`/api/admin/metrics?${params.toString()}`),
      apiFetch("/api/admin/alerts").catch(() => null)
    ]);
    renderMetrics(metrics, alerts);
  } catch (error) {
    mount.innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function renderMetrics(data, alerts) {
  const mount = document.querySelector("[data-metrics-body]");
  const { demand, supply, matching, booking, revenue, quality } = data;
  if (!demand) { mount.innerHTML = '<div class="empty-state"><p>No database is bound to this Worker.</p></div>'; return; }

  const maxByDay = Math.max(...demand.byDay.map((d) => d.total), 1);

  const alertsHtml = !alerts ? "" : alerts.breaches.length
    ? `<div class="breach-list" style="margin-bottom:1.25rem;">${alerts.breaches.map((b) => `
        <div class="breach-card"><div>⚠️</div><div><strong>${escapeHtml(b.metric)}</strong> is ${b.direction} threshold — ${escapeHtml(String(b.value))}${typeof b.value === "number" && String(b.metric).toLowerCase().includes("pct") ? "%" : ""} vs. ${escapeHtml(String(b.threshold))} (last ${alerts.windowHours}h)</div></div>`).join("")}</div>`
    : `<div class="no-breach-card" style="margin-bottom:1.25rem;">No thresholds breached in the last ${alerts.windowHours ?? 24} hours.</div>`;

  mount.innerHTML = `
    ${alertsHtml}
    <div class="panel">
      <h2>Demand</h2>
      <div class="stat-row">
        <span><small>Searches started</small><strong>${demand.searchesStarted}</strong></span>
        <span><small>Valid intakes</small><strong>${demand.validIntakes}</strong></span>
        <span><small>Out of market</small><strong>${demand.outOfMarketSearches}</strong></span>
      </div>
      <div class="table-wrap" style="border:1px solid var(--line); box-shadow:none;">
        <table class="data-table" style="min-width:0;">
          <thead><tr><th>Date</th><th>Searches</th><th style="width:40%"></th></tr></thead>
          <tbody>${demand.byDay.length ? demand.byDay.map((d) => `
            <tr><td>${escapeHtml(formatDate(d.date))}</td><td>${d.total}</td><td>${bar(d.total, maxByDay)}</td></tr>`).join("") : '<tr class="empty-row"><td colspan="3">No searches in this window.</td></tr>'}</tbody>
        </table>
      </div>
    </div>

    <div class="grid-2">
      <div class="panel">
        <h2>Supply</h2>
        <div class="stat-row">
          <span><small>Active clinics</small><strong>${supply.activeClinics}</strong></span>
          <span><small>Clinic response rate</small><strong>${fmtPct(supply.clinicResponse.responseRatePct)}</strong></span>
          <span><small>Decline rate</small><strong>${fmtPct(supply.clinicResponse.declineRatePct)}</strong></span>
        </div>
        <h3 style="font-size:.8rem; margin: .8rem 0 .4rem;">Capacity freshness (right now)</h3>
        <div class="count-list">
          ${["fresh", "aging", "stale", "never"].map((k) => `<div class="count-line"><span>${k}</span><span>${supply.capacityFreshness[k] || 0}</span></div>`).join("")}
        </div>
        <h3 style="font-size:.8rem; margin: .8rem 0 .4rem;">Availability states</h3>
        <div class="count-list">
          ${supply.availabilityStates.length ? supply.availabilityStates.map((s) => `<div class="count-line"><span>${escapeHtml(s.status)}</span><span>${s.total}</span></div>`).join("") : '<p class="page-lede">No active clinics match this filter.</p>'}
        </div>
      </div>

      <div class="panel">
        <h2>Matching</h2>
        <div class="stat-row">
          <span><small>Search → offer rate</small><strong>${fmtPct(matching.searchToOfferRatePct)}</strong></span>
          <span><small>2+ offer rate</small><strong>${fmtPct(matching.twoPlusOfferRatePct)}</strong></span>
          <span><small>No-result rate</small><strong>${fmtPct(matching.noResultRatePct)}</strong></span>
          <span><small>Median time to first offer</small><strong>${fmtMin(matching.medianTimeToFirstOfferMinutes)}</strong></span>
          <span><small>Avg. clinics contacted</small><strong>${matching.avgClinicsContacted ?? "—"}</strong></span>
        </div>
        ${matching.waveAvailable ? `
          <h3 style="font-size:.8rem; margin: .8rem 0 .4rem;">By wave</h3>
          <div class="table-wrap" style="border:1px solid var(--line); box-shadow:none;">
            <table class="data-table" style="min-width:0;">
              <thead><tr><th>Wave</th><th>Contacted</th><th>Offered</th><th>Offer rate</th></tr></thead>
              <tbody>${(matching.byWave || []).map((w) => `<tr><td>${w.wave}</td><td>${w.total}</td><td>${w.offered}</td><td>${fmtPct(w.offerRatePct)}</td></tr>`).join("")}</tbody>
            </table>
          </div>` : '<p class="page-lede">Per-wave performance activates once staged wave routing lands.</p>'}
      </div>
    </div>

    <div class="grid-2">
      <div class="panel">
        <h2>Booking funnel</h2>
        <div class="funnel-list">
          ${[
            ["Offers viewed", booking.offersViewed],
            ["Offers selected", booking.offersSelected],
            ["Paid", booking.paid],
            ["Confirmed booking", booking.confirmedBooking],
            ["Confirmed visit", booking.confirmedVisit]
          ].map(([label, value], i, arr) => `
            <div class="funnel-step">
              <span>${escapeHtml(label)}</span><strong>${value}</strong>
              <div class="funnel-bar">${bar(value, Math.max(...arr.map((r) => r[1]), 1))}</div>
            </div>`).join("")}
        </div>
        <div class="count-list" style="margin-top:.8rem;">
          <div class="count-line"><span>Cancellations</span><span>${booking.cancellations}</span></div>
          <div class="count-line"><span>No-shows</span><span>${booking.noShows}</span></div>
        </div>
      </div>

      <div class="panel">
        <h2>Revenue</h2>
        <div class="stat-row">
          <span><small>Customer payments</small><strong>${formatCents(revenue.customerPaymentsCents)}</strong></span>
          <span><small>Platform fee</small><strong>${formatCents(revenue.platformFeeCents)}</strong></span>
          <span><small>Clinic transfers</small><strong>${formatCents(revenue.clinicTransfersCents)}</strong></span>
          <span><small>Refunds</small><strong>${formatCents(revenue.refundsCents)}</strong></span>
          <span><small>Per connection</small><strong>${revenue.revenuePerConnectionCents === null ? "—" : formatCents(revenue.revenuePerConnectionCents)}</strong></span>
        </div>
        ${revenue.byMarket.length ? `
          <h3 style="font-size:.8rem; margin: .8rem 0 .4rem;">By market</h3>
          <div class="count-list">${revenue.byMarket.map((m) => `<div class="count-line"><span>${escapeHtml(m.marketId)}</span><span>${formatCents(m.platformFeeCents)} fee</span></div>`).join("")}</div>` : ""}
      </div>
    </div>

    <div class="panel">
      <h2>Quality</h2>
      <div class="stat-row">
        <span><small>Stale capacity now</small><strong>${quality.staleCapacityLocationsNow}</strong></span>
        <span><small>Ignored / expired requests</small><strong>${quality.ignoredOrExpiredRequests}</strong></span>
        <span><small>Expired offers</small><strong>${quality.expiredOffers}</strong></span>
        <span><small>Clinic decline rate</small><strong>${fmtPct(quality.clinicDeclineRatePct)}</strong></span>
        <span><small>Explicit cancellations</small><strong>${quality.customerAbandonment.explicitCancellations}</strong></span>
      </div>
      <h3 style="font-size:.8rem; margin: .8rem 0 .4rem;">Technical failures (client-reported)</h3>
      <div class="count-list">
        ${quality.technicalFailures.length ? quality.technicalFailures.map((f) => `<div class="count-line"><span>${escapeHtml(f.surface)} · ${escapeHtml(f.code || "—")}</span><span>${f.total}</span></div>`).join("") : '<p class="page-lede">No client errors in this window.</p>'}
      </div>
    </div>`;
}

/**
 * The config `checkAlerts` (src/metrics.js) checks the alerts panel above
 * against — a trailing window, not the dashboard's own date-range filter.
 */
async function loadAlertThresholds() {
  const mount = document.querySelector("[data-alert-thresholds-body]");
  mount.innerHTML = '<p class="page-lede">Loading…</p>';
  try {
    const { thresholds } = await apiFetch("/api/admin/alerts/thresholds");
    renderAlertThresholds(thresholds);
  } catch (error) {
    mount.innerHTML = `<p class="page-lede">${escapeHtml(error.message)}</p>`;
  }
}

function renderAlertThresholds(thresholds) {
  const mount = document.querySelector("[data-alert-thresholds-body]");
  mount.innerHTML = `
    <form data-form="alert-thresholds" class="form-grid two-col">
      <label class="field"><span>Minimum search → offer rate (%)</span><input type="number" name="minOfferRatePct" min="0" max="100" value="${thresholds.minOfferRatePct}"></label>
      <label class="field"><span>Max median time to first offer (min)</span><input type="number" name="maxMedianFirstOfferMinutes" min="0" max="1440" value="${thresholds.maxMedianFirstOfferMinutes}"></label>
      <label class="field"><span>Max no-result rate (%)</span><input type="number" name="maxNoResultRatePct" min="0" max="100" value="${thresholds.maxNoResultRatePct}"></label>
      <label class="field"><span>Max clinic decline rate (%)</span><input type="number" name="maxDeclineRatePct" min="0" max="100" value="${thresholds.maxDeclineRatePct}"></label>
      <label class="field"><span>Trailing window (hours)</span><input type="number" name="windowHours" min="1" max="168" value="${thresholds.windowHours}"></label>
      <div class="form-actions wide" style="margin-top:0;"><button class="button button-primary" type="submit">Save thresholds</button></div>
    </form>`;
  mount.querySelector('form[data-form="alert-thresholds"]').addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    try {
      const { thresholds: saved } = await apiFetch("/api/admin/alerts/thresholds", {
        method: "PUT",
        body: JSON.stringify({
          minOfferRatePct: Number(form.minOfferRatePct.value),
          maxMedianFirstOfferMinutes: Number(form.maxMedianFirstOfferMinutes.value),
          maxNoResultRatePct: Number(form.maxNoResultRatePct.value),
          maxDeclineRatePct: Number(form.maxDeclineRatePct.value),
          windowHours: Number(form.windowHours.value)
        })
      });
      toast("Alert thresholds saved.");
      renderAlertThresholds(saved);
      loadMetrics();
    } catch (error) {
      toast(error.message, true);
    }
  });
}

/* ------------------------------------------------------- Paw It Forward --- */
/**
 * Fund, custody, and reconciliation — three related but distinct backend
 * modules (src/fund.js, src/fund-custody.js, src/reconciliation.js) grouped
 * under one nav item with sub-tabs, per the audit's instructions. Custody's
 * sweep is the one action here that moves real money, so it is the one
 * gated behind the action modal's confirmation checkbox.
 */
async function loadPif(tab) {
  state.pifTab = tab;
  document.querySelectorAll("[data-pif-tab]").forEach((button) => button.classList.toggle("active", button.dataset.pifTab === tab));
  document.querySelectorAll("[data-pif-panel]").forEach((panel) => { panel.hidden = panel.dataset.pifPanel !== tab; });
  if (tab === "custody") return loadPifCustody();
  if (tab === "reconciliation") return loadPifReconciliation();
  return loadPifFund();
}

async function loadPifFund() {
  const mount = document.querySelector('[data-pif-panel="fund"]');
  mount.innerHTML = '<div class="loading-state"><span class="spinner" aria-hidden="true"></span><p>Loading fund…</p></div>';
  try {
    renderPifFund(await apiFetch("/api/admin/fund"));
  } catch (error) {
    mount.innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function renderFundIntegrity(integrity) {
  return `<h2>Ledger integrity</h2>
    ${integrity.ok
      ? '<div class="no-breach-card">The ledger is balanced, and no restricted account is negative.</div>'
      : `<div class="breach-list">
          ${(integrity.unbalanced || []).map((t) => `<div class="breach-card"><div>⚠️</div><div><strong>Unbalanced transaction</strong> ${escapeHtml(t.id)} (${escapeHtml(t.kind)}) — debits ${t.debits} ≠ credits ${t.credits}</div></div>`).join("")}
          ${(integrity.negativeRestricted || []).map((a) => `<div class="breach-card"><div>⚠️</div><div><strong>Negative restricted account</strong> ${escapeHtml(a.code)} — ${formatCents(a.balanceCents)}</div></div>`).join("")}
        </div>`}
    <div class="form-actions" style="justify-content:flex-start; margin-top:.8rem;">
      <button class="button button-small" type="button" data-run-integrity>Run integrity check now</button>
    </div>`;
}

function wireFundIntegrityButton(root) {
  root.querySelector("[data-run-integrity]")?.addEventListener("click", async (event) => {
    event.target.disabled = true;
    try {
      const fresh = await apiFetch("/api/admin/fund/integrity");
      const panel = root.querySelector("[data-fund-integrity]");
      panel.innerHTML = renderFundIntegrity(fresh);
      wireFundIntegrityButton(root);
      toast(fresh.ok ? "Ledger checks out." : "Integrity issues found — see below.", !fresh.ok);
    } catch (error) {
      toast(error.message, true);
      event.target.disabled = false;
    }
  });
}

function renderPifFund(data) {
  const mount = document.querySelector('[data-pif-panel="fund"]');
  const { balances, controls, integrity, matchContributedCents, reservationsByState } = data;
  mount.innerHTML = `
    <div class="panel">
      <h2>Fund balances</h2>
      <div class="stat-row">
        <span><small>Available</small><strong>${formatCents(balances.availableCents)}</strong></span>
        <span><small>Reserved</small><strong>${formatCents(balances.reservedCents)}</strong></span>
        <span><small>Consumed lifetime</small><strong>${formatCents(balances.consumedLifetimeCents)}</strong></span>
        <span><small>Refunds payable</small><strong>${formatCents(balances.refundsPayableCents)}</strong></span>
        <span><small>Tími match lifetime</small><strong>${formatCents(balances.matchLifetimeCents)}</strong></span>
        <span><small>Match contributed</small><strong>${formatCents(matchContributedCents)}</strong></span>
        <span><small>Processor fees</small><strong>${formatCents(balances.processorFeesCents)}</strong></span>
      </div>
    </div>
    <div class="panel">
      <h2>Reservations by state</h2>
      ${Object.keys(reservationsByState || {}).length ? `<div class="count-list">${Object.entries(reservationsByState).map(([key, row]) => `<div class="count-line"><span>${escapeHtml(labelize(key))}</span><span>${row.count} · ${formatCents(row.cents)}</span></div>`).join("")}</div>` : '<p class="page-lede">No reservations recorded.</p>'}
    </div>
    <div class="panel">
      <h2>Fund controls</h2>
      <p class="page-lede">Read-only here — set by migration/config, not this console.</p>
      <div class="tenant-summary">
        <span><small>Min liquidity reserve</small><strong style="font-size:.85rem;">${formatCents(controls.minLiquidityReserveCents)}</strong></span>
        <span><small>Max daily reserved</small><strong style="font-size:.85rem;">${formatCents(controls.maxDailyReservedCents)}</strong></span>
        <span><small>Max monthly reserved</small><strong style="font-size:.85rem;">${formatCents(controls.maxMonthlyReservedCents)}</strong></span>
        <span><small>Reservation TTL</small><strong style="font-size:.85rem;">${controls.reservationTtlMinutes} min</strong></span>
        <span><small>Assistance paused</small><strong style="font-size:.85rem;">${controls.assistancePaused ? "Yes" : "No"}</strong></span>
        <span><small>Visits / household / year</small><strong style="font-size:.85rem;">${controls.perHouseholdVisitsPerYear}</strong></span>
        <span><small>Public metrics delay</small><strong style="font-size:.85rem;">${controls.publicMetricsDelayHours}h</strong></span>
        <span><small>Public metrics min. connections</small><strong style="font-size:.85rem;">${controls.publicMetricsMinConnections}</strong></span>
        <span><small>Enhanced review threshold</small><strong style="font-size:.85rem;">${formatCents(controls.enhancedReviewThresholdCents)}</strong></span>
      </div>
    </div>
    <div class="panel" data-fund-integrity>${renderFundIntegrity(integrity)}</div>`;
  wireFundIntegrityButton(mount);
}

const CUSTODY_TRANSFER_TONE = { PENDING: "warn", IN_TRANSIT: "info", COMPLETED: "good", FAILED: "bad" };

async function loadPifCustody() {
  const mount = document.querySelector('[data-pif-panel="custody"]');
  mount.innerHTML = '<div class="loading-state"><span class="spinner" aria-hidden="true"></span><p>Loading custody…</p></div>';
  try {
    const [status, transfers] = await Promise.all([
      apiFetch("/api/admin/pif/custody"),
      apiFetch("/api/admin/pif/custody/transfers?limit=50")
    ]);
    renderPifCustody(status, transfers.transfers || []);
  } catch (error) {
    mount.innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function renderPifCustody(status, transfers) {
  const mount = document.querySelector('[data-pif-panel="custody"]');
  const c = status.custody;
  const rail = status.rail;
  mount.innerHTML = `
    <div class="panel">
      <div class="page-head" style="margin-bottom:.6rem;">
        <h2 style="margin:0;">Custody status</h2>
        ${tonePill(c.custodyProtected ? "Protected" : "Not physically protected", c.custodyProtected ? "good" : "bad")}
      </div>
      <p class="page-lede">Provider ${escapeHtml(c.provider)} (${escapeHtml(c.custodyMode)}) · rail ${rail.ok ? "reachable" : `unreachable — ${escapeHtml(rail.message || rail.code || "")}`}</p>
      <div class="stat-row">
        <span><small>Unsettled</small><strong>${formatCents(c.unsettledPifContributionsCents)}</strong></span>
        <span><small>Available to sweep</small><strong>${formatCents(c.availableToSweepPifContributionsCents)}</strong></span>
        <span><small>Swept lifetime</small><strong>${formatCents(c.sweptPifContributionsCents)}</strong></span>
        <span><small>Designated (ledger)</small><strong>${formatCents(c.designatedLedgerCents)}</strong></span>
        <span><small>Custody (ledger)</small><strong>${formatCents(c.custodyLedgerCents)}</strong></span>
        <span><small>In transit</small><strong>${formatCents(c.inTransitLedgerCents)}</strong></span>
        <span><small>Guarantee cash at clinics</small><strong>${formatCents(c.guaranteeCashAtClinicCents)}</strong></span>
        <span><small>Rail balance</small><strong>${rail.ok ? formatCents(rail.balanceCents) : "—"}</strong></span>
        <span><small>Unprotected designated</small><strong${c.unprotectedDesignatedCents > 0 ? ' style="color:var(--coral-dark);"' : ""}>${formatCents(c.unprotectedDesignatedCents)}</strong></span>
      </div>
      <div class="form-actions" style="justify-content:flex-start; margin-top:.8rem;">
        <button class="button button-small button-danger" type="button" data-run-sweep>Sweep designated contributions now</button>
      </div>
    </div>
    <div class="panel">
      <h2>Transfers (${transfers.length})</h2>
      ${transfers.length ? `<div class="table-wrap" style="border:1px solid var(--line); box-shadow:none;">
        <table class="data-table" style="min-width:0;">
          <thead><tr><th>Direction</th><th>Amount</th><th>State</th><th>Requested</th><th>Settled</th></tr></thead>
          <tbody>${transfers.map((t) => `<tr>
            <td>${escapeHtml(labelize(t.direction))}</td>
            <td>${formatCents(t.amountCents)}</td>
            <td>${tonePill(labelize(t.state), CUSTODY_TRANSFER_TONE[t.state] || "neutral")}</td>
            <td>${formatDateTime(t.requestedAt)}</td>
            <td>${t.settledAt ? formatDateTime(t.settledAt) : "—"}</td>
          </tr>`).join("")}</tbody>
        </table>
      </div>` : '<p class="page-lede">No custody transfers recorded yet.</p>'}
    </div>`;

  mount.querySelector("[data-run-sweep]").addEventListener("click", () => {
    openActionModal({
      title: "Sweep designated contributions",
      lede: "Moves the exact designated, settled, unswept amount into protected custody — a real transfer against the custody rail. It cannot be undone from this screen.",
      confirmText: "I understand this moves money into custody and cannot be undone here.",
      submitLabel: "Run sweep",
      fields: [{ name: "limit", label: "Max contributions this run", type: "number", hint: "optional, defaults to 50" }],
      onSubmit: async (payload) => {
        const { sweep } = await apiFetch("/api/admin/pif/custody/sweep", {
          method: "POST", body: JSON.stringify(payload.limit ? { limit: payload.limit } : {})
        });
        toast(`Swept ${sweep.swept.length} (${formatCents(sweep.sweptCents)}) · ${sweep.inTransit.length} in transit · ${sweep.failed.length} failed.`, sweep.failedClosed);
        await loadPifCustody();
      }
    });
  });
}

const RECON_RUN_TONE = { OK: "good", EXCEPTIONS_RAISED: "warn", FAILED: "bad" };
const RECON_EXCEPTION_TONE = { CRITICAL_RECONCILIATION_EXCEPTION: "bad", RECONCILIATION_WARNING: "warn" };
const RECON_EXCEPTION_STATUSES = ["OPEN", "INVESTIGATING", "RESOLVED_EXPLAINED", "RESOLVED_COMPENSATING_ENTRY"];

async function loadPifReconciliation() {
  const mount = document.querySelector('[data-pif-panel="reconciliation"]');
  mount.innerHTML = '<div class="loading-state"><span class="spinner" aria-hidden="true"></span><p>Loading reconciliation…</p></div>';
  try {
    const [{ runs = [] }, { exceptions = [] }] = await Promise.all([
      apiFetch("/api/admin/pif/reconciliation/runs?limit=20"),
      apiFetch("/api/admin/pif/reconciliation/exceptions?status=OPEN&limit=100")
    ]);
    renderPifReconciliation(runs, exceptions);
  } catch (error) {
    mount.innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function renderPifReconciliation(runs, exceptions) {
  const mount = document.querySelector('[data-pif-panel="reconciliation"]');
  mount.innerHTML = `
    <div class="panel">
      <div class="page-head" style="margin-bottom:.6rem;">
        <h2 style="margin:0;">Reconciliation runs</h2>
        <button class="button button-small button-primary" type="button" data-run-reconciliation>Run reconciliation now</button>
      </div>
      <p class="page-lede">Reconciles protected custody to the penny (§21) — no threshold, no auto-adjustment. A run only examines; it never moves money.</p>
      ${runs.length ? `<div class="table-wrap" style="border:1px solid var(--line); box-shadow:none;">
        <table class="data-table" style="min-width:0;">
          <thead><tr><th>Started</th><th>Scope</th><th>Status</th><th>Difference</th><th>Exceptions</th><th>Critical</th></tr></thead>
          <tbody>${runs.map((r) => `<tr>
            <td>${formatDateTime(r.startedAt)}</td>
            <td>${escapeHtml(labelize(r.scope))}</td>
            <td>${tonePill(labelize(r.status), RECON_RUN_TONE[r.status] || "neutral")}</td>
            <td>${formatCents(r.differenceCents)}</td>
            <td>${r.exceptionCount}</td>
            <td>${r.criticalCount}</td>
          </tr>`).join("")}</tbody>
        </table>
      </div>` : '<p class="page-lede">No reconciliation runs yet.</p>'}
    </div>
    <div class="panel">
      <h2>Open exceptions (${exceptions.length})</h2>
      ${exceptions.length ? exceptions.map((e) => `
        <div class="member-row">
          <div class="who">
            <strong>${escapeHtml(e.code)}</strong> ${tonePill(e.classification === "CRITICAL_RECONCILIATION_EXCEPTION" ? "Critical" : "Warning", RECON_EXCEPTION_TONE[e.classification] || "neutral")}
            <small>${escapeHtml(e.summary)}</small>
            <small>Expected ${formatCents(e.expectedCents)} · actual ${formatCents(e.actualCents)} · diff ${formatCents(e.differenceCents)} · opened ${escapeHtml(formatDateTime(e.openedAt))}</small>
          </div>
          <div class="member-actions"><button class="button button-small" type="button" data-resolve-exception="${escapeAttr(e.id)}">Resolve</button></div>
        </div>`).join("") : '<p class="page-lede">No open exceptions.</p>'}
    </div>`;

  mount.querySelector("[data-run-reconciliation]").addEventListener("click", async (event) => {
    event.target.disabled = true;
    try {
      const result = await apiFetch("/api/admin/pif/reconciliation/runs", { method: "POST", body: JSON.stringify({ scope: "MANUAL" }) });
      toast(result.run.status === "OK" ? "Reconciliation OK — no exceptions." : `Reconciliation raised ${result.run.exceptionCount} exception(s).`, result.run.status !== "OK");
      await loadPifReconciliation();
    } catch (error) {
      toast(error.message, true);
      event.target.disabled = false;
    }
  });

  mount.querySelectorAll("[data-resolve-exception]").forEach((button) => {
    button.addEventListener("click", () => {
      const exceptionId = button.dataset.resolveException;
      openActionModal({
        title: "Resolve reconciliation exception",
        lede: "Bookkeeping about the investigation, not the money — no balance changes here. Resolving as corrected requires the ledger transaction id that made the correction.",
        submitLabel: "Save",
        fields: [
          { name: "status", label: "Status", type: "select", options: RECON_EXCEPTION_STATUSES, blank: false },
          { name: "investigationNotes", label: "Investigation notes", type: "textarea", required: true },
          { name: "compensatingTransactionId", label: "Compensating ledger transaction id", hint: "required only if resolving as corrected" }
        ],
        onSubmit: async (payload) => {
          await apiFetch(`/api/admin/pif/reconciliation/exceptions/${encodeURIComponent(exceptionId)}`, { method: "POST", body: JSON.stringify(payload) });
          toast("Exception updated.");
          await loadPifReconciliation();
        }
      });
    });
  });
}

function describeAdminResult(admin) {
  if (!admin) return "No administrator email was given, so nobody can sign into it yet — add one from the workspace page.";
  if (admin.mode === "seated") {
    return admin.accountCreated
      ? `${admin.email} was created and seated as administrator. They sign in with an emailed code.`
      : `${admin.email} was seated as administrator.`;
  }
  if (admin.mode === "invited") {
    const why = admin.reason ? ` (${admin.reason})` : "";
    return `${admin.email} was invited${why}. No account exists until they accept.`;
  }
  if (admin.mode === "failed") {
    return `ADMINISTRATOR NOT SEATED — ${admin.error || "Clerk refused the request"}. Add one from the workspace page.`;
  }
  return "";
}

/* ------------------------------------------------- generic action modal --- */
/**
 * A reusable modal form, driven by a field spec, for the many narrow
 * POST-with-a-body actions the clinic-contract, custody, and reconciliation
 * screens expose (record an agreement, grant founding status, run a sweep,
 * resolve an exception, …). One implementation instead of N bespoke forms.
 *
 * `confirmText`, when given, renders a required checkbox that gates the
 * submit button — the explicit confirmation step every destructive action
 * (moves money, terminates a contract) must have before its POST fires.
 */
function actionFieldHtml(field) {
  const value = field.value ?? field.default ?? "";
  const req = field.required ? "required" : "";
  const wide = field.wide === false ? "" : " wide";
  const label = `<span>${escapeHtml(field.label)}${field.hint ? `<span class="hint"> — ${escapeHtml(field.hint)}</span>` : ""}</span>`;
  if (field.type === "select") {
    const opts = (field.options || []).map((o) => {
      const val = typeof o === "string" ? o : o.value;
      const text = typeof o === "string" ? labelize(o) : o.label;
      return `<option value="${escapeAttr(val)}" ${val === value ? "selected" : ""}>${escapeHtml(text)}</option>`;
    }).join("");
    return `<label class="field${field.wide === false ? "" : " wide"}">${label}<select name="${field.name}" ${req}>${field.blank !== false ? `<option value="">${escapeHtml(field.blankLabel || "—")}</option>` : ""}${opts}</select></label>`;
  }
  if (field.type === "textarea") {
    return `<label class="field wide">${label}<textarea name="${field.name}" rows="3" ${req}>${escapeHtml(value)}</textarea></label>`;
  }
  if (field.type === "checkbox") {
    return `<label class="checkbox-row wide"><input type="checkbox" name="${field.name}" ${value ? "checked" : ""}> ${escapeHtml(field.label)}</label>`;
  }
  const inputType = field.type === "money" ? "number" : (field.type || "text");
  const step = field.type === "money" ? "0.01" : (field.step || null);
  return `<label class="field${wide}">${label}<input type="${inputType}" name="${escapeAttr(field.name)}" value="${escapeAttr(value)}" ${step ? `step="${step}"` : ""} ${req}></label>`;
}

function openActionModal({ title, lede, fields, confirmText, submitLabel = "Submit", onSubmit }) {
  const modal = document.querySelector("[data-action-modal]");
  modal.querySelector("[data-action-modal-title]").textContent = title;
  const body = modal.querySelector("[data-action-modal-body]");
  body.innerHTML = `
    ${lede ? `<p class="page-lede">${escapeHtml(lede)}</p>` : ""}
    <form data-action-form novalidate>
      <div data-action-modal-errors class="form-errors" hidden></div>
      <div class="form-grid two-col">${fields.map(actionFieldHtml).join("")}</div>
      ${confirmText ? `<label class="checkbox-row wide" style="margin-top:1rem; color:var(--coral-dark);"><input type="checkbox" data-confirm-checkbox required> ${escapeHtml(confirmText)}</label>` : ""}
      <div class="form-actions">
        <button class="button" type="button" data-action-modal-cancel>Cancel</button>
        <button class="button ${confirmText ? "button-danger" : "button-primary"}" type="submit" data-action-modal-submit>${escapeHtml(submitLabel)}</button>
      </div>
    </form>`;
  const form = body.querySelector("form");
  const submitBtn = body.querySelector("[data-action-modal-submit]");
  const confirmBox = body.querySelector("[data-confirm-checkbox]");
  if (confirmBox) {
    submitBtn.disabled = true;
    confirmBox.addEventListener("change", () => { submitBtn.disabled = !confirmBox.checked; });
  }
  body.querySelector("[data-action-modal-cancel]").addEventListener("click", closeActionModal);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorsBox = body.querySelector("[data-action-modal-errors]");
    errorsBox.hidden = true;
    const payload = {};
    for (const field of fields) {
      if (field.type === "checkbox") { payload[field.name] = form[field.name].checked; continue; }
      const raw = form[field.name].value;
      if (field.type === "money") { payload[field.name] = raw === "" ? null : Math.round(Number(raw) * 100); continue; }
      if (field.type === "number") { payload[field.name] = raw === "" ? null : Number(raw); continue; }
      payload[field.name] = typeof raw === "string" ? raw.trim() : raw;
    }
    submitBtn.disabled = true;
    try {
      await onSubmit(payload);
      closeActionModal();
    } catch (error) {
      errorsBox.innerHTML = Array.isArray(error.details) && error.details.length
        ? `<strong>Fix the following:</strong><ul>${error.details.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ul>`
        : escapeHtml(error.message);
      errorsBox.hidden = false;
      submitBtn.disabled = confirmBox ? !confirmBox.checked : false;
    }
  });
  modal.hidden = false;
}
function closeActionModal() {
  document.querySelector("[data-action-modal]").hidden = true;
}

async function boot() {
  try {
    state.config = await apiFetch("/api/config");
  } catch (error) {
    console.error("Unable to load /api/config", error);
    state.config = { signInRequired: true };
  }
  if (state.config.signInRequired && state.config.clerkPublishableKey) {
    await initClerk();
  }
  wireStaticHandlers();
  await route();
}

boot();
