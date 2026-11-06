/**
 * Demo mode: an in-memory platform full of realistic sample data, so you can click through the
 * dashboard without any API keys.  npm run demo  →  http://localhost:8080
 */
import fs from "node:fs";
import { initDb, db, schema } from "./db/index.js";
import { createHttpServer } from "./server.js";
import { newId, newSecret, sha256Hex, encryptJson } from "./lib/crypto.js";
import { createUser } from "./users.js";
import { parseAgentConfig } from "./agents/config.js";
import type { TranscriptEntry } from "./db/schema.js";
import { log } from "./lib/log.js";

const ADMIN = { email: "admin@demo.test", password: "demo-admin-123" };
const OWNER = { email: "owner@brightsmile.test", password: "demo-owner-123" };

function rand<T>(arr: T[], r: () => number) {
  return arr[Math.floor(r() * arr.length)];
}
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff);
}

const FIRST = ["Jamie", "Priya", "Marcus", "Elena", "Tom", "Aisha", "Daniel", "Sofia", "Kevin", "Grace", "Luis", "Hannah", "Omar", "Chloe", "Ben"];
const LAST = ["Lee", "Patel", "Johnson", "Garcia", "Nguyen", "Brown", "Kim", "Rossi", "Okafor", "Martin", "Silva", "Cohen"];

type Scenario = {
  direction: "inbound" | "outbound";
  outcome: string;
  booked?: boolean;
  transferred?: boolean;
  endedBy: string;
  successful: boolean;
  sentiment: string;
  score: number;
  transcript: [TranscriptEntry["role"], string][];
  summary: string;
  objections?: string[];
  unanswered?: string[];
  wentWell: string[];
  toImprove: string[];
  suggestions: string[];
};

const SCENARIOS: Scenario[] = [
  {
    direction: "inbound",
    outcome: "appointment_booked",
    booked: true,
    endedBy: "agent",
    successful: true,
    sentiment: "positive",
    score: 9,
    summary: "New patient asked about cleanings and insurance. Confirmed Delta Dental is accepted and booked a new patient exam for Tuesday at 10 AM. Emailed the new patient guide.",
    transcript: [
      ["agent", "Hi, thanks for calling Bright Smile Dental. This is Ava, a virtual assistant. This call may be recorded. How can I help?"],
      ["caller", "Hi, I just moved to the area and I'm looking for a new dentist. Do you take Delta Dental?"],
      ["agent", "Welcome to the neighborhood! Yes, we accept Delta Dental. Would you like to book a new patient exam? It includes X-rays and a cleaning."],
      ["caller", "Yeah, that'd be great. Sometime next week, mornings are best."],
      ["agent", "One moment."],
      ["agent", "I have Tuesday at 10 AM or Wednesday at 8 AM. Do either of those work?"],
      ["caller", "Tuesday at ten works."],
      ["agent", "Perfect. Can I get your full name?"],
      ["caller", "{name}."],
      ["agent", "Thanks {first}. You're booked for Tuesday at 10 AM. Want me to email you our new patient guide with the forms and parking info?"],
      ["caller", "Sure, it's {email}."],
      ["agent", "Got it, sending it now. Anything else I can help with?"],
      ["caller", "No, that's it. Thanks!"],
      ["agent", "You're welcome! See you Tuesday. Bye!"],
    ],
    wentWell: ["Confirmed insurance before pitching the visit", "Offered two specific times instead of asking open-ended", "Offered the new patient guide at the right moment"],
    toImprove: ["Could have spelled the email back to confirm it"],
    suggestions: ["Add: 'Always spell email addresses back letter by letter before sending anything.'"],
  },
  {
    direction: "inbound",
    outcome: "transferred",
    transferred: true,
    endedBy: "transfer",
    successful: true,
    sentiment: "neutral",
    score: 8,
    summary: "Existing patient had a question about a bill from their last visit. Agent transferred them to the front desk.",
    transcript: [
      ["agent", "Hi, thanks for calling Bright Smile Dental. This is Ava, a virtual assistant. This call may be recorded. How can I help?"],
      ["caller", "I got a bill for $180 and I thought my insurance covered my cleaning."],
      ["agent", "I'm sorry about the confusion. Billing questions are best handled by our front desk team. Let me connect you now."],
    ],
    wentWell: ["Recognised a billing issue quickly and transferred without making promises"],
    toImprove: ["Could have asked for the patient's name first so the front desk had context"],
    suggestions: ["Add: 'Before transferring, ask for the caller's name and include it in the transfer reason.'"],
  },
  {
    direction: "outbound",
    outcome: "not_interested",
    endedBy: "caller",
    successful: false,
    sentiment: "negative",
    score: 5,
    summary: "Outbound call to a web lead. They said they already found another dentist and hung up.",
    objections: ["Already found another dentist"],
    transcript: [
      ["agent", "Hi {first}, this is Ava, a virtual assistant calling from Bright Smile Dental. This call may be recorded. Do you have a minute?"],
      ["caller", "Uh, who is this?"],
      ["agent", "I'm calling because you asked about new patient appointments on our website. Are you still looking for a dentist?"],
      ["caller", "No, I already found one. Thanks."],
    ],
    wentWell: ["Reminded the person why we were calling"],
    toImprove: ["Opened with a question before explaining why we were calling, which caused confusion", "Didn't try to keep the door open (e.g. offer a second opinion or whitening)"],
    suggestions: ["Change the outbound greeting to mention the website request in the first sentence.", "Add: 'If they already have a dentist, mention our whitening special and offer to text the details.'"],
  },
  {
    direction: "inbound",
    outcome: "interested_follow_up",
    endedBy: "agent",
    successful: false,
    sentiment: "positive",
    score: 6,
    summary: "Caller asked about whitening cost and payment plans. Wanted to check with their partner before booking. Agent texted pricing and the booking link.",
    objections: ["Needs to check with partner", "Price"],
    unanswered: ["Whether whitening results are guaranteed"],
    transcript: [
      ["agent", "Hi, thanks for calling Bright Smile Dental. This is Ava, a virtual assistant. This call may be recorded. How can I help?"],
      ["caller", "How much is teeth whitening?"],
      ["agent", "Professional whitening is $399, and we offer payment plans through CareCredit."],
      ["caller", "Is it guaranteed to work?"],
      ["agent", "I don't have details on guarantees, but our team can go over what to expect. Would you like to book a quick consultation?"],
      ["caller", "Let me talk to my partner first."],
      ["agent", "Of course. Want me to text you the pricing and a link to book when you're ready?"],
      ["caller", "Sure."],
      ["agent", "Done, it's on its way. Have a great day!"],
    ],
    wentWell: ["Gave the price clearly and mentioned payment plans", "Turned a 'not now' into a text follow-up"],
    toImprove: ["Couldn't answer whether whitening results are guaranteed"],
    suggestions: ["Add to knowledge: what results patients can expect from whitening and whether touch-ups are included."],
  },
  {
    direction: "outbound",
    outcome: "callback_requested",
    endedBy: "agent",
    successful: false,
    sentiment: "neutral",
    score: 7,
    summary: "Lead was driving and asked to be called back tomorrow afternoon.",
    transcript: [
      ["agent", "Hi {first}, this is Ava, a virtual assistant calling from Bright Smile Dental. This call may be recorded. Do you have a minute?"],
      ["caller", "I'm driving right now, can you call me tomorrow afternoon?"],
      ["agent", "Absolutely, I'll make a note to call you tomorrow afternoon. Drive safe!"],
    ],
    wentWell: ["Respected the caller's time and kept it short"],
    toImprove: ["The callback wasn't actually scheduled in the system"],
    suggestions: ["Add a 'schedule_callback' step: when someone asks for a callback, book it as a task in the CRM."],
  },
];

async function seed() {
  const existing = await db().select().from(schema.tenants).limit(1);
  if (existing.length) return;
  await createUser({ email: ADMIN.email, name: "You (platform admin)", role: "platform_admin", tenantId: null, password: ADMIN.password });

  const example = JSON.parse(fs.readFileSync("examples/dental-front-desk.json", "utf8"));
  const tenants = [
    { name: "Bright Smile Dental", calls: 64, owner: OWNER },
    { name: "Summit Roofing Co.", calls: 23 },
    { name: "Harbor Physical Therapy", calls: 11 },
  ];
  for (const [ti, tdef] of tenants.entries()) {
    const tenantId = newId("ten");
    await db().insert(schema.tenants).values({ id: tenantId, name: tdef.name, apiKeyHash: sha256Hex(newSecret()), webhookSecret: newSecret("whs_", 24) });
    if (tdef.owner) await createUser({ email: tdef.owner.email, name: "Dr. Morgan Reyes", role: "owner", tenantId, password: tdef.owner.password });
    const cfg = parseAgentConfig({ ...example.config, businessName: tdef.name });
    const agentId = newId("agt");
    await db().insert(schema.agents).values({ id: agentId, tenantId, name: ti === 0 ? "Front desk" : "Receptionist", config: cfg });
    const outbound = newId("agt");
    await db().insert(schema.agents).values({ id: outbound, tenantId, name: "New lead caller", config: { ...cfg, instructions: "Call new website leads, qualify them and book a consultation." } });
    const phone = `+1555010${ti}${100 + ti}`.slice(0, 12);
    const ok = { ok: true, at: new Date().toISOString() };
    const trust: Record<string, { ok: boolean; at: string }> = ti === 0 ? { customerProfileSid: ok, shakenStirSid: ok, cnamSid: ok, voiceIntegritySid: ok } : {};
    await db().insert(schema.phoneNumbers).values([
      { id: newId("num"), tenantId, agentId, e164: phone, twilioSid: `PN${ti}demo`, friendlyName: "Main line", trust, health: { status: "new", attempts: 0, answered: 0, shortCalls: 0, answerRate: 0 } },
      { id: newId("num"), tenantId, agentId: outbound, e164: ["+14155550142", "+17205550188", "+15125550173"][ti], twilioSid: `PN${ti}demo2`, friendlyName: "Local · San Francisco", region: "CA", locality: "San Francisco", trust, health: { status: "good", attempts: 212, answered: 81, shortCalls: 9, answerRate: 0.382 } },
      ...(ti === 0
        ? [
            { id: newId("num"), tenantId, agentId: outbound, e164: "+13105550119", twilioSid: "PNdemo3", friendlyName: "Local · Los Angeles", region: "CA", locality: "Los Angeles", trust, health: { status: "watch", attempts: 96, answered: 15, shortCalls: 4, answerRate: 0.156 } },
            { id: newId("num"), tenantId, agentId: outbound, e164: "+16195550127", twilioSid: "PNdemo4", friendlyName: "Local · San Diego", region: "CA", locality: "San Diego", trust, health: { status: "at_risk", attempts: 88, answered: 6, shortCalls: 3, answerRate: 0.068 }, restedUntil: new Date(Date.now() + 2 * 86400_000) },
            { id: newId("num"), tenantId, agentId: outbound, e164: "+12125550161", twilioSid: "PNdemo5", friendlyName: "Local · New York", region: "NY", locality: "New York", trust, health: { status: "new", attempts: 7, answered: 3, shortCalls: 0, answerRate: 0.43 } },
          ]
        : []),
    ]);
    if (ti === 0) {
      await db().update(schema.tenants).set({
        settings: {
          trustHub: { customerProfileSid: "BU" + "1".repeat(32), shakenStirSid: "BU" + "2".repeat(32), cnamSid: "BU" + "3".repeat(32), voiceIntegritySid: "BU" + "4".repeat(32) },
          business: { legalName: "Bright Smile Dental LLC", callerIdName: "BRIGHT SMILE", website: "https://brightsmile.example", address: "120 Main Street, Suite 4, Springfield", contactEmail: "office@brightsmile.example", useCase: "Returning calls to people who requested an appointment on our website" },
        },
      }).where((await import("drizzle-orm")).eq(schema.tenants.id, tenantId));
    }
    await db().insert(schema.integrations).values([
      { id: newId("int"), tenantId, kind: "hubspot", label: "HubSpot", settings: { callOnCreate: true, callOnPropertyChange: ["lifecyclestage"] }, secretsEnc: encryptJson({ accessToken: "demo" }) },
      { id: newId("int"), tenantId, kind: "calcom", label: "Cal.com – New patient exam", settings: { eventTypeId: 123 }, secretsEnc: encryptJson({ apiKey: "demo" }) },
      { id: newId("int"), tenantId, kind: "webhook", label: "Zapier", settings: { url: "https://hooks.zapier.com/hooks/catch/demo" }, secretsEnc: encryptJson({ signingSecret: "demo" }) },
    ]);

    const r = rng(42 + ti);
    for (let i = 0; i < tdef.calls; i++) {
      const first = rand(FIRST, r);
      const last = rand(LAST, r);
      const email = `${first}.${last}@example.com`.toLowerCase();
      const contactPhone = `+1415555${String(1000 + Math.floor(r() * 8999))}`;
      const contactId = newId("con");
      await db()
        .insert(schema.contacts)
        .values({ id: contactId, tenantId, phone: contactPhone, firstName: first, lastName: last, email: r() > 0.4 ? email : null, crmExternalId: String(10000 + i), fields: { reason_for_visit: rand(["cleaning", "toothache", "whitening", "new patient exam"], r) } })
        .onConflictDoNothing();
      const created = new Date(Date.now() - Math.floor(r() * 21 * 86400_000));
      const roll = r();
      const sc = SCENARIOS[Math.floor(r() * SCENARIOS.length)];
      const direction = roll < 0.14 ? "outbound" : sc.direction;
      const id = newId("call");
      if (roll < 0.14) {
        await db().insert(schema.calls).values({ id, tenantId, agentId: direction === "inbound" ? agentId : outbound, contactId, direction, fromNumber: phone, toNumber: contactPhone, status: rand(["no_answer", "busy", "voicemail"], r), durationSeconds: 0, outcome: "voicemail", createdAt: created, finalized: true });
        continue;
      }
      const fill = (t: string) => t.replace(/\{name\}/g, `${first} ${last}`).replace(/\{first\}/g, first).replace(/\{email\}/g, email);
      let t = created.getTime();
      const transcript: TranscriptEntry[] = sc.transcript.map(([role, text]) => ({ role, text: fill(text), at: new Date((t += 2500 + r() * 4000)).toISOString() }));
      const duration = Math.round((t - created.getTime()) / 1000) + 5;
      const analysis = {
        summary: fill(sc.summary),
        outcome: sc.outcome,
        successful: sc.successful,
        sentiment: sc.sentiment,
        caller_intent: "",
        objections: sc.objections ?? [],
        unanswered_questions: sc.unanswered ?? [],
        follow_up_needed: !sc.booked,
        follow_up_reason: "",
        review: { score: Math.max(1, Math.min(10, sc.score + Math.round(r() * 2 - 1))), went_well: sc.wentWell, to_improve: sc.toImprove, prompt_suggestions: sc.suggestions },
        follow_up_sms: "",
        follow_up_email_subject: "",
        follow_up_email_body: "",
        follow_up_resources: [],
      };
      await db().insert(schema.calls).values({
        id,
        tenantId,
        agentId: direction === "inbound" ? agentId : outbound,
        contactId,
        direction,
        fromNumber: direction === "inbound" ? contactPhone : phone,
        toNumber: direction === "inbound" ? phone : contactPhone,
        status: "completed",
        dialedAt: direction === "outbound" ? created : null,
        callerIdReason: direction === "outbound" ? "same_area_code" : null,
        twilioCallSid: `CA${id}`,
        startedAt: created,
        endedAt: new Date(t),
        durationSeconds: duration,
        transcript,
        summary: analysis.summary,
        outcome: sc.outcome,
        analysis,
        review: analysis.review,
        booked: !!sc.booked,
        transferredTo: sc.transferred ? "+15555550123" : null,
        endedBy: sc.endedBy,
        finalized: true,
        createdAt: created,
      });
      const ev = (type: string, offset: number, data: Record<string, unknown> = {}) => ({ id: newId("evt"), tenantId, callId: id, type, data, at: new Date(created.getTime() + offset) });
      const events = [ev(direction === "outbound" ? "call.dialing" : "call.ringing", 0), ev("call.connected", 1500), ev("recording.started", 2000)];
      if (sc.booked) events.push(ev("tool.check_availability", 20000, { result: { total_open: 14 } }), ev("tool.book_appointment", 40000, { result: { booked: true } }), ev("appointment.booked", 40500));
      if (sc.transferred) events.push(ev("transfer.started", 15000, { target: "front_desk" }), ev("transfer.result", 30000, { status: "completed" }));
      if (sc.endedBy === "caller") events.push(ev("call.ended_by_caller", duration * 1000));
      events.push(ev("call.completed", duration * 1000 + 500, { status: "completed", duration }), ev("call.analyzed", duration * 1000 + 6000, { outcome: sc.outcome, score: analysis.review.score }));
      await db().insert(schema.callEvents).values(events);
      if (sc.booked) {
        await db().insert(schema.messages).values({ id: newId("msg"), tenantId, agentId, contactId, callId: id, channel: "sms", direction: "outbound", fromNumber: phone, toNumber: contactPhone, body: `You're booked with ${tdef.name} for Tuesday at 10 AM. Reply here if you need to change it.`, status: "delivered", createdAt: new Date(t) });
      }
      if (sc.outcome === "interested_follow_up") {
        await db().insert(schema.messages).values({ id: newId("msg"), tenantId, agentId, contactId, callId: id, channel: "sms", direction: "outbound", fromNumber: phone, toNumber: contactPhone, body: "Hi! Here's the whitening info: $399, payment plans via CareCredit. Book anytime: https://example.com/book", status: "delivered", createdAt: new Date(t) });
      }
    }
    // A couple of queued calls.
    const [c] = await db().select().from(schema.contacts).where((await import("drizzle-orm")).eq(schema.contacts.tenantId, tenantId)).limit(1);
    if (c) await db().insert(schema.calls).values({ id: newId("call"), tenantId, agentId: outbound, contactId: c.id, direction: "outbound", fromNumber: phone, toNumber: c.phone, status: "queued", scheduledFor: new Date(Date.now() + 3600_000), reason: "HubSpot: contact.creation" });

    if (ti === 0) {
      await db().insert(schema.insightReports).values({
        id: newId("ins"),
        tenantId,
        agentId,
        periodStart: new Date(Date.now() - 14 * 86400_000),
        periodEnd: new Date(),
        callCount: 41,
        report: {
          headline: "Booking rate is strong on inbound calls (38%), but outbound openers are losing people in the first 10 seconds.",
          what_is_working: ["Offering two specific times converts better than asking when they're free", "Insurance questions are answered confidently", "Texting pricing after 'let me think about it' keeps leads warm"],
          top_problems: [
            { problem: "Outbound greeting confuses people", evidence: "6 of 9 outbound hang-ups happened right after 'Do you have a minute?' (e.g. the call with Marcus Johnson)", how_often: "6 of 17 outbound calls", fix: "Say why you're calling in the first sentence: 'You asked about new patient appointments on our website.'" },
            { problem: "Callbacks aren't being scheduled", evidence: "Three callers asked for a callback; none were queued", how_often: "3 calls", fix: "When someone asks for a callback, create a follow-up task or queue a call for the time they asked." },
          ],
          knowledge_gaps: [
            { question: "Is whitening guaranteed / how long does it last?", suggested_answer_to_add: "Most patients see results 4-8 shades lighter that last 1-3 years; touch-up trays are included." },
            { question: "Do you see kids?", suggested_answer_to_add: "Yes, we see children from age 3." },
          ],
          common_objections: [
            { objection: "I need to check with my partner", suggested_response: "Totally fair. Want me to hold a time for 24 hours and text you the details so you can confirm?" },
            { objection: "It's too expensive", suggested_response: "We offer payment plans through CareCredit, which brings whitening to about $35 a month." },
          ],
          recommended_instruction_changes: [
            "Outbound: 'Start with: Hi {name}, it's Ava from Bright Smile Dental. You asked about new patient appointments on our website, is now a good time?'",
            "Add: 'Always spell email addresses back before sending anything.'",
            "Add: 'If someone asks for a callback, confirm the day and time and schedule it.'",
          ],
          experiments_to_try: ["A/B test a warmer voice (lower stability) on outbound calls", "Try calling new leads within 5 minutes vs. 1 hour", "Offer a $49 whitening consult on 'not interested' calls"],
        },
      });
    }
  }
}

await initDb(process.env.DATABASE_URL ?? "memory://");
await seed();
const port = Number(process.env.PORT ?? 8080);
createHttpServer().listen(port, () => {
  log.info("demo ready", { url: `http://localhost:${port}` });
  console.log(`\n  Demo dashboard: http://localhost:${port}\n  Platform admin: ${ADMIN.email} / ${ADMIN.password}\n  Client owner:   ${OWNER.email} / ${OWNER.password}\n`);
});
