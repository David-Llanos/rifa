import { holdAtDeadline } from "./confirmation-core.js";
import type { OrderStatus, TicketState } from "./confirmation-core.js";
import type {
  ConfirmationRepository,
  DeadlineReleaseResult,
  LockedOrder,
  ReleasedOrder,
  ReleaseResult,
} from "./confirmation-repository.js";
import type { InventoryRepository, NewOrder } from "./repository.js";
import type { InventoryRaffle, TicketCounts, TicketStatus } from "./types.js";

interface MemTicket {
  status: TicketStatus;
  orderId: string | null;
  expiresAt: Date | null;
  soldAt?: Date | null;
}

interface MemOrder extends NewOrder {
  status: OrderStatus;
}

interface State {
  raffles: Map<string, InventoryRaffle>;
  tickets: Map<string, Map<number, MemTicket>>;
  orders: Map<string, MemOrder>;
  /** Payment status per order (test stand-in for the payment table). */
  payments: Map<string, "pending" | "succeeded" | "failed" | "expired">;
}

export interface MemoryTx {
  readonly memory: true;
}

function clone(s: State): State {
  const tickets = new Map<string, Map<number, MemTicket>>();
  for (const [rid, m] of s.tickets) {
    tickets.set(rid, new Map([...m].map(([n, t]) => [n, { ...t }])));
  }
  return {
    raffles: new Map([...s.raffles].map(([k, v]) => [k, { ...v }])),
    tickets,
    orders: new Map([...s.orders].map(([k, v]) => [k, { ...v, numbers: [...v.numbers] }])),
    payments: new Map(s.payments),
  };
}

/**
 * In-memory repository with the same semantics as the PostgreSQL one: transactions are serialized (as the
 * row locks make them for the same tickets) and a throw restores the previous state.
 */
export class MemoryInventoryRepository
  implements InventoryRepository<MemoryTx>, ConfirmationRepository<MemoryTx>
{
  private state: State = {
    raffles: new Map(),
    tickets: new Map(),
    orders: new Map(),
    payments: new Map(),
  };
  private tail: Promise<unknown> = Promise.resolve();
  private readonly tx: MemoryTx = { memory: true };

  addRaffle(id: string, raffle: InventoryRaffle): void {
    this.state.raffles.set(id, { ...raffle });
    if (!this.state.tickets.has(id)) this.state.tickets.set(id, new Map());
  }

  setRaffleStatus(id: string, status: InventoryRaffle["status"]): void {
    const r = this.state.raffles.get(id);
    if (r) r.status = status;
  }

  /** Test helper: mark tickets as sold for an existing order. */
  markSold(raffleId: string, numbers: number[]): void {
    for (const n of numbers) {
      const t = this.state.tickets.get(raffleId)?.get(n);
      if (t) t.status = "sold";
    }
  }

  ticketStatuses(raffleId: string): Map<number, TicketStatus> {
    return new Map([...(this.state.tickets.get(raffleId) ?? [])].map(([n, t]) => [n, t.status]));
  }

  orderCount(): number {
    return this.state.orders.size;
  }

  orderStatus(orderId: string): OrderStatus | undefined {
    return this.state.orders.get(orderId)?.status;
  }

  /** Test helper: record a payment for an order. */
  setPayment(orderId: string, status: "pending" | "succeeded" | "failed" | "expired"): void {
    this.state.payments.set(orderId, status);
  }

  paymentStatus(orderId: string): string | undefined {
    return this.state.payments.get(orderId);
  }

  lockOrder(_tx: MemoryTx, orderId: string): Promise<LockedOrder | null> {
    const o = this.state.orders.get(orderId);
    return Promise.resolve(
      o
        ? {
            id: o.id,
            raffleId: o.raffleId,
            playerId: o.playerId,
            numbers: [...o.numbers],
            status: o.status,
          }
        : null,
    );
  }

  lockTickets(_tx: MemoryTx, raffleId: string, numbers: number[]): Promise<TicketState[]> {
    const out: TicketState[] = [];
    for (const n of [...numbers].sort((a, b) => a - b)) {
      const t = this.state.tickets.get(raffleId)?.get(n);
      if (t) {
        out.push({
          number: n,
          status: t.status,
          orderId: t.orderId,
          reservationExpiresAt: t.expiresAt,
          soldAt: t.soldAt ?? null,
        });
      }
    }
    return Promise.resolve(out);
  }

  convertToSold(
    _tx: MemoryTx,
    raffleId: string,
    orderId: string,
    numbers: number[],
    now: Date,
  ): Promise<void> {
    for (const n of numbers) {
      const t = this.state.tickets.get(raffleId)?.get(n);
      if (t) {
        t.status = "sold";
        t.orderId = orderId;
        t.expiresAt = null;
        t.soldAt ??= now;
      }
    }
    return Promise.resolve();
  }

  setOrderStatus(_tx: MemoryTx, orderId: string, status: OrderStatus): Promise<void> {
    const o = this.state.orders.get(orderId);
    if (o) o.status = status;
    return Promise.resolve();
  }

  releaseExpiredDetailed(_tx: MemoryTx, now: Date): Promise<ReleaseResult> {
    return Promise.resolve(
      this.releaseWhere((t) => t.expiresAt !== null && t.expiresAt.getTime() <= now.getTime()),
    );
  }

  releaseAtDeadline(
    _tx: MemoryTx,
    raffleId: string,
    now: Date,
    graceMs: number,
  ): Promise<DeadlineReleaseResult> {
    const raffle = this.state.raffles.get(raffleId);
    if (!raffle || raffle.deadline.getTime() > now.getTime()) {
      return Promise.resolve({ tickets: 0, orders: [], heldOrders: 0 });
    }
    const out = this.releaseWhere(
      (t) =>
        !holdAtDeadline(
          t.orderId !== null && this.state.payments.get(t.orderId) === "pending",
          raffle.deadline,
          now,
          graceMs,
        ),
      raffleId,
    );
    const held = new Set<string>();
    for (const t of this.state.tickets.get(raffleId)?.values() ?? [])
      if (t.status === "reserved" && t.orderId) held.add(t.orderId);
    return Promise.resolve({ ...out, heldOrders: held.size });
  }

  /** Releases reserved tickets matching `pick` and expires the orders left empty (with pending payments). */
  private releaseWhere(pick: (t: MemTicket) => boolean, onlyRaffle?: string): ReleaseResult {
    let tickets = 0;
    const touched = new Set<string>();
    for (const [rid, m] of this.state.tickets) {
      if (onlyRaffle !== undefined && rid !== onlyRaffle) continue;
      for (const t of m.values()) {
        if (t.status === "reserved" && pick(t)) {
          if (t.orderId) touched.add(t.orderId);
          t.status = "available";
          t.orderId = null;
          t.expiresAt = null;
          tickets++;
        }
      }
    }
    const orders: ReleasedOrder[] = [];
    for (const id of touched) {
      const o = this.state.orders.get(id);
      if (!o || (o.status !== "reserved" && o.status !== "pending")) continue;
      let holds = false;
      for (const m of this.state.tickets.values())
        for (const t of m.values()) if (t.orderId === id) holds = true;
      if (holds) continue;
      o.status = "expired";
      const hadPendingPayment = this.state.payments.get(id) === "pending";
      if (hadPendingPayment) this.state.payments.set(id, "expired");
      orders.push({ orderId: id, raffleId: o.raffleId, playerId: o.playerId, hadPendingPayment });
    }
    return { tickets, orders };
  }

  transaction<T>(fn: (tx: MemoryTx) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const snapshot = clone(this.state);
      try {
        return await fn(this.tx);
      } catch (e) {
        this.state = snapshot;
        throw e;
      }
    };
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => undefined);
    return result;
  }

  getRaffleShared(_tx: MemoryTx, raffleId: string): Promise<InventoryRaffle | null> {
    const r = this.state.raffles.get(raffleId);
    return Promise.resolve(r ? { ...r } : null);
  }

  lockPlayer(): Promise<void> {
    return Promise.resolve();
  }

  heldCount(_tx: MemoryTx, raffleId: string, playerId: string): Promise<number> {
    let n = 0;
    for (const t of this.state.tickets.get(raffleId)?.values() ?? []) {
      if ((t.status === "reserved" || t.status === "sold") && t.orderId) {
        if (this.state.orders.get(t.orderId)?.playerId === playerId) n++;
      }
    }
    return Promise.resolve(n);
  }

  createOrder(_tx: MemoryTx, order: NewOrder): Promise<void> {
    this.state.orders.set(order.id, { ...order, numbers: [...order.numbers], status: "reserved" });
    return Promise.resolve();
  }

  reserveNumbers(
    _tx: MemoryTx,
    raffleId: string,
    orderId: string,
    numbers: number[],
    expiresAt: Date,
  ): Promise<number[]> {
    const got: number[] = [];
    const m = this.state.tickets.get(raffleId);
    for (const n of numbers) {
      const t = m?.get(n);
      if (t && t.status === "available") {
        t.status = "reserved";
        t.orderId = orderId;
        t.expiresAt = expiresAt;
        got.push(n);
      }
    }
    return Promise.resolve(got);
  }

  abandonOrder(_tx: MemoryTx, orderId: string): Promise<void> {
    for (const m of this.state.tickets.values()) {
      for (const t of m.values()) {
        if (t.orderId === orderId && t.status === "reserved") {
          t.status = "available";
          t.orderId = null;
          t.expiresAt = null;
        }
      }
    }
    this.state.orders.delete(orderId);
    return Promise.resolve();
  }

  listAvailable(_tx: MemoryTx, raffleId: string): Promise<number[]> {
    const out: number[] = [];
    for (const [n, t] of this.state.tickets.get(raffleId) ?? [])
      if (t.status === "available") out.push(n);
    return Promise.resolve(out.sort((a, b) => a - b));
  }

  releaseExpired(_tx: MemoryTx, now: Date): Promise<number> {
    let n = 0;
    for (const m of this.state.tickets.values()) {
      for (const t of m.values()) {
        if (t.status === "reserved" && t.expiresAt && t.expiresAt.getTime() <= now.getTime()) {
          t.status = "available";
          t.orderId = null;
          t.expiresAt = null;
          n++;
        }
      }
    }
    const held = new Set<string>();
    for (const m of this.state.tickets.values())
      for (const t of m.values()) if (t.orderId) held.add(t.orderId);
    for (const o of this.state.orders.values())
      if (o.status === "reserved" && !held.has(o.id)) o.status = "expired";
    return Promise.resolve(n);
  }

  cancelAll(_tx: MemoryTx, raffleId: string): Promise<number> {
    let n = 0;
    for (const t of this.state.tickets.get(raffleId)?.values() ?? []) {
      if (t.status !== "cancelled") {
        t.status = "cancelled";
        t.expiresAt = null;
        n++;
      }
    }
    return Promise.resolve(n);
  }

  counts(_tx: MemoryTx, raffleId: string): Promise<TicketCounts> {
    const out: TicketCounts = { available: 0, reserved: 0, sold: 0, cancelled: 0 };
    for (const t of this.state.tickets.get(raffleId)?.values() ?? []) out[t.status]++;
    return Promise.resolve(out);
  }

  seedTickets(_tx: MemoryTx, raffleId: string, total: number): Promise<number> {
    let m = this.state.tickets.get(raffleId);
    if (!m) {
      m = new Map();
      this.state.tickets.set(raffleId, m);
    }
    let n = 0;
    for (let i = 1; i <= total; i++) {
      if (!m.has(i)) {
        m.set(i, { status: "available", orderId: null, expiresAt: null });
        n++;
      }
    }
    return Promise.resolve(n);
  }
}
