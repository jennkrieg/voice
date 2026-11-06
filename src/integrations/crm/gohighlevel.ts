import { CrmError, type CrmContact, type CrmProvider } from "./types.js";

const BASE = "https://services.leadconnectorhq.com";
const VERSION = "2021-07-28";

type GhlContact = {
  id: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  customFields?: { id: string; key?: string; value?: unknown }[];
  [k: string]: unknown;
};

/** GoHighLevel API v2 via a sub-account Private Integration token (scopes: contacts.readonly, contacts.write). */
export class GoHighLevelCrm implements CrmProvider {
  kind = "gohighlevel" as const;
  constructor(
    private secrets: { token: string },
    private locationId: string,
  ) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.secrets.token}`,
        Version: VERSION,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 404) return null;
    const text = await res.text();
    if (!res.ok) throw new CrmError("GoHighLevel", res.status, text.slice(0, 300));
    return text ? (JSON.parse(text) as T) : null;
  }

  private toContact(c: GhlContact): CrmContact {
    return { externalId: c.id, phone: c.phone, firstName: c.firstName, lastName: c.lastName, email: c.email, fields: c };
  }

  async getContact(id: string) {
    const r = await this.req<{ contact: GhlContact }>("GET", `/contacts/${encodeURIComponent(id)}`);
    return r?.contact ? this.toContact(r.contact) : null;
  }

  async findByPhone(phone: string) {
    const q = new URLSearchParams({ locationId: this.locationId, number: phone });
    const r = await this.req<{ contact?: GhlContact | null }>("GET", `/contacts/search/duplicate?${q}`);
    return r?.contact ? this.toContact(r.contact) : null;
  }

  async createContact(input: { phone: string; firstName?: string; lastName?: string; email?: string }) {
    const r = await this.req<{ contact: GhlContact }>("POST", "/contacts/upsert", { locationId: this.locationId, ...input });
    return this.toContact(r!.contact);
  }

  async updateContact(id: string, fields: Record<string, string>) {
    const std: Record<string, string> = {};
    const custom: { key: string; field_value: string }[] = [];
    const map: Record<string, string> = { first_name: "firstName", last_name: "lastName", email: "email", phone: "phone" };
    for (const [k, v] of Object.entries(fields)) {
      if (map[k]) std[map[k]] = v;
      else if (["firstName", "lastName", "email", "phone", "companyName", "address1", "city", "state", "postalCode", "website"].includes(k)) std[k] = v;
      else custom.push({ key: k, field_value: v });
    }
    await this.req("PUT", `/contacts/${encodeURIComponent(id)}`, { ...std, ...(custom.length ? { customFields: custom } : {}) });
  }

  async addNote(id: string, body: string) {
    await this.req("POST", `/contacts/${encodeURIComponent(id)}/notes`, { body });
  }
}
