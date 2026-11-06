import express from "express";
import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { newId, newSecret, sha256Hex } from "../lib/crypto.js";
import { requirePlatformAdmin, h } from "./auth.js";

/** For you, the platform owner: create and manage client accounts. */
export function platformRouter() {
  const r = express.Router();
  r.use(express.json());
  r.use(requirePlatformAdmin);

  r.post(
    "/tenants",
    h(async (req, res) => {
      const body = z.object({ name: z.string().min(1), timezone: z.string().default("America/New_York") }).parse(req.body);
      const apiKey = newSecret("vk_live_", 32);
      const [t] = await db()
        .insert(schema.tenants)
        .values({ id: newId("ten"), name: body.name, timezone: body.timezone, apiKeyHash: sha256Hex(apiKey), webhookSecret: newSecret("whs_", 24) })
        .returning();
      res.status(201).json({ tenant: { id: t.id, name: t.name, timezone: t.timezone }, apiKey, note: "Store the apiKey now; it can't be shown again." });
    }),
  );

  r.get(
    "/tenants",
    h(async (_req, res) => {
      const rows = await db()
        .select({ id: schema.tenants.id, name: schema.tenants.name, timezone: schema.tenants.timezone, createdAt: schema.tenants.createdAt })
        .from(schema.tenants)
        .orderBy(desc(schema.tenants.createdAt));
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

  r.delete(
    "/tenants/:id",
    h(async (req, res) => {
      await db().delete(schema.tenants).where(eq(schema.tenants.id, req.params.id as string));
      res.sendStatus(204);
    }),
  );
  return r;
}
