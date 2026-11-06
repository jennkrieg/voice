import { and, eq, gte, lte, isNotNull, desc } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { anthropic, MODEL, fallbackParams } from "./llm.js";
import { newId } from "../lib/crypto.js";
import type { AgentConfig } from "./config.js";
import { parseAgentConfig } from "./config.js";

export const InsightReportBody = z.object({
  headline: z.string(),
  what_is_working: z.array(z.string()),
  top_problems: z.array(z.object({ problem: z.string(), evidence: z.string(), how_often: z.string(), fix: z.string() })),
  knowledge_gaps: z.array(z.object({ question: z.string(), suggested_answer_to_add: z.string() })),
  common_objections: z.array(z.object({ objection: z.string(), suggested_response: z.string() })),
  recommended_instruction_changes: z.array(z.string()),
  experiments_to_try: z.array(z.string()),
});
export type InsightReportBody = z.infer<typeof InsightReportBody>;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: Object.keys(InsightReportBody.shape),
  properties: {
    headline: { type: "string", description: "One-sentence takeaway for the owner" },
    what_is_working: { type: "array", items: { type: "string" } },
    top_problems: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["problem", "evidence", "how_often", "fix"],
        properties: { problem: { type: "string" }, evidence: { type: "string" }, how_often: { type: "string" }, fix: { type: "string" } },
      },
    },
    knowledge_gaps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "suggested_answer_to_add"],
        properties: { question: { type: "string" }, suggested_answer_to_add: { type: "string" } },
      },
    },
    common_objections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["objection", "suggested_response"],
        properties: { objection: { type: "string" }, suggested_response: { type: "string" } },
      },
    },
    recommended_instruction_changes: { type: "array", items: { type: "string" }, description: "Concrete text to add/change in the agent instructions" },
    experiments_to_try: { type: "array", items: { type: "string" }, description: "A/B ideas: greetings, voices, offers, call times" },
  },
};

/** Review many calls at once and produce coaching recommendations for the owner. */
export async function generateInsightReport(opts: { tenantId: string; agentId: string; from: Date; to: Date; maxCalls?: number }) {
  const [agent] = await db().select().from(schema.agents).where(and(eq(schema.agents.id, opts.agentId), eq(schema.agents.tenantId, opts.tenantId)));
  if (!agent) throw new Error("agent not found");
  const cfg: AgentConfig = parseAgentConfig(agent.config);
  const rows = await db()
    .select({
      id: schema.calls.id,
      direction: schema.calls.direction,
      outcome: schema.calls.outcome,
      summary: schema.calls.summary,
      analysis: schema.calls.analysis,
      durationSeconds: schema.calls.durationSeconds,
      endedBy: schema.calls.endedBy,
    })
    .from(schema.calls)
    .where(
      and(
        eq(schema.calls.tenantId, opts.tenantId),
        eq(schema.calls.agentId, opts.agentId),
        gte(schema.calls.createdAt, opts.from),
        lte(schema.calls.createdAt, opts.to),
        isNotNull(schema.calls.analysis),
      ),
    )
    .orderBy(desc(schema.calls.createdAt))
    .limit(opts.maxCalls ?? 200);
  if (rows.length === 0) throw new Error("No analysed calls in that period yet");

  const digest = rows
    .map((r) => {
      const a = r.analysis as Record<string, any>;
      return [
        `## Call ${r.id} (${r.direction}, ${r.durationSeconds ?? 0}s, ended by ${r.endedBy ?? "?"}) outcome=${r.outcome} score=${a?.review?.score}`,
        `Summary: ${r.summary}`,
        a?.objections?.length ? `Objections: ${a.objections.join("; ")}` : "",
        a?.unanswered_questions?.length ? `Unanswered: ${a.unanswered_questions.join("; ")}` : "",
        a?.review?.to_improve?.length ? `To improve: ${a.review.to_improve.join("; ")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");

  const res = await anthropic().beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
    ...fallbackParams,
    system: `You coach the owner of an AI phone agent for ${cfg.businessName}. You get per-call reviews from a period and find patterns: what's working, recurring problems, missing knowledge, objections, and concrete changes to the agent's instructions. Prioritise by impact on bookings and caller experience. Cite call ids as evidence. Be concrete enough that the owner can paste your suggested text into the agent's settings.

Current agent instructions:
<instructions>
${cfg.instructions}
</instructions>
Current knowledge:
<knowledge>
${cfg.knowledge || "(empty)"}
</knowledge>`,
    messages: [{ role: "user", content: `${rows.length} calls between ${opts.from.toISOString()} and ${opts.to.toISOString()}:\n\n${digest}` }],
  });
  if (res.stop_reason === "refusal") throw new Error("report generation refused");
  const text = res.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("report returned no text");
  const report = InsightReportBody.parse(JSON.parse(text.text));
  const [row] = await db()
    .insert(schema.insightReports)
    .values({ id: newId("ins"), tenantId: opts.tenantId, agentId: opts.agentId, periodStart: opts.from, periodEnd: opts.to, callCount: rows.length, report })
    .returning();
  return row;
}
