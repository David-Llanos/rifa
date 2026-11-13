import { COUNTRY_CURRENCY, fieldError, isCountry, isLocale, isValidTimeZone } from "@raffle/shared";
import type { FieldError } from "@raffle/shared";
import {
  LOCKED_FIELDS_AFTER_SALE,
  RAFFLE_BOUNDS as B,
  type LocalizedText,
  type Raffle,
  type RaffleInput,
} from "./types.js";

const FALLBACKS = ["lower", "higher", "redraw"];

const len = (s: string): number => [...s].length;
const isValidDate = (d: unknown): d is Date => d instanceof Date && !Number.isNaN(d.getTime());
const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

function validateLocalized(
  name: "title" | "description",
  text: LocalizedText | undefined,
  max: number,
): FieldError[] {
  const errors: FieldError[] = [];
  const present = (["en", "es"] as const).filter((l) => (text?.[l] ?? "").trim().length > 0);
  if (present.length === 0) {
    errors.push(fieldError(name, "required", { min: 1, max }));
    return errors;
  }
  for (const l of present) {
    const v = text?.[l] ?? "";
    if (len(v) > max) errors.push(fieldError(`${name}.${l}`, "length", { min: 1, max }));
  }
  return errors;
}

/** Requirement 9.2, 9.3: the draw must be later than the deadline. */
export function validateDrawTime(deadline: Date, drawAt: Date): FieldError | null {
  if (!isValidDate(drawAt)) return fieldError("drawAt", "required");
  if (!isValidDate(deadline)) return null;
  if (drawAt.getTime() <= deadline.getTime()) {
    return fieldError("drawAt", "after_deadline", { deadline: deadline.toISOString() });
  }
  return null;
}

/**
 * Validate a full raffle submission (Requirements 2.1 to 2.9, 9.2, 9.3, 20.9).
 * Returns one error per invalid field; an empty array means valid.
 */
export function validateRaffle(input: RaffleInput, now: Date): FieldError[] {
  const e: FieldError[] = [];

  e.push(...validateLocalized("title", input.title, B.titleMax));
  e.push(...validateLocalized("description", input.description, B.descriptionMax));

  if (!isLocale(input.defaultLocale)) e.push(fieldError("defaultLocale", "required"));

  const images = input.prizeImages;
  if (!Array.isArray(images) || images.length < B.imagesMin || images.length > B.imagesMax) {
    e.push(fieldError("prizeImages", "count", { min: B.imagesMin, max: B.imagesMax }));
  } else if (images.some((i) => typeof i !== "string" || i.trim() === "")) {
    e.push(fieldError("prizeImages", "invalid"));
  }

  if (typeof input.prizeValueMinor !== "bigint" || input.prizeValueMinor <= 0n) {
    e.push(fieldError("prizeValueMinor", "positive"));
  }

  const countryOk = isCountry(input.country);
  if (!countryOk) e.push(fieldError("country", "required"));

  // Currency per country (2.5, 2.6)
  if (countryOk) {
    const required = COUNTRY_CURRENCY[input.country];
    if (input.currency !== required) e.push(fieldError("currency", "currency", { required }));
  } else if (typeof input.currency !== "string" || input.currency === "") {
    e.push(fieldError("currency", "required"));
  }

  if (typeof input.ticketPriceMinor !== "bigint" || input.ticketPriceMinor <= 0n) {
    e.push(fieldError("ticketPriceMinor", "positive"));
  }

  // Total tickets (2.3, 2.4)
  const totalOk = isInt(input.totalTickets) && input.totalTickets >= B.ticketsMin && input.totalTickets <= B.ticketsMax;
  if (!totalOk) e.push(fieldError("totalTickets", "range", { min: B.ticketsMin, max: B.ticketsMax }));

  // Deadline at least now + 24 h (2.7)
  if (!isValidDate(input.deadline)) {
    e.push(fieldError("deadline", "required"));
  } else {
    const min = new Date(now.getTime() + B.minDeadlineLeadMs);
    if (input.deadline.getTime() < min.getTime()) {
      e.push(fieldError("deadline", "min_lead", { min: min.toISOString() }));
    }
  }

  if (typeof input.tzName !== "string" || !isValidTimeZone(input.tzName)) {
    e.push(fieldError("tzName", "invalid"));
  }

  // Threshold (2.8) and per-player limit (2.9) bounded by total tickets
  if (input.minThreshold !== undefined && input.minThreshold !== null) {
    const max = totalOk ? input.totalTickets : B.ticketsMax;
    if (!isInt(input.minThreshold) || input.minThreshold < 1 || input.minThreshold > max) {
      e.push(fieldError("minThreshold", "range", { min: 1, max }));
    }
  }
  if (input.maxPerPlayer !== undefined && input.maxPerPlayer !== null) {
    const max = totalOk ? input.totalTickets : B.ticketsMax;
    if (!isInt(input.maxPerPlayer) || input.maxPerPlayer < 1 || input.maxPerPlayer > max) {
      e.push(fieldError("maxPerPlayer", "range", { min: 1, max }));
    }
  }

  if (typeof input.lotteryId !== "string" || input.lotteryId.trim() === "") {
    e.push(fieldError("lotteryId", "required"));
  }
  if (!input.winningRule || typeof input.winningRule.id !== "string" || input.winningRule.id === "") {
    e.push(fieldError("winningRule", "required"));
  }
  if (!FALLBACKS.includes(input.fallbackRule)) e.push(fieldError("fallbackRule", "invalid"));

  const drawErr = validateDrawTime(input.deadline, input.drawAt);
  if (drawErr) e.push(drawErr);

  return e;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}

/**
 * Requirement 2.11: once at least one ticket is sold, price, total count, deadline,
 * lottery and winning rule cannot change. Fields absent from the patch are unchanged.
 */
export function validateEdit(
  existing: Raffle,
  patch: Partial<RaffleInput>,
  soldCount: number,
): FieldError[] {
  if (soldCount <= 0) return [];
  const errors: FieldError[] = [];
  for (const f of LOCKED_FIELDS_AFTER_SALE) {
    if (patch[f] !== undefined && !sameValue(patch[f], existing[f])) {
      errors.push(fieldError(f, "locked_after_sale"));
    }
  }
  return errors;
}
