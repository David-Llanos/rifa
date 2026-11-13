import type { Country, Locale } from "@raffle/shared";

export const RAFFLE_STATUSES = [
  "draft",
  "pending_review",
  "published",
  "sales_closed",
  "awaiting_draw",
  "completed",
  "cancelled",
] as const;
export type RaffleStatus = (typeof RAFFLE_STATUSES)[number];

export type FallbackRule = "lower" | "higher" | "redraw";

/** Bilingual text; at least one language must be present (Requirement 20.9). */
export interface LocalizedText {
  en?: string;
  es?: string;
}

/** Owner-submitted raffle configuration. Money fields are bigint minor units. */
export interface RaffleInput {
  title: LocalizedText;
  description: LocalizedText;
  defaultLocale: Locale;
  prizeImages: string[];
  prizeValueMinor: bigint;
  country: Country;
  currency: string;
  totalTickets: number;
  ticketPriceMinor: bigint;
  deadline: Date;
  tzName: string;
  minThreshold?: number;
  maxPerPlayer?: number;
  numberSelection: boolean;
  earlyClosure: boolean;
  lotteryId: string;
  drawAt: Date;
  winningRule: { id: string; params?: Record<string, unknown> };
  fallbackRule: FallbackRule;
}

export interface Raffle extends RaffleInput {
  id: string;
  ownerId: string;
  status: RaffleStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** Fields that cannot change once a ticket has been sold (Requirement 2.11). */
export const LOCKED_FIELDS_AFTER_SALE = [
  "ticketPriceMinor",
  "totalTickets",
  "deadline",
  "lotteryId",
  "winningRule",
] as const satisfies readonly (keyof RaffleInput)[];

export const RAFFLE_BOUNDS = {
  titleMax: 100,
  descriptionMax: 5000,
  imagesMin: 1,
  imagesMax: 10,
  ticketsMin: 10,
  ticketsMax: 100_000,
  minDeadlineLeadMs: 24 * 60 * 60 * 1000,
} as const;
