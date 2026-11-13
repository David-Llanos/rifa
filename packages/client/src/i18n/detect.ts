import { DEFAULT_LOCALE, type Locale } from "@raffle/shared";

/**
 * Select the initial Locale from browser language tags (Requirement 20.2).
 * The primary (first) tag decides: "es" or "es-*" gives Spanish, "en" or "en-*" gives
 * English, anything else (or no tags) gives English.
 */
export function detectLocale(languageTags: readonly string[]): Locale {
  const primary = languageTags[0]?.trim().toLowerCase();
  if (!primary) return DEFAULT_LOCALE;
  const base = primary.split(/[-_]/)[0];
  if (base === "es") return "es";
  if (base === "en") return "en";
  return DEFAULT_LOCALE;
}

/** Parse an Accept-Language header into tags ordered by descending quality (stable). */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params
        .map((p) => p.trim())
        .find((p) => p.startsWith("q="))
        ?.slice(2);
      const quality = q === undefined ? 1 : Number(q);
      return { tag: tag.trim(), quality: Number.isFinite(quality) ? quality : 0, index };
    })
    .filter((e) => e.tag !== "" && e.tag !== "*" && e.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index)
    .map((e) => e.tag);
}
