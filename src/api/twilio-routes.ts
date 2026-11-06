import express, { type Request, type Response, type NextFunction } from "express";
import twilio from "twilio";
import { eq } from "drizzle-orm";
import { env } from "../env.js";
import { db, schema } from "../db/index.js";
import { newId, signToken, verifyToken } from "../lib/crypto.js";
import { log, errMsg } from "../lib/log.js";
import { parseAgentConfig, fillTemplate, templateVars } from "../agents/config.js";
import { loadCrm } from "../integrations/registry.js";
import { resolveContactByPhone, getContact } from "../contacts.js";
import { getCall, updateCall, addCallEvent } from "../calls.js";
import { finalizeCall } from "../finalize.js";
import { handleInboundSms } from "../sms/inbound.js";
import { previewVoice } from "../telephony/tts.js";
import { streamTwiml, sayTwiml, playTwiml, EMPTY_TWIML, escapeXml } from "../telephony/twiml.js";

function xml(res: Response, body: string) {
  res.type("text/xml").send(body);
}

/** Rejects requests that weren't signed by Twilio with your auth token. */
function validateTwilio(req: Request, res: Response, next: NextFunction) {
  if (!env.TWILIO_VALIDATE_SIGNATURE) return next();
  const sig = req.header("X-Twilio-Signature") ?? "";
  const url = `${env.PUBLIC_BASE_URL}${req.originalUrl}`;
  if (!env.TWILIO_AUTH_TOKEN || !twilio.validateRequest(env.TWILIO_AUTH_TOKEN, sig, url, req.body ?? {})) {
    log.warn("rejected unsigned Twilio request", { path: req.path });
    return res.status(403).send("invalid signature");
  }
  next();
}

function connectStream(callId: string, resume = false) {
  const wsUrl = `${env.PUBLIC_BASE_URL.replace(/^http/, "ws")}/twilio/media`;
  return streamTwiml(wsUrl, { callId, token: signToken({ callId }, 4 * 3600), ...(resume ? { resume: "1" } : {}) });
}

export function twilioRouter() {
  const r = express.Router();
  r.use(express.urlencoded({ extended: false }));
  r.use(validateTwilio);

  // Incoming call to one of our numbers.
  r.post("/voice", async (req, res) => {
    const { From, To, CallSid } = req.body as Record<string, string>;
    const [num] = await db().select().from(schema.phoneNumbers).where(eq(schema.phoneNumbers.e164, To));
    if (!num?.agentId) return xml(res, sayTwiml("Sorry, this number isn't set up yet. Goodbye."));
    const [agent] = await db().select().from(schema.agents).where(eq(schema.agents.id, num.agentId));
    const cfg = parseAgentConfig(agent.config);
    const crm = await loadCrm(num.tenantId, cfg.crm.integrationId).catch(() => null);
    const contact = await resolveContactByPhone(num.tenantId, From, crm);
    const id = newId("call");
    await db().insert(schema.calls).values({
      id,
      tenantId: num.tenantId,
      agentId: agent.id,
      contactId: contact.id,
      direction: "inbound",
      fromNumber: From,
      toNumber: To,
      status: "in_progress",
      twilioCallSid: CallSid,
      startedAt: new Date(),
    });
    await addCallEvent({ id, tenantId: num.tenantId }, "call.ringing", { from: From });
    if (contact.doNotCall) await addCallEvent({ id, tenantId: num.tenantId }, "note", { text: "Caller is on do-not-call list (inbound calls are still answered)" });
    xml(res, connectStream(id));
  });

  // Outbound call answered (after answering-machine detection, if enabled).
  r.post("/outbound-answer", async (req, res) => {
    const callId = String(req.query.callId ?? "");
    const call = await getCall(callId);
    if (!call) return xml(res, EMPTY_TWIML);
    const answeredBy = (req.body.AnsweredBy as string | undefined) ?? null;
    await updateCall(callId, { answeredBy, startedAt: new Date() });
    if (answeredBy?.startsWith("machine") || answeredBy === "fax") {
      const [agent] = await db().select().from(schema.agents).where(eq(schema.agents.id, call.agentId));
      const cfg = parseAgentConfig(agent.config);
      await updateCall(callId, { status: "voicemail", endedBy: "system" });
      await addCallEvent(call, "voicemail.detected", { answeredBy });
      if (!cfg.dialer.leaveVoicemail || answeredBy === "fax") return xml(res, `<Response><Hangup/></Response>`);
      const token = signToken({ callId }, 600);
      // Played in the agent's own voice.
      return xml(res, playTwiml(`${env.PUBLIC_BASE_URL}/twilio/voicemail.mp3?callId=${encodeURIComponent(callId)}&token=${encodeURIComponent(token)}`));
    }
    xml(res, connectStream(callId));
  });

  r.post("/status", async (req, res) => {
    res.sendStatus(204);
    const b = req.body as Record<string, string>;
    let callId = req.query.callId ? String(req.query.callId) : null;
    if (!callId && b.CallSid) {
      const [c] = await db().select({ id: schema.calls.id }).from(schema.calls).where(eq(schema.calls.twilioCallSid, b.CallSid));
      callId = c?.id ?? null;
    }
    if (!callId) return;
    const call = await getCall(callId);
    if (!call) return;
    await addCallEvent(call, `twilio.${b.CallStatus}`, { answeredBy: b.AnsweredBy });
    if (b.CallStatus === "in-progress" && call.status === "dialing") await updateCall(callId, { status: "in_progress" });
    if (["completed", "no-answer", "busy", "failed", "canceled"].includes(b.CallStatus)) {
      finalizeCall(callId, b as { CallStatus: string }).catch((e) => log.error("finalize failed", { callId, error: errMsg(e) }));
    }
  });

  r.post("/transfer-result", async (req, res) => {
    const callId = String(req.query.callId ?? "");
    if (!verifyToken<{ callId: string }>(String(req.query.token ?? ""))) return xml(res, EMPTY_TWIML);
    const status = req.body.DialCallStatus as string;
    const call = await getCall(callId);
    if (call) await addCallEvent(call, "transfer.result", { status, durationSeconds: req.body.DialCallDuration });
    if (status === "completed" || status === "answered") return xml(res, `<Response><Hangup/></Response>`);
    // Nobody picked up: hand the caller back to the AI.
    await updateCall(callId, { transferredTo: null, endedBy: null });
    xml(res, connectStream(callId, true));
  });

  // Whispered to the person receiving a transfer before they're connected.
  r.post("/whisper", async (req, res) => {
    if (!verifyToken(String(req.query.token ?? ""))) return xml(res, EMPTY_TWIML);
    const call = await getCall(String(req.query.callId ?? ""));
    const contact = call?.contactId ? await getContact(call.tenantId, call.contactId) : null;
    const who = contact?.firstName ? `${contact.firstName}${contact.lastName ? ` ${contact.lastName}` : ""}` : "a caller";
    xml(res, `<Response><Say voice="Polly.Joanna-Neural">Transfer from the AI assistant. ${escapeXml(who)}. ${escapeXml(String(req.query.reason ?? ""))}. Connecting now.</Say></Response>`);
  });

  r.post("/recording", async (req, res) => {
    res.sendStatus(204);
    const callId = String(req.query.callId ?? "");
    const call = await getCall(callId);
    if (!call || req.body.RecordingStatus !== "completed") return;
    await updateCall(callId, { recordingUrl: `${req.body.RecordingUrl}.mp3` });
    await addCallEvent(call, "recording.completed", { durationSeconds: req.body.RecordingDuration });
  });

  r.post("/sms", async (req, res) => {
    xml(res, EMPTY_TWIML);
    handleInboundSms(req.body).catch((e) => log.error("inbound sms failed", { error: errMsg(e) }));
  });

  r.post("/sms/status", async (req, res) => {
    res.sendStatus(204);
    if (req.body.MessageSid) {
      await db().update(schema.messages).set({ status: req.body.MessageStatus }).where(eq(schema.messages.twilioSid, req.body.MessageSid));
    }
  });

  return r;
}

/** Voicemail audio in the agent's voice (Twilio <Play> fetches this with GET, unsigned). */
export function voicemailRoute() {
  return async (req: Request, res: Response) => {
    const claims = verifyToken<{ callId: string }>(String(req.query.token ?? ""));
    if (!claims || claims.callId !== req.query.callId) return res.sendStatus(403);
    const call = await getCall(claims.callId);
    if (!call) return res.sendStatus(404);
    const [agent] = await db().select().from(schema.agents).where(eq(schema.agents.id, call.agentId));
    const cfg = parseAgentConfig(agent.config);
    const contact = call.contactId ? await getContact(call.tenantId, call.contactId) : null;
    try {
      const mp3 = await previewVoice(fillTemplate(cfg.voicemailMessage, templateVars(cfg, contact)), cfg.voice);
      res.type("audio/mpeg").send(mp3);
    } catch (e) {
      log.error("voicemail tts failed", { error: errMsg(e) });
      res.sendStatus(500);
    }
  };
}
