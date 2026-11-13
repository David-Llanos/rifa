import { CURRENCY_DECIMALS, type Locale, type Money } from "@raffle/shared";

/** BCP 47 tags used for number and date conventions per UI Locale. */
export const INTL_LOCALE: Readonly<Record<Locale, string>> = { en: "en-US", es: "es-CO" };

function toDecimalString(m: Money): { text: string; hasFraction: boolean } {
  const decimals = CURRENCY_DECIMALS[m.currency];
  const negative = m.amountMinor < 0n;
  const abs = negative ? -m.amountMinor : m.amountMinor;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, "0");
  const text = `${negative ? "-" : ""}${whole.toString()}.${frac}`;
  return { text, hasFraction: abs % scale !== 0n };
}

/**
 * Format an amount using the Locale's number conventions while always showing the raffle
 * currency code (COP or USD) regardless of Locale (Requirement 20.5). Exact: the bigint
 * minor units are converted to a decimal string, never through floating point.
 */
export function formatMoney(m: Money, locale: Locale): string {
  const { text, hasFraction } = toDecimalString(m);
  const decimals = CURRENCY_DECIMALS[m.currency];
  const fractionDigits = m.currency === "USD" || hasFraction ? decimals : 0;
  return new Intl.NumberFormat(INTL_LOCALE[locale], {
    style: "currency",
    currency: m.currency,
    currencyDisplay: "code",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(text as unknown as number);
}

export function formatNumber(value: number | bigint, locale: Locale): string {
  return new Intl.NumberFormat(INTL_LOCALE[locale]).format(value);
}

export function formatDate(
  date: Date,
  locale: Locale,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" },
): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], options).format(date);
}
