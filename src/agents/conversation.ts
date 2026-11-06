import Anthropic from "@anthropic-ai/sdk";
import type { AgentRuntime } from "./tools.js";
import { buildTools } from "./tools.js";
import { anthropic, MODEL, EFFORT, fallbackParams } from "./llm.js";
import { log, errMsg } from "../lib/log.js";

type MessageParam = Anthropic.Beta.BetaMessageParam;

export interface TurnHooks {
  /** Each text delta as it streams (feed to TTS). */
  onText?: (delta: string) => void;
  /** A tool is about to run (voice: say a filler phrase so there's no dead air). */
  onToolStart?: (name: string) => void;
  onToolResult?: (name: string, input: unknown, result: unknown, isError: boolean) => void;
  signal?: AbortSignal;
}

export interface TurnResult {
  text: string;
  interrupted: boolean;
  toolsUsed: string[];
}

const MAX_TOOL_ROUNDS = 6;

/**
 * One conversation (a call or an SMS thread) with Claude, including tool use.
 * History is append-only: completed assistant turns are stored exactly as returned.
 */
export class Conversation {
  messages: MessageParam[] = [];
  private tools: ReturnType<typeof buildTools>;

  constructor(
    private rt: AgentRuntime,
    private system: Anthropic.Beta.BetaTextBlockParam[],
    private client: Anthropic = anthropic(),
  ) {
    this.tools = buildTools(rt);
  }

  addUser(text: string) {
    this.messages.push({ role: "user", content: text });
  }

  /** Something the agent said that didn't come from the model (scripted greeting). */
  addAssistantText(text: string) {
    if (this.messages.length === 0) this.messages.push({ role: "user", content: "[conversation started]" });
    this.messages.push({ role: "assistant", content: text });
  }

  async respond(hooks: TurnHooks = {}): Promise<TurnResult> {
    let spoken = "";
    const toolsUsed: string[] = [];
    let jsonRetries = 0;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      let turnText = "";
      const stream = this.client.beta.messages.stream(
        {
          model: MODEL,
          max_tokens: 8000,
          system: this.system,
          tools: [...this.tools.values()].map((t) => t.def),
          messages: this.messages,
          output_config: { effort: EFFORT },
          ...fallbackParams,
        },
        { signal: hooks.signal },
      );
      stream.on("text", (d) => {
        turnText += d;
        hooks.onText?.(d);
      });

      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await stream.finalMessage();
        jsonRetries = 0;
      } catch (err) {
        if (hooks.signal?.aborted) {
          // Caller interrupted (barge-in). Keep what was already said so the model knows.
          spoken += turnText;
          if (spoken.trim()) this.messages.push({ role: "assistant", content: `${spoken.trim()} [interrupted by the caller]` });
          return { text: spoken, interrupted: true, toolsUsed };
        }
        if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
        log.warn("tool input was not parseable JSON, retrying turn", { error: errMsg(err) });
        continue;
      }
      spoken += turnText;

      if (message.stop_reason === "refusal") {
        this.messages.push({ role: "assistant", content: message.content });
        const fallback = "Sorry, I can't help with that one. Is there anything else I can do for you?";
        if (!turnText) hooks.onText?.(fallback);
        return { text: spoken || fallback, interrupted: false, toolsUsed };
      }

      this.messages.push({ role: "assistant", content: message.content });
      const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (message.stop_reason !== "tool_use" || toolUses.length === 0) {
        return { text: spoken, interrupted: false, toolsUsed };
      }

      // Run all tool calls from this turn, then return all results in one user message.
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        const tool = this.tools.get(tu.name);
        toolsUsed.push(tu.name);
        hooks.onToolStart?.(tu.name);
        if (!tool) {
          results.push({ type: "tool_result", tool_use_id: tu.id, is_error: true, content: `Unknown tool ${tu.name}` });
          continue;
        }
        const parsed = tool.schema.safeParse(tu.input);
        if (!parsed.success) {
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            is_error: true,
            content: JSON.stringify({ INVALID_INPUT: JSON.stringify(tu.input), issues: parsed.error.issues.map((i) => i.message) }),
          });
          hooks.onToolResult?.(tu.name, tu.input, parsed.error.issues, true);
          continue;
        }
        try {
          const out = await tool.run(parsed.data);
          results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out) });
          hooks.onToolResult?.(tu.name, parsed.data, out, false);
        } catch (e) {
          log.warn("tool failed", { tool: tu.name, error: errMsg(e) });
          results.push({ type: "tool_result", tool_use_id: tu.id, is_error: true, content: errMsg(e) });
          hooks.onToolResult?.(tu.name, parsed.data, errMsg(e), true);
        }
      }
      this.messages.push({ role: "user", content: results });
      if (hooks.signal?.aborted) return { text: spoken, interrupted: true, toolsUsed };
    }
    return { text: spoken, interrupted: false, toolsUsed };
  }
}
