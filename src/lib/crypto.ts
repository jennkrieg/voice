import crypto from "node:crypto";
import { env } from "../env.js";

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(12).toString("base64url")}`;
}

export function newSecret(prefix = "", bytes = 24): string {
  return prefix + crypto.randomBytes(bytes).toString("base64url");
}

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function hmacHex(secret: string, value: string): string {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

let cachedKey: Buffer | null = null;
function encryptionKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = env.ENCRYPTION_KEY;
  if (!raw) {
    if (process.env.NODE_ENV === "production") throw new Error("ENCRYPTION_KEY is required in production");
    // Dev-only fallback so the project runs out of the box. Never use in production.
    cachedKey = crypto.createHash("sha256").update("dev-only-insecure-key").digest();
    return cachedKey;
  }
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY must decode to 32 bytes (64 hex chars or base64)");
  cachedKey = key;
  return key;
}

/** AES-256-GCM. Output: base64(iv | tag | ciphertext). */
export function encryptJson(value: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export function decryptJson<T = Record<string, unknown>>(blob: string): T {
  const buf = Buffer.from(blob, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  const pt = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
  return JSON.parse(pt.toString("utf8")) as T;
}

/** Short-lived signed token (used for OAuth state and media-stream auth). */
export function signToken(payload: Record<string, unknown>, ttlSeconds: number): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlSeconds * 1000 })).toString("base64url");
  const sig = crypto.createHmac("sha256", encryptionKey()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyToken<T = Record<string, unknown>>(token: string): T | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = crypto.createHmac("sha256", encryptionKey()).update(body).digest("base64url");
  if (!safeEqual(sig, expected)) return null;
  const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (typeof data.exp !== "number" || data.exp < Date.now()) return null;
  return data as T;
}
