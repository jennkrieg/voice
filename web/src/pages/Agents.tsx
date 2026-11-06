import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Bot, Plus, Phone, ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { api } from "../lib/api";
import { useApi, useAction, type Agent, type PhoneNumber } from "../lib/hooks";
import { useSession } from "../lib/session";
import { phone, when } from "../lib/format";
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader, Spinner, cx } from "../components/ui";

export const TEMPLATES = [
  {
    id: "receptionist",
    title: "Receptionist",
    icon: ArrowDownLeft,
    blurb: "Answers calls and texts, handles questions, books appointments, and transfers to a person when needed.",
    config: (biz: string) => ({
      businessName: biz,
      instructions:
        "You answer calls for the business.\nFind out what the caller needs, answer questions using the business information, and offer to book an appointment when it makes sense.\nTransfer to a person if they ask for one, have a billing question, or are upset.\nIf they want information sent to them, offer to text or email it.",
      knowledge: "Hours: Monday to Friday, 9am to 5pm.\nAddress: (add your address)\nServices and prices: (add them here)",
    }),
  },
  {
    id: "lead_caller",
    title: "New lead caller",
    icon: ArrowUpRight,
    blurb: "Calls new leads from your CRM within minutes, qualifies them, and books a consultation.",
    config: (biz: string) => ({
      businessName: biz,
      outboundGreeting: "Hi{firstNameComma} this is {agentName}, a virtual assistant from {businessName}. You recently asked about our services online.{recordingNotice} Is now a good time?",
      instructions:
        "You call people who just asked about our services online.\nConfirm it's a good time. If not, ask when to call back.\nAsk one or two questions to understand what they need, then offer to book a free consultation.\nIf they're not interested, thank them and end the call. If they ask not to be called, mark do-not-contact.",
      knowledge: "Consultation: free, 20 minutes, by phone or video.\nServices and prices: (add them here)",
      followUp: { autoAfterCall: { sms: true, email: false } },
    }),
  },
  { id: "blank", title: "Start from scratch", icon: Bot, blurb: "An empty agent with sensible defaults.", config: (biz: string) => ({ businessName: biz }) },
];

export function Agents() {
  const { tenantName } = useSession();
  const nav = useNavigate();
  const agents = useApi<{ agents: Agent[] }>("/api/agents");
  const numbers = useApi<{ numbers: PhoneNumber[] }>("/api/numbers");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [biz, setBiz] = useState(tenantName ?? "");
  const [tpl, setTpl] = useState("receptionist");
  const create = useAction(
    () => api<Agent>("/api/agents", { json: { name, config: TEMPLATES.find((t) => t.id === tpl)!.config(biz) } }),
    { success: "Agent created", onSuccess: (a) => nav(`/agents/${a.id}`) },
  );

  return (
    <>
      <PageHeader
        title="Agents"
        description="Each agent has its own voice, instructions, calendar and CRM settings."
        actions={
          <Button variant="primary" onClick={() => setOpen(true)}>
            <Plus className="size-4" /> New agent
          </Button>
        }
      />
      {agents.isLoading ? (
        <Spinner />
      ) : !agents.data?.agents.length ? (
        <Card>
          <Empty icon={<Bot className="size-8" />} title="No agents yet">
            Create an agent, then give it a phone number.
          </Empty>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {agents.data.agents.map((a) => {
            const nums = numbers.data?.numbers.filter((n) => n.agentId === a.id) ?? [];
            return (
              <Link key={a.id} to={`/agents/${a.id}`} className="group rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-brand/40 hover:shadow">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="grid size-10 place-items-center rounded-full bg-brand-soft text-brand">
                      <Bot className="size-5" />
                    </div>
                    <div>
                      <p className="font-semibold group-hover:text-brand">{a.name}</p>
                      <p className="text-xs text-slate-500">
                        "{a.config.agentName}" for {a.config.businessName}
                      </p>
                    </div>
                  </div>
                  {a.config.ambience?.preset && a.config.ambience.preset !== "none" && <Badge tone="violet">{a.config.ambience.preset.replace("_", " ")}</Badge>}
                </div>
                <p className="mt-3 line-clamp-2 text-sm text-slate-600">{a.config.instructions}</p>
                <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  {nums.length ? (
                    nums.map((n) => (
                      <span key={n.id} className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5">
                        <Phone className="size-3" /> {phone(n.e164)}
                      </span>
                    ))
                  ) : (
                    <span className="text-amber-700">No phone number</span>
                  )}
                  <span className="ml-auto">Updated {when(a.updatedAt)}</span>
                </div>
              </Link>
            );
          })}
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New agent"
        wide
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={!name || !biz} loading={create.isPending} onClick={() => create.mutate(undefined)}>
              Create agent
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            {TEMPLATES.map((t) => (
              <button key={t.id} onClick={() => setTpl(t.id)} className={cx("rounded-xl border p-4 text-left transition", tpl === t.id ? "border-brand bg-brand-soft ring-1 ring-brand" : "border-slate-200 hover:border-slate-300")}>
                <t.icon className={cx("mb-2 size-5", tpl === t.id ? "text-brand" : "text-slate-400")} />
                <p className="text-sm font-semibold">{t.title}</p>
                <p className="mt-1 text-xs text-slate-500">{t.blurb}</p>
              </button>
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Agent name" hint="Only you see this, e.g. 'Front desk'">
              <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </Field>
            <Field label="Business name" hint="The agent says this on calls">
              <Input value={biz} onChange={(e) => setBiz(e.target.value)} />
            </Field>
          </div>
        </div>
      </Modal>
    </>
  );
}
