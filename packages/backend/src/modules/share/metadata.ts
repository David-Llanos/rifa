import { DEFAULT_LOCALE, type Locale } from "@raffle/shared";
import type { LocalizedText } from "../raffle/types.js";

export const OG_TITLE_MAX = 70;
export const OG_DESCRIPTION_MAX = 200;
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;

/**
 * Text in the visitor's Locale, falling back to the platform default Locale, then to the
 * other language (Requirement 16.11). Blank text counts as missing.
 */
export function pickText(field: LocalizedText, visitor: Locale): string {
  const other: Locale = DEFAULT_LOCALE === "en" ? "es" : "en";
  for (const l of [visitor, DEFAULT_LOCALE, other]) {
    const t = field[l];
    if (typeof t === "string" && t.trim() !== "") return t.trim();
  }
  return "";
}

/** Truncate to at most `max` code points, ending in an ellipsis when shortened. */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  if (chars.length <= max) return chars.join("");
  return chars
    .slice(0, max - 1)
    .join("")
    .trimEnd()
    .concat("…");
}

export interface OgMeta {
  title: string;
  description: string;
}

export interface OgTags extends OgMeta {
  url: string;
  image: { url: string; width: number; height: number } | null;
  locale: Locale;
}

export function ogMeta(
  raffle: { title: LocalizedText; description: LocalizedText },
  locale: Locale,
): OgMeta {
  return {
    title: truncate(pickText(raffle.title, locale), OG_TITLE_MAX),
    description: truncate(pickText(raffle.description, locale), OG_DESCRIPTION_MAX),
  };
}

/** Resolves an image URL to a rendition of at least 1200 by 630 pixels. */
export type OgImageResolver = (imageUrl: string, width: number, height: number) => string;

export const defaultOgImageResolver: OgImageResolver = (imageUrl, width, height) => {
  const sep = imageUrl.includes("?") ? "&" : "?";
  return `${imageUrl}${sep}w=${width}&h=${height}&fit=cover`;
};

export function ogTags(
  raffle: { title: LocalizedText; description: LocalizedText; prizeImages: readonly string[] },
  locale: Locale,
  url: string,
  resolveImage: OgImageResolver = defaultOgImageResolver,
): OgTags {
  const first = raffle.prizeImages[0];
  return {
    ...ogMeta(raffle, locale),
    url,
    locale,
    image: first
      ? {
          url: resolveImage(first, OG_IMAGE_WIDTH, OG_IMAGE_HEIGHT),
          width: OG_IMAGE_WIDTH,
          height: OG_IMAGE_HEIGHT,
        }
      : null,
  };
}
