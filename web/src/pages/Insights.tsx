import { useState } from "react";
import { Lightbulb, ThumbsUp, AlertTriangle, BookOpen, MessageCircleQuestion, Wand2, FlaskConical } from "lucide-react";
import { api } from "../lib/api";
import { useApi, useAction, type Agent } from "../lib/hooks";
import { when } from "../lib/format";
import { Button, Card, CopyField, Empty, Field, Modal, PageHeader, Select, Spinner, cx } from "../components/ui";

export function Insights() {
  const q = useApi<{ reports: any[] }>("/api/insights");
  const agents = useApi<{ agents: Agent[] }>("/api/agents");
  const [selected, setSelected] = useState<string | null>(null);
  const [gen, setGen] = useState(false);
  const reports = q.data?.reports ?? [];
  const r = reports.find((x) => x.id === selected) ?? reports[0];
  const agentName = (id: string) => agents.data?.agents.find((a) => a.id === id)?.name ?? "Agent";

  return (
    <>
      <PageHeader
        title="AI coaching"
        description="The AI reviews many calls together and tells you exactly what to change."
        actions={
          <Button variant="primary" onClick={() => setGen(true)}>
            <Lightbulb className="size-4" /> New report
          </Button>
        }
      />
      {q.isLoading ? (
        <Spinner />
      ) : !r ? (
        <Card>
          <Empty icon={<Lightbulb className="size-8" />} title="No reports yet">
            Once an agent has handled some calls, generate a report to see patterns, gaps and suggested fixes.
          </Empty>
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-4">
          <div className="space-y-2">
            {reports.map((x) => (
              <button key={x.id} onClick={() => setSelected(x.id)} className={cx("w-full rounded-lg border p-3 text-left text-sm transition", x.id === r.id ? "border-brand bg-brand-soft" : "border-slate-200 bg-white hover:border-slate-300")}>
                <p className="font-medium">{agentName(x.agentId)}</p>
                <p className="text-xs text-slate-500">
                  {x.callCount} calls · {when(x.createdAt)}
                </p>
              </button>
            ))}
          </div>
          <div className="space-y-6 lg:col-span-3">
            <div className="rounded-xl border border-amber-200 bg-gradient-to-br from-amber-50 to-white p-5">
              <p className="text-xs font-medium uppercase tracking-wide text-amber-700">
                {agentName(r.agentId)} · {new Date(r.periodStart).toLocaleDateString()} – {new Date(r.periodEnd).toLocaleDateString()} · {r.callCount} calls
              </p>
              <p className="mt-2 text-lg font-medium leading-snug text-slate-900">{r.report.headline}</p>
            </div>
            <div className="grid gap-6 md:grid-cols-2">
              <Section icon={<ThumbsUp className="size-4 text-emerald-600" />} title="What's working">
                <ul className="ml-5 list-disc space-y-1.5">{r.report.what_is_working.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul>
              </Section>
              <Section icon={<FlaskConical className="size-4 text-violet-600" />} title="Experiments to try">
                <ul className="ml-5 list-disc space-y-1.5">{r.report.experiments_to_try.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul>
              </Section>
            </div>
            <Section icon={<AlertTriangle className="size-4 text-amber-600" />} title="Top problems">
              <div className="space-y-3">
                {r.report.top_problems.map((p: any, i: number) => (
                  <div key={i} className="rounded-lg border border-slate-200 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <p className="font-medium">{p.problem}</p>
                      <span className="shrink-0 rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{p.how_often}</span>
                    </div>
                    <p className="mt-1 text-slate-500">{p.evidence}</p>
                    <p className="mt-2 rounded-md bg-emerald-50 px-3 py-2 text-emerald-900">
                      <span className="font-medium">Fix: </span>
                      {p.fix}
                    </p>
                  </div>
                ))}
              </div>
            </Section>
            <Section icon={<Wand2 className="size-4 text-brand" />} title="Change these instructions" description="Copy into the agent's Instructions.">
              <div className="space-y-2">{r.report.recommended_instruction_changes.map((x: string, i: number) => <CopyField key={i} value={x} wrap />)}</div>
            </Section>
            <div className="grid gap-6 md:grid-cols-2">
              <Section icon={<BookOpen className="size-4 text-sky-600" />} title="Knowledge to add" description="Questions the agent couldn't answer.">
                <div className="space-y-3">
                  {r.report.knowledge_gaps.map((g: any, i: number) => (
                    <div key={i}>
                      <p className="font-medium">{g.question}</p>
                      <p className="text-slate-600">{g.suggested_answer_to_add}</p>
                    </div>
                  ))}
                </div>
              </Section>
              <Section icon={<MessageCircleQuestion className="size-4 text-rose-600" />} title="Objections and how to answer">
                <div className="space-y-3">
                  {r.report.common_objections.map((o: any, i: number) => (
                    <div key={i}>
                      <p className="font-medium">"{o.objection}"</p>
                      <p className="text-slate-600">{o.suggested_response}</p>
                    </div>
                  ))}
                </div>
              </Section>
            </div>
          </div>
        </div>
      )}
      <GenerateModal open={gen} onClose={() => setGen(false)} agents={agents.data?.agents ?? []} onDone={(id) => setSelected(id)} />
    </>
  );
}

function Section({ icon, title, description, children }: { icon: React.ReactNode; title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          {icon}
          {title}
        </span>
      }
      description={description}
    >
      <div className="text-sm text-slate-700">{children}</div>
    </Card>
  );
}

function GenerateModal({ open, onClose, agents, onDone }: { open: boolean; onClose: () => void; agents: Agent[]; onDone: (id: string) => void }) {
  const [agentId, setAgentId] = useState("");
  const [days, setDays] = useState(14);
  const a = agentId || agents[0]?.id || "";
  const gen = useAction(() => api<{ id: string }>(`/api/agents/${a}/insights`, { json: { days } }), {
    success: "Report ready",
    onSuccess: (r) => {
      onDone(r.id);
      onClose();
    },
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New coaching report"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!a} loading={gen.isPending} onClick={() => gen.mutate(undefined)}>
            Generate
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Agent">
          <Select value={a} onChange={(e) => setAgentId(e.target.value)}>
            {agents.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Calls from the last">
          <Select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </Select>
        </Field>
        <p className="text-xs text-slate-500">Takes about a minute. Only calls that have an AI review are included.</p>
      </div>
    </Modal>
  );
}
