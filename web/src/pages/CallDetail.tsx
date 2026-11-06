import { Link, useParams } from "react-router-dom";
import { ArrowLeft, CheckCircle2, AlertCircle, Wand2, MessageSquare, Mail, HelpCircle, ShieldAlert } from "lucide-react";
import { useApi } from "../lib/hooks";
import { mediaUrl } from "../lib/api";
import { duration, phone, titleCase, when } from "../lib/format";
import { Badge, Card, CopyField, Empty, Spinner, cx } from "../components/ui";
import { CallFlags, Direction, OutcomeBadge, Score } from "../components/CallBits";

const ENDED_BY: Record<string, string> = { agent: "Agent ended", caller: "Caller hung up", transfer: "Transferred", system: "System" };

export function CallDetail() {
  const { id } = useParams();
  const q = useApi<any>(`/api/calls/${id}`);
  const agents = useApi<{ agents: any[] }>("/api/agents");
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <Empty title="Call not found" />;
  const c = q.data;
  const a = c.analysis ?? {};
  const review = c.review ?? a.review;
  const contactName = [c.contact?.firstName, c.contact?.lastName].filter(Boolean).join(" ") || "Unknown caller";
  const otherNumber = c.direction === "inbound" ? c.fromNumber : c.toNumber;
  const agentName = agents.data?.agents.find((x) => x.id === c.agentId)?.name;

  return (
    <>
      <Link to="/calls" className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft className="size-4" /> Calls
      </Link>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{contactName}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-500">
            <Direction d={c.direction} />
            <span>{phone(otherNumber)}</span>
            <span>·</span>
            <span>{when(c.startedAt ?? c.createdAt)}</span>
            <span>·</span>
            <span>{duration(c.durationSeconds)}</span>
            {agentName && (
              <>
                <span>·</span>
                <span>{agentName}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <OutcomeBadge outcome={c.outcome} status={c.status} />
          {c.booked && c.outcome !== "appointment_booked" && <Badge tone="green">Appointment booked</Badge>}
          {c.transferredTo && <Badge tone="blue">Transferred to {phone(c.transferredTo)}</Badge>}
          {c.endedBy && <Badge>{ENDED_BY[c.endedBy] ?? c.endedBy}</Badge>}
          {a.sentiment && <Badge tone={a.sentiment === "positive" ? "green" : a.sentiment === "negative" ? "red" : "slate"}>{titleCase(a.sentiment)}</Badge>}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
          {c.recording && (
            <Card title="Recording">
              <audio controls preload="none" className="w-full" src={mediaUrl(c.recording)} />
            </Card>
          )}
          {c.summary && (
            <Card title="Summary">
              <p className="text-sm leading-relaxed text-slate-700">{c.summary}</p>
            </Card>
          )}
          <Card title="Transcript" padded={false}>
            {c.transcript?.length ? (
              <div className="space-y-3 p-5">
                {c.transcript.map((t: any, i: number) =>
                  t.role === "event" ? (
                    <p key={i} className="text-center text-xs text-slate-400">{t.text}</p>
                  ) : (
                    <div key={i} className={cx("flex", t.role === "agent" ? "justify-start" : "justify-end")}>
                      <div className={cx("max-w-[80%] rounded-2xl px-4 py-2 text-sm leading-relaxed", t.role === "agent" ? "rounded-tl-sm bg-slate-100 text-slate-800" : "rounded-tr-sm bg-brand text-white")}>
                        <div className={cx("mb-0.5 text-[11px] font-medium", t.role === "agent" ? "text-slate-500" : "text-white/70")}>
                          {t.role === "agent" ? "Agent" : contactName.split(" ")[0]} · {new Date(t.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" })}
                        </div>
                        {t.text}
                      </div>
                    </div>
                  ),
                )}
              </div>
            ) : (
              <Empty title="No conversation">{c.status === "queued" ? `Scheduled for ${when(c.scheduledFor)}.` : "Nobody spoke on this call."}</Empty>
            )}
          </Card>
        </div>

        <div className="space-y-6 lg:col-span-2">
          {review && (
            <Card title="AI review" actions={<Score value={review.score} />}>
              <div className="space-y-4 text-sm">
                {review.went_well?.length > 0 && (
                  <div>
                    <p className="mb-1.5 flex items-center gap-1.5 font-medium text-emerald-700"><CheckCircle2 className="size-4" /> What went well</p>
                    <ul className="ml-5 list-disc space-y-1 text-slate-700">{review.went_well.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul>
                  </div>
                )}
                {review.to_improve?.length > 0 && (
                  <div>
                    <p className="mb-1.5 flex items-center gap-1.5 font-medium text-amber-700"><AlertCircle className="size-4" /> What to improve</p>
                    <ul className="ml-5 list-disc space-y-1 text-slate-700">{review.to_improve.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul>
                  </div>
                )}
                {review.prompt_suggestions?.length > 0 && (
                  <div>
                    <p className="mb-1.5 flex items-center gap-1.5 font-medium text-violet-700"><Wand2 className="size-4" /> Suggested instruction changes</p>
                    <div className="space-y-2">
                      {review.prompt_suggestions.map((x: string, i: number) => (
                        <CopyField key={i} value={x} wrap />
                      ))}
                    </div>
                    <Link to={`/agents/${c.agentId}`} className="mt-2 inline-block text-xs font-medium text-brand hover:underline">
                      Open agent instructions →
                    </Link>
                  </div>
                )}
              </div>
            </Card>
          )}
          {(a.objections?.length > 0 || a.unanswered_questions?.length > 0) && (
            <Card title="Signals">
              <div className="space-y-4 text-sm">
                {a.objections?.length > 0 && (
                  <div>
                    <p className="mb-1.5 flex items-center gap-1.5 font-medium text-slate-700"><ShieldAlert className="size-4" /> Objections</p>
                    <div className="flex flex-wrap gap-1.5">{a.objections.map((x: string, i: number) => <Badge key={i} tone="amber">{x}</Badge>)}</div>
                  </div>
                )}
                {a.unanswered_questions?.length > 0 && (
                  <div>
                    <p className="mb-1.5 flex items-center gap-1.5 font-medium text-slate-700"><HelpCircle className="size-4" /> Couldn't answer</p>
                    <ul className="ml-5 list-disc space-y-1 text-slate-700">{a.unanswered_questions.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul>
                  </div>
                )}
              </div>
            </Card>
          )}
          {c.followUps?.length > 0 && (
            <Card title="Follow-ups sent">
              <ul className="space-y-3 text-sm">
                {c.followUps.map((m: any) => (
                  <li key={m.id} className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                    <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-500">
                      {m.channel === "email" ? <Mail className="size-3.5" /> : <MessageSquare className="size-3.5" />}
                      {m.channel === "email" ? `Email to ${m.toNumber}` : `Text to ${phone(m.toNumber)}`} · {when(m.createdAt)}
                    </p>
                    {m.subject && <p className="font-medium">{m.subject}</p>}
                    <p className="whitespace-pre-wrap text-slate-700">{m.body}</p>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card title="Timeline">
            <ol className="relative ml-1.5 space-y-3 border-l border-slate-200 pl-4">
              {c.events.map((e: any) => (
                <li key={e.id} className="text-sm">
                  <span className="absolute -left-[5px] mt-1.5 size-2.5 rounded-full border-2 border-white bg-slate-300" />
                  <div className="flex justify-between gap-3">
                    <span className="font-medium text-slate-700">{titleCase(e.type.replace(/^tool\./, "tool: "))}</span>
                    <span className="shrink-0 text-xs tabular-nums text-slate-400">{new Date(e.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" })}</span>
                  </div>
                  {e.data && Object.keys(e.data).length > 0 && <p className="truncate text-xs text-slate-500">{JSON.stringify(e.data).slice(0, 140)}</p>}
                </li>
              ))}
            </ol>
          </Card>
          <div className="flex items-center justify-end">
            <CallFlags booked={c.booked} transferred={!!c.transferredTo} recording={!!c.recording} />
          </div>
        </div>
      </div>
    </>
  );
}
