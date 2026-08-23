import {
  VoiceGuide,
  clearRoute,
  configureMap,
  drawRoute,
  fetchRoute,
  formatDistance,
  formatDuration,
  mapAvailable,
  phraseInstruction,
  renderClinicMap,
  announcement,
  toneFor
} from "./map.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const APP_ROUTES = new Set(["find", "results", "tracker", "pets", "clinic", "sign-in", "legal"]);
const PROTECTED_ROUTES = new Set(["find", "results", "tracker", "pets", "clinic"]);
const DEFAULT_POSITION = { latitude: 37.6688, longitude: -122.0808, label: "Hayward, California", detail: "Using demonstration coordinates" };
const STORAGE_KEYS = {
  draft: "timi_intake_draft_v1",
  intake: "timi_current_intake_v1",
  search: "timi_current_search_v1",
  clinicAvailability: "timi_demo_clinic_availability_v1",
  clinicDecisions: "timi_demo_clinic_decisions_v1",
  navigation: "timi_navigation_preferences_v1"
};

const state = {
  route: "home",
  config: null,
  clerk: null,
  session: null,
  auth: null,
  intakeStep: 1,
  intakeDraft: readStorage(STORAGE_KEYS.draft, {
    position: DEFAULT_POSITION,
    petName: "Otis",
    species: "dog",
    breed: "Golden retriever",
    weightLbs: 72,
    urgency: "same_day",
    symptoms: [],
    startedWhen: "",
    concernSummary: "",
    redFlags: [],
    ownerName: "Maya Morgan",
    ownerPhone: "(510) 555-0147",
    ownerEmail: "maya@example.com"
  }),
  locations: [],
  selectedLocation: null,
  currentIntake: readStorage(STORAGE_KEYS.intake, null),
  currentSearch: readStorage(STORAGE_KEYS.search, null),
  trackerTimer: null,
  clinicTimer: null,
  deferredInstall: null,
  stripe: null,
  stripeElements: null,
  clinicData: null,
  knownClinicRequests: new Set(),
  clinicInitialized: false,
  resultsMap: null,
  trackerMap: null,
  activeRoute: null,
  navigationActive: false,
  navigationWatchId: null,
  voiceGuide: null,
  navigationPreferences: readStorage(STORAGE_KEYS.navigation, {
    voiceEnabled: true,
    voiceURI: null,
    rate: 1,
    units: "imperial",
    avoidTolls: false,
    avoidHighways: false,
    avoidFerries: false
  })
};

function readStorage(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage can be unavailable in privacy modes. */ }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatMoney(cents) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format((cents || 0) / 100);
}

function timestampMs(value) {
  if (!value) return Number.NaN;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  return Date.parse(normalized);
}

function formatRelativeTime(iso) {
  if (!iso) return "Not recently confirmed";
  const seconds = Math.max(0, Math.round((Date.now() - timestampMs(iso)) / 1000));
  if (seconds < 60) return `${seconds || 1} sec ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hr ago`;
}

function formatClock(iso) {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(timestampMs(iso)));
}

function initials(name) {
  return String(name).split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function humanize(value) {
  return String(value || "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

const GENERIC_CONCERN = /^(?:(?:my|the)\s+(?:dog|cat|pet|animal)\s+)?(?:isn['’]?t|is not|doesn['’]?t seem|does not seem|hasn['’]?t been)?\s*(?:acting like (?:himself|herself|themself|themselves)|feeling (?:well|good)|doing (?:well|good)|right|normal|himself|herself|themselves|seems? off|sick|unwell|not okay|something(?: is|'s) wrong)[.! ]*$/i;
const OBSERVABLE_DETAIL = /\b(vomit|throw(?:ing)? up|diarrh|stool|feces|cough|wheez|breath|pant|limp|walk|stand|pain|cry|yel[p|l]|bleed|wound|swollen|lump|seiz|collaps|unconscious|urine|urinat|pee|drink|water|eat|food|appetite|eye|ear|skin|rash|itch|scratch|toxin|poison|chocol|medication|fever|temperature|discharge|shak|trembl|letharg|energy|sleep|hiding|aggress|abdomen|belly|leg|paw|mouth)\w*/i;
const QUANTIFIED_DETAIL = /\b(?:\d+|once|twice|three|four|several|every|hourly|constantly|repeatedly|since|for\s+\d+|minutes?|hours?|days?|today|yesterday|morning|tonight)\b/i;
const FUNCTIONAL_DETAIL = /\b(?:won['’]?t|will not|can['’]?t|cannot|unable|refus|less than|more than|stopped|difficulty|struggl|only)\b/i;

function assessConcern(summary, symptoms, startedWhen) {
  const text = String(summary || "").trim();
  const words = text.match(/[a-z0-9'’]+/gi) || [];
  const selected = Array.isArray(symptoms) ? symptoms : [];
  const concrete = OBSERVABLE_DETAIL.test(text);
  const quantified = QUANTIFIED_DETAIL.test(text);
  const functional = FUNCTIONAL_DETAIL.test(text);
  const weakCategoryOnly = selected.every((value) => ["energy_or_behavior", "other_observable"].includes(value));
  if (!selected.length) return { ok: false, message: "Select at least one thing you can observe." };
  if (!startedWhen) return { ok: false, message: "Choose when the change started." };
  if (text.length < 30 || words.length < 6) return { ok: false, message: "Add a little more detail: what changed and how often or how much." };
  if (GENERIC_CONCERN.test(text) || (!concrete && !quantified && !functional)) return { ok: false, message: "Describe something observable—for example eating, breathing, walking, vomiting, stool, urination, pain, or a visible injury." };
  if (weakCategoryOnly && !concrete) return { ok: false, message: "For behavior or energy changes, include the specific action that changed, such as hiding, refusing food, trouble standing, or unusual sleep." };
  const strength = 2 + Number(concrete) + Number(quantified) + Number(functional) + Number(words.length >= 12);
  return { ok: true, strength, message: strength >= 5 ? "Specific enough for a clinic to review" : "Good—one more concrete detail would help" };
}

function showToast(message) {
  const toast = $("[data-toast]");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("is-visible"), 3200);
}

function parseRoute() {
  const raw = location.hash.replace(/^#/, "") || "home";
  const [route] = raw.split("?");
  if (route === "how-it-works" || route === "emergency") return "home";
  return $("[data-screen='" + CSS.escape(route) + "']") ? route : "home";
}

function routeQuery() {
  const raw = location.hash.split("?")[1] || "";
  return new URLSearchParams(raw);
}

function setRoute(route) {
  if (location.hash === `#${route}`) renderRoute();
  else location.hash = route;
}

function clearTimers() {
  window.clearInterval(state.trackerTimer);
  window.clearInterval(state.clinicTimer);
  state.trackerTimer = null;
  state.clinicTimer = null;
}

async function renderRoute() {
  clearTimers();
  releaseMaps();
  $$('dialog[open]').forEach((dialog) => dialog.close());
  document.body.classList.remove("dialog-open");
  let route = parseRoute();
  if (state.config?.signInRequired && PROTECTED_ROUTES.has(route) && !state.clerk?.user) {
    sessionStorage.setItem("timi_return_route", route);
    route = "sign-in";
  }
  if (state.config?.signInRequired && state.clerk?.user && !state.session) {
    try { state.session = (await api("/api/session")).session; } catch { state.session = null; }
  }
  state.route = route;

  const render = () => {
    $$('[data-screen]').forEach((screen) => {
      const active = screen.dataset.screen === route;
      screen.classList.toggle("is-active", active);
      screen.setAttribute("aria-hidden", String(!active));
    });
    $("[data-public-header]").hidden = APP_ROUTES.has(route);
    document.body.classList.toggle("app-view", APP_ROUTES.has(route));
    window.scrollTo({ top: 0, behavior: "instant" });
  };
  if (document.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) document.startViewTransition(render);
  else render();

  document.title = ({
    home: "Tími NOW — find veterinary care right now",
    find: "Tell us what is happening · Tími NOW",
    results: "Available veterinary care · Tími NOW",
    tracker: "Live intake request · Tími NOW",
    pets: "Pet profile · Tími NOW",
    clinic: "Clinic console · Tími NOW",
    legal: "Legal center · Tími NOW",
    "sign-in": "Sign in · Tími NOW"
  })[route];

  if (route === "home") {
    const anchor = location.hash.replace("#", "");
    if (["how-it-works", "emergency"].includes(anchor)) requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView());
  }
  if (route === "legal") {
    const section = routeQuery().get("section") || "terms";
    requestAnimationFrame(() => document.getElementById(section)?.scrollIntoView({ block: "start" }));
  }
  if (route === "find") {
    if (routeQuery().get("care") === "emergency") {
      state.intakeDraft.urgency = "emergency";
      state.intakeStep = 1;
    }
    hydrateIntakeForm();
    renderIntakeStep();
  }
  if (route === "results") await loadLocations();
  if (route === "tracker") {
    await refreshCurrentIntake();
    state.trackerTimer = window.setInterval(refreshCurrentIntake, 5000);
  }
  if (route === "clinic") {
    renderAccountMenu();
    renderClinicWorkspaceSwitch();
    const denied = state.config?.signInRequired && state.session && state.session.surfaces && !state.session.surfaces.clinic;
    $("[data-clinic-denied]").hidden = !denied;
    $("[data-clinic-console-body]").hidden = denied;
    if (!denied) {
      await loadClinicDashboard();
      state.clinicTimer = window.setInterval(loadClinicDashboard, 15000);
    }
  }
  if (route === "sign-in") await renderSignIn();
  if (APP_ROUTES.has(route) && route !== "sign-in") renderAccountMenu();
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("accept", "application/json");
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (state.config?.signInRequired && state.clerk?.session) {
    let token = null;
    try { token = await state.clerk.session.getToken({ template: "timinow" }); }
    catch { token = await state.clerk.session.getToken(); }
    if (token) headers.set("authorization", `Bearer ${token}`);
  } else if (options.clinic) {
    headers.set("x-demo-role", "clinic");
    headers.set("x-demo-tenant-id", "tenant_hearth");
    headers.set("x-demo-user-id", "demo_clinic_manager");
  }
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

async function loadConfig() {
  try {
    state.config = await api("/api/config");
  } catch {
    state.config = { signInRequired: false, demoMode: true, database: "fixtures" };
  }
  configureMap(state.config.map);
  if (state.config.signInRequired) await initializeClerk();
}

async function initializeClerk() {
  if (!state.config.clerkPublishableKey || !state.config.clerkJsUrl) return;
  try {
    const clerkModule = await import(state.config.clerkJsUrl);
    const Clerk = clerkModule.Clerk || clerkModule.default?.Clerk || clerkModule.default;
    state.clerk = new Clerk(state.config.clerkPublishableKey);
    await state.clerk.load();
    await maybeHandleOAuthRedirect();
    state.clerk.addListener(() => renderAccountMenu());
  } catch (error) {
    console.error("Clerk initialization failed", error);
  }
}

async function maybeHandleOAuthRedirect() {
  if (!state.clerk) return;
  const hasRedirectParams = /[?&](__clerk_status|__clerk_handshake|__clerk_ticket|rotating_token_nonce)=/.test(location.href);
  if (!hasRedirectParams) return;
  try {
    await state.clerk.handleRedirectCallback({
      afterSignInUrl: `${location.origin}/#find`,
      afterSignUpUrl: `${location.origin}/#find`
    });
  } catch (error) {
    console.error("Clerk redirect handling failed", error);
  }
}

/* ---------------------------------------------------------------------- */
/* Custom Clerk-headless auth state machine                               */
/* ---------------------------------------------------------------------- */

function resetAuthFlow() {
  state.auth = {
    step: "identifier",
    signIn: null,
    signUp: null,
    factors: [],
    activeFactor: null,
    flowKind: "sign-in",
    signUpChannel: null,
    signUpIdentifier: "",
    resendAvailableAt: 0,
    resendTimer: null,
    memberships: [],
    pendingRoute: null,
    forceOrgPicker: false
  };
  $("[data-auth-identifier-form]")?.reset();
  $("[data-auth-password-form]")?.reset();
  $("[data-auth-signup-form]")?.reset();
  $("[data-auth-reset-form]")?.reset();
  clearOtpInputs();
  setAuthStep("identifier");
}

function setAuthStep(step) {
  $$('[data-auth-step]').forEach((panel) => { panel.hidden = panel.dataset.authStep !== step; });
  if (state.auth) state.auth.step = step;
  clearAuthError();
  if (step === "code") requestAnimationFrame(focusFirstOtp);
}

function showAuthError(error) {
  const message = error?.errors?.[0]?.longMessage || error?.message || "Something went wrong. Please try again.";
  const box = $("[data-auth-error]");
  if (!box) return;
  box.querySelector("[data-auth-error-text]").textContent = message;
  box.hidden = false;
}

function clearAuthError() {
  const box = $("[data-auth-error]");
  if (box) box.hidden = true;
}

function setSubmitting(form, submitting, label) {
  const button = form.querySelector(".auth-submit");
  if (!button) return;
  button.disabled = submitting;
  button.textContent = submitting ? "Please wait…" : label;
}

async function renderSignIn() {
  const disabled = $("[data-auth-disabled]");
  const steps = $("[data-auth-steps]");
  if (!state.config?.signInRequired) {
    steps.hidden = true;
    disabled.hidden = false;
    return;
  }
  disabled.hidden = true;
  steps.hidden = false;
  if (!state.clerk) {
    setAuthStep("identifier");
    showAuthError({ errors: [{ longMessage: "Clerk is not configured. Add the Clerk publishable key and issuer before setting SIGN_IN_REQUIRED=true." }] });
    return;
  }
  if (state.auth?.forceOrgPicker) {
    state.auth.forceOrgPicker = false;
    renderOrgPicker(state.clerk.user?.organizationMemberships || []);
    return;
  }
  if (state.clerk.user) {
    await afterAuthenticated();
    return;
  }
  resetAuthFlow();
}

async function afterAuthenticated() {
  try { state.session = (await api("/api/session")).session; }
  catch { state.session = null; }
  const returnRoute = (state.auth && state.auth.pendingRoute) || sessionStorage.getItem("timi_return_route") || "find";
  const memberships = state.clerk.user?.organizationMemberships || [];
  if (returnRoute === "clinic" && !state.clerk.organization) {
    if (memberships.length > 1) {
      if (!state.auth) state.auth = { pendingRoute: null };
      state.auth.pendingRoute = "clinic";
      renderOrgPicker(memberships);
      return;
    }
    if (memberships.length === 1) {
      try {
        await state.clerk.setActive({ organization: memberships[0].organization.id });
        state.session = (await api("/api/session")).session;
      } catch { /* fall through with whatever session we already have */ }
    }
  }
  finalizeRouting(returnRoute);
}

function finalizeRouting(returnRoute) {
  sessionStorage.removeItem("timi_return_route");
  if (state.auth) state.auth.pendingRoute = null;
  renderAccountMenu();
  if (returnRoute === "clinic" && state.session && state.session.surfaces && !state.session.surfaces.clinic) {
    setAuthStep("denied");
    $("[data-auth-denied-message]").textContent = "This account is not part of a veterinary workspace. Sign in with a clinic account, or return to the customer app.";
    return;
  }
  setRoute(returnRoute);
}

function renderOrgPicker(memberships) {
  state.auth.memberships = memberships;
  const list = $("[data-auth-org-list]");
  list.innerHTML = memberships.map((membership, index) => `
    <button class="auth-org-card" type="button" data-org-index="${index}">
      <span class="auth-org-avatar">${escapeHtml(initials(membership.organization?.name || "Org"))}</span>
      <span><strong>${escapeHtml(membership.organization?.name || "Workspace")}</strong><small>${escapeHtml(humanize(membership.role || ""))}</small></span>
    </button>`).join("");
  setAuthStep("organization");
}

function openOrgSwitcher() {
  const memberships = state.clerk?.user?.organizationMemberships || [];
  if (memberships.length < 2) return showToast("This account has only one workspace.");
  if (!state.auth) resetAuthFlow();
  state.auth.pendingRoute = state.route === "sign-in" ? "clinic" : state.route;
  state.auth.forceOrgPicker = true;
  setRoute("sign-in");
}

function strategyLabel(factor) {
  switch (factor.strategy) {
    case "password": return { title: "Use your password", detail: "" };
    case "email_code": return { title: "Email me a code", detail: factor.safeIdentifier || "" };
    case "phone_code": return { title: "Text me a code", detail: factor.safeIdentifier || "" };
    case "passkey": return { title: "Use a passkey", detail: "" };
    case "reset_password_email_code": return { title: "Reset your password", detail: "Emails a reset code" };
    default: return { title: humanize(factor.strategy), detail: "" };
  }
}

function renderStrategyStep(signIn) {
  const factors = signIn.supportedFirstFactors || [];
  state.auth.factors = factors;
  if (factors.length <= 1) {
    if (factors[0]) return startFactor(factors[0]);
    return showAuthError({ errors: [{ longMessage: "No sign-in method is available for this account." }] });
  }
  const list = $("[data-auth-strategy-list]");
  list.innerHTML = factors.map((factor, index) => {
    const label = strategyLabel(factor);
    return `<button class="auth-strategy-option" type="button" data-factor-index="${index}"><span>${escapeHtml(label.title)}</span>${label.detail ? `<small>${escapeHtml(label.detail)}</small>` : ""}</button>`;
  }).join("");
  setAuthStep("strategy");
}

async function startFactor(factor) {
  switch (factor.strategy) {
    case "password":
      setAuthStep("password");
      break;
    case "email_code":
    case "phone_code":
    case "reset_password_email_code":
      await prepareAndShowCode(factor);
      break;
    case "passkey":
      await signInWithPasskey();
      break;
    default:
      showAuthError({ errors: [{ longMessage: `Unsupported sign-in method: ${humanize(factor.strategy)}` }] });
  }
}

async function prepareAndShowCode(factor) {
  try {
    const params = { strategy: factor.strategy };
    if (factor.emailAddressId) params.emailAddressId = factor.emailAddressId;
    if (factor.phoneNumberId) params.phoneNumberId = factor.phoneNumberId;
    const updated = await state.auth.signIn.prepareFirstFactor(params);
    state.auth.signIn = updated;
    state.auth.activeFactor = factor;
    state.auth.flowKind = "sign-in";
    $("[data-auth-code-lede]").textContent = factor.strategy === "reset_password_email_code"
      ? `Enter the reset code sent to ${factor.safeIdentifier || "your email"}.`
      : `Enter the 6-digit code sent to ${factor.safeIdentifier || "you"}.`;
    clearOtpInputs();
    startResendCooldown();
    setAuthStep("code");
  } catch (error) { showAuthError(error); }
}

async function signInWithPasskey() {
  try {
    const signIn = state.auth.signIn || state.clerk.client.signIn;
    const result = await signIn.authenticateWithPasskey();
    state.auth.signIn = result;
    await handleSignInResult(result);
  } catch (error) { showAuthError(error); }
}

async function startOAuth(strategy) {
  if (!state.clerk) return;
  try {
    await state.clerk.client.signIn.authenticateWithRedirect({
      strategy,
      redirectUrl: `${location.origin}/#sign-in`,
      redirectUrlComplete: `${location.origin}/#find`
    });
  } catch (error) { showAuthError(error); }
}

async function handleSignInResult(signIn) {
  state.auth.signIn = signIn;
  switch (signIn.status) {
    case "complete":
      await completeSignIn(signIn.createdSessionId);
      break;
    case "needs_first_factor":
      renderStrategyStep(signIn);
      break;
    case "needs_second_factor":
      showAuthError({ errors: [{ longMessage: "This account requires a second verification step that isn't supported here yet. Please contact your workspace administrator." }] });
      break;
    case "needs_new_password":
      setAuthStep("reset");
      break;
    case "needs_identifier":
      resetAuthFlow();
      break;
    default:
      showAuthError({ errors: [{ longMessage: `Unexpected sign-in status: ${signIn.status}` }] });
  }
}

async function completeSignIn(sessionId) {
  await state.clerk.setActive({ session: sessionId });
  await afterAuthenticated();
}

async function signOut() {
  try { await state.clerk?.signOut(); } catch (error) { console.error("Sign out failed", error); }
  state.session = null;
  closeAccountMenus();
  renderAccountMenu();
  setRoute("home");
}

/* One-time-code input helpers */
function otpInputs() { return $$('[data-otp-input] input'); }
function clearOtpInputs() { otpInputs().forEach((input) => { input.value = ""; }); }
function getOtpValue() { return otpInputs().map((input) => input.value).join(""); }
function focusFirstOtp() { otpInputs()[0]?.focus(); }

async function submitCode() {
  const code = getOtpValue();
  if (code.length !== 6) return;
  try {
    if (state.auth.flowKind === "sign-up") {
      const signUp = state.auth.signUp;
      const result = state.auth.signUpChannel === "phone"
        ? await signUp.attemptPhoneNumberVerification({ code })
        : await signUp.attemptEmailAddressVerification({ code });
      state.auth.signUp = result;
      if (result.status === "complete") await completeSignIn(result.createdSessionId);
      else showAuthError({ errors: [{ longMessage: `Verification incomplete (${humanize(result.status)}).` }] });
    } else {
      const factor = state.auth.activeFactor;
      const attempted = await state.auth.signIn.attemptFirstFactor({ strategy: factor.strategy, code });
      state.auth.signIn = attempted;
      if (factor.strategy === "reset_password_email_code" && attempted.status === "needs_new_password") return setAuthStep("reset");
      await handleSignInResult(attempted);
    }
  } catch (error) {
    showAuthError(error);
    clearOtpInputs();
    focusFirstOtp();
  }
}

function startResendCooldown() {
  state.auth.resendAvailableAt = Date.now() + 30_000;
  updateResendButton();
  window.clearInterval(state.auth.resendTimer);
  state.auth.resendTimer = window.setInterval(updateResendButton, 1000);
}

function updateResendButton() {
  const button = $("[data-auth-resend]");
  if (!button) return;
  const remaining = Math.ceil((state.auth.resendAvailableAt - Date.now()) / 1000);
  if (remaining > 0) { button.disabled = true; button.textContent = `Resend code (${remaining}s)`; }
  else { button.disabled = false; button.textContent = "Resend code"; window.clearInterval(state.auth.resendTimer); }
}

async function resendCode() {
  try {
    if (state.auth.flowKind === "sign-up") {
      const signUp = state.auth.signUp;
      if (state.auth.signUpChannel === "phone") await signUp.preparePhoneNumberVerification({ strategy: "phone_code" });
      else await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
      startResendCooldown();
    } else if (state.auth.activeFactor) {
      await prepareAndShowCode(state.auth.activeFactor);
    }
  } catch (error) { showAuthError(error); }
}

/* Custom workspace switcher for the clinic console */
function renderClinicWorkspaceSwitch() {
  const button = $("[data-workspace-switch]");
  if (!button) return;
  if (!state.config?.signInRequired || !state.clerk?.user) { button.hidden = true; return; }
  button.hidden = false;
  button.querySelector("[data-workspace-switch-label]").textContent = state.clerk.organization?.name || "Choose workspace";
}

/* Custom header account menu */
function closeAccountMenus() {
  $$('[data-account-panel]').forEach((panel) => { panel.hidden = true; });
}

function renderAccountMenu() {
  const containers = $$('[data-account-menu]');
  const user = state.clerk?.user;
  containers.forEach((container) => {
    if (!state.config?.signInRequired || !user) { container.hidden = true; container.innerHTML = ""; return; }
    container.hidden = false;
    const name = user.fullName || user.username || user.primaryEmailAddress?.emailAddress || "Account";
    const email = user.primaryEmailAddress?.emailAddress || "";
    const orgName = state.clerk.organization?.name;
    const memberships = user.organizationMemberships || [];
    container.innerHTML = `
      <button class="account-menu-trigger" type="button" data-account-toggle aria-haspopup="true" aria-expanded="false">
        <span class="account-avatar">${escapeHtml(initials(name))}</span>
        ${orgName ? `<span class="account-org-label">${escapeHtml(orgName)}</span>` : ""}
      </button>
      <div class="account-menu-panel" data-account-panel hidden>
        <div class="account-menu-identity"><strong>${escapeHtml(name)}</strong>${email ? `<small>${escapeHtml(email)}</small>` : ""}</div>
        ${memberships.length > 1 ? '<button class="account-menu-item" type="button" data-switch-workspace>Switch workspace</button>' : ""}
        <button class="account-menu-item" type="button" data-sign-out>Sign out</button>
      </div>`;
  });
}

function hydrateIntakeForm() {
  const form = $("[data-intake-form]");
  if (!form) return;
  const draft = state.intakeDraft;
  const set = (name, value) => { if (form.elements[name] && value !== undefined && value !== null) form.elements[name].value = value; };
  set("petName", draft.petName); set("species", draft.species); set("breed", draft.breed); set("weightLbs", draft.weightLbs);
  set("ownerName", draft.ownerName); set("ownerPhone", draft.ownerPhone); set("ownerEmail", draft.ownerEmail); set("concernSummary", draft.concernSummary); set("startedWhen", draft.startedWhen);
  const urgency = form.querySelector(`[name="urgency"][value="${CSS.escape(draft.urgency || "same_day")}"]`);
  if (urgency) urgency.checked = true;
  $$('[name="redFlag"]', form).forEach((input) => { input.checked = (draft.redFlags || []).includes(input.value); });
  $$('[name="symptom"]', form).forEach((input) => { input.checked = (draft.symptoms || []).includes(input.value); });
  if (form.elements.legalConsent) form.elements.legalConsent.checked = draft.legalConsent === true;
  if (form.elements.contactConsent) form.elements.contactConsent.checked = draft.contactConsent === true;
  $("[data-location-label]").textContent = draft.position?.label || DEFAULT_POSITION.label;
  $("[data-location-detail]").textContent = draft.position?.detail || DEFAULT_POSITION.detail;
  updateSafetyCallout();
  updateConcernSpecificity();
}

function persistFormDraft() {
  const form = $("[data-intake-form]");
  if (!form) return;
  const values = new FormData(form);
  state.intakeDraft = {
    ...state.intakeDraft,
    petName: String(values.get("petName") || "").trim(),
    species: String(values.get("species") || "dog"),
    breed: String(values.get("breed") || "").trim(),
    weightLbs: Number(values.get("weightLbs")) || null,
    urgency: String(values.get("urgency") || "same_day"),
    symptoms: values.getAll("symptom").map(String),
    startedWhen: String(values.get("startedWhen") || ""),
    concernSummary: String(values.get("concernSummary") || "").trim(),
    redFlags: values.getAll("redFlag").map(String),
    ownerName: String(values.get("ownerName") || "").trim(),
    ownerPhone: String(values.get("ownerPhone") || "").trim(),
    ownerEmail: String(values.get("ownerEmail") || "").trim(),
    legalConsent: values.get("legalConsent") === "on",
    contactConsent: values.get("contactConsent") === "on"
  };
  if (state.intakeDraft.redFlags.length) state.intakeDraft.urgency = "emergency";
  writeStorage(STORAGE_KEYS.draft, state.intakeDraft);
}

function renderIntakeStep() {
  $$('[data-intake-step]').forEach((step) => {
    const active = Number(step.dataset.intakeStep) === state.intakeStep;
    step.hidden = !active;
    step.classList.toggle("is-active", active);
  });
  $("[data-intake-step-label]").textContent = `${state.intakeStep} of 2`;
  $("[data-intake-progress]").style.width = `${state.intakeStep * 50}%`;
  requestAnimationFrame(() => $("[data-intake-step]:not([hidden]) h1")?.focus?.());
}

function validateStep(step) {
  const panel = $(`[data-intake-step="${step}"]`);
  const form = $("[data-intake-form]");
  const concern = form?.elements.concernSummary;
  if (step === 1 && concern) {
    const values = new FormData(form);
    const assessment = assessConcern(values.get("concernSummary"), values.getAll("symptom").map(String), values.get("startedWhen"));
    concern.setCustomValidity(assessment.ok ? "" : assessment.message);
  }
  const fields = $$('input, select, textarea', panel).filter((field) => field.required && !field.checkValidity());
  $$('.field-error', panel).forEach((error) => error.remove());
  if (!fields.length) return true;
  const first = fields[0];
  const error = document.createElement("p");
  error.className = "field-error";
  error.textContent = first.validationMessage || "Complete this field to continue.";
  first.closest("label, fieldset")?.append(error);
  first.focus();
  return false;
}

function updateConcernSpecificity() {
  const form = $("[data-intake-form]");
  const meter = $("[data-specificity-meter]");
  if (!form || !meter) return;
  const values = new FormData(form);
  const assessment = assessConcern(values.get("concernSummary"), values.getAll("symptom").map(String), values.get("startedWhen"));
  meter.classList.toggle("is-ready", assessment.ok);
  meter.querySelector("span").textContent = assessment.message;
  meter.querySelector("i").style.width = assessment.ok ? `${Math.min(100, (assessment.strength || 4) * 18)}%` : "26%";
  form.elements.concernSummary?.setCustomValidity(assessment.ok ? "" : assessment.message);
}

function updateSafetyCallout() {
  const form = $("[data-intake-form]");
  if (!form) return;
  const hasFlag = $$('[name="redFlag"]', form).some((input) => input.checked);
  const emergency = form.elements.urgency?.value === "emergency";
  $("[data-safety-callout]").hidden = !(hasFlag || emergency);
}

async function useLocation() {
  if (!navigator.geolocation) return showToast("Location services are not available in this browser.");
  showToast("Finding your location…");
  navigator.geolocation.getCurrentPosition(
    (position) => {
      state.intakeDraft.position = {
        latitude: Number(position.coords.latitude.toFixed(6)),
        longitude: Number(position.coords.longitude.toFixed(6)),
        label: "Current location",
        detail: `Accurate to about ${Math.round(position.coords.accuracy)} meters`
      };
      writeStorage(STORAGE_KEYS.draft, state.intakeDraft);
      if (state.route === "home") setRoute("find");
      else hydrateIntakeForm();
      showToast("Location updated.");
    },
    () => showToast("We could not access your location. You can continue with the demonstration area."),
    { enableHighAccuracy: true, timeout: 9000, maximumAge: 60_000 }
  );
}

function careType() {
  return state.intakeDraft.urgency === "emergency" || state.intakeDraft.redFlags?.length ? "emergency" : "urgent";
}

async function loadLocations() {
  const list = $("[data-hospital-list]");
  list.innerHTML = '<div class="loading-state"><span></span><strong>Checking nearby capacity…</strong></div>';
  const position = state.intakeDraft.position || DEFAULT_POSITION;
  const params = new URLSearchParams({ lat: position.latitude, lng: position.longitude, radius: "50", species: state.intakeDraft.species || "dog", care: careType() });
  try {
    const data = await api(`/api/locations?${params}`);
    state.locations = data.locations;
    renderLocations();
  } catch (error) {
    list.innerHTML = `<div class="empty-state"><strong>Availability could not be loaded.</strong><p>${escapeHtml(error.message)}</p><button class="button button-quiet" type="button" data-refresh-results>Try again</button></div>`;
  }
  $("[data-results-context]").textContent = `Searching near ${position.label} for ${state.intakeDraft.petName || "your pet"}.`;
  $("[data-summary-pet]").textContent = `${state.intakeDraft.petName || "Pet"} · ${humanize(state.intakeDraft.species)}`;
  $("[data-summary-urgency]").textContent = humanize(state.intakeDraft.urgency);
  $("[data-summary-area]").textContent = position.label;
}

function sortLocations(locations) {
  const sort = $("[data-sort-results]")?.value || "recommended";
  const copy = [...locations];
  if (sort === "distance") return copy.sort((a, b) => (a.distanceMiles ?? 999) - (b.distanceMiles ?? 999));
  if (sort === "wait") return copy.sort((a, b) => (a.availability.stableWaitMin ?? 9999) - (b.availability.stableWaitMin ?? 9999));
  if (sort === "freshness") return copy.sort((a, b) => Date.parse(b.availability.reportedAt || 0) - Date.parse(a.availability.reportedAt || 0));
  const rank = { available: 0, limited: 1, confirm_first: 2, critical_only: 3, unverified: 4, diverting: 5, closed: 6 };
  return copy.sort((a, b) => (rank[a.availability.intakeStatus] ?? 9) - (rank[b.availability.intakeStatus] ?? 9) || (a.distanceMiles ?? 999) - (b.distanceMiles ?? 999));
}

function waitText(location) {
  const availability = location.availability;
  if (availability.stableWaitMin === null && availability.stableWaitMax === null) return "Not reported";
  if (availability.stableWaitMin === availability.stableWaitMax) return `${availability.stableWaitMin} min`;
  return `${availability.stableWaitMin ?? 0}–${availability.stableWaitMax ?? "?"} min`;
}

function renderLocations() {
  const list = $("[data-hospital-list]");
  const locations = sortLocations(state.locations);
  if (!locations.length) {
    list.innerHTML = '<div class="empty-state"><strong>No matching hospital is reporting nearby.</strong><p>Increase the search area or call the nearest emergency hospital if your pet may be in danger.</p></div>';
    return;
  }
  const eligibleCount = locations.filter((location) => careType() === "emergency" || !["closed", "diverting", "critical_only"].includes(location.availability.intakeStatus)).slice(0, 30).length;
  const launch = $("[data-start-search]");
  if (launch) {
    launch.disabled = eligibleCount === 0;
    launch.textContent = eligibleCount ? `Ask ${eligibleCount} nearby clinic${eligibleCount === 1 ? "" : "s"}` : "No clinics available to ask";
  }
  const launchNote = $("[data-search-launch-note]");
  if (launchNote) launchNote.textContent = `Tími will contact ${eligibleCount} matching clinic${eligibleCount === 1 ? "" : "s"} and show up to five active offers. Nothing is booked until you choose.`;
  renderResultsMap();
  list.innerHTML = locations.map((location) => {
    const status = location.availability.intakeStatus;
    const disabled = ["closed", "diverting"].includes(status) && careType() !== "emergency";
    const capabilities = location.capabilities.slice(0, 4).map((capability) => `<span>${escapeHtml(humanize(capability))}</span>`).join("");
    return `<article class="hospital-card ${location.kind === "emergency" ? "is-emergency" : ""}">
      <div class="hospital-avatar">${escapeHtml(initials(location.name))}</div>
      <div class="hospital-main"><span class="hospital-kind">${escapeHtml(humanize(location.kind))} care</span><h2>${escapeHtml(location.name)}</h2>
        <div class="hospital-meta"><span>${location.distanceMiles ?? "—"} mi away</span><span>${escapeHtml(location.open24Hours ? "Open 24 hours" : "Open now")}</span><span>${escapeHtml(location.phone)}</span></div>
        <div class="hospital-capabilities">${capabilities}</div>
        <div class="freshness-row"><strong>${escapeHtml(humanize(location.availability.source))}</strong><span>Verified ${escapeHtml(formatRelativeTime(location.availability.reportedAt))}</span><span class="confidence">${escapeHtml(humanize(location.availability.confidence))} confidence</span></div>
      </div>
      <div class="capacity-box"><div class="capacity-label"><i class="signal ${escapeHtml(status)}"></i>${escapeHtml(location.availability.label)}</div><div class="wait-range"><small>REPORTED STABLE-PATIENT WAIT</small><strong>${escapeHtml(waitText(location))}</strong></div><div class="card-actions"><button class="button button-quiet" type="button" data-view-location="${escapeHtml(location.id)}">Details</button><span class="candidate-state">${disabled ? "Not contacted" : "Included in search"}</span></div></div>
    </article>`;
  }).join("");
}

function openHospitalDialog(locationId, requestMode = false) {
  const location = state.locations.find((candidate) => candidate.id === locationId);
  if (!location) return;
  state.selectedLocation = location;
  const policy = location.policy || {};
  const content = $("[data-hospital-dialog-content]");
  content.innerHTML = `<p class="eyebrow coral">${escapeHtml(humanize(location.kind))} CARE</p><h2 id="hospital-dialog-title">${escapeHtml(location.name)}</h2><p class="address">${escapeHtml(location.address)} · ${escapeHtml(location.phone)}</p>
    <div class="dialog-capacity"><div><small>CURRENT STATUS</small><strong>${escapeHtml(location.availability.label)}</strong></div><div><small>STABLE-PATIENT WAIT</small><strong>${escapeHtml(waitText(location))}</strong></div><div><small>VERIFIED</small><strong>${escapeHtml(formatRelativeTime(location.availability.reportedAt))}</strong></div><div><small>SOURCE</small><strong>${escapeHtml(humanize(location.availability.source))} · ${escapeHtml(location.availability.confidence)}</strong></div></div>
    <p class="dialog-note">${escapeHtml(location.availability.note || "Hospital staff determine clinical priority after intake. Your actual wait can change when critical patients arrive.")}</p>
    <div class="deposit-box"><strong>${policy.depositRequired ? `${formatMoney(policy.depositAmountCents)} arrival deposit after acceptance` : "No Tími deposit required"}</strong><small>${policy.depositRequired ? `Policy ${escapeHtml(policy.version || "current")}: the full deposit is credited to the clinic invoice. Refund and no-show terms are shown again before payment.` : "The clinic will handle veterinary payment directly."}</small></div>
    <p class="dialog-legal">If included in a search, this clinic receives the structured intake under the <a href="#legal?section=terms">Terms</a> and <a href="#legal?section=safety">Veterinary Safety Notice</a>. No clinic is confirmed until you choose an offer.</p>
    <div class="dialog-actions"><a class="button button-quiet" href="tel:${escapeHtml(location.phone.replace(/[^0-9+]/g, ""))}">Call hospital</a><button class="button button-primary" type="button" data-close-dialog>Done</button></div>`;
  const dialog = $("[data-hospital-dialog]");
  dialog.showModal();
  document.body.classList.add("dialog-open");
}

async function startCareSearch() {
  const draft = state.intakeDraft;
  const candidates = sortLocations(state.locations)
    .filter((location) => careType() === "emergency" || !["closed", "diverting", "critical_only"].includes(location.availability.intakeStatus))
    .slice(0, 30);
  if (!candidates.length) return showToast("No matching clinic can be contacted from this search.");
  const button = $("[data-start-search]");
  if (button) { button.disabled = true; button.textContent = "Contacting clinics…"; }
  try {
    const data = await api("/api/searches", {
      method: "POST",
      body: JSON.stringify({
        locationIds: candidates.map((location) => location.id),
        targetLimit: 30,
        radiusMiles: 50,
        pet: { name: draft.petName, species: draft.species, breed: draft.breed, weightLbs: draft.weightLbs },
        owner: { name: draft.ownerName, phone: draft.ownerPhone, email: draft.ownerEmail },
        concernCategory: careType() === "emergency" ? "possible_emergency" : "illness_or_injury",
        concernSummary: draft.concernSummary,
        symptoms: draft.symptoms,
        startedWhen: draft.startedWhen,
        urgency: draft.urgency,
        redFlags: draft.redFlags,
        customerLatitude: draft.position.latitude,
        customerLongitude: draft.position.longitude,
        consentToContact: draft.contactConsent === true,
        legalConsent: draft.legalConsent === true,
        legalVersion: state.config?.legalVersion || "2026-08-22"
      })
    });
    state.currentSearch = data.search;
    state.currentIntake = null;
    writeStorage(STORAGE_KEYS.search, state.currentSearch);
    writeStorage(STORAGE_KEYS.intake, null);
    setRoute("tracker");
  } catch (error) {
    showToast(error.message);
    if (button) { button.disabled = false; button.textContent = "Ask nearby clinics"; }
  }
}

async function submitIntake(locationId) {
  const location = state.locations.find((candidate) => candidate.id === locationId);
  if (!location) return;
  const draft = state.intakeDraft;
  const policyAck = $("[data-policy-ack]");
  if (policyAck && !policyAck.checked) { policyAck.focus(); return showToast("Acknowledge the clinic and capacity terms before sending."); }
  const button = $(`[data-confirm-request="${CSS.escape(locationId)}"]`);
  if (button) { button.disabled = true; button.textContent = "Sending…"; }
  try {
    const data = await api("/api/intakes", {
      method: "POST",
      body: JSON.stringify({
        locationId,
        pet: { name: draft.petName, species: draft.species, breed: draft.breed, weightLbs: draft.weightLbs },
        owner: { name: draft.ownerName, phone: draft.ownerPhone, email: draft.ownerEmail },
        concernCategory: careType() === "emergency" ? "possible_emergency" : "illness_or_injury",
        concernSummary: draft.concernSummary,
        symptoms: draft.symptoms,
        startedWhen: draft.startedWhen,
        urgency: draft.urgency,
        redFlags: draft.redFlags,
        customerLatitude: draft.position.latitude,
        customerLongitude: draft.position.longitude,
        travelMinutes: Math.max(5, Math.round((location.distanceMiles || 2) * 4)),
        consentToContact: draft.contactConsent === true,
        legalConsent: draft.legalConsent === true,
        legalVersion: state.config?.legalVersion || "2026-08-22"
      })
    });
    state.currentIntake = { ...data.intake, location: data.location };
    writeStorage(STORAGE_KEYS.intake, state.currentIntake);
    $("[data-hospital-dialog]").close();
    document.body.classList.remove("dialog-open");
    setRoute("tracker");
  } catch (error) {
    showToast(error.message);
    if (button) { button.disabled = false; button.textContent = "Send intake request"; }
  }
}

async function refreshCurrentIntake() {
  if (!state.currentIntake?.id && state.currentSearch?.id) {
    await refreshCareSearch();
    return;
  }
  if (!state.currentIntake?.id) {
    $("[data-tracker-title]").textContent = "No active intake request.";
    $("[data-tracker-lede]").textContent = "Return to results to ask a hospital to accept your pet.";
    return;
  }
  if (state.currentIntake.demo || state.currentIntake.id.startsWith("demo_")) {
    const elapsed = Date.now() - timestampMs(state.currentIntake.requestedAt);
    if (state.currentIntake.status === "pending" && elapsed >= 5_000) {
      const now = new Date().toISOString();
      const arrivalMinutes = state.currentIntake.location?.arrivalWindowMinutes || 20;
      state.currentIntake = {
        ...state.currentIntake,
        status: "accepted",
        decisionAt: now,
        arrivalBy: new Date(Date.now() + arrivalMinutes * 60_000).toISOString(),
        clinicNote: "Demo confirmation: the veterinary team reviewed the request and is ready for your arrival.",
        updatedAt: now
      };
      writeStorage(STORAGE_KEYS.intake, state.currentIntake);
      showToast("The veterinary team accepted the demonstration intake.");
    }
    renderTracker();
    return;
  }
  try {
    const data = await api(`/api/intakes/${encodeURIComponent(state.currentIntake.id)}`);
    state.currentIntake = { ...state.currentIntake, ...data.intake };
    writeStorage(STORAGE_KEYS.intake, state.currentIntake);
  } catch (error) {
    if (error.code !== "INTAKE_NOT_FOUND") showToast(error.message);
  }
  renderTracker();
}

async function refreshCareSearch() {
  if (!state.currentSearch?.id) return;
  if (!state.currentSearch.demo && !state.currentSearch.id.startsWith("demo_search_")) {
    try {
      const data = await api(`/api/searches/${encodeURIComponent(state.currentSearch.id)}`);
      state.currentSearch = data.search;
      writeStorage(STORAGE_KEYS.search, state.currentSearch);
      if (state.currentSearch.selectedIntakeId) {
        const intakeData = await api(`/api/intakes/${encodeURIComponent(state.currentSearch.selectedIntakeId)}`);
        const selectedOffer = state.currentSearch.offers?.find((offer) => offer.id === state.currentSearch.selectedOfferId);
        state.currentIntake = { ...intakeData.intake, location: selectedOffer?.location };
        writeStorage(STORAGE_KEYS.intake, state.currentIntake);
        renderTracker();
        return;
      }
    } catch (error) {
      if (error.code !== "SEARCH_NOT_FOUND") showToast(error.message);
    }
  }
  renderCareSearch();
}

function offerWaitText(offer) {
  if (offer.waitMin === null && offer.waitMax === null) return "Not supplied";
  if (offer.waitMin === offer.waitMax) return `${offer.waitMin} min`;
  return `${offer.waitMin ?? 0}–${offer.waitMax ?? "?"} min`;
}

function offerTypeLabel(offer) {
  return ({
    available_now: "Available now",
    available_at: offer.availableAt ? `Available ${formatClock(offer.availableAt)}` : "Available at stated time",
    emergency_intake: "Emergency intake open"
  })[offer.responseType] || "Availability offered";
}

function renderCareSearch() {
  const search = state.currentSearch;
  if (!search) return;
  $("[data-search-stage]").hidden = false;
  $("[data-confirmed-stage]").hidden = true;
  const offers = Array.isArray(search.offers) ? search.offers.filter((offer) => offer.status === "active") : [];
  const progress = search.progress || { contacted: search.targetLimit || 0, awaiting: 0, declined: 0, offers: offers.length };
  $("[data-offer-count]").textContent = `${offers.length} of ${search.maxOffers || 5} offers`;
  $("[data-search-progress]").textContent = offers.length >= (search.maxOffers || 5) ? "Five clinics can help" : `Contacting ${progress.contacted || 0} clinics`;
  $("[data-search-progress-detail]").textContent = search.status === "expired"
    ? "The response window ended. Start a new search for current capacity."
    : `${progress.awaiting || 0} awaiting response · ${progress.declined || 0} unavailable`;
  $("[data-tracker-eyebrow]").textContent = offers.length ? "AVAILABILITY OFFERS" : "SEARCH IN PROGRESS";
  $("[data-tracker-title]").textContent = offers.length
    ? `${search.pet?.name || "Your pet"} has ${offers.length} option${offers.length === 1 ? "" : "s"}.`
    : "Asking nearby clinics now.";
  $("[data-tracker-lede]").textContent = offers.length
    ? "Compare the live offers and choose the clinic that works best. Tími will release every offer you do not select."
    : `Offers will be collected until ${formatClock(search.collectionExpiresAt || search.searchExpiresAt)} or until five clinics respond.`;
  const list = $("[data-offer-list]");
  if (!offers.length) {
    list.innerHTML = `<div class="empty-state offer-waiting"><span class="offer-spinner"></span><strong>${search.status === "expired" ? "No active offers remain" : "Waiting for clinic responses"}</strong><p>${search.status === "expired" ? "Capacity changes quickly. Please start a new search." : "You may leave this page open; responses update automatically."}</p></div>`;
    return;
  }
  list.innerHTML = offers.map((offer) => {
    const clinic = offer.location || {};
    const emergency = offer.responseType === "emergency_intake";
    const canSelect = ["collecting", "offers_ready"].includes(search.status) && timestampMs(offer.expiresAt) > Date.now();
    return `<article class="offer-card ${emergency ? "is-emergency" : ""}">
      <div class="offer-card-heading"><div class="hospital-avatar">${escapeHtml(initials(clinic.name || "Clinic"))}</div><div><span class="hospital-kind">${escapeHtml(offerTypeLabel(offer))}</span><h2>${escapeHtml(clinic.name || "Veterinary clinic")}</h2><p>${escapeHtml(clinic.address || "Address available on confirmation")}</p></div></div>
      <dl class="offer-facts"><div><dt>Travel</dt><dd>${clinic.distanceMiles ?? "—"} mi</dd></div><div><dt>${emergency ? "Estimated wait" : "Reported wait"}</dt><dd>${escapeHtml(offerWaitText(offer))}</dd></div><div><dt>Deposit</dt><dd>${offer.depositAmountCents ? formatMoney(offer.depositAmountCents) : "None"}</dd></div><div><dt>Exam fee</dt><dd>${offer.baseExamFeeCents ? `From ${formatMoney(offer.baseExamFeeCents)}` : "Not supplied"}</dd></div></dl>
      <p class="offer-note">${escapeHtml(offer.clinicNote || (emergency ? "Open for emergency intake; treatment order is determined by clinical triage." : "The clinic reports capacity for this arrival window."))}</p>
      <div class="offer-card-actions"><small>Held until ${escapeHtml(formatClock(offer.expiresAt))}</small><button class="button button-primary" type="button" data-select-offer="${escapeHtml(offer.id)}" ${canSelect ? "" : "disabled"}>Choose this clinic</button></div>
    </article>`;
  }).join("");
}

async function selectCareOffer(offerId) {
  const search = state.currentSearch;
  const offer = search?.offers?.find((candidate) => candidate.id === offerId);
  if (!search || !offer) return;
  const button = $(`[data-select-offer="${CSS.escape(offerId)}"]`);
  if (button) { button.disabled = true; button.textContent = "Confirming…"; }
  try {
    let data;
    if (search.demo || search.id.startsWith("demo_search_")) {
      const now = new Date().toISOString();
      data = {
        intake: {
          id: `demo_intake_${Date.now()}`,
          publicCode: search.publicCode,
          locationId: offer.locationId,
          tenantId: offer.tenantId,
          pet: search.pet,
          owner: search.owner,
          concernCategory: search.concernCategory,
          concernSummary: search.concernSummary,
          urgency: search.urgency,
          redFlags: search.redFlags,
          status: "accepted",
          clinicNote: offer.clinicNote,
          requestedAt: search.requestedAt,
          decisionAt: now,
          requestExpiresAt: offer.expiresAt,
          arrivalBy: offer.arrivalBy,
          policy: offer.policy,
          depositAmountCents: offer.depositAmountCents,
          paymentStatus: offer.depositAmountCents ? "pending" : "not_required",
          sourceSearchId: search.id,
          selectedOfferId: offer.id,
          demo: true
        },
        location: offer.location
      };
      state.currentSearch = { ...search, status: "selected", selectedOfferId: offer.id, selectedIntakeId: data.intake.id, offers: search.offers.map((item) => ({ ...item, status: item.id === offer.id ? "selected" : "released" })) };
    } else {
      data = await api(`/api/searches/${encodeURIComponent(search.id)}/select-offer`, { method: "POST", body: JSON.stringify({ offerId }) });
      state.currentSearch = data.search;
    }
    state.currentIntake = { ...data.intake, location: data.location || offer.location };
    writeStorage(STORAGE_KEYS.search, state.currentSearch);
    writeStorage(STORAGE_KEYS.intake, state.currentIntake);
    showToast("Clinic selected. The other offers were released.");
    renderTracker();
  } catch (error) {
    showToast(error.message);
    if (button) { button.disabled = false; button.textContent = "Choose this clinic"; }
  }
}

async function cancelCareSearch() {
  const search = state.currentSearch;
  if (!search) return;
  try {
    if (search.demo || search.id.startsWith("demo_search_")) state.currentSearch = { ...search, status: "cancelled", offers: [] };
    else state.currentSearch = (await api(`/api/searches/${encodeURIComponent(search.id)}/status`, { method: "POST", body: JSON.stringify({ status: "cancelled" }) })).search;
    writeStorage(STORAGE_KEYS.search, state.currentSearch);
    renderCareSearch();
    showToast("The search was cancelled and clinic offers were released.");
  } catch (error) { showToast(error.message); }
}

function renderTracker() {
  const intake = state.currentIntake;
  if (!intake) return;
  $("[data-search-stage]").hidden = true;
  $("[data-confirmed-stage]").hidden = false;
  renderTrackerMap();
  const location = intake.location || state.locations.find((candidate) => candidate.id === intake.locationId) || {};
  $("[data-tracker-hospital]").textContent = location.name || "Veterinary hospital";
  $("[data-tracker-address]").textContent = location.address || "Location available after confirmation";
  $("[data-tracker-initials]").textContent = initials(location.name || "Veterinary hospital");
  $("[data-tracker-phone]").href = `tel:${String(location.phone || "").replace(/[^0-9+]/g, "")}`;
  $("[data-request-time]").textContent = `Sent ${formatRelativeTime(intake.requestedAt)}`;
  const decision = $("[data-timeline-decision]");
  const arrival = $("[data-timeline-arrival]");
  const startTrip = $("[data-start-trip]");
  const feedback = $("[data-arrival-feedback]");
  const cancel = $("[data-cancel-intake]");
  startTrip.hidden = true; feedback.hidden = true; cancel.hidden = false;
  decision.classList.remove("complete"); arrival.classList.remove("complete");

  if (intake.status === "pending") {
    $("[data-tracker-eyebrow]").textContent = "REQUEST SENT";
    $("[data-tracker-title]").textContent = "Asking the veterinary team now.";
    $("[data-tracker-lede]").textContent = `This request expires at ${formatClock(intake.requestExpiresAt)} if the clinic cannot respond.`;
  } else if (["accepted", "en_route", "arrived", "triaged", "seen", "completed"].includes(intake.status)) {
    decision.classList.add("complete"); arrival.classList.add("complete");
    decision.querySelector("span").textContent = "✓"; decision.querySelector("small").textContent = "Clinic accepted the intake";
    arrival.querySelector("span").textContent = "✓"; arrival.querySelector("small").textContent = intake.arrivalBy ? `Please arrive by ${formatClock(intake.arrivalBy)}` : "Arrival window confirmed";
    $("[data-tracker-eyebrow]").textContent = intake.status === "accepted" ? "ACCEPTED" : humanize(intake.status);
    $("[data-tracker-title]").textContent = `${intake.pet?.name || "Your pet"} has a place to go.`;
    $("[data-tracker-lede]").textContent = intake.clinicNote || `Arrive by ${formatClock(intake.arrivalBy)}. Hospital staff will determine clinical priority on arrival.`;
    startTrip.hidden = !["accepted"].includes(intake.status);
    feedback.hidden = !["en_route", "arrived", "triaged", "seen"].includes(intake.status);
    cancel.hidden = ["arrived", "triaged", "seen", "completed"].includes(intake.status);
    maybePresentPayment(intake);
  } else {
    $("[data-tracker-eyebrow]").textContent = humanize(intake.status);
    $("[data-tracker-title]").textContent = intake.status === "declined" ? "This clinic cannot safely add another patient." : "This intake is no longer active.";
    $("[data-tracker-lede]").textContent = intake.status === "declined" ? "Return to the live results and Tími will help you try the next appropriate hospital." : "Search again to obtain a fresh capacity confirmation.";
    cancel.hidden = true;
  }
}

function maybePresentPayment(intake) {
  const paymentButton = $("[data-pay-deposit]");
  const paymentNote = $("[data-payment-note]");
  if (!paymentButton || !paymentNote) return;
  const required = intake.policy?.depositRequired && intake.depositAmountCents > 0;
  paymentButton.hidden = !required || intake.paymentStatus === "paid";
  paymentButton.textContent = required ? `Pay ${formatMoney(intake.depositAmountCents)} deposit` : "";
  paymentNote.hidden = !required;
  paymentNote.textContent = intake.paymentStatus === "paid" ? "Deposit paid and credited to the clinic invoice." : "The clinic requires an arrival deposit before departure.";
}

async function updateIntakeStatus(status) {
  if (!state.currentIntake?.id) return;
  if (state.currentIntake.demo || state.currentIntake.id.startsWith("demo_")) {
    state.currentIntake = { ...state.currentIntake, status, updatedAt: new Date().toISOString() };
    writeStorage(STORAGE_KEYS.intake, state.currentIntake);
    renderTracker();
    return;
  }
  try {
    const data = await api(`/api/intakes/${encodeURIComponent(state.currentIntake.id)}/status`, { method: "POST", body: JSON.stringify({ status }) });
    state.currentIntake = { ...state.currentIntake, ...data.intake };
    writeStorage(STORAGE_KEYS.intake, state.currentIntake);
    renderTracker();
  } catch (error) { showToast(error.message); }
}

async function recordObservation(milestone) {
  const intake = state.currentIntake;
  if (!intake) return;
  if (intake.demo || intake.id.startsWith("demo_")) {
    if (["arrived", "triaged", "seen"].includes(milestone)) {
      state.currentIntake = { ...intake, status: milestone, updatedAt: new Date().toISOString() };
      writeStorage(STORAGE_KEYS.intake, state.currentIntake);
      renderTracker();
    }
    showToast(`Thank you. ${humanize(milestone)} was recorded in this demo.`);
    return;
  }
  try {
    await api("/api/observations", { method: "POST", body: JSON.stringify({ intakeId: intake.id, locationId: intake.locationId, milestone }) });
    await refreshCurrentIntake();
    showToast(`Thank you. ${humanize(milestone)} was recorded.`);
  } catch (error) { showToast(error.message); }
}

async function startPayment() {
  const intake = state.currentIntake;
  if (!intake) return;
  const policy = intake.policy || {};
  const clinic = intake.location?.name || "the selected clinic";
  $("[data-payment-disclosure]").textContent = `${clinic} requires ${formatMoney(intake.depositAmountCents)}. The full amount is credited to its invoice. Free cancellation: ${policy.freeCancelMinutes ?? 0} minutes; later refund and no-show handling follow clinic policy ${policy.version || "current"}.`;
  $("[data-payment-policy-ack]").textContent = `I authorize the ${formatMoney(intake.depositAmountCents)} deposit and agree to clinic policy ${policy.version || "current"}, including its cancellation, refund, and no-show terms.`;
  const form = $("[data-payment-form]");
  state.stripeElements = null;
  $("[data-payment-element]").replaceChildren();
  form.reset();
  form.querySelector("button[type='submit']").textContent = intake.demo || intake.id.startsWith("demo_") ? "Complete demo deposit" : "Continue to secure payment";
  const dialog = $("[data-payment-dialog]");
  dialog.showModal(); document.body.classList.add("dialog-open");
}

async function loadStripe() {
  if (window.Stripe) return window.Stripe;
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://js.stripe.com/v3";
    script.onload = resolve;
    script.onerror = reject;
    document.head.append(script);
  });
  return window.Stripe;
}

async function openStripePayment(clientSecret) {
  if (!state.config.stripePublishableKey) throw new Error("Stripe publishable key is not configured.");
  const Stripe = await loadStripe();
  state.stripe = Stripe(state.config.stripePublishableKey);
  state.stripeElements = state.stripe.elements({ clientSecret, appearance: { theme: "stripe", variables: { colorPrimary: "#2357d9", borderRadius: "10px" } } });
  const dialog = $("[data-payment-dialog]");
  if (!dialog.open) dialog.showModal();
  document.body.classList.add("dialog-open");
  const paymentElement = state.stripeElements.create("payment");
  paymentElement.mount("[data-payment-element]");
}

async function confirmStripePayment(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type='submit']");
  button.disabled = true; button.textContent = "Processing…";
  const intake = state.currentIntake;
  if (intake.demo || intake.id.startsWith("demo_")) {
    state.currentIntake = { ...intake, paymentStatus: "paid", paymentProviderId: `demo_payment_${Date.now()}`, updatedAt: new Date().toISOString() };
    writeStorage(STORAGE_KEYS.intake, state.currentIntake);
    $("[data-payment-dialog]").close(); document.body.classList.remove("dialog-open");
    renderTracker();
    button.disabled = false; button.textContent = "Complete demo deposit";
    return showToast("Demonstration deposit completed. No card was charged.");
  }
  if (!state.stripeElements) {
    try {
      const data = await api(`/api/intakes/${encodeURIComponent(intake.id)}/payment`, { method: "POST" });
      state.currentIntake = { ...state.currentIntake, ...data.intake };
      if (["none", "paid", "demo"].includes(data.mode)) {
        writeStorage(STORAGE_KEYS.intake, state.currentIntake); renderTracker(); $("[data-payment-dialog]").close();
        return showToast(data.mode === "demo" ? "Demonstration deposit completed." : "Deposit status updated.");
      }
      await openStripePayment(data.clientSecret);
      button.disabled = false; button.textContent = `Pay ${formatMoney(intake.depositAmountCents)} deposit`;
      return;
    } catch (error) { showToast(error.message); button.disabled = false; button.textContent = "Continue to secure payment"; return; }
  }
  const result = await state.stripe.confirmPayment({ elements: state.stripeElements, confirmParams: { return_url: `${location.origin}/#tracker` }, redirect: "if_required" });
  if (result.error) { showToast(result.error.message); button.disabled = false; button.textContent = "Pay deposit"; return; }
  $("[data-payment-dialog]").close(); document.body.classList.remove("dialog-open");
  await api(`/api/intakes/${encodeURIComponent(state.currentIntake.id)}/payment-status`);
  await refreshCurrentIntake();
}

async function loadClinicDashboard() {
  try {
    const data = await api("/api/clinic/dashboard", { clinic: true });
    if (state.config?.database === "fixtures") {
      const availability = readStorage(STORAGE_KEYS.clinicAvailability, null);
      if (availability?.expiresAt && timestampMs(availability.expiresAt) > Date.now()) {
        data.location.availability = availability;
      }
      const decisions = readStorage(STORAGE_KEYS.clinicDecisions, {});
      data.requests = data.requests.map((request) => decisions[request.id] ? { ...request, ...decisions[request.id] } : request);
      data.metrics = clinicMetrics(data.requests);
    }
    renderClinicDashboard(data);
  } catch (error) {
    $("[data-request-list]").innerHTML = `<div class="empty-state"><strong>Clinic data could not be loaded.</strong><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function renderClinicDashboard(data) {
  state.clinicData = data;
  const { location, requests, metrics } = data;
  announceNewClinicRequests(requests);
  $("[data-clinic-name]").textContent = location.name;
  $("[data-clinic-status]").textContent = location.availability.label;
  $("[data-clinic-freshness]").textContent = `Confirmed ${formatRelativeTime(location.availability.reportedAt)} · expires ${formatClock(location.availability.expiresAt)}`;
  const signal = $("[data-clinic-signal]");
  signal.className = `large-signal ${location.availability.intakeStatus}`;
  const form = $("[data-availability-form]");
  const statusRadio = form.querySelector(`[name="intakeStatus"][value="${CSS.escape(location.availability.intakeStatus)}"]`);
  if (statusRadio) statusRadio.checked = true;
  if (location.availability.stableWaitMin !== null) form.elements.stableWaitMin.value = location.availability.stableWaitMin;
  if (location.availability.stableWaitMax !== null) form.elements.stableWaitMax.value = location.availability.stableWaitMax;
  if (location.availability.capacityCount !== null) form.elements.capacityCount.value = location.availability.capacityCount;
  form.elements.acceptsCritical.checked = location.availability.acceptsCritical;
  form.elements.note.value = location.availability.note || "";
  $("[data-metric-pending]").textContent = metrics.pending;
  $("[data-metric-active]").textContent = metrics.activeArrivals;
  $("[data-metric-completed]").textContent = metrics.completedToday;
  $("[data-metric-declined]").textContent = metrics.declinedToday;
  $("[data-request-count]").textContent = `${metrics.pending} request${metrics.pending === 1 ? "" : "s"}`;
  $("[data-ops-source]").textContent = humanize(location.availability.source);
  $("[data-ops-confidence]").textContent = humanize(location.availability.confidence);
  $("[data-ops-wait]").textContent = waitText(location);
  $("[data-ops-critical]").textContent = location.availability.acceptsCritical ? "Accepting" : "Not accepting";
  const policy = location.policy || {};
  $("[data-policy-deposit]").textContent = policy.depositRequired ? formatMoney(policy.depositAmountCents) : "None";
  $("[data-policy-cancel]").textContent = `${policy.freeCancelMinutes || 0} min`;
  $("[data-policy-completed]").textContent = formatMoney(policy.completedPlatformFeeCents);
  $("[data-policy-noshow]").textContent = formatMoney(policy.noShowPlatformFeeCents);
  renderClinicRequests(requests);
}

function clinicMetrics(requests) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    pending: requests.filter((item) => item.status === "pending").length,
    activeArrivals: requests.filter((item) => ["accepted", "en_route", "arrived", "triaged"].includes(item.status)).length,
    completedToday: requests.filter((item) => item.status === "completed" && item.updatedAt?.startsWith(today)).length,
    declinedToday: requests.filter((item) => item.status === "declined" && item.updatedAt?.startsWith(today)).length
  };
}

function announceNewClinicRequests(requests) {
  const pending = requests.filter((intake) => intake.status === "pending");
  if (state.clinicInitialized && "Notification" in window && Notification.permission === "granted") {
    pending.filter((intake) => !state.knownClinicRequests.has(intake.id)).forEach((intake) => {
      new Notification(`New ${humanize(intake.urgency)} intake for ${intake.pet.name}`, {
        body: intake.concernSummary,
        icon: "/assets/icons/icon.svg",
        tag: intake.id
      });
    });
  }
  pending.forEach((intake) => state.knownClinicRequests.add(intake.id));
  state.clinicInitialized = true;
}

async function enableClinicAlerts() {
  if (!("Notification" in window)) return showToast("This browser does not support desktop alerts.");
  const permission = await Notification.requestPermission();
  showToast(permission === "granted" ? "Clinic intake alerts are enabled." : "Notification permission was not granted.");
}

function renderClinicRequests(requests) {
  const list = $("[data-request-list]");
  if (!requests.length) {
    list.innerHTML = '<div class="empty-state"><strong>No requests waiting.</strong><p>New requests appear here and can be accepted in one tap.</p></div>';
    return;
  }
  list.innerHTML = requests.slice(0, 12).map((intake) => `<article class="request-card"><span class="request-urgency">${escapeHtml(intake.urgency === "emergency" ? "ER" : "NOW")}</span><div><h3>${escapeHtml(intake.pet.name)} · ${escapeHtml(humanize(intake.species || intake.pet.species))}</h3><p>${escapeHtml(intake.concernSummary)}</p><small>${escapeHtml(intake.owner.name)} · ${escapeHtml(intake.travelMinutes ? `${intake.travelMinutes} min away` : "travel time unknown")} · ${escapeHtml(intake.searchTarget ? "Multi-clinic search" : humanize(intake.status))}</small></div>${intake.status === "pending" ? `<button type="button" data-review-intake="${escapeHtml(intake.id)}" data-pet-name="${escapeHtml(intake.pet.name)}" data-search-target="${intake.searchTarget ? "true" : "false"}">Review</button>` : `<span class="hospital-kind">${escapeHtml(humanize(intake.status))}</span>`}</article>`).join("");
}

async function publishAvailability(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const button = form.querySelector("button[type='submit']");
  button.disabled = true; button.textContent = "Publishing…";
  try {
    const data = await api("/api/clinic/availability", { clinic: true, method: "POST", body: JSON.stringify({
      intakeStatus: values.get("intakeStatus"),
      stableWaitMin: Number(values.get("stableWaitMin")),
      stableWaitMax: Number(values.get("stableWaitMax")),
      capacityCount: Number(values.get("capacityCount")),
      ttlMinutes: Number(values.get("ttlMinutes")),
      acceptsCritical: values.get("acceptsCritical") === "on",
      note: values.get("note")
    }) });
    if (data.demo) writeStorage(STORAGE_KEYS.clinicAvailability, data.location.availability);
    showToast(data.demo ? "Demo capacity was published in this browser." : "Live capacity was published.");
    await loadClinicDashboard();
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; button.textContent = "Publish live status"; }
}

function openDecisionDialog(intakeId, petName, searchTarget = false) {
  const dialog = $("[data-decision-dialog]");
  const form = $("[data-decision-form]");
  form.reset();
  form.elements.intakeId.value = intakeId;
  form.elements.requestType.value = searchTarget ? "search" : "intake";
  $("[data-decision-title]").textContent = searchTarget ? `Offer availability for ${petName}` : `Accept ${petName}?`;
  $("[data-accept-decision-label]").textContent = searchTarget ? "Make an availability offer" : "Accept this arrival";
  syncDecisionFields();
  dialog.showModal(); document.body.classList.add("dialog-open");
}

function syncDecisionFields() {
  const form = $("[data-decision-form]");
  if (!form) return;
  const isSearch = form.elements.requestType.value === "search";
  const isAccept = form.elements.decision.value === "accept";
  $("[data-offer-fields]").hidden = !(isSearch && isAccept);
  form.elements.availableAt.required = isSearch && isAccept && form.elements.responseType.value === "available_at";
  const button = form.querySelector("button[type='submit']");
  button.textContent = isAccept ? (isSearch ? "Send availability offer" : "Accept arrival") : "Decline request";
}

async function submitDecision(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const intakeId = values.get("intakeId");
  const isSearch = values.get("requestType") === "search";
  const availableAtValue = values.get("availableAt");
  const availableAt = availableAtValue && Number.isFinite(Date.parse(availableAtValue)) ? new Date(availableAtValue).toISOString() : null;
  const button = form.querySelector("button[type='submit']");
  button.disabled = true; button.textContent = "Sending…";
  try {
    const endpoint = isSearch
      ? `/api/clinic/search-targets/${encodeURIComponent(intakeId)}/decision`
      : `/api/clinic/intakes/${encodeURIComponent(intakeId)}/decision`;
    const data = await api(endpoint, { clinic: true, method: "POST", body: JSON.stringify({
      decision: isSearch && values.get("decision") === "accept" ? "offer" : values.get("decision"),
      responseType: values.get("responseType"),
      availableAt,
      arrivalWindowMinutes: Number(values.get("arrivalWindowMinutes")),
      holdMinutes: Number(values.get("holdMinutes")),
      waitMin: Number(values.get("waitMin")),
      waitMax: Number(values.get("waitMax")),
      note: values.get("note")
    }) });
    if (data.demo) {
      const decisions = readStorage(STORAGE_KEYS.clinicDecisions, {});
      decisions[intakeId] = data.intake;
      writeStorage(STORAGE_KEYS.clinicDecisions, decisions);
    }
    $("[data-decision-dialog]").close(); document.body.classList.remove("dialog-open");
    showToast(isSearch && values.get("decision") === "accept" ? "Availability offer sent. The owner can compare it with other clinics." : "The pet owner was updated.");
    await loadClinicDashboard();
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; button.textContent = "Send decision"; }
}

document.addEventListener("click", (event) => {
  const routeButton = event.target.closest("[data-route]");
  if (routeButton) setRoute(routeButton.dataset.route);
  const locationButton = event.target.closest("[data-use-location]");
  if (locationButton) useLocation();
  const next = event.target.closest("[data-next-step]");
  if (next && validateStep(state.intakeStep)) { persistFormDraft(); state.intakeStep = Math.min(2, state.intakeStep + 1); renderIntakeStep(); }
  const previous = event.target.closest("[data-prev-step]");
  if (previous) { persistFormDraft(); state.intakeStep = Math.max(1, state.intakeStep - 1); renderIntakeStep(); }
  const refreshResults = event.target.closest("[data-refresh-results]");
  if (refreshResults) loadLocations();
  const startSearch = event.target.closest("[data-start-search]");
  if (startSearch) startCareSearch();
  const viewLocation = event.target.closest("[data-view-location]");
  if (viewLocation) openHospitalDialog(viewLocation.dataset.viewLocation, false);
  const requestLocation = event.target.closest("[data-request-location]");
  if (requestLocation) openHospitalDialog(requestLocation.dataset.requestLocation, true);
  const confirmRequest = event.target.closest("[data-confirm-request]");
  if (confirmRequest) submitIntake(confirmRequest.dataset.confirmRequest);
  const selectOffer = event.target.closest("[data-select-offer]");
  if (selectOffer) selectCareOffer(selectOffer.dataset.selectOffer);
  const cancelSearch = event.target.closest("[data-cancel-search]");
  if (cancelSearch && confirm("Cancel this search and release every clinic offer?")) cancelCareSearch();
  const startTrip = event.target.closest("[data-start-trip]");
  if (startTrip) updateIntakeStatus("en_route");
  const cancel = event.target.closest("[data-cancel-intake]");
  if (cancel && confirm("Cancel this intake request?")) updateIntakeStatus("cancelled");
  const observation = event.target.closest("[data-observation]");
  if (observation) recordObservation(observation.dataset.observation);
  const pay = event.target.closest("[data-pay-deposit]");
  if (pay) startPayment();
  const refreshClinic = event.target.closest("[data-refresh-clinic]");
  if (refreshClinic) loadClinicDashboard();
  const enableAlerts = event.target.closest("[data-enable-alerts]");
  if (enableAlerts) enableClinicAlerts();
  const review = event.target.closest("[data-review-intake]");
  if (review) openDecisionDialog(review.dataset.reviewIntake, review.dataset.petName, review.dataset.searchTarget === "true");
  const closeDialog = event.target.closest("[data-close-dialog]");
  if (closeDialog) { closeDialog.closest("dialog")?.close(); document.body.classList.remove("dialog-open"); }
  const toastButton = event.target.closest("[data-toast-message]");
  if (toastButton) showToast(toastButton.dataset.toastMessage);

  const oauthButton = event.target.closest("[data-oauth]");
  if (oauthButton) startOAuth(oauthButton.dataset.oauth);
  const passkeyButton = event.target.closest("[data-passkey-signin]");
  if (passkeyButton) signInWithPasskey();
  const authBack = event.target.closest("[data-auth-back]");
  if (authBack) setAuthStep("identifier");
  const authToggleMode = event.target.closest("[data-auth-toggle-mode]");
  if (authToggleMode) {
    const currentStep = event.target.closest("[data-auth-step]")?.dataset.authStep;
    setAuthStep(currentStep === "sign-up" ? "identifier" : "sign-up");
  }
  const forgotPassword = event.target.closest("[data-auth-forgot-password]");
  if (forgotPassword) {
    const resetFactor = (state.auth?.factors || []).find((factor) => factor.strategy === "reset_password_email_code");
    if (resetFactor) prepareAndShowCode(resetFactor);
    else showAuthError({ errors: [{ longMessage: "Password reset is not available for this account." }] });
  }
  const codeSubmit = event.target.closest("[data-auth-code-submit]");
  if (codeSubmit) submitCode();
  const resendButton = event.target.closest("[data-auth-resend]");
  if (resendButton && !resendButton.disabled) resendCode();
  const factorOption = event.target.closest("[data-factor-index]");
  if (factorOption) {
    const factor = state.auth?.factors?.[Number(factorOption.dataset.factorIndex)];
    if (factor) startFactor(factor);
  }
  const orgCard = event.target.closest("[data-org-index]");
  if (orgCard) selectOrganization(orgCard);
  const workspaceSwitch = event.target.closest("[data-workspace-switch]");
  if (workspaceSwitch) openOrgSwitcher();

  const accountToggle = event.target.closest("[data-account-toggle]");
  if (accountToggle) {
    const panel = accountToggle.nextElementSibling;
    const wasOpen = panel && !panel.hidden;
    closeAccountMenus();
    if (panel) { panel.hidden = wasOpen; accountToggle.setAttribute("aria-expanded", String(!wasOpen)); }
  } else if (!event.target.closest("[data-account-panel]")) {
    closeAccountMenus();
  }
  const switchWorkspaceItem = event.target.closest("[data-switch-workspace]");
  if (switchWorkspaceItem) openOrgSwitcher();
  const signOutItem = event.target.closest("[data-sign-out]");
  if (signOutItem) signOut();
});

async function selectOrganization(button) {
  const membership = state.auth?.memberships?.[Number(button.dataset.orgIndex)];
  if (!membership) return;
  button.disabled = true;
  try {
    await state.clerk.setActive({ organization: membership.organization.id });
    try { state.session = (await api("/api/session")).session; } catch { state.session = null; }
    finalizeRouting((state.auth && state.auth.pendingRoute) || "find");
  } catch (error) {
    showAuthError(error);
    button.disabled = false;
  }
}

$("[data-auth-identifier-form]")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const identifier = form.elements.identifier.value.trim();
  if (!identifier) return;
  setSubmitting(form, true, "Continue");
  try {
    const signIn = await state.clerk.client.signIn.create({ identifier });
    state.auth.signIn = signIn;
    state.auth.flowKind = "sign-in";
    await handleSignInResult(signIn);
  } catch (error) { showAuthError(error); }
  finally { setSubmitting(form, false, "Continue"); }
});

$("[data-auth-password-form]")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const password = form.elements.password.value;
  setSubmitting(form, true, "Sign in");
  try {
    const attempted = await state.auth.signIn.attemptFirstFactor({ strategy: "password", password });
    state.auth.signIn = attempted;
    await handleSignInResult(attempted);
  } catch (error) { showAuthError(error); }
  finally { setSubmitting(form, false, "Sign in"); }
});

$("[data-auth-reset-form]")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const password = String(values.get("password") || "");
  const confirmPassword = String(values.get("confirmPassword") || "");
  if (password.length < 8) return showAuthError({ errors: [{ longMessage: "Password must be at least 8 characters." }] });
  if (password !== confirmPassword) return showAuthError({ errors: [{ longMessage: "Passwords do not match." }] });
  setSubmitting(form, true, "Set new password");
  try {
    const result = await state.auth.signIn.resetPassword({ password });
    state.auth.signIn = result;
    await handleSignInResult(result);
  } catch (error) { showAuthError(error); }
  finally { setSubmitting(form, false, "Set new password"); }
});

$("[data-auth-signup-form]")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const firstName = String(values.get("firstName") || "").trim();
  const lastName = String(values.get("lastName") || "").trim();
  const identifier = String(values.get("identifier") || "").trim();
  const password = String(values.get("password") || "");
  const isPhone = identifier.includes("@") === false && /^[+0-9()\-\s]{7,}$/.test(identifier);
  setSubmitting(form, true, "Create account");
  try {
    const payload = { firstName, lastName, password };
    if (isPhone) payload.phoneNumber = identifier; else payload.emailAddress = identifier;
    const signUp = await state.clerk.client.signUp.create(payload);
    state.auth.signUp = signUp;
    state.auth.flowKind = "sign-up";
    state.auth.signUpChannel = isPhone ? "phone" : "email";
    state.auth.signUpIdentifier = identifier;
    if (isPhone) await signUp.preparePhoneNumberVerification({ strategy: "phone_code" });
    else await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
    $("[data-auth-code-lede]").textContent = `Enter the 6-digit code sent to ${identifier}.`;
    clearOtpInputs();
    startResendCooldown();
    setAuthStep("code");
  } catch (error) { showAuthError(error); }
  finally { setSubmitting(form, false, "Create account"); }
});

$("[data-otp-input]")?.addEventListener("input", (event) => {
  const input = event.target;
  if (!input.matches("input")) return;
  input.value = input.value.replace(/\D/g, "").slice(-1);
  const inputs = otpInputs();
  const index = inputs.indexOf(input);
  if (input.value && index < inputs.length - 1) inputs[index + 1].focus();
  if (getOtpValue().length === 6) submitCode();
});

$("[data-otp-input]")?.addEventListener("keydown", (event) => {
  if (event.key !== "Backspace") return;
  const input = event.target;
  if (!input.matches("input")) return;
  const inputs = otpInputs();
  const index = inputs.indexOf(input);
  if (!input.value && index > 0) inputs[index - 1].focus();
});

$("[data-otp-input]")?.addEventListener("paste", (event) => {
  const text = (event.clipboardData || window.clipboardData).getData("text").replace(/\D/g, "").slice(0, 6);
  if (!text) return;
  event.preventDefault();
  const inputs = otpInputs();
  text.split("").forEach((digit, index) => { if (inputs[index]) inputs[index].value = digit; });
  inputs[Math.min(text.length, inputs.length - 1)]?.focus();
  if (text.length === 6) submitCode();
});

$("[data-intake-form]")?.addEventListener("change", (event) => {
  if (event.target.matches('[name="redFlag"], [name="urgency"]')) updateSafetyCallout();
  if (event.target.matches('[name="symptom"], [name="startedWhen"]')) updateConcernSpecificity();
});

$("[data-intake-form]")?.addEventListener("input", (event) => {
  if (event.target.matches('[name="concernSummary"]')) updateConcernSpecificity();
});

$("[data-intake-form]")?.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!validateStep(2)) return;
  persistFormDraft();
  setRoute("results");
});

$("[data-sort-results]")?.addEventListener("change", renderLocations);
$("[data-availability-form]")?.addEventListener("submit", publishAvailability);
$("[data-decision-form]")?.addEventListener("submit", submitDecision);
$("[data-decision-form]")?.addEventListener("change", (event) => {
  if (event.target.matches('[name="decision"], [name="responseType"]')) syncDecisionFields();
});
$("[data-payment-form]")?.addEventListener("submit", confirmStripePayment);

$$('dialog').forEach((dialog) => {
  dialog.addEventListener("close", () => document.body.classList.remove("dialog-open"));
  dialog.addEventListener("click", (event) => {
    const rectangle = dialog.getBoundingClientRect();
    if (event.clientX < rectangle.left || event.clientX > rectangle.right || event.clientY < rectangle.top || event.clientY > rectangle.bottom) dialog.close();
  });
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault(); state.deferredInstall = event; $("[data-install]").hidden = false;
});
$("[data-install]")?.addEventListener("click", async () => {
  if (!state.deferredInstall) return;
  state.deferredInstall.prompt(); await state.deferredInstall.userChoice; state.deferredInstall = null; $("[data-install]").hidden = true;
});

window.addEventListener("hashchange", () => { if (state.route === "find") persistFormDraft(); renderRoute(); });
window.addEventListener("load", async () => { await loadConfig(); await renderRoute(); });

if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));

/* ============================== map and navigation ============================== */

/**
 * The map is optional infrastructure: when no Mapbox token is configured the
 * panels stay hidden and every existing text-based flow still works.
 */
function mapPanel(selector) {
  const panel = $(selector);
  if (!panel) return null;
  if (!mapAvailable()) {
    panel.hidden = true;
    return null;
  }
  panel.hidden = false;
  return panel;
}

async function renderResultsMap() {
  const panel = mapPanel("[data-results-map-panel]");
  if (!panel) return;
  const container = $("[data-results-map]", panel);
  const clinics = sortLocations(state.locations).slice(0, 30);
  if (!clinics.length) {
    panel.hidden = true;
    return;
  }
  try {
    state.resultsMap?.destroy();
    state.resultsMap = await renderClinicMap(container, {
      origin: state.intakeDraft.position,
      clinics,
      onSelect: (clinic) => openHospitalDialog(clinic.id)
    });
  } catch (error) {
    panel.hidden = true;
    console.warn("Map unavailable", error.message);
  }
}

async function renderTrackerMap() {
  const panel = mapPanel("[data-tracker-map-panel]");
  if (!panel) return;
  const intake = state.currentIntake;
  const location = intake?.location || state.locations.find((candidate) => candidate.id === intake?.locationId);
  if (!location || !Number.isFinite(location.latitude)) {
    panel.hidden = true;
    return;
  }
  const origin = state.intakeDraft.position;
  try {
    state.trackerMap?.destroy();
    state.trackerMap = await renderClinicMap($("[data-tracker-map]", panel), {
      origin,
      clinics: [location]
    });
    await refreshRoute(origin, location);
  } catch (error) {
    panel.hidden = true;
    console.warn("Tracker map unavailable", error.message);
  }
}

async function refreshRoute(origin, location) {
  if (!state.trackerMap || !origin) return;
  try {
    const route = await fetchRoute(origin, location, { preferences: state.navigationPreferences });
    state.activeRoute = { ...route, clinic: location };
    drawRoute(state.trackerMap.map, route);
    const summary = $("[data-route-summary]");
    if (summary) {
      summary.hidden = false;
      $("[data-route-eta]", summary).textContent = `${formatDuration(route.durationSeconds)} away`;
      $("[data-route-distance]", summary).textContent =
        `${formatDistance(route.distanceMeters, state.navigationPreferences.units)} · ${location.name}`;
    }
    state.trackerMap.map.fitBounds(routeBounds(route), { padding: 48, duration: 0 });
  } catch (error) {
    console.warn("Route unavailable", error.message);
  }
}

function routeBounds(route) {
  const coordinates = route.geometry?.coordinates || [];
  return coordinates.reduce(
    (bounds, point) => [
      [Math.min(bounds[0][0], point[0]), Math.min(bounds[0][1], point[1])],
      [Math.max(bounds[1][0], point[0]), Math.max(bounds[1][1], point[1])]
    ],
    [[180, 90], [-180, -90]]
  );
}

/**
 * Which speaking register the current trip is in. Derived from the intake's
 * urgency rather than a setting, so a driver never has to think about it: the
 * playful lines simply do not exist on an emergency run.
 */
function navigationTone() {
  return toneFor(state.currentIntake?.urgency || state.intakeDraft?.urgency || "same_day");
}

function persistNavigationPreferences() {
  writeStorage(STORAGE_KEYS.navigation, state.navigationPreferences);
}

function populateVoicePicker() {
  const picker = $("[data-navigation-voice-picker]");
  if (!picker || !VoiceGuide.supported()) return;
  const voices = VoiceGuide.voices(navigator.language || "en");
  if (!voices.length) return;
  picker.innerHTML = voices
    .map((voice) => `<option value="${escapeHtml(voice.voiceURI)}">${escapeHtml(voice.name)}${voice.local ? "" : " (network)"}</option>`)
    .join("");
  if (state.navigationPreferences.voiceURI) picker.value = state.navigationPreferences.voiceURI;
}

function startNavigation() {
  const route = state.activeRoute;
  if (!route) return;
  const panel = $("[data-navigation-panel]");
  if (!panel) return;
  panel.hidden = false;
  state.navigationActive = true;
  state.voiceGuide = new VoiceGuide({
    enabled: state.navigationPreferences.voiceEnabled,
    rate: state.navigationPreferences.rate,
    voiceURI: state.navigationPreferences.voiceURI,
    tone: navigationTone()
  });
  populateVoicePicker();
  renderNavigationSteps(route);

  const pet = state.currentIntake?.pet?.name || "your pet";
  state.voiceGuide.say(
    announcement("start", { tone: navigationTone(), clinic: route.clinic.name, pet }),
    { force: true }
  );

  if (navigator.geolocation) {
    state.navigationWatchId = navigator.geolocation.watchPosition(
      (position) => advanceNavigation(position.coords),
      () => {},
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
    );
  }
  updateIntakeStatus("en_route").catch(() => {});
}

function renderNavigationSteps(route) {
  const list = $("[data-navigation-steps]");
  if (!list) return;
  list.innerHTML = route.steps
    .map((step) => `<li><strong>${escapeHtml(phraseInstruction(step, { clinic: route.clinic.name }))}</strong>` +
      `<small>${escapeHtml(formatDistance(step.distanceMeters, state.navigationPreferences.units))}</small></li>`)
    .join("");
  const first = route.steps[0];
  if (first) {
    $("[data-navigation-instruction]").textContent = phraseInstruction(first, { clinic: route.clinic.name });
    $("[data-navigation-distance]").textContent = formatDistance(first.distanceMeters, state.navigationPreferences.units);
    $("[data-maneuver-glyph]").textContent = maneuverGlyph(first);
  }
}

function maneuverGlyph(step) {
  const modifier = String(step.modifier || "").toLowerCase();
  if (step.type === "arrive") return "◎";
  if (modifier.includes("left")) return modifier.includes("slight") ? "↰" : "←";
  if (modifier.includes("right")) return modifier.includes("slight") ? "↱" : "→";
  if (modifier.includes("uturn")) return "↺";
  return "↑";
}

/**
 * Advance the banner as the driver moves. Deliberately simple: the browser has
 * no map-matching engine, so this snaps to the nearest upcoming maneuver rather
 * than pretending to do full route-following. The native clients use Mapbox's
 * real navigator for that.
 */
function advanceNavigation(coordinates) {
  const route = state.activeRoute;
  if (!route || !state.navigationActive) return;
  const remaining = route.steps.filter((step) => step.location);
  if (!remaining.length) return;

  let closest = remaining[0];
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const step of remaining) {
    const distance = haversineMeters(coordinates.latitude, coordinates.longitude, step.location[1], step.location[0]);
    if (distance < closestDistance) {
      closestDistance = distance;
      closest = step;
    }
  }

  const clinic = route.clinic.name;
  $("[data-navigation-instruction]").textContent = phraseInstruction(closest, { clinic });
  $("[data-navigation-distance]").textContent = formatDistance(closestDistance, state.navigationPreferences.units);
  $("[data-maneuver-glyph]").textContent = maneuverGlyph(closest);

  if (closestDistance < 220) {
    state.voiceGuide?.say(phraseInstruction(closest, { clinic }));
  }

  const toClinic = haversineMeters(coordinates.latitude, coordinates.longitude, route.clinic.latitude, route.clinic.longitude);
  if (toClinic < 900) {
    state.voiceGuide?.say(announcement("approaching", {
      tone: navigationTone(),
      clinic,
      pet: state.currentIntake?.pet?.name,
      kind: humanize(route.clinic.kind || "main")
    }));
  }
  if (toClinic < 120) {
    state.voiceGuide?.say(
      announcement("arrival", {
        tone: navigationTone(),
        clinic,
        pet: state.currentIntake?.pet?.name
      }),
      { force: true }
    );
    endNavigation();
    recordObservation("arrived").catch(() => {});
  }
}

function endNavigation() {
  state.navigationActive = false;
  state.voiceGuide?.stop();
  state.voiceGuide = null;
  if (state.navigationWatchId !== null && navigator.geolocation) {
    navigator.geolocation.clearWatch(state.navigationWatchId);
    state.navigationWatchId = null;
  }
  const panel = $("[data-navigation-panel]");
  if (panel) panel.hidden = true;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const earthRadius = 6371000;
  const latitudeDelta = toRadians(lat2 - lat1);
  const longitudeDelta = toRadians(lon2 - lon1);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.sqrt(a));
}

$("[data-start-navigation]")?.addEventListener("click", startNavigation);
$("[data-end-navigation]")?.addEventListener("click", endNavigation);
$("[data-navigation-voice]")?.addEventListener("change", (event) => {
  state.navigationPreferences.voiceEnabled = event.target.checked;
  if (state.voiceGuide) state.voiceGuide.preferences.enabled = event.target.checked;
  persistNavigationPreferences();
});
$("[data-navigation-voice-picker]")?.addEventListener("change", (event) => {
  state.navigationPreferences.voiceURI = event.target.value;
  if (state.voiceGuide) state.voiceGuide.preferences.voiceURI = event.target.value;
  persistNavigationPreferences();
});
$("[data-navigation-rate]")?.addEventListener("input", (event) => {
  state.navigationPreferences.rate = Number(event.target.value);
  if (state.voiceGuide) state.voiceGuide.preferences.rate = state.navigationPreferences.rate;
  persistNavigationPreferences();
});
$("[data-navigation-units]")?.addEventListener("change", (event) => {
  state.navigationPreferences.units = event.target.value;
  persistNavigationPreferences();
  if (state.activeRoute) renderNavigationSteps(state.activeRoute);
});
$$("[data-navigation-avoid]").forEach((input) => {
  const key = `avoid${input.dataset.navigationAvoid.charAt(0).toUpperCase()}${input.dataset.navigationAvoid.slice(1)}`;
  input.checked = Boolean(state.navigationPreferences[key]);
  input.addEventListener("change", () => {
    state.navigationPreferences[key] = input.checked;
    persistNavigationPreferences();
    const intake = state.currentIntake;
    const location = intake?.location || state.locations.find((candidate) => candidate.id === intake?.locationId);
    if (location) refreshRoute(state.intakeDraft.position, location);
  });
});
if (VoiceGuide.supported()) speechSynthesis.addEventListener?.("voiceschanged", populateVoicePicker);

/**
 * Tear down any live map before a route change. WebGL contexts are a limited
 * browser resource, so leaving them attached to hidden screens eventually
 * refuses to create new ones.
 */
function releaseMaps() {
  if (state.navigationActive) endNavigation();
  state.resultsMap?.destroy();
  state.resultsMap = null;
  state.trackerMap?.destroy();
  state.trackerMap = null;
  state.activeRoute = null;
  const summary = $("[data-route-summary]");
  if (summary) summary.hidden = true;
}
