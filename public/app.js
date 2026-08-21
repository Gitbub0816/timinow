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
  clinicDecisions: "timi_demo_clinic_decisions_v1"
};

const state = {
  route: "home",
  config: null,
  clerk: null,
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
  clinicInitialized: false
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
  $$('dialog[open]').forEach((dialog) => dialog.close());
  document.body.classList.remove("dialog-open");
  let route = parseRoute();
  if (state.config?.signInRequired && PROTECTED_ROUTES.has(route) && !state.clerk?.user) {
    sessionStorage.setItem("timi_return_route", route);
    route = "sign-in";
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
    mountOrganizationSwitcher();
    await loadClinicDashboard();
    state.clinicTimer = window.setInterval(loadClinicDashboard, 15000);
  }
  if (route === "sign-in") await renderSignIn();
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("accept", "application/json");
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (state.config?.signInRequired && state.clerk?.session) {
    const token = await state.clerk.session.getToken();
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
  if (state.config.signInRequired) await initializeClerk();
}

async function initializeClerk() {
  if (!state.config.clerkPublishableKey || !state.config.clerkJsUrl) return;
  try {
    const clerkModule = await import(state.config.clerkJsUrl);
    const Clerk = clerkModule.Clerk || clerkModule.default?.Clerk || clerkModule.default;
    state.clerk = new Clerk(state.config.clerkPublishableKey);
    await state.clerk.load();
    state.clerk.addListener(() => {
      if (state.route === "sign-in" && state.clerk.user) {
        const returnRoute = sessionStorage.getItem("timi_return_route") || "find";
        sessionStorage.removeItem("timi_return_route");
        setRoute(returnRoute);
      }
    });
  } catch (error) {
    console.error("Clerk initialization failed", error);
  }
}

async function renderSignIn() {
  const mount = document.getElementById("clerk-sign-in");
  const disabled = $("[data-auth-disabled]");
  if (!state.config?.signInRequired) {
    mount.hidden = true;
    disabled.hidden = false;
    return;
  }
  disabled.hidden = true;
  mount.hidden = false;
  if (!state.clerk) {
    mount.innerHTML = '<div class="safety-callout"><strong>Clerk is not configured.</strong><p>Add the Clerk publishable key and issuer before setting SIGN_IN_REQUIRED=true.</p></div>';
    return;
  }
  if (state.clerk.user) {
    const returnRoute = sessionStorage.getItem("timi_return_route") || "find";
    setRoute(returnRoute);
    return;
  }
  mount.innerHTML = "";
  state.clerk.mountSignIn(mount);
}

function mountOrganizationSwitcher() {
  const mount = document.getElementById("clerk-org-switcher");
  if (!mount || !state.config?.signInRequired || !state.clerk?.user) return;
  mount.hidden = false;
  mount.innerHTML = "";
  state.clerk.mountOrganizationSwitcher(mount, { hidePersonal: true, afterSelectOrganizationUrl: "/#clinic" });
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
        legalVersion: "2026-08-21"
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
        legalVersion: "2026-08-21"
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
