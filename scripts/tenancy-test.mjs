/**
 * Authorization tests for the tenancy layer.
 *
 * These cover the one asymmetry the whole platform rests on: a tenant
 * administrator may manage people inside their own workspace, and only a
 * platform operator may bring a new workspace into existence.
 */
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { isPlatformAdmin, listTenantMembers, recordAudit, slugify, upsertTenantMember, countTenantAdmins } from "../src/tenancy.js";
import { normalizeRole, requireTenantAdmin } from "../src/tenant-admin.js";

class D1StatementMock {
  constructor(database, sql) { this.database = database; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() { return this.database.prepare(this.sql).get(...this.values) || null; }
  async all() { return { results: this.database.prepare(this.sql).all(...this.values), success: true }; }
  async run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid || 0) } };
  }
}

class D1Mock {
  constructor(database) { this.database = database; }
  prepare(sql) { return new D1StatementMock(this.database, sql); }
  async batch(statements) {
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const database = new DatabaseSync(":memory:");
database.exec(await readFile("migrations/0001_initial.sql", "utf8"));
database.exec(await readFile("migrations/0002_seed.sql", "utf8"));
database.exec(await readFile("migrations/0003_multi_offer_search.sql", "utf8"));
database.exec(await readFile("migrations/0004_tenancy_admin.sql", "utf8"));

const env = { DB: new D1Mock(database) };
const operator = { userId: "user_operator", email: "operator@example.com" };
const staff = { userId: "user_staff", email: "vet@example.com" };

/* -------------------------------------------------- platform operators --- */

assert(!(await isPlatformAdmin(env, staff)), "Nobody is a platform operator by default");
assert(!(await isPlatformAdmin(env, null)), "An unauthenticated caller is never a platform operator");

assert(
  await isPlatformAdmin({ ...env, PLATFORM_ADMIN_USER_IDS: "user_operator" }, operator),
  "The user id allowlist must grant platform access"
);
assert(
  !(await isPlatformAdmin({ ...env, PLATFORM_ADMIN_USER_IDS: "user_operator" }, staff)),
  "The user id allowlist must not leak to other users"
);
assert(
  await isPlatformAdmin({ ...env, PLATFORM_ADMIN_EMAILS: "Operator@Example.com" }, operator),
  "The email allowlist must be case-insensitive"
);
assert(
  !(await isPlatformAdmin({ ...env, PLATFORM_ADMIN_EMAILS: "someone@else.com" }, operator)),
  "A non-matching email must be rejected"
);

database.prepare("INSERT INTO platform_admins (clerk_user_id, email, label) VALUES (?, ?, ?)")
  .run("user_seeded", "seeded@example.com", "Seeded operator");
assert(
  await isPlatformAdmin(env, { userId: "user_seeded" }),
  "A platform_admins row must grant platform access without any env allowlist"
);

// Without a CLERK_SECRET_KEY the bootstrap lookup must not be attempted, and the
// caller must simply be denied rather than the request failing.
assert(
  !(await isPlatformAdmin({ ...env, PLATFORM_ADMIN_EMAILS: "operator@example.com" }, { userId: "user_no_claim" })),
  "A missing email claim must deny rather than throw when no Clerk secret is set"
);

/* ------------------------------------------------ tenant administration --- */

assert(normalizeRole("admin") === "org:admin", "Bare admin must normalize to the Clerk role");
assert(normalizeRole("member") === "org:member", "Bare member must normalize to the Clerk role");
assert(normalizeRole("") === "org:member", "An unset role must default to member");
assert(normalizeRole("org:owner") === null, "An unknown role must be rejected outright");

assert(
  requireTenantAdmin(null, "tenant_hearth")?.status === 401,
  "An unauthenticated caller must be refused before any tenant work"
);
assert(
  requireTenantAdmin({ authenticated: true, clerkOrgId: "org_x", role: "org:admin" }, null)?.code === "TENANT_REQUIRED",
  "An administrator with no mapped tenant must be refused"
);
assert(
  requireTenantAdmin({ authenticated: true, clerkOrgId: null, role: "org:admin" }, "tenant_hearth")?.code === "ORGANIZATION_REQUIRED",
  "An administrator with no active organization must be refused"
);
assert(
  requireTenantAdmin({ authenticated: true, clerkOrgId: "org_x", role: "org:member" }, "tenant_hearth")?.code === "TENANT_ADMIN_REQUIRED",
  "A plain member must not be able to manage people"
);
assert(
  requireTenantAdmin({ authenticated: true, clerkOrgId: "org_x", role: "org:admin" }, "tenant_hearth") === null,
  "A tenant administrator with an active organization must be allowed"
);

/* ------------------------------------------------------ member mirroring --- */

await upsertTenantMember(env, {
  tenantId: "tenant_hearth",
  clerkOrgId: "org_demo_hearth",
  clerkUserId: "user_staff",
  email: "vet@example.com",
  displayName: "Sam Rivera",
  role: "org:admin"
});
let members = await listTenantMembers(env, "tenant_hearth");
assert(members.length === 1, "A member must be mirrored into D1");
assert(members[0].role === "org:admin", "The mirrored role must match Clerk");
assert(await countTenantAdmins(env, "tenant_hearth") === 1, "The administrator count must reflect the mirror");

// Re-running the same upsert must update rather than duplicate, because the
// roster reconciles on every console load.
await upsertTenantMember(env, {
  tenantId: "tenant_hearth",
  clerkOrgId: "org_demo_hearth",
  clerkUserId: "user_staff",
  displayName: "Sam Rivera",
  role: "org:member"
});
members = await listTenantMembers(env, "tenant_hearth");
assert(members.length === 1, "Re-mirroring a member must not duplicate the row");
assert(members[0].role === "org:member", "Re-mirroring must apply the new role");
assert(members[0].email === "vet@example.com", "Re-mirroring must not discard a known email");
assert(await countTenantAdmins(env, "tenant_hearth") === 0, "Demoting the only administrator must be visible to the guard");

/* ------------------------------------------------------------- auditing --- */

await recordAudit(env, {
  actorUserId: "user_operator",
  actorScope: "platform",
  tenantId: "tenant_hearth",
  action: "tenant.created",
  target: "tenant_hearth",
  detail: { name: "Hearth & Paw" }
});
const audit = database.prepare("SELECT * FROM admin_audit_log").all();
assert(audit.length === 1, "Privileged actions must be recorded");
assert(audit[0].actor_scope === "platform", "The audit trail must record the authority level used");
assert(JSON.parse(audit[0].detail_json).name === "Hearth & Paw", "Audit detail must round-trip");

/* ------------------------------------------- seating a new administrator --- */

// Seating somebody who has never used Tími has to create the account, not just
// invite them into one. An invitation is a pending record: no Clerk user, no
// membership, no roster row, and a workspace page reading "No active members"
// whether the invite is waiting, was never sent, or failed.
{
  const calls = [];
  const realFetch = globalThis.fetch;
  const clerk = { createUserFails: false };
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(String(url)).pathname.replace("/v1", "");
    const method = options.method || "GET";
    calls.push(`${method} ${path}`);
    const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });
    if (method === "GET" && path === "/users") return reply({ data: [] });
    if (method === "POST" && path === "/users") {
      if (clerk.createUserFails) {
        return reply({ errors: [{ message: "Phone number is required.", long_message: "Phone number is required." }] }, 422);
      }
      return reply({ id: "user_new", first_name: "Dana", last_name: "Reyes", primary_email_address_id: "idn_1", email_addresses: [{ id: "idn_1", email_address: "dana@clinic.example" }] });
    }
    if (method === "POST" && path.endsWith("/memberships")) return reply({ id: "orgmem_1" });
    if (method === "POST" && path.endsWith("/invitations")) return reply({ id: "orginv_1" });
    return reply({}, 404);
  };

  const { addMember } = await import("../src/tenant-admin.js");
  const seatEnv = { ...env, CLERK_SECRET_KEY: "sk_test_stub" };
  const seatActor = { userId: "user_operator", clerkOrgId: "org_hearth" };

  const seated = await addMember(seatEnv, seatActor, "tenant_hearth", { email: "dana@clinic.example", role: "org:admin" });
  assert(seated.status === 201, "Seating a new administrator must succeed");
  assert(seated.body.added?.clerkUserId === "user_new", "A Clerk user must be created for an address Clerk has never seen");
  assert(seated.body.added?.accountCreated === true, "The response must say the account was created, not merely seated");
  assert(seated.body.invited === null, "Creating the account means there is nothing to invite");
  assert(calls.includes("POST /users"), "The account must actually be created through Clerk");
  const roster = await listTenantMembers(seatEnv, "tenant_hearth");
  assert(roster.some((member) => member.clerkUserId === "user_new"), "A seated administrator must appear on the roster immediately");

  // And when Clerk refuses — a required attribute this screen cannot supply —
  // an invitation still gets somebody in, with the reason carried back rather
  // than left in a log.
  clerk.createUserFails = true;
  const invited = await addMember(seatEnv, seatActor, "tenant_hearth", { email: "sam@clinic.example", role: "org:member" });
  assert(invited.status === 201, "A refused account creation must still fall back to an invitation");
  assert(invited.body.added === null, "Nobody is seated when the account could not be created");
  assert(invited.body.invited?.id === "orginv_1", "The invitation must be created as the fallback");
  assert(/Phone number is required/.test(invited.body.invited?.reason || ""), "Clerk's reason must reach the caller, not only the log");

  globalThis.fetch = realFetch;
}

/* -------------------------------------------------------------- slugs --- */

assert(slugify("Hearth & Paw Veterinary") === "hearth-paw-veterinary", "Slugs must be URL safe");
assert(slugify("Café Vétérinaire") === "cafe-veterinaire", "Slugs must fold accents");
assert(slugify("   ") === "tenant", "An empty name must still produce a usable slug");

console.log("Tenancy tests passed: platform operator gating, tenant administrator guards, member mirroring, administrator seating (account creation and invitation fallback), auditing, and slugs.");
