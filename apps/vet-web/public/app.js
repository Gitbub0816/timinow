/**
 * Tími Vet — veterinary operations console.
 *
 * A faithful web port of apps/vet-windows (WPF): same layout, same design
 * tokens, the same 6-second dashboard poll, the same "don't alert on first
 * load" guard, and — the important part — an always-on-top floating console
 * using the Document Picture-in-Picture API (see openMiniWindow()).
 *
 * Per docs/PLATFORM-CONTRACT.md, no prebuilt Clerk component is mounted
 * anywhere in this file. Clerk loads headless and every flow (sign-in with
 * one-time email/phone codes, organization switching, invitation acceptance)
 * is driven through the client API by hand.
 */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const SETTINGS_KEY = "timi_vet_settings_v1";
const RETURN_ROUTE_KEY = "timi_vet_return_route";
const KNOWN_SCREENS = new Set(["sign-in", "workspace", "pill", "console", "billing", "people", "settings", "legal"]);
const DEFAULT_SETTINGS = { pollSeconds: 6, alertsEnabled: true, playSound: true, autoOpenMini: true };

const state = {
  // Pill mode is the default lightweight surface reception lands on — see
  // parseRoute() and the "sign-in"/"workspace" fallthrough in renderRoute().
  // The full dashboard (#console) stays one click away but is never required.
  route: "pill",
  config: null,
  clerk: null,
  session: null,
  settings: readSettings(),
  dashboard: null,
  dashboardInitialized: false,
  billing: null,
  knownPendingIds: new Set(),
  selectedRequestId: null,
  offerFormEdited: false,
  isBusy: false,
  statusMessage: "Connecting to Tími…",
  pollTimer: null,
  pillExpanded: false,
  pillWasStale: false,
  signIn: { stage: "identifier", identifier: "", attempt: null, factor: null, error: null, busy: false },
  people: null,
  miniWin: null,
  miniKind: null // "pip" | "popup"
};

/* ----------------------------------------------------------- analytics --- */
/* First-party, cookieless beacon. Events carry a name, a path, and optional
   coarse metadata — never an identifier. A failed beacon never affects the
   console. */
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
    window.clearTimeout(flushTimer);
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
      const event = { name: String(name), path: `#${state?.route || "console"}` };
      if (meta && typeof meta === "object") event.meta = meta;
      queue.push(event);
      if (!flushTimer) flushTimer = window.setTimeout(flush, 400);
    } catch { /* analytics must never break the console */ }
  };
})();

/* Boot splash: static HTML shows it instantly; hidden once the console has
   booted, but never before ~1.2s so it cannot flash. */
const BOOT_STARTED_AT = Date.now();
function hideBootSplash() {
  const splash = $("[data-boot-splash]");
  if (!splash || splash.dataset.hiding) return;
  splash.dataset.hiding = "true";
  const linger = Math.max(0, 1200 - (Date.now() - BOOT_STARTED_AT));
  window.setTimeout(() => {
    splash.classList.add("is-hidden");
    window.setTimeout(() => splash.remove(), 480);
  }, linger);
}
window.setTimeout(hideBootSplash, 10000);

/* ------------------------------------------------------------- storage --- */

function readSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch { /* private mode */ }
}

/* ------------------------------------------------------------ utilities --- */

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function humanize(value) {
  return String(value || "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function initials(name) {
  return String(name || "?").trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
}

function timestampMs(value) {
  if (!value) return Number.NaN;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  return Date.parse(normalized);
}

function formatClock(iso) {
  if (!iso) return "Just now";
  const ms = timestampMs(iso);
  if (!Number.isFinite(ms)) return "Just now";
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(ms));
}

/* --------------------------------------------------- clinic request view --- */

function petLine(request) {
  return `${request.pet?.name || "Pet"} · ${humanize(request.pet?.species || "other").toUpperCase()}`;
}

function requestTypeLabel(request) {
  return request.searchTarget ? "MULTI-CLINIC SEARCH" : "DIRECT INTAKE";
}

function travelLabel(request) {
  return request.travelMinutes == null ? "Travel unknown" : `${request.travelMinutes} min away`;
}

/**
 * Allergies and medications the owner recorded, labelled for what they are.
 *
 * Optional, unverified, and never a substitute for the clinic's own
 * history-taking — but a receptionist should not learn about a penicillin
 * reaction from the owner at the door when it was typed into the request.
 */
function ownerSuppliedMedical(request) {
  const parts = [];
  if (request.pet?.allergies) parts.push(`<strong>Allergies:</strong> ${escapeHtml(request.pet.allergies)}`);
  if (request.pet?.medications) parts.push(`<strong>Medications:</strong> ${escapeHtml(request.pet.medications)}`);
  if (!parts.length) return "";
  return `<p class="owner-supplied-medical"><small>REPORTED BY OWNER, UNVERIFIED</small><br>${parts.join(" · ")}</p>`;
}

function isEmergency(request) {
  return request.urgency === "emergency" || (Array.isArray(request.redFlags) && request.redFlags.length > 0);
}

function truncate(text, max) {
  const value = String(text || "");
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/* --------------------------------------------------------------- toast --- */

function showToast(message) {
  const toast = $("[data-toast]");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("is-visible"), 3800);
}

/* ----------------------------------------------------------------- API --- */

async function authHeaders() {
  const headers = {};
  if (state.clerk?.session) {
    let token = null;
    try { token = await state.clerk.session.getToken({ template: "timinow" }); } catch { /* template may not exist yet */ }
    if (!token) { try { token = await state.clerk.session.getToken(); } catch { /* no active session */ } }
    if (token) headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("accept", "application/json");
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const auth = await authHeaders();
  Object.entries(auth).forEach(([key, value]) => headers.set(key, value));
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error?.message || `Request failed (${response.status})`);
    error.code = data.error?.code;
    error.details = data.error?.details;
    throw error;
  }
  return data;
}

/* --------------------------------------------------------- config + clerk --- */

async function loadConfig() {
  try {
    state.config = await api("/api/config");
  } catch {
    state.config = { signInRequired: true, demoMode: false, database: "fixtures" };
  }
  applyPricingCopy();
  if (state.config.signInRequired) await initializeClerk();
}

/**
 * Prices and the terms version come from /api/config, never from the markup.
 * A console quoting a fee the ledger no longer charges is how a clinic ends
 * up arguing with an invoice.
 */
function applyPricingCopy() {
  const fee = clinicFees();
  $$("[data-fee-owner]").forEach((node) => { node.textContent = formatMoney(fee.ownerFeeCents); });
  $$("[data-fee-clinic]").forEach((node) => { node.textContent = formatMoney(fee.clinicFeeCents); });
  $$("[data-legal-version]").forEach((node) => { node.textContent = state.config?.legalVersion || "current"; });
}

const FEE_FALLBACK = { ownerFeeCents: 1500, clinicFeeCents: 2500, currency: "usd" };

function clinicFees() {
  return { ...FEE_FALLBACK, ...(state.config?.fees || {}) };
}

function formatMoney(cents) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: Number(cents || 0) % 100 === 0 ? 0 : 2 }).format((cents || 0) / 100);
}

async function initializeClerk() {
  if (!state.config.clerkPublishableKey || !state.config.clerkJsUrl) return;
  try {
    const clerkModule = await import(/* @vite-ignore */ state.config.clerkJsUrl);
    const Clerk = clerkModule.Clerk || clerkModule.default?.Clerk || clerkModule.default;
    state.clerk = new Clerk(state.config.clerkPublishableKey);
    await state.clerk.load();
    await handleInvitationTicket();
    state.clerk.addListener(() => { renderRoute(); });
  } catch (error) {
    console.error("Clerk initialization failed", error);
  }
}

/** Clerk invitation links land with `__clerk_ticket` (and usually `__clerk_status`). */
async function handleInvitationTicket() {
  const params = new URLSearchParams(location.search);
  const ticket = params.get("__clerk_ticket");
  if (!ticket || !state.clerk) return;
  try {
    const attempt = await state.clerk.client.signIn.create({ strategy: "ticket", ticket });
    if (attempt.status === "complete") await state.clerk.setActive({ session: attempt.createdSessionId });
  } catch {
    try {
      const attempt = await state.clerk.client.signUp.create({ strategy: "ticket", ticket });
      if (attempt.status === "complete" && attempt.createdSessionId) {
        await state.clerk.setActive({ session: attempt.createdSessionId });
      } else {
        // Accounts are passwordless: finish through the ordinary one-time-code
        // flow with the invited email prefilled.
        state.signIn = {
          stage: "identifier",
          identifier: attempt.emailAddress || "",
          attempt: null,
          factor: null,
          error: "Your invitation was accepted. Continue with your work email to receive a one-time sign-in code.",
          busy: false
        };
      }
    } catch (signUpError) {
      console.warn("Invitation ticket could not be redeemed", signUpError);
    }
  } finally {
    history.replaceState(null, "", location.pathname + location.hash);
  }
}

/* ------------------------------------------------------------- sign in --- */

function signInErrorMessage(error) {
  return error?.errors?.[0]?.long_message || error?.errors?.[0]?.message || error?.message || "Something went wrong. Try again.";
}

function renderSignIn() {
  const mount = $("[data-sign-in-body]");
  const disabled = $("[data-auth-disabled]");
  if (!state.config?.signInRequired) { mount.hidden = true; disabled.hidden = false; return; }
  disabled.hidden = true;
  mount.hidden = false;
  if (!state.clerk) {
    mount.innerHTML = `<p class="sign-in-error">Clerk is not configured on this deployment. Set CLERK_PUBLISHABLE_KEY, CLERK_JS_URL, and (as a Worker secret) CLERK_SECRET_KEY.</p>`;
    return;
  }

  const { stage, error, busy } = state.signIn;
  const errorHtml = error ? `<p class="sign-in-error">${escapeHtml(error)}</p>` : "";

  if (stage === "identifier") {
    mount.innerHTML = `
      <form class="sign-in-step" data-identifier-form>
        <label class="field">Work email, username, or phone
          <input name="identifier" autocomplete="username" required value="${escapeHtml(state.signIn.identifier)}">
        </label>
        ${errorHtml}
        <button class="button button-primary button-block" type="submit" ${busy ? "disabled" : ""}>${busy ? "Checking…" : "Continue"}</button>
      </form>
      <p class="sign-in-note" style="margin-top:1rem">We'll send a one-time code to your email or phone — Tími sign-in uses no passwords.</p>`;
    $("[data-identifier-form]", mount).addEventListener("submit", onIdentifierSubmit);
    return;
  }

  if (stage === "code") {
    const via = state.signIn.factor?.strategy === "phone_code" ? "phone" : "email";
    mount.innerHTML = `
      <button class="sign-in-back" type="button" data-back>← Use a different account</button>
      <form class="sign-in-step" data-code-form style="margin-top:.8rem">
        <label class="field">6-digit code sent to your ${via}
          <input name="code" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" required>
        </label>
        ${errorHtml}
        <button class="button button-primary button-block" type="submit" ${busy ? "disabled" : ""}>${busy ? "Verifying…" : "Verify and sign in"}</button>
      </form>`;
    $("[data-back]", mount).addEventListener("click", () => { state.signIn = { stage: "identifier", identifier: "", attempt: null, factor: null, error: null, busy: false }; renderSignIn(); });
    $("[data-code-form]", mount).addEventListener("submit", onCodeSubmit);
    return;
  }
}

async function onIdentifierSubmit(event) {
  event.preventDefault();
  const identifier = new FormData(event.currentTarget).get("identifier")?.toString().trim();
  if (!identifier) return;
  state.signIn.busy = true; state.signIn.error = null; renderSignIn();
  try {
    const attempt = await state.clerk.client.signIn.create({ identifier });
    const factors = attempt.supportedFirstFactors || [];
    // One-time codes only: email first, then phone. Passwords, passkeys, and
    // OAuth are not offered on any Tími web surface.
    const factor = factors.find((f) => f.strategy === "email_code")
      || factors.find((f) => f.strategy === "phone_code");
    if (!factor) throw new Error("This account has no email or phone number that can receive a one-time code. Ask your workspace administrator to update it.");
    await attempt.prepareFirstFactor({
      strategy: factor.strategy,
      emailAddressId: factor.emailAddressId,
      phoneNumberId: factor.phoneNumberId
    });
    state.signIn = { stage: "code", identifier, attempt, factor, error: null, busy: false };
  } catch (error) {
    state.signIn = { stage: "identifier", identifier, attempt: null, factor: null, error: signInErrorMessage(error), busy: false };
  }
  renderSignIn();
}

async function completeIfDone(result) {
  if (result.status === "complete") {
    await state.clerk.setActive({ session: result.createdSessionId });
    return true;
  }
  return false;
}

async function onCodeSubmit(event) {
  event.preventDefault();
  const code = new FormData(event.currentTarget).get("code")?.toString().trim();
  state.signIn.busy = true; state.signIn.error = null; renderSignIn();
  try {
    const result = await state.signIn.attempt.attemptFirstFactor({ strategy: state.signIn.factor.strategy, code });
    if (!(await completeIfDone(result))) throw new Error("That code did not complete sign-in. Try again.");
  } catch (error) {
    state.signIn.error = signInErrorMessage(error);
    state.signIn.busy = false;
    renderSignIn();
  }
}

/* ------------------------------------------------------------ workspace --- */

function renderWorkspace() {
  const mount = $("[data-workspace-body]");
  const memberships = state.clerk?.user?.organizationMemberships || [];
  if (!memberships.length) {
    mount.innerHTML = `<div class="workspace-fail"><h2>No workspace yet</h2><p>Your account isn't a member of any Tími veterinary workspace. Ask a workspace administrator to invite you by email.</p></div>`;
    return;
  }
  mount.innerHTML = `<div class="org-grid">${memberships.map((membership) => `
    <button class="org-card" type="button" data-org="${escapeHtml(membership.organization.id)}">
      <span class="org-avatar">${escapeHtml(initials(membership.organization.name))}</span>
      <strong>${escapeHtml(membership.organization.name)}</strong>
      <small>${escapeHtml(humanize(membership.role))}</small>
    </button>`).join("")}</div>`;
  $$("[data-org]", mount).forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await state.clerk.setActive({ organization: button.dataset.org });
      setRoute("console");
    } catch (error) {
      showToast(signInErrorMessage(error));
      button.disabled = false;
    }
  }));
}

function renderWorkspaceFailure(session) {
  const mount = $("[data-workspace-body]");
  mount.innerHTML = `<div class="workspace-fail">
    <h2>This workspace isn't mapped to Tími Vet</h2>
    <p>Your Clerk organization is active, but no clinic tenant is linked to it yet (surfaces.clinic is false). Ask your Tími platform operator to finish onboarding this workspace, or choose a different one.</p>
    <button class="button button-quiet" type="button" data-action="choose-different" style="margin-top:1rem">Choose a different workspace</button>
  </div>`;
  $('[data-action="choose-different"]', mount).addEventListener("click", async () => {
    try { await state.clerk.setActive({ organization: null }); } catch { /* ignore */ }
    setRoute("workspace");
  });
  void session;
}

/* ------------------------------------------------------------- routing --- */

function parseRoute() {
  const raw = location.hash.replace(/^#/, "") || "pill";
  const [route] = raw.split("?");
  return KNOWN_SCREENS.has(route) ? route : "pill";
}

function routeQuery() {
  const raw = location.hash.split("?")[1] || "";
  return new URLSearchParams(raw);
}

function setRoute(route) {
  if (location.hash === `#${route}`) renderRoute();
  else location.hash = route;
}

async function renderRoute() {
  let route = parseRoute();
  const signedIn = !state.config?.signInRequired || Boolean(state.clerk?.user);

  if (state.config?.signInRequired) {
    if (!state.clerk?.user) {
      route = "sign-in";
    } else if (!state.clerk.organization) {
      const memberships = state.clerk.user.organizationMemberships || [];
      if (memberships.length === 1) {
        try { await state.clerk.setActive({ organization: memberships[0].organization.id }); }
        catch { /* fall through to the picker */ }
      }
      if (!state.clerk.organization) route = "workspace";
    } else if (route === "sign-in" || route === "workspace") {
      route = "pill";
    }
  }

  state.route = route;
  if (renderRoute.lastTrackedRoute !== route) {
    renderRoute.lastTrackedRoute = route;
    track("page_view");
  }
  $$("[data-screen]").forEach((screen) => screen.classList.toggle("is-active", screen.dataset.screen === route));
  $$("[data-nav]").forEach((link) => link.classList.toggle("active", link.dataset.nav === route));
  document.title = ({
    "sign-in": "Sign in · Tími Vet", workspace: "Choose a workspace · Tími Vet",
    pill: "Quick status · Tími Vet", console: "Clinic operations · Tími Vet", billing: "Billing · Tími Vet",
    people: "People · Tími Vet", settings: "Facility settings · Tími Vet", legal: "Legal · Tími Vet"
  })[route] || "Tími Vet";

  if (route === "sign-in") { renderSignIn(); return; }
  if (route === "workspace") { renderWorkspace(); return; }
  if (!signedIn) return;

  // Every remaining route needs the session descriptor (tenant, location, surfaces).
  try {
    const { session } = await api("/api/session");
    state.session = session;
    if (state.config?.signInRequired && !session.surfaces.clinic) {
      state.route = "workspace";
      $$("[data-screen]").forEach((screen) => screen.classList.toggle("is-active", screen.dataset.screen === "workspace"));
      renderWorkspaceFailure(session);
      return;
    }
  } catch (error) {
    showToast(error.message);
    return;
  }

  if (route === "pill") await enterPill();
  if (route === "console") await enterConsole();
  if (route === "billing") await enterBilling();
  if (route === "people") await enterPeople();
  if (route === "settings") await enterSettings();
  if (route === "legal") {
    const section = routeQuery().get("section") || "clinics";
    requestAnimationFrame(() => document.getElementById(section)?.scrollIntoView({ block: "start" }));
  }
}

/* -------------------------------------------------------------- console --- */

function setBusy(busy) {
  state.isBusy = busy;
  $("[data-progress]").hidden = !busy;
}

function setStatus(message) {
  state.statusMessage = message;
  const node = $("[data-status-message]");
  if (node) node.textContent = message;
  renderMiniWindow();
}

/**
 * Both #pill and #console poll the same dashboard endpoint, so the poll timer
 * is shared rather than owned by either screen — switching between them never
 * starts a second interval or loses the one already running.
 */
function ensureDashboardPolling() {
  if (state.pollTimer) return;
  state.pollTimer = window.setInterval(() => refreshDashboard(false), Math.max(3, Math.min(60, state.settings.pollSeconds)) * 1000);
}

async function enterConsole() {
  if (!enterConsole.tracked) {
    enterConsole.tracked = true;
    track("console_opened");
  }
  syncSettingsForm();
  await refreshDashboard(true);
  ensureDashboardPolling();
}

async function enterPill() {
  if (!enterPill.tracked) {
    enterPill.tracked = true;
    track("pill_opened");
  }
  await refreshDashboard(true);
  ensureDashboardPolling();
}

async function enterSettings() {
  if (!state.dashboard) await refreshDashboard(true);
  hydrateSettingsForm(state.dashboard?.location);
}

async function refreshDashboard(initial) {
  if (state.isBusy && !initial) return;
  setBusy(true);
  try {
    const dashboard = await api("/api/clinic/dashboard");
    state.dashboard = dashboard;
    $("[data-clinic-name]").textContent = dashboard.location.name;
    $("[data-clinic-address]").textContent = dashboard.location.address || "";
    $("[data-connection-mode]").textContent = state.config?.demoMode ? "INTERACTIVE DEMO" : "LIVE CLOUDFLARE CONNECTION";
    $("[data-metric-pending]").textContent = dashboard.metrics.pending;
    $("[data-metric-active]").textContent = dashboard.metrics.activeArrivals;
    $("[data-metric-completed]").textContent = dashboard.metrics.completedToday;
    $("[data-metric-declined]").textContent = dashboard.metrics.declinedToday;
    hydrateAvailabilityForm(dashboard.location.availability);

    const pending = dashboard.requests.filter((request) => request.status === "pending");
    const newArrivals = [];
    for (const request of pending) {
      if (!state.knownPendingIds.has(request.id)) {
        state.knownPendingIds.add(request.id);
        if (state.dashboardInitialized) newArrivals.push(request);
      }
    }
    // A matching request arriving — or one already sitting in the queue the
    // first time this console loads — is exactly when the pill needs to stop
    // being quiet — expand it so reception sees Accept/Decline immediately,
    // whether or not #pill happens to be the visible screen right now.
    if (newArrivals.length || (!state.dashboardInitialized && pending.length)) setPillExpanded(true);
    state.dashboardInitialized = true;

    if (state.selectedRequestId && !dashboard.requests.some((r) => r.id === state.selectedRequestId)) {
      state.selectedRequestId = null;
    }

    renderQueue(dashboard.requests);
    renderDecisionWorkspace();
    renderMiniWindow();
    renderPill();

    for (const request of newArrivals) await onNewPendingRequest(request);

    setStatus(`Updated ${new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date())} · next check in ${Math.max(3, Math.min(60, state.settings.pollSeconds))} sec`);
  } catch (error) {
    setStatus(`Connection issue · ${error.message}`);
  } finally {
    setBusy(false);
  }
}

function hydrateAvailabilityForm(availability) {
  const form = $("[data-availability-form]");
  if (form.dataset.userEdited === "true") return;
  form.elements.intakeStatus.value = availability.intakeStatus === "unverified" ? "available" : availability.intakeStatus;
  form.elements.note.value = availability.note || "";
  form.elements.stableWaitMin.value = availability.stableWaitMin ?? 15;
  form.elements.stableWaitMax.value = availability.stableWaitMax ?? 35;
  form.elements.capacityCount.value = availability.capacityCount ?? 3;
  form.elements.ttlMinutes.value = 30;
  form.elements.acceptsCritical.checked = availability.acceptsCritical !== false;
}

/**
 * Whether this booking is sponsored by the Paw It Forward Fund.
 *
 * The clinic is told three things and no more: that the booking is sponsored,
 * that its Tími NOW referral fee is $0, and that the patient still owes the
 * clinic its normal deposit and veterinary charges. Income, benefit type,
 * hardship reason, documents, and the assistance application itself are not
 * in this payload, are never requested by this console, and must never be
 * rendered here — a clinic that can see why somebody qualified can treat them
 * differently for it.
 */
function isSponsored(request) {
  return request?.sponsored === true || request?.sponsorship?.state === "RESERVED" || Boolean(request?.sponsorshipId);
}

function sponsoredBadge(request) {
  return isSponsored(request) ? '<span class="sponsored-badge">Paw It Forward sponsored booking</span>' : "";
}

function sponsoredNotice(request) {
  if (!isSponsored(request)) return "";
  return `<div class="sponsored-notice">
      <strong>Paw It Forward sponsored booking</strong>
      <span>TímiNOW referral fee: $0</span>
      <span>Patient remains responsible for your normal deposit and veterinary charges.</span>
    </div>`;
}

function renderQueue(requests) {
  const list = $("[data-queue-list]");
  const pending = requests.filter((r) => r.status === "pending");
  $("[data-queue-count]").textContent = pending.length;
  if (!pending.length) {
    list.innerHTML = `<div class="queue-empty">Queue clear. New requests will appear here as they arrive.</div>`;
    return;
  }
  list.innerHTML = pending.map((request) => `
    <button class="queue-item ${isEmergency(request) ? "is-emergency" : ""} ${request.id === state.selectedRequestId ? "is-selected" : ""}" type="button" data-request="${escapeHtml(request.id)}">
      <span class="queue-avatar">${escapeHtml(initials(request.pet?.name))}</span>
      <span class="queue-main">
        <h3>${escapeHtml(petLine(request))}</h3>
        ${sponsoredBadge(request)}
        <p>${escapeHtml(request.concernSummary)}</p>
        <span class="request-type">${requestTypeLabel(request)}</span>
      </span>
      <span class="queue-meta">
        ${escapeHtml(formatClock(request.requestedAt))}
        <span class="travel">${escapeHtml(travelLabel(request))}</span>
        <span class="status">${escapeHtml(request.status)}</span>
      </span>
    </button>`).join("");
  $$("[data-request]", list).forEach((button) => button.addEventListener("click", () => {
    state.selectedRequestId = button.dataset.request;
    state.offerFormEdited = false;
    renderQueue(state.dashboard.requests);
    renderDecisionWorkspace();
  }));
}

function selectedRequest() {
  return state.dashboard?.requests.find((r) => r.id === state.selectedRequestId) || null;
}

function renderDecisionWorkspace() {
  const mount = $("[data-workspace-content]");
  const request = selectedRequest();
  if (!request) {
    mount.innerHTML = `<p class="workspace-empty">Select a request from the review queue.</p>`;
    return;
  }
  const availability = state.dashboard?.location?.availability || {};
  const defaultResponseType = isEmergency(request) ? "emergency_intake" : "available_now";
  const now = new Date(Date.now() + 30 * 60_000);
  const dateValue = now.toISOString().slice(0, 10);
  const timeValue = now.toTimeString().slice(0, 5);

  mount.innerHTML = `
    <h2>${escapeHtml(petLine(request))}</h2>
    ${sponsoredNotice(request)}
    <p style="font-size:.85rem">${escapeHtml(request.concernSummary)}</p>
    ${ownerSuppliedMedical(request)}
    <div class="workspace-facts">
      <div><small>OWNER</small><strong>${escapeHtml(request.owner?.name || "—")}</strong></div>
      <div><small>PHONE</small><strong>${escapeHtml(request.owner?.phone || "—")}</strong></div>
      <div><small>TRAVEL</small><strong>${escapeHtml(travelLabel(request))}</strong></div>
    </div>
    ${request.searchTarget && request.contactRevealed === false ? '<p class="workspace-empty" style="margin-top:.4rem">Full name and phone number appear once the owner books with your clinic.</p>' : ""}
    <hr class="workspace-divider">
    <p class="workspace-form-title">Availability response</p>
    <form data-decision-form>
      <div class="workspace-grid">
        <div>
          <label class="field">Response type
            <select name="responseType">
              <option value="available_now" ${defaultResponseType === "available_now" ? "selected" : ""}>Available now</option>
              <option value="available_at" ${defaultResponseType === "available_at" ? "selected" : ""}>Available at a stated time</option>
              <option value="emergency_intake" ${defaultResponseType === "emergency_intake" ? "selected" : ""}>Emergency intake, triage on arrival</option>
            </select>
          </label>
          <div class="field-row" style="margin-top:.6rem">
            <label class="field">Available date<input name="availableDate" type="date" value="${dateValue}"></label>
            <label class="field">Available time<input name="availableTime" type="time" value="${timeValue}"></label>
          </div>
          <label class="field" style="margin-top:.6rem">Message to pet owner
            <textarea name="note" rows="4" maxlength="500" placeholder="Arrival entrance, parking, or other instructions"></textarea>
          </label>
        </div>
        <div>
          <div class="compact-grid-2x2">
            <label class="field">Arrival window (min)<input name="arrivalWindowMinutes" type="number" min="5" max="180" value="30"></label>
            <label class="field">Offer hold (min)<input name="holdMinutes" type="number" min="1" max="30" value="5"></label>
            <label class="field">Wait min<input name="waitMin" type="number" min="0" max="1440" value="${availability.stableWaitMin ?? 15}"></label>
            <label class="field">Wait max<input name="waitMax" type="number" min="0" max="1440" value="${availability.stableWaitMax ?? 35}"></label>
          </div>
          <div class="disclaimer-banner">An offer does not book the patient. The owner may compare up to five responses. Unselected offers are released automatically.</div>
        </div>
      </div>
      <div class="workspace-actions">
        <button class="button button-quiet" type="button" data-decision="decline">Decline request</button>
        <button class="button button-coral" type="submit" data-decision="offer">Send availability offer</button>
      </div>
    </form>`;

  const form = $("[data-decision-form]", mount);
  $('[data-decision="decline"]', form).addEventListener("click", () => submitDecision(request, form, true));
  form.addEventListener("submit", (event) => { event.preventDefault(); submitDecision(request, form, false); });
}

async function submitDecision(request, form, decline) {
  const values = new FormData(form);
  const arrivalWindowMinutes = Number(values.get("arrivalWindowMinutes")) || 30;
  const note = values.get("note")?.toString() || "";
  const waitMin = Number(values.get("waitMin"));
  const waitMax = Number(values.get("waitMax"));
  if (!decline && waitMin > waitMax) { showToast("Offer minimum wait cannot exceed maximum wait."); return; }

  setBusy(true);
  try {
    let path; let body;
    if (request.searchTarget) {
      const responseType = values.get("responseType")?.toString() || "available_now";
      let availableAt;
      if (responseType === "available_at") {
        const date = values.get("availableDate")?.toString();
        const time = values.get("availableTime")?.toString();
        if (date && time) availableAt = new Date(`${date}T${time}`).toISOString();
      }
      path = `/api/clinic/search-targets/${encodeURIComponent(request.id)}/decision`;
      body = decline
        ? { decision: "decline" }
        : { decision: "offer", responseType, availableAt, arrivalWindowMinutes, holdMinutes: Number(values.get("holdMinutes")) || 5, waitMin, waitMax, note };
    } else {
      path = `/api/clinic/intakes/${encodeURIComponent(request.id)}/decision`;
      body = decline ? { decision: "decline", arrivalWindowMinutes, note } : { decision: "accept", arrivalWindowMinutes, note };
    }
    await api(path, { method: "POST", body: JSON.stringify(body) });
    track("decision_made", { decision: decline ? "decline" : (request.searchTarget ? "offer" : "accept") });
    setStatus(decline ? `Declined ${request.pet?.name}'s request.` : `${request.searchTarget ? "Availability offer sent" : "Arrival accepted"} for ${request.pet?.name}.`);
    state.selectedRequestId = null;
    await refreshDashboard(true);
  } catch (error) {
    setStatus(error.message);
    showToast(error.message);
  } finally {
    setBusy(false);
  }
}

function wireAvailabilityForm() {
  const form = $("[data-availability-form]");
  form.addEventListener("input", () => { form.dataset.userEdited = "true"; });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = new FormData(form);
    const stableWaitMin = Number(values.get("stableWaitMin"));
    const stableWaitMax = Number(values.get("stableWaitMax"));
    if (stableWaitMin > stableWaitMax) { showToast("Minimum wait cannot exceed maximum wait."); return; }
    setBusy(true);
    try {
      await api("/api/clinic/availability", {
        method: "POST",
        body: JSON.stringify({
          intakeStatus: values.get("intakeStatus"),
          stableWaitMin, stableWaitMax,
          capacityCount: Number(values.get("capacityCount")) || 0,
          ttlMinutes: Number(values.get("ttlMinutes")) || 30,
          acceptsCritical: form.elements.acceptsCritical.checked,
          note: values.get("note")?.toString() || ""
        })
      });
      form.dataset.userEdited = "false";
      setStatus("Live intake status published.");
      await refreshDashboard(true);
    } catch (error) {
      setStatus(error.message);
      showToast(error.message);
    } finally {
      setBusy(false);
    }
  });
}

/* ------------------------------------------------------------- pill mode --- */

function statusVocabLabel(status) {
  return ({
    available: "Accepting", limited: "Limited", confirm_first: "Confirm first",
    critical_only: "Critical only", diverting: "Diverting", closed: "Closed", unverified: "Unverified"
  })[status] || "Unverified";
}

function minutesAgo(iso) {
  const ms = timestampMs(iso);
  return Number.isFinite(ms) ? Math.max(0, Math.round((Date.now() - ms) / 60_000)) : null;
}

function setPillExpanded(expanded) {
  state.pillExpanded = expanded;
  const panel = $("[data-pill-panel]");
  const toggle = $("[data-pill-toggle]");
  if (!panel || !toggle) return;
  panel.hidden = !expanded;
  toggle.setAttribute("aria-expanded", String(expanded));
}

function flashPillWidget() {
  const widget = $("[data-pill-toggle]");
  if (!widget) return;
  widget.classList.remove("is-flash");
  void widget.offsetWidth; // restart the CSS animation
  widget.classList.add("is-flash");
  window.setTimeout(() => widget.classList.remove("is-flash"), 1100);
}

/** One quiet WebAudio chime — a single soft tone, distinct from the sharper
 *  new-request alert beep, marking the moment a status goes stale. */
function playStaleChime() {
  try {
    audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 523;
    gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, audioContext.currentTime + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.6);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.65);
  } catch { /* WebAudio unavailable */ }
}

/** The pill widget: dot, label, remaining capacity, freshness line, and the
 *  persistent stale border once the published status has expired. Tími's
 *  backend already treats an expired report as "unverified" (see
 *  availabilityFromRow in src/db.js); this only reflects that in the UI. */
function renderPill() {
  const availability = state.dashboard?.location?.availability;
  const dot = $("[data-pill-dot]");
  const label = $("[data-pill-label]");
  const capacity = $("[data-pill-capacity]");
  const freshness = $("[data-pill-freshness]");
  const widget = $("[data-pill-toggle]");
  if (!availability || !dot || !widget) return;

  const status = availability.intakeStatus;
  dot.className = `pill-dot status-${status}`;
  label.textContent = statusVocabLabel(status);
  capacity.textContent = availability.capacityCount != null ? `· ${availability.capacityCount}` : "";

  const stale = Boolean(availability.stale);
  if (stale) {
    const age = minutesAgo(availability.expiresAt);
    freshness.textContent = age == null ? "No status published yet — update to publish one." : `Status expired ${age} min ago. Unverified until you update it.`;
  } else {
    const reported = minutesAgo(availability.reportedAt);
    freshness.textContent = `Confirmed ${reported == null ? "moments ago" : `${reported} min ago`} · expires ${formatClock(availability.expiresAt)}`;
  }
  freshness.classList.toggle("is-stale", stale);
  widget.classList.toggle("is-stale", stale);

  if (stale && !state.pillWasStale) {
    playStaleChime();
    flashPillWidget();
  }
  state.pillWasStale = stale;

  hydratePillForm(availability);
  renderPillRequests();
}

function hydratePillForm(availability) {
  const form = $("[data-pill-status-form]");
  if (!form || form.dataset.userEdited === "true") return;
  const value = availability.intakeStatus === "unverified" ? "available" : availability.intakeStatus;
  const radio = form.querySelector(`input[name="intakeStatus"][value="${value}"]`);
  if (radio) radio.checked = true;
  form.elements.capacityCount.value = availability.capacityCount ?? 3;
  form.elements.ttlMinutes.value = "30";
}

function wirePillStatusForm() {
  const toggle = $("[data-pill-toggle]");
  toggle.addEventListener("click", () => setPillExpanded(!state.pillExpanded));

  const form = $("[data-pill-status-form]");
  form.addEventListener("input", () => { form.dataset.userEdited = "true"; });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = new FormData(form);
    const availability = state.dashboard?.location?.availability || {};
    setBusy(true);
    try {
      await api("/api/clinic/availability", {
        method: "POST",
        body: JSON.stringify({
          intakeStatus: values.get("intakeStatus") || "available",
          stableWaitMin: availability.stableWaitMin,
          stableWaitMax: availability.stableWaitMax,
          capacityCount: Number(values.get("capacityCount")) || 0,
          ttlMinutes: Number(values.get("ttlMinutes")) || 30,
          acceptsCritical: availability.acceptsCritical !== false,
          note: availability.note || ""
        })
      });
      form.dataset.userEdited = "false";
      setStatus("Live intake status published.");
      await refreshDashboard(true);
    } catch (error) {
      setStatus(error.message);
      showToast(error.message);
    } finally {
      setBusy(false);
    }
  });
}

/**
 * The pending request the pill surfaces for a decision. Accept and Decline
 * reuse submitDecision() — the exact same /api/clinic/intakes/.../decision
 * and /api/clinic/search-targets/.../decision calls the full decision
 * workspace uses — so there is one place that knows how to answer a request,
 * not two.
 */
function renderPillRequests() {
  const slot = $("[data-pill-request-slot]");
  if (!slot) return;
  const pending = (state.dashboard?.requests || []).filter((r) => r.status === "pending");
  const request = pending[0];
  if (!request) { slot.innerHTML = ""; return; }

  const emergency = isEmergency(request);
  const isSearch = Boolean(request.searchTarget);
  slot.innerHTML = `
    <div class="pill-request ${emergency ? "is-emergency" : ""}">
      <p class="pill-request-eyebrow">${emergency ? "EMERGENCY REQUEST" : "NEW REQUEST"}${pending.length > 1 ? ` · +${pending.length - 1} more waiting` : ""}</p>
      <h3>${escapeHtml(petLine(request))}</h3>
      <p>${escapeHtml(truncate(request.concernSummary, 140))}</p>
      <p class="pill-request-meta">${escapeHtml(travelLabel(request))} · ${escapeHtml(formatClock(request.requestedAt))}</p>
      <form data-pill-decision-form>
        <div class="pill-accept-fields" data-pill-accept-fields hidden>
          ${isSearch
            ? `<label class="field">Estimated wait (min)<input name="waitMin" type="number" min="0" max="1440" value="20" data-pill-wait-sync></label>
               <input type="hidden" name="waitMax" value="20">
               <input type="hidden" name="arrivalWindowMinutes" value="30">`
            : `<label class="field">Arrival window (min)<input name="arrivalWindowMinutes" type="number" min="5" max="180" value="30"></label>`}
          <label class="field">Instructions for the owner <span style="font-weight:400">(optional)</span>
            <textarea name="note" rows="2" maxlength="500" placeholder="Entrance, parking, or what to bring"></textarea>
          </label>
          <input type="hidden" name="responseType" value="${emergency ? "emergency_intake" : "available_now"}">
          <input type="hidden" name="holdMinutes" value="5">
          <div class="button-row">
            <button class="button button-quiet" type="button" data-pill-cancel-accept>Back</button>
            <button class="button button-coral" type="submit">Confirm &amp; send</button>
          </div>
        </div>
        <div class="pill-decision-actions" data-pill-decision-actions>
          <button class="button button-quiet" type="button" data-pill-decline>Decline</button>
          <button class="button button-coral" type="button" data-pill-accept>Accept</button>
        </div>
      </form>
    </div>`;

  const form = $("[data-pill-decision-form]", slot);
  const acceptFields = $("[data-pill-accept-fields]", form);
  const decisionActions = $("[data-pill-decision-actions]", form);
  $("[data-pill-accept]", form).addEventListener("click", () => { acceptFields.hidden = false; decisionActions.hidden = true; });
  $("[data-pill-cancel-accept]", form).addEventListener("click", () => { acceptFields.hidden = true; decisionActions.hidden = false; });
  $("[data-pill-decline]", form).addEventListener("click", () => submitDecision(request, form, true));
  $("[data-pill-wait-sync]", form)?.addEventListener("input", (event) => { form.elements.waitMax.value = event.target.value; });
  form.addEventListener("submit", (event) => { event.preventDefault(); submitDecision(request, form, false); });
}

/* --------------------------------------------------- facility settings --- */

function hydrateSettingsForm(location) {
  const form = $("[data-settings-form]");
  if (!form || !location) return;
  form.elements.kind.value = location.kind || "general";
  const capabilities = location.capabilities || [];
  form.elements.emergencyCapable.checked = capabilities.includes("emergency");
  $$('input[name="species"]', form).forEach((box) => { box.checked = (location.species || []).includes(box.value); });
  const knownCapabilityBoxes = $$('input[name="capability"]', form);
  knownCapabilityBoxes.forEach((box) => { box.checked = capabilities.includes(box.value); });
  const known = new Set([...knownCapabilityBoxes.map((box) => box.value), "emergency"]);
  form.elements.otherCapabilities.value = capabilities.filter((value) => !known.has(value)).join(", ");
  form.elements.open24Hours.checked = Boolean(location.open24Hours);
  form.elements.acceptsWalkIns.checked = location.acceptsWalkIns !== false;
  form.elements.arrivalWindowMinutes.value = location.arrivalWindowMinutes ?? 20;
  form.elements.baseExamFeeCents.value = location.baseExamFeeCents != null ? Math.round(location.baseExamFeeCents / 100) : "";
  form.elements.hoursNote.value = location.hours?.note || "";
  form.elements.staffingLevel.value = location.staffingLevel || "veterinarian";
  form.elements.staffingNote.value = location.staffingNote || "";
}

function wireSettingsPageForm() {
  const form = $("[data-settings-form]");
  if (!form) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = new FormData(form);
    const capabilities = new Set(values.getAll("capability"));
    if (values.get("emergencyCapable")) capabilities.add("emergency"); else capabilities.delete("emergency");
    (values.get("otherCapabilities") || "").toString().split(",")
      .map((value) => value.trim().toLowerCase()).filter(Boolean)
      .forEach((value) => capabilities.add(value));
    const feeDollars = values.get("baseExamFeeCents");
    setBusy(true);
    try {
      const { location } = await api("/api/clinic/settings", {
        method: "POST",
        body: JSON.stringify({
          kind: values.get("kind"),
          species: values.getAll("species"),
          capabilities: [...capabilities],
          open24Hours: form.elements.open24Hours.checked,
          acceptsWalkIns: form.elements.acceptsWalkIns.checked,
          arrivalWindowMinutes: Number(values.get("arrivalWindowMinutes")) || 20,
          baseExamFeeCents: feeDollars ? Math.round(Number(feeDollars) * 100) : undefined,
          hoursNote: values.get("hoursNote")?.toString() || "",
          staffingLevel: values.get("staffingLevel"),
          staffingNote: values.get("staffingNote")?.toString() || ""
        })
      });
      if (state.dashboard) state.dashboard.location = location;
      showToast("Facility settings saved.");
    } catch (error) {
      showToast(error.message);
    } finally {
      setBusy(false);
    }
  });
}

/* -------------------------------------------------------------- settings --- */

function syncSettingsForm() {
  $$("[data-setting]").forEach((input) => {
    const key = input.dataset.setting;
    if (input.type === "checkbox") input.checked = Boolean(state.settings[key]);
    else input.value = state.settings[key];
  });
  const permission = window.Notification?.permission || "unsupported";
  const status = $("[data-notification-status]");
  if (status) status.textContent = permission === "unsupported" ? "Notifications are not supported in this browser." : `Notification permission: ${permission}.`;
}

function wireSettingsForm() {
  $$("[data-setting]").forEach((input) => {
    input.addEventListener("change", () => {
      const key = input.dataset.setting;
      const value = input.type === "checkbox" ? input.checked : Math.max(3, Math.min(60, Number(input.value) || DEFAULT_SETTINGS.pollSeconds));
      state.settings[key] = value;
      saveSettings();
      if (key === "pollSeconds") {
        window.clearInterval(state.pollTimer);
        state.pollTimer = window.setInterval(() => refreshDashboard(false), value * 1000);
      }
    });
  });
  $('[data-action="request-notifications"]').addEventListener("click", async () => {
    if (!window.Notification) { showToast("This browser does not support desktop notifications."); return; }
    await Notification.requestPermission();
    syncSettingsForm();
  });
}

/* -------------------------------------------------------------- alerts --- */

let audioContext = null;
function playAlertBeep() {
  try {
    audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.2, audioContext.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.32);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.34);
  } catch { /* WebAudio unavailable */ }
}

function fireNotification(request) {
  if (!window.Notification || Notification.permission !== "granted") return;
  const title = isEmergency(request) ? `Emergency intake · ${request.pet?.name}` : `New intake · ${request.pet?.name}`;
  const notification = new Notification(title, { body: truncate(request.concernSummary, 180), tag: request.id });
  notification.addEventListener("click", () => { window.focus(); setRoute("console"); state.selectedRequestId = request.id; renderQueue(state.dashboard.requests); renderDecisionWorkspace(); });
}

function showAutoOpenBanner(request) {
  $(".auto-open-banner")?.remove();
  const banner = document.createElement("div");
  banner.className = "auto-open-banner";
  banner.innerHTML = `<strong>${escapeHtml(isEmergency(request) ? "Emergency intake" : "New intake")} · ${escapeHtml(request.pet?.name || "Pet")}</strong>
    <p>${escapeHtml(truncate(request.concernSummary, 120))}</p>
    <button class="button button-primary" type="button">Open floating console</button>`;
  banner.querySelector("button").addEventListener("click", async () => { await openMiniWindow(false); banner.remove(); });
  document.body.appendChild(banner);
  window.setTimeout(() => banner.remove(), 15000);
}

async function onNewPendingRequest(request) {
  if (!state.settings.alertsEnabled) return;
  if (state.settings.playSound) playAlertBeep();
  fireNotification(request);
  if (state.settings.autoOpenMini) {
    const opened = await openMiniWindow(true);
    if (!opened) showAutoOpenBanner(request);
  }
}

/* --------------------------------------------------- floating mini window --- */

function cloneStylesInto(targetDoc) {
  [...document.styleSheets].forEach((styleSheet) => {
    try {
      const cssText = [...styleSheet.cssRules].map((rule) => rule.cssText).join("\n");
      const style = targetDoc.createElement("style");
      style.textContent = cssText;
      targetDoc.head.appendChild(style);
    } catch {
      if (styleSheet.href) {
        const link = targetDoc.createElement("link");
        link.rel = "stylesheet";
        link.href = styleSheet.href;
        targetDoc.head.appendChild(link);
      }
    }
  });
  $$('link[rel="stylesheet"]').forEach((link) => {
    if (![...targetDoc.querySelectorAll('link[rel="stylesheet"]')].some((existing) => existing.href === link.href)) {
      const clone = targetDoc.createElement("link");
      clone.rel = "stylesheet";
      clone.href = link.href;
      targetDoc.head.appendChild(clone);
    }
  });
}

function buildMiniDocument(doc) {
  doc.title = "Tími · Live";
  const meta = doc.createElement("meta");
  meta.name = "color-scheme";
  meta.content = "light dark";
  doc.head.appendChild(meta);
  doc.body.style.margin = "0";
  cloneStylesInto(doc);
  doc.body.innerHTML = `
    <div class="mini-root">
      <div class="mini-header">
        <div class="mini-wordmark"><b>Tími</b><span> NOW · LIVE</span></div>
        <button class="mini-close" type="button" data-mini-close aria-label="Close">×</button>
      </div>
      <div class="mini-summary">
        <div><strong data-mini-clinic>Tími veterinary console</strong><small data-mini-status>Connecting…</small></div>
        <div class="mini-pending-pill"><span data-mini-pending>0</span> waiting</div>
      </div>
      <div class="mini-list" data-mini-list></div>
      ${state.miniKind === "popup" ? '<p class="mini-fallback-note">This browser lacks Document Picture-in-Picture, so this pop-up isn’t guaranteed to stay on top. Chrome or Edge keep it always on top.</p>' : ""}
      <div class="mini-footer">
        <label><input type="checkbox" data-mini-autoopen> Pop open on a new request</label>
        <button class="button button-primary" type="button" data-mini-open>Open decision workspace</button>
      </div>
    </div>`;
  doc.querySelector("[data-mini-close]").addEventListener("click", closeMiniWindow);
  doc.querySelector("[data-mini-open]").addEventListener("click", () => {
    window.focus();
    setRoute("console");
    closeMiniWindow();
  });
  const autoOpenBox = doc.querySelector("[data-mini-autoopen]");
  autoOpenBox.checked = state.settings.autoOpenMini;
  autoOpenBox.addEventListener("change", () => {
    state.settings.autoOpenMini = autoOpenBox.checked;
    saveSettings();
    syncSettingsForm();
  });
}

function miniItemHtml(request) {
  return `<div class="mini-item ${isEmergency(request) ? "is-emergency" : ""}">
    <span class="mini-avatar">${escapeHtml(initials(request.pet?.name))}</span>
    <div><h4>${escapeHtml(petLine(request))}</h4><p>${escapeHtml(request.concernSummary)}</p></div>
    <span class="mini-travel">${escapeHtml(travelLabel(request))}</span>
  </div>`;
}

function renderMiniWindow() {
  const win = state.miniWin;
  if (!win || win.closed) { state.miniWin = null; state.miniKind = null; return; }
  const doc = win.document;
  const dashboard = state.dashboard;
  const clinicNode = doc.querySelector("[data-mini-clinic]");
  if (!clinicNode) return;
  clinicNode.textContent = dashboard?.location?.name || "Tími veterinary console";
  doc.querySelector("[data-mini-status]").textContent = state.statusMessage;
  const pending = (dashboard?.requests || []).filter((r) => r.status === "pending");
  doc.querySelector("[data-mini-pending]").textContent = pending.length;
  const list = doc.querySelector("[data-mini-list]");
  list.innerHTML = pending.length ? pending.map(miniItemHtml).join("") : '<div class="mini-empty">No pending requests.</div>';
}

/**
 * Opens the always-on-top floating console. Tries the Document
 * Picture-in-Picture API first (genuinely always-on-top, chrome-less — the
 * closest web equivalent to WPF's Topmost="True"); falls back to a plain
 * pop-up window when unsupported. Both attempts can be refused by the browser
 * when not called from a fresh user gesture (e.g. an automatic open triggered
 * by a poll tick) — callers should treat a `false` return as "show the banner
 * instead", not as an error.
 */
async function openMiniWindow(userInitiated) {
  if (state.miniWin && !state.miniWin.closed) {
    renderMiniWindow();
    try { state.miniWin.focus(); } catch { /* ignore */ }
    return true;
  }

  if ("documentPictureInPicture" in window) {
    try {
      const pipWindow = await window.documentPictureInPicture.requestWindow({ width: 390, height: 300 });
      state.miniWin = pipWindow;
      state.miniKind = "pip";
      buildMiniDocument(pipWindow.document);
      renderMiniWindow();
      pipWindow.addEventListener("pagehide", () => { state.miniWin = null; state.miniKind = null; });
      return true;
    } catch (error) {
      if (userInitiated) console.warn("Picture-in-picture window was refused", error);
    }
  }

  try {
    const popup = window.open("", "timi-vet-mini", "popup=yes,width=390,height=300,left=80,top=80");
    if (!popup) { if (userInitiated) showToast("Allow pop-ups for Tími Vet to open the floating console."); return false; }
    state.miniWin = popup;
    state.miniKind = "popup";
    buildMiniDocument(popup.document);
    renderMiniWindow();
    return true;
  } catch (error) {
    if (userInitiated) showToast("Could not open the floating console in this browser.");
    return false;
  }
}

function closeMiniWindow() {
  try { state.miniWin?.close(); } catch { /* already closed */ }
  state.miniWin = null;
  state.miniKind = null;
}

/* --------------------------------------------------------------- billing --- */

const RECEIVABLE_STATE_LABEL = {
  DUE: "Due", RETRYING: "Retrying", PAST_DUE: "Past due", RESTRICTED: "Restricted",
  INVOICED: "On a statement", PAID: "Paid", VOID: "Voided", WAIVED: "Waived"
};

const INVOICE_STATE_LABEL = {
  DRAFT: "Draft", OPEN: "Sent", SENT: "Sent", PAID: "Paid", PAST_DUE: "Past due", VOID: "Voided", UNCOLLECTIBLE: "Uncollectible"
};

const FEE_REASON_LABEL = {
  STANDARD_RATE: "Standard rate",
  FOUNDING_CLINIC_RATE: "Founding clinic · $0",
  SPONSORED_VISIT: "Paw It Forward sponsored · $0"
};

function billingDate(value) {
  if (!value) return "—";
  const ms = timestampMs(value);
  return Number.isFinite(ms) ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(ms)) : "—";
}

/**
 * The clinic's own money, and only its own.
 *
 * Everything here is the clinic's relationship with Tími NOW: what completed,
 * what it owes for those completions, which statement each line landed on,
 * and whether that statement is paid. A sponsored line shows $0 and the fact
 * that it was sponsored — never who was helped or why.
 */
async function enterBilling() {
  const summary = $("[data-billing-summary]");
  try {
    const data = await api("/api/clinic/billing");
    state.billing = data.billing || data;
  } catch (error) {
    state.billing = null;
    summary.innerHTML = `<p class="billing-empty">Billing is unavailable right now — ${escapeHtml(error.message)}</p>`;
    $("[data-billing-invoices]").innerHTML = '<p class="billing-empty">Unavailable.</p>';
    $("[data-billing-receivables]").innerHTML = '<p class="billing-empty">Unavailable.</p>';
    return;
  }
  renderBilling();
}

function renderBilling() {
  const billing = state.billing || {};
  const receivables = billing.receivables || [];
  const invoices = billing.invoices || [];
  const fee = clinicFees();
  // Founding status is whatever the server says it is; where it says nothing,
  // the most recent priced line is the honest answer rather than a guess.
  const plan = billing.plan || billing.pricingPlan || receivables.find((row) => row.plan)?.plan || null;
  const founding = plan === "FOUNDING";
  const completed = receivables.length;
  const paidCents = receivables.filter((row) => row.state === "PAID").reduce((total, row) => total + row.amountCents, 0);

  $("[data-billing-summary]").innerHTML = [
    { label: "Your fee per completed connection", value: founding ? formatMoney(0) : formatMoney(fee.clinicFeeCents), note: founding ? "Founding clinic rate, while participating and in good standing" : "Charged only on a verified completion" },
    { label: "Outstanding", value: formatMoney(billing.outstandingCents || 0), note: billing.restricted ? `${billing.restrictedCount || 1} line restricted — new availability acceptances are paused until it is settled` : "Nothing past due" },
    { label: "Completed connections billed", value: String(completed), note: `${formatMoney(paidCents)} settled to date` },
    { label: "Statements", value: String(invoices.length), note: invoices[0] ? `Latest ${billingDate(invoices[0].periodStart)} · ${INVOICE_STATE_LABEL[invoices[0].status] || humanize(invoices[0].status)}` : "No statement yet" }
  ].map((tile) => `<article class="card billing-tile"><small>${escapeHtml(tile.label)}</small><strong>${escapeHtml(tile.value)}</strong><span>${escapeHtml(tile.note)}</span></article>`).join("");

  $("[data-billing-invoice-count]").textContent = invoices.length ? `${invoices.length} statement${invoices.length === 1 ? "" : "s"}` : "None yet";
  $("[data-billing-invoices]").innerHTML = invoices.length
    ? `<table class="billing-table"><thead><tr><th>Period</th><th>Connections</th><th>Total</th><th>Status</th><th>Paid</th></tr></thead><tbody>${invoices.map((invoice) => `
        <tr><td>${escapeHtml(billingDate(invoice.periodStart))} – ${escapeHtml(billingDate(invoice.periodEnd))}</td>
        <td>${invoice.lineCount}</td>
        <td>${escapeHtml(formatMoney(invoice.totalCents))}</td>
        <td><span class="billing-state is-${escapeHtml(String(invoice.status || "").toLowerCase())}">${escapeHtml(INVOICE_STATE_LABEL[invoice.status] || humanize(invoice.status || "—"))}</span></td>
        <td>${escapeHtml(invoice.paidAt ? billingDate(invoice.paidAt) : "—")}</td></tr>`).join("")}</tbody></table>`
    : '<p class="billing-empty">Your first monthly statement appears here once a connection completes.</p>';

  $("[data-billing-receivable-count]").textContent = completed ? `${completed} completed` : "None yet";
  $("[data-billing-receivables]").innerHTML = completed
    ? `<table class="billing-table"><thead><tr><th>Completed</th><th>Booking</th><th>Fee</th><th>Basis</th><th>Status</th><th>Statement</th></tr></thead><tbody>${receivables.map((row) => `
        <tr><td>${escapeHtml(billingDate(row.completedAt))}</td>
        <td class="billing-id">${escapeHtml(row.intakeId)}</td>
        <td>${escapeHtml(formatMoney(row.amountCents))}</td>
        <td>${escapeHtml(FEE_REASON_LABEL[row.reason] || humanize(row.reason || "—"))}</td>
        <td><span class="billing-state is-${escapeHtml(String(row.state || "").toLowerCase())}">${escapeHtml(RECEIVABLE_STATE_LABEL[row.state] || humanize(row.state || "—"))}</span></td>
        <td>${escapeHtml(row.invoiceId || "—")}</td></tr>`).join("")}</tbody></table>`
    : '<p class="billing-empty">A completed connection appears here with the fee it carried, including sponsored connections at $0.</p>';
}

/* ---------------------------------------------------------------- people --- */

async function enterPeople() {
  const mount = $("[data-people-body]");
  mount.innerHTML = `<p class="workspace-empty">Loading roster…</p>`;
  try {
    const data = await api("/api/tenant/members");
    state.people = data;
    renderPeople();
  } catch (error) {
    mount.innerHTML = `<p class="workspace-fail">${escapeHtml(error.message)}</p>`;
  }
}

function isSelfAdmin() {
  return state.session?.user?.role === "org:admin";
}

function renderPeople() {
  const mount = $("[data-people-body]");
  const canManage = isSelfAdmin();
  const { members = [], invitations = [] } = state.people || {};
  mount.innerHTML = `
    ${canManage ? `
    <div class="people-add">
      <label class="field">Add by email<input type="email" data-add-email placeholder="name@clinic.example"></label>
      <label class="field">Role
        <select data-add-role>
          <option value="org:member">Member</option>
          <option value="org:admin">Administrator</option>
        </select>
      </label>
      <button class="button button-primary" type="button" data-add-submit>Add person</button>
    </div>` : ""}
    <table class="people-table">
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th></th></tr></thead>
      <tbody>${members.map((member) => `
        <tr data-member="${escapeHtml(member.clerkUserId)}">
          <td>${escapeHtml(member.name)}${member.isSelf ? " (you)" : ""}</td>
          <td>${escapeHtml(member.email || "—")}</td>
          <td>${canManage && !member.isSelf
            ? `<select data-role-select><option value="org:member" ${member.role === "org:member" ? "selected" : ""}>Member</option><option value="org:admin" ${member.role === "org:admin" ? "selected" : ""}>Administrator</option></select>`
            : `<span class="pill-role ${member.role === "org:admin" ? "is-admin" : ""}">${escapeHtml(humanize(member.role.replace("org:", "")))}</span>`}
          </td>
          <td class="row-actions">${canManage && !member.isSelf ? `<button type="button" data-remove>Remove</button>` : ""}</td>
        </tr>`).join("") || `<tr><td colspan="4">No members yet.</td></tr>`}
      </tbody>
    </table>
    ${invitations.length ? `
    <div class="section-heading"><h2>Pending invitations</h2></div>
    <table class="people-table">
      <thead><tr><th>Email</th><th>Role</th><th>Sent</th><th></th></tr></thead>
      <tbody>${invitations.map((invite) => `
        <tr data-invitation="${escapeHtml(invite.id)}">
          <td>${escapeHtml(invite.email)}</td>
          <td><span class="pill-role ${invite.role === "org:admin" ? "is-admin" : ""}">${escapeHtml(humanize(invite.role.replace("org:", "")))}</span></td>
          <td>${escapeHtml(invite.createdAt ? new Date(invite.createdAt).toLocaleDateString() : "—")}</td>
          <td class="row-actions">${canManage ? `<button type="button" data-revoke>Revoke</button>` : ""}</td>
        </tr>`).join("")}
      </tbody>
    </table>` : ""}
    ${!canManage ? '<p class="people-note" style="margin-top:1.2rem">You have read-only access to this roster. Ask a workspace administrator to make changes.</p>' : ""}
  `;

  if (!canManage) return;

  $("[data-add-submit]", mount)?.addEventListener("click", async () => {
    const email = $("[data-add-email]", mount).value.trim();
    const role = $("[data-add-role]", mount).value;
    if (!email) return;
    try {
      await api("/api/tenant/members", { method: "POST", body: JSON.stringify({ email, role }) });
      showToast("Sent.");
      await enterPeople();
    } catch (error) { showToast(error.message); }
  });

  $$("[data-member]", mount).forEach((row) => {
    const memberId = row.dataset.member;
    row.querySelector("[data-role-select]")?.addEventListener("change", async (event) => {
      try {
        await api(`/api/tenant/members/${encodeURIComponent(memberId)}`, { method: "PATCH", body: JSON.stringify({ role: event.target.value }) });
        showToast("Role updated.");
        await enterPeople();
      } catch (error) { showToast(error.message); await enterPeople(); }
    });
    row.querySelector("[data-remove]")?.addEventListener("click", async () => {
      if (!confirm("Remove this person from the workspace?")) return;
      try {
        await api(`/api/tenant/members/${encodeURIComponent(memberId)}`, { method: "DELETE" });
        showToast("Removed.");
        await enterPeople();
      } catch (error) { showToast(error.message); }
    });
  });

  $$("[data-invitation]", mount).forEach((row) => {
    row.querySelector("[data-revoke]")?.addEventListener("click", async () => {
      try {
        await api(`/api/tenant/invitations/${encodeURIComponent(row.dataset.invitation)}`, { method: "DELETE" });
        showToast("Invitation revoked.");
        await enterPeople();
      } catch (error) { showToast(error.message); }
    });
  });
}

/* ------------------------------------------------------------------ boot --- */

function wireGlobalActions() {
  $$('[data-route]').forEach((el) => el.addEventListener("click", () => setRoute(el.dataset.route)));
  $('[data-action="refresh-now"]')?.addEventListener("click", () => refreshDashboard(true));
  $('[data-action="open-mini"]')?.addEventListener("click", () => openMiniWindow(true));
  $$('[data-action="sign-out"]').forEach((button) => button.addEventListener("click", async () => {
    closeMiniWindow();
    window.clearInterval(state.pollTimer);
    try { await state.clerk?.signOut(); } catch { /* already signed out */ }
    location.hash = "sign-in";
  }));
}

window.addEventListener("hashchange", renderRoute);
window.addEventListener("beforeunload", closeMiniWindow);

async function main() {
  try {
    wireGlobalActions();
    wireAvailabilityForm();
    wirePillStatusForm();
    wireSettingsPageForm();
    wireSettingsForm();
    await loadConfig();
    await renderRoute();
  } finally {
    hideBootSplash();
  }
}

main();

if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
