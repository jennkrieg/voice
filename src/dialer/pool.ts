import { and, eq, gte, inArray, sql, desc, isNotNull } from "drizzle-orm";
import { DateTime } from "luxon";
import { env } from "../env.js";
import { db, schema } from "../db/index.js";
import type { PhoneNumberRow, Tenant } from "../db/schema.js";
import type { AgentConfig } from "../agents/config.js";
import { newId } from "../lib/crypto.js";
import { log, errMsg } from "../lib/log.js";
import { areaCodeOf } from "../lib/area-codes.js";
import { twilioClient } from "../telephony/twilio-client.js";
import { registerNumberWithTrustHub } from "../telephony/trust.js";
import { pickCallerId, classifyHealth, type PoolNumber, type CallerIdReason } from "./caller-id.js";

export const numberWebhooks = () => ({
  voiceUrl: `${env.PUBLIC_BASE_URL}/twilio/voice`,
  voiceMethod: "POST",
  statusCallback: `${env.PUBLIC_BASE_URL}/twilio/status`,
  statusCallbackMethod: "POST",
  smsUrl: `${env.PUBLIC_BASE_URL}/twilio/sms`,
  smsMethod: "POST",
});

/** Buy a number, point it at us, save it, and register it with the tenant's Trust Hub products. */
export async function buyNumber(tenant: Tenant, phoneNumber: string, opts: { agentId?: string | null; region?: string | null; locality?: string | null; friendlyName?: string }) {
  const bought = await twilioClient().incomingPhoneNumbers.create({ phoneNumber, friendlyName: opts.friendlyName ?? tenant.name, ...numberWebhooks() });
  const [row] = await db()
    .insert(schema.phoneNumbers)
    .values({ id: newId("num"), tenantId: tenant.id, agentId: opts.agentId ?? null, e164: bought.phoneNumber, twilioSid: bought.sid, friendlyName: bought.friendlyName, region: opts.region ?? null, locality: opts.locality ?? null })
    .returning();
  await registerNumberWithTrustHub(tenant, row).catch((e) => log.warn("trust registration failed", { error: errMsg(e) }));
  return row;
}

/** Outbound calls placed today (in the agent's timezone) per caller-ID number. */
async function usageToday(numbers: string[], timezone: string): Promise<Map<string, number>> {
  if (!numbers.length) return new Map();
  const start = DateTime.now().setZone(timezone).startOf("day").toJSDate();
  const rows = await db()
    .select({ from: schema.calls.fromNumber, n: sql<number>`count(*)::int` })
    .from(schema.calls)
    .where(and(eq(schema.calls.direction, "outbound"), inArray(schema.calls.fromNumber, numbers), gte(schema.calls.dialedAt, start)))
    .groupBy(schema.calls.fromNumber);
  return new Map(rows.map((r) => [r.from, r.n]));
}

async function previousCallerId(contactId: string | null): Promise<string | null> {
  if (!contactId) return null;
  const [r] = await db()
    .select({ from: schema.calls.fromNumber })
    .from(schema.calls)
    .where(and(eq(schema.calls.contactId, contactId), eq(schema.calls.direction, "outbound"), isNotNull(schema.calls.dialedAt)))
    .orderBy(desc(schema.calls.dialedAt))
    .limit(1);
  return r?.from ?? null;
}

/** If enabled and there's room in the pool, buy a number in (or near) the contact's area code. */
async function maybeAutoBuy(tenant: Tenant, agentId: string, cfg: AgentConfig, pool: PhoneNumberRow[], contactPhone: string): Promise<PhoneNumberRow | null> {
  const lp = cfg.dialer.localPresence;
  const ac = areaCodeOf(contactPhone);
  if (!lp.enabled || !lp.autoBuy || !ac || pool.length >= lp.maxPoolSize) return null;
  if (pool.some((n) => areaCodeOf(n.e164) === ac)) return null;
  try {
    const local = twilioClient().availablePhoneNumbers("US").local;
    let [hit] = await local.list({ areaCode: Number(ac), voiceEnabled: true, smsEnabled: true, limit: 1 });
    if (!hit) [hit] = await local.list({ nearNumber: contactPhone, distance: 50, voiceEnabled: true, smsEnabled: true, limit: 1 });
    if (!hit) return null;
    const row = await buyNumber(tenant, hit.phoneNumber, { agentId, region: hit.region, locality: hit.locality, friendlyName: `${tenant.name} (local ${ac})` });
    log.info("auto-bought local number", { tenantId: tenant.id, agentId, number: row.e164 });
    return row;
  } catch (e) {
    log.warn("auto-buy failed", { areaCode: ac, error: errMsg(e) });
    return null;
  }
}

/** Decide which of the agent's numbers to call from. Returns null when every number is at its cap or resting. */
export async function chooseCallerId(opts: { tenant: Tenant; agentId: string; cfg: AgentConfig; contactPhone: string; contactId: string | null }): Promise<{ e164: string; reason: CallerIdReason } | null> {
  let pool = await db().select().from(schema.phoneNumbers).where(eq(schema.phoneNumbers.agentId, opts.agentId)).orderBy(schema.phoneNumbers.createdAt);
  const bought = await maybeAutoBuy(opts.tenant, opts.agentId, opts.cfg, pool, opts.contactPhone);
  if (bought) pool = [...pool, bought];
  const usage = await usageToday(pool.map((n) => n.e164), opts.cfg.timezone);
  const poolNums: PoolNumber[] = pool.map((n) => ({
    e164: n.e164,
    outboundEnabled: n.outboundEnabled,
    restedUntil: n.restedUntil,
    dailyCap: n.dailyCap ?? opts.cfg.dialer.perNumberDailyCap,
    usedToday: usage.get(n.e164) ?? 0,
  }));
  return pickCallerId({
    contactPhone: opts.contactPhone,
    pool: poolNums,
    businessNumber: opts.cfg.dialer.businessNumber ?? pool[0]?.e164,
    previousNumber: opts.cfg.dialer.stickyCallerId ? await previousCallerId(opts.contactId) : null,
    localPresence: opts.cfg.dialer.localPresence.enabled,
  });
}

/** Recompute 7-day health for every number; rest numbers that look spam-labelled when the agent allows it. */
export async function refreshNumberHealth() {
  const since = new Date(Date.now() - 7 * 86400_000);
  const c = schema.calls;
  const stats = await db()
    .select({
      from: c.fromNumber,
      attempts: sql<number>`count(*)::int`,
      answered: sql<number>`count(*) filter (where ${c.status} = 'completed' and coalesce(${c.answeredBy}, 'human') not like 'machine%')::int`,
      shortCalls: sql<number>`count(*) filter (where ${c.status} = 'completed' and coalesce(${c.durationSeconds}, 0) < 10)::int`,
    })
    .from(c)
    .where(and(eq(c.direction, "outbound"), gte(c.dialedAt, since)))
    .groupBy(c.fromNumber);
  const byNumber = new Map(stats.map((s) => [s.from, s]));
  const numbers = await db().select().from(schema.phoneNumbers);
  const agentCfg = new Map<string, AgentConfig>();
  for (const n of numbers) {
    const h = classifyHealth(byNumber.get(n.e164) ?? { attempts: 0, answered: 0, shortCalls: 0 });
    const patch: Partial<PhoneNumberRow> = { health: { ...h, checkedAt: new Date().toISOString() } };
    if (h.status === "at_risk" && n.agentId && (!n.restedUntil || n.restedUntil < new Date())) {
      let cfg = agentCfg.get(n.agentId);
      if (!cfg) {
        const [a] = await db().select().from(schema.agents).where(eq(schema.agents.id, n.agentId));
        if (a) {
          const { parseAgentConfig } = await import("../agents/config.js");
          cfg = parseAgentConfig(a.config);
          agentCfg.set(n.agentId, cfg);
        }
      }
      if (cfg?.dialer.autoRestFlaggedNumbers) {
        patch.restedUntil = new Date(Date.now() + 3 * 86400_000);
        log.warn("resting number with collapsing answer rate", { number: n.e164, answerRate: h.answerRate });
      }
    }
    await db().update(schema.phoneNumbers).set(patch).where(eq(schema.phoneNumbers.id, n.id));
  }
}
