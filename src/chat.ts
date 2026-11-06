/**
 * Talk to an agent in your terminal: same brain, prompt and tools as on the phone, with an
 * in-memory database and calendar, so you can iterate on instructions without placing calls.
 *
 *   npm run chat -- examples/dental-front-desk.json [--sms] [--outbound]
 */
import fs from "node:fs";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { initDb, db, schema } from "./db/index.js";
import { parseAgentConfig, fillTemplate, templateVars } from "./agents/config.js";
import { Conversation } from "./agents/conversation.js";
import { stableSystem, sessionContext, buildSystem } from "./agents/prompt.js";
import { MemoryCalendar } from "./integrations/calendar/memory.js";
import { upsertContact } from "./contacts.js";
import { analyzeCall } from "./agents/analysis.js";
import type { TranscriptEntry } from "./db/schema.js";

const file = process.argv.find((a) => a.endsWith(".json")) ?? "examples/dental-front-desk.json";
const channel = process.argv.includes("--sms") ? "sms" : "voice";
const direction = process.argv.includes("--outbound") ? "outbound" : "inbound";
const raw = JSON.parse(fs.readFileSync(file, "utf8"));
const cfg = parseAgentConfig(raw.config ?? raw);

await initDb("memory://");
await db().insert(schema.tenants).values({ id: "ten_local", name: "local", apiKeyHash: "x", webhookSecret: "x" });
await db().insert(schema.agents).values({ id: "agt_local", tenantId: "ten_local", name: "local", config: cfg });
const contact = await upsertContact("ten_local", { phone: "+15555550199", firstName: direction === "outbound" ? "Jamie" : null });

const transcript: TranscriptEntry[] = [];
const log = (role: TranscriptEntry["role"], text: string) => transcript.push({ role, text, at: new Date().toISOString() });
const rt = {
  tenantId: "ten_local",
  agentId: "agt_local",
  cfg,
  channel: channel as "voice" | "sms",
  contact,
  calendar: new MemoryCalendar(),
  crm: null,
  sendSms: async (b: string) => console.log(`\n  [text sent to caller] ${b}`),
  sendEmail: async (s: string, b: string, keys: string[]) => console.log(`\n  [email] ${s}\n  ${b.replace(/\n/g, "\n  ")}${keys.length ? `\n  attachments: ${keys.join(", ")}` : ""}`),
  requestTransfer: (t: { key: string; number: string }, reason: string) => console.log(`\n  [transfer -> ${t.key} ${t.number}: ${reason}]`),
  requestHangup: (reason: string) => {
    console.log(`\n  [call ended: ${reason}]`);
    ended = true;
  },
};
let ended = false;
const conv = new Conversation(rt, buildSystem(stableSystem(cfg, rt.channel), sessionContext({ cfg, channel: rt.channel, direction, contact })));

console.log(`\n${cfg.agentName} (${cfg.businessName}) | ${channel} | ${direction}. Type to talk, /quit to end and see the AI review.\n`);
if (channel === "voice") {
  const greeting = fillTemplate(direction === "outbound" ? cfg.outboundGreeting : cfg.inboundGreeting, templateVars(cfg, contact));
  conv.addAssistantText(greeting);
  log("agent", greeting);
  console.log(`${cfg.agentName}: ${greeting}`);
}
const rl = readline.createInterface({ input: stdin, output: stdout });
while (!ended) {
  const line = (await rl.question("\nyou: ")).trim();
  if (!line) continue;
  if (line === "/quit") break;
  log("caller", line);
  conv.addUser(line);
  stdout.write(`${cfg.agentName}: `);
  const res = await conv.respond({
    onText: (d) => stdout.write(d),
    onToolStart: (n) => stdout.write(`\n  [${n}...] `),
    onToolResult: (n, _i, out, err) => stdout.write(`\n  [${n} ${err ? "failed" : "ok"}: ${JSON.stringify(out).slice(0, 200)}]\n`),
  });
  log("agent", res.text);
  stdout.write("\n");
}
rl.close();
if (transcript.some((t) => t.role === "caller")) {
  console.log("\nReviewing the conversation...\n");
  const a = await analyzeCall({ cfg, transcript, direction, booked: rt.calendar.bookings.length > 0, transferred: false, endedBy: ended ? "agent" : "caller" });
  console.log(JSON.stringify(a, null, 2));
}
process.exit(0);
