import express from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { env } from "../env.js";
import { db, schema } from "../db/index.js";
import { verifyPassword } from "../lib/password.js";
import { findUserByEmail, publicUser, setPassword } from "../users.js";
import { setSessionCookie, clearSessionCookie, sessionUser, passesCsrf } from "./session.js";
import { h } from "./auth.js";

export function branding() {
  return { name: env.BRAND_NAME, logoUrl: env.BRAND_LOGO_URL ?? null, primaryColor: env.BRAND_PRIMARY_COLOR, supportEmail: env.BRAND_SUPPORT_EMAIL ?? null };
}

// Simple in-memory limiter: 10 failed attempts per email+IP per 15 minutes.
const failures = new Map<string, { count: number; until: number }>();
function limited(key: string) {
  const f = failures.get(key);
  return !!f && f.until > Date.now() && f.count >= 10;
}
function fail(key: string) {
  const f = failures.get(key);
  const now = Date.now();
  failures.set(key, f && f.until > now ? { count: f.count + 1, until: f.until } : { count: 1, until: now + 15 * 60_000 });
}

export function authRouter() {
  const r = express.Router();
  r.use(express.json());

  r.get("/branding", (_req, res) => res.json(branding()));

  r.post(
    "/login",
    h(async (req, res) => {
      const body = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
      const key = `${body.email.toLowerCase()}|${req.ip}`;
      if (limited(key)) return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
      const user = await findUserByEmail(body.email);
      if (!user || !verifyPassword(body.password, user.passwordHash)) {
        fail(key);
        return res.status(401).json({ error: "Wrong email or password" });
      }
      failures.delete(key);
      await db().update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, user.id));
      setSessionCookie(req, res, user);
      res.json({ user: publicUser(user) });
    }),
  );

  r.post("/logout", (_req, res) => {
    clearSessionCookie(res);
    res.sendStatus(204);
  });

  r.get(
    "/me",
    h(async (req, res) => {
      const user = await sessionUser(req);
      if (!user) return res.status(401).json({ error: "not signed in", branding: branding() });
      const tenant = user.tenantId ? (await db().select().from(schema.tenants).where(eq(schema.tenants.id, user.tenantId)))[0] : null;
      res.json({ user: publicUser(user), tenant: tenant ? { id: tenant.id, name: tenant.name, timezone: tenant.timezone } : null, branding: branding() });
    }),
  );

  r.post(
    "/password",
    h(async (req, res) => {
      const user = await sessionUser(req);
      if (!user) return res.status(401).json({ error: "not signed in" });
      if (!passesCsrf(req)) return res.status(403).json({ error: "missing X-Requested-With header" });
      const body = z.object({ currentPassword: z.string(), newPassword: z.string().min(10, "Use at least 10 characters") }).parse(req.body);
      if (!verifyPassword(body.currentPassword, user.passwordHash)) return res.status(400).json({ error: "Current password is wrong" });
      await setPassword(user.id, body.newPassword);
      const [fresh] = await db().select().from(schema.users).where(eq(schema.users.id, user.id));
      setSessionCookie(req, res, fresh); // other sessions are now invalid
      res.json({ ok: true });
    }),
  );
  return r;
}
