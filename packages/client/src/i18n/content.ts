import type { Locale } from "@raffle/shared";

/** Owner-entered bilingual field (Requirement 20.9). */
export interface BilingualField {
  en?: string | undefined;
  es?: string | undefined;
}

/**
 * Pick the visitor-locale text, else the other language (Requirement 20.10).
 * Empty or whitespace-only text counts as missing. Returns undefined if both are missing.
 */
export function pickContent(field: BilingualField, visitor: Locale): string | undefined {
  const other: Locale = visitor === "en" ? "es" : "en";
  const has = (s: string | undefined): s is string => typeof s === "string" && s.trim() !== "";
  const primary = field[visitor];
  if (has(primary)) return primary;
  const secondary = field[other];
  return has(secondary) ? secondary : undefined;
}
