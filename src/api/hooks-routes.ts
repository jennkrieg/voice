import express, { type Request } from "express";
import { and, eq } from "drizzle-orm";
import { env } from "../env.js";
import { db, schema } from "../db/index.js";
import { safeEqual, decryptJson } from "../lib/crypto.js";
import { log, errMsg } from "../lib/log.js";
import { toE164 } from "../lib/phone.js";
import { upsertContact } from "../contacts.js";
import { enqueueCall } from "../dialer/dialer.js";
import { crmFromRow } from "../integrations/registry.js";
import { verifyHubSpotSignatureV3 } from "../integrations/crm/hubspot.js";

/** Read a value by trying several common field names / dotted paths. */
function pick(body: any, paths: string[]): string | undefined {
  for (const p of paths) {
    const v = p.split(".").reduce((o: any, k) => (o == null ? undefined : o[k]), body);
    if (v !== undefined && v !== null && v !== "") return typeof v === "object" && "value" in v ? String(v.value) : String(v);
  }
  return undefined;
}

const PHONE = ["phone", "phone_number", "phoneNumber", "Phone", "mobile", "mobilephone", "contact.phone", "properties.phone", "properties.mobilephone", "data.phone", "customData.phone"];
const FIRST = ["first_name", "firstName", "firstname", "First Name", "contact.first_name", "contact.firstName", "properties.firstname", "data.first_name", "full_name"];
const LAST = ["last_name", "lastName", "lastname", "Last Name", "contact.last_name", "contact.lastName", "properties.lastname", "data.last_name"];
const EMAIL = ["email", "Email", "contact.email", "properties.email", "data.email"];
const EXTERNAL_ID = ["contact_id", "contactId", "id", "objectId", "vid", "contact.id", "data.id"];
const TZ = ["timezone", "timeZone", "contact.timezone", "properties.hs_timezone"];

/**
 * Inbound triggers from a client's CRM or automation tool:
 *  - POST /hooks/:tenantId/contact     generic: GoHighLevel workflows, HubSpot workflows, Zapier, Make, n8n, Salesforce flows...
 *  - POST /hooks/:tenantId/hubspot     HubSpot app webhook subscriptions (contact.creation, contact.propertyChange)
 */
export function hooksRouter() {
  const r = express.Router();
  r.use(
    express.json({
      limit: "1mb",
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: string }).rawBody = buf.toString("utf8");
      },
    }),
  );

  async function tenantFor(req: Request) {
    const [t] = await db().select().from(schema.tenants).where(eq(schema.tenants.id, req.params.tenantId as string));
    return t ?? null;
  }

  r.post("/:tenantId/contact", async (req, res) => {
    const tenant = await tenantFor(req);
    const secret = req.header("X-Webhook-Secret") ?? String(req.query.secret ?? "");
    if (!tenant || !secret || !safeEqual(secret, tenant.webhookSecret)) return res.status(401).json({ error: "bad secret" });
    const body = req.body ?? {};
    const phone = toE164(pick(body, PHONE));
    if (!phone) return res.status(400).json({ error: "no valid phone number in payload" });
    let first = pick(body, FIRST);
    let last = pick(body, LAST);
    if (first && !last && first.includes(" ")) [first, last] = [first.split(" ")[0], first.split(" ").slice(1).join(" ")];
    const agentId = String(req.query.agentId ?? body.agent_id ?? body.agentId ?? "");
    const crmIntegrationId = req.query.crmIntegrationId ? String(req.query.crmIntegrationId) : undefined;
    const contact = await upsertContact(tenant.id, {
      phone,
      firstName: first,
      lastName: last,
      email: pick(body, EMAIL),
      timezone: pick(body, TZ),
      crmIntegrationId,
      crmExternalId: crmIntegrationId ? pick(body, EXTERNAL_ID) : undefined,
      fields: typeof body.fields === "object" && body.fields ? body.fields : {},
    });
    const action = String(req.query.action ?? body.action ?? "call");
    if (action !== "call" || !agentId) return res.json({ ok: true, contactId: contact.id, call: null });
    const result = await enqueueCall({ tenantId: tenant.id, agentId, contact, reason: String(body.reason ?? req.query.reason ?? "crm trigger") });
    res.json({ ok: true, contactId: contact.id, call: result });
  });

  r.post("/:tenantId/hubspot", async (req, res) => {
    const tenant = await tenantFor(req);
    if (!tenant) return res.sendStatus(404);
    const integrationId = String(req.query.integrationId ?? "");
    const agentId = String(req.query.agentId ?? "");
    const [row] = await db()
      .select()
      .from(schema.integrations)
      .where(and(eq(schema.integrations.id, integrationId), eq(schema.integrations.tenantId, tenant.id), eq(schema.integrations.kind, "hubspot")));
    if (!row) return res.status(404).json({ error: "hubspot integration not found" });
    const secrets = decryptJson<{ accessToken: string; clientSecret?: string }>(row.secretsEnc!);
    if (!secrets.clientSecret) return res.status(400).json({ error: "integration has no clientSecret for signature checks" });
    const ok = verifyHubSpotSignatureV3({
      clientSecret: secrets.clientSecret,
      method: req.method,
      uri: `${env.PUBLIC_BASE_URL}${req.originalUrl}`,
      rawBody: (req as Request & { rawBody?: string }).rawBody ?? "",
      timestamp: req.header("X-HubSpot-Request-Timestamp"),
      signature: req.header("X-HubSpot-Signature-v3"),
    });
    if (!ok) return res.status(401).json({ error: "bad signature" });
    res.sendStatus(204);

    const settings = row.settings as { callOnCreate?: boolean; callOnPropertyChange?: string[] };
    const events = Array.isArray(req.body) ? req.body : [];
    const crm = crmFromRow(row);
    for (const ev of events as { objectId: number; subscriptionType: string; propertyName?: string; propertyValue?: string }[]) {
      try {
        const shouldCall =
          (ev.subscriptionType === "contact.creation" && settings.callOnCreate !== false) ||
          (ev.subscriptionType === "contact.propertyChange" && !!ev.propertyName && (settings.callOnPropertyChange ?? []).includes(ev.propertyName));
        const remote = await crm.getContact(String(ev.objectId));
        const phone = toE164(remote?.phone);
        if (!remote || !phone) continue;
        const contact = await upsertContact(tenant.id, {
          phone,
          firstName: remote.firstName,
          lastName: remote.lastName,
          email: remote.email,
          timezone: (remote.fields.hs_timezone as string) || null,
          crmIntegrationId: row.id,
          crmExternalId: remote.externalId,
        });
        if (shouldCall && agentId) await enqueueCall({ tenantId: tenant.id, agentId, contact, reason: `hubspot ${ev.subscriptionType}${ev.propertyName ? `:${ev.propertyName}` : ""}` });
      } catch (e) {
        log.warn("hubspot event failed", { error: errMsg(e) });
      }
    }
  });

  return r;
}
