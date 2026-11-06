import Anthropic from "@anthropic-ai/sdk";
import { env } from "../env.js";

let client: Anthropic | null = null;
export function anthropic(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

export const MODEL = env.LLM_MODEL;
export const EFFORT = env.LLM_EFFORT;

/**
 * Server-side refusal fallback: if a model declines, the API re-runs the request on a
 * fallback model inside the same call, so a live conversation doesn't dead-end.
 */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
export const fallbackParams = { betas: [FALLBACK_BETA], fallbacks: "default" as const };
