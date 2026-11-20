/**
 * Draw_Service: result retrieval, postponements and manual results
 * (Requirements 9.6, 9.8 to 9.13, 19.11, 19.12).
 *
 * Collaborators (persistence, audit, raffle completion, notifications, jobs, admin alerts) are ports,
 * so this module does not depend on the raffle, notification or scheduler implementations.
 */
import { err, ok, systemClock } from "@raffle/shared";
import type { Clock, Result } from "@raffle/shared";
import { ticketNumberDigits } from "../raffle/lottery-catalog.js";
import {
  deriveWinningNumber,
  resolveWinner,
  type FallbackRule,
  type LotteryResult,
  type WinningRule,
} from "./core.js";
import { decideManualResult } from "./manual.js";
import type { LotteryResultSource } from "./source.js";

export const JOB_RETRIEVE_RESULT = "draw.retrieve_result";

/** Retrieval is polled this often so a published result is found within 15 minutes of the draw (9.6). */
export const POLL_INTERVAL_MS = 5 * 60 * 1000;
/** After this long without a result Admins are alerted and manual entry opens (9.11). */
export const MANUAL_ENTRY_AFTER_MS = 2 * 60 * 60 * 1000;
export const SOURCE_REF_MAX = 500;

export interface DrawRaffle {
  id: string;
  ownerId: string;
  status: string;
  totalTickets: number;
  lotteryId: string;
  drawAt: Date;
  winningRule: { id: string };
  fallbackRule: FallbackRule;
}

export type ManualState = "pending" | "applied" | "rejected";

export interface DrawRecord {
  raffleId: string;
  result?: LotteryResult;
  sourceRef?: string;
  retrievedAt?: Date;
  derivedNumber?: number;
  winnerTicket?: number;
  unavailableAlertedAt?: Date;
  manual?: {
    enteredBy: string;
    enteredAt: Date;
    state: ManualState;
    approvedBy?: string;
    decidedBy?: string;
    decidedAt?: Date;
  };
}

export interface DrawRepository<Tx> {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Loads the raffle with a row lock. */
  findRaffleForUpdate(tx: Tx, raffleId: string): Promise<DrawRaffle | null>;
  soldTicketNumbers(tx: Tx, raffleId: string): Promise<ReadonlySet<number>>;
  findDraw(tx: Tx, raffleId: string): Promise<DrawRecord | null>;
  saveDraw(tx: Tx, draw: DrawRecord): Promise<void>;
  setDrawAt(tx: Tx, raffleId: string, drawAt: Date): Promise<void>;
}

export interface DrawAuditEvent {
  actor: string;
  action: string;
  entityType: "draw";
  entityId: string;
  changes: { field: string; before: string | null; after: string | null }[];
}

/** Structurally satisfied by the audit service adapter; failures must throw (fail closed, 18.9). */
export interface DrawAuditAppender<Tx> {
  append(tx: Tx, event: DrawAuditEvent): Promise<unknown>;
}

/** Implemented by the raffle module: performs the awaiting_draw to completed transition. */
export interface RaffleCompletion<Tx> {
  recordWinner(tx: Tx, raffleId: string, ticket: number, actor: string, now: Date): Promise<void>;
}

export type DrawNoticeKind = "draw_postponed" | "draw_cancelled" | "no_winner" | "redraw_scheduled";

/** Sent after commit; implemented on top of the Notification_Service. */
export interface DrawNotifier {
  notifyOwner(
    ownerId: string,
    raffleId: string,
    kind: DrawNoticeKind,
    params?: Record<string, string>,
  ): Promise<void>;
  notifyPlayers(
    raffleId: string,
    kind: DrawNoticeKind,
    params?: Record<string, string>,
  ): Promise<void>;
}

export type DrawAlertKind =
  | "result_unavailable"
  | "no_winner"
  | "lottery_cancelled"
  | "notification_failed";

export interface DrawAdminAlerter {
  alertAdmins(
    kind: DrawAlertKind,
    raffleId: string,
    detail?: Record<string, string>,
  ): Promise<void>;
}

export interface DrawJobScheduling {
  schedule(input: {
    jobType: string;
    entityId: string;
    occurrence: string;
    runAt: Date;
  }): Promise<boolean>;
}

export interface DrawDeps<Tx> {
  repo: DrawRepository<Tx>;
  audit: DrawAuditAppender<Tx>;
  completion: RaffleCompletion<Tx>;
  source: LotteryResultSource;
  /** Catalog source key for a lottery, e.g. `lottery:<id>`. */
  sourceKeyOf: (lotteryId: string) => string | undefined;
  /** Next scheduled draw of the lottery after `after`, used by the "redraw" fallback. */
  nextDrawAfter: (lotteryId: string, after: Date) => Date;
  notifier: DrawNotifier;
  alerts: DrawAdminAlerter;
  jobs: DrawJobScheduling;
  clock?: Clock;
}

export type RetrieveOutcome =
  | "skipped"
  | "waiting"
  | "winner"
  | "redraw"
  | "no_winner"
  | "postponed"
  | "cancelled"
  | "alerted";

export type Admin = { id: string; role: "admin" | string };

export interface PendingManualResult {
  /** Equal to the raffle id (one draw per raffle). */
  id: string;
  raffleId: string;
  enteredBy: string;
  sourceRef: string;
  result: LotteryResult;
  enteredAt: Date;
}

export type ManualError =
  | "forbidden"
  | "not_found"
  | "invalid_source_ref"
  | "invalid_result"
  | "not_awaiting_draw"
  | "too_early"
  | "already_pending"
  | "already_decided"
  | "not_pending";

export type ApprovalError = ManualError | "self_approval" | "self_rejection";

export interface DrawService {
  retrieveResult(raffleId: string): Promise<RetrieveOutcome>;
  /** Schedules the first retrieval at the draw time (call when a raffle enters awaiting_draw). */
  scheduleRetrieval(raffleId: string, drawAt: Date): Promise<boolean>;
  enterManualResult(
    admin: Admin,
    raffleId: string,
    result: LotteryResult,
    sourceRef: string,
  ): Promise<Result<PendingManualResult, ManualError>>;
  approveManualResult(
    admin: Admin,
    pendingId: string,
  ): Promise<Result<RetrieveOutcome, ApprovalError>>;
  rejectManualResult(admin: Admin, pendingId: string): Promise<Result<void, ApprovalError>>;
}

/** Structurally satisfied by the scheduler module's `Scheduler`. */
export interface DrawJobRegistry {
  register(jobType: string, handler: (job: { entityId: string }) => Promise<void>): void;
}

export function registerDrawJobs(registry: DrawJobRegistry, service: DrawService): void {
  registry.register(JOB_RETRIEVE_RESULT, async (job) => {
    await service.retrieveResult(job.entityId);
  });
}

const iso = (d: Date | undefined): string | null => (d ? d.toISOString() : null);

const isAdmin = (a: Admin): boolean => a.role === "admin";

export function createDrawService<Tx>(deps: DrawDeps<Tx>): DrawService {
  const clock = deps.clock ?? systemClock;
  const { repo, audit } = deps;

  type Post = () => Promise<void>;

  async function runPost(raffleId: string, post: Post[]): Promise<void> {
    for (const p of post) {
      try {
        await p();
      } catch (e) {
        // A notification failure never undoes a recorded draw outcome; Admins are told instead.
        await deps.alerts.alertAdmins("notification_failed", raffleId, {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  const scheduleRetrieval = (raffleId: string, drawAt: Date): Promise<boolean> =>
    deps.jobs.schedule({
      jobType: JOB_RETRIEVE_RESULT,
      entityId: raffleId,
      occurrence: `draw:${drawAt.toISOString()}`,
      runAt: drawAt,
    });

  /**
   * Derives and records the result, then resolves the winner. Runs in the caller's transaction;
   * returns follow-up actions to run after commit.
   */
  async function applyResult(
    tx: Tx,
    raffle: DrawRaffle,
    existing: DrawRecord | null,
    input: { result: LotteryResult; sourceRef: string; retrievedAt: Date; actor: string },
    now: Date,
    post: Post[],
  ): Promise<RetrieveOutcome> {
    const rule = raffle.winningRule.id as WinningRule;
    const derived = deriveWinningNumber(
      input.result,
      rule,
      ticketNumberDigits(raffle.totalTickets),
    );
    const sold = await repo.soldTicketNumbers(tx, raffle.id);
    const resolution = resolveWinner(derived, sold, raffle.fallbackRule);

    const record: DrawRecord = {
      ...(existing ?? { raffleId: raffle.id }),
      result: input.result,
      sourceRef: input.sourceRef,
      retrievedAt: input.retrievedAt,
      derivedNumber: derived,
    };
    delete record.winnerTicket;
    // Requirement 9.13: result, source reference, retrieval time, rule and derived number are audited.
    await audit.append(tx, {
      actor: input.actor,
      action: "draw.result_recorded",
      entityType: "draw",
      entityId: raffle.id,
      changes: [
        { field: "result", before: null, after: JSON.stringify(input.result) },
        { field: "sourceRef", before: null, after: input.sourceRef },
        { field: "retrievedAt", before: null, after: input.retrievedAt.toISOString() },
        { field: "winningRule", before: null, after: rule },
        { field: "derivedNumber", before: null, after: String(derived) },
      ],
    });

    if (resolution.kind === "winner") {
      record.winnerTicket = resolution.ticket;
      await repo.saveDraw(tx, record);
      await audit.append(tx, {
        actor: input.actor,
        action: "draw.winner_determined",
        entityType: "draw",
        entityId: raffle.id,
        changes: [{ field: "winnerTicket", before: null, after: String(resolution.ticket) }],
      });
      await deps.completion.recordWinner(tx, raffle.id, resolution.ticket, input.actor, now);
      return "winner";
    }

    await repo.saveDraw(tx, record);
    if (resolution.kind === "redraw") {
      const next = deps.nextDrawAfter(raffle.lotteryId, raffle.drawAt);
      await repo.setDrawAt(tx, raffle.id, next);
      await audit.append(tx, {
        actor: input.actor,
        action: "draw.redraw_scheduled",
        entityType: "draw",
        entityId: raffle.id,
        changes: [{ field: "drawAt", before: iso(raffle.drawAt), after: next.toISOString() }],
      });
      post.push(
        () => scheduleRetrieval(raffle.id, next).then(() => undefined),
        () =>
          deps.notifier.notifyOwner(raffle.ownerId, raffle.id, "redraw_scheduled", {
            drawAt: next.toISOString(),
          }),
        () =>
          deps.notifier.notifyPlayers(raffle.id, "redraw_scheduled", {
            drawAt: next.toISOString(),
          }),
      );
      return "redraw";
    }

    // No sold ticket in the chosen direction (or none sold): status unchanged, Admins alerted and the
    // Owner notified (Requirement 9.10).
    await audit.append(tx, {
      actor: input.actor,
      action: "draw.no_winner",
      entityType: "draw",
      entityId: raffle.id,
      changes: [{ field: "derivedNumber", before: null, after: String(derived) }],
    });
    post.push(
      () => deps.notifier.notifyOwner(raffle.ownerId, raffle.id, "no_winner"),
      () => deps.alerts.alertAdmins("no_winner", raffle.id, { derivedNumber: String(derived) }),
    );
    return "no_winner";
  }

  return {
    scheduleRetrieval,

    async retrieveResult(raffleId) {
      const now = clock.now();
      const pre = await repo.transaction(async (tx) => {
        const raffle = await repo.findRaffleForUpdate(tx, raffleId);
        const draw = raffle ? await repo.findDraw(tx, raffleId) : null;
        return { raffle, draw };
      });
      const { raffle } = pre;
      if (!raffle || raffle.status !== "awaiting_draw" || pre.draw?.winnerTicket !== undefined) {
        return "skipped";
      }
      if (now.getTime() < raffle.drawAt.getTime()) {
        await scheduleRetrieval(raffleId, raffle.drawAt);
        return "waiting";
      }

      const sourceKey = deps.sourceKeyOf(raffle.lotteryId) ?? `lottery:${raffle.lotteryId}`;
      // Network call outside any transaction; provider errors propagate so the scheduler retries.
      const fetched = await deps.source.fetch({
        lotteryId: raffle.lotteryId,
        sourceKey,
        drawAt: raffle.drawAt,
      });

      const post: Post[] = [];
      const outcome = await repo.transaction(async (tx): Promise<RetrieveOutcome> => {
        const locked = await repo.findRaffleForUpdate(tx, raffleId);
        const draw = await repo.findDraw(tx, raffleId);
        // Re-check under the lock: a manual approval or a status change may have won the race.
        if (
          !locked ||
          locked.status !== "awaiting_draw" ||
          draw?.winnerTicket !== undefined ||
          locked.drawAt.getTime() !== raffle.drawAt.getTime()
        ) {
          return "skipped";
        }

        switch (fetched.kind) {
          case "not_yet_published": {
            const deadline = new Date(locked.drawAt.getTime() + MANUAL_ENTRY_AFTER_MS);
            if (now.getTime() < deadline.getTime()) {
              const next = new Date(now.getTime() + POLL_INTERVAL_MS);
              post.push(() =>
                deps.jobs
                  .schedule({
                    jobType: JOB_RETRIEVE_RESULT,
                    entityId: raffleId,
                    occurrence: `poll:${next.toISOString()}`,
                    runAt: next,
                  })
                  .then(() => undefined),
              );
              return "waiting";
            }
            if (draw?.unavailableAlertedAt) return "alerted";
            await repo.saveDraw(tx, {
              ...(draw ?? { raffleId }),
              unavailableAlertedAt: now,
            });
            await audit.append(tx, {
              actor: "system",
              action: "draw.result_unavailable",
              entityType: "draw",
              entityId: raffleId,
              changes: [{ field: "unavailableAlertedAt", before: null, after: now.toISOString() }],
            });
            post.push(() =>
              deps.alerts.alertAdmins("result_unavailable", raffleId, {
                drawAt: locked.drawAt.toISOString(),
              }),
            );
            return "alerted";
          }

          case "postponed": {
            if (fetched.newDrawAt.getTime() === locked.drawAt.getTime()) return "waiting";
            await repo.setDrawAt(tx, raffleId, fetched.newDrawAt);
            await audit.append(tx, {
              actor: "system",
              action: "draw.postponed",
              entityType: "draw",
              entityId: raffleId,
              changes: [
                {
                  field: "drawAt",
                  before: iso(locked.drawAt),
                  after: fetched.newDrawAt.toISOString(),
                },
              ],
            });
            const params = { drawAt: fetched.newDrawAt.toISOString() };
            post.push(
              () => scheduleRetrieval(raffleId, fetched.newDrawAt).then(() => undefined),
              () => deps.notifier.notifyOwner(locked.ownerId, raffleId, "draw_postponed", params),
              () => deps.notifier.notifyPlayers(raffleId, "draw_postponed", params),
            );
            return "postponed";
          }

          case "cancelled": {
            await audit.append(tx, {
              actor: "system",
              action: "draw.lottery_cancelled",
              entityType: "draw",
              entityId: raffleId,
              changes: [{ field: "drawAt", before: iso(locked.drawAt), after: null }],
            });
            post.push(
              () => deps.notifier.notifyOwner(locked.ownerId, raffleId, "draw_cancelled"),
              () => deps.notifier.notifyPlayers(raffleId, "draw_cancelled"),
              () => deps.alerts.alertAdmins("lottery_cancelled", raffleId),
            );
            return "cancelled";
          }

          case "result": {
            if (fetched.result.lotteryId !== locked.lotteryId) {
              throw new Error("result belongs to a different lottery");
            }
            return applyResult(
              tx,
              locked,
              draw,
              {
                result: fetched.result,
                sourceRef: fetched.sourceRef,
                retrievedAt: now,
                actor: "system",
              },
              now,
              post,
            );
          }
        }
      });
      await runPost(raffleId, post);
      return outcome;
    },

    async enterManualResult(admin, raffleId, result, sourceRef) {
      if (!isAdmin(admin)) return err("forbidden");
      const ref = sourceRef.trim();
      if (ref.length < 1 || [...ref].length > SOURCE_REF_MAX) return err("invalid_source_ref");
      const now = clock.now();
      return repo.transaction(async (tx): Promise<Result<PendingManualResult, ManualError>> => {
        const raffle = await repo.findRaffleForUpdate(tx, raffleId);
        if (!raffle) return err("not_found");
        if (raffle.status !== "awaiting_draw") return err("not_awaiting_draw");
        // Manual entry opens only once automatic retrieval failed for 2 hours (Requirement 9.11).
        if (now.getTime() < raffle.drawAt.getTime() + MANUAL_ENTRY_AFTER_MS)
          return err("too_early");
        const draw = await repo.findDraw(tx, raffleId);
        if (draw?.winnerTicket !== undefined) return err("already_decided");
        if (draw?.manual?.state === "pending") return err("already_pending");
        if (result.lotteryId !== raffle.lotteryId) return err("invalid_result");
        try {
          deriveWinningNumber(
            result,
            raffle.winningRule.id as WinningRule,
            ticketNumberDigits(raffle.totalTickets),
          );
        } catch {
          return err("invalid_result");
        }
        const record: DrawRecord = {
          ...(draw ?? { raffleId }),
          result,
          sourceRef: ref,
          manual: { enteredBy: admin.id, enteredAt: now, state: "pending" },
        };
        await repo.saveDraw(tx, record);
        await audit.append(tx, {
          actor: admin.id,
          action: "draw.manual_entered",
          entityType: "draw",
          entityId: raffleId,
          changes: [
            { field: "result", before: null, after: JSON.stringify(result) },
            { field: "sourceRef", before: null, after: ref },
            { field: "manualState", before: null, after: "pending" },
          ],
        });
        return ok({
          id: raffleId,
          raffleId,
          enteredBy: admin.id,
          sourceRef: ref,
          result,
          enteredAt: now,
        });
      });
    },

    async approveManualResult(admin, pendingId) {
      if (!isAdmin(admin)) return err("forbidden");
      const now = clock.now();
      const post: Post[] = [];
      const result = await repo.transaction(
        async (tx): Promise<Result<RetrieveOutcome, ApprovalError>> => {
          const raffle = await repo.findRaffleForUpdate(tx, pendingId);
          const draw = raffle ? await repo.findDraw(tx, pendingId) : null;
          if (!raffle || !draw) return err("not_found");
          if (draw.manual?.state !== "pending" || !draw.result || !draw.sourceRef) {
            return err("not_pending");
          }
          const outcome = decideManualResult(draw.manual.enteredBy, admin.id, "approve");
          if (outcome === "denied_self") {
            // Draw state stays unchanged; the attempt is recorded with Admin identity (Req 19.12).
            await audit.append(tx, {
              actor: admin.id,
              action: "draw.manual_approval_denied",
              entityType: "draw",
              entityId: pendingId,
              changes: [{ field: "manualState", before: "pending", after: "pending" }],
            });
            return err("self_approval");
          }
          if (raffle.status !== "awaiting_draw") return err("not_awaiting_draw");
          const next: DrawRecord = {
            ...draw,
            manual: {
              ...draw.manual,
              state: "applied",
              approvedBy: admin.id,
              decidedBy: admin.id,
              decidedAt: now,
            },
          };
          await audit.append(tx, {
            actor: admin.id,
            action: "draw.manual_approved",
            entityType: "draw",
            entityId: pendingId,
            changes: [{ field: "manualState", before: "pending", after: "applied" }],
          });
          const applied = await applyResult(
            tx,
            raffle,
            next,
            { result: draw.result, sourceRef: draw.sourceRef, retrievedAt: now, actor: admin.id },
            now,
            post,
          );
          return ok(applied);
        },
      );
      await runPost(pendingId, post);
      return result;
    },

    async rejectManualResult(admin, pendingId) {
      if (!isAdmin(admin)) return err("forbidden");
      const now = clock.now();
      return repo.transaction(async (tx): Promise<Result<void, ApprovalError>> => {
        const raffle = await repo.findRaffleForUpdate(tx, pendingId);
        const draw = raffle ? await repo.findDraw(tx, pendingId) : null;
        if (!raffle || !draw) return err("not_found");
        if (draw.manual?.state !== "pending") return err("not_pending");
        const outcome = decideManualResult(draw.manual.enteredBy, admin.id, "reject");
        if (outcome === "denied_self") {
          await audit.append(tx, {
            actor: admin.id,
            action: "draw.manual_rejection_denied",
            entityType: "draw",
            entityId: pendingId,
            changes: [{ field: "manualState", before: "pending", after: "pending" }],
          });
          return err("self_rejection");
        }
        await repo.saveDraw(tx, {
          ...draw,
          manual: { ...draw.manual, state: "rejected", decidedBy: admin.id, decidedAt: now },
        });
        await audit.append(tx, {
          actor: admin.id,
          action: "draw.manual_rejected",
          entityType: "draw",
          entityId: pendingId,
          changes: [{ field: "manualState", before: "pending", after: "rejected" }],
        });
        return ok(undefined);
      });
    },
  };
}
