import { err, ok, systemClock } from "@raffle/shared";
import type { Clock, Result, Rng } from "@raffle/shared";
import {
  checkOnSale,
  checkPlayerLimit,
  pickRandomAvailable,
  validQuantity,
  validSelection,
} from "./core.js";
import type { InventoryRepository } from "./repository.js";
import {
  DEFAULT_RESERVATION_TIMEOUT_MS,
  type InventoryError,
  type InventoryRaffle,
  type Reservation,
  type TicketCounts,
} from "./types.js";

export interface InventoryServiceDeps<Tx> {
  repo: InventoryRepository<Tx>;
  rng: Rng;
  newId: () => string;
  clock?: Clock;
  /** Reservation_Timeout in milliseconds; defaults to 10 minutes. */
  reservationTimeoutMs?: number;
  /** Called after a committed ticket status change, e.g. `CountsPublisher.changed` (Req 4.3). */
  countsChanged?: (raffleId: string) => void;
}

export interface InventoryService<Tx> {
  /** All-or-nothing reservation of specific numbers (Req 5.1, 5.3, 5.4). */
  reserve(
    raffleId: string,
    playerId: string,
    numbers: number[],
  ): Promise<Result<Reservation, InventoryError>>;
  /** Reserves `qty` random available numbers (Req 5.2). */
  assignRandom(
    raffleId: string,
    playerId: string,
    qty: number,
  ): Promise<Result<Reservation, InventoryError>>;
  /**
   * Releases reservations that expired at or before `now`; returns the number of tickets released (Req 5.6).
   * Does not publish counts; the expiry jobs use `ConfirmationService.releaseExpired`, which does.
   */
  releaseExpired(now?: Date): Promise<number>;
  counts(raffleId: string): Promise<TicketCounts>;
  /** Sets all tickets to cancelled. Pass `tx` to join the raffle-cancellation transaction (Req 8.6). */
  cancelRaffleTickets(raffleId: string, tx?: Tx): Promise<number>;
  /** Creates the raffle's tickets 1..total as available. */
  createTickets(raffleId: string, total: number, tx?: Tx): Promise<number>;
}

/** Thrown inside a transaction to roll it back while carrying a typed rejection. */
class Rejection extends Error {
  constructor(readonly error: InventoryError) {
    super(error.kind);
    this.name = "Rejection";
  }
}

const MAX_RANDOM_ATTEMPTS = 5;

export function createInventoryService<Tx>(deps: InventoryServiceDeps<Tx>): InventoryService<Tx> {
  const { repo, rng, newId } = deps;
  const clock = deps.clock ?? systemClock;
  const timeoutMs = deps.reservationTimeoutMs ?? DEFAULT_RESERVATION_TIMEOUT_MS;

  /** Common pre-checks under the raffle lock: existence, sale state, per-player limit. */
  async function precheck(
    tx: Tx,
    raffleId: string,
    playerId: string,
    qty: number,
    now: Date,
  ): Promise<InventoryRaffle> {
    const raffle = await repo.getRaffleShared(tx, raffleId);
    if (!raffle) throw new Rejection({ kind: "not_found" });
    const sale = checkOnSale(raffle, now);
    if (!sale.ok) throw new Rejection(sale.error);
    await repo.lockPlayer(tx, raffleId, playerId);
    const held = await repo.heldCount(tx, raffleId, playerId);
    const limit = checkPlayerLimit(raffle, held, qty);
    if (!limit.ok) throw new Rejection(limit.error);
    return raffle;
  }

  /** Runs after commit; a failing listener must not fail the committed operation. */
  function changed(raffleId: string): void {
    try {
      deps.countsChanged?.(raffleId);
    } catch {
      // Realtime is best effort; clients flag stale counts (Req 4.8).
    }
  }

  async function run(
    fn: (tx: Tx) => Promise<Reservation>,
  ): Promise<Result<Reservation, InventoryError>> {
    try {
      const reservation = await repo.transaction(fn);
      changed(reservation.raffleId);
      return ok(reservation);
    } catch (e) {
      if (e instanceof Rejection) return err(e.error);
      throw e;
    }
  }

  return {
    reserve(raffleId, playerId, numbers) {
      return run(async (tx) => {
        const now = clock.now();
        const raffle = await repo.getRaffleShared(tx, raffleId);
        if (!raffle) throw new Rejection({ kind: "not_found" });
        if (!validSelection(numbers, raffle.totalTickets))
          throw new Rejection({ kind: "invalid_selection" });
        await precheck(tx, raffleId, playerId, numbers.length, now);

        const expiresAt = new Date(now.getTime() + timeoutMs);
        const orderId = newId();
        await repo.createOrder(tx, {
          id: orderId,
          raffleId,
          playerId,
          numbers: [...numbers],
          totalMinor: raffle.ticketPriceMinor * BigInt(numbers.length),
          currency: raffle.currency,
        });
        const got = new Set(await repo.reserveNumbers(tx, raffleId, orderId, numbers, expiresAt));
        const missing = numbers.filter((n) => !got.has(n));
        // Throwing rolls back the order and any partial update: nothing changes (Req 5.4).
        if (missing.length > 0) throw new Rejection({ kind: "unavailable", numbers: missing });
        return { orderId, raffleId, playerId, numbers: [...numbers], expiresAt };
      });
    },

    assignRandom(raffleId, playerId, qty) {
      return run(async (tx) => {
        const now = clock.now();
        if (!validQuantity(qty)) throw new Rejection({ kind: "invalid_selection" });
        const raffle = await precheck(tx, raffleId, playerId, qty, now);
        const expiresAt = new Date(now.getTime() + timeoutMs);

        for (let attempt = 0; attempt < MAX_RANDOM_ATTEMPTS; attempt++) {
          const picked = pickRandomAvailable(await repo.listAvailable(tx, raffleId), qty, rng);
          if (!picked) throw new Rejection({ kind: "unavailable", numbers: [] });
          const orderId = newId();
          await repo.createOrder(tx, {
            id: orderId,
            raffleId,
            playerId,
            numbers: picked,
            totalMinor: raffle.ticketPriceMinor * BigInt(qty),
            currency: raffle.currency,
          });
          const got = await repo.reserveNumbers(tx, raffleId, orderId, picked, expiresAt);
          if (got.length === picked.length) {
            return { orderId, raffleId, playerId, numbers: picked, expiresAt };
          }
          // Another checkout took a number between listing and updating: undo and pick again.
          await repo.abandonOrder(tx, orderId);
        }
        throw new Rejection({ kind: "unavailable", numbers: [] });
      });
    },

    releaseExpired(now = clock.now()) {
      return repo.transaction((tx) => repo.releaseExpired(tx, now));
    },

    counts(raffleId) {
      return repo.transaction((tx) => repo.counts(tx, raffleId));
    },

    // With a caller-owned `tx` the change is not committed yet, so the caller publishes after commit.
    async cancelRaffleTickets(raffleId, tx) {
      if (tx) return repo.cancelAll(tx, raffleId);
      const n = await repo.transaction((t) => repo.cancelAll(t, raffleId));
      if (n > 0) changed(raffleId);
      return n;
    },

    async createTickets(raffleId, total, tx) {
      if (tx) return repo.seedTickets(tx, raffleId, total);
      const n = await repo.transaction((t) => repo.seedTickets(t, raffleId, total));
      if (n > 0) changed(raffleId);
      return n;
    },
  };
}
