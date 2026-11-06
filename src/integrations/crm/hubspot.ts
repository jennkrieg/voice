import crypto from "node:crypto";
import { CrmError, type CrmContact, type CrmProvider } from "./types.js";

const BASE = "https://api.hubapi.com";
const PROPS = ["firstname", "lastname", "email", "phone", "mobilephone", "hs_timezone"];
const CANONICAL_TO_HUBSPOT: Record<string, string> = {
  first_name: "firstname",
  last_name: "lastname",
  email: "email",
  phone: "phone",
};
// HubSpot-defined association type for note -> contact.
const NOTE_TO_CONTACT = 202;

type HsObject = { id: string; properties: Record<string, string | null> };

/** HubSpot via a private app access token (scopes: crm.objects.contacts.read, crm.objects.contacts.write). */
export class HubSpotCrm implements CrmProvider {
  kind = "hubspot" as const;
  constructor(private secrets: { accessToken: string }) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.secrets.accessToken}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 404) return null;
    const text = await res.text();
    if (!res.ok) throw new CrmError("HubSpot", res.status, text.slice(0, 300));
    return text ? (JSON.parse(text) as T) : null;
  }

  private toContact(o: HsObject): CrmContact {
    const p = o.properties;
    return {
      externalId: o.id,
      phone: p.phone ?? p.mobilephone ?? null,
      firstName: p.firstname,
      lastName: p.lastname,
      email: p.email,
      fields: p,
    };
  }

  async getContact(id: string) {
    const o = await this.req<HsObject>("GET", `/crm/v3/objects/contacts/${encodeURIComponent(id)}?properties=${PROPS.join(",")}`);
    return o ? this.toContact(o) : null;
  }

  async findByPhone(phone: string) {
    const digits = phone.replace(/\D/g, "");
    const variants = [...new Set([phone, digits, digits.slice(-10)])];
    const r = await this.req<{ results: HsObject[] }>("POST", "/crm/v3/objects/contacts/search", {
      // Each filterGroup is OR'd together.
      filterGroups: variants.flatMap((v) => [
        { filters: [{ propertyName: "phone", operator: "EQ", value: v }] },
        { filters: [{ propertyName: "mobilephone", operator: "EQ", value: v }] },
      ]).slice(0, 5),
      properties: PROPS,
      limit: 1,
    });
    const hit = r?.results?.[0];
    return hit ? this.toContact(hit) : null;
  }

  async createContact(input: { phone: string; firstName?: string; lastName?: string; email?: string }) {
    const o = await this.req<HsObject>("POST", "/crm/v3/objects/contacts", {
      properties: { phone: input.phone, firstname: input.firstName, lastname: input.lastName, email: input.email },
    });
    return this.toContact(o!);
  }

  async updateContact(id: string, fields: Record<string, string>) {
    const properties = Object.fromEntries(Object.entries(fields).map(([k, v]) => [CANONICAL_TO_HUBSPOT[k] ?? k, v]));
    await this.req("PATCH", `/crm/v3/objects/contacts/${encodeURIComponent(id)}`, { properties });
  }

  async addNote(id: string, body: string) {
    await this.req("POST", "/crm/v3/objects/notes", {
      properties: { hs_timestamp: new Date().toISOString(), hs_note_body: body.replace(/\n/g, "<br>") },
      associations: [{ to: { id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: NOTE_TO_CONTACT }] }],
    });
  }
}

/**
 * Verify HubSpot webhook signature v3:
 * base64(HMAC-SHA256(clientSecret, method + uri + body + timestamp)), timestamp within 5 minutes.
 */
export function verifyHubSpotSignatureV3(opts: {
  clientSecret: string;
  method: string;
  uri: string;
  rawBody: string;
  timestamp: string | undefined;
  signature: string | undefined;
  now?: number;
}): boolean {
  if (!opts.signature || !opts.timestamp) return false;
  const ts = Number(opts.timestamp);
  if (!Number.isFinite(ts) || Math.abs((opts.now ?? Date.now()) - ts) > 5 * 60 * 1000) return false;
  const expected = crypto
    .createHmac("sha256", opts.clientSecret)
    .update(opts.method.toUpperCase() + opts.uri + opts.rawBody + opts.timestamp)
    .digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(opts.signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
