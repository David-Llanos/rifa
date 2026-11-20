import type { PaymentMethod } from "../payment/types.js";
import type { TicketStatus } from "./types.js";

/** Longest a reservation may stay active for an asynchronous payment method (Req 6.8). */
export const MAX_ASYNC_RESERVATION_MS = 72 * 60 * 60 * 1000;

/** Grace period after the deadline for an in-progress payment before its tickets are released. */
export const DEADLINE_PAYMENT_GRACE_MS = 15 * 60 * 1000;

/** Payment methods that confirm asynchronously (Req 6.8). */
export const ASYNC_PAYMENT_METHODS: readonly PaymentMethod[] = ["cash_network", "ach"];

export function isAsyncMethod(method: PaymentMethod): boolean {
  return ASYNC_PAYMENT_METHODS.includes(method);
}

/**
 * Effective reservation expiry (Req 5.3, 6.8).
 * Synchronous methods use `start + defaultTimeoutMin`. Asynchronous methods use the method-specific
 * expiry (`methodExpiry`, when given) capped at `start + 72h`; with no method expiry the cap applies.
 */
export function reservationExpiry(
  method: PaymentMethod,
  start: Date,
  defaultTimeoutMin: number,
  methodExpiry?: Date,
): Date {
  if (!isAsyncMethod(method)) return new Date(start.getTime() + defaultTimeoutMin * 60_000);
  const cap = start.getTime() + MAX_ASYNC_RESERVATION_MS;
  return new Date(Math.min(methodExpiry ? methodExpiry.getTime() : cap, cap));
}

export type OrderStatus = "reserved" | "pending" | "paid" | "expired" | "refunded" | "under_review";

export interface TicketState {
  number: number;
  status: TicketStatus;
  orderId: string | null;
  reservationExpiresAt: Date | null;
  soldAt: Date | null;
}

/** The order and its tickets, as locked for a confirmation. */
export interface InventoryState {
  orderId: string;
  orderStatus: OrderStatus;
  tickets: TicketState[];
}

export interface PaymentConfirmation {
  paymentId: string;
  orderId: string;
}

export type ConfirmEffect = "sold" | "refund" | "noop";

/** A ticket can be converted to sold if it is still held by this order, or was released and is Available. */
function convertible(t: TicketState, orderId: string): boolean {
  if (t.status === "available") return true;
  return (t.status === "reserved" || t.status === "sold") && t.orderId === orderId;
}

/**
 * Pure idempotent confirmation (Req 5.7, 5.8, 5.9, 6.11).
 * - Order already paid or refunded: `noop` (repeated confirmation changes nothing).
 * - Every ticket still held by the order or Available: they become sold, order paid (`sold`).
 * - Any ticket taken or cancelled: ticket statuses are unchanged, order refunded (`refund`).
 */
export function applyConfirmation(
  state: InventoryState,
  c: PaymentConfirmation,
  now: Date,
): { state: InventoryState; effect: ConfirmEffect } {
  if (state.orderStatus === "paid" || state.orderStatus === "refunded") {
    return { state, effect: "noop" };
  }
  const ok = state.tickets.length > 0 && state.tickets.every((t) => convertible(t, c.orderId));
  if (!ok) return { state: { ...state, orderStatus: "refunded" }, effect: "refund" };
  return {
    state: {
      ...state,
      orderStatus: "paid",
      tickets: state.tickets.map((t) => ({
        ...t,
        status: "sold",
        orderId: c.orderId,
        reservationExpiresAt: null,
        soldAt: t.soldAt ?? now,
      })),
    },
    effect: "sold",
  };
}

/**
 * At the raffle deadline a reservation is released, unless its payment is in progress and the
 * grace period has not elapsed (up to 15 minutes after the deadline).
 */
export function holdAtDeadline(
  paymentInProgress: boolean,
  deadline: Date,
  now: Date,
  graceMs: number = DEADLINE_PAYMENT_GRACE_MS,
): boolean {
  return paymentInProgress && now.getTime() < deadline.getTime() + graceMs;
}
