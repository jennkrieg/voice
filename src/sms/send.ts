import { env } from "../env.js";
import { db, schema } from "../db/index.js";
import { newId } from "../lib/crypto.js";
import { twilioClient } from "../telephony/twilio-client.js";
import { emitEvent } from "../integrations/webhooks.js";

export async function sendSms(opts: {
  tenantId: string;
  agentId?: string | null;
  contactId?: string | null;
  callId?: string | null;
  from: string;
  to: string;
  body: string;
}) {
  const msg = await twilioClient().messages.create({
    from: opts.from,
    to: opts.to,
    body: opts.body,
    statusCallback: `${env.PUBLIC_BASE_URL}/twilio/sms/status`,
  });
  const [row] = await db()
    .insert(schema.messages)
    .values({
      id: newId("msg"),
      tenantId: opts.tenantId,
      agentId: opts.agentId ?? null,
      contactId: opts.contactId ?? null,
      callId: opts.callId ?? null,
      channel: "sms",
      direction: "outbound",
      fromNumber: opts.from,
      toNumber: opts.to,
      body: opts.body,
      twilioSid: msg.sid,
      status: msg.status,
    })
    .returning();
  void emitEvent(opts.tenantId, "sms.sent", { messageId: row.id, to: opts.to, body: opts.body, contactId: opts.contactId });
  return row;
}
