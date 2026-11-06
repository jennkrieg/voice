import { and, eq, desc } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { db, schema } from "../db/index.js";
import { newId } from "../lib/crypto.js";
import { log, errMsg } from "../lib/log.js";
import { parseAgentConfig } from "../agents/config.js";
import { Conversation } from "../agents/conversation.js";
import { stableSystem, sessionContext, buildSystem } from "../agents/prompt.js";
import type { AgentRuntime } from "../agents/tools.js";
import { loadCalendar, loadCrm } from "../integrations/registry.js";
import { resolveContactByPhone, applyContactUpdates } from "../contacts.js";
import { emitEvent } from "../integrations/webhooks.js";
import { sendSms } from "./send.js";
import { sendEmail } from "../email/send.js";

const OPT_OUT = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|optout|opt out|revoke)\s*$/i;
const OPT_IN = /^\s*(start|unstop|yes)\s*$/i;

// One reply at a time per thread, so quick double-texts get one coherent answer.
const locks = new Map<string, Promise<void>>();

export async function handleInboundSms(p: { From: string; To: string; Body: string; MessageSid: string }) {
  const [num] = await db().select().from(schema.phoneNumbers).where(eq(schema.phoneNumbers.e164, p.To));
  if (!num) return log.warn("sms to unknown number", { to: p.To });
  const tenantId = num.tenantId;
  const agentRow = num.agentId ? (await db().select().from(schema.agents).where(eq(schema.agents.id, num.agentId)))[0] : null;
  const cfg = agentRow ? parseAgentConfig(agentRow.config) : null;
  const crm = cfg ? await loadCrm(tenantId, cfg.crm.integrationId).catch(() => null) : null;
  let contact = await resolveContactByPhone(tenantId, p.From, crm);

  await db().insert(schema.messages).values({
    id: newId("msg"),
    tenantId,
    agentId: agentRow?.id ?? null,
    contactId: contact.id,
    channel: "sms",
    direction: "inbound",
    fromNumber: p.From,
    toNumber: p.To,
    body: p.Body,
    twilioSid: p.MessageSid,
    status: "received",
  });
  void emitEvent(tenantId, "sms.received", { from: p.From, to: p.To, body: p.Body, contactId: contact.id, agentId: agentRow?.id });

  // Twilio handles the carrier-required STOP/START replies on long codes; we record the preference.
  if (OPT_OUT.test(p.Body)) {
    await applyContactUpdates(contact, { do_not_text: "true" }, null);
    return;
  }
  if (OPT_IN.test(p.Body) && contact.doNotText) {
    contact = await applyContactUpdates(contact, { do_not_text: "false" }, null);
    return;
  }
  if (!agentRow || !cfg || !cfg.sms.autoReply || contact.doNotText) return;

  const key = `${tenantId}:${contact.id}`;
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(() => reply(tenantId, agentRow.id, p.To, contact.id)).catch((e) => log.error("sms reply failed", { error: errMsg(e) }));
  locks.set(key, next);
  void next.finally(() => locks.get(key) === next && locks.delete(key));
}

async function reply(tenantId: string, agentId: string, agentNumber: string, contactId: string) {
  const [agentRow] = await db().select().from(schema.agents).where(eq(schema.agents.id, agentId));
  const cfg = parseAgentConfig(agentRow.config);
  const [contact] = await db().select().from(schema.contacts).where(eq(schema.contacts.id, contactId));
  const history = await db()
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.tenantId, tenantId), eq(schema.messages.contactId, contactId), eq(schema.messages.channel, "sms")))
    .orderBy(desc(schema.messages.createdAt))
    .limit(30);
  history.reverse();
  // Only reply if the latest message is still theirs (we may have answered already).
  if (!history.length || history.at(-1)!.direction !== "inbound") return;

  const [calendar, crm] = await Promise.all([
    loadCalendar(tenantId, cfg.calendar.integrationId).catch(() => null),
    loadCrm(tenantId, cfg.crm.integrationId).catch(() => null),
  ]);
  const rt: AgentRuntime = {
    tenantId,
    agentId,
    cfg,
    channel: "sms",
    contact,
    calendar,
    crm,
    sendSms: async (body) => {
      await sendSms({ tenantId, agentId, contactId, from: agentNumber, to: contact.phone, body });
    },
  };
  if (cfg.followUp.emailIntegrationId) {
    const integrationId = cfg.followUp.emailIntegrationId;
    rt.sendEmail = async (subject, body, keys) => {
      await sendEmail({ tenantId, integrationId, agentId, contactId, to: rt.contact.email!, subject, text: body, assets: cfg.followUp.assets.filter((a) => keys.includes(a.key)) });
    };
  }
  const conv = new Conversation(rt, buildSystem(stableSystem(cfg, "sms"), sessionContext({ cfg, channel: "sms", direction: "inbound", contact })));
  // Rebuild the thread as alternating turns (consecutive same-role texts are merged).
  const msgs: Anthropic.Beta.BetaMessageParam[] = [];
  for (const m of history) {
    const role = m.direction === "inbound" ? "user" : "assistant";
    const last = msgs.at(-1);
    if (last && last.role === role) last.content = `${last.content as string}\n${m.body}`;
    else msgs.push({ role, content: m.body });
  }
  if (msgs[0]?.role === "assistant") msgs.unshift({ role: "user", content: "[earlier conversation]" });
  conv.messages = msgs;

  const res = await conv.respond();
  const text = res.text.trim();
  if (text) await sendSms({ tenantId, agentId, contactId, from: agentNumber, to: contact.phone, body: text });
}
