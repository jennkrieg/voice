import { eq, sql } from "drizzle-orm";
import { db, schema } from "./db/index.js";
import type { User, UserRole } from "./db/schema.js";
import { newId } from "./lib/crypto.js";
import { hashPassword, tempPassword } from "./lib/password.js";
import { env } from "./env.js";
import { log } from "./lib/log.js";

export function publicUser(u: User) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, tenantId: u.tenantId, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt };
}

export async function findUserByEmail(email: string): Promise<User | null> {
  const [u] = await db().select().from(schema.users).where(eq(schema.users.email, email.trim().toLowerCase()));
  return u ?? null;
}

/** Creates a user. Returns the generated temporary password when none was given. */
export async function createUser(opts: { email: string; name?: string | null; role: UserRole; tenantId: string | null; password?: string }) {
  const email = opts.email.trim().toLowerCase();
  if (await findUserByEmail(email)) throw Object.assign(new Error("A user with that email already exists"), { status: 409 });
  if (opts.role !== "platform_admin" && !opts.tenantId) throw new Error("tenant users need a tenantId");
  const password = opts.password ?? tempPassword();
  const [user] = await db()
    .insert(schema.users)
    .values({ id: newId("usr"), tenantId: opts.role === "platform_admin" ? null : opts.tenantId, email, name: opts.name ?? null, role: opts.role, passwordHash: hashPassword(password) })
    .returning();
  return { user, temporaryPassword: opts.password ? undefined : password };
}

export async function setPassword(userId: string, password: string) {
  await db()
    .update(schema.users)
    .set({ passwordHash: hashPassword(password), sessionVersion: sql`${schema.users.sessionVersion} + 1` })
    .where(eq(schema.users.id, userId));
}

/** Creates the first platform admin from env on boot (idempotent). */
export async function ensureBootstrapAdmin() {
  if (!env.PLATFORM_ADMIN_EMAIL || !env.PLATFORM_ADMIN_PASSWORD) return;
  if (await findUserByEmail(env.PLATFORM_ADMIN_EMAIL)) return;
  await createUser({ email: env.PLATFORM_ADMIN_EMAIL, name: "Platform admin", role: "platform_admin", tenantId: null, password: env.PLATFORM_ADMIN_PASSWORD });
  log.info("created platform admin user", { email: env.PLATFORM_ADMIN_EMAIL });
}
