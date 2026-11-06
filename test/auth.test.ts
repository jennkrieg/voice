import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

process.env.PLATFORM_ADMIN_KEY = "test-platform-admin-key-123456";
process.env.PLATFORM_ADMIN_EMAIL = "boss@platform.test";
process.env.PLATFORM_ADMIN_PASSWORD = "correct-horse-battery";
process.env.BRAND_NAME = "Acme Voice";
process.env.BRAND_PRIMARY_COLOR = "#0ea5e9";
process.env.LOG_LEVEL = "error";

const { initDb, closeDb } = await import("../src/db/index.ts");
const { createHttpServer } = await import("../src/server.ts");
const { ensureBootstrapAdmin } = await import("../src/users.ts");
const { hashPassword, verifyPassword } = await import("../src/lib/password.ts");

let base = "";
let server: http.Server;

/** Minimal cookie-keeping browser. */
function browser() {
  let cookie = "";
  return async (path: string, opts: { method?: string; json?: unknown; csrf?: boolean; headers?: Record<string, string> } = {}) => {
    const res = await fetch(base + path, {
      method: opts.method ?? (opts.json === undefined ? "GET" : "POST"),
      headers: {
        ...(opts.json !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(opts.csrf === false ? {} : { "X-Requested-With": "dashboard" }),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(opts.headers ?? {}),
      },
      body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, setCookie: set };
  };
}

before(async () => {
  await initDb("memory://");
  await ensureBootstrapAdmin();
  server = createHttpServer();
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.close();
  await closeDb();
});

test("password hashing", () => {
  const h = hashPassword("s3cret-pass");
  assert.ok(h.startsWith("scrypt$"));
  assert.ok(verifyPassword("s3cret-pass", h));
  assert.ok(!verifyPassword("wrong", h));
});

let tenantId = "";
let ownerPassword = "";

test("branding is public; login sets an httpOnly session cookie; bad password is rejected", async () => {
  const b = browser();
  const brand = await b("/auth/branding");
  assert.deepEqual([brand.body.name, brand.body.primaryColor], ["Acme Voice", "#0ea5e9"]);
  assert.equal((await b("/auth/me")).status, 401);
  assert.equal((await b("/auth/login", { json: { email: "boss@platform.test", password: "nope" } })).status, 401);
  const ok = await b("/auth/login", { json: { email: "BOSS@platform.test", password: "correct-horse-battery" } });
  assert.equal(ok.status, 200);
  assert.match(ok.setCookie!, /HttpOnly/i);
  assert.match(ok.setCookie!, /SameSite=Lax/i);
  const me = await b("/auth/me");
  assert.equal(me.body.user.role, "platform_admin");
});

test("platform admin creates a client with an owner login, and can act inside the client", async () => {
  const b = browser();
  await b("/auth/login", { json: { email: "boss@platform.test", password: "correct-horse-battery" } });
  // CSRF: cookie-authenticated writes need the custom header.
  assert.equal((await b("/platform/tenants", { json: { name: "X" }, csrf: false })).status, 403);
  const r = await b("/platform/tenants", { json: { name: "Summit Roofing", owner: { email: "owner@summit.test", name: "Pat" } } });
  assert.equal(r.status, 201);
  tenantId = r.body.tenant.id;
  ownerPassword = r.body.owner.temporaryPassword;
  assert.ok(ownerPassword.length >= 12);
  const list = await b("/platform/tenants");
  assert.equal(list.body.tenants[0].name, "Summit Roofing");
  assert.equal(list.body.tenants[0].calls30d, 0);
  // Without choosing a client, /api is refused; with X-Tenant-Id it works.
  assert.equal((await b("/api/tenant")).status, 400);
  const inside = await b("/api/tenant", { headers: { "X-Tenant-Id": tenantId } });
  assert.equal(inside.body.name, "Summit Roofing");
  // Duplicate emails are refused.
  assert.equal((await b("/platform/tenants", { json: { name: "Dup", owner: { email: "owner@summit.test" } } })).status, 409);
});

test("client owner sees only their account, can invite a member; members can't manage the team", async () => {
  const owner = browser();
  assert.equal((await owner("/auth/login", { json: { email: "owner@summit.test", password: ownerPassword } })).status, 200);
  assert.equal((await owner("/api/tenant")).body.id, tenantId);
  // Can't reach platform admin, or another tenant via header.
  assert.equal((await owner("/platform/tenants")).status, 401);
  assert.equal((await owner("/api/tenant", { headers: { "X-Tenant-Id": "ten_other" } })).body.id, tenantId);
  const inv = await owner("/api/users", { json: { email: "member@summit.test", role: "member" } });
  assert.equal(inv.status, 201);
  const member = browser();
  assert.equal((await member("/auth/login", { json: { email: "member@summit.test", password: inv.body.temporaryPassword } })).status, 200);
  assert.equal((await member("/api/agents")).status, 200);
  assert.equal((await member("/api/users", { json: { email: "x@summit.test" } })).status, 403);
  assert.equal((await member("/api/tenant/rotate-key", { json: {} })).status, 403);
  // Owner can't remove themselves.
  const me = await owner("/auth/me");
  assert.equal((await owner(`/api/users/${me.body.user.id}`, { method: "DELETE" })).status, 400);
});

test("changing password signs out other sessions", async () => {
  const a = browser();
  const b = browser();
  await a("/auth/login", { json: { email: "owner@summit.test", password: ownerPassword } });
  await b("/auth/login", { json: { email: "owner@summit.test", password: ownerPassword } });
  assert.equal((await a("/auth/password", { json: { currentPassword: ownerPassword, newPassword: "a-much-better-password" } })).status, 200);
  assert.equal((await a("/api/tenant")).status, 200, "the session that changed it stays signed in");
  assert.equal((await b("/api/tenant")).status, 401, "other sessions are invalidated");
});

test("missing service keys return a friendly 503, not a crash", async () => {
  const b = browser();
  await b("/auth/login", { json: { email: "owner@summit.test", password: "a-much-better-password" } });
  const r = await b("/api/voices");
  assert.equal(r.status, 503);
  assert.match(r.body.error, /isn't set up yet/);
});
