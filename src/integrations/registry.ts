import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { decryptJson } from "../lib/crypto.js";
import type { IntegrationRow } from "../db/schema.js";
import type { CalendarProvider } from "./calendar/types.js";
import type { CrmProvider } from "./crm/types.js";
import { GoogleCalendarProvider } from "./calendar/google.js";
import { CalcomProvider } from "./calendar/calcom.js";
import { HubSpotCrm } from "./crm/hubspot.js";
import { GoHighLevelCrm } from "./crm/gohighlevel.js";

export async function getIntegration(tenantId: string, id: string): Promise<IntegrationRow | null> {
  const [row] = await db()
    .select()
    .from(schema.integrations)
    .where(and(eq(schema.integrations.tenantId, tenantId), eq(schema.integrations.id, id)));
  return row ?? null;
}

function secretsOf<T>(row: IntegrationRow): T {
  if (!row.secretsEnc) throw new Error(`Integration ${row.id} has no credentials`);
  return decryptJson<T>(row.secretsEnc);
}

export function calendarFromRow(row: IntegrationRow): CalendarProvider {
  const s = row.settings as Record<string, unknown>;
  switch (row.kind) {
    case "google_calendar":
      return new GoogleCalendarProvider(secretsOf(row), (s.calendarId as string) || "primary");
    case "calcom":
      return new CalcomProvider(secretsOf(row), s.eventTypeId as number | undefined);
    default:
      throw new Error(`Integration ${row.id} (${row.kind}) is not a calendar`);
  }
}

export function crmFromRow(row: IntegrationRow): CrmProvider {
  const s = row.settings as Record<string, unknown>;
  switch (row.kind) {
    case "hubspot":
      return new HubSpotCrm(secretsOf(row));
    case "gohighlevel":
      if (!s.locationId) throw new Error("GoHighLevel integration needs settings.locationId");
      return new GoHighLevelCrm(secretsOf(row), s.locationId as string);
    default:
      throw new Error(`Integration ${row.id} (${row.kind}) is not a CRM`);
  }
}

export async function loadCalendar(tenantId: string, integrationId?: string): Promise<CalendarProvider | null> {
  if (!integrationId) return null;
  const row = await getIntegration(tenantId, integrationId);
  return row ? calendarFromRow(row) : null;
}

export async function loadCrm(tenantId: string, integrationId?: string): Promise<{ id: string; crm: CrmProvider } | null> {
  if (!integrationId) return null;
  const row = await getIntegration(tenantId, integrationId);
  return row ? { id: row.id, crm: crmFromRow(row) } : null;
}
