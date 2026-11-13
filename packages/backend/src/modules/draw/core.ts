/**
 * Draw_Service pure core: winning number derivation and winner resolution.
 * Requirements 9.7, 9.8, 9.9, 9.10.
 */

/** Official External_Lottery result. Prize numbers are digit strings (leading zeros preserved). */
export interface LotteryResult {
  readonly lotteryId: string;
  readonly drawAt: Date;
  readonly firstPrize: string;
  readonly secondPrize?: string;
}

/** Closed set of Winning_Rules. */
export const WINNING_RULES = [
  "LAST_N_DIGITS_OF_FIRST_PRIZE",
  "FIRST_N_DIGITS_OF_FIRST_PRIZE",
  "LAST_N_DIGITS_OF_SECOND_PRIZE",
] as const;
export type WinningRule = (typeof WINNING_RULES)[number];

export type FallbackRule = "lower" | "higher" | "redraw";

export type WinnerResolution =
  | { kind: "winner"; ticket: number }
  | { kind: "redraw" }
  | { kind: "none" };

function digitsOf(value: string | undefined): string {
  const d = (value ?? "").replace(/\D/g, "");
  if (d.length === 0) throw new RangeError("lottery result has no digits for the selected rule");
  return d;
}

/**
 * Deterministically derives the winning ticket number (0 to 10^digits - 1) from a lottery result.
 * Prize numbers shorter than `digits` are left-padded with zeros.
 */
export function deriveWinningNumber(
  result: LotteryResult,
  rule: WinningRule,
  digits: number,
): number {
  if (!Number.isInteger(digits) || digits < 1 || digits > 15) {
    throw new RangeError("digits must be an integer from 1 to 15");
  }
  let source: string;
  switch (rule) {
    case "LAST_N_DIGITS_OF_FIRST_PRIZE":
      source = digitsOf(result.firstPrize).padStart(digits, "0").slice(-digits);
      break;
    case "FIRST_N_DIGITS_OF_FIRST_PRIZE":
      source = digitsOf(result.firstPrize).padStart(digits, "0").slice(0, digits);
      break;
    case "LAST_N_DIGITS_OF_SECOND_PRIZE":
      source = digitsOf(result.secondPrize).padStart(digits, "0").slice(-digits);
      break;
    default:
      throw new RangeError("unknown winning rule");
  }
  return Number(source);
}

/**
 * Resolves the winner: exact match on a sold ticket wins; otherwise the owner's fallback applies.
 * "lower"/"higher" pick the nearest sold ticket in that direction, or `none` if there is none.
 * "redraw" defers to the next External_Lottery draw.
 */
export function resolveWinner(
  derived: number,
  sold: ReadonlySet<number>,
  fallback: FallbackRule,
): WinnerResolution {
  if (sold.has(derived)) return { kind: "winner", ticket: derived };
  if (fallback === "redraw") return { kind: "redraw" };
  let best: number | undefined;
  for (const n of sold) {
    if (fallback === "lower" && n < derived && (best === undefined || n > best)) best = n;
    if (fallback === "higher" && n > derived && (best === undefined || n < best)) best = n;
  }
  return best === undefined ? { kind: "none" } : { kind: "winner", ticket: best };
}
