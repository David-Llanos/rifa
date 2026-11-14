export type PurchaseGuardResult =
  | { allowed: true }
  | { allowed: false; messageKey: "pwa.offline.purchaseBlocked" };

/**
 * Decides whether a purchase may start. Offline attempts are blocked with a message and
 * `start` is never invoked; the caller's selection state is never touched, so chosen
 * numbers are preserved (Req 21.4).
 */
export function guardPurchase(online: boolean): PurchaseGuardResult {
  return online ? { allowed: true } : { allowed: false, messageKey: "pwa.offline.purchaseBlocked" };
}

export function attemptPurchase<T>(
  online: boolean,
  start: () => T,
): { started: true; result: T } | { started: false; messageKey: "pwa.offline.purchaseBlocked" } {
  const guard = guardPurchase(online);
  if (!guard.allowed) return { started: false, messageKey: guard.messageKey };
  return { started: true, result: start() };
}
