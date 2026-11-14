import type { Money } from "@raffle/shared";

export const KYC_MAX_ATTEMPTS = 3;
export const KYC_ATTEMPT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Winner verification must complete within 30 days of the draw (Requirement 13.8). */
export const WINNER_KYC_DEADLINE_MS = 30 * 24 * 60 * 60 * 1000;

/** A new attempt is allowed iff fewer than 3 attempts happened in the previous 24 hours (Req 13.2). */
export function kycAttemptAllowed(attempts: Date[], now: Date): boolean {
  const from = now.getTime() - KYC_ATTEMPT_WINDOW_MS;
  const recent = attempts.filter((a) => a.getTime() > from && a.getTime() <= now.getTime());
  return recent.length < KYC_MAX_ATTEMPTS;
}

/** Winner identity verification applies when the prize value is above the threshold (Req 13.7). */
export function winnerVerificationRequired(prize: Money, threshold: Money): boolean {
  return prize.currency === threshold.currency && prize.amountMinor > threshold.amountMinor;
}

export type DeliveryDecision =
  | { action: "release" }
  | { action: "wait"; deadline: Date }
  /** Withhold the delivery notification and notify the Player and an Admin (Req 13.8). */
  | { action: "withhold"; reason: "rejected" | "overdue" };

export function winnerDeliveryDecision(
  status: "approved" | "pending" | "rejected" | "error" | "none",
  drawAt: Date,
  now: Date,
): DeliveryDecision {
  if (status === "approved") return { action: "release" };
  if (status === "rejected") return { action: "withhold", reason: "rejected" };
  const deadline = new Date(drawAt.getTime() + WINNER_KYC_DEADLINE_MS);
  if (now.getTime() >= deadline.getTime()) return { action: "withhold", reason: "overdue" };
  return { action: "wait", deadline };
}
