import fs from "node:fs";
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema.js";
import { MIGRATIONS } from "./migrations.js";
import { log } from "../lib/log.js";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

let instance: Db | null = null;
let closer: (() => Promise<void>) | null = null;

/**
 * Connects to Postgres when DATABASE_URL is set, otherwise uses embedded PGlite
 * (Postgres compiled to WASM) in ./data/pglite, or in memory when url is "memory://".
 */
export async function initDb(url = process.env.DATABASE_URL): Promise<Db> {
  if (instance) return instance;
  if (url && !url.startsWith("memory://")) {
    const pg = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const pool = new pg.default.Pool({ connectionString: url });
    instance = drizzle(pool, { schema }) as unknown as Db;
    closer = () => pool.end();
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    let dataDir: string | undefined;
    if (!url) {
      fs.mkdirSync("./data", { recursive: true });
      dataDir = "./data/pglite";
      log.warn("DATABASE_URL not set: using embedded database in ./data/pglite (fine for dev, use Postgres in production)");
    }
    const client = new PGlite(dataDir);
    instance = drizzle(client, { schema }) as unknown as Db;
    closer = () => client.close();
  }
  for (const stmt of MIGRATIONS) await instance.execute(sql.raw(stmt));
  return instance;
}

export function db(): Db {
  if (!instance) throw new Error("Database not initialised; call initDb() first");
  return instance;
}

export async function closeDb() {
  await closer?.();
  instance = null;
  closer = null;
}

export { schema };
