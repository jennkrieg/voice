import type { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { env } from "../env.js";
import { db, schema } from "../db/index.js";
import type { Tenant } from "../db/schema.js";
import { safeEqual, sha256Hex } from "../lib/crypto.js";

declare module "express-serve-static-core" {
  interface Request {
    tenant?: Tenant;
    isPlatformAdmin?: boolean;
  }
}

function bearer(req: Request): string | null {
  const h = req.header("Authorization");
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

export function requirePlatformAdmin(req: Request, res: Response, next: NextFunction) {
  const token = bearer(req);
  if (!env.PLATFORM_ADMIN_KEY || !token || !safeEqual(token, env.PLATFORM_ADMIN_KEY)) return res.status(401).json({ error: "platform admin key required" });
  req.isPlatformAdmin = true;
  next();
}

/** Tenant API key, or the platform admin key plus an X-Tenant-Id header (to manage any client). */
export async function requireTenant(req: Request, res: Response, next: NextFunction) {
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: "missing bearer token" });
  if (env.PLATFORM_ADMIN_KEY && safeEqual(token, env.PLATFORM_ADMIN_KEY)) {
    const id = req.header("X-Tenant-Id");
    if (!id) return res.status(400).json({ error: "X-Tenant-Id header required with the platform key" });
    const [t] = await db().select().from(schema.tenants).where(eq(schema.tenants.id, id));
    if (!t) return res.status(404).json({ error: "tenant not found" });
    req.tenant = t;
    req.isPlatformAdmin = true;
    return next();
  }
  const [t] = await db().select().from(schema.tenants).where(eq(schema.tenants.apiKeyHash, sha256Hex(token)));
  if (!t) return res.status(401).json({ error: "invalid api key" });
  req.tenant = t;
  next();
}

/** Wrap async handlers: errors become JSON 400/500 instead of crashing. */
export const h =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);
