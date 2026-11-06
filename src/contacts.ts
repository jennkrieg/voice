import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "./db/index.js";
import type { Contact } from "./db/schema.js";
import { newId } from "./lib/crypto.js";
import { log, errMsg } from "./lib/log.js";
import type { CrmProvider } from "./integrations/crm/types.js";

export interface ContactInput {
  phone: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  timezone?: string | null;
  crmIntegrationId?: string | null;
  crmExternalId?: string | null;
  fields?: Record<string, unknown>;
}

/** Insert or update the local contact, keyed by (tenant, phone). Only non-empty values overwrite. */
export async function upsertContact(tenantId: string, input: ContactInput): Promise<Contact> {
  const clean = <T>(v: T | null | undefined) => (v === "" || v === undefined ? null : v);
  const values = {
    id: newId("con"),
    tenantId,
    phone: input.phone,
    firstName: clean(input.firstName),
    lastName: clean(input.lastName),
    email: clean(input.email),
    timezone: clean(input.timezone),
    crmIntegrationId: clean(input.crmIntegrationId),
    crmExternalId: clean(input.crmExternalId),
    fields: input.fields ?? {},
  };
  const [row] = await db()
    .insert(schema.contacts)
    .values(values)
    .onConflictDoUpdate({
      target: [schema.contacts.tenantId, schema.contacts.phone],
      set: {
        firstName: sql`COALESCE(excluded.first_name, ${schema.contacts.firstName})`,
        lastName: sql`COALESCE(excluded.last_name, ${schema.contacts.lastName})`,
        email: sql`COALESCE(excluded.email, ${schema.contacts.email})`,
        timezone: sql`COALESCE(excluded.timezone, ${schema.contacts.timezone})`,
        crmIntegrationId: sql`COALESCE(excluded.crm_integration_id, ${schema.contacts.crmIntegrationId})`,
        crmExternalId: sql`COALESCE(excluded.crm_external_id, ${schema.contacts.crmExternalId})`,
        fields: sql`${schema.contacts.fields} || excluded.fields`,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  return row;
}

export async function getContact(tenantId: string, id: string): Promise<Contact | null> {
  const [row] = await db()
    .select()
    .from(schema.contacts)
    .where(and(eq(schema.contacts.tenantId, tenantId), eq(schema.contacts.id, id)));
  return row ?? null;
}

export async function findContactByPhone(tenantId: string, phone: string): Promise<Contact | null> {
  const [row] = await db()
    .select()
    .from(schema.contacts)
    .where(and(eq(schema.contacts.tenantId, tenantId), eq(schema.contacts.phone, phone)));
  return row ?? null;
}

/** Find a contact locally, then in the CRM; create a local record either way. */
export async function resolveContactByPhone(
  tenantId: string,
  phone: string,
  crm: { id: string; crm: CrmProvider } | null,
): Promise<Contact> {
  const local = await findContactByPhone(tenantId, phone);
  if (local?.crmExternalId || !crm) return local ?? upsertContact(tenantId, { phone });
  try {
    const remote = await crm.crm.findByPhone(phone);
    if (remote) {
      return upsertContact(tenantId, {
        phone,
        firstName: remote.firstName,
        lastName: remote.lastName,
        email: remote.email,
        crmIntegrationId: crm.id,
        crmExternalId: remote.externalId,
      });
    }
  } catch (e) {
    log.warn("CRM lookup failed", { tenantId, error: errMsg(e) });
  }
  return local ?? upsertContact(tenantId, { phone });
}

/** Apply field updates locally and push them to the CRM (creating the CRM record if needed). */
export async function applyContactUpdates(
  contact: Contact,
  updates: Record<string, string>,
  crm: { id: string; crm: CrmProvider } | null,
): Promise<Contact> {
  const patch: Partial<Contact> = { updatedAt: new Date() };
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(updates)) {
    if (k === "first_name") patch.firstName = v;
    else if (k === "last_name") patch.lastName = v;
    else if (k === "email") patch.email = v;
    else if (k === "do_not_call") patch.doNotCall = v === "true";
    else if (k === "do_not_text") patch.doNotText = v === "true";
    else extra[k] = v;
  }
  const [row] = await db()
    .update(schema.contacts)
    .set({ ...patch, fields: sql`${schema.contacts.fields} || ${JSON.stringify(extra)}::jsonb` })
    .where(eq(schema.contacts.id, contact.id))
    .returning();

  if (crm) {
    try {
      let externalId = row.crmExternalId;
      if (!externalId) {
        const created = await crm.crm.createContact({
          phone: row.phone,
          firstName: row.firstName ?? undefined,
          lastName: row.lastName ?? undefined,
          email: row.email ?? undefined,
        });
        externalId = created.externalId;
        await db()
          .update(schema.contacts)
          .set({ crmExternalId: externalId, crmIntegrationId: crm.id })
          .where(eq(schema.contacts.id, row.id));
      }
      const remoteUpdates = Object.fromEntries(
        Object.entries(updates).filter(([k]) => k !== "do_not_text"),
      );
      if (Object.keys(remoteUpdates).length) await crm.crm.updateContact(externalId, remoteUpdates);
    } catch (e) {
      log.warn("CRM update failed", { contactId: row.id, error: errMsg(e) });
    }
  }
  return row;
}
