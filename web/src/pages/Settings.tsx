import { useEffect, useState } from "react";
import { UserPlus } from "lucide-react";
import { api } from "../lib/api";
import { useApi, useAction } from "../lib/hooks";
import { useSession } from "../lib/session";
import { when } from "../lib/format";
import { Badge, Button, Card, CopyField, Field, Input, Modal, PageHeader, Select, Spinner, Table } from "../components/ui";

export function SettingsPage() {
  const { canManage, me, isAdmin } = useSession();
  const t = useApi<any>("/api/tenant");
  const users = useApi<{ users: any[] }>("/api/users");
  const [acct, setAcct] = useState({ name: "", timezone: "" });
  useEffect(() => {
    if (t.data) setAcct({ name: t.data.name, timezone: t.data.timezone });
  }, [t.data]);
  const saveAcct = useAction(() => api("/api/tenant", { method: "PATCH", json: acct }), { success: "Saved" });
  const [invite, setInvite] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  const rotate = useAction(() => api<{ apiKey: string }>("/api/tenant/rotate-key", { json: {} }), { onSuccess: (r) => setKey(r.apiKey) });
  const removeUser = useAction((id: string) => api(`/api/users/${id}`, { method: "DELETE" }), { success: "Removed" });

  if (t.isLoading) return <Spinner />;
  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Business">
          <div className="space-y-4">
            <Field label="Name">
              <Input disabled={!canManage} value={acct.name} onChange={(e) => setAcct({ ...acct, name: e.target.value })} />
            </Field>
            <Field label="Timezone">
              <Input disabled={!canManage} value={acct.timezone} onChange={(e) => setAcct({ ...acct, timezone: e.target.value })} />
            </Field>
            {canManage && (
              <Button variant="primary" loading={saveAcct.isPending} onClick={() => saveAcct.mutate(undefined)}>
                Save
              </Button>
            )}
          </div>
        </Card>
        {!isAdmin && <PasswordCard />}
        <Card
          title="Team"
          description="People who can sign in to this account."
          padded={false}
          className="lg:col-span-2"
          actions={
            canManage && (
              <Button size="sm" onClick={() => setInvite(true)}>
                <UserPlus className="size-3.5" /> Add person
              </Button>
            )
          }
        >
          <Table head={["Name", "Email", "Role", "Last sign-in", ""]}>
            {users.data?.users.map((u) => (
              <tr key={u.id}>
                <td className="px-4 py-3 font-medium">{u.name ?? "–"}</td>
                <td className="px-4 py-3">{u.email}</td>
                <td className="px-4 py-3">
                  <Badge tone={u.role === "owner" ? "violet" : "slate"}>{u.role === "owner" ? "Owner" : "Member"}</Badge>
                </td>
                <td className="px-4 py-3 text-slate-500">{when(u.lastLoginAt)}</td>
                <td className="px-4 py-3 text-right">
                  {canManage && u.id !== me?.user.id && (
                    <Button size="sm" variant="ghost" onClick={() => confirm(`Remove ${u.email}?`) && removeUser.mutate(u.id)}>
                      Remove
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        </Card>
        {canManage && (
          <Card title="API access" description="For developers and automations. Use as a Bearer token on /api." className="lg:col-span-2">
            <div className="space-y-4">
              {key ? (
                <Field label="New API key (shown once; the old key no longer works)">
                  <CopyField value={key} />
                </Field>
              ) : (
                <Button loading={rotate.isPending} onClick={() => confirm("Create a new API key? The current key stops working immediately.") && rotate.mutate(undefined)}>
                  Create new API key
                </Button>
              )}
              <Field label="Inbound webhook secret" hint="Sent by your CRM in the X-Webhook-Secret header. See Integrations for the full URLs.">
                <CopyField value={t.data.inboundWebhooks.secret} secret />
              </Field>
            </div>
          </Card>
        )}
      </div>
      <InviteModal open={invite} onClose={() => setInvite(false)} />
    </>
  );
}

function PasswordCard() {
  const [f, setF] = useState({ currentPassword: "", newPassword: "" });
  const change = useAction(() => api("/auth/password", { json: f }), { success: "Password changed", onSuccess: () => setF({ currentPassword: "", newPassword: "" }) });
  return (
    <Card title="Your password">
      <div className="space-y-4">
        <Field label="Current password">
          <Input type="password" value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} />
        </Field>
        <Field label="New password" hint="At least 10 characters. Signs you out on other devices.">
          <Input type="password" value={f.newPassword} onChange={(e) => setF({ ...f, newPassword: e.target.value })} />
        </Field>
        <Button disabled={!f.currentPassword || f.newPassword.length < 10} loading={change.isPending} onClick={() => change.mutate(undefined)}>
          Change password
        </Button>
      </div>
    </Card>
  );
}

function InviteModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [f, setF] = useState({ email: "", name: "", role: "member" });
  const [temp, setTemp] = useState<string | null>(null);
  const add = useAction(() => api<{ temporaryPassword: string }>("/api/users", { json: { ...f, name: f.name || undefined } }), { onSuccess: (r) => setTemp(r.temporaryPassword) });
  const close = () => {
    setTemp(null);
    setF({ email: "", name: "", role: "member" });
    onClose();
  };
  return (
    <Modal
      open={open}
      onClose={close}
      title="Add a person"
      footer={
        temp ? (
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" disabled={!f.email} loading={add.isPending} onClick={() => add.mutate(undefined)}>
              Add
            </Button>
          </>
        )
      }
    >
      {temp ? (
        <div className="space-y-3 text-sm">
          <p>
            Send <b>{f.email}</b> this temporary password. They can change it under Settings.
          </p>
          <CopyField value={temp} />
        </div>
      ) : (
        <div className="space-y-4">
          <Field label="Email">
            <Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          </Field>
          <Field label="Name">
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label="Role" hint="Owners can manage the team, API keys and integrations.">
            <Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
              <option value="member">Member</option>
              <option value="owner">Owner</option>
            </Select>
          </Field>
        </div>
      )}
    </Modal>
  );
}
