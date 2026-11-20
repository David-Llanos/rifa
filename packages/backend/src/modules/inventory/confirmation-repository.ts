import type { OrderStatus, TicketState } from "./confirmation-core.js";

export interface LockedOrder {
  id: string;
  raffleId: string;
  playerId: string;
  numbers: number[];
  status: OrderStatus;
}

/** An order whose reservation was released. */
export interface ReleasedOrder {
  orderId: string;
  raffleId: string;
  playerId: string;
  /** True when the order had a pending payment, now marked expired (Req 6.10). */
  hadPendingPayment: boolean;
}

export interface ReleaseResult {
  /** Tickets returned to Available. */
  tickets: number;
  /** Orders left without tickets and marked expired. */
  orders: ReleasedOrder[];
}

export interface DeadlineReleaseResult extends ReleaseResult {
  /** Distinct orders still holding reserved tickets (in-progress payments within grace). */
  heldOrders: number;
}

/** Persistence port for confirmation and expiry. Methods run inside the caller's transaction. */
export interface ConfirmationRepository<Tx> {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** `SELECT ... FOR UPDATE` on the order so concurrent confirmations serialize. */
  lockOrder(tx: Tx, orderId: string): Promise<LockedOrder | null>;
  /** `SELECT ... FOR UPDATE` on the order's tickets, ordered by number. */
  lockTickets(tx: Tx, raffleId: string, numbers: number[]): Promise<TicketState[]>;
  convertToSold(
    tx: Tx,
    raffleId: string,
    orderId: string,
    numbers: number[],
    now: Date,
  ): Promise<void>;
  setOrderStatus(tx: Tx, orderId: string, status: OrderStatus): Promise<void>;
  /** Releases reservations expired at or before `now`; expires orders left empty and their pending payments. */
  releaseExpiredDetailed(tx: Tx, now: Date): Promise<ReleaseResult>;
  /**
   * Releases the raffle's reserved tickets once its deadline passed, except orders with a pending payment
   * until `deadline + graceMs`.
   */
  releaseAtDeadline(
    tx: Tx,
    raffleId: string,
    now: Date,
    graceMs: number,
  ): Promise<DeadlineReleaseResult>;
}
