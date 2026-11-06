import { z } from "zod";
import { DateTime } from "luxon";
import type Anthropic from "@anthropic-ai/sdk";
import type { AgentConfig } from "./config.js";
import { fillTemplate } from "./config.js";
import type { Contact } from "../db/schema.js";
import type { CalendarProvider } from "../integrations/calendar/types.js";
import type { CrmProvider } from "../integrations/crm/types.js";
import { pickSpread, spokenTime } from "../integrations/calendar/slots.js";
import { applyContactUpdates } from "../contacts.js";
import { emitEvent } from "../integrations/webhooks.js";
import type { Channel } from "./prompt.js";
import { errMsg, log } from "../lib/log.js";

export interface AgentRuntime {
  tenantId: string;
  agentId: string;
  cfg: AgentConfig;
  channel: Channel;
  contact: Contact;
  calendar: CalendarProvider | null;
  crm: { id: string; crm: CrmProvider } | null;
  callId?: string;
  /** Sends a text to the contact from the agent's number. */
  sendSms?: (body: string) => Promise<void>;
  /** Sends an email to the contact (only when an email integration is configured). */
  sendEmail?: (subject: string, body: string, assetKeys: string[]) => Promise<void>;
  /** Voice-only controls, executed after the agent finishes speaking. */
  requestTransfer?: (target: AgentConfig["transferTargets"][number], reason: string) => void;
  requestHangup?: (reason: string) => void;
  /** Called after any successful booking. */
  onBooked?: (b: { id: string; start: string; when: string }) => void;
}

type ToolImpl = {
  def: Anthropic.Beta.BetaTool;
  schema: z.ZodType;
  run: (input: any) => Promise<unknown>;
};

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export function buildTools(rt: AgentRuntime): Map<string, ToolImpl> {
  const tools = new Map<string, ToolImpl>();
  const add = (t: ToolImpl) => tools.set(t.def.name, { ...t, def: { ...t.def, eager_input_streaming: true } });
  const tz = rt.cfg.timezone;
  const assets = rt.cfg.followUp.assets;

  if (rt.calendar) {
    const calendar = rt.calendar;
    add({
      def: {
        name: "check_availability",
        description:
          "Find open appointment times. Use before offering times. Returns a short list of open start times between the two dates (inclusive). Offer two or three, not the whole list.",
        input_schema: {
          type: "object",
          properties: {
            start_date: { type: "string", description: "First day to search, YYYY-MM-DD, in the business timezone" },
            end_date: { type: "string", description: "Last day to search, YYYY-MM-DD. Defaults to start_date + 3 days" },
            preferred_time_of_day: { type: "string", enum: ["morning", "afternoon", "evening", "any"] },
          },
          required: ["start_date"],
          additionalProperties: false,
        },
      },
      schema: z.object({
        start_date: ymd,
        end_date: ymd.optional(),
        preferred_time_of_day: z.enum(["morning", "afternoon", "evening", "any"]).optional(),
      }),
      run: async (i: { start_date: string; end_date?: string; preferred_time_of_day?: string }) => {
        const now = DateTime.now().setZone(tz);
        const maxEnd = now.plus({ days: rt.cfg.calendar.maxDaysAhead }).endOf("day");
        let from = DateTime.fromISO(i.start_date, { zone: tz }).startOf("day");
        if (from < now) from = now;
        let to = (i.end_date ? DateTime.fromISO(i.end_date, { zone: tz }) : from.plus({ days: 3 })).endOf("day");
        if (to > maxEnd) to = maxEnd;
        if (from > to) return { slots: [], note: `Bookings are only available up to ${rt.cfg.calendar.maxDaysAhead} days ahead.` };
        let slots = await calendar.openSlots(from, to, rt.cfg.calendar, tz);
        const pref = i.preferred_time_of_day;
        if (pref && pref !== "any") {
          const f = slots.filter((s) => (pref === "morning" ? s.hour < 12 : pref === "afternoon" ? s.hour >= 12 && s.hour < 17 : s.hour >= 17));
          if (f.length) slots = f;
        }
        const picked = pickSpread(slots, 6);
        return {
          timezone: tz,
          slots: picked.map((s) => ({ start: s.toISO(), spoken: spokenTime(s) })),
          total_open: slots.length,
          ...(calendar.requiresEmail ? { note: "Booking requires the person's email address." } : {}),
        };
      },
    });

    add({
      def: {
        name: "book_appointment",
        description: "Book an appointment at an exact start time returned by check_availability, after the person confirmed it.",
        input_schema: {
          type: "object",
          properties: {
            start: { type: "string", description: "ISO start time exactly as returned by check_availability" },
            name: { type: "string", description: "Full name of the person" },
            email: { type: "string", description: calendar.requiresEmail ? "Email address (required)" : "Email address, if they gave one" },
            notes: { type: "string", description: "What the appointment is about, in a sentence" },
          },
          required: calendar.requiresEmail ? ["start", "name", "email"] : ["start", "name"],
          additionalProperties: false,
        },
      },
      schema: z.object({ start: z.string(), name: z.string().min(1), email: z.string().email().optional(), notes: z.string().optional() }),
      run: async (i: { start: string; name: string; email?: string; notes?: string }) => {
        const start = DateTime.fromISO(i.start, { setZone: true }).setZone(tz);
        if (!start.isValid) throw new Error("Invalid start time");
        const res = await calendar.book(
          {
            start,
            title: fillTemplate(rt.cfg.calendar.eventTitle, { name: i.name }),
            description: [i.notes, `Phone: ${rt.contact.phone}`, `Booked by ${rt.cfg.agentName} (AI) via ${rt.channel}`].filter(Boolean).join("\n"),
            attendee: { name: i.name, email: i.email ?? rt.contact.email ?? undefined, phone: rt.contact.phone },
          },
          rt.cfg.calendar,
          tz,
        );
        const when = spokenTime(start);
        const [first, ...rest] = i.name.trim().split(/\s+/);
        const updates: Record<string, string> = {};
        if (!rt.contact.firstName && first) updates.first_name = first;
        if (!rt.contact.lastName && rest.length) updates.last_name = rest.join(" ");
        if (!rt.contact.email && i.email) updates.email = i.email;
        if (Object.keys(updates).length) rt.contact = await applyContactUpdates(rt.contact, updates, rt.crm);
        if (rt.crm && rt.contact.crmExternalId) {
          rt.crm.crm.addNote(rt.contact.crmExternalId, `Appointment booked by AI agent for ${when} (${tz}).${i.notes ? `\n${i.notes}` : ""}`).catch((e) => log.warn("CRM note failed", { error: errMsg(e) }));
        }
        void emitEvent(rt.tenantId, "appointment.booked", { agentId: rt.agentId, callId: rt.callId, contactId: rt.contact.id, bookingId: res.id, start: res.start, end: res.end, name: i.name, email: i.email });
        rt.onBooked?.({ id: res.id, start: res.start, when });
        return { booked: true, when, booking_id: res.id };
      },
    });
  }

  const fields = rt.cfg.crm.updatableFields;
  const fieldNames = Object.keys(fields);
  if (fieldNames.length) {
    add({
      def: {
        name: "update_contact",
        description: "Save details the person told you (name, email, and the other fields listed) to their record. Only include fields they actually gave you.",
        input_schema: {
          type: "object",
          properties: Object.fromEntries(fieldNames.map((f) => [f, { type: "string", description: fields[f] }])),
          additionalProperties: false,
        },
      },
      schema: z.record(z.string(), z.string()).refine((o) => Object.keys(o).every((k) => fieldNames.includes(k)), "unknown field"),
      run: async (i: Record<string, string>) => {
        rt.contact = await applyContactUpdates(rt.contact, i, rt.crm);
        void emitEvent(rt.tenantId, "contact.updated", { agentId: rt.agentId, contactId: rt.contact.id, crmExternalId: rt.contact.crmExternalId, updates: i });
        return { saved: Object.keys(i) };
      },
    });
  }

  add({
    def: {
      name: "set_do_not_contact",
      description: "Use when the person asks not to be called or texted again. Then confirm politely and end the conversation.",
      input_schema: { type: "object", properties: { reason: { type: "string" } }, additionalProperties: false },
    },
    schema: z.object({ reason: z.string().optional() }),
    run: async () => {
      rt.contact = await applyContactUpdates(rt.contact, { do_not_call: "true", do_not_text: "true" }, rt.crm);
      return { done: true };
    },
  });

  if (rt.sendSms && (rt.channel === "sms" || rt.cfg.sms.allowDuringCalls)) {
    const send = rt.sendSms;
    add({
      def: {
        name: "send_text_message",
        description:
          (rt.channel === "voice"
            ? "Text the caller something useful during the call (a link, address, or summary). Tell them you're sending it."
            : "Send an additional, separate text message. Normally just reply in plain text instead.") +
          (assets.length ? ` Resource links you can include:\n${assets.map((a) => `- ${a.title}: ${a.url}`).join("\n")}` : ""),
        input_schema: { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false },
      },
      schema: z.object({ message: z.string().min(1).max(1200) }),
      run: async (i: { message: string }) => {
        if (rt.contact.doNotText) return { sent: false, reason: "This person opted out of texts." };
        await send(i.message);
        return { sent: true };
      },
    });
  }

  if (rt.sendEmail) {
    const send = rt.sendEmail;
    add({
      def: {
        name: "send_email",
        description:
          "Email the person. Use to send resources they asked for or agreed to receive" +
          (assets.length ? `. Available resources:\n${assets.map((a) => `- ${a.key}: ${a.title}. ${a.description}`).join("\n")}` : "") +
          "\nIf you don't have their email yet, ask for it and confirm the spelling first.",
        input_schema: {
          type: "object",
          properties: {
            email: { type: "string", description: "Their email address, if not already on file or if they gave a new one" },
            subject: { type: "string" },
            body: { type: "string", description: "Short, warm plain-text email body. Sign off as the business." },
            ...(assets.length ? { resources: { type: "array", items: { type: "string", enum: assets.map((a) => a.key) } } } : {}),
          },
          required: ["subject", "body"],
          additionalProperties: false,
        },
      },
      schema: z.object({ email: z.string().email().optional(), subject: z.string().min(1), body: z.string().min(1), resources: z.array(z.string()).optional() }),
      run: async (i: { email?: string; subject: string; body: string; resources?: string[] }) => {
        if (i.email && i.email !== rt.contact.email) rt.contact = await applyContactUpdates(rt.contact, { email: i.email }, rt.crm);
        if (!rt.contact.email) return { sent: false, reason: "No email address on file. Ask for it first." };
        await send(i.subject, i.body, i.resources ?? []);
        return { sent: true, to: rt.contact.email };
      },
    });
  }

  if (rt.channel === "voice") {
    if (rt.cfg.transferTargets.length && rt.requestTransfer) {
      const request = rt.requestTransfer;
      add({
        def: {
          name: "transfer_call",
          description: "Transfer the caller to a person. Say a short line like 'Let me connect you now' first; the transfer happens after you finish speaking.",
          input_schema: {
            type: "object",
            properties: {
              target: { type: "string", enum: rt.cfg.transferTargets.map((t) => t.key) },
              reason: { type: "string", description: "One sentence for the person receiving the call" },
            },
            required: ["target", "reason"],
            additionalProperties: false,
          },
        },
        schema: z.object({ target: z.string(), reason: z.string() }),
        run: async (i: { target: string; reason: string }) => {
          const t = rt.cfg.transferTargets.find((x) => x.key === i.target);
          if (!t) throw new Error(`Unknown transfer target ${i.target}`);
          request(t, i.reason);
          return { transferring: true };
        },
      });
    }
    if (rt.requestHangup) {
      const hangup = rt.requestHangup;
      add({
        def: {
          name: "end_call",
          description: "Hang up after your goodbye. Use when the conversation is finished, it's a wrong number, or you reached voicemail.",
          input_schema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"], additionalProperties: false },
        },
        schema: z.object({ reason: z.string() }),
        run: async (i: { reason: string }) => {
          hangup(i.reason);
          return { ending: true };
        },
      });
    }
  }
  return tools;
}
