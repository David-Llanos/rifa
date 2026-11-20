import { systemClock } from "@raffle/shared";
import type { Clock } from "@raffle/shared";
import { DEADLINE_PAYMENT_GRACE_MS, applyConfirmation } from "./confirmation-core.js";
import type { ConfirmEffect, InventoryState } from "./confirmation-core.js";
import type {
  ConfirmationRepository,
  DeadlineReleaseResult,
  ReleasedOrder,
  ReleaseResult,
} from "./confirmation-repository.js";

export interface LatePaymentRefundRequest {
  paymentId: string;
  orderId: string;
  raffleId: string;
  playerId: string;
}

/**
 * Port to the payment module (built in task 7.6). Implementations refund the full amount to the original
 * method and notify the Player within 60 seconds (Req 5.8, 6.11). Must be idempotent per `paymentId`.
 */
export interface LatePaymentRefunds {
  refundInFull(req: LatePaymentRefundRequest): Promise<void>;
}

/** Port to the notification module: tells the Player an asynchronous purchase was not completed (Req 6.10). */
export interface ReservationExpiryNotifier {
  purchaseNotCompleted(order: ReleasedOrder): Promise<void>;
}

export type ConfirmOutcome =
  | { effect: ConfirmEffect; orderId: string }
  | { effect: "not_found"; orderId: string };

export interface ReleaseOutcome extends ReleaseResult {
  /** Orders whose expiry notification failed; the release itself is committed. */
  notifyFailures: number;
}

export interface DeadlineReleaseOutcome extends DeadlineReleaseResult {
  notifyFailures: number;
}

export interface ConfirmationServiceDeps<Tx> {
  repo: ConfirmationRepository<Tx>;
  refunds: LatePaymentRefunds;
  notifier?: ReservationExpiryNotifier;
  clock?: Clock;
  /** Grace for in-progress payments at the deadline; defaults to 15 minutes. */
  deadlineGraceMs?: number;
}

export interface ConfirmationService {
  /** Idempotent: repeated deliveries for one order convert tickets to sold at most once (Req 5.9). */
  confirmPayment(c: { paymentId: string; orderId: string }): Promise<ConfirmOutcome>;
  /** Releases expired reservations (Req 5.6, 6.10) and notifies Players of expired asynchronous payments. */
  releaseExpired(now?: Date): Promise<ReleaseOutcome>;
  /** Deadline-time release with the in-progress payment exception (Req 7.4). */
  releaseAtDeadline(raffleId: string, now?: Date): Promise<DeadlineReleaseOutcome>;
}

export function createConfirmationService<Tx>(
  deps: ConfirmationServiceDeps<Tx>,
): ConfirmationService {
  const { repo, refunds, notifier } = deps;
  const clock = deps.clock ?? systemClock;
  const graceMs = deps.deadlineGraceMs ?? DEADLINE_PAYMENT_GRACE_MS;

  async function notify(orders: ReleasedOrder[]): Promise<number> {
    let failures = 0;
    for (const o of orders) {
      if (!o.hadPendingPayment || !notifier) continue;
      try {
        await notifier.purchaseNotCompleted(o);
      } catch {
        failures++;
      }
    }
    return failures;
  }

  return {
    async confirmPayment(c) {
      const now = clock.now();
      const result = await repo.transaction(async (tx) => {
        const order = await repo.lockOrder(tx, c.orderId);
        if (!order) return null;
        const tickets = await repo.lockTickets(tx, order.raffleId, order.numbers);
        const before: InventoryState = {
          orderId: order.id,
          orderStatus: order.status,
          tickets,
        };
        const { state, effect } = applyConfirmation(before, c, now);
        if (effect === "sold") {
          await repo.convertToSold(tx, order.raffleId, order.id, order.numbers, now);
          await repo.setOrderStatus(tx, order.id, "paid");
        } else if (effect === "refund") {
          await repo.setOrderStatus(tx, order.id, state.orderStatus);
        }
        return { order, effect, previous: order.status };
      });
      if (!result) return { effect: "not_found", orderId: c.orderId };
      // The refund call is external, so it runs after commit. A redelivery for an order already marked
      // refunded repeats the (idempotent) request, which recovers a refund that failed after commit.
      if (
        result.effect === "refund" ||
        (result.effect === "noop" && result.previous === "refunded")
      ) {
        await refunds.refundInFull({
          paymentId: c.paymentId,
          orderId: result.order.id,
          raffleId: result.order.raffleId,
          playerId: result.order.playerId,
        });
      }
      return { effect: result.effect, orderId: c.orderId };
    },

    async releaseExpired(now = clock.now()) {
      const released = await repo.transaction((tx) => repo.releaseExpiredDetailed(tx, now));
      return { ...released, notifyFailures: await notify(released.orders) };
    },

    async releaseAtDeadline(raffleId, now = clock.now()) {
      const released = await repo.transaction((tx) =>
        repo.releaseAtDeadline(tx, raffleId, now, graceMs),
      );
      return { ...released, notifyFailures: await notify(released.orders) };
    },
  };
}
