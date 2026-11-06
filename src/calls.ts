import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "./db/index.js";
import type { CallRow, TranscriptEntry } from "./db/schema.js";
import { newId } from "./lib/crypto.js";
import { log, errMsg } from "./lib/log.js";

export async function getCall(id: string): Promise<CallRow | null> {
  const [row] = await db().select().from(schema.calls).where(eq(schema.calls.id, id));
  return row ?? null;
}

export async function getCallForTenant(tenantId: string, id: string): Promise<CallRow | null> {
  const [row] = await db().select().from(schema.calls).where(and(eq(schema.calls.id, id), eq(schema.calls.tenantId, tenantId)));
  return row ?? null;
}

export async function updateCall(id: string, patch: Partial<CallRow>) {
  await db().update(schema.calls).set(patch).where(eq(schema.calls.id, id));
}

/** Append to the event timeline. Never throws (analytics must not break a live call). */
export async function addCallEvent(call: { id: string; tenantId: string }, type: string, data: Record<string, unknown> = {}) {
  try {
    await db().insert(schema.callEvents).values({ id: newId("evt"), tenantId: call.tenantId, callId: call.id, type, data });
  } catch (e) {
    log.warn("failed to record call event", { callId: call.id, type, error: errMsg(e) });
  }
}

export async function appendTranscript(callId: string, entry: Omit<TranscriptEntry, "at">) {
  const full: TranscriptEntry = { ...entry, at: new Date().toISOString() };
  try {
    await db()
      .update(schema.calls)
      .set({ transcript: sql`${schema.calls.transcript} || ${JSON.stringify([full])}::jsonb` })
      .where(eq(schema.calls.id, callId));
  } catch (e) {
    log.warn("failed to append transcript", { callId, error: errMsg(e) });
  }
}
