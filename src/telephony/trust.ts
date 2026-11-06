import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { PhoneNumberRow, Tenant, TenantSettings } from "../db/schema.js";
import { twilioClient } from "./twilio-client.js";
import { log, errMsg } from "../lib/log.js";

type TrustKey = keyof NonNullable<TenantSettings["trustHub"]>;

export const TRUST_LABELS: Record<TrustKey, string> = {
  customerProfileSid: "Business Profile",
  shakenStirSid: "SHAKEN/STIR (verified calls)",
  cnamSid: "CNAM (business name on caller ID)",
  voiceIntegritySid: "Voice Integrity (spam-label remediation)",
  brandedCallingSid: "Branded Calling",
};

/**
 * Attach a phone number to each of the tenant's approved Trust Hub products, so its calls are
 * signed with A-level STIR/SHAKEN attestation, show the business name (CNAM), and are registered
 * with the carriers' spam-analytics engines (Voice Integrity). Safe to call repeatedly.
 */
export async function registerNumberWithTrustHub(tenant: Tenant, num: PhoneNumberRow) {
  const th = tenant.settings?.trustHub ?? {};
  const client = twilioClient();
  const results: PhoneNumberRow["trust"] = { ...(num.trust ?? {}) };
  for (const key of Object.keys(TRUST_LABELS) as TrustKey[]) {
    const sid = th[key];
    if (!sid) continue;
    if (results[key]?.ok && (results[key] as { sid?: string }).sid === sid) continue;
    try {
      const params = { channelEndpointType: "phone-number", channelEndpointSid: num.twilioSid };
      if (key === "customerProfileSid") await client.trusthub.v1.customerProfiles(sid).customerProfilesChannelEndpointAssignment.create(params);
      else await client.trusthub.v1.trustProducts(sid).trustProductsChannelEndpointAssignment.create(params);
      results[key] = { ok: true, at: new Date().toISOString(), ...({ sid } as object) };
    } catch (e) {
      const msg = errMsg(e);
      // Already assigned counts as success.
      const ok = /already/i.test(msg);
      results[key] = { ok, ...(ok ? {} : { error: msg.slice(0, 200) }), at: new Date().toISOString(), ...({ sid } as object) };
      if (!ok) log.warn("trust hub assignment failed", { number: num.e164, product: key, error: msg });
    }
  }
  await db().update(schema.phoneNumbers).set({ trust: results }).where(eq(schema.phoneNumbers.id, num.id));
  return results;
}

export async function trustProductStatuses(tenant: Tenant) {
  const th = tenant.settings?.trustHub ?? {};
  const client = twilioClient();
  const out: Record<string, { sid: string; label: string; status: string; name?: string; error?: string }> = {};
  for (const key of Object.keys(TRUST_LABELS) as TrustKey[]) {
    const sid = th[key];
    if (!sid) continue;
    try {
      const r = key === "customerProfileSid" ? await client.trusthub.v1.customerProfiles(sid).fetch() : await client.trusthub.v1.trustProducts(sid).fetch();
      out[key] = { sid, label: TRUST_LABELS[key], status: r.status, name: r.friendlyName };
    } catch (e) {
      out[key] = { sid, label: TRUST_LABELS[key], status: "error", error: errMsg(e).slice(0, 200) };
    }
  }
  return out;
}
