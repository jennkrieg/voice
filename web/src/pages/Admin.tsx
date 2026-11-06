import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Building2, Plus, ArrowRight } from "lucide-react";
import { api } from "../lib/api";
import { useApi, useAction } from "../lib/hooks";
import { useSession } from "../lib/session";
import { when } from "../lib/format";
import { Button, Card, CopyField, Empty, Field, Input, Modal, PageHeader, Spinner, Table, Stat } from "../components/ui";

type TenantRow = { id: string; name: string; timezone: string; createdAt: string; agents: number; numbers: number; calls30d: number; minutes30d: number; booked30d: number; lastCallAt: string | null };

const TIMEZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu", "America/Toronto", "Europe/London", "Australia/Sydney"];

export function AdminClients() {
  const { openTenant } = useSession();
  const nav = useNavigate();
  const q = useApi<{ tenants: TenantRow[] }>("/platform/tenants");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<any>(null);
  const [form, setForm] = useState({ name: "", timezone: "America/New_York", ownerEmail: "", ownerName: "" });
  const create = useAction(
    () =>
      api("/platform/tenants", {
        json: { name: form.name, timezone: form.timezone, owner: form.ownerEmail ? { email: form.ownerEmail, name: form.ownerName || undefined } : undefined },
      }),
    {
      onSuccess: (r) => {
        setCreating(false);
        setCreated(r);
        setForm({ name: "", timezone: "America/New_York", ownerEmail: "", ownerName: "" });
      },
    },
  );
  const tenants = q.data?.tenants ?? [];
  const totals = tenants.reduce((a, t) => ({ calls: a.calls + t.calls30d, minutes: a.minutes + t.minutes30d, booked: a.booked + t.booked30d }), { calls: 0, minutes: 0, booked: 0 });

  return (
    <>
      <PageHeader
        title="Clients"
        description="Every business you run agents for. Open one to manage its agents, numbers and calls."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus className="size-4" /> New client
          </Button>
        }
      />
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Clients" value={tenants.length} />
        <Stat label="Calls (30 days)" value={totals.calls.toLocaleString()} />
        <Stat label="Minutes (30 days)" value={totals.minutes.toLocaleString()} sub="Billable usage" />
        <Stat label="Bookings (30 days)" value={totals.booked.toLocaleString()} />
      </div>
      <Card padded={false}>
        {q.isLoading ? (
          <Spinner />
        ) : tenants.length === 0 ? (
          <Empty icon={<Building2 className="size-8" />} title="No clients yet">
            Create your first client to set up their agent.
          </Empty>
        ) : (
          <Table head={["Client", "Agents", "Numbers", "Calls (30d)", "Minutes (30d)", "Booked (30d)", "Last call", ""]}>
            {tenants.map((t) => (
              <tr key={t.id} className="hover:bg-slate-50">
                <td className="px-4 py-3">
                  <div className="font-medium">{t.name}</div>
                  <div className="text-xs text-slate-500">{t.timezone}</div>
                </td>
                <td className="px-4 py-3 tabular-nums">{t.agents}</td>
                <td className="px-4 py-3 tabular-nums">{t.numbers}</td>
                <td className="px-4 py-3 tabular-nums">{t.calls30d}</td>
                <td className="px-4 py-3 tabular-nums">{t.minutes30d}</td>
                <td className="px-4 py-3 tabular-nums">{t.booked30d}</td>
                <td className="px-4 py-3 text-slate-500">{when(t.lastCallAt)}</td>
                <td className="px-4 py-3 text-right">
                  <Button
                    size="sm"
                    onClick={() => {
                      openTenant(t.id, t.name);
                      nav("/");
                    }}
                  >
                    Open <ArrowRight className="size-3.5" />
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="New client"
        footer={
          <>
            <Button onClick={() => setCreating(false)}>Cancel</Button>
            <Button variant="primary" loading={create.isPending} disabled={!form.name} onClick={() => create.mutate(undefined)}>
              Create client
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Business name">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Bright Smile Dental" autoFocus />
          </Field>
          <Field label="Timezone">
            <select className="h-9 w-full rounded-lg border border-slate-300 px-3 text-sm" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
              {TIMEZONES.map((z) => (
                <option key={z}>{z}</option>
              ))}
            </select>
          </Field>
          <div className="rounded-lg bg-slate-50 p-4">
            <p className="mb-3 text-sm font-medium">Client login (optional)</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Owner email">
                <Input type="email" value={form.ownerEmail} onChange={(e) => setForm({ ...form, ownerEmail: e.target.value })} />
              </Field>
              <Field label="Owner name">
                <Input value={form.ownerName} onChange={(e) => setForm({ ...form, ownerName: e.target.value })} />
              </Field>
            </div>
            <p className="mt-2 text-xs text-slate-500">They'll sign in to this dashboard and see only their own business.</p>
          </div>
        </div>
      </Modal>

      <Modal open={!!created} onClose={() => setCreated(null)} title={`${created?.tenant?.name ?? "Client"} created`} footer={<Button variant="primary" onClick={() => setCreated(null)}>Done</Button>}>
        <div className="space-y-4 text-sm">
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-amber-800">Copy these now. They can't be shown again.</p>
          {created?.owner && (
            <div className="space-y-2">
              <p className="font-medium">Client login</p>
              <p className="text-slate-600">Email: {created.owner.email}</p>
              <Field label="Temporary password">
                <CopyField value={created.owner.temporaryPassword} />
              </Field>
            </div>
          )}
          <Field label="API key (for developers / automations)">
            <CopyField value={created?.apiKey ?? ""} secret />
          </Field>
        </div>
      </Modal>
    </>
  );
}

export function AdminTeam() {
  const q = useApi<{ users: any[] }>("/platform/users");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [temp, setTemp] = useState<string | null>(null);
  const add = useAction(() => api<{ temporaryPassword: string }>("/platform/users", { json: { email, name: name || undefined } }), {
    onSuccess: (r) => {
      setTemp(r.temporaryPassword);
      setEmail("");
      setName("");
    },
  });
  return (
    <>
      <PageHeader title="Platform admins" description="People on your team who can see and manage every client." />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card padded={false} className="lg:col-span-2">
          {q.isLoading ? (
            <Spinner />
          ) : (
            <Table head={["Name", "Email", "Last sign-in"]}>
              {q.data?.users.map((u) => (
                <tr key={u.id}>
                  <td className="px-4 py-3 font-medium">{u.name ?? "–"}</td>
                  <td className="px-4 py-3">{u.email}</td>
                  <td className="px-4 py-3 text-slate-500">{when(u.lastLoginAt)}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Card title="Add an admin">
          <div className="space-y-3">
            <Field label="Email">
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Button variant="primary" loading={add.isPending} disabled={!email} onClick={() => add.mutate(undefined)}>
              Add admin
            </Button>
            {temp && (
              <Field label="Temporary password (shown once)">
                <CopyField value={temp} />
              </Field>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}
