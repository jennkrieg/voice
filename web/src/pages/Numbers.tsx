import { useState } from "react";
import { Phone, Plus, Search, Download } from "lucide-react";
import { api } from "../lib/api";
import { useApi, useAction, type Agent, type PhoneNumber } from "../lib/hooks";
import { phone, when } from "../lib/format";
import { Button, Card, Empty, ErrorNote, Field, Input, Modal, PageHeader, Select, Spinner, Table } from "../components/ui";

export function Numbers() {
  const numbers = useApi<{ numbers: PhoneNumber[] }>("/api/numbers");
  const agents = useApi<{ agents: Agent[] }>("/api/agents");
  const [buying, setBuying] = useState(false);
  const [importing, setImporting] = useState(false);
  const assign = useAction((v: { id: string; agentId: string | null }) => api(`/api/numbers/${v.id}`, { method: "PATCH", json: { agentId: v.agentId } }), { success: "Number updated" });
  const release = useAction((id: string) => api(`/api/numbers/${id}?release=true`, { method: "DELETE" }), { success: "Number released" });
  return (
    <>
      <PageHeader
        title="Phone numbers"
        description="Each number answers calls and texts with the agent you assign."
        actions={
          <>
            <Button onClick={() => setImporting(true)}>
              <Download className="size-4" /> Use an existing number
            </Button>
            <Button variant="primary" onClick={() => setBuying(true)}>
              <Plus className="size-4" /> Get a number
            </Button>
          </>
        }
      />
      <Card padded={false}>
        {numbers.isLoading ? (
          <Spinner />
        ) : !numbers.data?.numbers.length ? (
          <Empty icon={<Phone className="size-8" />} title="No numbers yet">
            Get a local number in any area code. It's ready for calls and texts within a minute.
          </Empty>
        ) : (
          <Table head={["Number", "Label", "Answered by", "Added", ""]}>
            {numbers.data.numbers.map((n) => (
              <tr key={n.id}>
                <td className="px-4 py-3 font-medium tabular-nums">{phone(n.e164)}</td>
                <td className="px-4 py-3 text-slate-600">{n.friendlyName ?? "–"}</td>
                <td className="px-4 py-3">
                  <Select className="w-56" value={n.agentId ?? ""} onChange={(e) => assign.mutate({ id: n.id, agentId: e.target.value || null })}>
                    <option value="">Not assigned (won't answer)</option>
                    {agents.data?.agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </Select>
                </td>
                <td className="px-4 py-3 text-slate-500">{when(n.createdAt)}</td>
                <td className="px-4 py-3 text-right">
                  <Button size="sm" variant="ghost" onClick={() => confirm(`Release ${phone(n.e164)}? You may not be able to get it back.`) && release.mutate(n.id)}>
                    Release
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <p className="mt-4 text-xs text-slate-500">US texting: register the business for A2P 10DLC in Twilio before sending texts at volume, or carriers may block them.</p>
      <BuyModal open={buying} onClose={() => setBuying(false)} agents={agents.data?.agents ?? []} />
      <ImportModal open={importing} onClose={() => setImporting(false)} agents={agents.data?.agents ?? []} />
    </>
  );
}

function BuyModal({ open, onClose, agents }: { open: boolean; onClose: () => void; agents: Agent[] }) {
  const [areaCode, setAreaCode] = useState("");
  const [contains, setContains] = useState("");
  const [agentId, setAgentId] = useState("");
  const [results, setResults] = useState<any[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [searching, setSearching] = useState(false);
  const buy = useAction((p: string) => api("/api/numbers", { json: { phoneNumber: p, agentId: agentId || undefined } }), { success: "Number added", onSuccess: onClose });
  async function search() {
    setSearching(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ ...(areaCode ? { areaCode } : {}), ...(contains ? { contains } : {}) });
      setResults((await api<{ numbers: any[] }>(`/api/numbers/available?${qs}`)).numbers);
    } catch (e) {
      setError(e);
    } finally {
      setSearching(false);
    }
  }
  return (
    <Modal open={open} onClose={onClose} title="Get a phone number" wide>
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Area code">
            <Input className="w-28" placeholder="415" value={areaCode} onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, "").slice(0, 3))} />
          </Field>
          <Field label="Contains (optional)">
            <Input className="w-36" placeholder="7777" value={contains} onChange={(e) => setContains(e.target.value)} />
          </Field>
          <Field label="Assign to">
            <Select className="w-48" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              <option value="">Decide later</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button onClick={search} loading={searching}>
            <Search className="size-4" /> Search
          </Button>
        </div>
        <ErrorNote error={error} />
        {results && (results.length === 0 ? (
          <p className="text-sm text-slate-500">No numbers found. Try another area code.</p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            {results.map((r) => (
              <li key={r.phoneNumber} className="flex items-center justify-between px-4 py-2.5">
                <div>
                  <p className="font-medium tabular-nums">{phone(r.phoneNumber)}</p>
                  <p className="text-xs text-slate-500">{[r.locality, r.region].filter(Boolean).join(", ")}</p>
                </div>
                <Button size="sm" variant="primary" loading={buy.isPending && buy.variables === r.phoneNumber} onClick={() => buy.mutate(r.phoneNumber)}>
                  Get this number
                </Button>
              </li>
            ))}
          </ul>
        ))}
      </div>
    </Modal>
  );
}

function ImportModal({ open, onClose, agents }: { open: boolean; onClose: () => void; agents: Agent[] }) {
  const [num, setNum] = useState("");
  const [agentId, setAgentId] = useState("");
  const imp = useAction(() => api("/api/numbers/import", { json: { phoneNumber: num, agentId: agentId || undefined } }), { success: "Number connected", onSuccess: onClose });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Use an existing number"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!num} loading={imp.isPending} onClick={() => imp.mutate(undefined)}>
            Connect number
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-600">For a number already in the platform's Twilio account (including numbers ported in from another carrier). It's switched over to the agent right away.</p>
        <Field label="Phone number">
          <Input placeholder="+1 415 555 0100" value={num} onChange={(e) => setNum(e.target.value)} />
        </Field>
        <Field label="Assign to">
          <Select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">Decide later</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}
