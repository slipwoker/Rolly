import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

export type Db = pg.Pool;

export function createPool(url: string): Db {
  // Render's internal URLs are inside the private network; external URLs require TLS
  const external = /\.render\.com/.test(url) && !/sslmode=disable/.test(url);
  return new pg.Pool({ connectionString: url, max: 8, ...(external ? { ssl: { rejectUnauthorized: true } } : {}) });
}

export async function migrate(db: Db): Promise<string[]> {
  const dir = resolve(import.meta.dirname, "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  const client = await db.connect();
  try {
    await client.query("SELECT pg_advisory_lock(727001)");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      await client.query("BEGIN");
      try {
        await client.query(readFileSync(resolve(dir, f), "utf8"));
        await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [f]);
        await client.query("COMMIT");
        applied.push(f);
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(727001)").catch(() => {});
    client.release();
  }
  return applied;
}
