import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";

process.env.PLATFORM_ADMIN_KEY = "test-platform-admin-key-123456";
process.env.TWILIO_VALIDATE_SIGNATURE = "false";
process.env.PUBLIC_BASE_URL = "https://agents.example.com";
process.env.LOG_LEVEL = "error";

const { initDb, closeDb, db, schema } = await import("../src/db/index.ts");
const { createHttpServer } = await import("../src/server.ts");
const { Conversation } = await import("../src/agents/conversation.ts");
const { MemoryCalendar } = await import("../src/integrations/calendar/memory.ts");
const { parseAgentConfig } = await import("../src/agents/config.ts");
const { eq } = await import("drizzle-orm");

let base = "";
let server: http.Server;
let tenantId = "";
let apiKey = "";
let webhookSecret = "";
let agentId = "";
const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
let sink: http.Server;
let sinkUrl = "";

async function api(path: string, init: RequestInit & { json?: unknown; key?: string } = {}) {
  const res = await fetch(base + path, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${init.key ?? apiKey}`, ...(init.headers ?? {}) },
    body: init.json === undefined ? init.body : JSON.stringify(init.json),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, raw: text };
}

before(async () => {
  await initDb("memory://");
  server = createHttpServer();
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  sink = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body: b });
      res.end("ok");
    });
  });
  await new Promise<void>((r) => sink.listen(0, r));
  sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/events`;
});

after(async () => {
  server.close();
  sink.close();
  await closeDb();
});

test("platform admin creates a client account; tenant key works, wrong key doesn't", async () => {
  const r = await api("/platform/tenants", { method: "POST", key: process.env.PLATFORM_ADMIN_KEY, json: { name: "Acme Dental", timezone: "America/New_York" } });
  assert.equal(r.status, 201);
  tenantId = r.body.tenant.id;
  apiKey = r.body.apiKey;
  const me = await api("/api/tenant");
  assert.equal(me.status, 200);
  assert.equal(me.body.name, "Acme Dental");
  webhookSecret = me.body.inboundWebhooks.secret;
  assert.equal((await api("/api/tenant", { key: "vk_live_nope" })).status, 401);
  // Platform key can act as any tenant.
  const asAdmin = await api("/api/tenant", { key: process.env.PLATFORM_ADMIN_KEY, headers: { "X-Tenant-Id": tenantId } });
  assert.equal(asAdmin.body.id, tenantId);
});

test("create agent, validate config, patch one section", async () => {
  const bad = await api("/api/agents", { method: "POST", json: { name: "x", config: { agentName: "no business" } } });
  assert.equal(bad.status, 400);
  const r = await api("/api/agents", {
    method: "POST",
    json: {
      name: "Front desk",
      config: {
        businessName: "Acme Dental",
        instructions: "Book cleanings.",
        crm: { updatableFields: { first_name: "First name", email: "Email", insurance: "Insurance provider" } },
        transferTargets: [{ key: "front_desk", number: "+15555550123", description: "Human receptionist" }],
      },
    },
  });
  assert.equal(r.status, 201);
  agentId = r.body.id;
  const p = await api(`/api/agents/${agentId}`, { method: "PATCH", json: { config: { ambience: { preset: "coffee_shop", volume: 0.1 } } } });
  assert.equal(p.status, 200);
  assert.equal(p.body.config.ambience.preset, "coffee_shop");
  assert.equal(p.body.config.instructions, "Book cleanings.");
  await db().insert(schema.phoneNumbers).values({ id: "num_test", tenantId, agentId, e164: "+15555550100", twilioSid: "PN123" });
});

test("CRM webhook (GoHighLevel-style payload) creates the contact and queues a call once", async () => {
  const payload = { contact_id: "ghl_abc", first_name: "Jamie", last_name: "Lee", phone: "(415) 555-0199", email: "jamie@example.com" };
  const denied = await fetch(`${base}/hooks/${tenantId}/contact?agentId=${agentId}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Webhook-Secret": "wrong" }, body: JSON.stringify(payload) });
  assert.equal(denied.status, 401);
  const send = () =>
    fetch(`${base}/hooks/${tenantId}/contact?agentId=${agentId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Webhook-Secret": webhookSecret },
      body: JSON.stringify(payload),
    }).then((r) => r.json());
  const first = await send();
  assert.equal(first.ok, true);
  assert.equal(first.call.queued, true);
  const second = await send();
  assert.equal(second.call.queued, false);
  assert.match(second.call.reason, /already queued/);
  const contacts = await api("/api/contacts?phone=4155550199");
  assert.equal(contacts.body.contacts[0].firstName, "Jamie");
  const calls = await api(`/api/calls?agentId=${agentId}&status=queued`);
  assert.equal(calls.body.calls.length, 1);
  const detail = await api(`/api/calls/${calls.body.calls[0].id}`);
  assert.equal(detail.body.events[0].type, "call.queued");
  // Cancel it.
  assert.equal((await api(`/api/calls/${calls.body.calls[0].id}`, { method: "DELETE" })).status, 204);
});

test("inbound call webhook answers with a signed media stream", async () => {
  const res = await fetch(`${base}/twilio/voice`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ From: "+14155550111", To: "+15555550100", CallSid: "CA_inbound_1" }),
  });
  const xml = await res.text();
  assert.match(xml, /<Connect><Stream url="wss:\/\/agents\.example\.com\/twilio\/media">/);
  assert.match(xml, /name="token"/);
  const unknown = await fetch(`${base}/twilio/voice`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ From: "+14155550111", To: "+19999999999", CallSid: "CA_x" }),
  });
  assert.match(await unknown.text(), /isn&apos;t set up/);
});

/** Scripted stand-in for the Anthropic client: returns canned assistant turns in order. */
function fakeClient(turns: { text?: string; tools?: { name: string; input: unknown }[] }[]) {
  const requests: any[] = [];
  let i = 0;
  const client = {
    beta: {
      messages: {
        stream(params: any) {
          requests.push(structuredClone(params));
          const t = turns[i++] ?? { text: "ok" };
          const listeners: ((d: string) => void)[] = [];
          const content: any[] = [];
          if (t.text) content.push({ type: "text", text: t.text });
          for (const [k, tool] of (t.tools ?? []).entries()) content.push({ type: "tool_use", id: `toolu_${i}_${k}`, name: tool.name, input: tool.input });
          return {
            on(_e: string, cb: (d: string) => void) {
              listeners.push(cb);
              return this;
            },
            async finalMessage() {
              await new Promise((r) => setImmediate(r));
              if (t.text) listeners.forEach((l) => l(t.text!));
              return { role: "assistant", content, stop_reason: t.tools?.length ? "tool_use" : "end_turn" };
            },
          };
        },
      },
    },
  };
  return { client: client as any, requests };
}

test("conversation runs tools: availability -> booking -> CRM field update -> webhook event", async () => {
  await api("/api/integrations", { method: "POST", json: { kind: "webhook", label: "Zapier", settings: { url: sinkUrl } } });
  const [agent] = await db().select().from(schema.agents).where(eq(schema.agents.id, agentId));
  const cfg = parseAgentConfig({ ...(agent.config as object), calendar: { minNoticeMinutes: 0, businessHours: { mon: [["00:00", "23:59"]], tue: [["00:00", "23:59"]], wed: [["00:00", "23:59"]], thu: [["00:00", "23:59"]], fri: [["00:00", "23:59"]], sat: [["00:00", "23:59"]], sun: [["00:00", "23:59"]] } } });
  const [contact] = await db().select().from(schema.contacts).where(eq(schema.contacts.phone, "+14155550199"));
  const calendar = new MemoryCalendar();
  const booked: string[] = [];
  const rt = { tenantId, agentId, cfg, channel: "voice" as const, contact, calendar, crm: null, onBooked: (b: { when: string }) => booked.push(b.when) };

  const { DateTime } = await import("luxon");
  const day = DateTime.now().setZone(cfg.timezone).plus({ days: 1 }).toISODate()!;
  // First run the availability tool to get a real slot, then book it.
  const probe = fakeClient([{ tools: [{ name: "check_availability", input: { start_date: day } }] }, { text: "I have a few times." }]);
  const conv1 = new Conversation(rt, [{ type: "text", text: "sys" }], probe.client);
  conv1.addUser("Can I come in tomorrow?");
  await conv1.respond();
  const toolResult = (conv1.messages[2].content as any[])[0];
  const slot = JSON.parse(toolResult.content).slots[0].start;
  assert.ok(slot);

  const script = fakeClient([
    { text: "Booking that now.", tools: [{ name: "book_appointment", input: { start: slot, name: "Jamie Lee" } }, { name: "update_contact", input: { insurance: "Delta Dental" } }] },
    { text: "You're all set!" },
  ]);
  const conv = new Conversation(rt, [{ type: "text", text: "sys" }], script.client);
  conv.addUser("The first one works, I'm Jamie Lee, and I have Delta Dental.");
  let streamed = "";
  const res = await conv.respond({ onText: (d) => (streamed += d) });
  assert.equal(res.interrupted, false);
  assert.deepEqual(res.toolsUsed, ["book_appointment", "update_contact"]);
  assert.equal(streamed, "Booking that now.You're all set!");
  assert.equal(calendar.bookings.length, 1);
  assert.equal(booked.length, 1);
  // Both tool results go back in ONE user message, and the history alternates correctly.
  assert.deepEqual(conv.messages.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
  assert.equal((conv.messages[2].content as any[]).length, 2);
  // Tools are sent with eager input streaming.
  assert.ok(script.requests[0].tools.every((t: any) => t.eager_input_streaming === true));
  assert.equal(script.requests[0].fallbacks, "default");

  const [updated] = await db().select().from(schema.contacts).where(eq(schema.contacts.id, contact.id));
  assert.equal((updated.fields as any).insurance, "Delta Dental");

  await new Promise((r) => setTimeout(r, 200));
  const types = received.map((r) => JSON.parse(r.body).type);
  assert.ok(types.includes("appointment.booked"), types.join(","));
  assert.ok(types.includes("contact.updated"));
  // Signed with the integration's secret.
  assert.match(String(received[0].headers["x-signature"]), /^sha256=[0-9a-f]{64}$/);
});

test("invalid tool input is returned to the model as an error, not executed", async () => {
  const [agent] = await db().select().from(schema.agents).where(eq(schema.agents.id, agentId));
  const cfg = parseAgentConfig(agent.config);
  const [contact] = await db().select().from(schema.contacts).where(eq(schema.contacts.phone, "+14155550199"));
  const script = fakeClient([{ tools: [{ name: "update_contact", input: { not_allowed_field: "x" } }] }, { text: "Sorry about that." }]);
  const conv = new Conversation({ tenantId, agentId, cfg, channel: "voice", contact, calendar: null, crm: null }, [{ type: "text", text: "sys" }], script.client);
  conv.addUser("hi");
  await conv.respond();
  const result = (conv.messages[2].content as any[])[0];
  assert.equal(result.is_error, true);
  assert.match(result.content, /INVALID_INPUT/);
});

test("analytics: booking conversion, transfers, hang-ups, outcomes", async () => {
  const mk = (id: string, patch: Record<string, unknown>) =>
    db().insert(schema.calls).values({ id, tenantId, agentId, direction: "outbound", fromNumber: "+15555550100", toNumber: "+14155550199", status: "completed", durationSeconds: 120, ...patch } as any);
  await mk("call_a", { booked: true, outcome: "appointment_booked", endedBy: "agent", analysis: { successful: true }, review: { score: 9 } });
  await mk("call_b", { transferredTo: "+15555550123", outcome: "transferred", endedBy: "transfer", analysis: { successful: true }, review: { score: 7 } });
  await mk("call_c", { outcome: "not_interested", endedBy: "caller", analysis: { successful: false }, review: { score: 5 } });
  await mk("call_d", { status: "no_answer", durationSeconds: 0 });
  const r = await api(`/api/analytics?agentId=${agentId}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.booked, 1);
  assert.equal(r.body.transferred, 1);
  assert.equal(r.body.callerHungUp, 1);
  assert.equal(r.body.noAnswer, 1);
  assert.equal(r.body.rates.bookingPctOfConnected, 33.3);
  assert.equal(r.body.avgScore, 7);
  assert.ok(r.body.outcomes.some((o: any) => o.outcome === "appointment_booked" && o.count === 1));
  const u = await api("/api/usage");
  assert.ok(u.body.callMinutes >= 6);
});

test("ambience preview is a playable WAV", async () => {
  const res = await fetch(`${base}/api/ambience/coffee_shop.wav`, { headers: { Authorization: `Bearer ${apiKey}` } });
  assert.equal(res.headers.get("content-type"), "audio/wav");
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.toString("ascii", 0, 4), "RIFF");
  assert.equal(buf.length, 44 + 8000 * 10 * 2);
});

test("anti-spam settings: validated Trust Hub SIDs, numbers list shows area code/state, registry CSV", async () => {
  const bad = await api("/api/compliance", { method: "PUT", json: { trustHub: { shakenStirSid: "nope" } } });
  assert.equal(bad.status, 400);
  const sid = "BU" + "a".repeat(32);
  const ok = await api("/api/compliance", { method: "PUT", json: { trustHub: { shakenStirSid: sid, cnamSid: "" }, business: { legalName: "Acme Dental LLC", callerIdName: "ACME DENTAL", website: "https://acme.test" } } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.settings.trustHub.shakenStirSid, sid);
  assert.equal((await api("/api/compliance", { method: "PUT", json: { business: { callerIdName: "A NAME LONGER THAN 15" } } })).status, 400);
  const nums = await api("/api/numbers");
  assert.equal(nums.body.numbers[0].areaCode, "555");
  assert.equal(nums.body.numbers[0].usedToday, 0);
  const csv = await fetch(`${base}/api/compliance/registry.csv`, { headers: { Authorization: `Bearer ${apiKey}` } }).then((r) => r.text());
  assert.match(csv, /"\+15555550100","Acme Dental LLC","ACME DENTAL"/);
  const patch = await api("/api/numbers/num_test", { method: "PATCH", json: { outboundEnabled: false, dailyCap: 40 } });
  assert.equal(patch.body.outboundEnabled, false);
  assert.equal(patch.body.dailyCap, 40);
});

test("HubSpot webhook rejects bad signatures", async () => {
  const int = await api("/api/integrations", { method: "POST", json: { kind: "hubspot", secrets: { accessToken: "pat-na1-xxxxxxxxxxxx", clientSecret: "cs" } } });
  const body = JSON.stringify([{ objectId: 1, subscriptionType: "contact.creation" }]);
  const res = await fetch(`${base}/hooks/${tenantId}/hubspot?integrationId=${int.body.id}&agentId=${agentId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-HubSpot-Signature-v3": crypto.randomBytes(32).toString("base64"), "X-HubSpot-Request-Timestamp": String(Date.now()) },
    body,
  });
  assert.equal(res.status, 401);
  const list = await api("/api/integrations");
  assert.ok(list.body.integrations.every((i: any) => !("secretsEnc" in i)));
});
