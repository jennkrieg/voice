import { and, eq } from "drizzle-orm";
import { db, schema } from "./db/index.js";
import { log, errMsg } from "./lib/log.js";
import { getCall, updateCall, addCallEvent } from "./calls.js";
import { getContact } from "./contacts.js";
import { parseAgentConfig, fillTemplate, templateVars } from "./agents/config.js";
import { analyzeCall } from "./agents/analysis.js";
import { loadCrm } from "./integrations/registry.js";
import { emitEvent } from "./integrations/webhooks.js";
import { sendSms } from "./sms/send.js";
import { sendEmail } from "./email/send.js";
import { enqueueCall } from "./dialer/dialer.js";
import { forgetCall } from "./telephony/call-session.js";
import { env } from "./env.js";
import type { CallStatus } from "./db/schema.js";

const TWILIO_TO_STATUS: Record<string, CallStatus> = {
  completed: "completed",
  "no-answer": "no_answer",
  busy: "busy",
  failed: "failed",
  canceled: "canceled",
};

/**
 * Runs once when Twilio reports the call finished: final status, AI analysis + review,
 * CRM note and fields, automatic follow-ups, retries, and the call.completed webhook.
 */
export async function finalizeCall(callId: string, twilio: { CallStatus: string; CallDuration?: string; AnsweredBy?: string }) {
  const call = await getCall(callId);
  if (!call || call.finalized) return;
  // Claim finalisation (Twilio may retry the callback).
  const [claimed] = await db()
    .update(schema.calls)
    .set({ finalized: true })
    .where(and(eq(schema.calls.id, callId), eq(schema.calls.finalized, false)))
    .returning({ id: schema.calls.id });
  if (!claimed) return;
  forgetCall(callId);

  let status: CallStatus = call.status === "voicemail" ? "voicemail" : (TWILIO_TO_STATUS[twilio.CallStatus] ?? "completed");
  const duration = Number(twilio.CallDuration ?? 0) || null;
  const callerSpoke = call.transcript.some((t) => t.role === "caller");
  if (status === "completed" && twilio.AnsweredBy?.startsWith("machine") && !callerSpoke) status = "voicemail";
  await updateCall(callId, { status, durationSeconds: duration, endedAt: new Date(), answeredBy: twilio.AnsweredBy ?? call.answeredBy });
  await addCallEvent(call, "call.completed", { status, duration });

  const [agent] = await db().select().from(schema.agents).where(eq(schema.agents.id, call.agentId));
  if (!agent) return;
  const cfg = parseAgentConfig(agent.config);
  const contact = call.contactId ? await getContact(call.tenantId, call.contactId) : null;

  // Retry unanswered outbound calls.
  if (call.direction === "outbound" && ["no_answer", "busy", "voicemail"].includes(status) && contact && call.attempt < cfg.dialer.maxAttempts) {
    const r = await enqueueCall({
      tenantId: call.tenantId,
      agentId: call.agentId,
      contact,
      reason: `retry after ${status}`,
      attempt: call.attempt + 1,
      notBefore: new Date(Date.now() + cfg.dialer.retryAfterMinutes * 60_000),
    });
    await addCallEvent(call, "call.retry_scheduled", r);
  }

  // Missed inbound call text-back.
  if (call.direction === "inbound" && !callerSpoke && cfg.sms.missedCallText && contact && !contact.doNotText && env.TWILIO_ACCOUNT_SID) {
    await sendSms({ tenantId: call.tenantId, agentId: call.agentId, contactId: contact.id, callId, from: call.toNumber, to: contact.phone, body: fillTemplate(cfg.sms.missedCallText, templateVars(cfg, contact)) }).catch(
      (e) => log.warn("missed-call text failed", { error: errMsg(e) }),
    );
  }

  const fresh = (await getCall(callId))!;
  let analysis = null;
  if (callerSpoke && (cfg.behaviour.reviewCalls || cfg.followUp.autoAfterCall.sms || cfg.followUp.autoAfterCall.email || cfg.crm.logCalls)) {
    try {
      analysis = await analyzeCall({
        cfg,
        transcript: fresh.transcript,
        direction: fresh.direction,
        booked: fresh.booked,
        transferred: !!fresh.transferredTo,
        endedBy: fresh.endedBy,
      });
      await updateCall(callId, {
        summary: analysis.summary,
        outcome: analysis.outcome,
        analysis,
        review: cfg.behaviour.reviewCalls ? analysis.review : null,
      });
      await addCallEvent(call, "call.analyzed", { outcome: analysis.outcome, score: analysis.review.score });
    } catch (e) {
      log.error("call analysis failed", { callId, error: errMsg(e) });
    }
  } else {
    await updateCall(callId, { outcome: status === "completed" ? "no_conversation" : status });
  }

  // CRM sync.
  const crm = await loadCrm(call.tenantId, cfg.crm.integrationId).catch(() => null);
  if (crm && contact?.crmExternalId) {
    const outcome = analysis?.outcome ?? status;
    try {
      if (cfg.crm.logCalls) {
        const lines = [
          `AI ${call.direction} call (${outcome})`,
          duration ? `Duration: ${Math.round(duration / 60)} min` : "",
          fresh.booked ? "Appointment booked" : "",
          fresh.transferredTo ? `Transferred to ${fresh.transferredTo}` : "",
          analysis?.summary ? `\n${analysis.summary}` : "",
          fresh.recordingUrl ? `\nRecording: ${env.PUBLIC_BASE_URL}/api/calls/${callId}/recording` : "",
        ];
        await crm.crm.addNote(contact.crmExternalId, lines.filter(Boolean).join("\n"));
      }
      const fields: Record<string, string> = {};
      if (cfg.crm.outcomeField) fields[cfg.crm.outcomeField] = outcome;
      if (cfg.crm.summaryField && analysis?.summary) fields[cfg.crm.summaryField] = analysis.summary;
      if (Object.keys(fields).length) await crm.crm.updateContact(contact.crmExternalId, fields);
    } catch (e) {
      log.warn("CRM call sync failed", { callId, error: errMsg(e) });
    }
  }

  // Automatic AI-written follow-ups.
  const updatedContact = contact ? await getContact(call.tenantId, contact.id) : null;
  if (analysis?.follow_up_needed && updatedContact) {
    const agentNumber = call.direction === "outbound" ? call.fromNumber : call.toNumber;
    if (cfg.followUp.autoAfterCall.sms && analysis.follow_up_sms && !updatedContact.doNotText && env.TWILIO_ACCOUNT_SID) {
      await sendSms({ tenantId: call.tenantId, agentId: call.agentId, contactId: updatedContact.id, callId, from: agentNumber, to: updatedContact.phone, body: analysis.follow_up_sms })
        .then(() => addCallEvent(call, "follow_up.sms_sent"))
        .catch((e) => log.warn("follow-up sms failed", { error: errMsg(e) }));
    }
    if (cfg.followUp.autoAfterCall.email && cfg.followUp.emailIntegrationId && updatedContact.email && analysis.follow_up_email_body && !updatedContact.doNotText) {
      await sendEmail({
        tenantId: call.tenantId,
        integrationId: cfg.followUp.emailIntegrationId,
        agentId: call.agentId,
        contactId: updatedContact.id,
        callId,
        to: updatedContact.email,
        subject: analysis.follow_up_email_subject || `Following up from ${cfg.businessName}`,
        text: analysis.follow_up_email_body,
        assets: cfg.followUp.assets.filter((a) => analysis.follow_up_resources.includes(a.key)),
      })
        .then(() => addCallEvent(call, "follow_up.email_sent"))
        .catch((e) => log.warn("follow-up email failed", { error: errMsg(e) }));
    }
  }

  const final = (await getCall(callId))!;
  await emitEvent(call.tenantId, "call.completed", {
    callId,
    agentId: call.agentId,
    direction: call.direction,
    status: final.status,
    outcome: final.outcome,
    successful: analysis?.successful ?? null,
    booked: final.booked,
    transferredTo: final.transferredTo,
    endedBy: final.endedBy,
    durationSeconds: final.durationSeconds,
    summary: final.summary,
    reviewScore: analysis?.review.score ?? null,
    contact: updatedContact
      ? { id: updatedContact.id, phone: updatedContact.phone, firstName: updatedContact.firstName, lastName: updatedContact.lastName, email: updatedContact.email, crmExternalId: updatedContact.crmExternalId }
      : null,
    recordingUrl: final.recordingUrl ? `${env.PUBLIC_BASE_URL}/api/calls/${callId}/recording` : null,
    transcript: final.transcript,
  });
}
