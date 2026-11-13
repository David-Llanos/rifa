import type { Locale } from "./locale.js";

/** Time zone helpers built on Intl (IANA zones). Requirement 7.10. */

export interface LocalDateTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock fields of an instant in the given zone. */
export function utcToZoned(date: Date, tz: string): LocalDateTime {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(date);
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

function asUtcMs(l: LocalDateTime): number {
  const d = new Date(Date.UTC(2000, l.month - 1, l.day, l.hour, l.minute, l.second));
  d.setUTCFullYear(l.year);
  return d.getTime();
}

/**
 * Convert a jurisdiction-local wall-clock time to a UTC instant.
 * Nonexistent local times (DST gap) resolve forward; ambiguous times (DST overlap) resolve to the earlier instant.
 */
export function zonedToUtc(local: LocalDateTime, tz: string): Date {
  const wanted = asUtcMs(local);
  const offsetAt = (ms: number): number => asUtcMs(utcToZoned(new Date(ms), tz)) - Math.floor(ms / 1000) * 1000;
  // Try both candidate offsets around the target to handle DST transitions.
  const o1 = offsetAt(wanted - 86400000);
  const o2 = offsetAt(wanted + 86400000);
  const candidates = [...new Set([o1, o2])].map((o) => wanted - o);
  const valid = candidates.filter((c) => asUtcMs(utcToZoned(new Date(c), tz)) === wanted);
  if (valid.length > 0) return new Date(Math.min(...valid));
  // Gap: use the offset before the transition, which moves the time forward.
  return new Date(wanted - o1);
}

/** Offset of a zone at an instant in minutes east of UTC. */
export function offsetMinutes(date: Date, tz: string): number {
  return Math.round((asUtcMs(utcToZoned(date, tz)) - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** "UTC-05:00" style offset label. */
export function formatOffset(date: Date, tz: string): string {
  const min = offsetMinutes(date, tz);
  const sign = min < 0 ? "-" : "+";
  const abs = Math.abs(min);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `UTC${sign}${hh}:${mm}`;
}

/**
 * Display an instant in the viewer's zone. Output always includes the zone name
 * (IANA id) and the numeric offset, e.g. "2025-03-01 14:30 America/Bogota (UTC-05:00)".
 */
export function formatInZone(date: Date, tz: string, locale: Locale = "en"): string {
  const text = new Intl.DateTimeFormat(locale === "es" ? "es-CO" : "en-US", {
    timeZone: tz,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
  return `${text} ${tz} (${formatOffset(date, tz)})`;
}

/** Convert a jurisdiction-local deadline to UTC, then render it in the viewer's zone. */
export function deadlineForViewer(
  local: LocalDateTime,
  jurisdictionTz: string,
  viewerTz: string,
  locale: Locale = "en",
): { utc: Date; display: string } {
  const utc = zonedToUtc(local, jurisdictionTz);
  return { utc, display: formatInZone(utc, viewerTz, locale) };
}
