import type { Clock } from "@raffle/shared";
import { decide, validateThresholds, type FraudThresholds } from "./decision.js";
import type { RateLimitStore } from "./rate-limit-store.js";
import {
  scoreWithTimeout,
  SCORE_TIMEOUT_MS,
  type FraudScorer,
  type PurchaseContext,
} from "./scoring.js";

/** Queueing for Admin review must complete within 5 seconds (Requirement 15.3). */
export const ORDER_REVIEW_DEADLINE_MS = 5000;
/** Sales suspension must complete within 60 seconds of detection (Requirement 15.6). */
export const SUSPENSION_DEADLINE_MS = 60_000;

export const BLOCKED_MESSAGE = "The purchase could not be completed.";
export const UNDER_REVIEW_MESSAGE = "Your order is under review.";

export type ReviewReason = "score_in_review_band" | "scoring_error";

export interface OrderReviewEntry {
  orderId: string;
  userId: string;
  raffleId: string;
  reason: ReviewReason;
  /** Null when scoring failed or timed out. */
  score: number | null;
  queuedAt: Date;
}

export interface OrderReviewQueue {
  add(entry: OrderReviewEntry): void;
}

export class InMemoryOrderReviewQueue implements OrderReviewQueue {
  readonly entries: OrderReviewEntry[] = [];
  add(entry: OrderReviewEntry): void {
    if (!this.entries.some((e) => e.orderId === entry.orderId)) this.entries.push(entry);
  }
}

export interface FraudRecord {
  kind: "purchase_blocked" | "order_held" | "raffle_suspended" | "owner_approval_requested";
  at: Date;
  subjectId: string;
  reason: string;
  score?: number | null;
}

/** Port for recording fraud reasons and scores (wired to the audit trail by the caller). */
export interface FraudRecorder {
  record(r: FraudRecord): void;
}

export class InMemoryFraudRecorder implements FraudRecorder {
  readonly records: FraudRecord[] = [];
  record(r: FraudRecord): void {
    this.records.push(r);
  }
}

export interface FraudPorts {
  /** Releases any Reservation held for the purchase. */
  releaseReservation(reservationId: string): void | Promise<void>;
  /** Tells the Player their order is under review. */
  notifyPlayerUnderReview(userId: string, orderId: string): void | Promise<void>;
  notifyAdmins(subject: string, details: Record<string, string>): void | Promise<void>;
  /** Suspends new sales only; completed orders are untouched. */
  suspendSales(raffleId: string): void | Promise<void>;
}

export type PurchaseOutcome =
  | { status: "allowed"; score: number }
  | { status: "blocked"; score: number; message: string }
  | { status: "under_review"; score: number | null; message: string }
  | { status: "rate_limited"; retryAfterMs: number; message: string };

export interface FraudServiceOptions {
  thresholds: FraudThresholds;
  scoreTimeoutMs?: number;
}

/**
 * Fraud gate for the payment flow: rate limits reservation creation, scores the purchase, and applies
 * block, review, or allow (Requirements 15.1 to 15.5).
 */
export class FraudService {
  private readonly scoreTimeoutMs: number;

  constructor(
    private readonly scorer: FraudScorer,
    private readonly store: RateLimitStore,
    private readonly queue: OrderReviewQueue,
    private readonly recorder: FraudRecorder,
    private readonly ports: FraudPorts,
    private readonly clock: Clock,
    private readonly options: FraudServiceOptions,
  ) {
    validateThresholds(options.thresholds);
    this.scoreTimeoutMs = options.scoreTimeoutMs ?? SCORE_TIMEOUT_MS;
  }

  /** Rate limit by user and by IP; rejects when either exceeds 10 requests in 60 seconds. */
  async checkRateLimit(
    userId: string,
    ip: string,
  ): Promise<{ allowed: boolean; retryAfterMs: number }> {
    const now = this.clock.now().getTime();
    const byUser = await this.store.consume(`user:${userId}`, now);
    const byIp = await this.store.consume(`ip:${ip}`, now);
    return {
      allowed: byUser.allowed && byIp.allowed,
      retryAfterMs: Math.max(byUser.retryAfterMs, byIp.retryAfterMs),
    };
  }

  /** Evaluates a purchase at initiation. */
  async evaluatePurchase(ctx: PurchaseContext): Promise<PurchaseOutcome> {
    const rl = await this.checkRateLimit(ctx.userId, ctx.ip);
    if (!rl.allowed) {
      return {
        status: "rate_limited",
        retryAfterMs: rl.retryAfterMs,
        message: `Rate limit exceeded. Try again in ${Math.ceil(rl.retryAfterMs / 1000)} seconds.`,
      };
    }
    const score = await scoreWithTimeout(this.scorer, ctx, this.scoreTimeoutMs);
    const decision = decide(score, this.options.thresholds);
    const numeric = score === "error" ? null : score;
    const at = this.clock.now();

    if (decision === "block") {
      this.recorder.record({
        kind: "purchase_blocked",
        at,
        subjectId: ctx.orderId,
        reason: "score_at_or_above_block_threshold",
        score: numeric,
      });
      await this.ports.releaseReservation(ctx.reservationId);
      return { status: "blocked", score: score as number, message: BLOCKED_MESSAGE };
    }
    if (decision === "review") {
      const reason: ReviewReason = score === "error" ? "scoring_error" : "score_in_review_band";
      this.queue.add({
        orderId: ctx.orderId,
        userId: ctx.userId,
        raffleId: ctx.raffleId,
        reason,
        score: numeric,
        queuedAt: at,
      });
      this.recorder.record({
        kind: "order_held",
        at,
        subjectId: ctx.orderId,
        reason,
        score: numeric,
      });
      await this.ports.notifyPlayerUnderReview(ctx.userId, ctx.orderId);
      return { status: "under_review", score: numeric, message: UNDER_REVIEW_MESSAGE };
    }
    return { status: "allowed", score: score as number };
  }
}

// ---- Raffle fraud suspension (Requirement 15.6) ----

export type RaffleFraudSignal = "prize_does_not_exist" | "duplicate_identities";

export interface RaffleFraudFacts {
  prizeVerified: boolean;
  /** Distinct owner/winner-eligible identities sharing the same identity document. */
  duplicateIdentityCount: number;
}

export function detectRaffleFraudSignals(f: RaffleFraudFacts): RaffleFraudSignal[] {
  const out: RaffleFraudSignal[] = [];
  if (!f.prizeVerified) out.push("prize_does_not_exist");
  if (f.duplicateIdentityCount > 1) out.push("duplicate_identities");
  return out;
}

export interface SuspensionResult {
  suspended: boolean;
  signals: RaffleFraudSignal[];
  /** True when suspension finished within 60 seconds of detection. */
  withinDeadline: boolean;
}

/** Suspends new sales on a fraudulent raffle, notifies Admins, and leaves completed orders alone. */
export async function suspendFraudulentRaffle(
  raffleId: string,
  facts: RaffleFraudFacts,
  ports: Pick<FraudPorts, "suspendSales" | "notifyAdmins">,
  recorder: FraudRecorder,
  clock: Clock,
): Promise<SuspensionResult> {
  const signals = detectRaffleFraudSignals(facts);
  if (signals.length === 0) return { suspended: false, signals, withinDeadline: true };
  const detectedAt = clock.now();
  await ports.suspendSales(raffleId);
  await ports.notifyAdmins("raffle_fraud_suspected", { raffleId, signals: signals.join(",") });
  const done = clock.now();
  recorder.record({
    kind: "raffle_suspended",
    at: done,
    subjectId: raffleId,
    reason: signals.join(","),
  });
  return {
    suspended: true,
    signals,
    withinDeadline: done.getTime() - detectedAt.getTime() <= SUSPENSION_DEADLINE_MS,
  };
}

// ---- High-risk owner approval (Requirement 15.9) ----

export interface OwnerApprovalEntry {
  raffleId: string;
  ownerId: string;
  requestedAt: Date;
}

export type Visibility = "visible" | "pending_admin_approval";

/**
 * Tracks high-risk Owners. Each Raffle of a flagged Owner needs manual Admin approval before it becomes
 * visible to Players.
 */
export class HighRiskOwnerRegistry {
  private readonly highRisk = new Set<string>();
  private readonly pending = new Map<string, OwnerApprovalEntry>();
  private readonly approved = new Set<string>();

  constructor(
    private readonly clock: Clock,
    private readonly recorder: FraudRecorder,
  ) {}

  flag(ownerId: string): void {
    this.highRisk.add(ownerId);
  }

  unflag(ownerId: string): void {
    this.highRisk.delete(ownerId);
  }

  isHighRisk(ownerId: string): boolean {
    return this.highRisk.has(ownerId);
  }

  /** Decides visibility at publication; queues for approval when the Owner is high risk. */
  requestVisibility(ownerId: string, raffleId: string): Visibility {
    if (!this.isHighRisk(ownerId) || this.approved.has(raffleId)) return "visible";
    if (!this.pending.has(raffleId)) {
      const at = this.clock.now();
      this.pending.set(raffleId, { raffleId, ownerId, requestedAt: at });
      this.recorder.record({
        kind: "owner_approval_requested",
        at,
        subjectId: raffleId,
        reason: "owner_high_risk",
      });
    }
    return "pending_admin_approval";
  }

  pendingApprovals(): OwnerApprovalEntry[] {
    return [...this.pending.values()];
  }

  /** Admin approval; returns false when no approval was pending for the Raffle. */
  approve(raffleId: string): boolean {
    if (!this.pending.delete(raffleId)) return false;
    this.approved.add(raffleId);
    return true;
  }

  reject(raffleId: string): boolean {
    return this.pending.delete(raffleId);
  }
}
