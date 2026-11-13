/** Thresholds for fraud decisions; `review` must be below `block` (Requirements 15.2, 15.3). */
export interface FraudThresholds {
  review: number;
  block: number;
}

export type FraudDecision = "allow" | "review" | "block";

export class InvalidThresholdsError extends Error {
  constructor() {
    super("Fraud thresholds must satisfy 0 <= review < block <= 100.");
    this.name = "InvalidThresholdsError";
  }
}

export function validateThresholds(t: FraudThresholds): void {
  if (!(t.review >= 0 && t.review < t.block && t.block <= 100)) throw new InvalidThresholdsError();
}

/**
 * Pure decision core. A score at or above `block` blocks; from `review` up to `block` holds for review;
 * below `review` allows. A scoring timeout or error (`"error"`), or a score outside the integer range
 * 0..100, holds the order for review (Requirements 15.2, 15.3, 15.4).
 */
export function decide(score: number | "error", t: FraudThresholds): FraudDecision {
  validateThresholds(t);
  if (score === "error" || !Number.isInteger(score) || score < 0 || score > 100) return "review";
  if (score >= t.block) return "block";
  if (score >= t.review) return "review";
  return "allow";
}

export const RATE_LIMIT_MAX = 10;
export const RATE_LIMIT_WINDOW_MS = 60_000;

export interface RateLimitResult {
  allowed: boolean;
  /** Milliseconds until the next request is allowed; 0 when allowed. */
  retryAfterMs: number;
}

/**
 * Sliding-window limiter over request timestamps (ms). Up to `limit` requests are allowed in any
 * `windowMs` period; each additional one is rejected with the time remaining until a slot frees up
 * (Requirement 15.5). Rejected requests are not counted, so callers only record allowed ones.
 */
export function rateLimit(
  timestamps: readonly number[],
  nowMs: number,
  limit: number = RATE_LIMIT_MAX,
  windowMs: number = RATE_LIMIT_WINDOW_MS,
): RateLimitResult {
  const inWindow = timestamps
    .filter((t) => t > nowMs - windowMs && t <= nowMs)
    .sort((a, b) => a - b);
  if (inWindow.length < limit) return { allowed: true, retryAfterMs: 0 };
  const freeing = inWindow[inWindow.length - limit] as number;
  return { allowed: false, retryAfterMs: Math.max(1, freeing + windowMs - nowMs) };
}
