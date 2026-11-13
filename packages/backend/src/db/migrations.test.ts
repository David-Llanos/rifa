import { describe, expect, it } from "vitest";
import { loadMigrations, migrate, type SqlClient } from "./migrations.js";

const sql = loadMigrations()
  .map((m) => m.sql)
  .join("\n");

const tableBody = (name: string): string => {
  const m = new RegExp(`CREATE TABLE ${name} \\(([\\s\\S]*?)\\n\\);`).exec(sql);
  if (!m) throw new Error(`table ${name} not found`);
  return m[1] ?? "";
};

describe("initial schema", () => {
  it("defines every required table", () => {
    for (const t of [
      '"user"',
      "raffle",
      "ticket",
      '"order"',
      "payment",
      "refund",
      "draw",
      "payout",
      "audit_event",
      "notification",
      "ruleset_version",
      "kyc_record",
      "support_case",
      "job",
    ]) {
      expect(() => tableBody(t)).not.toThrow();
    }
  });

  it("enforces unique ticket numbers per raffle and a status check", () => {
    const t = tableBody("ticket");
    expect(t).toMatch(/UNIQUE \(raffle_id, number\)/);
    expect(t).toMatch(/status IN \('available', 'reserved', 'sold', 'cancelled'\)/);
  });

  it("enforces unique provider references and uses bigint money", () => {
    expect(tableBody("payment")).toMatch(/UNIQUE \(provider, provider_reference\)/);
    expect(tableBody("payment")).toMatch(/amount_minor\s+bigint/);
    expect(tableBody("raffle")).toMatch(/ticket_price_minor\s+bigint/);
  });

  it("enforces the job unique key", () => {
    expect(tableBody("job")).toMatch(/UNIQUE \(job_type, entity_id, occurrence\)/);
  });

  it("has no card data columns", () => {
    expect(sql).not.toMatch(/\b(card_number|pan|cvv|cvc|card_cvv|expiry_month|expiry_year)\b/i);
  });
});

describe("migrate", () => {
  it("applies pending migrations once, in order", async () => {
    const log: string[] = [];
    const applied = new Set<string>();
    const client: SqlClient = {
      async query(text, values) {
        log.push(text.trim().split(/\s+/).slice(0, 2).join(" "));
        if (text.startsWith("INSERT INTO schema_migration")) applied.add(String(values?.[0]));
        if (text.startsWith("SELECT name")) return { rows: [...applied].map((name) => ({ name })) };
        return { rows: [] };
      },
    };
    const first = await migrate(client);
    expect(first).toEqual(loadMigrations().map((m) => m.name));
    expect(await migrate(client)).toEqual([]);
    expect(log).toContain("BEGIN");
    expect(log).toContain("COMMIT");
  });
});
