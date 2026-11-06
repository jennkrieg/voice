import { and, eq, gte, lte, sql } from "drizzle-orm";
import { db, schema } from "./db/index.js";

/** Headline numbers for a dashboard: volume, connection, conversion, transfers, hang-ups, outcomes. */
export async function callStats(tenantId: string, opts: { from: Date; to: Date; agentId?: string }) {
  const c = schema.calls;
  const where = and(
    eq(c.tenantId, tenantId),
    gte(c.createdAt, opts.from),
    lte(c.createdAt, opts.to),
    opts.agentId ? eq(c.agentId, opts.agentId) : undefined,
  );
  const [totals] = await db()
    .select({
      total: sql<number>`count(*)::int`,
      inbound: sql<number>`count(*) filter (where ${c.direction} = 'inbound')::int`,
      outbound: sql<number>`count(*) filter (where ${c.direction} = 'outbound')::int`,
      connected: sql<number>`count(*) filter (where ${c.status} = 'completed')::int`,
      noAnswer: sql<number>`count(*) filter (where ${c.status} in ('no_answer','busy'))::int`,
      voicemail: sql<number>`count(*) filter (where ${c.status} = 'voicemail')::int`,
      failed: sql<number>`count(*) filter (where ${c.status} = 'failed')::int`,
      queued: sql<number>`count(*) filter (where ${c.status} in ('queued','dialing','in_progress'))::int`,
      booked: sql<number>`count(*) filter (where ${c.booked})::int`,
      transferred: sql<number>`count(*) filter (where ${c.transferredTo} is not null)::int`,
      callerHungUp: sql<number>`count(*) filter (where ${c.endedBy} = 'caller')::int`,
      successful: sql<number>`count(*) filter (where (${c.analysis}->>'successful')::boolean)::int`,
      avgDurationSeconds: sql<number>`coalesce(round(avg(${c.durationSeconds}) filter (where ${c.status} = 'completed')), 0)::int`,
      totalMinutes: sql<number>`coalesce(ceil(sum(${c.durationSeconds}) / 60.0), 0)::int`,
      avgScore: sql<number>`round(avg((${c.review}->>'score')::numeric), 1)::float`,
    })
    .from(c)
    .where(where);
  const outcomes = await db()
    .select({ outcome: c.outcome, count: sql<number>`count(*)::int` })
    .from(c)
    .where(and(where, sql`${c.outcome} is not null`))
    .groupBy(c.outcome)
    .orderBy(sql`count(*) desc`);
  const rate = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);
  return {
    period: { from: opts.from.toISOString(), to: opts.to.toISOString() },
    ...totals,
    rates: {
      connectPct: rate(totals.connected, totals.total - totals.queued),
      bookingPctOfConnected: rate(totals.booked, totals.connected),
      transferPctOfConnected: rate(totals.transferred, totals.connected),
      callerHangUpPctOfConnected: rate(totals.callerHungUp, totals.connected),
      successPctOfConnected: rate(totals.successful, totals.connected),
    },
    outcomes,
  };
}

export async function usage(tenantId: string, from: Date, to: Date) {
  const [calls] = await db()
    .select({ minutes: sql<number>`coalesce(ceil(sum(${schema.calls.durationSeconds}) / 60.0), 0)::int`, calls: sql<number>`count(*)::int` })
    .from(schema.calls)
    .where(and(eq(schema.calls.tenantId, tenantId), gte(schema.calls.createdAt, from), lte(schema.calls.createdAt, to)));
  const msgs = await db()
    .select({ channel: schema.messages.channel, direction: schema.messages.direction, count: sql<number>`count(*)::int` })
    .from(schema.messages)
    .where(and(eq(schema.messages.tenantId, tenantId), gte(schema.messages.createdAt, from), lte(schema.messages.createdAt, to)))
    .groupBy(schema.messages.channel, schema.messages.direction);
  return { from: from.toISOString(), to: to.toISOString(), callMinutes: calls.minutes, calls: calls.calls, messages: msgs };
}
