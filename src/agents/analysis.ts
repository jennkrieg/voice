import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { anthropic, MODEL, fallbackParams } from "./llm.js";
import type { AgentConfig } from "./config.js";
import type { TranscriptEntry } from "../db/schema.js";

export const OUTCOMES = [
  "appointment_booked",
  "transferred",
  "interested_follow_up",
  "callback_requested",
  "information_provided",
  "not_interested",
  "do_not_contact",
  "wrong_number",
  "voicemail",
  "caller_hung_up_early",
  "no_conversation",
  "other",
] as const;

export const CallAnalysis = z.object({
  summary: z.string(),
  outcome: z.enum(OUTCOMES),
  successful: z.boolean(),
  sentiment: z.enum(["positive", "neutral", "negative"]),
  caller_intent: z.string(),
  objections: z.array(z.string()),
  unanswered_questions: z.array(z.string()),
  follow_up_needed: z.boolean(),
  follow_up_reason: z.string(),
  review: z.object({
    score: z.number().int().min(1).max(10),
    went_well: z.array(z.string()),
    to_improve: z.array(z.string()),
    prompt_suggestions: z.array(z.string()),
  }),
  follow_up_sms: z.string(),
  follow_up_email_subject: z.string(),
  follow_up_email_body: z.string(),
  follow_up_resources: z.array(z.string()),
});
export type CallAnalysis = z.infer<typeof CallAnalysis>;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: Object.keys(CallAnalysis.shape),
  properties: {
    summary: { type: "string", description: "2-4 sentence summary for the business owner" },
    outcome: { type: "string", enum: [...OUTCOMES] },
    successful: { type: "boolean", description: "Did the call achieve the agent's goal?" },
    sentiment: { type: "string", enum: ["positive", "neutral", "negative"] },
    caller_intent: { type: "string" },
    objections: { type: "array", items: { type: "string" } },
    unanswered_questions: { type: "array", items: { type: "string" }, description: "Questions the agent could not answer well" },
    follow_up_needed: { type: "boolean" },
    follow_up_reason: { type: "string" },
    review: {
      type: "object",
      additionalProperties: false,
      required: ["score", "went_well", "to_improve", "prompt_suggestions"],
      properties: {
        score: { type: "integer", description: "1-10 rating of how well the AI agent handled the call" },
        went_well: { type: "array", items: { type: "string" } },
        to_improve: { type: "array", items: { type: "string" }, description: "Specific moments the agent could have handled better" },
        prompt_suggestions: { type: "array", items: { type: "string" }, description: "Concrete edits to the agent's instructions or knowledge" },
      },
    },
    follow_up_sms: { type: "string", description: "A personalised follow-up text, or empty string if none should be sent" },
    follow_up_email_subject: { type: "string", description: "Empty string if no email should be sent" },
    follow_up_email_body: { type: "string", description: "Plain-text follow-up email, or empty string" },
    follow_up_resources: { type: "array", items: { type: "string" }, description: "Keys of resources to include" },
  },
};

export function transcriptText(t: TranscriptEntry[]): string {
  return t.map((e) => (e.role === "event" ? `[${e.text}]` : `${e.role === "agent" ? "AGENT" : "CALLER"}: ${e.text}`)).join("\n");
}

/** One structured-output request: summary, outcome, coaching review, and a drafted follow-up. */
export async function analyzeCall(opts: {
  cfg: AgentConfig;
  transcript: TranscriptEntry[];
  direction: "inbound" | "outbound";
  booked: boolean;
  transferred: boolean;
  endedBy: string | null;
  client?: Anthropic;
}): Promise<CallAnalysis> {
  const { cfg } = opts;
  const resources = cfg.followUp.assets.map((a) => `- ${a.key}: ${a.title}. ${a.description}`).join("\n") || "(none)";
  const res = await (opts.client ?? anthropic()).beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
    ...fallbackParams,
    system: `You review phone calls handled by an AI voice agent for ${cfg.businessName}, then (1) summarise and classify the call, (2) coach the business owner on how to improve the agent, and (3) draft a follow-up message.

The agent's instructions were:
<instructions>
${cfg.instructions}
</instructions>

Follow-up guidance from the business: ${cfg.followUp.guidance || "(none)"}
Resources that can be included in follow-ups:
${resources}

Be specific and evidence-based in the review: quote or paraphrase the moment you're referring to. Only draft follow-ups that a real person would welcome; leave them empty for wrong numbers, opt-outs, hostile callers, or when nothing useful can be said. Never promise anything the transcript doesn't support.`,
    messages: [
      {
        role: "user",
        content: `Direction: ${opts.direction}\nAppointment booked: ${opts.booked}\nTransferred to a human: ${opts.transferred}\nEnded by: ${opts.endedBy ?? "unknown"}\n\n<transcript>\n${transcriptText(opts.transcript) || "(empty)"}\n</transcript>`,
      },
    ],
  });
  if (res.stop_reason === "refusal") throw new Error("analysis refused");
  const text = res.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("analysis returned no text");
  return CallAnalysis.parse(JSON.parse(text.text));
}
