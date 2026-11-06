import { and, eq, inArray, lte, sql, or, isNull } from "drizzle-orm";
import { DateTime } from "luxon";
import { env } from "../env.js";
import { db, schema } from "../db/index.js";
import type { Contact } from "../db/schema.js";
import { newId } from "../lib/crypto.js";
import { log, errMsg } from "../lib/log.js";
import { parseAgentConfig, type AgentConfig } from "../agents/config.js";
import { nextAllowedCallTime } from "./calling-window.js";
import { twilioClient } from "../telephony/twilio-client.js";
import { addCallEvent } from "../calls.js";

export async function agentNumber(agentId: string): Promise<string | null> {
  const [n] = await db().select().from(schema.phoneNumbers).where(eq(schema.phoneNumbers.agentId, agentId)).limit(1);
  return n?.e164 ?? null;
}

export type EnqueueResult = { queued: true; callId: string; scheduledFor: string } | { queued: false; reason: string };

/**
 * Queue an outbound call. Applies do-not-call, de-duplication and the agent's calling hours
 * (in the contact's timezone when known). `force` skips de-dup and hours (for test calls only).
 */
export async function enqueueCall(opts: {
  tenantId: string;
  agentId: string;
  contact: Contact;
  reason?: string;
  notBefore?: Date;
  force?: boolean;
  attempt?: number;
  metadata?: Record<string, unknown>;
}): Promise<EnqueueResult> {
  const [agent] = await db().select().from(schema.agents).where(and(eq(schema.agents.id, opts.agentId), eq(schema.agents.tenantId, opts.tenantId)));
  if (!agent) return { queued: false, reason: "agent not found" };
  const cfg = parseAgentConfig(agent.config);
  const c = opts.contact;
  if (c.doNotCall) return { queued: false, reason: "contact is on do-not-call" };
  const from = await agentNumber(opts.agentId);
  if (!from) return { queued: false, reason: "agent has no phone number assigned" };

  if (!opts.force) {
    const open = await db()
      .select({ id: schema.calls.id })
      .from(schema.calls)
      .where(and(eq(schema.calls.contactId, c.id), inArray(schema.calls.status, ["queued", "dialing", "in_progress"])))
      .limit(1);
    if (open.length) return { queued: false, reason: "a call to this contact is already queued or in progress" };
    if (c.lastCallAt && cfg.dialer.minHoursBetweenCalls > 0 && (opts.attempt ?? 1) === 1) {
      const hours = (Date.now() - c.lastCallAt.getTime()) / 3_600_000;
      if (hours < cfg.dialer.minHoursBetweenCalls) return { queued: false, reason: `called ${hours.toFixed(1)}h ago` };
    }
  }

  let when: DateTime = DateTime.fromJSDate(opts.notBefore ?? new Date());
  if (!opts.force) when = nextAllowedCallTime(when, cfg.dialer.callingHours, c.timezone || cfg.timezone);
  const id = newId("call");
  await db().insert(schema.calls).values({
    id,
    tenantId: opts.tenantId,
    agentId: opts.agentId,
    contactId: c.id,
    direction: "outbound",
    fromNumber: from,
    toNumber: c.phone,
    status: "queued",
    scheduledFor: when.toJSDate(),
    attempt: opts.attempt ?? 1,
    reason: opts.reason ?? null,
    metadata: { ...(opts.metadata ?? {}), force: !!opts.force },
  });
  await addCallEvent({ id, tenantId: opts.tenantId }, "call.queued", { scheduledFor: when.toISO(), reason: opts.reason });
  return { queued: true, callId: id, scheduledFor: when.toUTC().toISO()! };
}

/** Place one queued call. Claims it atomically so two workers never dial the same call. */
async function place(callId: string, cfg: AgentConfig) {
  const [claimed] = await db()
    .update(schema.calls)
    .set({ status: "dialing" })
    .where(and(eq(schema.calls.id, callId), eq(schema.calls.status, "queued")))
    .returning();
  if (!claimed) return;
  const base = env.PUBLIC_BASE_URL;
  try {
    const call = await twilioClient().calls.create({
      to: claimed.toNumber,
      from: claimed.fromNumber,
      url: `${base}/twilio/outbound-answer?callId=${encodeURIComponent(callId)}`,
      method: "POST",
      statusCallback: `${base}/twilio/status?callId=${encodeURIComponent(callId)}`,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      ...(env.TWILIO_MACHINE_DETECTION && cfg.dialer.leaveVoicemail ? { machineDetection: "DetectMessageEnd" } : {}),
      timeout: 25,
    });
    await db().update(schema.calls).set({ twilioCallSid: call.sid }).where(eq(schema.calls.id, callId));
    if (claimed.contactId) await db().update(schema.contacts).set({ lastCallAt: new Date() }).where(eq(schema.contacts.id, claimed.contactId));
    await addCallEvent(claimed, "call.dialing", { twilioCallSid: call.sid });
  } catch (e) {
    log.error("failed to place call", { callId, error: errMsg(e) });
    await db().update(schema.calls).set({ status: "failed", reason: errMsg(e).slice(0, 300) }).where(eq(schema.calls.id, callId));
    await addCallEvent(claimed, "call.failed", { error: errMsg(e) });
  }
}

/** Polls the queue. Single-process by default; the atomic claim makes multiple workers safe. */
export function startDialer(intervalMs = 5000) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const due = await db()
        .select()
        .from(schema.calls)
        .where(and(eq(schema.calls.status, "queued"), or(isNull(schema.calls.scheduledFor), lte(schema.calls.scheduledFor, new Date()))))
        .orderBy(schema.calls.scheduledFor)
        .limit(25);
      const agentCache = new Map<string, AgentConfig>();
      for (const call of due) {
        let cfg = agentCache.get(call.agentId);
        if (!cfg) {
          const [a] = await db().select().from(schema.agents).where(eq(schema.agents.id, call.agentId));
          if (!a) continue;
          cfg = parseAgentConfig(a.config);
          agentCache.set(call.agentId, cfg);
        }
        const [{ active }] = await db()
          .select({ active: sql<number>`count(*)::int` })
          .from(schema.calls)
          .where(and(eq(schema.calls.agentId, call.agentId), inArray(schema.calls.status, ["dialing", "in_progress"])));
        if (active >= cfg.dialer.maxConcurrentCalls) continue;
        await place(call.id, cfg);
      }
    } catch (e) {
      log.error("dialer tick failed", { error: errMsg(e) });
    } finally {
      running = false;
    }
  };
  const t = setInterval(tick, intervalMs);
  void tick();
  return () => clearInterval(t);
}
