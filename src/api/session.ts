import type { Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { User } from "../db/schema.js";
import { signToken, verifyToken } from "../lib/crypto.js";

export const SESSION_COOKIE = "va_session";
const SESSION_DAYS = 14;

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function setSessionCookie(req: Request, res: Response, user: User) {
  const token = signToken({ uid: user.id, sv: user.sessionVersion }, SESSION_DAYS * 86400);
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure, maxAge: SESSION_DAYS * 86400_000, path: "/" });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

export async function sessionUser(req: Request): Promise<User | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const claims = verifyToken<{ uid: string; sv: number }>(token);
  if (!claims) return null;
  const [u] = await db().select().from(schema.users).where(eq(schema.users.id, claims.uid));
  if (!u || u.sessionVersion !== claims.sv) return null;
  return u;
}

/**
 * Cookie-authenticated requests that change data must carry this header. Browsers won't send a
 * custom header cross-site without a CORS preflight (which we never approve), so this blocks CSRF.
 */
export const CSRF_HEADER = "x-requested-with";
export function passesCsrf(req: Request): boolean {
  return ["GET", "HEAD", "OPTIONS"].includes(req.method) || !!req.header(CSRF_HEADER);
}
