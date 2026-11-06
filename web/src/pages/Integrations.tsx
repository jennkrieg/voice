import { useState } from "react";
import { CalendarDays, CheckCircle2, Mail, Webhook, Users } from "lucide-react";
import { api } from "../lib/api";
import { useApi, useAction, type Agent, type Integration } from "../lib/hooks";
import { useSession } from "../lib/session";
import { titleCase, when } from "../lib/format";
import { Badge, Button, Card, CopyField, Field, Input, Modal, PageHeader, Select, Spinner, Switch, useToast } from "../components/ui";

type Kind = "google_calendar" | "calcom" | "hubspot" | "gohighlevel" | "email_smtp" | "webhook";
const CATALOG: { kind: Kind; name: string; group: string; icon: any; blurb: string }[] = [
  { kind: "google_calendar", name: "Google Calendar", group: "Calendars", icon: CalendarDays, blurb: "Check availability and book on a Google calendar." },
  { kind: "calcom", name: "Cal.com", group: "Calendars", icon: CalendarDays, blurb: "Book into a Cal.com event type, with its own availability rules." },
  { kind: "hubspot", name: "HubSpot", group: "CRMs", icon: Users, blurb: "Look up callers, update fields, log calls, and call new contacts automatically." },
  { kind: "gohighlevel", name: "GoHighLevel", group: "CRMs", icon: Users, blurb: "Sync contacts and notes with a HighLevel sub-account." },
  { kind: "email_smtp", name: "Email (SMTP)", group: "Email", icon: Mail, blurb: "Send follow-ups and lead magnets from your own address." },
  { kind: "webhook", name: "Webhook / Zapier", group: "Automations", icon: Webhook, blurb: "Send call results to Zapier, Make, n8n, Salesforce or your own system." },
];

const SMTP_PRESETS: Record<string, { host: string; port: number; user?: string; note: string }> = {
  "Google Workspace / Gmail": { host: "smtp.gmail.com", port: 465, note: "Use an app password (Google account → Security → App passwords)." },
  "Microsoft 365 / Outlook": { host: "smtp.office365.com", port: 587, note: "SMTP AUTH must be enabled for the mailbox." },
  SendGrid: { host: "smtp.sendgrid.net", port: 587, user: "apikey", note: "Password is your SendGrid API key." },
  Postmark: { host: "smtp.postmarkapp.com", port: 587, note: "Username and password are both your server token." },
  Resend: { host: "smtp.resend.com", port: 465, user: "resend", note: "Password is your Resend API key." },
  Other: { host: "", port: 587, note: "" },
};

export function Integrations() {
  const { canManage } = useSession();
  const q = useApi<{ integrations: Integration[] }>("/api/integrations");
  const [adding, setAdding] = useState<Kind | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const toast = useToast();
  const remove = useAction((id: string) => api(`/api/integrations/${id}`, { method: "DELETE" }), { success: "Disconnected" });
  const connectGoogle = useAction(() => api<{ url: string }>("/api/integrations/google/connect", { json: {} }), { onSuccess: (r) => (window.location.href = r.url) });
  const list = q.data?.integrations ?? [];

  async function test(id: string) {
    setTesting(id);
    try {
      const r = await api<any>(`/api/integrations/${id}/test`, { json: {} });
      toast(r.openSlotsNext7Days != null ? `Connected. ${r.openSlotsNext7Days} open slots in the next 7 days.` : "Connected and working");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setTesting(null);
    }
  }

  return (
    <>
      <PageHeader title="Integrations" description="Connect calendars, CRMs, email and automations. Credentials are encrypted." />
      <Card title="Connected" padded={false} className="mb-6">
        {q.isLoading ? (
          <Spinner />
        ) : list.length === 0 ? (
          <p className="px-5 py-6 text-sm text-slate-500">Nothing connected yet. Pick one below.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {list.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <CheckCircle2 className="size-4 text-emerald-600" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{i.label ?? titleCase(i.kind)}</p>
                  <p className="text-xs text-slate-500">
                    {CATALOG.find((c) => c.kind === i.kind)?.name} · added {when(i.createdAt)} · <span className="font-mono">{i.id}</span>
                  </p>
                </div>
                <Button size="sm" loading={testing === i.id} onClick={() => test(i.id)}>
                  Test
                </Button>
                {canManage && (
                  <Button size="sm" variant="ghost" onClick={() => confirm("Disconnect this integration?") && remove.mutate(i.id)}>
                    Disconnect
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {CATALOG.map((c) => (
          <div key={c.kind} className="flex flex-col rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <div className="grid size-9 place-items-center rounded-lg bg-slate-100 text-slate-600">
                <c.icon className="size-4.5" />
              </div>
              <Badge>{c.group}</Badge>
            </div>
            <p className="font-semibold">{c.name}</p>
            <p className="mt-1 flex-1 text-sm text-slate-500">{c.blurb}</p>
            <Button className="mt-4" loading={c.kind === "google_calendar" && connectGoogle.isPending} onClick={() => (c.kind === "google_calendar" ? connectGoogle.mutate(undefined) : setAdding(c.kind))}>
              Connect
            </Button>
          </div>
        ))}
      </div>

      <CrmTriggers />
      {adding && <AddModal kind={adding} onClose={() => setAdding(null)} />}
    </>
  );
}

function AddModal({ kind, onClose }: { kind: Kind; onClose: () => void }) {
  const [label, setLabel] = useState("");
  const [f, setF] = useState<Record<string, any>>({ port: 587, callOnCreate: true, callOnPropertyChange: "", preset: "SendGrid", host: SMTP_PRESETS.SendGrid.host, user: "apikey" });
  const [created, setCreated] = useState<any>(null);
  const up = (k: string, v: any) => setF((x) => ({ ...x, [k]: v }));
  const name = CATALOG.find((c) => c.kind === kind)!.name;

  function body() {
    switch (kind) {
      case "calcom":
        return { kind, label: label || "Cal.com", settings: f.eventTypeId ? { eventTypeId: Number(f.eventTypeId) } : {}, secrets: { apiKey: f.apiKey } };
      case "hubspot":
        return {
          kind,
          label: label || "HubSpot",
          settings: { callOnCreate: !!f.callOnCreate, callOnPropertyChange: String(f.callOnPropertyChange || "").split(",").map((s: string) => s.trim()).filter(Boolean) },
          secrets: { accessToken: f.accessToken, ...(f.clientSecret ? { clientSecret: f.clientSecret } : {}) },
        };
      case "gohighlevel":
        return { kind, label: label || "GoHighLevel", settings: { locationId: f.locationId }, secrets: { token: f.token } };
      case "email_smtp":
        return {
          kind,
          label: label || f.fromEmail,
          settings: { host: f.host, port: Number(f.port), user: f.user, fromEmail: f.fromEmail, fromName: f.fromName || undefined, replyTo: f.replyTo || undefined },
          secrets: { password: f.password },
        };
      default:
        return { kind, label: label || "Webhook", settings: { url: f.url } };
    }
  }
  const save = useAction(() => api("/api/integrations", { json: body() }), {
    success: `${name} connected`,
    onSuccess: (r) => (kind === "webhook" ? setCreated(r) : onClose()),
  });

  if (created)
    return (
      <Modal open onClose={onClose} title="Webhook connected" footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <p className="mb-3 text-sm text-slate-600">Each event is signed with this secret in the <code>X-Signature</code> header (sha256 HMAC of the body). It's shown once.</p>
        <CopyField value={created.secrets.signingSecret} />
      </Modal>
    );

  return (
    <Modal
      open
      onClose={onClose}
      title={`Connect ${name}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>
            Connect
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Label" hint="So you can tell connections apart">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={name} />
        </Field>
        {kind === "calcom" && (
          <>
            <Field label="Cal.com API key" hint="Cal.com → Settings → Developer → API keys">
              <Input type="password" value={f.apiKey ?? ""} onChange={(e) => up("apiKey", e.target.value)} placeholder="cal_live_…" />
            </Field>
            <Field label="Default event type ID (optional)" hint="Can also be set per agent">
              <Input type="number" value={f.eventTypeId ?? ""} onChange={(e) => up("eventTypeId", e.target.value)} />
            </Field>
          </>
        )}
        {kind === "hubspot" && (
          <>
            <Field label="Private app access token" hint="HubSpot → Settings → Integrations → Private apps. Scopes: crm.objects.contacts.read and .write">
              <Input type="password" value={f.accessToken ?? ""} onChange={(e) => up("accessToken", e.target.value)} placeholder="pat-na1-…" />
            </Field>
            <Field label="App client secret (optional)" hint="Only needed for HubSpot app webhooks (to verify signatures)">
              <Input type="password" value={f.clientSecret ?? ""} onChange={(e) => up("clientSecret", e.target.value)} />
            </Field>
            <Switch checked={!!f.callOnCreate} onChange={(v) => up("callOnCreate", v)} label="Call new contacts automatically" hint="When HubSpot sends a contact.creation webhook" />
            <Field label="Also call when these properties change" hint="Comma-separated internal names, e.g. lifecyclestage, hs_lead_status">
              <Input value={f.callOnPropertyChange} onChange={(e) => up("callOnPropertyChange", e.target.value)} />
            </Field>
          </>
        )}
        {kind === "gohighlevel" && (
          <>
            <Field label="Private integration token" hint="Sub-account → Settings → Private Integrations. Scopes: contacts.readonly, contacts.write">
              <Input type="password" value={f.token ?? ""} onChange={(e) => up("token", e.target.value)} placeholder="pit-…" />
            </Field>
            <Field label="Location (sub-account) ID">
              <Input value={f.locationId ?? ""} onChange={(e) => up("locationId", e.target.value)} />
            </Field>
          </>
        )}
        {kind === "email_smtp" && (
          <>
            <Field label="Provider" hint={SMTP_PRESETS[f.preset]?.note}>
              <Select
                value={f.preset}
                onChange={(e) => {
                  const p = SMTP_PRESETS[e.target.value];
                  setF((x) => ({ ...x, preset: e.target.value, host: p.host, port: p.port, user: p.user ?? x.user ?? "" }));
                }}
              >
                {Object.keys(SMTP_PRESETS).map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </Select>
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="SMTP host" className="col-span-2">
                <Input value={f.host} onChange={(e) => up("host", e.target.value)} />
              </Field>
              <Field label="Port">
                <Input type="number" value={f.port} onChange={(e) => up("port", e.target.value)} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Username">
                <Input value={f.user ?? ""} onChange={(e) => up("user", e.target.value)} />
              </Field>
              <Field label="Password / API key">
                <Input type="password" value={f.password ?? ""} onChange={(e) => up("password", e.target.value)} />
              </Field>
              <Field label="From email">
                <Input type="email" value={f.fromEmail ?? ""} onChange={(e) => up("fromEmail", e.target.value)} />
              </Field>
              <Field label="From name">
                <Input value={f.fromName ?? ""} onChange={(e) => up("fromName", e.target.value)} />
              </Field>
            </div>
          </>
        )}
        {kind === "webhook" && (
          <Field label="URL" hint="We POST every event here: call.completed, appointment.booked, contact.updated, transfer.started, sms.received…">
            <Input value={f.url ?? ""} onChange={(e) => up("url", e.target.value)} placeholder="https://hooks.zapier.com/hooks/catch/…" />
          </Field>
        )}
      </div>
    </Modal>
  );
}

function CrmTriggers() {
  const t = useApi<any>("/api/tenant");
  const agents = useApi<{ agents: Agent[] }>("/api/agents");
  const ints = useApi<{ integrations: Integration[] }>("/api/integrations");
  const [agentId, setAgentId] = useState("");
  const a = agentId || agents.data?.agents[0]?.id || "";
  const hub = ints.data?.integrations.find((i) => i.kind === "hubspot");
  if (!t.data) return null;
  const hooks = t.data.inboundWebhooks;
  return (
    <Card title="Have your CRM trigger calls" description="Call new leads automatically. Calls respect your calling hours, do-not-call and retry rules." className="mt-6">
      <div className="space-y-5">
        <Field label="Agent that should call">
          <Select className="max-w-xs" value={a} onChange={(e) => setAgentId(e.target.value)}>
            {agents.data?.agents.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        </Field>
        <div>
          <p className="mb-1 text-sm font-medium">Any CRM or automation tool (GoHighLevel workflows, HubSpot workflows, Zapier, Make…)</p>
          <p className="mb-2 text-xs text-slate-500">Add a "webhook" action that POSTs the contact to this URL, with the secret in the <code>X-Webhook-Secret</code> header. Phone, name and email are picked up automatically.</p>
          <div className="space-y-2">
            <CopyField value={hooks.contact.replace("<AGENT_ID>", a)} />
            <CopyField value={hooks.secret} secret />
          </div>
        </div>
        {hub && (
          <div>
            <p className="mb-1 text-sm font-medium">HubSpot app webhooks</p>
            <p className="mb-2 text-xs text-slate-500">In your HubSpot app's webhook settings, subscribe to contact.creation (and property changes) with this target URL.</p>
            <CopyField value={hooks.hubspot.replace("<HUBSPOT_INTEGRATION_ID>", hub.id).replace("<AGENT_ID>", a)} />
          </div>
        )}
      </div>
    </Card>
  );
}
