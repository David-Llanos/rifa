import { err, ok } from "@raffle/shared";
import type { Result, Rng } from "@raffle/shared";
import {
  MAX_TICKETS_PER_CHECKOUT,
  type InventoryError,
  type InventoryRaffle,
  type TicketCounts,
} from "./types.js";

/**
 * Picks `qty` distinct numbers uniformly at random from `available` (partial Fisher-Yates on a copy).
 * Returns null when fewer than `qty` numbers are available or `qty` is not a positive integer.
 */
export function pickRandomAvailable(
  available: readonly number[],
  qty: number,
  rng: Rng,
): number[] | null {
  if (!Number.isInteger(qty) || qty < 1 || qty > available.length) return null;
  const pool = [...available];
  for (let i = 0; i < qty; i++) {
    const j = i + rng.nextInt(pool.length - i);
    const tmp = pool[i] as number;
    pool[i] = pool[j] as number;
    pool[j] = tmp;
  }
  return pool.slice(0, qty);
}

/** Checks that a quantity is an integer in 1..100 (Requirement 5.1). */
export function validQuantity(qty: number): boolean {
  return Number.isInteger(qty) && qty >= 1 && qty <= MAX_TICKETS_PER_CHECKOUT;
}

/** Checks a requested number list: 1..100 distinct integers inside 1..totalTickets. */
export function validSelection(numbers: readonly number[], totalTickets: number): boolean {
  if (!validQuantity(numbers.length)) return false;
  const seen = new Set<number>();
  for (const n of numbers) {
    if (!Number.isInteger(n) || n < 1 || n > totalTickets || seen.has(n)) return false;
    seen.add(n);
  }
  return true;
}

/** Whether the raffle currently accepts reservations; otherwise the typed rejection (Req 7.3, 8.6). */
export function checkOnSale(raffle: InventoryRaffle, now: Date): Result<true, InventoryError> {
  if (raffle.status === "cancelled") return err({ kind: "cancelled" });
  if (
    raffle.status === "sales_closed" ||
    raffle.status === "awaiting_draw" ||
    raffle.status === "completed"
  ) {
    return err({ kind: "sales_closed" });
  }
  if (raffle.status !== "published") return err({ kind: "not_on_sale" });
  if (raffle.deadline.getTime() <= now.getTime()) return err({ kind: "sales_closed" });
  return ok(true);
}

/** Per-player limit: tickets already held (reserved or sold) plus the request must not exceed the limit. */
export function checkPlayerLimit(
  raffle: InventoryRaffle,
  held: number,
  requested: number,
): Result<true, InventoryError> {
  const max = raffle.maxPerPlayer;
  if (max !== null && held + requested > max) {
    return err({ kind: "limit_exceeded", max, held, requested });
  }
  return ok(true);
}

export function totalCount(c: TicketCounts): number {
  return c.available + c.reserved + c.sold + c.cancelled;
}
