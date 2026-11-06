import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CalendarCheck, Clock, Lightbulb, PhoneCall, PhoneForwarded, PhoneOff, Star, Signal, ArrowRight } from "lucide-react";
import { useApi, type CallListItem } from "../lib/hooks";
import { useSession } from "../lib/session";
import { OUTCOME_LABEL, OUTCOME_TONE, duration, pct, when, phone } from "../lib/format";
import { Card, Empty, PageHeader, Select, Spinner, Stat, Table } from "../components/ui";
import { CallFlags, Direction, OutcomeBadge, Score } from "../components/CallBits";

const BAR: Record<string, string> = { green: "bg-emerald-500", blue: "bg-sky-500", violet: "bg-violet-500", amber: "bg-amber-500", red: "bg-red-500", slate: "bg-slate-400" };

function DailyChart({ daily, days }: { daily: { day: string; calls: number; booked: number }[]; days: number }) {
  // Fill gaps so every day shows.
  const map = new Map(daily.map((d) => [d.day, d]));
  const series = Array.from({ length: days }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (days - 1 - i));
    const key = d.toLocaleDateString("en-CA");
    return { day: key, calls: map.get(key)?.calls ?? 0, booked: map.get(key)?.booked ?? 0 };
  });
  const max = Math.max(1, ...series.map((s) => s.calls));
  return (
    <div>
      <div className="flex h-40 items-end gap-[3px]">
        {series.map((s) => (
          <div key={s.day} className="group relative flex h-full flex-1 flex-col justify-end" title={`${s.day}: ${s.calls} calls, ${s.booked} booked`}>
            <div className="w-full rounded-t-sm bg-brand/25 transition group-hover:bg-brand/40" style={{ height: `${(s.calls / max) * 100}%` }}>
              <div className="absolute bottom-0 w-full rounded-t-sm bg-brand" style={{ height: `${(s.booked / max) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-slate-400">
        <span>{new Date(series[0].day + "T12:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
        <span>Today</span>
      </div>
      <div className="mt-3 flex gap-4 text-xs text-slate-500">
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-brand/25" /> Calls</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-brand" /> Booked</span>
      </div>
    </div>
  );
}

export function Overview() {
  const { tenantName } = useSession();
  const [days, setDays] = useState(30);
  const nav = useNavigate();
  const stats = useApi<any>(`/api/analytics?days=${days}`);
  const recent = useApi<{ calls: CallListItem[] }>("/api/calls?limit=6");
  const insights = useApi<{ reports: any[] }>("/api/insights");
  const s = stats.data;
  const latest = insights.data?.reports?.[0];
  const outcomeMax = Math.max(1, ...(s?.outcomes ?? []).map((o: any) => o.count));

  return (
    <>
      <PageHeader
        title={`Welcome back${tenantName ? `, ${tenantName}` : ""}`}
        description="How your AI agents are performing."
        actions={
          <Select value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-36">
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </Select>
        }
      />
      {stats.isLoading || !s ? (
        <Spinner />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="Calls" value={s.total} sub={`${s.inbound} in · ${s.outbound} out`} icon={<PhoneCall className="size-4" />} />
            <Stat label="Connected" value={pct(s.rates.connectPct)} sub={`${s.connected} conversations`} icon={<Signal className="size-4" />} />
            <Stat label="Booked" value={pct(s.rates.bookingPctOfConnected)} sub={`${s.booked} appointments`} icon={<CalendarCheck className="size-4" />} />
            <Stat label="Transferred" value={pct(s.rates.transferPctOfConnected)} sub={`${s.transferred} calls`} icon={<PhoneForwarded className="size-4" />} />
            <Stat label="Caller hung up" value={pct(s.rates.callerHangUpPctOfConnected)} sub={`${s.callerHungUp} calls`} icon={<PhoneOff className="size-4" />} />
            <Stat label="AI call score" value={s.avgScore ?? "–"} sub={`${s.totalMinutes} min · avg ${duration(s.avgDurationSeconds)}`} icon={<Star className="size-4" />} />
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-3">
            <Card title="Calls per day" className="lg:col-span-2">
              <DailyChart daily={s.daily} days={days} />
            </Card>
            <Card title="Outcomes">
              {s.outcomes.length === 0 ? (
                <p className="text-sm text-slate-500">No completed calls yet.</p>
              ) : (
                <ul className="space-y-3">
                  {s.outcomes.map((o: any) => (
                    <li key={o.outcome}>
                      <div className="mb-1 flex justify-between text-sm">
                        <span className="text-slate-700">{OUTCOME_LABEL[o.outcome] ?? o.outcome}</span>
                        <span className="tabular-nums text-slate-500">{o.count}</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-slate-100">
                        <div className={`h-1.5 rounded-full ${BAR[OUTCOME_TONE[o.outcome] ?? "slate"]}`} style={{ width: `${(o.count / outcomeMax) * 100}%` }} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card
          title="Recent calls"
          className="lg:col-span-2"
          padded={false}
          actions={
            <Link to="/calls" className="text-sm font-medium text-brand hover:underline">
              View all
            </Link>
          }
        >
          {recent.isLoading ? (
            <Spinner />
          ) : !recent.data?.calls.length ? (
            <Empty icon={<PhoneCall className="size-8" />} title="No calls yet">
              Assign a phone number to an agent, or trigger a call from your CRM.
            </Empty>
          ) : (
            <Table head={["", "Contact", "Outcome", "Length", "Score", "When"]}>
              {recent.data.calls.map((c) => (
                <tr key={c.id} className="cursor-pointer hover:bg-slate-50" onClick={() => nav(`/calls/${c.id}`)}>
                  <td className="px-4 py-3"><Direction d={c.direction} /></td>
                  <td className="px-4 py-3">
                    <div className="font-medium">{c.contactName ?? phone(c.direction === "inbound" ? c.fromNumber : c.toNumber)}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-2">
                      <OutcomeBadge outcome={c.outcome} status={c.status} />
                      <CallFlags booked={c.booked} transferred={!!c.transferredTo} />
                    </span>
                  </td>
                  <td className="px-4 py-3 tabular-nums text-slate-600">{duration(c.durationSeconds)}</td>
                  <td className="px-4 py-3"><Score value={c.reviewScore} /></td>
                  <td className="px-4 py-3 text-slate-500">{when(c.createdAt)}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Card title="Latest AI coaching" actions={<Lightbulb className="size-4 text-amber-500" />}>
          {latest ? (
            <div className="space-y-3">
              <p className="text-sm leading-relaxed text-slate-700">{latest.report.headline}</p>
              {latest.report.top_problems?.[0] && (
                <div className="rounded-lg bg-amber-50 p-3 text-sm">
                  <p className="font-medium text-amber-900">Top fix</p>
                  <p className="mt-1 text-amber-800">{latest.report.top_problems[0].fix}</p>
                </div>
              )}
              <Link to="/insights" className="inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline">
                Read the full report <ArrowRight className="size-3.5" />
              </Link>
            </div>
          ) : (
            <p className="text-sm text-slate-500">
              After a few calls, generate a coaching report from an agent's page. It reviews every call and recommends exactly what to change.
            </p>
          )}
        </Card>
      </div>
      <p className="mt-6 flex items-center gap-1.5 text-xs text-slate-400">
        <Clock className="size-3.5" /> Rates are out of connected calls. Times are in your browser's timezone.
      </p>
    </>
  );
}
