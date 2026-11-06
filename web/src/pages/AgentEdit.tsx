import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Lightbulb, Pause, Phone, Play, Plus, Save, Trash2, Volume2 } from "lucide-react";
import { api, apiBlob, mediaUrl } from "../lib/api";
import { useApi, useAction, type Agent, type Integration } from "../lib/hooks";
import { useSession } from "../lib/session";
import { Badge, Button, Card, ErrorNote, Field, Input, Modal, Select, Slider, Spinner, Switch, Tabs, Textarea, cx, useToast } from "../components/ui";

type Cfg = any;
type Setter = (path: string, value: unknown) => void;
const TABS = [
  { id: "basics", label: "Basics" },
  { id: "voice", label: "Voice & sound" },
  { id: "calendar", label: "Calendar" },
  { id: "crm", label: "CRM" },
  { id: "transfers", label: "Transfers" },
  { id: "followups", label: "Follow-ups & texting" },
  { id: "rules", label: "Calling rules" },
] as const;
type TabId = (typeof TABS)[number]["id"];

function setPath(obj: Cfg, path: string, value: unknown): Cfg {
  const next = structuredClone(obj);
  const keys = path.split(".");
  let o = next;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  o[keys.at(-1)!] = value;
  return next;
}

const TZ = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu", "America/Toronto", "Europe/London", "Australia/Sydney"];

export function AgentEdit() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const q = useApi<Agent>(`/api/agents/${id}`);
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [name, setName] = useState("");
  const [tab, setTab] = useState<TabId>("basics");
  const [error, setError] = useState<unknown>(null);
  const [coachOpen, setCoachOpen] = useState(false);
  const original = useRef<string>("");

  useEffect(() => {
    if (q.data && !cfg) {
      setCfg(q.data.config);
      setName(q.data.name);
      original.current = JSON.stringify([q.data.name, q.data.config]);
    }
  }, [q.data, cfg]);
  const dirty = cfg && JSON.stringify([name, cfg]) !== original.current;
  const set: Setter = (path, value) => setCfg((c: Cfg) => setPath(c, path, value));

  const save = useAction(() => api<Agent>(`/api/agents/${id}`, { method: "PATCH", json: { name, config: cfg } }), {
    success: "Saved",
    onSuccess: (a) => {
      setCfg(a.config);
      original.current = JSON.stringify([a.name, a.config]);
      setError(null);
    },
  });
  const remove = useAction(() => api(`/api/agents/${id}`, { method: "DELETE" }), { success: "Agent deleted", onSuccess: () => nav("/agents") });

  if (q.isLoading || !cfg) return <Spinner />;
  return (
    <>
      <Link to="/agents" className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft className="size-4" /> Agents
      </Link>
      <div className="sticky top-0 z-20 -mx-4 mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <div className="min-w-0">
          <input value={name} onChange={(e) => setName(e.target.value)} className="w-full bg-transparent text-xl font-semibold tracking-tight focus:outline-none" />
          <p className="text-sm text-slate-500">
            {cfg.agentName} · {cfg.businessName}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {dirty && <Badge tone="amber">Unsaved changes</Badge>}
          <Button onClick={() => setCoachOpen(true)}>
            <Lightbulb className="size-4" /> Coaching report
          </Button>
          <Button
            variant="primary"
            disabled={!dirty}
            loading={save.isPending}
            onClick={() =>
              save.mutate(undefined, {
                onError: (e) => {
                  setError(e);
                  toast("Couldn't save. Check the highlighted settings.", "error");
                },
              })
            }
          >
            <Save className="size-4" /> Save
          </Button>
        </div>
      </div>
      {error ? <div className="mb-4"><ErrorNote error={error} /></div> : null}
      <Tabs tabs={[...TABS]} value={tab} onChange={setTab} />
      <div className="mt-6 space-y-6">
        {tab === "basics" && <Basics cfg={cfg} set={set} />}
        {tab === "voice" && <VoiceTab cfg={cfg} set={set} agentId={id!} />}
        {tab === "calendar" && <CalendarTab cfg={cfg} set={set} />}
        {tab === "crm" && <CrmTab cfg={cfg} set={set} />}
        {tab === "transfers" && <TransfersTab cfg={cfg} set={set} />}
        {tab === "followups" && <FollowupsTab cfg={cfg} set={set} />}
        {tab === "rules" && <RulesTab cfg={cfg} set={set} />}
        {tab === "basics" && (
          <Card title="Danger zone">
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-slate-600">Delete this agent. Its call history stays, but numbers assigned to it stop answering.</p>
              <Button variant="danger" loading={remove.isPending} onClick={() => confirm("Delete this agent?") && remove.mutate(undefined)}>
                <Trash2 className="size-4" /> Delete agent
              </Button>
            </div>
          </Card>
        )}
      </div>
      <CoachModal open={coachOpen} onClose={() => setCoachOpen(false)} agentId={id!} />
    </>
  );
}

function Basics({ cfg, set }: { cfg: Cfg; set: Setter }) {
  return (
    <>
      <Card title="Identity">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Business name">
            <Input value={cfg.businessName} onChange={(e) => set("businessName", e.target.value)} />
          </Field>
          <Field label="What the agent calls itself">
            <Input value={cfg.agentName} onChange={(e) => set("agentName", e.target.value)} />
          </Field>
          <Field label="Timezone" hint="Used for booking and calling hours">
            <Select value={cfg.timezone} onChange={(e) => set("timezone", e.target.value)}>
              {[...new Set([cfg.timezone, ...TZ])].map((z) => (
                <option key={z}>{z}</option>
              ))}
            </Select>
          </Field>
          <Field label="Language">
            <Select value={cfg.language} onChange={(e) => set("language", e.target.value)}>
              {["en-US", "en-GB", "en-AU", "es", "fr", "de", "pt", "it", "nl", "hi", "ja"].map((l) => (
                <option key={l}>{l}</option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>
      <Card title="Instructions" description="What the agent is for and how it should behave. Write it like you'd brief a new receptionist.">
        <Textarea rows={12} value={cfg.instructions} onChange={(e) => set("instructions", e.target.value)} />
      </Card>
      <Card title="Business knowledge" description="Facts it can share: services, prices, hours, address, policies, FAQs. It won't make up anything that isn't here.">
        <Textarea rows={10} value={cfg.knowledge} onChange={(e) => set("knowledge", e.target.value)} />
      </Card>
      <Card title="Greetings" description="Placeholders: {businessName} {agentName} {firstName} {firstNameComma} {recordingNotice}">
        <div className="space-y-4">
          <Field label="Answering a call">
            <Textarea rows={2} value={cfg.inboundGreeting} onChange={(e) => set("inboundGreeting", e.target.value)} />
          </Field>
          <Field label="Placing a call">
            <Textarea rows={2} value={cfg.outboundGreeting} onChange={(e) => set("outboundGreeting", e.target.value)} />
          </Field>
          <Field label="Voicemail message" hint="Left after the beep when an outbound call reaches voicemail, in the agent's own voice.">
            <Textarea rows={2} value={cfg.voicemailMessage} onChange={(e) => set("voicemailMessage", e.target.value)} />
          </Field>
        </div>
      </Card>
    </>
  );
}

function useAudio() {
  const ref = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const play = (key: string, src: string) => {
    ref.current?.pause();
    if (playing === key) return setPlaying(null);
    const a = new Audio(src);
    ref.current = a;
    a.onended = () => setPlaying(null);
    void a.play();
    setPlaying(key);
  };
  useEffect(() => () => ref.current?.pause(), []);
  return { play, playing, stop: () => (ref.current?.pause(), setPlaying(null)) };
}

function VoiceTab({ cfg, set, agentId }: { cfg: Cfg; set: Setter; agentId: string }) {
  const voices = useApi<{ voices: { voiceId: string; name: string; category?: string; labels: Record<string, string>; previewUrl?: string }[] }>("/api/voices", { retry: false });
  const [filter, setFilter] = useState("");
  const [sample, setSample] = useState(`Hi, thanks for calling ${cfg.businessName}! This is ${cfg.agentName}. How can I help you today?`);
  const [previewing, setPreviewing] = useState(false);
  const [testPhone, setTestPhone] = useState("");
  const audio = useAudio();
  const toast = useToast();
  const v = cfg.voice;
  const list = useMemo(
    () =>
      (voices.data?.voices ?? []).filter((x) => {
        const hay = `${x.name} ${Object.values(x.labels).join(" ")}`.toLowerCase();
        return !filter || hay.includes(filter.toLowerCase());
      }),
    [voices.data, filter],
  );
  const testCall = useAction(() => api(`/api/agents/${agentId}/test-call`, { json: { phone: testPhone } }), {
    success: (r: any) => (r.queued ? "Calling you in a few seconds…" : `Couldn't call: ${r.reason}`),
  });

  async function previewMine() {
    setPreviewing(true);
    try {
      const blob = await apiBlob("/api/voices/preview", { text: sample, voice: v });
      audio.play("mine", URL.createObjectURL(blob));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setPreviewing(false);
    }
  }

  return (
    <>
      <div className="grid gap-6 lg:grid-cols-5">
        <Card title="Voice" description="Voices from your ElevenLabs library. Press play to hear each one." className="lg:col-span-3" padded={false}>
          <div className="border-b border-slate-100 p-4">
            <Input placeholder="Search by name, accent, gender, age…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          {voices.isLoading ? (
            <Spinner />
          ) : voices.error ? (
            <div className="space-y-3 p-5">
              <ErrorNote error={voices.error} />
              <Field label="Voice ID" hint="Paste a voice ID from ElevenLabs.">
                <Input value={v.voiceId ?? ""} onChange={(e) => set("voice.voiceId", e.target.value || undefined)} />
              </Field>
            </div>
          ) : (
            <ul className="max-h-[420px] divide-y divide-slate-100 overflow-y-auto">
              {list.map((x) => (
                <li key={x.voiceId} className={cx("flex items-center gap-3 px-4 py-2.5", v.voiceId === x.voiceId && "bg-brand-soft")}>
                  <button
                    disabled={!x.previewUrl}
                    onClick={() => x.previewUrl && audio.play(x.voiceId, x.previewUrl)}
                    className="grid size-8 shrink-0 place-items-center rounded-full border border-slate-200 bg-white text-slate-600 hover:border-brand hover:text-brand disabled:opacity-30"
                    aria-label={`Play ${x.name}`}
                  >
                    {audio.playing === x.voiceId ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{x.name}</p>
                    <p className="truncate text-xs text-slate-500">{Object.values(x.labels).join(" · ") || x.category}</p>
                  </div>
                  {v.voiceId === x.voiceId ? (
                    <Badge tone="violet">Selected</Badge>
                  ) : (
                    <Button size="sm" onClick={() => set("voice.voiceId", x.voiceId)}>
                      Use
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <div className="space-y-6 lg:col-span-2">
          <Card title="Voice settings">
            <div className="space-y-5">
              <Field label="Model">
                <Select value={v.model ?? ""} onChange={(e) => set("voice.model", e.target.value || undefined)}>
                  <option value="">Flash v2.5 (fastest, recommended for calls)</option>
                  <option value="eleven_turbo_v2_5">Turbo v2.5 (fast)</option>
                  <option value="eleven_multilingual_v2">Multilingual v2 (most expressive, slower)</option>
                </Select>
              </Field>
              <Slider label="Stability" value={v.stability} min={0} max={1} step={0.05} onChange={(x) => set("voice.stability", x)} format={(x) => x.toFixed(2)} hint="Lower sounds more natural and varied; higher is steadier." />
              <Slider label="Clarity" value={v.similarityBoost} min={0} max={1} step={0.05} onChange={(x) => set("voice.similarityBoost", x)} format={(x) => x.toFixed(2)} />
              <Slider label="Style" value={v.style} min={0} max={1} step={0.05} onChange={(x) => set("voice.style", x)} format={(x) => x.toFixed(2)} hint="Adds emotion. Keep low (0 to 0.3) for phone calls." />
              <Slider label="Speed" value={v.speed} min={0.7} max={1.2} step={0.05} onChange={(x) => set("voice.speed", x)} format={(x) => `${x.toFixed(2)}×`} />
            </div>
          </Card>
          <Card title="Hear it">
            <div className="space-y-3">
              <Textarea rows={3} value={sample} onChange={(e) => setSample(e.target.value)} />
              <Button onClick={previewMine} loading={previewing} className="w-full">
                <Volume2 className="size-4" /> {audio.playing === "mine" ? "Stop" : "Preview with these settings"}
              </Button>
              <div className="border-t border-slate-100 pt-3">
                <p className="mb-2 text-sm font-medium">Test call</p>
                <p className="mb-2 text-xs text-slate-500">Save first. The agent calls you right away, using the full call setup.</p>
                <div className="flex gap-2">
                  <Input placeholder="(415) 555-0100" value={testPhone} onChange={(e) => setTestPhone(e.target.value)} />
                  <Button loading={testCall.isPending} disabled={!testPhone} onClick={() => testCall.mutate(undefined)}>
                    <Phone className="size-4" /> Call me
                  </Button>
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>
      <Ambience cfg={cfg} set={set} audio={audio} />
    </>
  );
}

function Ambience({ cfg, set, audio }: { cfg: Cfg; set: Setter; audio: ReturnType<typeof useAudio> }) {
  const amb = cfg.ambience;
  const presets = [
    { id: "none", label: "Off", desc: "Clean line" },
    { id: "office", label: "Office", desc: "Quiet room, distant keyboard" },
    { id: "call_center", label: "Call centre", desc: "Busy room, many voices" },
    { id: "coffee_shop", label: "Coffee shop", desc: "Murmur, cups and spoons" },
    { id: "custom", label: "My recording", desc: "Your own WAV file" },
  ];
  return (
    <Card title="Background sound" description="Mix a subtle room sound under the voice so calls feel less robotic.">
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {presets.map((p) => (
          <div key={p.id} className={cx("rounded-xl border p-3", amb.preset === p.id ? "border-brand bg-brand-soft ring-1 ring-brand" : "border-slate-200")}>
            <button className="w-full text-left" onClick={() => set("ambience.preset", p.id)}>
              <p className="text-sm font-semibold">{p.label}</p>
              <p className="text-xs text-slate-500">{p.desc}</p>
            </button>
            {["office", "call_center", "coffee_shop"].includes(p.id) && (
              <button
                onClick={() => audio.play(`amb-${p.id}`, mediaUrl(`/api/ambience/${p.id}.wav?volume=${Math.min(1, amb.volume * 4)}`))}
                className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
              >
                {audio.playing === `amb-${p.id}` ? <Pause className="size-3" /> : <Play className="size-3" />} Listen
              </button>
            )}
          </div>
        ))}
      </div>
      {amb.preset !== "none" && (
        <div className="mt-5 grid gap-5 md:grid-cols-2">
          <Slider label="Volume" value={amb.volume} min={0} max={0.4} step={0.01} onChange={(x) => set("ambience.volume", x)} format={(x) => `${Math.round(x * 100)}%`} hint="8% to 15% sounds natural. Higher competes with the voice." />
          <Field label={amb.preset === "custom" ? "Recording URL" : "Use a real recording instead (optional)"} hint="Link to a WAV file (any sample rate). Real room recordings sound the most authentic.">
            <Input placeholder="https://…/cafe-ambience.wav" value={amb.url ?? ""} onChange={(e) => set("ambience.url", e.target.value || undefined)} />
          </Field>
        </div>
      )}
    </Card>
  );
}

function IntegrationSelect({ kinds, value, onChange, empty }: { kinds: string[]; value?: string; onChange: (v?: string) => void; empty: string }) {
  const q = useApi<{ integrations: Integration[] }>("/api/integrations");
  const list = (q.data?.integrations ?? []).filter((i) => kinds.includes(i.kind));
  return (
    <div className="flex items-center gap-2">
      <Select value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">{empty}</option>
        {list.map((i) => (
          <option key={i.id} value={i.id}>
            {i.label ?? i.kind}
          </option>
        ))}
      </Select>
      <Link to="/integrations" className="shrink-0 text-sm font-medium text-brand hover:underline">
        Connect…
      </Link>
    </div>
  );
}

const DAYS = [
  ["mon", "Monday"],
  ["tue", "Tuesday"],
  ["wed", "Wednesday"],
  ["thu", "Thursday"],
  ["fri", "Friday"],
  ["sat", "Saturday"],
  ["sun", "Sunday"],
] as const;

function CalendarTab({ cfg, set }: { cfg: Cfg; set: Setter }) {
  const c = cfg.calendar;
  const ints = useApi<{ integrations: Integration[] }>("/api/integrations");
  const kind = ints.data?.integrations.find((i) => i.id === c.integrationId)?.kind;
  const hours = c.businessHours ?? {};
  return (
    <>
      <Card title="Booking calendar" description="Where the agent checks availability and books appointments.">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Calendar">
            <IntegrationSelect kinds={["google_calendar", "calcom"]} value={c.integrationId} onChange={(v) => set("calendar.integrationId", v)} empty="No calendar (agent won't book)" />
          </Field>
          {kind === "calcom" && (
            <Field label="Cal.com event type ID" hint="The number in the event type's URL in Cal.com.">
              <Input type="number" value={c.calcomEventTypeId ?? ""} onChange={(e) => set("calendar.calcomEventTypeId", e.target.value ? Number(e.target.value) : undefined)} />
            </Field>
          )}
          <Field label="Event title" hint="{name} is replaced with the person's name">
            <Input value={c.eventTitle} onChange={(e) => set("calendar.eventTitle", e.target.value)} />
          </Field>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Length (minutes)">
            <Input type="number" min={5} value={c.durationMinutes} onChange={(e) => set("calendar.durationMinutes", Number(e.target.value))} />
          </Field>
          <Field label="Buffer between (minutes)">
            <Input type="number" min={0} value={c.bufferMinutes} onChange={(e) => set("calendar.bufferMinutes", Number(e.target.value))} />
          </Field>
          <Field label="Minimum notice (minutes)">
            <Input type="number" min={0} value={c.minNoticeMinutes} onChange={(e) => set("calendar.minNoticeMinutes", Number(e.target.value))} />
          </Field>
          <Field label="Book up to (days ahead)">
            <Input type="number" min={1} max={90} value={c.maxDaysAhead} onChange={(e) => set("calendar.maxDaysAhead", Number(e.target.value))} />
          </Field>
        </div>
      </Card>
      {kind !== "calcom" && (
        <Card title="Bookable hours" description={`In ${cfg.timezone}. Busy times on the calendar are skipped automatically.`}>
          <div className="divide-y divide-slate-100">
            {DAYS.map(([key, label]) => {
              const windows: [string, string][] = hours[key] ?? [];
              return (
                <div key={key} className="flex flex-wrap items-center gap-3 py-2.5">
                  <div className="w-32">
                    <Switch checked={windows.length > 0} onChange={(on) => set(`calendar.businessHours.${key}`, on ? [["09:00", "17:00"]] : [])} label={label} />
                  </div>
                  {windows.map((w, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <Input type="time" className="w-28" value={w[0]} onChange={(e) => set(`calendar.businessHours.${key}`, windows.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))} />
                      <span className="text-slate-400">–</span>
                      <Input type="time" className="w-28" value={w[1]} onChange={(e) => set(`calendar.businessHours.${key}`, windows.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} />
                      {windows.length > 1 && (
                        <button className="p-1 text-slate-400 hover:text-red-600" onClick={() => set(`calendar.businessHours.${key}`, windows.filter((_, j) => j !== i))} aria-label="Remove">
                          <Trash2 className="size-3.5" />
                        </button>
                      )}
                    </div>
                  ))}
                  {windows.length > 0 && (
                    <button className="text-xs font-medium text-brand hover:underline" onClick={() => set(`calendar.businessHours.${key}`, [...windows, ["13:00", "17:00"]])}>
                      + Add hours
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </>
  );
}

function KeyValueRows({ rows, onChange, keyLabel, valueLabel, keyPlaceholder, valuePlaceholder }: { rows: [string, string][]; onChange: (r: [string, string][]) => void; keyLabel: string; valueLabel: string; keyPlaceholder?: string; valuePlaceholder?: string }) {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[1fr_2fr_auto] gap-2 text-xs font-medium text-slate-500">
        <span>{keyLabel}</span>
        <span>{valueLabel}</span>
        <span className="w-8" />
      </div>
      {rows.map(([k, v], i) => (
        <div key={i} className="grid grid-cols-[1fr_2fr_auto] gap-2">
          <Input className="font-mono text-xs" placeholder={keyPlaceholder} value={k} onChange={(e) => onChange(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} />
          <Input placeholder={valuePlaceholder} value={v} onChange={(e) => onChange(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} />
          <button className="w-8 text-slate-400 hover:text-red-600" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label="Remove">
            <Trash2 className="mx-auto size-4" />
          </button>
        </div>
      ))}
      <Button size="sm" variant="ghost" onClick={() => onChange([...rows, ["", ""]])}>
        <Plus className="size-3.5" /> Add
      </Button>
    </div>
  );
}

function CrmTab({ cfg, set }: { cfg: Cfg; set: Setter }) {
  const c = cfg.crm;
  const rows = Object.entries(c.updatableFields ?? {}) as [string, string][];
  return (
    <>
      <Card title="CRM" description="The agent looks up callers here, saves what they tell it, and logs every call.">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="CRM">
            <IntegrationSelect kinds={["hubspot", "gohighlevel"]} value={c.integrationId} onChange={(v) => set("crm.integrationId", v)} empty="No CRM (contacts stay in this dashboard)" />
          </Field>
          <div className="pt-6">
            <Switch checked={c.logCalls} onChange={(v) => set("crm.logCalls", v)} label="Log each call as a note" hint="Summary, outcome and a recording link" />
          </div>
          <Field label="Write the outcome to field" hint="Optional. e.g. ai_call_outcome">
            <Input className="font-mono text-xs" value={c.outcomeField ?? ""} onChange={(e) => set("crm.outcomeField", e.target.value || undefined)} />
          </Field>
          <Field label="Write the summary to field" hint="Optional. e.g. ai_call_summary">
            <Input className="font-mono text-xs" value={c.summaryField ?? ""} onChange={(e) => set("crm.summaryField", e.target.value || undefined)} />
          </Field>
        </div>
      </Card>
      <Card title="Fields the agent can update" description="Use your CRM's field names (HubSpot internal names, GoHighLevel custom field keys). first_name, last_name, email and phone work everywhere.">
        <KeyValueRows rows={rows} onChange={(r) => set("crm.updatableFields", Object.fromEntries(r))} keyLabel="CRM field" valueLabel="What it means (the agent reads this)" keyPlaceholder="insurance_provider" valuePlaceholder="Their insurance company" />
      </Card>
    </>
  );
}

function TransfersTab({ cfg, set }: { cfg: Cfg; set: Setter }) {
  const t: { key: string; number: string; description: string }[] = cfg.transferTargets;
  const update = (next: typeof t) => set("transferTargets", next);
  return (
    <Card title="Transfer to a person" description="The person you transfer to hears a short summary before they're connected. If nobody answers, the AI takes the call back.">
      <div className="space-y-3">
        {t.map((x, i) => (
          <div key={i} className="grid gap-2 rounded-lg border border-slate-200 p-3 md:grid-cols-[1fr_1fr_2fr_auto]">
            <Field label="Name">
              <Input className="font-mono text-xs" placeholder="front_desk" value={x.key} onChange={(e) => update(t.map((y, j) => (j === i ? { ...y, key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") } : y)))} />
            </Field>
            <Field label="Phone number">
              <Input placeholder="+15555550123" value={x.number} onChange={(e) => update(t.map((y, j) => (j === i ? { ...y, number: e.target.value } : y)))} />
            </Field>
            <Field label="When to transfer here">
              <Input placeholder="Billing questions, or anyone who asks for a person" value={x.description} onChange={(e) => update(t.map((y, j) => (j === i ? { ...y, description: e.target.value } : y)))} />
            </Field>
            <button className="self-end p-2 text-slate-400 hover:text-red-600" onClick={() => update(t.filter((_, j) => j !== i))} aria-label="Remove">
              <Trash2 className="size-4" />
            </button>
          </div>
        ))}
        <Button size="sm" onClick={() => update([...t, { key: "", number: "", description: "" }])}>
          <Plus className="size-3.5" /> Add a transfer destination
        </Button>
      </div>
    </Card>
  );
}

function FollowupsTab({ cfg, set }: { cfg: Cfg; set: Setter }) {
  const f = cfg.followUp;
  const s = cfg.sms;
  const assets: any[] = f.assets;
  const upd = (next: any[]) => set("followUp.assets", next);
  return (
    <>
      <Card title="Resources to send" description="Lead magnets, guides, price sheets, links. The agent offers them when relevant, and attaches PDFs to emails.">
        <div className="space-y-3">
          {assets.map((a, i) => (
            <div key={i} className="grid gap-2 rounded-lg border border-slate-200 p-3 md:grid-cols-2">
              <Field label="Title">
                <Input value={a.title} onChange={(e) => upd(assets.map((x, j) => (j === i ? { ...x, title: e.target.value, key: x.key || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") } : x)))} />
              </Field>
              <Field label="File or page URL">
                <Input placeholder="https://…/guide.pdf" value={a.url} onChange={(e) => upd(assets.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} />
              </Field>
              <Field label="When to offer it" className="md:col-span-2">
                <Input placeholder="Offer to anyone booking a first visit" value={a.description} onChange={(e) => upd(assets.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
              </Field>
              <div className="flex items-center justify-between md:col-span-2">
                <Switch checked={a.attach} onChange={(v) => upd(assets.map((x, j) => (j === i ? { ...x, attach: v } : x)))} label="Attach the file to emails" />
                <button className="p-1 text-slate-400 hover:text-red-600" onClick={() => upd(assets.filter((_, j) => j !== i))} aria-label="Remove">
                  <Trash2 className="size-4" />
                </button>
              </div>
            </div>
          ))}
          <Button size="sm" onClick={() => upd([...assets, { key: "", title: "", description: "", url: "", attach: true }])}>
            <Plus className="size-3.5" /> Add a resource
          </Button>
        </div>
      </Card>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Email">
          <div className="space-y-4">
            <Field label="Send emails from">
              <IntegrationSelect kinds={["email_smtp"]} value={f.emailIntegrationId} onChange={(v) => set("followUp.emailIntegrationId", v)} empty="No email account (agent can't email)" />
            </Field>
            <Switch checked={f.autoAfterCall.email} onChange={(v) => set("followUp.autoAfterCall.email", v)} label="Email a follow-up after calls" hint="The AI writes it from the conversation, only when it makes sense." />
            <Switch checked={f.autoAfterCall.sms} onChange={(v) => set("followUp.autoAfterCall.sms", v)} label="Text a follow-up after calls" />
            <Field label="Follow-up guidance" hint="Tone, links to always include, what to avoid">
              <Textarea rows={3} value={f.guidance} onChange={(e) => set("followUp.guidance", e.target.value)} />
            </Field>
          </div>
        </Card>
        <Card title="Texting">
          <div className="space-y-4">
            <Switch checked={s.autoReply} onChange={(v) => set("sms.autoReply", v)} label="AI replies to incoming texts" hint="Answers questions and can book by text" />
            <Switch checked={s.allowDuringCalls} onChange={(v) => set("sms.allowDuringCalls", v)} label="Agent can text during calls" hint="'I just texted you the address'" />
            <Field label="Booking confirmation text" hint="{when} {businessName} {firstName}. Leave empty to turn off.">
              <Textarea rows={2} value={s.bookingConfirmation} onChange={(e) => set("sms.bookingConfirmation", e.target.value)} />
            </Field>
            <Field label="Missed call text-back" hint="Sent when someone calls and hangs up before talking. Leave empty to turn off.">
              <Textarea rows={2} value={s.missedCallText} onChange={(e) => set("sms.missedCallText", e.target.value)} />
            </Field>
          </div>
        </Card>
      </div>
    </>
  );
}

function RulesTab({ cfg, set }: { cfg: Cfg; set: Setter }) {
  const d = cfg.dialer;
  const b = cfg.behaviour;
  const DAYNUM = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Outbound calling" description="Applies to calls triggered by your CRM or the API.">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Call from">
              <Input type="time" value={d.callingHours.start} onChange={(e) => set("dialer.callingHours.start", e.target.value)} />
            </Field>
            <Field label="Until">
              <Input type="time" value={d.callingHours.end} onChange={(e) => set("dialer.callingHours.end", e.target.value)} />
            </Field>
          </div>
          <div>
            <p className="mb-1.5 text-sm font-medium text-slate-700">Days</p>
            <div className="flex flex-wrap gap-1.5">
              {DAYNUM.map((n, i) => {
                const on = d.callingHours.days.includes(i + 1);
                return (
                  <button
                    key={n}
                    onClick={() => set("dialer.callingHours.days", on ? d.callingHours.days.filter((x: number) => x !== i + 1) : [...d.callingHours.days, i + 1].sort())}
                    className={cx("h-8 w-11 rounded-lg border text-xs font-medium", on ? "border-brand bg-brand text-white" : "border-slate-300 bg-white text-slate-600")}
                  >
                    {n}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-xs text-slate-500">In the contact's local time when known, otherwise {cfg.timezone}.</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Calls at once">
              <Input type="number" min={1} max={50} value={d.maxConcurrentCalls} onChange={(e) => set("dialer.maxConcurrentCalls", Number(e.target.value))} />
            </Field>
            <Field label="Attempts per lead">
              <Input type="number" min={1} max={5} value={d.maxAttempts} onChange={(e) => set("dialer.maxAttempts", Number(e.target.value))} />
            </Field>
            <Field label="Retry after (minutes)">
              <Input type="number" min={5} value={d.retryAfterMinutes} onChange={(e) => set("dialer.retryAfterMinutes", Number(e.target.value))} />
            </Field>
            <Field label="Don't re-call within (hours)">
              <Input type="number" min={0} value={d.minHoursBetweenCalls} onChange={(e) => set("dialer.minHoursBetweenCalls", Number(e.target.value))} />
            </Field>
          </div>
          <Switch checked={d.leaveVoicemail} onChange={(v) => set("dialer.leaveVoicemail", v)} label="Leave a voicemail" hint="Detected in the background, so real people hear the agent instantly; voicemails get your message after the beep." />
        </div>
      </Card>
      <Card title="During calls">
        <div className="space-y-4">
          <Switch checked={b.recordCalls} onChange={(v) => set("behaviour.recordCalls", v)} label="Record calls" hint="Some states require everyone's consent. Keep {recordingNotice} in your greetings." />
          <Switch checked={b.reviewCalls} onChange={(v) => set("behaviour.reviewCalls", v)} label="AI review after every call" hint="Score, what went well, and what to improve" />
          <Field label="Filler while looking things up">
            <Input value={b.fillerPhrase} onChange={(e) => set("behaviour.fillerPhrase", e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Silence before 'Are you there?' (s)">
              <Input type="number" min={3} value={b.silenceTimeoutSeconds} onChange={(e) => set("behaviour.silenceTimeoutSeconds", Number(e.target.value))} />
            </Field>
            <Field label="Max call length (minutes)">
              <Input type="number" min={1} value={b.maxCallMinutes} onChange={(e) => set("behaviour.maxCallMinutes", Number(e.target.value))} />
            </Field>
          </div>
        </div>
      </Card>
      <Card title="Caller ID & spam protection" description="Which number people see, and how hard each number is worked." className="lg:col-span-2">
        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-4">
            <Switch
              checked={d.localPresence.enabled}
              onChange={(v) => set("dialer.localPresence.enabled", v)}
              label="Call from a local number"
              hint="Uses one of this agent's numbers with the person's area code, or one in their state. Otherwise it uses the business number."
            />
            <Switch
              checked={d.localPresence.autoBuy}
              onChange={(v) => set("dialer.localPresence.autoBuy", v)}
              label="Buy local numbers automatically"
              hint="When no number matches the person's area code, buy one (about $1-2/month each). Callbacks and texts to it reach this agent."
            />
            {d.localPresence.autoBuy && (
              <Field label="Most numbers this agent may have">
                <Input type="number" min={1} max={100} value={d.localPresence.maxPoolSize} onChange={(e) => set("dialer.localPresence.maxPoolSize", Number(e.target.value))} />
              </Field>
            )}
            <Field label="Business number (fallback)" hint="E.164, e.g. +14155550100. Leave empty to use the agent's first number.">
              <Input value={d.businessNumber ?? ""} onChange={(e) => set("dialer.businessNumber", e.target.value || undefined)} />
            </Field>
          </div>
          <div className="space-y-4">
            <Field label="Max calls per number per day" hint="Keep it modest (50 to 100). High volume from one number is the most common reason carriers flag it.">
              <Input type="number" min={1} max={1000} value={d.perNumberDailyCap} onChange={(e) => set("dialer.perNumberDailyCap", Number(e.target.value))} />
            </Field>
            <Switch checked={d.stickyCallerId} onChange={(v) => set("dialer.stickyCallerId", v)} label="Same person, same number" hint="Follow-up calls come from the number they saw before, so they recognise it." />
            <Switch checked={d.autoRestFlaggedNumbers} onChange={(v) => set("dialer.autoRestFlaggedNumbers", v)} label="Rest numbers that look flagged" hint="If a number's answer rate collapses, stop using it for 3 days." />
            <Link to="/spam-protection" className="inline-block text-sm font-medium text-brand hover:underline">
              Set up carrier verification and caller ID name →
            </Link>
          </div>
        </div>
      </Card>
    </div>
  );
}

function CoachModal({ open, onClose, agentId }: { open: boolean; onClose: () => void; agentId: string }) {
  const [days, setDays] = useState(14);
  const nav = useNavigate();
  const { tenantId } = useSession();
  const gen = useAction(() => api(`/api/agents/${agentId}/insights`, { json: { days } }), { success: "Coaching report ready", onSuccess: () => nav("/insights") });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="AI coaching report"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={gen.isPending} onClick={() => gen.mutate(undefined)} disabled={!tenantId}>
            <Lightbulb className="size-4" /> Generate report
          </Button>
        </>
      }
    >
      <p className="mb-4 text-sm text-slate-600">Reviews this agent's recent calls and tells you what's working, what isn't, which questions it couldn't answer, and the exact instruction changes to make. It takes about a minute.</p>
      <Field label="Calls from the last">
        <Select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>7 days</option>
          <option value={14}>14 days</option>
          <option value={30}>30 days</option>
          <option value={90}>90 days</option>
        </Select>
      </Field>
    </Modal>
  );
}
