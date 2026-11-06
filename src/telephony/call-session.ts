import type WebSocket from "ws";
import { eq } from "drizzle-orm";
import { env } from "../env.js";
import { db, schema } from "../db/index.js";
import type { CallRow, Contact } from "../db/schema.js";
import { verifyToken, signToken } from "../lib/crypto.js";
import { log, errMsg } from "../lib/log.js";
import { parseAgentConfig, fillTemplate, templateVars, type AgentConfig } from "../agents/config.js";
import { Conversation } from "../agents/conversation.js";
import { stableSystem, sessionContext, buildSystem } from "../agents/prompt.js";
import type { AgentRuntime } from "../agents/tools.js";
import { SentenceChunker } from "../agents/sentences.js";
import { loadCalendar, loadCrm } from "../integrations/registry.js";
import { getContact, upsertContact } from "../contacts.js";
import { getCall, updateCall, addCallEvent, appendTranscript } from "../calls.js";
import { loadAmbience } from "../audio/ambience.js";
import { DeepgramStream } from "./stt.js";
import { synthesizeUlaw } from "./tts.js";
import { Speaker } from "./speaker.js";
import { twilioClient } from "./twilio-client.js";
import { sendSms } from "../sms/send.js";
import { sendEmail } from "../email/send.js";
import { emitEvent } from "../integrations/webhooks.js";
import { escapeXml } from "./twiml.js";

/** Conversations kept in memory for the life of a call, so a failed transfer can resume. */
const live = new Map<string, { conversation: Conversation; rt: AgentRuntime }>();
export function forgetCall(callId: string) {
  live.delete(callId);
}

type TwilioMsg =
  | { event: "connected" }
  | { event: "start"; start: { streamSid: string; callSid: string; customParameters?: Record<string, string> } }
  | { event: "media"; media: { payload: string; track?: string } }
  | { event: "mark"; mark: { name: string } }
  | { event: "stop" };

export function handleMediaStream(ws: WebSocket) {
  let session: CallSession | null = null;
  ws.on("message", async (raw) => {
    let msg: TwilioMsg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.event === "start") {
      const p = msg.start.customParameters ?? {};
      const claims = p.token ? verifyToken<{ callId: string }>(p.token) : null;
      if (!claims || claims.callId !== p.callId) {
        log.warn("media stream with invalid token");
        ws.close();
        return;
      }
      try {
        session = await CallSession.start(ws, msg.start.streamSid, msg.start.callSid, p.callId, p.resume === "1");
      } catch (e) {
        log.error("failed to start call session", { callId: p.callId, error: errMsg(e) });
        ws.close();
      }
    } else if (msg.event === "media") {
      session?.onAudio(Buffer.from(msg.media.payload, "base64"));
    } else if (msg.event === "stop") {
      void session?.onStop();
    }
  });
  ws.on("close", () => void session?.onStop());
}

class CallSession {
  private turn: Promise<void> | null = null;
  private turnAbort: AbortController | null = null;
  private pending: string[] = [];
  private action: { kind: "transfer"; target: AgentConfig["transferTargets"][number]; reason: string } | { kind: "hangup"; reason: string } | null = null;
  private lastActivity = Date.now();
  private nudges = 0;
  private stopped = false;
  private timers: NodeJS.Timeout[] = [];
  private spokeThisTurn = false;
  private bookedSomething = false;

  private constructor(
    private ws: WebSocket,
    private streamSid: string,
    private callSid: string,
    private call: CallRow,
    private cfg: AgentConfig,
    private conversation: Conversation,
    private rt: AgentRuntime,
    private speaker: Speaker,
    private stt: DeepgramStream,
  ) {}

  static async start(ws: WebSocket, streamSid: string, callSid: string, callId: string, resumed: boolean) {
    const call = await getCall(callId);
    if (!call) throw new Error(`call ${callId} not found`);
    const [agent] = await db().select().from(schema.agents).where(eq(schema.agents.id, call.agentId));
    if (!agent) throw new Error("agent not found");
    const cfg = parseAgentConfig(agent.config);
    const agentNumber = call.direction === "outbound" ? call.fromNumber : call.toNumber;
    const otherNumber = call.direction === "outbound" ? call.toNumber : call.fromNumber;
    let contact: Contact | null = call.contactId ? await getContact(call.tenantId, call.contactId) : null;
    if (!contact) contact = await upsertContact(call.tenantId, { phone: otherNumber });

    const existing = live.get(callId);
    let session!: CallSession;
    let rt: AgentRuntime;
    let conversation: Conversation;
    if (existing) {
      rt = existing.rt;
      conversation = existing.conversation;
    } else {
      const [calendar, crm] = await Promise.all([
        loadCalendar(call.tenantId, cfg.calendar.integrationId).catch(() => null),
        loadCrm(call.tenantId, cfg.crm.integrationId).catch(() => null),
      ]);
      rt = {
        tenantId: call.tenantId,
        agentId: call.agentId,
        cfg,
        channel: "voice",
        contact,
        calendar,
        crm,
        callId,
      };
      if (env.TWILIO_ACCOUNT_SID) {
        rt.sendSms = async (body) => {
          await sendSms({ tenantId: call.tenantId, agentId: call.agentId, contactId: rt.contact.id, callId, from: agentNumber, to: rt.contact.phone, body });
        };
      }
      if (cfg.followUp.emailIntegrationId) {
        const integrationId = cfg.followUp.emailIntegrationId;
        rt.sendEmail = async (subject, body, keys) => {
          await sendEmail({
            tenantId: call.tenantId,
            integrationId,
            agentId: call.agentId,
            contactId: rt.contact.id,
            callId,
            to: rt.contact.email!,
            subject,
            text: body,
            assets: cfg.followUp.assets.filter((a) => keys.includes(a.key)),
          });
        };
      }
      const system = buildSystem(stableSystem(cfg, "voice"), sessionContext({ cfg, channel: "voice", direction: call.direction, contact }));
      conversation = new Conversation(rt, system);
      live.set(callId, { conversation, rt });
    }
    // These close over `session`, which is assigned below before any call can happen.
    rt.requestTransfer = (target, reason) => (session.action = { kind: "transfer", target, reason });
    rt.requestHangup = (reason) => (session.action = { kind: "hangup", reason });
    rt.onBooked = (b) => {
      session.bookedSomething = true;
      void updateCall(callId, { booked: true });
      void addCallEvent(call, "appointment.booked", b);
      if (cfg.sms.bookingConfirmation && rt.sendSms && !rt.contact.doNotText) {
        const text = fillTemplate(cfg.sms.bookingConfirmation, { ...templateVars(cfg, rt.contact), when: b.when });
        rt.sendSms(text).catch((e) => log.warn("confirmation sms failed", { error: errMsg(e) }));
      }
    };

    const ambience = await loadAmbience(cfg.ambience.preset, cfg.ambience.url).catch((e) => {
      log.warn("ambience load failed", { error: errMsg(e) });
      return null;
    });
    const speaker = new Speaker(
      (frame) => ws.readyState === 1 && ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: Buffer.from(frame).toString("base64") } })),
      () => ws.readyState === 1 && ws.send(JSON.stringify({ event: "clear", streamSid })),
      (text, signal) => synthesizeUlaw(text, cfg.voice, signal),
      ambience,
      cfg.ambience.volume,
      (text) => {
        void appendTranscript(callId, { role: "agent", text });
        session.lastActivity = Date.now();
      },
    );
    const stt = new DeepgramStream(cfg.language);
    session = new CallSession(ws, streamSid, callSid, call, cfg, conversation, rt, speaker, stt);
    stt.on("partial", (t: string) => session.onPartial(t));
    stt.on("utterance", (t: string) => session.onUtterance(t));

    await updateCall(callId, { status: "in_progress", twilioCallSid: callSid, startedAt: call.startedAt ?? new Date() });
    if (!resumed) {
      void addCallEvent(call, "call.connected", { direction: call.direction });
      void emitEvent(call.tenantId, "call.started", { callId, agentId: call.agentId, direction: call.direction, contactId: contact.id });
      if (cfg.behaviour.recordCalls) session.startRecording();
      const tpl = call.direction === "outbound" ? cfg.outboundGreeting : cfg.inboundGreeting;
      const greeting = fillTemplate(tpl, templateVars(cfg, contact));
      conversation.addAssistantText(greeting);
      speaker.say(greeting);
    } else {
      void addCallEvent(call, "transfer.failed", {});
      conversation.addUser(
        "[system: The transfer didn't go through (nobody answered). Tell the caller, and offer to take a message, book a callback, or help with anything else.]",
      );
      session.startTurn();
    }
    session.startTimers();
    return session;
  }

  onAudio(mulaw: Buffer) {
    this.stt.send(mulaw);
  }

  private onPartial(text: string) {
    this.lastActivity = Date.now();
    this.nudges = 0;
    // Barge-in: the caller started talking over the agent.
    if (this.speaker.speaking && text.trim().split(/\s+/).length >= 2) {
      this.speaker.interrupt();
      this.turnAbort?.abort();
      void addCallEvent(this.call, "barge_in", { partial: text.slice(0, 120) });
    }
  }

  private onUtterance(text: string) {
    this.lastActivity = Date.now();
    this.nudges = 0;
    void appendTranscript(this.call.id, { role: "caller", text });
    this.pending.push(text);
    // If the model is still thinking about the previous fragment, restart with the full thought.
    if (this.turn && !this.speaker.speaking) this.turnAbort?.abort();
    this.startTurn();
  }

  private startTurn() {
    const prev = this.turn;
    this.turnAbort?.abort();
    const abort = new AbortController();
    this.turnAbort = abort;
    const run = async () => {
      if (prev) await prev.catch(() => {});
      if (abort.signal.aborted || this.stopped) return;
      if (this.pending.length) {
        this.conversation.addUser(this.pending.join(" "));
        this.pending = [];
      }
      const chunker = new SentenceChunker();
      this.spokeThisTurn = false;
      const say = (s: string) => {
        this.spokeThisTurn = true;
        this.speaker.say(s);
      };
      try {
        const res = await this.conversation.respond({
          signal: abort.signal,
          onText: (d) => chunker.push(d).forEach(say),
          onToolStart: (name) => {
            const rest = chunker.flush();
            if (rest) say(rest);
            if (!this.spokeThisTurn && this.cfg.behaviour.fillerPhrase && !["end_call", "transfer_call"].includes(name)) say(this.cfg.behaviour.fillerPhrase);
          },
          onToolResult: (name, input, result, isError) => void addCallEvent(this.call, `tool.${name}`, { input, result, isError }),
        });
        if (res.interrupted) return;
        const rest = chunker.flush();
        if (rest) say(rest);
      } catch (e) {
        log.error("turn failed", { callId: this.call.id, error: errMsg(e) });
        void addCallEvent(this.call, "error", { error: errMsg(e) });
        say("Sorry, I'm having a little trouble on my end. Could you say that again?");
      }
      if (this.action && !abort.signal.aborted) await this.runAction();
    };
    const p = run();
    this.turn = p;
    void p.finally(() => {
      if (this.turn === p) this.turn = null;
    });
  }

  private async runAction() {
    const action = this.action;
    this.action = null;
    if (!action) return;
    await this.speaker.drain();
    await new Promise((r) => setTimeout(r, 400));
    const client = twilioClient();
    if (action.kind === "hangup") {
      await updateCall(this.call.id, { endedBy: "agent", reason: action.reason });
      void addCallEvent(this.call, "call.ended_by_agent", { reason: action.reason });
      await client.calls(this.callSid).update({ status: "completed" }).catch((e) => log.warn("hangup failed", { error: errMsg(e) }));
      return;
    }
    const t = action.target;
    const token = signToken({ callId: this.call.id }, 3600);
    const q = `callId=${encodeURIComponent(this.call.id)}&token=${encodeURIComponent(token)}`;
    const whisper = `${env.PUBLIC_BASE_URL}/twilio/whisper?${q}&reason=${encodeURIComponent(action.reason)}`;
    const callerId = this.call.direction === "outbound" ? this.call.fromNumber : this.call.toNumber;
    await updateCall(this.call.id, { transferredTo: t.number, endedBy: "transfer" });
    void addCallEvent(this.call, "transfer.started", { target: t.key, number: t.number, reason: action.reason });
    void emitEvent(this.call.tenantId, "transfer.started", { callId: this.call.id, target: t.key, number: t.number, reason: action.reason });
    await client
      .calls(this.callSid)
      .update({
        twiml: `<Response><Dial callerId="${escapeXml(callerId)}" timeout="25" answerOnBridge="true" action="${escapeXml(`${env.PUBLIC_BASE_URL}/twilio/transfer-result?${q}`)}"><Number url="${escapeXml(whisper)}">${escapeXml(t.number)}</Number></Dial></Response>`,
      })
      .catch((e) => log.error("transfer failed", { error: errMsg(e) }));
  }

  private startRecording() {
    twilioClient()
      .calls(this.callSid)
      .recordings.create({
        recordingChannels: "dual",
        recordingStatusCallback: `${env.PUBLIC_BASE_URL}/twilio/recording?callId=${encodeURIComponent(this.call.id)}`,
        recordingStatusCallbackEvent: ["completed"],
      })
      .then(() => addCallEvent(this.call, "recording.started"))
      .catch((e) => log.warn("could not start recording", { error: errMsg(e) }));
  }

  private startTimers() {
    const silenceMs = this.cfg.behaviour.silenceTimeoutSeconds * 1000;
    this.timers.push(
      setInterval(() => {
        if (this.stopped || this.turn || this.speaker.speaking || this.action) return;
        if (Date.now() - this.lastActivity < silenceMs) return;
        this.lastActivity = Date.now();
        this.nudges++;
        if (this.nudges === 1) {
          this.speaker.say("Are you still there?");
        } else {
          void addCallEvent(this.call, "silence_timeout");
          this.speaker.say("I'll let you go for now. Feel free to call back anytime. Bye!");
          this.action = { kind: "hangup", reason: "silence" };
          void this.runAction();
        }
      }, 1000),
    );
    this.timers.push(
      setTimeout(() => {
        void addCallEvent(this.call, "max_duration_reached");
        this.conversation.addUser("[system: The call has reached its time limit. Politely wrap up in one or two sentences and call end_call.]");
        this.startTurn();
      }, this.cfg.behaviour.maxCallMinutes * 60_000),
    );
  }

  async onStop() {
    if (this.stopped) return;
    this.stopped = true;
    this.timers.forEach(clearTimeout);
    this.timers.forEach(clearInterval);
    this.turnAbort?.abort();
    this.speaker.stop();
    this.stt.close();
    const latest = await getCall(this.call.id);
    if (latest && !latest.endedBy) {
      await updateCall(this.call.id, { endedBy: "caller" });
      void addCallEvent(this.call, "call.ended_by_caller");
    }
  }
}
