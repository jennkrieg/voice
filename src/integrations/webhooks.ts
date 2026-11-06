import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { hmacHex, decryptJson } from "../lib/crypto.js";
import { log, errMsg } from "../lib/log.js";

export type PlatformEvent =
  | "call.started"
  | "call.completed"
  | "appointment.booked"
  | "contact.updated"
  | "sms.received"
  | "sms.sent"
  | "transfer.started";

/**
 * Sends events to every "webhook" integration the tenant configured
 * (Zapier, Make, n8n, a GoHighLevel workflow trigger, or the client's own backend).
 * Body is signed: X-Signature: sha256=<hex HMAC of the raw body with the integration's signing secret>.
 */
export async function emitEvent(tenantId: string, type: PlatformEvent, data: Record<string, unknown>) {
  const hooks = await db()
    .select()
    .from(schema.integrations)
    .where(and(eq(schema.integrations.tenantId, tenantId), eq(schema.integrations.kind, "webhook")));
  await Promise.all(
    hooks.map(async (h) => {
      const settings = h.settings as { url?: string; events?: string[] };
      if (!settings.url) return;
      if (settings.events?.length && !settings.events.includes(type)) return;
      const secret = h.secretsEnc ? decryptJson<{ signingSecret: string }>(h.secretsEnc).signingSecret : "";
      const body = JSON.stringify({ type, tenantId, occurredAt: new Date().toISOString(), data });
      try {
        const res = await fetch(settings.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Signature": `sha256=${hmacHex(secret, body)}`, "X-Event-Type": type },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) log.warn("webhook delivery failed", { integrationId: h.id, status: res.status, type });
      } catch (e) {
        log.warn("webhook delivery error", { integrationId: h.id, type, error: errMsg(e) });
      }
    }),
  );
}
