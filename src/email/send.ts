import nodemailer from "nodemailer";
import { db, schema } from "../db/index.js";
import { decryptJson, newId } from "../lib/crypto.js";
import { getIntegration } from "../integrations/registry.js";
import type { AgentConfig } from "../agents/config.js";

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export interface SmtpSettings {
  host: string;
  port: number;
  secure?: boolean;
  user: string;
  fromEmail: string;
  fromName?: string;
  replyTo?: string;
}

/** Download a follow-up asset so it can be attached (falls back to a link if too big or unreachable). */
async function fetchAttachment(url: string, title: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`could not download ${url}: ${res.status}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_ATTACHMENT_BYTES) throw new Error("attachment too large");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_ATTACHMENT_BYTES) throw new Error("attachment too large");
  const fromUrl = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
  const filename = /\.\w{2,5}$/.test(fromUrl) ? fromUrl : `${title.replace(/[^\w\- ]+/g, "").trim() || "file"}.pdf`;
  return { filename, content: buf, contentType: res.headers.get("content-type") ?? undefined };
}

/**
 * Send an email through the tenant's SMTP integration (works with Google Workspace, Microsoft 365,
 * SendGrid, Postmark, Amazon SES, Resend, Mailgun... anything that offers SMTP).
 */
export async function sendEmail(opts: {
  tenantId: string;
  integrationId: string;
  agentId?: string | null;
  contactId?: string | null;
  callId?: string | null;
  to: string;
  subject: string;
  text: string;
  assets?: AgentConfig["followUp"]["assets"];
}) {
  const row = await getIntegration(opts.tenantId, opts.integrationId);
  if (!row || row.kind !== "email_smtp") throw new Error("Email integration not found");
  const s = row.settings as unknown as SmtpSettings;
  const { password } = decryptJson<{ password: string }>(row.secretsEnc!);
  const transport = nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.secure ?? s.port === 465,
    auth: { user: s.user, pass: password },
  });

  const attachments: { filename: string; content: Buffer; contentType?: string }[] = [];
  const links: string[] = [];
  for (const a of opts.assets ?? []) {
    if (a.attach) {
      try {
        attachments.push(await fetchAttachment(a.url, a.title));
        continue;
      } catch {
        // fall through to link
      }
    }
    links.push(`${a.title}: ${a.url}`);
  }
  const text = links.length ? `${opts.text}\n\n${links.join("\n")}` : opts.text;
  const info = await transport.sendMail({
    from: s.fromName ? `"${s.fromName.replace(/"/g, "")}" <${s.fromEmail}>` : s.fromEmail,
    replyTo: s.replyTo,
    to: opts.to,
    subject: opts.subject,
    text,
    attachments,
  });
  const [msg] = await db()
    .insert(schema.messages)
    .values({
      id: newId("msg"),
      tenantId: opts.tenantId,
      agentId: opts.agentId ?? null,
      contactId: opts.contactId ?? null,
      callId: opts.callId ?? null,
      channel: "email",
      direction: "outbound",
      fromNumber: s.fromEmail,
      toNumber: opts.to,
      subject: opts.subject,
      body: text,
      twilioSid: info.messageId,
      status: "sent",
    })
    .returning();
  return msg;
}
