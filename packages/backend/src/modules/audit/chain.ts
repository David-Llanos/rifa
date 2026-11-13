import { createHash } from "node:crypto";

/** One changed field with its prior and new value (Req 18.2). */
export interface FieldChange {
  field: string;
  old: unknown;
  new: unknown;
}

/** Caller-supplied event data. */
export interface AuditEventInput {
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  /** Optional raffle the event relates to, used by the raffle filter of `search`. */
  raffleId?: string | null;
  changes?: FieldChange[];
}

/** The part of an event covered by the hash. `at` is a UTC ISO string with millisecond precision. */
export interface AuditEventContent {
  at: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  raffleId: string | null;
  changes: FieldChange[];
}

export interface AuditEvent extends AuditEventContent {
  seq: bigint;
  prevHash: string;
  hash: string;
}

/** Hash of the virtual event before the first one. */
export const GENESIS_HASH = "0".repeat(64);

/** Minimum retention of audit events, in years (Req 18.7). Enforced by the append-only table. */
export const AUDIT_RETENTION_YEARS = 7;

/** Deterministic JSON: object keys sorted, `undefined` dropped (as in JSON), bigint as string. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") return JSON.stringify(value.toString());
    if (value instanceof Date) return JSON.stringify(value.toISOString());
    return JSON.stringify(value) ?? "null";
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const parts = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${parts.join(",")}}`;
}

/** Normalizes timestamps to UTC with millisecond precision. */
export function toUtcMillis(d: Date): string {
  return d.toISOString();
}

/** Builds the hashed content from input and a timestamp. */
export function toContent(input: AuditEventInput, at: Date): AuditEventContent {
  return {
    at: toUtcMillis(at),
    actor: input.actor,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    raffleId: input.raffleId ?? null,
    changes: (input.changes ?? []).map((c) => ({ field: c.field, old: c.old ?? null, new: c.new ?? null })),
  };
}

/** SHA-256 over the previous hash and the canonical JSON of the content (Req 18.8). */
export function eventHash(prevHash: string, e: AuditEventContent): string {
  const content: AuditEventContent = {
    at: e.at,
    actor: e.actor,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    raffleId: e.raffleId ?? null,
    changes: e.changes,
  };
  return createHash("sha256").update(prevHash).update("\n").update(canonicalJson(content)).digest("hex");
}

export type ChainResult = { ok: true } | { ok: false; firstBadIndex: number };

/**
 * Verifies events given in chain order (ascending seq). `expectedPrev` is the hash the first event must link
 * to: genesis for a full chain, or the hash of the event before a sub-range. Modification, removal or
 * reordering is reported at the first position whose link or hash does not match.
 */
export function verifyChain(events: readonly AuditEvent[], expectedPrev: string = GENESIS_HASH): ChainResult {
  let prev = expectedPrev;
  for (let i = 0; i < events.length; i++) {
    const e = events[i] as AuditEvent;
    if (e.prevHash !== prev || e.hash !== eventHash(prev, e)) return { ok: false, firstBadIndex: i };
    prev = e.hash;
  }
  return { ok: true };
}

/** Builds the next event in a chain (pure helper used by the service and by tests). */
export function nextEvent(prev: Pick<AuditEvent, "hash" | "seq"> | undefined, input: AuditEventInput, at: Date): AuditEvent {
  const content = toContent(input, at);
  const prevHash = prev?.hash ?? GENESIS_HASH;
  return { ...content, seq: (prev?.seq ?? 0n) + 1n, prevHash, hash: eventHash(prevHash, content) };
}
