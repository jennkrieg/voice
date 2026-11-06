import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, Circle, Download, ExternalLink, RefreshCw, ShieldCheck, AlertTriangle } from "lucide-react";
import { api } from "../lib/api";
import { useApi, useAction } from "../lib/hooks";
import { useSession } from "../lib/session";
import { phone } from "../lib/format";
import { Badge, Button, Card, Field, Input, PageHeader, Spinner, Table, Textarea, cx } from "../components/ui";

type Compliance = {
  settings: { trustHub?: Record<string, string>; business?: Record<string, string> };
  labels: Record<string, string>;
  statuses: Record<string, { sid: string; label: string; status: string; name?: string; error?: string }>;
  numbers: { id: string; e164: string; trust: Record<string, { ok: boolean; error?: string }>; health: any; restedUntil: string | null }[];
};

const KEYS = [
  { key: "customerProfileSid", what: "Your verified business identity at Twilio. Required before anything else.", console: "https://console.twilio.com/us1/account/trust-hub/customer-profiles" },
  { key: "shakenStirSid", what: "Carriers mark your calls as verified (A-level attestation). Unsigned calls are far more likely to show 'Spam Likely'.", console: "https://console.twilio.com/us1/account/trust-hub/shaken-stir" },
  { key: "cnamSid", what: "Shows your business name instead of a city or 'Unknown' on caller ID.", console: "https://console.twilio.com/us1/account/trust-hub/cnam" },
  { key: "voiceIntegritySid", what: "Registers your numbers with the spam-labelling companies used by AT&T, Verizon and T-Mobile, and removes existing labels.", console: "https://console.twilio.com/us1/account/trust-hub/voice-integrity" },
  { key: "brandedCallingSid", what: "Optional: logo and call reason on supported phones.", console: "https://console.twilio.com/us1/account/trust-hub" },
];

const STATUS_TONE: Record<string, "green" | "amber" | "red" | "slate"> = { "twilio-approved": "green", "in-review": "amber", "pending-review": "amber", draft: "slate", "twilio-rejected": "red", error: "red" };

export function SpamProtection() {
  const { canManage } = useSession();
  const q = useApi<Compliance>("/api/compliance");
  const [th, setTh] = useState<Record<string, string>>({});
  const [biz, setBiz] = useState<Record<string, string>>({});
  useEffect(() => {
    if (q.data) {
      setTh(q.data.settings.trustHub ?? {});
      setBiz(q.data.settings.business ?? {});
    }
  }, [q.data]);
  const save = useAction(() => api("/api/compliance", { method: "PUT", json: { trustHub: th, business: biz } }), { success: "Saved" });
  const sync = useAction(() => api("/api/compliance/sync", { json: {} }), { success: "Numbers registered with your approved products" });
  if (q.isLoading || !q.data) return <Spinner />;
  const d = q.data;
  const approved = (k: string) => d.statuses[k]?.status === "twilio-approved";
  const atRisk = d.numbers.filter((n) => n.health?.status === "at_risk");

  const steps = [
    { done: approved("customerProfileSid"), label: "Business Profile approved" },
    { done: approved("shakenStirSid"), label: "Calls verified with STIR/SHAKEN" },
    { done: approved("cnamSid"), label: "Business name on caller ID (CNAM)" },
    { done: approved("voiceIntegritySid"), label: "Numbers registered with carrier spam engines (Voice Integrity)" },
    { done: !!biz.legalName && d.numbers.length > 0, label: "Numbers submitted to the Free Caller Registry" },
    { done: d.numbers.length > 0 && d.numbers.every((n) => Object.values(n.trust ?? {}).every((t) => t.ok)) && Object.keys(th).some((k) => th[k]), label: "Every number attached to your approved products" },
  ];

  return (
    <>
      <PageHeader title="Spam protection" description="Make sure outbound calls show up as a real, verified business instead of 'Spam Likely'." />
      {atRisk.length > 0 && (
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-medium">{atRisk.length} number{atRisk.length > 1 ? "s" : ""} may be labelled as spam</p>
            <p>
              {atRisk.map((n) => phone(n.e164)).join(", ")}: answer rates dropped sharply this week. They've been rested automatically if the agent allows it. Check them at{" "}
              <a className="underline" href="https://www.freecallerregistry.com" target="_blank" rel="noreferrer">freecallerregistry.com</a> and keep Voice Integrity enabled.
            </p>
          </div>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Checklist" className="lg:col-span-1">
          <ol className="space-y-3">
            {steps.map((s, i) => (
              <li key={i} className="flex items-start gap-2.5 text-sm">
                {s.done ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" /> : <Circle className="mt-0.5 size-4 shrink-0 text-slate-300" />}
                <span className={s.done ? "text-slate-700" : "text-slate-500"}>{s.label}</span>
              </li>
            ))}
          </ol>
          <div className="mt-5 rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">
            <p className="mb-1 font-medium text-slate-700">Already built in</p>
            <ul className="ml-4 list-disc space-y-0.5">
              <li>The agent speaks the moment someone answers (no robocall-style silence)</li>
              <li>Local caller ID that matches the person's area code</li>
              <li>The same person always sees the same number</li>
              <li>Daily call cap per number, spread across the pool</li>
              <li>Every number answers callbacks and texts with the same agent</li>
              <li>Numbers whose answer rate collapses are rested automatically</li>
              <li>Calling hours, do-not-call, and no repeat calls within 24 hours</li>
            </ul>
          </div>
        </Card>

        <div className="space-y-6 lg:col-span-2">
          <Card
            title="Carrier registration (Twilio Trust Hub)"
            description="Create each item once in the Twilio Console (it asks for the business's legal details; approval usually takes 1 to 3 business days), then paste its SID here. Every number, including ones bought later, is attached automatically."
            actions={
              canManage && (
                <Button size="sm" loading={sync.isPending} onClick={() => sync.mutate(undefined)}>
                  <RefreshCw className="size-3.5" /> Attach all numbers
                </Button>
              )
            }
          >
            <div className="space-y-4">
              {KEYS.map((k) => {
                const st = d.statuses[k.key];
                return (
                  <div key={k.key} className="grid gap-2 md:grid-cols-[1fr_1.1fr] md:items-start">
                    <div>
                      <p className="flex items-center gap-2 text-sm font-medium">
                        {d.labels[k.key]}
                        {st && <Badge tone={STATUS_TONE[st.status] ?? "slate"}>{st.status.replace("twilio-", "")}</Badge>}
                      </p>
                      <p className="text-xs text-slate-500">{k.what}</p>
                      <a href={k.console} target="_blank" rel="noreferrer" className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">
                        Open in Twilio <ExternalLink className="size-3" />
                      </a>
                    </div>
                    <Input disabled={!canManage} className="font-mono text-xs" placeholder="BU…" value={th[k.key] ?? ""} onChange={(e) => setTh({ ...th, [k.key]: e.target.value.trim() })} />
                  </div>
                );
              })}
            </div>
          </Card>

          <Card title="Business details" description="Used for the Free Caller Registry export and as a reference while filling in Twilio's forms.">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Legal business name">
                <Input disabled={!canManage} value={biz.legalName ?? ""} onChange={(e) => setBiz({ ...biz, legalName: e.target.value })} />
              </Field>
              <Field label="Caller ID name" hint="Max 15 characters, e.g. BRIGHT SMILE">
                <Input disabled={!canManage} maxLength={15} value={biz.callerIdName ?? ""} onChange={(e) => setBiz({ ...biz, callerIdName: e.target.value.toUpperCase() })} />
              </Field>
              <Field label="Website">
                <Input disabled={!canManage} value={biz.website ?? ""} onChange={(e) => setBiz({ ...biz, website: e.target.value })} />
              </Field>
              <Field label="EIN / tax ID">
                <Input disabled={!canManage} value={biz.ein ?? ""} onChange={(e) => setBiz({ ...biz, ein: e.target.value })} />
              </Field>
              <Field label="Business address" className="md:col-span-2">
                <Input disabled={!canManage} value={biz.address ?? ""} onChange={(e) => setBiz({ ...biz, address: e.target.value })} />
              </Field>
              <Field label="Contact email">
                <Input disabled={!canManage} value={biz.contactEmail ?? ""} onChange={(e) => setBiz({ ...biz, contactEmail: e.target.value })} />
              </Field>
              <Field label="Why you call people" className="md:col-span-2" hint="Plain description for registries, e.g. 'Returning calls to customers who requested an appointment'">
                <Textarea disabled={!canManage} rows={2} value={biz.useCase ?? ""} onChange={(e) => setBiz({ ...biz, useCase: e.target.value })} />
              </Field>
            </div>
            {canManage && (
              <div className="mt-5 flex flex-wrap gap-2">
                <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>
                  Save
                </Button>
                <a href="/api/compliance/registry.csv" className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50">
                  <Download className="size-4" /> Free Caller Registry file
                </a>
                <a href="https://www.freecallerregistry.com" target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-1 px-2 text-sm font-medium text-brand hover:underline">
                  freecallerregistry.com <ExternalLink className="size-3.5" />
                </a>
              </div>
            )}
          </Card>

          <Card title="Numbers" padded={false} actions={<Link to="/numbers" className="text-sm font-medium text-brand hover:underline">Manage numbers</Link>}>
            <Table head={["Number", ...Object.keys(d.labels).filter((k) => th[k]).map((k) => d.labels[k].split(" (")[0]), "Health"]}>
              {d.numbers.map((n) => (
                <tr key={n.id}>
                  <td className="whitespace-nowrap px-4 py-3 font-medium tabular-nums">{phone(n.e164)}</td>
                  {Object.keys(d.labels)
                    .filter((k) => th[k])
                    .map((k) => (
                      <td key={k} className="px-4 py-3">
                        {n.trust?.[k]?.ok ? <ShieldCheck className="size-4 text-emerald-600" /> : n.trust?.[k]?.error ? <span title={n.trust[k].error}><AlertTriangle className="size-4 text-red-500" /></span> : <Circle className="size-4 text-slate-300" />}
                      </td>
                    ))}
                  <td className="px-4 py-3"><HealthBadge health={n.health} restedUntil={n.restedUntil} /></td>
                </tr>
              ))}
            </Table>
          </Card>
        </div>
      </div>
    </>
  );
}

export function HealthBadge({ health, restedUntil }: { health: any; restedUntil: string | null }) {
  if (restedUntil && new Date(restedUntil) > new Date()) return <Badge tone="amber">Resting until {new Date(restedUntil).toLocaleDateString()}</Badge>;
  if (!health || health.status === "new" || !health.attempts) return <Badge>New</Badge>;
  const pct = Math.round(health.answerRate * 100);
  const tone = health.status === "good" ? "green" : health.status === "watch" ? "amber" : "red";
  const label = health.status === "good" ? "Healthy" : health.status === "watch" ? "Watch" : "Likely flagged";
  return (
    <span title={`${health.answered} of ${health.attempts} answered in 7 days`} className={cx("inline-flex")}>
      <Badge tone={tone}>
        {label} · {pct}% answered
      </Badge>
    </span>
  );
}
