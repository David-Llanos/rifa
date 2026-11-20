import type { InventoryRaffle, TicketCounts, TicketListRow } from "./types.js";

export interface NewOrder {
  id: string;
  raffleId: string;
  playerId: string;
  numbers: number[];
  totalMinor: bigint;
  currency: string;
}

/** Persistence port for the inventory service. Every method runs inside the caller's transaction. */
export interface InventoryRepository<Tx> {
  /** Run `fn` in one DB transaction; any throw rolls everything back. */
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Load the raffle with a shared row lock (so a status change cannot interleave). */
  getRaffleShared(tx: Tx, raffleId: string): Promise<InventoryRaffle | null>;
  /** Serialize concurrent checkouts of one player in one raffle so the per-player limit holds. */
  lockPlayer(tx: Tx, raffleId: string, playerId: string): Promise<void>;
  /** Tickets of the raffle currently reserved or sold for the player. */
  heldCount(tx: Tx, raffleId: string, playerId: string): Promise<number>;
  createOrder(tx: Tx, order: NewOrder): Promise<void>;
  /**
   * Conditional update: sets each requested number to reserved only if it is still available, and returns
   * the numbers that were actually reserved.
   */
  reserveNumbers(
    tx: Tx,
    raffleId: string,
    orderId: string,
    numbers: number[],
    expiresAt: Date,
  ): Promise<number[]>;
  /** Releases the order's reserved tickets and deletes the order (used to undo a partial attempt). */
  abandonOrder(tx: Tx, orderId: string): Promise<void>;
  listAvailable(tx: Tx, raffleId: string): Promise<number[]>;
  /** Releases reserved tickets whose reservation expired at or before `now`; returns the count. */
  releaseExpired(tx: Tx, now: Date): Promise<number>;
  /** Sets every ticket of the raffle to cancelled (raffle cancellation, Req 8.6); returns the count changed. */
  cancelAll(tx: Tx, raffleId: string): Promise<number>;
  counts(tx: Tx, raffleId: string): Promise<TicketCounts>;
  /** Every ticket of the raffle ordered by number, with buyer name and purchase time for sold ones. */
  listTickets(tx: Tx, raffleId: string): Promise<TicketListRow[]>;
  /** Creates tickets 1..total as available (idempotent). Returns the number inserted. */
  seedTickets(tx: Tx, raffleId: string, total: number): Promise<number>;
}
