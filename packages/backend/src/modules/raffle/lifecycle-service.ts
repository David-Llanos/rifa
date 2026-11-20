import { err, fieldError, ok, systemClock } from "@raffle/shared";
import type { Clock, FieldError, Result } from "@raffle/shared";
import type { RaffleAuditAppender, RaffleRepository } from "./draft-service.js";
import {
  closureDecision,
  isIllegal,
  reminderRunAt,
  transition,
  type RaffleEvent,
} from "./lifecycle.js";
import type { Raffle, RaffleStatus } from "./types.js";
import { validateRaffle } from "./validation.js";

export const CANCEL_REASON_MAX = 500;

export type CancellationStatus = "pending" | "approved" | "rejected";

export interface CancellationRequest {
  id: string;
  raffleId: string;
  requestedBy: string;
  reason: string;
  status: CancellationStatus;
  decidedBy: string | null;
  requestedAt: Date;
  decidedAt: Date | null;
}

/** Persistence for the lifecycle service; extends the draft repository with cancellation requests. */
export interface LifecycleRepository<Tx> extends RaffleRepository<Tx> {
  insertCancellationRequest(tx: Tx, req: CancellationRequest): Promise<void>;
  findPendingCancellation(tx: Tx, raffleId: string): Promise<CancellationRequest | null>;
  updateCancellationRequest(tx: Tx, req: CancellationRequest): Promise<void>;
}

/** Implemented by the inventory module (task 5.1); this module only depends on the interface. */
export interface InventoryEffects<Tx> {
  /** Releases unpaid reservations, keeping those with a payment in progress up to 15 minutes. */
  releaseUnpaidReservations(tx: Tx, raffleId: string, now: Date): Promise<void>;
  /** Sets every ticket of the raffle to cancelled (Requirement 8.6). */
  cancelTickets(tx: Tx, raffleId: string): Promise<void>;
}

/** Implemented by the payment module (task 7.x). */
export interface RefundEffects<Tx> {
  /**
   * Enqueues refunds of every sold ticket payment; must start them within 24 hours (Req 8.2).
   * `previousStatus` is the status before cancellation: from `draft`, the Creation_Fee is refunded (Req 3.9).
   */
  startRefunds(
    tx: Tx,
    raffleId: string,
    cancelledAt: Date,
    context?: { previousStatus: RaffleStatus },
  ): Promise<void>;
}

/** Implemented by the payment module's fee service (task 7.4). */
export interface CreationFeeGate<Tx> {
  /** A draft can be submitted only after its Creation_Fee is paid (Requirements 3.2, 3.3). */
  isCreationFeePaid(tx: Tx, raffleId: string): Promise<boolean>;
}

export type OwnerNoticeKind =
  | "publication_failed"
  | "cancellation_pending"
  | "cancellation_rejected"
  | "raffle_cancelled"
  | "deadline_reminder"
  | "closure_failed";

/** Sent after commit; a failure to notify never rolls back a state change. */
export interface OwnerNotifier {
  notifyOwner(
    ownerId: string,
    raffleId: string,
    kind: OwnerNoticeKind,
    params?: Record<string, string>,
  ): Promise<void>;
}

/** Structurally satisfied by the scheduler module's `Scheduler`. */
export interface JobScheduling {
  schedule(input: {
    jobType: string;
    entityId: string;
    occurrence: string;
    runAt: Date;
  }): Promise<boolean>;
}

export const JOB_CLOSE_SALES = "raffle.close_sales";
export const JOB_EVALUATE_THRESHOLD = "raffle.evaluate_threshold";
export const JOB_REMINDER_24H = "raffle.reminder_24h";

export type PublicationOutcome =
  | { ok: true; via: "payment_and_compliance" | "admin_approval" }
  | { ok: false; reason: string };

export type LifecycleError =
  | { kind: "not_found" }
  | { kind: "forbidden" }
  | { kind: "illegal_transition"; from: RaffleStatus; event: RaffleEvent }
  | { kind: "invalid"; errors: FieldError[] };

export type Actor = { id: string; role: "owner" | "admin" };

export type CancelOutcome = "cancelled" | "pending_admin_approval";

export interface LifecycleDeps<Tx> {
  repo: LifecycleRepository<Tx>;
  audit: RaffleAuditAppender<Tx>;
  inventory: InventoryEffects<Tx>;
  refunds: RefundEffects<Tx>;
  notifier: OwnerNotifier;
  jobs: JobScheduling;
  newId: () => string;
  clock?: Clock;
  /** When set, submission is rejected until the Creation_Fee is paid. */
  creationFee?: CreationFeeGate<Tx>;
}

export type ClosureStep = "none" | "sales_closed" | "awaiting_draw" | "cancelled";

export interface RaffleLifecycleService {
  /** draft to pending_review (Requirement 2.12). */
  submitForPublication(ownerId: string, raffleId: string): Promise<Result<Raffle, LifecycleError>>;
  /** pending_review to published, or back to draft with the owner notified (Requirements 2.12, 2.13). */
  resolvePublication(
    raffleId: string,
    outcome: PublicationOutcome,
  ): Promise<Result<Raffle, LifecycleError>>;
  /** Owner requests or Admin performs cancellation (Requirement 8.8). */
  cancel(
    raffleId: string,
    actor: Actor,
    reason: string,
  ): Promise<Result<CancelOutcome, LifecycleError>>;
  approveCancellation(raffleId: string, admin: Actor): Promise<Result<void, LifecycleError>>;
  rejectCancellation(raffleId: string, admin: Actor): Promise<Result<void, LifecycleError>>;
  /** published to sales_closed when the deadline passed or an early-closure sell-out occurred. */
  closeSales(raffleId: string): Promise<Result<ClosureStep, LifecycleError>>;
  /** sales_closed to awaiting_draw or cancelled with refunds (Requirements 7.7 to 7.9). */
  evaluateThreshold(raffleId: string): Promise<Result<ClosureStep, LifecycleError>>;
  /** Sends the 24-hour reminder when the raffle is still published. Returns whether it was sent. */
  sendDeadlineReminder(raffleId: string): Promise<boolean>;
}

function validReason(reason: string): FieldError[] {
  const n = [...reason.trim()].length;
  return n >= 1 && n <= CANCEL_REASON_MAX
    ? []
    : [fieldError("reason", "length", { min: 1, max: CANCEL_REASON_MAX })];
}

export function createRaffleLifecycleService<Tx>(deps: LifecycleDeps<Tx>): RaffleLifecycleService {
  const clock = deps.clock ?? systemClock;
  const { repo, audit } = deps;

  async function load(tx: Tx, raffleId: string): Promise<Result<Raffle, LifecycleError>> {
    const r = await repo.findForUpdate(tx, raffleId);
    return r ? ok(r) : err({ kind: "not_found" });
  }

  /** Applies a legal event, persists and audits it. */
  async function move(
    tx: Tx,
    raffle: Raffle,
    event: RaffleEvent,
    actor: string,
    now: Date,
    extra: { field: string; before: string | null; after: string | null }[] = [],
  ): Promise<Result<Raffle, LifecycleError>> {
    const next = transition(raffle.status, event);
    if (isIllegal(next)) return err({ kind: "illegal_transition", from: raffle.status, event });
    const updated: Raffle = { ...raffle, status: next, updatedAt: now };
    await repo.update(tx, updated);
    await audit.append(tx, {
      actor,
      action: `raffle.${event}`,
      entityType: "raffle",
      entityId: raffle.id,
      changes: [{ field: "status", before: raffle.status, after: next }, ...extra],
    });
    return ok(updated);
  }

  async function scheduleClosureJobs(raffle: Raffle, now: Date): Promise<void> {
    await deps.jobs.schedule({
      jobType: JOB_CLOSE_SALES,
      entityId: raffle.id,
      occurrence: "deadline",
      runAt: raffle.deadline,
    });
    await deps.jobs.schedule({
      jobType: JOB_REMINDER_24H,
      entityId: raffle.id,
      occurrence: "24h",
      runAt: reminderRunAt(raffle.deadline, now),
    });
  }

  async function cancelNow(
    tx: Tx,
    raffle: Raffle,
    event: "cancel" | "threshold_not_met",
    actor: string,
    reason: string,
    now: Date,
  ): Promise<Result<Raffle, LifecycleError>> {
    const moved = await move(tx, raffle, event, actor, now, [
      { field: "cancellationReason", before: null, after: reason },
    ]);
    if (!moved.ok) return moved;
    await deps.inventory.cancelTickets(tx, raffle.id);
    await deps.refunds.startRefunds(tx, raffle.id, now, { previousStatus: raffle.status });
    return moved;
  }

  return {
    async submitForPublication(ownerId, raffleId) {
      const now = clock.now();
      const result = await repo.transaction(async (tx): Promise<Result<Raffle, LifecycleError>> => {
        const loaded = await load(tx, raffleId);
        if (!loaded.ok) return loaded;
        if (loaded.value.ownerId !== ownerId) return err({ kind: "forbidden" });
        // Deadline must still be at least 24 hours away at submission (Requirement 2.7).
        const errors = validateRaffle(loaded.value, now);
        if (errors.length > 0) return err({ kind: "invalid", errors });
        if (
          loaded.value.status === "draft" &&
          deps.creationFee &&
          !(await deps.creationFee.isCreationFeePaid(tx, raffleId))
        ) {
          return err({ kind: "invalid", errors: [fieldError("creationFee", "unpaid")] });
        }
        return move(tx, loaded.value, "submit", ownerId, now);
      });
      return result;
    },

    async resolvePublication(raffleId, outcome) {
      const now = clock.now();
      const result = await repo.transaction(async (tx): Promise<Result<Raffle, LifecycleError>> => {
        const loaded = await load(tx, raffleId);
        if (!loaded.ok) return loaded;
        const event: RaffleEvent = outcome.ok ? "publication_approved" : "publication_rejected";
        // All raffle data is retained on failure; only the status changes (Requirement 2.13).
        return move(tx, loaded.value, event, "system", now, [
          {
            field: "publicationResult",
            before: null,
            after: outcome.ok ? outcome.via : outcome.reason,
          },
        ]);
      });
      if (!result.ok) return result;
      if (outcome.ok) {
        await scheduleClosureJobs(result.value, now);
      } else {
        await deps.notifier.notifyOwner(result.value.ownerId, raffleId, "publication_failed", {
          reason: outcome.reason,
        });
      }
      return result;
    },

    async cancel(raffleId, actor, reason) {
      const now = clock.now();
      const bad = validReason(reason);
      if (bad.length > 0) return err({ kind: "invalid", errors: bad });
      const text = reason.trim();
      const box: { ownerId: string } = { ownerId: "" };
      const result = await repo.transaction(
        async (tx): Promise<Result<CancelOutcome, LifecycleError>> => {
          const loaded = await load(tx, raffleId);
          if (!loaded.ok) return loaded;
          const raffle = loaded.value;
          box.ownerId = raffle.ownerId;
          if (actor.role === "owner" && raffle.ownerId !== actor.id)
            return err({ kind: "forbidden" });
          if (isIllegal(transition(raffle.status, "cancel"))) {
            return err({ kind: "illegal_transition", from: raffle.status, event: "cancel" });
          }
          const sold = await repo.soldCount(tx, raffleId);
          if (actor.role === "owner" && sold > 0) {
            // The raffle stays active until an Admin approves (Requirement 8.8).
            const existing = await repo.findPendingCancellation(tx, raffleId);
            if (existing) return ok("pending_admin_approval");
            await repo.insertCancellationRequest(tx, {
              id: deps.newId(),
              raffleId,
              requestedBy: actor.id,
              reason: text,
              status: "pending",
              decidedBy: null,
              requestedAt: now,
              decidedAt: null,
            });
            await audit.append(tx, {
              actor: actor.id,
              action: "raffle.cancellation_requested",
              entityType: "raffle",
              entityId: raffleId,
              changes: [{ field: "cancellationReason", before: null, after: text }],
            });
            return ok("pending_admin_approval");
          }
          const done = await cancelNow(tx, raffle, "cancel", actor.id, text, now);
          return done.ok ? ok("cancelled") : done;
        },
      );
      if (result.ok) {
        await deps.notifier.notifyOwner(
          box.ownerId,
          raffleId,
          result.value === "cancelled" ? "raffle_cancelled" : "cancellation_pending",
        );
      }
      return result;
    },

    async approveCancellation(raffleId, admin) {
      const now = clock.now();
      if (admin.role !== "admin") return err({ kind: "forbidden" });
      const result = await repo.transaction(async (tx): Promise<Result<string, LifecycleError>> => {
        const loaded = await load(tx, raffleId);
        if (!loaded.ok) return loaded;
        const req = await repo.findPendingCancellation(tx, raffleId);
        if (!req) return err({ kind: "not_found" });
        // A documented reason of 1 to 500 characters must exist before approval (Requirement 8.8).
        const bad = validReason(req.reason);
        if (bad.length > 0) return err({ kind: "invalid", errors: bad });
        const done = await cancelNow(tx, loaded.value, "cancel", admin.id, req.reason, now);
        if (!done.ok) return done;
        await repo.updateCancellationRequest(tx, {
          ...req,
          status: "approved",
          decidedBy: admin.id,
          decidedAt: now,
        });
        return ok(loaded.value.ownerId);
      });
      if (!result.ok) return result;
      await deps.notifier.notifyOwner(result.value, raffleId, "raffle_cancelled");
      return ok(undefined);
    },

    async rejectCancellation(raffleId, admin) {
      const now = clock.now();
      if (admin.role !== "admin") return err({ kind: "forbidden" });
      const result = await repo.transaction(async (tx): Promise<Result<string, LifecycleError>> => {
        const loaded = await load(tx, raffleId);
        if (!loaded.ok) return loaded;
        const req = await repo.findPendingCancellation(tx, raffleId);
        if (!req) return err({ kind: "not_found" });
        await repo.updateCancellationRequest(tx, {
          ...req,
          status: "rejected",
          decidedBy: admin.id,
          decidedAt: now,
        });
        await audit.append(tx, {
          actor: admin.id,
          action: "raffle.cancellation_rejected",
          entityType: "raffle",
          entityId: raffleId,
          changes: [{ field: "cancellationStatus", before: "pending", after: "rejected" }],
        });
        return ok(loaded.value.ownerId);
      });
      if (!result.ok) return result;
      await deps.notifier.notifyOwner(result.value, raffleId, "cancellation_rejected");
      return ok(undefined);
    },

    async closeSales(raffleId) {
      const now = clock.now();
      const result = await repo.transaction(
        async (tx): Promise<Result<ClosureStep, LifecycleError>> => {
          const loaded = await load(tx, raffleId);
          if (!loaded.ok) return loaded;
          const raffle = loaded.value;
          const sold = await repo.soldCount(tx, raffleId);
          const decision = closureDecision({
            status: raffle.status,
            now,
            deadline: raffle.deadline,
            soldCount: sold,
            totalTickets: raffle.totalTickets,
            minThreshold: raffle.minThreshold,
            earlyClosure: raffle.earlyClosure,
          });
          if (decision !== "sales_closed") return ok("none");
          const moved = await move(tx, raffle, "close_sales", "system", now);
          if (!moved.ok) return moved;
          await deps.inventory.releaseUnpaidReservations(tx, raffleId, now);
          return ok("sales_closed");
        },
      );
      if (result.ok && result.value === "sales_closed") {
        // Threshold evaluation runs as its own durable job, due immediately (within 1 minute).
        await deps.jobs.schedule({
          jobType: JOB_EVALUATE_THRESHOLD,
          entityId: raffleId,
          occurrence: "closure",
          runAt: now,
        });
      }
      return result;
    },

    async evaluateThreshold(raffleId) {
      const now = clock.now();
      const box: { ownerId: string | null } = { ownerId: null };
      const result = await repo.transaction(
        async (tx): Promise<Result<ClosureStep, LifecycleError>> => {
          const loaded = await load(tx, raffleId);
          if (!loaded.ok) return loaded;
          const raffle = loaded.value;
          const sold = await repo.soldCount(tx, raffleId);
          const decision = closureDecision({
            status: raffle.status,
            now,
            deadline: raffle.deadline,
            soldCount: sold,
            totalTickets: raffle.totalTickets,
            minThreshold: raffle.minThreshold,
            earlyClosure: raffle.earlyClosure,
          });
          if (decision === "awaiting_draw") {
            const moved = await move(tx, raffle, "threshold_met", "system", now);
            return moved.ok ? ok("awaiting_draw") : moved;
          }
          if (decision === "cancel_refund") {
            const done = await cancelNow(
              tx,
              raffle,
              "threshold_not_met",
              "system",
              "minimum ticket threshold not met",
              now,
            );
            if (!done.ok) return done;
            box.ownerId = raffle.ownerId;
            return ok("cancelled");
          }
          return ok("none");
        },
      );
      if (result.ok && result.value === "cancelled" && box.ownerId) {
        await deps.notifier.notifyOwner(box.ownerId, raffleId, "raffle_cancelled", {
          reason: "threshold_not_met",
        });
      }
      return result;
    },

    async sendDeadlineReminder(raffleId) {
      const raffle = await repo.transaction(async (tx) => repo.findForUpdate(tx, raffleId));
      if (raffle?.status !== "published") return false;
      await deps.notifier.notifyOwner(raffle.ownerId, raffleId, "deadline_reminder", {
        deadline: raffle.deadline.toISOString(),
      });
      return true;
    },
  };
}
