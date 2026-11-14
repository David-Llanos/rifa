import { err, fieldError, ok, systemClock } from "@raffle/shared";
import type { Clock, FieldError, Result } from "@raffle/shared";
import type { Raffle, RaffleInput } from "./types.js";
import { validateEdit, validateRaffle } from "./validation.js";

/** Audit event content, structurally compatible with the audit service's `append` input. */
export interface RaffleAuditEvent {
  actor: string;
  action: string;
  entityType: "raffle";
  entityId: string;
  changes: { field: string; before: string | null; after: string | null }[];
}

/** Depends on an interface only; the hash-chained audit service implements it (task 2.1). */
export interface RaffleAuditAppender<Tx> {
  append(tx: Tx, event: RaffleAuditEvent): Promise<unknown>;
}

export interface RaffleRepository<Tx> {
  /** Run `fn` in one DB transaction; any throw rolls everything back. */
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  insert(tx: Tx, raffle: Raffle): Promise<void>;
  /** Load with a row lock. */
  findForUpdate(tx: Tx, raffleId: string): Promise<Raffle | null>;
  update(tx: Tx, raffle: Raffle): Promise<void>;
  soldCount(tx: Tx, raffleId: string): Promise<number>;
}

export interface RaffleDraftDeps<Tx> {
  repo: RaffleRepository<Tx>;
  audit: RaffleAuditAppender<Tx>;
  newId: () => string;
  clock?: Clock;
}

function show(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "object") {
    return JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x));
  }
  return String(v);
}

function diff(
  before: Partial<RaffleInput> | null,
  after: RaffleInput,
): RaffleAuditEvent["changes"] {
  const out: RaffleAuditEvent["changes"] = [];
  for (const key of Object.keys(after) as (keyof RaffleInput)[]) {
    const b = before ? show(before[key]) : null;
    const a = show(after[key]);
    if (b !== a) out.push({ field: key, before: b, after: a });
  }
  return out;
}

export interface RaffleDraftService {
  saveDraft(ownerId: string, input: RaffleInput): Promise<Result<Raffle, FieldError[]>>;
  updateDraft(
    ownerId: string,
    raffleId: string,
    patch: Partial<RaffleInput>,
  ): Promise<Result<Raffle, FieldError[]>>;
}

/**
 * Draft persistence. Validation runs first; the audit append runs inside the same transaction as the
 * write, so an audit failure rolls the change back (Requirement 18.9).
 */
export function createRaffleDraftService<Tx>(deps: RaffleDraftDeps<Tx>): RaffleDraftService {
  const clock = deps.clock ?? systemClock;
  const { repo, audit } = deps;

  return {
    async saveDraft(ownerId, input) {
      const now = clock.now();
      const errors = validateRaffle(input, now);
      if (errors.length > 0) return err(errors);

      const raffle: Raffle = {
        ...input,
        id: deps.newId(),
        ownerId,
        status: "draft",
        createdAt: now,
        updatedAt: now,
      };
      await repo.transaction(async (tx) => {
        await repo.insert(tx, raffle);
        await audit.append(tx, {
          actor: ownerId,
          action: "raffle.draft_created",
          entityType: "raffle",
          entityId: raffle.id,
          changes: diff(null, input),
        });
      });
      return ok(raffle);
    },

    async updateDraft(ownerId, raffleId, patch) {
      const now = clock.now();
      return repo.transaction(async (tx): Promise<Result<Raffle, FieldError[]>> => {
        const existing = await repo.findForUpdate(tx, raffleId);
        if (!existing) return err([fieldError("raffle", "not_found")]);
        if (existing.ownerId !== ownerId) return err([fieldError("raffle", "forbidden")]);
        if (existing.status !== "draft") return err([fieldError("raffle", "not_draft")]);

        const locked = validateEdit(existing, patch, await repo.soldCount(tx, raffleId));
        const defined = Object.fromEntries(
          Object.entries(patch).filter(([, v]) => v !== undefined),
        );
        const merged: Raffle = { ...existing, ...defined, updatedAt: now };
        const errors = [...locked, ...validateRaffle(merged, now)];
        if (errors.length > 0) return err(errors);

        await repo.update(tx, merged);
        await audit.append(tx, {
          actor: ownerId,
          action: "raffle.draft_updated",
          entityType: "raffle",
          entityId: raffleId,
          changes: diff(existing, merged).filter((c) => c.field in defined),
        });
        return ok(merged);
      });
    },
  };
}
