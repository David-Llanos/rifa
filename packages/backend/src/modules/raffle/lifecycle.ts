import { formatInZone, zonedToUtc } from "@raffle/shared";
import type { LocalDateTime, Locale } from "@raffle/shared";
import type { RaffleStatus } from "./types.js";

/** Events that drive the raffle lifecycle (Requirements 2.12 to 2.14, 7.2 to 7.9). */
export type RaffleEvent =
  | "submit"
  | "publication_approved"
  | "publication_rejected"
  | "close_sales"
  | "threshold_met"
  | "threshold_not_met"
  | "winner_recorded"
  | "cancel";

export interface IllegalTransition {
  readonly illegal: true;
  readonly from: RaffleStatus;
  readonly event: RaffleEvent;
}

type Table = Partial<Record<RaffleStatus, Partial<Record<RaffleEvent, RaffleStatus>>>>;

/** Allowed transitions; anything not listed is illegal and leaves the status unchanged. */
export const TRANSITIONS: Readonly<Table> = {
  draft: { submit: "pending_review", cancel: "cancelled" },
  pending_review: { publication_approved: "published", publication_rejected: "draft" },
  published: { close_sales: "sales_closed", cancel: "cancelled" },
  sales_closed: { threshold_met: "awaiting_draw", threshold_not_met: "cancelled" },
  awaiting_draw: { winner_recorded: "completed", cancel: "cancelled" },
};

export function isIllegal(r: RaffleStatus | IllegalTransition): r is IllegalTransition {
  return typeof r === "object";
}

export function transition(
  status: RaffleStatus,
  event: RaffleEvent,
): RaffleStatus | IllegalTransition {
  return TRANSITIONS[status]?.[event] ?? { illegal: true, from: status, event };
}

/** Status after applying `event`, or the unchanged status when the event is illegal. */
export function applyEvent(status: RaffleStatus, event: RaffleEvent): RaffleStatus {
  const next = transition(status, event);
  return isIllegal(next) ? status : next;
}

export interface ClosureInput {
  status: RaffleStatus;
  now: Date;
  deadline: Date;
  soldCount: number;
  totalTickets: number;
  /** Minimum_Ticket_Threshold; when unset at least one sold ticket is required for a draw. */
  minThreshold?: number | undefined;
  earlyClosure: boolean;
}

export type ClosureDecision = "none" | "sales_closed" | "awaiting_draw" | "cancel_refund";

/**
 * Sales closure decision (Requirements 7.2, 7.3, 7.5, 7.6, 7.8, 7.9).
 * - published: close at or after the deadline, or when sold out and early closure is enabled.
 * - sales_closed: awaiting_draw when sold >= threshold, otherwise cancellation with refunds.
 * - any other status: no action.
 */
export function closureDecision(s: ClosureInput): ClosureDecision {
  if (s.status === "published") {
    const reached = s.now.getTime() >= s.deadline.getTime();
    const soldOut = s.soldCount >= s.totalTickets;
    return reached || (s.earlyClosure && soldOut) ? "sales_closed" : "none";
  }
  if (s.status === "sales_closed") {
    const threshold = s.minThreshold ?? 1;
    return s.soldCount >= threshold ? "awaiting_draw" : "cancel_refund";
  }
  return "none";
}

/** Whether new reservations must be rejected for this status (Requirements 7.3, 8.6). */
export function rejectsReservations(
  status: RaffleStatus,
): "sales_closed" | "cancelled" | "not_open" | null {
  switch (status) {
    case "published":
      return null;
    case "cancelled":
      return "cancelled";
    case "sales_closed":
    case "awaiting_draw":
    case "completed":
      return "sales_closed";
    default:
      return "not_open";
  }
}

export const REMINDER_LEAD_MS = 24 * 60 * 60 * 1000;

/** When the single 24-hour reminder should run, never earlier than `now` (Requirement 7.11). */
export function reminderRunAt(deadline: Date, now: Date): Date {
  return new Date(Math.max(now.getTime(), deadline.getTime() - REMINDER_LEAD_MS));
}

/** Deadlines are entered in the Raffle jurisdiction time zone and stored as UTC (Requirement 7.10). */
export function deadlineFromJurisdictionLocal(local: LocalDateTime, jurisdictionTz: string): Date {
  return zonedToUtc(local, jurisdictionTz);
}

/** Deadline text for a viewer, with zone name and UTC offset (Requirement 7.10). */
export function deadlineDisplay(deadline: Date, viewerTz: string, locale: Locale = "en"): string {
  return formatInZone(deadline, viewerTz, locale);
}
