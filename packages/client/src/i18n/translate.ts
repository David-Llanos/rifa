import { DEFAULT_LOCALE, type Locale } from "@raffle/shared";
import en from "./messages/en.json";
import es from "./messages/es.json";

export type Messages = Readonly<Record<string, string>>;

export const MESSAGES: Readonly<Record<Locale, Messages>> = { en, es };

export type MessageKey = keyof typeof en;

export type MissingKeyLogger = (info: { key: string; locale: Locale }) => void;

export type TranslateParams = Readonly<Record<string, string | number>>;
export type Translate = (key: string, params?: TranslateParams) => string;

function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

/**
 * Create a translator for a Locale. A key missing in the Locale falls back to English
 * and is logged at most once per key and Locale per translator (session) (Requirement 20.7).
 * A key missing in English too returns the key itself.
 */
export function createTranslator(
  locale: Locale,
  options: {
    messages?: Readonly<Record<Locale, Messages>>;
    logMissing?: MissingKeyLogger;
    /** Shared across translators so the once-per-session guarantee survives locale switches. */
    reported?: Set<string>;
  } = {},
): Translate {
  const messages = options.messages ?? MESSAGES;
  const logMissing =
    options.logMissing ??
    (({ key, locale: l }) => console.warn(`[i18n] missing translation key "${key}" for locale "${l}"`));
  const reported = options.reported ?? new Set<string>();
  return (key, params) => {
    const own = messages[locale][key];
    if (own !== undefined) return interpolate(own, params);
    const marker = `${locale}\u0000${key}`;
    if (!reported.has(marker)) {
      reported.add(marker);
      logMissing({ key, locale });
    }
    const fallback = messages[DEFAULT_LOCALE][key];
    return interpolate(fallback ?? key, params);
  };
}

/** Keys present in one resource file but not the other (Requirement 20.8 parity check). */
export function keyParityDiff(
  messages: Readonly<Record<Locale, Messages>> = MESSAGES,
): { missingInEs: string[]; missingInEn: string[] } {
  const enKeys = new Set(Object.keys(messages.en));
  const esKeys = new Set(Object.keys(messages.es));
  return {
    missingInEs: [...enKeys].filter((k) => !esKeys.has(k)).sort(),
    missingInEn: [...esKeys].filter((k) => !enKeys.has(k)).sort(),
  };
}
