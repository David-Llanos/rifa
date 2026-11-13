/** Signals available when a purchase is initiated (Requirement 15.1). */
export interface PurchaseContext {
  orderId: string;
  reservationId: string;
  raffleId: string;
  userId: string;
  ip: string;
  deviceId: string;
  /** Device signals. */
  deviceIsNew: boolean;
  usersOnDevice: number;
  /** IP signals. */
  ipFlagged: boolean;
  usersOnIp: number;
  /** Velocity: purchases by this user in the last hour. */
  purchasesLastHour: number;
  /** Payment history. */
  failedPaymentsLast30d: number;
  chargebacksLast365d: number;
  accountAgeDays: number;
}

export interface FraudScorer {
  score(ctx: PurchaseContext): Promise<number>;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** Deterministic weighted risk score, an integer from 0 to 100. */
export function computeRiskScore(ctx: PurchaseContext): number {
  let s = 0;
  if (ctx.deviceIsNew) s += 5;
  s += clamp(ctx.usersOnDevice - 1, 0, 5) * 6;
  if (ctx.ipFlagged) s += 25;
  s += clamp(ctx.usersOnIp - 1, 0, 5) * 4;
  s += clamp(ctx.purchasesLastHour - 3, 0, 10) * 3;
  s += clamp(ctx.failedPaymentsLast30d, 0, 5) * 5;
  s += clamp(ctx.chargebacksLast365d, 0, 3) * 15;
  if (ctx.accountAgeDays < 1) s += 10;
  return clamp(Math.round(s), 0, 100);
}

export const ruleBasedScorer: FraudScorer = {
  score: (ctx) => Promise.resolve(computeRiskScore(ctx)),
};

/** Target for producing a risk score (Requirement 15.1). */
export const SCORE_TARGET_MS = 2000;
/** Beyond this the order is held for review (Requirement 15.4). */
export const SCORE_TIMEOUT_MS = 5000;

/**
 * Runs the scorer with a deadline. Returns `"error"` on timeout, rejection, or a result that is not an
 * integer from 0 to 100, so `decide` holds the order for review.
 */
export async function scoreWithTimeout(
  scorer: FraudScorer,
  ctx: PurchaseContext,
  timeoutMs: number = SCORE_TIMEOUT_MS,
): Promise<number | "error"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"error">((resolve) => {
    timer = setTimeout(() => resolve("error"), timeoutMs);
  });
  try {
    const result = await Promise.race([scorer.score(ctx).catch((): "error" => "error"), timeout]);
    if (result === "error") return "error";
    return Number.isInteger(result) && result >= 0 && result <= 100 ? result : "error";
  } catch {
    return "error";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
