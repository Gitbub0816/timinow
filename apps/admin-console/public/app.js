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
  map: null,
  marker: null
};

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
  if (raw === "audit") return { screen: "audit" };
  if (raw === "errors") return { screen: "errors" };
  return { screen: "tenants" };
}

function updateNavActive() {
  const top = ["audit", "errors"].includes(state.route.screen) ? state.route.screen : "tenants";
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
  await renderRoute();
}

async function renderRoute() {
  state.route = parseHash();
  updateNavActive();
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
  ["identifier", "strategy", "password", "code"].forEach((s) => {
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
  document.querySelector('form[data-step="password"]')?.reset();
  document.querySelector('form[data-step="code"]')?.reset();
  showStep("identifier");
  document.querySelector("[data-clerk-missing]").hidden = Boolean(state.config?.clerkPublishableKey) || !state.config?.signInRequired;
}

function renderStrategyChoices(attempt) {
  const list = document.querySelector("[data-strategy-list]");
  list.innerHTML = "";
  document.querySelector("[data-strategy-identity]").textContent = attempt.identifier ? `Continuing as ${attempt.identifier}` : "";
  const seen = new Set();
  const supported = (attempt.supportedFirstFactors || []).filter((factor) => {
    if (!["password", "email_code", "phone_code"].includes(factor.strategy)) return false;
    if (seen.has(factor.strategy)) return false;
    seen.add(factor.strategy);
    return true;
  });
  for (const factor of supported) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button";
    button.textContent = factor.strategy === "password"
      ? "Use your password"
      : factor.strategy === "email_code"
        ? `Email a code to ${factor.safeIdentifier || "your inbox"}`
        : `Text a code to ${factor.safeIdentifier || "your phone"}`;
    button.addEventListener("click", () => chooseStrategy(factor));
    list.appendChild(button);
  }
  if (!supported.length) {
    list.innerHTML = '<p class="sign-in-error" style="margin:0;">No supported sign-in method was found for this account.</p>';
  }
}

async function chooseStrategy(factor) {
  clearSignInError();
  if (factor.strategy === "password") {
    showStep("password");
    return;
  }
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

    <div class="panel">
      <h2>Audit trail</h2>
      <div class="audit-list">${audit.length ? audit.map(renderAuditRow).join("") : '<p class="page-lede">No recorded actions yet.</p>'}</div>
    </div>
  `;
  wireTenantDetailEvents(tenant.id);
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

  document.querySelector('form[data-step="password"]').addEventListener("submit", async (event) => {
    event.preventDefault();
    clearSignInError();
    try {
      const result = await state.signIn.attemptFirstFactor({ strategy: "password", password: event.target.password.value });
      if (result.status === "complete") await completeSignIn(result);
      else showSignInError(new Error("Additional verification is required for this account."));
    } catch (error) {
      showSignInError(error);
    }
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

  document.querySelector("[data-passkey]").addEventListener("click", async () => {
    clearSignInError();
    if (!state.clerk) return;
    try {
      const result = await state.clerk.client.signIn.authenticateWithPasskey();
      if (result?.status === "complete") await completeSignIn(result);
    } catch (error) {
      showSignInError(error);
    }
  });

  document.querySelectorAll("[data-oauth]").forEach((button) => {
    button.addEventListener("click", async () => {
      clearSignInError();
      if (!state.clerk) return;
      try {
        await state.clerk.client.signIn.authenticateWithRedirect({
          strategy: button.dataset.oauth,
          redirectUrl: `${location.origin}/`,
          redirectUrlComplete: `${location.origin}/#tenants`
        });
      } catch (error) {
        showSignInError(error);
      }
    });
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
