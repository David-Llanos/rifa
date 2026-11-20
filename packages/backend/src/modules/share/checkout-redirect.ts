import { isWellFormedShareToken } from "./token.js";

/** Checkout path for a raffle, carrying the selected ticket numbers (Requirement 16.8). */
export function checkoutPath(token: string, tickets: readonly number[]): string {
  const base = `/r/${token}/checkout`;
  return tickets.length === 0 ? base : `${base}?tickets=${tickets.join(",")}`;
}

/** Where an unauthenticated visitor is sent; `returnTo` brings them back to the same checkout. */
export function signInRedirect(token: string, tickets: readonly number[]): string {
  return `/sign-in?returnTo=${encodeURIComponent(checkoutPath(token, tickets))}`;
}

export interface CheckoutReturn {
  token: string;
  tickets: number[];
}

/**
 * Parses a `returnTo` value. Only internal checkout paths are accepted, which prevents
 * open redirects; anything else yields null.
 */
export function parseCheckoutReturn(returnTo: string): CheckoutReturn | null {
  const m = /^\/r\/([A-Za-z0-9_-]+)\/checkout(?:\?tickets=(\d+(?:,\d+)*))?$/.exec(returnTo);
  if (!m || !isWellFormedShareToken(m[1])) return null;
  const tickets = m[2] === undefined ? [] : m[2].split(",").map(Number);
  if (!tickets.every((n) => Number.isSafeInteger(n))) return null;
  return { token: m[1], tickets };
}
