import type { RaffleStatus } from "../raffle/types.js";

export type TicketStatus = "available" | "reserved" | "sold" | "cancelled";

export interface TicketCounts {
  available: number;
  reserved: number;
  sold: number;
  cancelled: number;
}

/** The raffle fields the inventory service needs, loaded under a row lock. */
export interface InventoryRaffle {
  status: RaffleStatus;
  totalTickets: number;
  ticketPriceMinor: bigint;
  currency: string;
  maxPerPlayer: number | null;
  deadline: Date;
}

export interface Reservation {
  orderId: string;
  raffleId: string;
  playerId: string;
  numbers: number[];
  expiresAt: Date;
}

/** Maximum Tickets per checkout (Requirement 5.1). */
export const MAX_TICKETS_PER_CHECKOUT = 100;

/** Default Reservation_Timeout: 10 minutes. */
export const DEFAULT_RESERVATION_TIMEOUT_MS = 10 * 60 * 1000;

export type InventoryError =
  | { kind: "not_found" }
  | { kind: "unavailable"; numbers: number[] }
  | { kind: "sales_closed" }
  | { kind: "cancelled" }
  | { kind: "not_on_sale" }
  | { kind: "limit_exceeded"; max: number; held: number; requested: number }
  | { kind: "invalid_selection" };
