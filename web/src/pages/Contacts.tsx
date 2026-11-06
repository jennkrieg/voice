import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Contact as ContactIcon, Phone, Plus, MessageSquare, Mail } from "lucide-react";
import { api } from "../lib/api";
import { useApi, useAction, type Agent, type CallListItem } from "../lib/hooks";
import { phone, when } from "../lib/format";
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader, Select, Spinner, Switch, Table, cx } from "../components/ui";
import { OutcomeBadge } from "../components/CallBits";

type Contact = { id: string; phone: string; firstName: string | null; lastName: string | null; email: string | null; crmExternalId: string | null; doNotCall: boolean; doNotText: boolean; lastCallAt: string | null; fields: Record<string, unknown>; updatedAt: string };

export function Contacts() {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<Contact | null>(null);
  const [adding, setAdding] = useState(false);
  const q = useApi<{ contacts: Contact[] }>(`/api/contacts?limit=200${search.replace(/\D/g, "").length >= 7 ? `&phone=${encodeURIComponent(search)}` : ""}`);
  const list = (q.data?.contacts ?? []).filter((c) => {
    if (!search || search.replace(/\D/g, "").length >= 7) return true;
    return `${c.firstName ?? ""} ${c.lastName ?? ""} ${c.email ?? ""}`.toLowerCase().includes(search.toLowerCase());
  });
  return (
    <>
      <PageHeader
        title="Contacts"
        description="Everyone your agents have talked to or will call. Your CRM stays the source of truth."
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Plus className="size-4" /> Add contact
          </Button>
        }
      />
      <div className="mb-4">
        <Input className="max-w-sm" placeholder="Search name, email or phone" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <Card padded={false}>
        {q.isLoading ? (
          <Spinner />
        ) : list.length === 0 ? (
          <Empty icon={<ContactIcon className="size-8" />} title="No contacts" />
        ) : (
          <Table head={["Name", "Phone", "Email", "CRM", "Status", "Last call"]}>
            {list.map((c) => (
              <tr key={c.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen(c)}>
                <td className="px-4 py-3 font-medium">{[c.firstName, c.lastName].filter(Boolean).join(" ") || "Unknown"}</td>
                <td className="px-4 py-3 tabular-nums">{phone(c.phone)}</td>
                <td className="px-4 py-3 text-slate-600">{c.email ?? "–"}</td>
                <td className="px-4 py-3 font-mono text-xs text-slate-500">{c.crmExternalId ?? "–"}</td>
                <td className="px-4 py-3">
                  <span className="flex gap-1">
                    {c.doNotCall && <Badge tone="red">Do not call</Badge>}
                    {c.doNotText && <Badge tone="red">No texts</Badge>}
                  </span>
                </td>
                <td className="px-4 py-3 text-slate-500">{when(c.lastCallAt)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {open && <ContactDrawer contact={open} onClose={() => setOpen(null)} />}
      <AddContact open={adding} onClose={() => setAdding(false)} />
    </>
  );
}

function ContactDrawer({ contact, onClose }: { contact: Contact; onClose: () => void }) {
  const nav = useNavigate();
  const agents = useApi<{ agents: Agent[] }>("/api/agents");
  const calls = useApi<{ calls: CallListItem[] }>(`/api/calls?contactId=${contact.id}&limit=20`);
  const msgs = useApi<{ messages: any[] }>(`/api/messages?contactId=${contact.id}&limit=50`);
  const [agentId, setAgentId] = useState("");
  const [c, setC] = useState(contact);
  const a = agentId || agents.data?.agents[0]?.id || "";
  const callNow = useAction(() => api<any>("/api/calls", { json: { agentId: a, contactId: c.id, reason: "manual call from dashboard" } }), {
    success: (r) => (r.queued ? `Call queued for ${when(r.scheduledFor)}` : r.reason),
  });
  const patch = useAction((p: Partial<Contact>) => api<Contact>(`/api/contacts/${c.id}`, { method: "PATCH", json: p }), { onSuccess: setC, success: "Saved" });
  const name = [c.firstName, c.lastName].filter(Boolean).join(" ") || "Unknown";
  const thread = [...(msgs.data?.messages ?? [])].reverse();
  return (
    <Modal open onClose={onClose} title={name} wide>
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-600">
          <span className="flex items-center gap-1.5"><Phone className="size-3.5" /> {phone(c.phone)}</span>
          {c.email && <span className="flex items-center gap-1.5"><Mail className="size-3.5" /> {c.email}</span>}
        </div>
        {Object.keys(c.fields ?? {}).length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(c.fields).map(([k, v]) => (
              <Badge key={k}>
                {k}: {String(v)}
              </Badge>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-end gap-2 rounded-lg bg-slate-50 p-3">
          <Field label="Call with">
            <Select className="w-52" value={a} onChange={(e) => setAgentId(e.target.value)}>
              {agents.data?.agents.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button variant="primary" disabled={!a || c.doNotCall} loading={callNow.isPending} onClick={() => callNow.mutate(undefined)}>
            <Phone className="size-4" /> Call now
          </Button>
          <span className="text-xs text-slate-500">Respects calling hours.</span>
        </div>
        <div className="flex flex-wrap gap-6">
          <Switch checked={c.doNotCall} onChange={(v) => patch.mutate({ doNotCall: v })} label="Do not call" />
          <Switch checked={c.doNotText} onChange={(v) => patch.mutate({ doNotText: v })} label="No texts or emails" />
        </div>
        <div>
          <p className="mb-2 text-sm font-semibold">Calls</p>
          {calls.data?.calls.length ? (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {calls.data.calls.map((x) => (
                <li key={x.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-slate-50" onClick={() => nav(`/calls/${x.id}`)}>
                  <OutcomeBadge outcome={x.outcome} status={x.status} />
                  <span className="min-w-0 flex-1 truncate text-slate-600">{x.summary ?? "–"}</span>
                  <span className="shrink-0 text-xs text-slate-400">{when(x.createdAt)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">No calls yet.</p>
          )}
        </div>
        <div>
          <p className="mb-2 text-sm font-semibold">Messages</p>
          {thread.length ? (
            <div className="space-y-2">
              {thread.map((m) => (
                <div key={m.id} className={cx("flex", m.direction === "inbound" ? "justify-start" : "justify-end")}>
                  <div className={cx("max-w-[80%] rounded-2xl px-3 py-2 text-sm", m.direction === "inbound" ? "bg-slate-100" : "bg-brand text-white")}>
                    <p className={cx("mb-0.5 flex items-center gap-1 text-[11px]", m.direction === "inbound" ? "text-slate-500" : "text-white/70")}>
                      {m.channel === "email" ? <Mail className="size-3" /> : <MessageSquare className="size-3" />} {when(m.createdAt)}
                    </p>
                    {m.subject && <p className="font-medium">{m.subject}</p>}
                    <p className="whitespace-pre-wrap">{m.body}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-500">No texts or emails yet.</p>
          )}
        </div>
      </div>
    </Modal>
  );
}

function AddContact({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [f, setF] = useState({ phone: "", firstName: "", lastName: "", email: "" });
  const add = useAction(() => api("/api/contacts", { json: Object.fromEntries(Object.entries(f).filter(([, v]) => v)) }), {
    success: "Contact added",
    onSuccess: () => {
      setF({ phone: "", firstName: "", lastName: "", email: "" });
      onClose();
    },
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add contact"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!f.phone} loading={add.isPending} onClick={() => add.mutate(undefined)}>
            Add
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Phone" className="sm:col-span-2">
          <Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="(415) 555-0100" />
        </Field>
        <Field label="First name">
          <Input value={f.firstName} onChange={(e) => setF({ ...f, firstName: e.target.value })} />
        </Field>
        <Field label="Last name">
          <Input value={f.lastName} onChange={(e) => setF({ ...f, lastName: e.target.value })} />
        </Field>
        <Field label="Email" className="sm:col-span-2">
          <Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}
