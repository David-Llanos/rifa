"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useI18n } from "../i18n/provider";
import { ConnectivityMonitor, type ConnectivityState } from "./connectivity";
import { attemptPurchase } from "./purchase-guard";
import { UpdateController, type UpdateState } from "./update";
import {
  disablePush,
  enablePush,
  pushStatus,
  reconcilePush,
  urlBase64ToUint8Array,
  type PushDeps,
  type PushStatus,
} from "./push";

export interface PushApi {
  save(subscription: unknown): Promise<void>;
  remove(): Promise<void>;
}

interface PwaContextValue extends ConnectivityState, UpdateState {
  /** Runs `start` only when online; otherwise shows the blocked message and returns false. */
  tryPurchase: (start: () => void) => boolean;
  /** Call on every realtime message or heartbeat so stale-count detection stays accurate. */
  realtimeActivity: () => void;
  realtimeLost: () => void;
  applyUpdate: () => void;
  push: { status: PushStatus; error: boolean; enable: () => void; disable: () => void };
  purchaseBlocked: boolean;
}

const PwaContext = createContext<PwaContextValue | null>(null);

const SERVER_STATE: ConnectivityState = { online: true, countsStale: false };

export function PwaProvider({
  pushApi,
  vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
  children,
}: {
  pushApi?: PushApi;
  vapidPublicKey?: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const monitor = useMemo(() => new ConnectivityMonitor(true), []);
  const conn = useSyncExternalStore(monitor.subscribe, monitor.getState, () => SERVER_STATE);

  const [updater, setUpdater] = useState<UpdateController | null>(null);
  const [update, setUpdate] = useState<UpdateState>({ updateAvailable: false });
  const [purchaseBlocked, setPurchaseBlocked] = useState(false);
  const [push, setPush] = useState<{ status: PushStatus; error: boolean }>({
    status: "default",
    error: false,
  });
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const pushApiRef = useRef(pushApi);
  pushApiRef.current = pushApi;

  useEffect(() => {
    monitor.setOnline(navigator.onLine);
    const on = () => {
      monitor.setOnline(true);
      setPurchaseBlocked(false);
    };
    const off = () => monitor.setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, [monitor]);

  // Register the service worker in production only, so dev builds are never served stale.
  useEffect(() => {
    if (!("serviceWorker" in navigator) || process.env.NODE_ENV !== "production") return;
    let controller: UpdateController | null = null;
    let interval: ReturnType<typeof setInterval> | undefined;
    let unsubscribe: (() => void) | undefined;
    navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => {
        registrationRef.current = registration;
        controller = new UpdateController(registration, navigator.serviceWorker, () =>
          window.location.reload(),
        );
        setUpdater(controller);
        setUpdate(controller.getState());
        unsubscribe = controller.subscribe(() => setUpdate(controller!.getState()));
        interval = setInterval(() => controller?.checkForUpdate(), 60 * 60 * 1000);
      })
      .catch(() => undefined);
    return () => {
      unsubscribe?.();
      if (interval) clearInterval(interval);
    };
  }, []);

  const pushDeps = useCallback((): PushDeps => {
    const supported =
      typeof window !== "undefined" &&
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window;
    return {
      supported,
      getPermission: () => Notification.permission,
      requestPermission: () => Notification.requestPermission(),
      subscribe: async () => {
        const reg = registrationRef.current ?? (await navigator.serviceWorker.ready);
        const existing = await reg.pushManager.getSubscription();
        if (existing) return existing.toJSON();
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: vapidPublicKey
            ? (urlBase64ToUint8Array(vapidPublicKey) as BufferSource)
            : undefined,
        });
        return sub.toJSON();
      },
      unsubscribe: async () => {
        const reg = registrationRef.current ?? (await navigator.serviceWorker.ready);
        const sub = await reg.pushManager.getSubscription();
        return sub ? sub.unsubscribe() : false;
      },
      saveSubscription: async (s) => pushApiRef.current?.save(s),
      removeSubscription: async () => pushApiRef.current?.remove(),
    };
  }, [vapidPublicKey]);

  useEffect(() => {
    const deps = pushDeps();
    setPush({ status: pushStatus(deps), error: false });
    void reconcilePush(deps).then((status) => setPush({ status, error: false }));
  }, [pushDeps]);

  const value = useMemo<PwaContextValue>(
    () => ({
      ...conn,
      ...update,
      purchaseBlocked,
      tryPurchase: (start) => {
        const outcome = attemptPurchase(monitor.getState().online, start);
        setPurchaseBlocked(!outcome.started);
        return outcome.started;
      },
      realtimeActivity: () => monitor.activity(),
      realtimeLost: () => monitor.realtimeLost(),
      applyUpdate: () => updater?.applyUpdate(),
      push: {
        ...push,
        enable: () =>
          void enablePush(pushDeps()).then((r) => setPush({ status: r.status, error: !!r.error })),
        disable: () =>
          void disablePush(pushDeps()).then((r) => setPush({ status: r.status, error: !!r.error })),
      },
    }),
    [conn, update, purchaseBlocked, monitor, updater, push, pushDeps],
  );

  return (
    <PwaContext.Provider value={value}>
      {!conn.online && (
        <div className="pwa-banner" role="status">
          {t("pwa.offline.banner")}
        </div>
      )}
      {purchaseBlocked && !conn.online && (
        <div className="pwa-banner pwa-banner--error" role="alert">
          {t("pwa.offline.purchaseBlocked")}
        </div>
      )}
      {update.updateAvailable && (
        <div className="pwa-banner pwa-banner--update" role="status">
          <span>{t("pwa.update.message")}</span>
          <button type="button" onClick={() => updater?.applyUpdate()}>
            {t("pwa.update.refresh")}
          </button>
        </div>
      )}
      {children}
    </PwaContext.Provider>
  );
}

export function usePwa(): PwaContextValue {
  const ctx = useContext(PwaContext);
  if (!ctx) throw new Error("usePwa must be used inside <PwaProvider>");
  return ctx;
}

/** Shows "counts may be outdated" while live counts cannot be trusted (Req 4.8). */
export function StaleCountsNotice() {
  const { t } = useI18n();
  const { countsStale } = usePwa();
  if (!countsStale) return null;
  return (
    <p className="pwa-stale" role="status">
      {t("pwa.staleCounts")}
    </p>
  );
}

/** Opt-in control for web push (additional channel, non-mandatory notifications only). */
export function PushToggle() {
  const { t } = useI18n();
  const { push } = usePwa();
  if (push.status === "unsupported") return <p>{t("pwa.push.unsupported")}</p>;
  return (
    <div className="pwa-push">
      {push.status === "granted" ? (
        <button type="button" onClick={push.disable}>
          {t("pwa.push.disable")}
        </button>
      ) : (
        <button type="button" onClick={push.enable} disabled={push.status === "denied"}>
          {t("pwa.push.enable")}
        </button>
      )}
      {push.status === "denied" && <p>{t("pwa.push.denied")}</p>}
      {push.error && <p role="alert">{t("pwa.push.error")}</p>}
    </div>
  );
}
