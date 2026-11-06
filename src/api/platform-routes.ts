import express from "express";
import { z } from "zod";
import { eq, desc, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { newId, newSecret, sha256Hex } from "../lib/crypto.js";
import { requirePlatformAdmin, h } from "./auth.js";
import { createUser, publicUser } from "../users.js";

/** For you, the platform owner: create and manage client accounts. */
export function platformRouter() {
  const r = express.Router();
  r.use(express.json());
  r.use(requirePlatformAdmin);

  r.post(
    "/tenants",
    h(async (req, res) => {
      const body = z
        .object({
          name: z.string().min(1),
          timezone: z.string().default("America/New_York"),
          owner: z.object({ email: z.string().email(), name: z.string().optional() }).optional(),
        })
        .parse(req.body);
      const apiKey = newSecret("vk_live_", 32);
      const [t] = await db()
        .insert(schema.tenants)
        .values({ id: newId("ten"), name: body.name, timezone: body.timezone, apiKeyHash: sha256Hex(apiKey), webhookSecret: newSecret("whs_", 24) })
        .returning();
      let owner: { email: string; temporaryPassword?: string } | null = null;
      if (body.owner) {
        try {
          const created = await createUser({ email: body.owner.email, name: body.owner.name, role: "owner", tenantId: t.id });
          owner = { email: created.user.email, temporaryPassword: created.temporaryPassword };
        } catch (e) {
          await db().delete(schema.tenants).where(eq(schema.tenants.id, t.id));
          throw e;
        }
      }
      res.status(201).json({ tenant: { id: t.id, name: t.name, timezone: t.timezone }, apiKey, owner, note: "Store the apiKey and temporary password now; they can't be shown again." });
    }),
  );

  r.get(
    "/tenants",
    h(async (_req, res) => {
      const t = schema.tenants;
      const rows = await db()
        .select({
          id: t.id,
          name: t.name,
          timezone: t.timezone,
          createdAt: t.createdAt,
          agents: sql<number>`(select count(*)::int from agents a where a.tenant_id = ${t.id})`,
          numbers: sql<number>`(select count(*)::int from phone_numbers n where n.tenant_id = ${t.id})`,
          calls30d: sql<number>`(select count(*)::int from calls c where c.tenant_id = ${t.id} and c.created_at > now() - interval '30 days')`,
          minutes30d: sql<number>`(select coalesce(ceil(sum(c.duration_seconds) / 60.0), 0)::int from calls c where c.tenant_id = ${t.id} and c.created_at > now() - interval '30 days')`,
          booked30d: sql<number>`(select count(*)::int from calls c where c.tenant_id = ${t.id} and c.booked and c.created_at > now() - interval '30 days')`,
          lastCallAt: sql<string | null>`(select max(c.created_at) from calls c where c.tenant_id = ${t.id})`,
        })
        .from(t)
        .orderBy(desc(t.createdAt));
      res.json({ tenants: rows });
    }),
  );

  r.post(
    "/tenants/:id/rotate-key",
    h(async (req, res) => {
      const apiKey = newSecret("vk_live_", 32);
      const [t] = await db().update(schema.tenants).set({ apiKeyHash: sha256Hex(apiKey) }).where(eq(schema.tenants.id, req.params.id as string)).returning();
      if (!t) return res.status(404).json({ error: "not found" });
      res.json({ apiKey });
    }),
  );

  r.get(
    "/users",
    h(async (_req, res) => {
      const rows = await db().select().from(schema.users).where(eq(schema.users.role, "platform_admin"));
      res.json({ users: rows.map(publicUser) });
    }),
  );
  r.post(
    "/users",
    h(async (req, res) => {
      const body = z.object({ email: z.string().email(), name: z.string().optional() }).parse(req.body);
      const { user, temporaryPassword } = await createUser({ ...body, role: "platform_admin", tenantId: null });
      res.status(201).json({ user: publicUser(user), temporaryPassword });
    }),
  );

  r.delete(
    "/tenants/:id",
    h(async (req, res) => {
      await db().delete(schema.tenants).where(eq(schema.tenants.id, req.params.id as string));
      res.sendStatus(204);
    }),
  );
  return r;
}
