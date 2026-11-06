import { pgTable, text, timestamp, jsonb, boolean, integer, index, uniqueIndex } from "drizzle-orm/pg-core";

/** A tenant is one of your clients (a business you sell the agent to). */
export const tenants = pgTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("America/New_York"),
  apiKeyHash: text("api_key_hash").notNull(),
  /** Shared secret CRMs send when they call our inbound webhook for this tenant. */
  webhookSecret: text("webhook_secret").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UserRole = "platform_admin" | "owner" | "member";

/** People who log in to the dashboard. Platform admins (you) have no tenant. */
export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    name: text("name"),
    passwordHash: text("password_hash").notNull(),
    role: text("role").$type<UserRole>().notNull(),
    /** Bumped on password change / "log out everywhere" to invalidate old sessions. */
    sessionVersion: integer("session_version").notNull().default(1),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_email_idx").on(t.email)],
);

export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** AgentConfig (see src/agents/config.ts). */
    config: jsonb("config").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agents_tenant_idx").on(t.tenantId)],
);

export const phoneNumbers = pgTable(
  "phone_numbers",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
    e164: text("e164").notNull(),
    twilioSid: text("twilio_sid").notNull(),
    friendlyName: text("friendly_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("phone_numbers_e164_idx").on(t.e164)],
);

export type IntegrationKind = "google_calendar" | "calcom" | "hubspot" | "gohighlevel" | "webhook" | "email_smtp";

export const integrations = pgTable(
  "integrations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    kind: text("kind").$type<IntegrationKind>().notNull(),
    label: text("label"),
    /** Non-secret settings (calendar id, event type id, location id, webhook url...). */
    settings: jsonb("settings").notNull().default({}),
    /** Encrypted JSON blob with tokens / API keys. Never returned by the API. */
    secretsEnc: text("secrets_enc"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("integrations_tenant_idx").on(t.tenantId)],
);

/** Local mirror of contacts the agent talks to. The client's CRM stays the source of truth. */
export const contacts = pgTable(
  "contacts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    phone: text("phone").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    email: text("email"),
    timezone: text("timezone"),
    /** CRM record this contact maps to. */
    crmIntegrationId: text("crm_integration_id"),
    crmExternalId: text("crm_external_id"),
    fields: jsonb("fields").notNull().default({}),
    doNotCall: boolean("do_not_call").notNull().default(false),
    doNotText: boolean("do_not_text").notNull().default(false),
    lastCallAt: timestamp("last_call_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("contacts_tenant_phone_idx").on(t.tenantId, t.phone)],
);

export type CallStatus =
  | "queued"
  | "dialing"
  | "in_progress"
  | "completed"
  | "no_answer"
  | "busy"
  | "failed"
  | "voicemail"
  | "canceled"
  | "skipped";

export type TranscriptEntry = { role: "agent" | "caller" | "event"; text: string; at: string };

export const calls = pgTable(
  "calls",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    contactId: text("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    direction: text("direction").$type<"inbound" | "outbound">().notNull(),
    fromNumber: text("from_number").notNull(),
    toNumber: text("to_number").notNull(),
    status: text("status").$type<CallStatus>().notNull(),
    twilioCallSid: text("twilio_call_sid"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    attempt: integer("attempt").notNull().default(1),
    reason: text("reason"),
    answeredBy: text("answered_by"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationSeconds: integer("duration_seconds"),
    transcript: jsonb("transcript").$type<TranscriptEntry[]>().notNull().default([]),
    summary: text("summary"),
    outcome: text("outcome"),
    analysis: jsonb("analysis"),
    recordingUrl: text("recording_url"),
    transferredTo: text("transferred_to"),
    /** Who ended the call: agent | caller | transfer | system | unknown. */
    endedBy: text("ended_by"),
    booked: boolean("booked").notNull().default(false),
    /** AI review of the call: score, what went well, what to improve. */
    review: jsonb("review"),
    finalized: boolean("finalized").notNull().default(false),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("calls_tenant_idx").on(t.tenantId, t.createdAt),
    index("calls_queue_idx").on(t.status, t.scheduledFor),
    uniqueIndex("calls_twilio_sid_idx").on(t.twilioCallSid),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
    contactId: text("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    channel: text("channel").$type<"sms" | "email">().notNull().default("sms"),
    direction: text("direction").$type<"inbound" | "outbound">().notNull(),
    fromNumber: text("from_number").notNull(),
    toNumber: text("to_number").notNull(),
    subject: text("subject"),
    body: text("body").notNull(),
    callId: text("call_id"),
    twilioSid: text("twilio_sid"),
    status: text("status"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("messages_thread_idx").on(t.tenantId, t.contactId, t.createdAt)],
);

/** Timeline of everything that happened on a call (for analytics and debugging). */
export const callEvents = pgTable(
  "call_events",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    callId: text("call_id").notNull().references(() => calls.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    data: jsonb("data").notNull().default({}),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("call_events_call_idx").on(t.callId, t.at), index("call_events_type_idx").on(t.tenantId, t.type, t.at)],
);

/** AI coaching reports across many calls. */
export const insightReports = pgTable(
  "insight_reports",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    agentId: text("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    callCount: integer("call_count").notNull(),
    report: jsonb("report").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("insight_reports_tenant_idx").on(t.tenantId, t.createdAt)],
);

export type Tenant = typeof tenants.$inferSelect;
export type User = typeof users.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type PhoneNumberRow = typeof phoneNumbers.$inferSelect;
export type IntegrationRow = typeof integrations.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type CallRow = typeof calls.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type CallEvent = typeof callEvents.$inferSelect;
export type InsightReport = typeof insightReports.$inferSelect;
