export type PushStatus = "unsupported" | "default" | "granted" | "denied";

export interface PushDeps {
  /** Browser support for service workers, PushManager and Notification. */
  supported: boolean;
  getPermission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  /** Subscribe via the push manager and return a serializable subscription. */
  subscribe(): Promise<unknown>;
  /** Unsubscribe in the browser; resolves to the removed subscription if there was one. */
  unsubscribe(): Promise<boolean>;
  /** Tell the Platform to start delivering web push to this subscription. */
  saveSubscription(subscription: unknown): Promise<void>;
  /** Tell the Platform to stop delivering web push; other channels are unaffected (Req 21.7). */
  removeSubscription(): Promise<void>;
}

export type PushResult = { status: PushStatus; error?: boolean };

export function pushStatus(deps: Pick<PushDeps, "supported" | "getPermission">): PushStatus {
  return deps.supported ? deps.getPermission() : "unsupported";
}

/** Web push permission handling (Req 21.6, 21.7). Web push is an extra channel only. */
export async function enablePush(deps: PushDeps): Promise<PushResult> {
  if (!deps.supported) return { status: "unsupported" };
  const permission =
    deps.getPermission() === "default" ? await deps.requestPermission() : deps.getPermission();
  if (permission !== "granted") {
    // Denied (or dismissed): make sure nothing keeps delivering web push.
    if (permission === "denied") await disablePush(deps);
    return { status: permission };
  }
  try {
    await deps.saveSubscription(await deps.subscribe());
    return { status: "granted" };
  } catch {
    return { status: "granted", error: true };
  }
}

export async function disablePush(deps: PushDeps): Promise<PushResult> {
  try {
    await deps.unsubscribe();
    await deps.removeSubscription();
    return { status: pushStatus(deps) };
  } catch {
    return { status: pushStatus(deps), error: true };
  }
}

/**
 * Reconcile on load: if permission was revoked in browser settings, stop web push
 * but leave all other notification channels untouched (Req 21.7).
 */
export async function reconcilePush(deps: PushDeps): Promise<PushStatus> {
  const status = pushStatus(deps);
  if (status === "denied") await disablePush(deps);
  return status;
}

export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
