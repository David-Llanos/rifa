/** Supported UI and notification languages. */
export const LOCALES = ["en", "es"] as const;
export type Locale = (typeof LOCALES)[number];

/** Default when no preference or supported language can be detected. */
export const DEFAULT_LOCALE: Locale = "en";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Launch countries. */
export const COUNTRIES = ["CO", "US"] as const;
export type Country = (typeof COUNTRIES)[number];

export function isCountry(value: unknown): value is Country {
  return typeof value === "string" && (COUNTRIES as readonly string[]).includes(value);
}
