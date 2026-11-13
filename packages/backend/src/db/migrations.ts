import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Migration {
  /** File name, e.g. `0001_initial_schema.sql`. Sorted lexicographically. */
  name: string;
  sql: string;
}

/** Minimal client surface so any pg-compatible driver can be passed in. */
export interface SqlClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations",
);

/** Loads migration files in order. */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

/** Applies pending migrations, each in its own transaction, recording them in `schema_migration`. */
export async function migrate(
  client: SqlClient,
  migrations: Migration[] = loadMigrations(),
): Promise<string[]> {
  await client.query(
    "CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const done = new Set(
    (await client.query("SELECT name FROM schema_migration")).rows.map((r) => String(r["name"])),
  );
  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.name)) continue;
    await client.query("BEGIN");
    try {
      await client.query(m.sql);
      await client.query("INSERT INTO schema_migration (name) VALUES ($1)", [m.name]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
    applied.push(m.name);
  }
  return applied;
}
