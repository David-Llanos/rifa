import { CURRENCY_DECIMALS, money, type Currency, type Money } from "./money.js";

function assertSame(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new RangeError(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSame(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSame(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

export function sum(items: readonly Money[], currency: Currency): Money {
  return items.reduce((acc, m) => add(acc, m), money(0n, currency));
}

export function negate(m: Money): Money {
  return money(-m.amountMinor, m.currency);
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSame(a, b);
  return a.amountMinor < b.amountMinor ? -1 : a.amountMinor > b.amountMinor ? 1 : 0;
}

/** Integer division rounding half away from zero. Denominator must be non-zero. */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError("division by zero");
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  const negative = numerator < 0n;
  const n = negative ? -numerator : numerator;
  const q = (2n * n + denominator) / (2n * denominator);
  return negative ? -q : q;
}

/** Multiply by an integer quantity (exact). */
export function multiply(m: Money, qty: bigint | number): Money {
  const q = typeof qty === "bigint" ? qty : BigInt(qty);
  return money(m.amountMinor * q, m.currency);
}

/** Multiply by a ratio, rounding the result to whole minor units (half away from zero). */
export function mulRatio(m: Money, numerator: bigint, denominator: bigint): Money {
  return money(divRoundHalfUp(m.amountMinor * numerator, denominator), m.currency);
}

const DECIMAL_RE = /^([+-])?(\d+)(?:\.(\d+))?$/;

/** Parse a decimal string into a scaled integer: value = units / 10^scale. */
function parseScaled(s: string): { units: bigint; scale: number } {
  const match = DECIMAL_RE.exec(s.trim());
  if (!match) throw new SyntaxError(`invalid decimal: ${s}`);
  const [, sign, whole, frac = ""] = match;
  const units = BigInt(whole + frac);
  return { units: sign === "-" ? -units : units, scale: frac.length };
}

/** Multiply by an exact decimal factor such as "0.0295" (a rate); rounds to whole minor units. */
export function mulDecimal(m: Money, factor: string): Money {
  const { units, scale } = parseScaled(factor);
  return mulRatio(m, units, 10n ** BigInt(scale));
}

/** Percentage of an amount, e.g. percentOf(m, "2.5"); rounds to whole minor units. */
export function percentOf(m: Money, percent: string): Money {
  const { units, scale } = parseScaled(percent);
  return mulRatio(m, units, 100n * 10n ** BigInt(scale));
}

/**
 * Parse a major-unit decimal string ("12.5", "1000") into Money, rounding to the
 * currency's decimals (2) with half-up rounding.
 */
export function parseMoney(s: string, currency: Currency): Money {
  const { units, scale } = parseScaled(s);
  const d = CURRENCY_DECIMALS[currency];
  const minor =
    scale <= d
      ? units * 10n ** BigInt(d - scale)
      : divRoundHalfUp(units, 10n ** BigInt(scale - d));
  return money(minor, currency);
}

/** Round an arbitrary-precision decimal string to 2 decimals (half away from zero), as a string. */
export function roundDecimal2(s: string): string {
  const { units, scale } = parseScaled(s);
  const minor = scale <= 2 ? units * 10n ** BigInt(2 - scale) : divRoundHalfUp(units, 10n ** BigInt(scale - 2));
  return minorToDecimalString(minor, 2);
}

function minorToDecimalString(minor: bigint, decimals: number): string {
  const negative = minor < 0n;
  const abs = (negative ? -minor : minor).toString().padStart(decimals + 1, "0");
  const whole = abs.slice(0, abs.length - decimals);
  const frac = abs.slice(abs.length - decimals);
  return `${negative ? "-" : ""}${whole}${decimals > 0 ? "." + frac : ""}`;
}

/** Exact major-unit decimal string, e.g. 1050n USD -> "10.50". */
export function toDecimalString(m: Money): string {
  return minorToDecimalString(m.amountMinor, CURRENCY_DECIMALS[m.currency]);
}
