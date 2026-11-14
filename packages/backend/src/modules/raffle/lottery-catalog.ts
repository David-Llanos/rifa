/**
 * External_Lottery catalog and Winning_Rule selection (Requirements 9.1, 9.4, 9.5).
 *
 * Catalog entries are seed CONFIGURATION. Schedules, result formats and sources must be
 * verified against the official lottery before launch; no result endpoint or credential is
 * defined here (the Draw_Service adapter resolves `sourceKey` through configuration).
 */
import { fieldError, isCountry } from "@raffle/shared";
import type { Country, FieldError } from "@raffle/shared";
import { WINNING_RULES, type WinningRule } from "../draw/core.js";
import type { FallbackRule } from "./types.js";

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export interface DrawSchedule {
  readonly days: readonly Weekday[];
  /** Local wall-clock time, HH:mm. */
  readonly localTime: string;
  readonly tzName: string;
}

/** Shape of the official result, used to decide which Winning_Rules are applicable. */
export interface ResultFormat {
  readonly firstPrizeDigits: number;
  /** Present only when the lottery publishes a second prize number. */
  readonly secondPrizeDigits?: number;
}

export interface ExternalLottery {
  readonly id: string;
  readonly country: Country;
  readonly name: string;
  readonly drawSchedule: DrawSchedule;
  readonly resultFormat: ResultFormat;
  /** Key the Draw_Service uses to look up the configured result source. Not a URL. */
  readonly sourceKey: string;
  /** Always true for seed data: schedule, format and source must be confirmed before launch. */
  readonly needsVerification: boolean;
}

const seed = (l: Omit<ExternalLottery, "sourceKey" | "needsVerification">): ExternalLottery => ({
  ...l,
  sourceKey: `lottery:${l.id}`,
  needsVerification: true,
});

const BOGOTA = "America/Bogota";
const NEW_YORK = "America/New_York";

export const LOTTERY_CATALOG: readonly ExternalLottery[] = [
  seed({
    id: "co-bogota",
    country: "CO",
    name: "Lotería de Bogotá",
    drawSchedule: { days: ["thu"], localTime: "22:30", tzName: BOGOTA },
    resultFormat: { firstPrizeDigits: 4, secondPrizeDigits: 4 },
  }),
  seed({
    id: "co-medellin",
    country: "CO",
    name: "Lotería de Medellín",
    drawSchedule: { days: ["fri"], localTime: "22:30", tzName: BOGOTA },
    resultFormat: { firstPrizeDigits: 4, secondPrizeDigits: 4 },
  }),
  seed({
    id: "co-cundinamarca",
    country: "CO",
    name: "Lotería de Cundinamarca",
    drawSchedule: { days: ["mon"], localTime: "22:30", tzName: BOGOTA },
    resultFormat: { firstPrizeDigits: 4, secondPrizeDigits: 4 },
  }),
  seed({
    id: "co-valle",
    country: "CO",
    name: "Lotería del Valle",
    drawSchedule: { days: ["wed"], localTime: "22:30", tzName: BOGOTA },
    resultFormat: { firstPrizeDigits: 4, secondPrizeDigits: 4 },
  }),
  seed({
    id: "us-ny-numbers-evening",
    country: "US",
    name: "New York Lottery Numbers (evening)",
    drawSchedule: {
      days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      localTime: "22:30",
      tzName: NEW_YORK,
    },
    resultFormat: { firstPrizeDigits: 3 },
  }),
  seed({
    id: "us-fl-pick5-evening",
    country: "US",
    name: "Florida Lottery Pick 5 (evening)",
    drawSchedule: {
      days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      localTime: "23:15",
      tzName: NEW_YORK,
    },
    resultFormat: { firstPrizeDigits: 5 },
  }),
  seed({
    id: "us-ny-win4-evening",
    country: "US",
    name: "New York Lottery Win 4 (evening)",
    drawSchedule: {
      days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      localTime: "22:30",
      tzName: NEW_YORK,
    },
    resultFormat: { firstPrizeDigits: 4 },
  }),
];

/** Catalog of supported External_Lotteries for a country (Requirement 9.1). */
export function listLotteries(country: Country): ExternalLottery[] {
  return LOTTERY_CATALOG.filter((l) => l.country === country);
}

export function getLottery(id: string): ExternalLottery | undefined {
  return LOTTERY_CATALOG.find((l) => l.id === id);
}

/** Number of digits of Ticket numbers (0 to totalTickets - 1), at least 1 (Requirement 9.4). */
export function ticketNumberDigits(totalTickets: number): number {
  if (!Number.isInteger(totalTickets) || totalTickets < 1) {
    throw new RangeError("totalTickets must be a positive integer");
  }
  return Math.max(1, String(totalTickets - 1).length);
}

export interface WinningRuleOption {
  readonly id: WinningRule;
  /** N: equal to the number of digits of the Ticket numbers. */
  readonly digits: number;
}

function ruleSupported(rule: WinningRule, format: ResultFormat, digits: number): boolean {
  switch (rule) {
    case "LAST_N_DIGITS_OF_FIRST_PRIZE":
    case "FIRST_N_DIGITS_OF_FIRST_PRIZE":
      return format.firstPrizeDigits >= digits;
    case "LAST_N_DIGITS_OF_SECOND_PRIZE":
      return (format.secondPrizeDigits ?? 0) >= digits;
  }
}

/** Winning_Rules from the closed set that the lottery's result format can satisfy. */
export function availableWinningRules(
  lottery: ExternalLottery,
  totalTickets: number,
): WinningRuleOption[] {
  const digits = ticketNumberDigits(totalTickets);
  return WINNING_RULES.filter((r) => ruleSupported(r, lottery.resultFormat, digits)).map((id) => ({
    id,
    digits,
  }));
}

export interface LotterySelection {
  country: Country;
  lotteryId: string;
  totalTickets: number;
  winningRule: { id: string; params?: Record<string, unknown> };
  fallbackRule: string;
}

export const FALLBACK_RULES: readonly FallbackRule[] = ["lower", "higher", "redraw"];

/**
 * Validates the lottery, exactly one Winning_Rule and the fallback rule against the catalog.
 * Returns one error per invalid field; empty means valid.
 */
export function validateLotterySelection(sel: LotterySelection): FieldError[] {
  const errors: FieldError[] = [];

  if (!(FALLBACK_RULES as readonly string[]).includes(sel.fallbackRule)) {
    errors.push(fieldError("fallbackRule", "invalid"));
  }

  const idOk = typeof sel.lotteryId === "string" && sel.lotteryId.trim() !== "";
  if (!idOk) {
    errors.push(fieldError("lotteryId", "required"));
    return errors.concat(ruleShapeErrors(sel));
  }
  const lottery = getLottery(sel.lotteryId);
  if (!lottery || !isCountry(sel.country) || lottery.country !== sel.country) {
    errors.push(fieldError("lotteryId", "unsupported"));
    return errors.concat(ruleShapeErrors(sel));
  }

  const ruleId = sel.winningRule?.id;
  if (typeof ruleId !== "string" || ruleId === "") {
    errors.push(fieldError("winningRule", "required"));
    return errors;
  }
  if (!(WINNING_RULES as readonly string[]).includes(ruleId)) {
    errors.push(fieldError("winningRule", "unsupported"));
    return errors;
  }
  if (!Number.isInteger(sel.totalTickets) || sel.totalTickets < 1) return errors;

  const digits = ticketNumberDigits(sel.totalTickets);
  if (!ruleSupported(ruleId as WinningRule, lottery.resultFormat, digits)) {
    errors.push(fieldError("winningRule", "not_applicable", { lotteryId: lottery.id, digits }));
    return errors;
  }
  const given = sel.winningRule.params?.["digits"];
  if (given !== undefined && given !== digits) {
    errors.push(fieldError("winningRule", "digits_mismatch", { digits }));
  }
  return errors;
}

function ruleShapeErrors(sel: LotterySelection): FieldError[] {
  const id = sel.winningRule?.id;
  if (typeof id !== "string" || id === "") return [fieldError("winningRule", "required")];
  if (!(WINNING_RULES as readonly string[]).includes(id)) {
    return [fieldError("winningRule", "unsupported")];
  }
  return [];
}

/** What the Share_Page shows before any Ticket is sold (Requirement 9.5). */
export interface ShareLotteryInfo {
  readonly lotteryId: string;
  readonly lotteryName: string;
  readonly winningRule: WinningRule;
  readonly winningRuleDigits: number;
  readonly fallbackRule: FallbackRule;
  readonly drawAt: string;
}

export function shareLotteryInfo(raffle: {
  lotteryId: string;
  totalTickets: number;
  winningRule: { id: string };
  fallbackRule: FallbackRule;
  drawAt: Date;
}): ShareLotteryInfo {
  const lottery = getLottery(raffle.lotteryId);
  return {
    lotteryId: raffle.lotteryId,
    lotteryName: lottery?.name ?? raffle.lotteryId,
    winningRule: raffle.winningRule.id as WinningRule,
    winningRuleDigits: ticketNumberDigits(raffle.totalTickets),
    fallbackRule: raffle.fallbackRule,
    drawAt: raffle.drawAt.toISOString(),
  };
}
