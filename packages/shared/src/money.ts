import type { Country } from "./locale.js";

/** Supported ISO 4217 currencies. */
export const CURRENCIES = ["COP", "USD"] as const;
export type Currency = (typeof CURRENCIES)[number];

/**
 * Money as integer minor units plus currency. Never use floating point for amounts.
 * Minor units: USD cents (2 decimals); COP centavos (2 decimals in ISO 4217, usually zero in practice).
 */
export interface Money {
  readonly amountMinor: bigint;
  readonly currency: Currency;
}

/** Number of minor-unit decimals per currency (ISO 4217). */
export const CURRENCY_DECIMALS: Readonly<Record<Currency, number>> = {
  COP: 2,
  USD: 2,
};

/** Currency required for raffles in each country (Requirement 2.5). */
export const COUNTRY_CURRENCY: Readonly<Record<Country, Currency>> = {
  CO: "COP",
  US: "USD",
};

export function isCurrency(value: unknown): value is Currency {
  return typeof value === "string" && (CURRENCIES as readonly string[]).includes(value);
}

export function currencyForCountry(country: Country): Currency {
  return COUNTRY_CURRENCY[country];
}

export function money(amountMinor: bigint, currency: Currency): Money {
  if (typeof amountMinor !== "bigint") {
    throw new TypeError("amountMinor must be a bigint");
  }
  if (!isCurrency(currency)) {
    throw new TypeError(`unsupported currency: ${String(currency)}`);
  }
  return { amountMinor, currency };
}

export function zero(currency: Currency): Money {
  return money(0n, currency);
}

export function isPositive(m: Money): boolean {
  return m.amountMinor > 0n;
}

export function sameCurrency(a: Money, b: Money): boolean {
  return a.currency === b.currency;
}
