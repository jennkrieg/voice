import express from "express";
import { z } from "zod";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import nodemailer from "nodemailer";
import { env, requireEnv } from "../env.js";
import { db, schema } from "../db/index.js";
import { encryptJson, newId, newSecret, signToken, decryptJson } from "../lib/crypto.js";
import { toE164 } from "../lib/phone.js";
import { requireTenant, requireOwner, h } from "./auth.js";
import { createUser, publicUser } from "../users.js";
import { sha256Hex } from "../lib/crypto.js";
import { AgentConfig, parseAgentConfig } from "../agents/config.js";
import { getIntegration, calendarFromRow, crmFromRow } from "../integrations/registry.js";
import { GOOGLE_SCOPES, googleOAuthClient } from "../integrations/calendar/google.js";
import { googleConfigured } from "./oauth-routes.js";
import { upsertContact, getContact } from "../contacts.js";
import { enqueueCall } from "../dialer/dialer.js";
import { getCallForTenant } from "../calls.js";
import { twilioClient } from "../telephony/twilio-client.js";
import { listVoices, previewVoice } from "../telephony/tts.js";
import { loadAmbience, SAMPLE_RATE, type AmbiencePreset } from "../audio/ambience.js";
import { sendSms } from "../sms/send.js";
import { sendEmail, type SmtpSettings } from "../email/send.js";
import { callStats, usage } from "../analytics.js";
import { generateInsightReport } from "../agents/insights.js";
import { emitEvent } from "../integrations/webhooks.js";

const IntegrationInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("calcom"), label: z.string().optional(), settings: z.object({ eventTypeId: z.number().int().optional() }).default({}), secrets: z.object({ apiKey: z.string().min(10) }) }),
  z.object({
    kind: z.literal("hubspot"),
    label: z.string().optional(),
    settings: z.object({ callOnCreate: z.boolean().default(true), callOnPropertyChange: z.array(z.string()).default([]) }).prefault({}),
    secrets: z.object({ accessToken: z.string().min(10), clientSecret: z.string().optional() }),
  }),
  z.object({ kind: z.literal("gohighlevel"), label: z.string().optional(), settings: z.object({ locationId: z.string().min(1) }), secrets: z.object({ token: z.string().min(10) }) }),
  z.object({ kind: z.literal("webhook"), label: z.string().optional(), settings: z.object({ url: z.string().url(), events: z.array(z.string()).optional() }), secrets: z.object({}).optional() }),
  z.object({
    kind: z.literal("email_smtp"),
    label: z.string().optional(),
    settings: z.object({ host: z.string(), port: z.number().int(), secure: z.boolean().optional(), user: z.string(), fromEmail: z.string().email(), fromName: z.string().optional(), replyTo: z.string().email().optional() }),
    secrets: z.object({ password: z.string() }),
  }),
]);

function range(q: Record<string, unknown>) {
  const to = q.to ? new Date(String(q.to)) : new Date();
  const from = q.from ? new Date(String(q.from)) : new Date(to.getTime() - Number(q.days ?? 30) * 86_400_000);
  return { from, to };
}

export function tenantRouter() {
  const r = express.Router();
  r.use(express.json({ limit: "2mb" }));
  r.use(requireTenant);

  // ---------- tenant ----------
  r.get(
    "/tenant",
    h(async (req, res) => {
      const t = req.tenant!;
      res.json({
        id: t.id,
        name: t.name,
        timezone: t.timezone,
        inboundWebhooks: {
          contact: `${env.PUBLIC_BASE_URL}/hooks/${t.id}/contact?agentId=<AGENT_ID>`,
          hubspot: `${env.PUBLIC_BASE_URL}/hooks/${t.id}/hubspot?integrationId=<HUBSPOT_INTEGRATION_ID>&agentId=<AGENT_ID>`,
          secretHeader: "X-Webhook-Secret",
          secret: t.webhookSecret,
        },
      });
    }),
  );

  r.patch(
    "/tenant",
    requireOwner,
    h(async (req, res) => {
      const body = z.object({ name: z.string().min(1).optional(), timezone: z.string().optional() }).parse(req.body);
      const [t] = await db().update(schema.tenants).set(body).where(eq(schema.tenants.id, req.tenant!.id)).returning();
      res.json({ id: t.id, name: t.name, timezone: t.timezone });
    }),
  );
  r.post(
    "/tenant/rotate-key",
    requireOwner,
    h(async (req, res) => {
      const apiKey = newSecret("vk_live_", 32);
      await db().update(schema.tenants).set({ apiKeyHash: sha256Hex(apiKey) }).where(eq(schema.tenants.id, req.tenant!.id));
      res.json({ apiKey, note: "The old key stops working now. Shown once." });
    }),
  );

  // ---------- team ----------
  r.get(
    "/users",
    h(async (req, res) => {
      const rows = await db().select().from(schema.users).where(eq(schema.users.tenantId, req.tenant!.id));
      res.json({ users: rows.map(publicUser) });
    }),
  );
  r.post(
    "/users",
    requireOwner,
    h(async (req, res) => {
      const body = z.object({ email: z.string().email(), name: z.string().optional(), role: z.enum(["owner", "member"]).default("member") }).parse(req.body);
      const { user, temporaryPassword } = await createUser({ ...body, tenantId: req.tenant!.id });
      res.status(201).json({ user: publicUser(user), temporaryPassword });
    }),
  );
  r.delete(
    "/users/:id",
    requireOwner,
    h(async (req, res) => {
      if (req.user?.id === req.params.id) return res.status(400).json({ error: "You can't remove yourself" });
      await db().delete(schema.users).where(and(eq(schema.users.id, req.params.id as string), eq(schema.users.tenantId, req.tenant!.id)));
      res.sendStatus(204);
    }),
  );

  // ---------- agents ----------
  r.get(
    "/agents",
    h(async (req, res) => {
      res.json({ agents: await db().select().from(schema.agents).where(eq(schema.agents.tenantId, req.tenant!.id)).orderBy(desc(schema.agents.createdAt)) });
    }),
  );
  r.post(
    "/agents",
    h(async (req, res) => {
      const body = z.object({ name: z.string().min(1), config: z.unknown() }).parse(req.body);
      const config = AgentConfig.parse(body.config);
      const [row] = await db().insert(schema.agents).values({ id: newId("agt"), tenantId: req.tenant!.id, name: body.name, config }).returning();
      res.status(201).json(row);
    }),
  );
  r.get(
    "/agents/:id",
    h(async (req, res) => {
      const [row] = await db().select().from(schema.agents).where(and(eq(schema.agents.id, req.params.id as string), eq(schema.agents.tenantId, req.tenant!.id)));
      if (!row) return res.status(404).json({ error: "not found" });
      res.json(row);
    }),
  );
  r.patch(
    "/agents/:id",
    h(async (req, res) => {
      const [row] = await db().select().from(schema.agents).where(and(eq(schema.agents.id, req.params.id as string), eq(schema.agents.tenantId, req.tenant!.id)));
      if (!row) return res.status(404).json({ error: "not found" });
      const body = z.object({ name: z.string().optional(), config: z.record(z.string(), z.unknown()).optional() }).parse(req.body);
      // Shallow-merge so you can change one section (e.g. voice) without resending everything.
      const merged = { ...(row.config as Record<string, unknown>), ...(body.config ?? {}) };
      const config = AgentConfig.parse(merged);
      const [updated] = await db()
        .update(schema.agents)
        .set({ name: body.name ?? row.name, config, updatedAt: new Date() })
        .where(eq(schema.agents.id, row.id))
        .returning();
      res.json(updated);
    }),
  );
  r.delete(
    "/agents/:id",
    h(async (req, res) => {
      await db().delete(schema.agents).where(and(eq(schema.agents.id, req.params.id as string), eq(schema.agents.tenantId, req.tenant!.id)));
      res.sendStatus(204);
    }),
  );
  /** Calls you (or anyone) right now, ignoring calling hours: the quickest way to hear a voice/prompt change. */
  r.post(
    "/agents/:id/test-call",
    h(async (req, res) => {
      const { phone } = z.object({ phone: z.string() }).parse(req.body);
      const e164 = toE164(phone);
      if (!e164) return res.status(400).json({ error: "invalid phone" });
      const contact = await upsertContact(req.tenant!.id, { phone: e164 });
      res.json(await enqueueCall({ tenantId: req.tenant!.id, agentId: req.params.id as string, contact, reason: "test call", force: true }));
    }),
  );
  r.post(
    "/agents/:id/insights",
    h(async (req, res) => {
      const { from, to } = range({ ...req.query, ...req.body });
      res.status(201).json(await generateInsightReport({ tenantId: req.tenant!.id, agentId: req.params.id as string, from, to }));
    }),
  );

  // ---------- voices & ambience ----------
  r.get(
    "/voices",
    h(async (_req, res) => {
      res.json({ voices: await listVoices() });
    }),
  );
  r.post(
    "/voices/preview",
    h(async (req, res) => {
      const body = z
        .object({ text: z.string().max(500).default("Hi there! Thanks for calling. How can I help you today?"), voice: AgentConfig.shape.voice })
        .parse(req.body);
      res.type("audio/mpeg").send(await previewVoice(body.text, body.voice));
    }),
  );
  r.get(
    "/ambience/:preset.wav",
    h(async (req, res) => {
      const preset = z.enum(["office", "call_center", "coffee_shop"]).parse(req.params.preset) as AmbiencePreset;
      const loop = (await loadAmbience(preset))!;
      const volume = Math.min(1, Number(req.query.volume ?? 0.5));
      const seconds = Math.min(loop.length, SAMPLE_RATE * 10);
      const pcm = Buffer.alloc(seconds * 2);
      for (let i = 0; i < seconds; i++) pcm.writeInt16LE(Math.round(loop[i] * volume * 32767), i * 2);
      const header = Buffer.alloc(44);
      header.write("RIFF", 0);
      header.writeUInt32LE(36 + pcm.length, 4);
      header.write("WAVEfmt ", 8);
      header.writeUInt32LE(16, 16);
      header.writeUInt16LE(1, 20);
      header.writeUInt16LE(1, 22);
      header.writeUInt32LE(SAMPLE_RATE, 24);
      header.writeUInt32LE(SAMPLE_RATE * 2, 28);
      header.writeUInt16LE(2, 32);
      header.writeUInt16LE(16, 34);
      header.write("data", 36);
      header.writeUInt32LE(pcm.length, 40);
      res.type("audio/wav").send(Buffer.concat([header, pcm]));
    }),
  );

  // ---------- phone numbers ----------
  r.get(
    "/numbers",
    h(async (req, res) => {
      res.json({ numbers: await db().select().from(schema.phoneNumbers).where(eq(schema.phoneNumbers.tenantId, req.tenant!.id)) });
    }),
  );
  r.get(
    "/numbers/available",
    h(async (req, res) => {
      const country = String(req.query.country ?? "US");
      const areaCode = req.query.areaCode ? Number(req.query.areaCode) : undefined;
      const list = await twilioClient()
        .availablePhoneNumbers(country)
        .local.list({ areaCode, contains: req.query.contains ? String(req.query.contains) : undefined, voiceEnabled: true, smsEnabled: true, limit: 20 });
      res.json({ numbers: list.map((n) => ({ phoneNumber: n.phoneNumber, friendlyName: n.friendlyName, locality: n.locality, region: n.region })) });
    }),
  );
  const webhookUrls = () => ({
    voiceUrl: `${env.PUBLIC_BASE_URL}/twilio/voice`,
    voiceMethod: "POST",
    statusCallback: `${env.PUBLIC_BASE_URL}/twilio/status`,
    statusCallbackMethod: "POST",
    smsUrl: `${env.PUBLIC_BASE_URL}/twilio/sms`,
    smsMethod: "POST",
  });
  r.post(
    "/numbers",
    h(async (req, res) => {
      const body = z.object({ phoneNumber: z.string(), agentId: z.string().optional() }).parse(req.body);
      const bought = await twilioClient().incomingPhoneNumbers.create({ phoneNumber: body.phoneNumber, friendlyName: `${req.tenant!.name}`, ...webhookUrls() });
      const [row] = await db()
        .insert(schema.phoneNumbers)
        .values({ id: newId("num"), tenantId: req.tenant!.id, agentId: body.agentId ?? null, e164: bought.phoneNumber, twilioSid: bought.sid, friendlyName: bought.friendlyName })
        .returning();
      res.status(201).json(row);
    }),
  );
  /** Use a number that's already in your Twilio account (or ported in). */
  r.post(
    "/numbers/import",
    h(async (req, res) => {
      const body = z.object({ phoneNumber: z.string(), agentId: z.string().optional() }).parse(req.body);
      const e164 = toE164(body.phoneNumber);
      const [found] = await twilioClient().incomingPhoneNumbers.list({ phoneNumber: e164 ?? body.phoneNumber, limit: 1 });
      if (!found) return res.status(404).json({ error: "number not found in the Twilio account" });
      await twilioClient().incomingPhoneNumbers(found.sid).update(webhookUrls());
      const [row] = await db()
        .insert(schema.phoneNumbers)
        .values({ id: newId("num"), tenantId: req.tenant!.id, agentId: body.agentId ?? null, e164: found.phoneNumber, twilioSid: found.sid, friendlyName: found.friendlyName })
        .returning();
      res.status(201).json(row);
    }),
  );
  r.patch(
    "/numbers/:id",
    h(async (req, res) => {
      const body = z.object({ agentId: z.string().nullable() }).parse(req.body);
      const [row] = await db()
        .update(schema.phoneNumbers)
        .set({ agentId: body.agentId })
        .where(and(eq(schema.phoneNumbers.id, req.params.id as string), eq(schema.phoneNumbers.tenantId, req.tenant!.id)))
        .returning();
      if (!row) return res.status(404).json({ error: "not found" });
      res.json(row);
    }),
  );
  r.delete(
    "/numbers/:id",
    h(async (req, res) => {
      const [row] = await db()
        .select()
        .from(schema.phoneNumbers)
        .where(and(eq(schema.phoneNumbers.id, req.params.id as string), eq(schema.phoneNumbers.tenantId, req.tenant!.id)));
      if (!row) return res.status(404).json({ error: "not found" });
      if (req.query.release === "true") await twilioClient().incomingPhoneNumbers(row.twilioSid).remove();
      await db().delete(schema.phoneNumbers).where(eq(schema.phoneNumbers.id, row.id));
      res.sendStatus(204);
    }),
  );

  // ---------- integrations ----------
  r.get(
    "/integrations",
    h(async (req, res) => {
      const rows = await db().select().from(schema.integrations).where(eq(schema.integrations.tenantId, req.tenant!.id));
      res.json({ integrations: rows.map(({ secretsEnc, ...rest }) => ({ ...rest, hasCredentials: !!secretsEnc })) });
    }),
  );
  r.post(
    "/integrations",
    h(async (req, res) => {
      const body = IntegrationInput.parse(req.body);
      let secrets: Record<string, unknown> = body.secrets ?? {};
      let reveal: Record<string, unknown> | undefined;
      if (body.kind === "webhook") {
        secrets = { signingSecret: newSecret("whsec_", 24) };
        reveal = secrets;
      }
      const [row] = await db()
        .insert(schema.integrations)
        .values({ id: newId("int"), tenantId: req.tenant!.id, kind: body.kind, label: body.label ?? body.kind, settings: body.settings, secretsEnc: encryptJson(secrets) })
        .returning();
      const { secretsEnc: _s, ...safe } = row;
      res.status(201).json({ ...safe, ...(reveal ? { secrets: reveal, note: "Verify X-Signature with this secret. Shown once." } : {}) });
    }),
  );
  /** Returns a Google consent URL; open it in a browser to connect a Google Calendar. */
  r.post(
    "/integrations/google/connect",
    h(async (req, res) => {
      if (!googleConfigured()) return res.status(400).json({ error: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first" });
      const body = z.object({ label: z.string().optional(), calendarId: z.string().optional() }).parse(req.body ?? {});
      const state = signToken({ tenantId: req.tenant!.id, ...body }, 1800);
      const url = googleOAuthClient().generateAuthUrl({ access_type: "offline", prompt: "consent", scope: GOOGLE_SCOPES, state });
      res.json({ url });
    }),
  );
  r.post(
    "/integrations/:id/test",
    h(async (req, res) => {
      const row = await getIntegration(req.tenant!.id, req.params.id as string);
      if (!row) return res.status(404).json({ error: "not found" });
      try {
        if (row.kind === "google_calendar" || row.kind === "calcom") {
          const tz = req.tenant!.timezone;
          const now = DateTime.now().setZone(tz);
          const cfg = AgentConfig.shape.calendar.parse({});
          const slots = await calendarFromRow(row).openSlots(now, now.plus({ days: 7 }), cfg, tz);
          return res.json({ ok: true, openSlotsNext7Days: slots.length, first: slots[0]?.toISO() ?? null });
        }
        if (row.kind === "hubspot" || row.kind === "gohighlevel") {
          await crmFromRow(row).findByPhone("+15555550100");
          return res.json({ ok: true });
        }
        if (row.kind === "email_smtp") {
          const s = row.settings as unknown as SmtpSettings;
          const { password } = decryptJson<{ password: string }>(row.secretsEnc!);
          await nodemailer.createTransport({ host: s.host, port: s.port, secure: s.secure ?? s.port === 465, auth: { user: s.user, pass: password } }).verify();
          return res.json({ ok: true });
        }
        if (row.kind === "webhook") {
          await emitEvent(req.tenant!.id, "contact.updated", { test: true });
          return res.json({ ok: true, note: "test event sent to all webhook integrations" });
        }
        res.json({ ok: true });
      } catch (e) {
        res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }),
  );
  r.delete(
    "/integrations/:id",
    requireOwner,
    h(async (req, res) => {
      await db().delete(schema.integrations).where(and(eq(schema.integrations.id, req.params.id as string), eq(schema.integrations.tenantId, req.tenant!.id)));
      res.sendStatus(204);
    }),
  );

  // ---------- contacts ----------
  r.get(
    "/contacts",
    h(async (req, res) => {
      const rows = await db()
        .select()
        .from(schema.contacts)
        .where(and(eq(schema.contacts.tenantId, req.tenant!.id), req.query.phone ? eq(schema.contacts.phone, toE164(String(req.query.phone)) ?? "") : undefined))
        .orderBy(desc(schema.contacts.updatedAt))
        .limit(Math.min(200, Number(req.query.limit ?? 50)));
      res.json({ contacts: rows });
    }),
  );
  r.post(
    "/contacts",
    h(async (req, res) => {
      const body = z
        .object({ phone: z.string(), firstName: z.string().optional(), lastName: z.string().optional(), email: z.string().email().optional(), timezone: z.string().optional(), fields: z.record(z.string(), z.unknown()).optional() })
        .parse(req.body);
      const phone = toE164(body.phone);
      if (!phone) return res.status(400).json({ error: "invalid phone" });
      res.status(201).json(await upsertContact(req.tenant!.id, { ...body, phone }));
    }),
  );
  r.patch(
    "/contacts/:id",
    h(async (req, res) => {
      const body = z.object({ doNotCall: z.boolean().optional(), doNotText: z.boolean().optional(), firstName: z.string().optional(), lastName: z.string().optional(), email: z.string().email().optional(), timezone: z.string().optional() }).parse(req.body);
      const [row] = await db()
        .update(schema.contacts)
        .set({ ...body, updatedAt: new Date() })
        .where(and(eq(schema.contacts.id, req.params.id as string), eq(schema.contacts.tenantId, req.tenant!.id)))
        .returning();
      if (!row) return res.status(404).json({ error: "not found" });
      res.json(row);
    }),
  );

  // ---------- calls ----------
  r.post(
    "/calls",
    h(async (req, res) => {
      const body = z
        .object({
          agentId: z.string(),
          contactId: z.string().optional(),
          phone: z.string().optional(),
          firstName: z.string().optional(),
          lastName: z.string().optional(),
          email: z.string().optional(),
          reason: z.string().optional(),
          notBefore: z.string().datetime().optional(),
        })
        .parse(req.body);
      let contact = body.contactId ? await getContact(req.tenant!.id, body.contactId) : null;
      if (!contact && body.phone) {
        const phone = toE164(body.phone);
        if (!phone) return res.status(400).json({ error: "invalid phone" });
        contact = await upsertContact(req.tenant!.id, { phone, firstName: body.firstName, lastName: body.lastName, email: body.email });
      }
      if (!contact) return res.status(400).json({ error: "contactId or phone required" });
      const result = await enqueueCall({ tenantId: req.tenant!.id, agentId: body.agentId, contact, reason: body.reason, notBefore: body.notBefore ? new Date(body.notBefore) : undefined });
      res.status(result.queued ? 202 : 409).json(result);
    }),
  );
  r.get(
    "/calls",
    h(async (req, res) => {
      const c = schema.calls;
      const q = req.query as Record<string, string | undefined>;
      const rows = await db()
        .select({
          id: c.id,
          agentId: c.agentId,
          contactId: c.contactId,
          direction: c.direction,
          fromNumber: c.fromNumber,
          toNumber: c.toNumber,
          status: c.status,
          outcome: c.outcome,
          booked: c.booked,
          transferredTo: c.transferredTo,
          endedBy: c.endedBy,
          durationSeconds: c.durationSeconds,
          summary: c.summary,
          reviewScore: sql<number | null>`(${c.review}->>'score')::int`,
          contactName: sql<string | null>`nullif(trim(concat_ws(' ', ${schema.contacts.firstName}, ${schema.contacts.lastName})), '')`,
          hasRecording: sql<boolean>`${c.recordingUrl} is not null`,
          scheduledFor: c.scheduledFor,
          createdAt: c.createdAt,
        })
        .from(c)
        .leftJoin(schema.contacts, eq(schema.contacts.id, c.contactId))
        .where(
          and(
            eq(c.tenantId, req.tenant!.id),
            q.agentId ? eq(c.agentId, q.agentId) : undefined,
            q.status ? eq(c.status, q.status as never) : undefined,
            q.outcome ? eq(c.outcome, q.outcome) : undefined,
            q.contactId ? eq(c.contactId, q.contactId) : undefined,
            q.before ? lt(c.createdAt, new Date(q.before)) : undefined,
          ),
        )
        .orderBy(desc(c.createdAt))
        .limit(Math.min(200, Number(q.limit ?? 50)));
      res.json({ calls: rows, nextBefore: rows.at(-1)?.createdAt ?? null });
    }),
  );
  r.get(
    "/calls/:id",
    h(async (req, res) => {
      const call = await getCallForTenant(req.tenant!.id, req.params.id as string);
      if (!call) return res.status(404).json({ error: "not found" });
      const [events, msgs] = await Promise.all([
        db().select().from(schema.callEvents).where(eq(schema.callEvents.callId, call.id)).orderBy(schema.callEvents.at),
        db().select().from(schema.messages).where(eq(schema.messages.callId, call.id)).orderBy(schema.messages.createdAt),
      ]);
      const contact = call.contactId ? await getContact(req.tenant!.id, call.contactId) : null;
      const { recordingUrl, ...rest } = call;
      res.json({ ...rest, recording: recordingUrl ? `/api/calls/${call.id}/recording` : null, contact, events, followUps: msgs });
    }),
  );
  /** Streams the recording (Twilio recordings need your account credentials to download). */
  r.get(
    "/calls/:id/recording",
    h(async (req, res) => {
      const call = await getCallForTenant(req.tenant!.id, req.params.id as string);
      if (!call?.recordingUrl) return res.status(404).json({ error: "no recording" });
      const auth = Buffer.from(`${requireEnv("TWILIO_ACCOUNT_SID")}:${requireEnv("TWILIO_AUTH_TOKEN")}`).toString("base64");
      const upstream = await fetch(call.recordingUrl, { headers: { Authorization: `Basic ${auth}` } });
      if (!upstream.ok) return res.status(502).json({ error: `recording fetch failed (${upstream.status})` });
      res.type("audio/mpeg").send(Buffer.from(await upstream.arrayBuffer()));
    }),
  );
  r.delete(
    "/calls/:id",
    h(async (req, res) => {
      const [row] = await db()
        .update(schema.calls)
        .set({ status: "canceled" })
        .where(and(eq(schema.calls.id, req.params.id as string), eq(schema.calls.tenantId, req.tenant!.id), eq(schema.calls.status, "queued")))
        .returning();
      if (!row) return res.status(409).json({ error: "only queued calls can be canceled" });
      res.sendStatus(204);
    }),
  );

  // ---------- analytics, usage, insights ----------
  r.get(
    "/analytics",
    h(async (req, res) => {
      res.json(await callStats(req.tenant!.id, { ...range(req.query), agentId: req.query.agentId ? String(req.query.agentId) : undefined, timezone: req.tenant!.timezone }));
    }),
  );
  r.get(
    "/usage",
    h(async (req, res) => {
      const { from, to } = range(req.query);
      res.json(await usage(req.tenant!.id, from, to));
    }),
  );
  r.get(
    "/events",
    h(async (req, res) => {
      const rows = await db()
        .select()
        .from(schema.callEvents)
        .where(and(eq(schema.callEvents.tenantId, req.tenant!.id), req.query.type ? eq(schema.callEvents.type, String(req.query.type)) : undefined))
        .orderBy(desc(schema.callEvents.at))
        .limit(Math.min(500, Number(req.query.limit ?? 100)));
      res.json({ events: rows });
    }),
  );
  r.get(
    "/insights",
    h(async (req, res) => {
      res.json({ reports: await db().select().from(schema.insightReports).where(eq(schema.insightReports.tenantId, req.tenant!.id)).orderBy(desc(schema.insightReports.createdAt)).limit(20) });
    }),
  );

  // ---------- messaging ----------
  r.get(
    "/messages",
    h(async (req, res) => {
      const rows = await db()
        .select()
        .from(schema.messages)
        .where(and(eq(schema.messages.tenantId, req.tenant!.id), req.query.contactId ? eq(schema.messages.contactId, String(req.query.contactId)) : undefined))
        .orderBy(desc(schema.messages.createdAt))
        .limit(Math.min(200, Number(req.query.limit ?? 50)));
      res.json({ messages: rows });
    }),
  );
  r.post(
    "/sms",
    h(async (req, res) => {
      const body = z.object({ agentId: z.string(), to: z.string(), body: z.string().min(1).max(1600) }).parse(req.body);
      const to = toE164(body.to);
      if (!to) return res.status(400).json({ error: "invalid phone" });
      const [num] = await db().select().from(schema.phoneNumbers).where(and(eq(schema.phoneNumbers.agentId, body.agentId), eq(schema.phoneNumbers.tenantId, req.tenant!.id)));
      if (!num) return res.status(400).json({ error: "agent has no phone number" });
      const contact = await upsertContact(req.tenant!.id, { phone: to });
      if (contact.doNotText) return res.status(409).json({ error: "contact opted out of texts" });
      res.status(201).json(await sendSms({ tenantId: req.tenant!.id, agentId: body.agentId, contactId: contact.id, from: num.e164, to, body: body.body }));
    }),
  );
  r.post(
    "/email",
    h(async (req, res) => {
      const body = z.object({ agentId: z.string(), to: z.string().email(), subject: z.string(), text: z.string(), assetKeys: z.array(z.string()).default([]) }).parse(req.body);
      const [agent] = await db().select().from(schema.agents).where(and(eq(schema.agents.id, body.agentId), eq(schema.agents.tenantId, req.tenant!.id)));
      if (!agent) return res.status(404).json({ error: "agent not found" });
      const cfg = parseAgentConfig(agent.config);
      if (!cfg.followUp.emailIntegrationId) return res.status(400).json({ error: "agent has no followUp.emailIntegrationId" });
      res.status(201).json(
        await sendEmail({
          tenantId: req.tenant!.id,
          integrationId: cfg.followUp.emailIntegrationId,
          agentId: agent.id,
          to: body.to,
          subject: body.subject,
          text: body.text,
          assets: cfg.followUp.assets.filter((a) => body.assetKeys.includes(a.key)),
        }),
      );
    }),
  );

  return r;
}
