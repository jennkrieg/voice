import { z } from "zod";

const hhmm = z.string().regex(/^\d{2}:\d{2}$/, "use HH:MM, 24h");
const DayKey = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export type DayKey = z.infer<typeof DayKey>;
export const BusinessHours = z.partialRecord(DayKey, z.array(z.tuple([hhmm, hhmm])));
export type BusinessHours = z.infer<typeof BusinessHours>;

const DEFAULT_HOURS: BusinessHours = {
  mon: [["09:00", "17:00"]],
  tue: [["09:00", "17:00"]],
  wed: [["09:00", "17:00"]],
  thu: [["09:00", "17:00"]],
  fri: [["09:00", "17:00"]],
};

export const TransferTarget = z.object({
  key: z.string().regex(/^[a-z0-9_]+$/, "lowercase letters, digits, underscores"),
  number: z.string(),
  description: z.string(),
});

export const AgentConfig = z.object({
  businessName: z.string(),
  agentName: z.string().default("Alex"),
  timezone: z.string().default("America/New_York"),
  language: z.string().default("en-US"),

  /** What the agent is for, how it should behave. Written by you or your client. */
  instructions: z.string().default("Answer questions about the business and book appointments."),
  /** Facts: services, prices, hours, address, FAQs. */
  knowledge: z.string().default(""),

  inboundGreeting: z
    .string()
    .default("Hi, thanks for calling {businessName}. This is {agentName}, a virtual assistant.{recordingNotice} How can I help?"),
  outboundGreeting: z
    .string()
    .default("Hi{firstNameComma} this is {agentName}, a virtual assistant calling from {businessName}.{recordingNotice} Do you have a minute?"),
  voicemailMessage: z
    .string()
    .default("Hi{firstNameComma} this is {agentName} from {businessName}. Sorry we missed you, we'll try again, or call us back at this number."),

  /** ElevenLabs voice. Try voices with GET /api/voices and POST /api/voices/preview. */
  voice: z
    .object({
      voiceId: z.string().optional(),
      model: z.string().optional(),
      /** 0-1. Lower = more expressive and varied, higher = steadier. */
      stability: z.number().min(0).max(1).default(0.45),
      similarityBoost: z.number().min(0).max(1).default(0.8),
      style: z.number().min(0).max(1).default(0.15),
      /** 0.7-1.2 */
      speed: z.number().min(0.7).max(1.2).default(1),
    })
    .prefault({ stability: 0.45, similarityBoost: 0.8, style: 0.15, speed: 1 }),

  /** Background sound under the agent's voice, to sound like a real office/cafe. */
  ambience: z
    .object({
      preset: z.enum(["none", "office", "call_center", "coffee_shop", "custom"]).default("none"),
      /** For "custom" (or to override a preset): https URL or local path to a WAV file. */
      url: z.string().optional(),
      /** 0-1. 0.08-0.15 sounds natural. */
      volume: z.number().min(0).max(1).default(0.12),
    })
    .prefault({ preset: "none", volume: 0.12 }),

  /** Resources the agent can send after or during a conversation. */
  followUp: z
    .object({
      assets: z
        .array(
          z.object({
            key: z.string().regex(/^[a-z0-9_]+$/),
            title: z.string(),
            /** When the agent should offer it. */
            description: z.string(),
            /** Public URL (PDF, page, video). */
            url: z.string().url(),
            /** Attach the file to emails (otherwise send the link). Max 10 MB. */
            attach: z.boolean().default(true),
          }),
        )
        .default([]),
      /** integrations.id of an email_smtp integration. */
      emailIntegrationId: z.string().optional(),
      /** After each call, let the AI write and send a personalised follow-up when it makes sense. */
      autoAfterCall: z
        .object({ sms: z.boolean().default(false), email: z.boolean().default(false) })
        .prefault({ sms: false, email: false }),
      /** Extra guidance for automatic follow-ups (tone, what to include, links to always add). */
      guidance: z.string().default(""),
    })
    .prefault({ assets: [], autoAfterCall: { sms: false, email: false }, guidance: "" }),

  transferTargets: z.array(TransferTarget).default([]),

  calendar: z
    .object({
      /** integrations.id of a google_calendar or calcom integration. */
      integrationId: z.string().optional(),
      eventTitle: z.string().default("Appointment with {name}"),
      durationMinutes: z.number().int().min(5).default(30),
      bufferMinutes: z.number().int().min(0).default(0),
      minNoticeMinutes: z.number().int().min(0).default(120),
      maxDaysAhead: z.number().int().min(1).max(90).default(14),
      /** Used for Google Calendar. Cal.com uses the availability configured in Cal.com. */
      businessHours: BusinessHours.default(DEFAULT_HOURS),
      /** Cal.com event type to book. */
      calcomEventTypeId: z.number().int().optional(),
    })
    .prefault({}),

  crm: z
    .object({
      /** integrations.id of a hubspot or gohighlevel integration. */
      integrationId: z.string().optional(),
      /** Fields the agent may update, as { crmFieldName: "what it means" }. */
      updatableFields: z.record(z.string(), z.string()).default({
        first_name: "First name",
        last_name: "Last name",
        email: "Email address",
      }),
      /** Optional CRM fields to write the call outcome / summary into after each call. */
      outcomeField: z.string().optional(),
      summaryField: z.string().optional(),
      /** Log each call as a note/activity on the CRM record. */
      logCalls: z.boolean().default(true),
    })
    .prefault({}),

  sms: z
    .object({
      /** Reply to inbound texts with the AI. */
      autoReply: z.boolean().default(true),
      /** Let the agent text the caller during a call (links, addresses, confirmations). */
      allowDuringCalls: z.boolean().default(true),
      /** Text a confirmation after a booking. Empty string disables. */
      bookingConfirmation: z
        .string()
        .default("You're booked with {businessName} for {when}. Reply here if you need to change it."),
      /** Text after a missed inbound call. Empty string disables. */
      missedCallText: z.string().default(""),
    })
    .prefault({}),

  dialer: z
    .object({
      maxConcurrentCalls: z.number().int().min(1).max(50).default(2),
      minHoursBetweenCalls: z.number().min(0).default(24),
      maxAttempts: z.number().int().min(1).max(5).default(2),
      retryAfterMinutes: z.number().int().min(5).default(120),
      /** Local time of the contact (or the agent timezone if unknown). Days: 1=Mon … 7=Sun. */
      callingHours: z
        .object({ start: hhmm.default("09:00"), end: hhmm.default("20:00"), days: z.array(z.number().int().min(1).max(7)).default([1, 2, 3, 4, 5, 6]) })
        .prefault({ start: "09:00", end: "20:00", days: [1, 2, 3, 4, 5, 6] }),
      leaveVoicemail: z.boolean().default(true),
    })
    .prefault({}),

  behaviour: z
    .object({
      fillerPhrase: z.string().default("One moment."),
      silenceTimeoutSeconds: z.number().min(3).default(8),
      maxCallMinutes: z.number().min(1).default(15),
      /** Record every call (dual channel). Check recording-consent laws; disclose it in the greeting. */
      recordCalls: z.boolean().default(true),
      /** Run an AI review (score + coaching notes) on every completed call. */
      reviewCalls: z.boolean().default(true),
    })
    .prefault({}),
});

export type AgentConfig = z.infer<typeof AgentConfig>;
export type AgentConfigInput = z.input<typeof AgentConfig>;

export function parseAgentConfig(input: unknown): AgentConfig {
  return AgentConfig.parse(input);
}

/** Fill {placeholders} in greeting templates. */
export function fillTemplate(tpl: string, vars: Record<string, string | undefined | null>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");
}

export function templateVars(cfg: AgentConfig, contact?: { firstName?: string | null } | null) {
  const first = contact?.firstName?.trim();
  return {
    businessName: cfg.businessName,
    agentName: cfg.agentName,
    firstName: first ?? "",
    firstNameComma: first ? ` ${first},` : ",",
    recordingNotice: cfg.behaviour.recordCalls ? " This call may be recorded." : "",
  };
}
