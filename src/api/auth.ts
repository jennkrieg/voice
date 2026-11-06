import type { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { env } from "../env.js";
import { db, schema } from "../db/index.js";
import type { Tenant, User } from "../db/schema.js";
import { safeEqual, sha256Hex } from "../lib/crypto.js";
import { sessionUser, passesCsrf } from "./session.js";

declare module "express-serve-static-core" {
  interface Request {
    tenant?: Tenant;
    user?: User;
    isPlatformAdmin?: boolean;
    /** "owner" for API keys and admins; the user's role for dashboard sessions. */
    role?: "owner" | "member";
  }
}

function bearer(req: Request): string | null {
  const h = req.header("Authorization");
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

export async function requirePlatformAdmin(req: Request, res: Response, next: NextFunction) {
  const token = bearer(req);
  if (token) {
    if (!env.PLATFORM_ADMIN_KEY || !safeEqual(token, env.PLATFORM_ADMIN_KEY)) return res.status(401).json({ error: "platform admin key required" });
    req.isPlatformAdmin = true;
    return next();
  }
  const user = await sessionUser(req);
  if (!user || user.role !== "platform_admin") return res.status(401).json({ error: "platform admin login required" });
  if (!passesCsrf(req)) return res.status(403).json({ error: "missing X-Requested-With header" });
  req.user = user;
  req.isPlatformAdmin = true;
  next();
}

async function tenantById(id: string) {
  const [t] = await db().select().from(schema.tenants).where(eq(schema.tenants.id, id));
  return t ?? null;
}

/**
 * Who can use /api:
 *  - a client's API key (acts as owner),
 *  - the platform admin key + X-Tenant-Id,
 *  - a dashboard session (client owner/member, or a platform admin + X-Tenant-Id).
 */
export async function requireTenant(req: Request, res: Response, next: NextFunction) {
  const token = bearer(req);
  if (token) {
    if (env.PLATFORM_ADMIN_KEY && safeEqual(token, env.PLATFORM_ADMIN_KEY)) {
      const id = req.header("X-Tenant-Id");
      if (!id) return res.status(400).json({ error: "X-Tenant-Id header required with the platform key" });
      const t = await tenantById(id);
      if (!t) return res.status(404).json({ error: "tenant not found" });
      Object.assign(req, { tenant: t, isPlatformAdmin: true, role: "owner" });
      return next();
    }
    const [t] = await db().select().from(schema.tenants).where(eq(schema.tenants.apiKeyHash, sha256Hex(token)));
    if (!t) return res.status(401).json({ error: "invalid api key" });
    Object.assign(req, { tenant: t, role: "owner" });
    return next();
  }

  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  if (!passesCsrf(req)) return res.status(403).json({ error: "missing X-Requested-With header" });
  req.user = user;
  if (user.role === "platform_admin") {
    // Query fallback lets <audio src> load recordings while an admin views a client.
    const id = req.header("X-Tenant-Id") ?? (req.method === "GET" && typeof req.query.tenantId === "string" ? req.query.tenantId : undefined);
    if (!id) return res.status(400).json({ error: "choose a client first (X-Tenant-Id)" });
    const t = await tenantById(id);
    if (!t) return res.status(404).json({ error: "tenant not found" });
    Object.assign(req, { tenant: t, isPlatformAdmin: true, role: "owner" });
    return next();
  }
  const t = user.tenantId ? await tenantById(user.tenantId) : null;
  if (!t) return res.status(403).json({ error: "account has no client" });
  Object.assign(req, { tenant: t, role: user.role === "owner" ? "owner" : "member" });
  next();
}

export function requireOwner(req: Request, res: Response, next: NextFunction) {
  if (req.role !== "owner") return res.status(403).json({ error: "only account owners can do this" });
  next();
}

/** Wrap async handlers: errors become JSON 400/500 instead of crashing. */
export const h =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);
