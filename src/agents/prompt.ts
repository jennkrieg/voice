import { DateTime } from "luxon";
import type Anthropic from "@anthropic-ai/sdk";
import type { AgentConfig } from "./config.js";
import type { Contact } from "../db/schema.js";

export type Channel = "voice" | "sms";

const VOICE_RULES = `You are on a live phone call. Everything you write is converted to speech.
- Talk like a friendly, competent receptionist: short sentences, contractions, one question at a time.
- Usually reply in one to three sentences. Never use lists, markdown, emoji, or symbols that don't read aloud.
- Say times and dates the way people say them ("Tuesday at two thirty"), and read phone numbers in small groups.
- If you didn't catch something, ask them to repeat it. Spell back emails letter by letter to confirm.
- If someone asks whether you're a real person, say honestly that you're an AI assistant.
- Only state facts from the business information below or from tool results. If you don't know, say so and offer to have someone follow up or to transfer them.
- Before booking, confirm the exact day, time, and name. After a tool call, tell the caller the result in plain words.
- When the conversation is done, say a short goodbye and call end_call.`;

const SMS_RULES = `You are replying to text messages (SMS) on behalf of the business.
- Keep each reply short (under 300 characters when possible), friendly, and plain text. No markdown.
- If someone asks whether you're a real person, say honestly that you're an AI assistant.
- Only state facts from the business information below or from tool results. If you don't know, say a team member will follow up.
- Before booking, confirm the exact day, time, and name.
- If they text STOP or ask not to be contacted, don't argue; the system handles opt-outs.`;

/** Stable per agent: cached across turns and calls. */
export function stableSystem(cfg: AgentConfig, channel: Channel): string {
  return [
    `You are ${cfg.agentName}, the AI assistant for ${cfg.businessName}.`,
    channel === "voice" ? VOICE_RULES : SMS_RULES,
    `# What you're here to do\n${cfg.instructions}`,
    cfg.knowledge ? `# Business information\n${cfg.knowledge}` : "",
    cfg.transferTargets.length && channel === "voice"
      ? `# People you can transfer to\n${cfg.transferTargets.map((t) => `- ${t.key}: ${t.description}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Per call/thread context. */
export function sessionContext(opts: {
  cfg: AgentConfig;
  channel: Channel;
  direction: "inbound" | "outbound";
  contact: Contact | null;
  now?: DateTime;
}): string {
  const now = (opts.now ?? DateTime.now()).setZone(opts.cfg.timezone);
  const c = opts.contact;
  const known = c
    ? [
        c.firstName || c.lastName ? `Name: ${[c.firstName, c.lastName].filter(Boolean).join(" ")}` : "Name: unknown",
        `Phone: ${c.phone}`,
        c.email ? `Email: ${c.email}` : "Email: unknown",
        ...Object.entries((c.fields ?? {}) as Record<string, unknown>)
          .slice(0, 20)
          .map(([k, v]) => `${k}: ${String(v)}`),
      ].join("\n")
    : "Nothing known yet.";
  const what =
    opts.channel === "voice"
      ? opts.direction === "outbound"
        ? "You placed this call to the person below."
        : "The person below called the business."
      : "You are texting with the person below.";
  return `# This conversation\n${what}\nCurrent date and time: ${now.toFormat("cccc, LLLL d, yyyy, h:mm a")} (${opts.cfg.timezone}).\n\n# What we know about them\n${known}`;
}

export function buildSystem(stable: string, context: string): Anthropic.Beta.BetaTextBlockParam[] {
  return [
    { type: "text", text: stable, cache_control: { type: "ephemeral" } },
    { type: "text", text: context },
  ];
}
