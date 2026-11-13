import type { SqlClient } from "../../db/migrations.js";
import {
  GENESIS_HASH,
  eventHash,
  toContent,
  verifyChain as verifyChainEvents,
  type AuditEvent,
  type AuditEventInput,
  type ChainResult,
  type FieldChange,
} from "./chain.js";

/** The caller's transaction (a pg client inside BEGIN ... COMMIT). */
export type Tx = SqlClient;

/** Raised when an audit record cannot be written; the caller's transaction must roll back (Req 18.9). */
export class AuditWriteError extends Error {
  readonly code = "AUDIT_WRITE_FAILED";
  constructor(cause: unknown) {
    super("The audit record could not be written; the operation was not performed.", { cause });
    this.name = "AuditWriteError";
  }
}

export interface Clock {
  now(): Date;
}

const systemClock: Clock = { now: () => new Date() };

/** Serializes appends so the chain has a single, gap-free linkage order. */
const CHAIN_LOCK_KEY = 7_266_001;

type Row = Record<string, unknown>;

function rowToEvent(r: Row): AuditEvent {
  const at = r["at"] instanceof Date ? r["at"] : new Date(String(r["at"]));
  const changes = typeof r["changes"] === "string" ? JSON.parse(r["changes"]) : r["changes"];
  return {
    seq: BigInt(String(r["seq"])),
    at: at.toISOString(),
    actor: String(r["actor"]),
    action: String(r["action"]),
    entityType: String(r["entity_type"]),
    entityId: String(r["entity_id"]),
    raffleId: r["raffle_id"] == null ? null : String(r["raffle_id"]),
    changes: (changes ?? []) as FieldChange[],
    prevHash: String(r["prev_hash"]),
    hash: String(r["hash"]),
  };
}

const COLUMNS = "seq, at, actor, action, entity_type, entity_id, raffle_id, changes, prev_hash, hash";

/**
 * Appends an event inside the caller's transaction. Any failure throws `AuditWriteError`, so the caller's
 * transaction rolls back and the audited operation does not take effect (fail closed, Req 18.9).
 */
export async function append(
  tx: Tx,
  input: AuditEventInput,
  clock: Clock = systemClock,
): Promise<AuditEvent> {
  try {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [CHAIN_LOCK_KEY]);
    const last = (await tx.query("SELECT seq, hash FROM audit_event ORDER BY seq DESC LIMIT 1")).rows[0];
    const prevHash = last ? String(last["hash"]) : GENESIS_HASH;
    const content = toContent(input, clock.now());
    const hash = eventHash(prevHash, content);
    const res = await tx.query(
      `INSERT INTO audit_event (at, actor, action, entity_type, entity_id, raffle_id, changes, prev_hash, hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9) RETURNING seq`,
      [
        content.at,
        content.actor,
        content.action,
        content.entityType,
        content.entityId,
        content.raffleId,
        JSON.stringify(content.changes),
        prevHash,
        hash,
      ],
    );
    const seq = res.rows[0]?.["seq"];
    if (seq === undefined) throw new Error("audit insert returned no row");
    return { ...content, seq: BigInt(String(seq)), prevHash, hash };
  } catch (e) {
    throw new AuditWriteError(e);
  }
}

/** Filters of an Admin audit search (Req 18.5). Dates are inclusive. */
export interface AuditQuery {
  raffleId?: string;
  userId?: string;
  eventType?: string;
  from?: Date;
  to?: Date;
  /** Defaults to 10,000, the size the 5-second target is specified for. */
  limit?: number;
}

/** Returns matching events by timestamp descending (ties by seq descending); empty array when none match. */
export async function search(db: SqlClient, q: AuditQuery = {}): Promise<AuditEvent[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  const add = (sql: (p: string) => string, v: unknown): void => {
    values.push(v);
    where.push(sql(`$${values.length}`));
  };
  if (q.raffleId !== undefined)
    add((p) => `(raffle_id = ${p} OR (entity_type = 'raffle' AND entity_id = ${p}))`, q.raffleId);
  if (q.userId !== undefined) add((p) => `actor = ${p}`, q.userId);
  if (q.eventType !== undefined) add((p) => `action = ${p}`, q.eventType);
  if (q.from !== undefined) add((p) => `at >= ${p}`, q.from?.toISOString());
  if (q.to !== undefined) add((p) => `at <= ${p}`, q.to?.toISOString());
  values.push(q.limit ?? 10_000);
  const sql = `SELECT ${COLUMNS} FROM audit_event ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY at DESC, seq DESC LIMIT $${values.length}`;
  return (await db.query(sql, values)).rows.map(rowToEvent);
}

export interface ChainReport {
  checked: number;
  result: ChainResult;
  /** seq of the first bad event, when verification fails. */
  firstBadSeq?: bigint;
}

/** Verifies the stored chain, optionally limited to an inclusive seq range. */
export async function verifyStoredChain(
  db: SqlClient,
  range: { fromSeq?: bigint; toSeq?: bigint } = {},
): Promise<ChainReport> {
  let expectedPrev = GENESIS_HASH;
  if (range.fromSeq !== undefined) {
    const before = (
      await db.query("SELECT hash FROM audit_event WHERE seq < $1 ORDER BY seq DESC LIMIT 1", [
        range.fromSeq.toString(),
      ])
    ).rows[0];
    if (before) expectedPrev = String(before["hash"]);
  }
  const values: unknown[] = [];
  const where: string[] = [];
  if (range.fromSeq !== undefined) {
    values.push(range.fromSeq.toString());
    where.push(`seq >= $${values.length}`);
  }
  if (range.toSeq !== undefined) {
    values.push(range.toSeq.toString());
    where.push(`seq <= $${values.length}`);
  }
  const rows = (
    await db.query(
      `SELECT ${COLUMNS} FROM audit_event ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq ASC`,
      values,
    )
  ).rows.map(rowToEvent);
  const result = verifyChainEvents(rows, expectedPrev);
  const report: ChainReport = { checked: rows.length, result };
  if (!result.ok) report.firstBadSeq = rows[result.firstBadIndex]?.seq as bigint;
  return report;
}

/**
 * Moves rejected update/delete attempts captured by the database trigger into the hash chain as new audit
 * events (Req 18.4). Call from a periodic job or after detecting tampering; runs inside `tx`.
 */
export async function recordRejectedAttempts(tx: Tx, clock: Clock = systemClock): Promise<number> {
  const pending = (
    await tx.query(
      `SELECT id, at, db_user, operation, target_seq FROM audit_rejected_attempt
       WHERE recorded_at IS NULL ORDER BY id FOR UPDATE SKIP LOCKED`,
    )
  ).rows;
  for (const r of pending) {
    const at = r["at"] instanceof Date ? r["at"] : new Date(String(r["at"]));
    await append(
      tx,
      {
        actor: String(r["db_user"]),
        action: "audit.rejected_attempt",
        entityType: "audit_event",
        entityId: r["target_seq"] == null ? "*" : String(r["target_seq"]),
        changes: [
          { field: "operation", old: null, new: String(r["operation"]) },
          { field: "attempted_at", old: null, new: at.toISOString() },
        ],
      },
      clock,
    );
    await tx.query("UPDATE audit_rejected_attempt SET recorded_at = now() WHERE id = $1", [String(r["id"])]);
  }
  return pending.length;
}
