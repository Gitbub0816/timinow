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

/* -------------------------------------------------------------- slugs --- */

assert(slugify("Hearth & Paw Veterinary") === "hearth-paw-veterinary", "Slugs must be URL safe");
assert(slugify("Café Vétérinaire") === "cafe-veterinaire", "Slugs must fold accents");
assert(slugify("   ") === "tenant", "An empty name must still produce a usable slug");

console.log("Tenancy tests passed: platform operator gating, tenant administrator guards, member mirroring, auditing, and slugs.");
