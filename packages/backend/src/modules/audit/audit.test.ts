import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, type SqlClient } from "../../db/migrations.js";
import {
  GENESIS_HASH,
  canonicalJson,
  eventHash,
  nextEvent,
  verifyChain,
  type AuditEvent,
  type AuditEventInput,
} from "./chain.js";
import { AuditWriteError, append } from "./service.js";

const input = (n: number): AuditEventInput => ({
  actor: `user-${n}`,
  action: "raffle.change",
  entityType: "raffle",
  entityId: `r-${n}`,
  changes: [{ field: "title", old: "a", new: `b${n}` }],
});

function build(n: number): AuditEvent[] {
  const out: AuditEvent[] = [];
  for (let i = 0; i < n; i++) out.push(nextEvent(out[i - 1], input(i), new Date(1_700_000_000_000 + i)));
  return out;
}

describe("hash chain", () => {
  it("canonical JSON ignores key order", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
  });

  it("verifies an intact chain and the empty chain", () => {
    expect(verifyChain([])).toEqual({ ok: true });
    expect(verifyChain(build(5))).toEqual({ ok: true });
    expect(build(1)[0]?.prevHash).toBe(GENESIS_HASH);
  });

  it("records UTC millisecond timestamps and old/new values", () => {
    const e = build(1)[0] as AuditEvent;
    expect(e.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(e.changes).toEqual([{ field: "title", old: "a", new: "b0" }]);
  });

  it("detects modification, removal and reordering", () => {
    const c = build(5);
    expect(verifyChain(c.map((e, i) => (i === 2 ? { ...e, actor: "evil" } : e)))).toEqual({ ok: false, firstBadIndex: 2 });
    expect(verifyChain([c[0], c[1], c[3], c[4]] as AuditEvent[])).toEqual({ ok: false, firstBadIndex: 2 });
    expect(verifyChain([c[0], c[2], c[1], c[3]] as AuditEvent[])).toMatchObject({ ok: false });
  });

  it("verifies a sub-range against the preceding hash", () => {
    const c = build(4);
    expect(verifyChain(c.slice(2), (c[1] as AuditEvent).hash)).toEqual({ ok: true });
  });

  it("hash depends on previous hash", () => {
    const c = build(1)[0] as AuditEvent;
    expect(eventHash("1".repeat(64), c)).not.toBe(c.hash);
  });
});

/** Tiny in-memory stand-in for the audit_event table, just enough for `append`. */
function fakeDb(failInsert = false): { db: SqlClient; rows: Record<string, unknown>[] } {
  const rows: Record<string, unknown>[] = [];
  const db: SqlClient = {
    async query(text, values = []) {
      if (text.startsWith("SELECT pg_advisory")) return { rows: [] };
      if (text.startsWith("SELECT seq, hash")) return { rows: rows.length ? [rows[rows.length - 1] as never] : [] };
      if (text.includes("INSERT INTO audit_event")) {
        if (failInsert) throw new Error("disk full");
        const row = { seq: rows.length + 1, prev_hash: values[7], hash: values[8], at: values[0] };
        rows.push(row);
        return { rows: [{ seq: row.seq }] };
      }
      throw new Error(`unexpected query ${text}`);
    },
  };
  return { db, rows };
}

describe("append", () => {
  it("links each event to the previous hash", async () => {
    const { db } = fakeDb();
    const clock = { now: () => new Date(1_700_000_000_000) };
    const a = await append(db, input(1), clock);
    const b = await append(db, input(2), clock);
    expect(a.prevHash).toBe(GENESIS_HASH);
    expect(b.prevHash).toBe(a.hash);
    expect(verifyChain([a, b])).toEqual({ ok: true });
  });

  it("fails closed with AuditWriteError when the write fails", async () => {
    const { db, rows } = fakeDb(true);
    await expect(append(db, input(1))).rejects.toBeInstanceOf(AuditWriteError);
    expect(rows).toHaveLength(0);
  });
});

describe("append-only migration", () => {
  const sql = readFileSync(join(MIGRATIONS_DIR, "0002_audit_append_only.sql"), "utf8");
  it("revokes changes, installs triggers and a 7-year retention policy", () => {
    expect(sql).toMatch(/REVOKE UPDATE, DELETE, TRUNCATE ON audit_event/);
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON audit_event/);
    expect(sql).toMatch(/BEFORE TRUNCATE ON audit_event/);
    expect(sql).toMatch(/INSERT INTO audit_rejected_attempt/);
    expect(sql).toMatch(/min_retention_years >= 7/);
  });
});
