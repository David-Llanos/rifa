import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  ConnectivityMonitor,
  UpdateController,
  attemptPurchase,
  disablePush,
  enablePush,
  reconcilePush,
  type ContainerLike,
  type PushDeps,
  type RegistrationLike,
  type Scheduler,
} from "./index";

function fakeScheduler() {
  let now = 0;
  const tasks: { at: number; fn: () => void; id: number }[] = [];
  let next = 1;
  const scheduler: Scheduler = {
    setTimeout: (fn, ms) => {
      const id = next++;
      tasks.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimeout: (h) => {
      const i = tasks.findIndex((t) => t.id === h);
      if (i >= 0) tasks.splice(i, 1);
    },
  };
  return {
    scheduler,
    advance(ms: number) {
      now += ms;
      for (const t of tasks.filter((x) => x.at <= now)) {
        tasks.splice(tasks.indexOf(t), 1);
        t.fn();
      }
    },
  };
}

describe("ConnectivityMonitor (Req 4.8)", () => {
  it("marks counts stale immediately when going offline and keeps purchases blocked state", () => {
    const m = new ConnectivityMonitor(true);
    expect(m.getState()).toEqual({ online: true, countsStale: false });
    m.setOnline(false);
    expect(m.getState()).toEqual({ online: false, countsStale: true });
  });

  it("flags stale counts after 10 s of realtime silence and clears on activity", () => {
    const { scheduler, advance } = fakeScheduler();
    const m = new ConnectivityMonitor(true, 10_000, scheduler);
    m.startWatching();
    advance(9_999);
    expect(m.getState().countsStale).toBe(false);
    advance(1);
    expect(m.getState().countsStale).toBe(true);
    m.activity();
    expect(m.getState().countsStale).toBe(false);
    advance(5_000);
    m.activity(); // heartbeat resets the watchdog
    advance(9_000);
    expect(m.getState().countsStale).toBe(false);
  });

  it("notifies subscribers only on change", () => {
    const m = new ConnectivityMonitor(true);
    const listener = vi.fn();
    m.subscribe(listener);
    m.setOnline(true);
    m.setOnline(false);
    m.setOnline(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("attemptPurchase (Req 21.4)", () => {
  it("blocks offline, never starts, and leaves selections untouched", () => {
    const selection = new Set([3, 7, 42]);
    const start = vi.fn();
    const out = attemptPurchase(false, start);
    expect(out).toEqual({ started: false, messageKey: "pwa.offline.purchaseBlocked" });
    expect(start).not.toHaveBeenCalled();
    expect([...selection]).toEqual([3, 7, 42]);
  });
  it("starts when online", () => {
    expect(attemptPurchase(true, () => 5)).toEqual({ started: true, result: 5 });
  });
});

describe("UpdateController (Req 21.9, 21.10)", () => {
  function setup(opts: { waiting?: boolean; controller?: boolean } = {}) {
    const regListeners: Record<string, () => void> = {};
    const containerListeners: Record<string, () => void> = {};
    const postMessage = vi.fn();
    const stateListeners: (() => void)[] = [];
    const installing = {
      state: "installing",
      addEventListener: (_t: "statechange", l: () => void) => stateListeners.push(l),
    };
    const registration: RegistrationLike = {
      waiting: opts.waiting ? { postMessage } : null,
      installing: null,
      addEventListener: (t, l) => {
        regListeners[t] = l;
      },
    };
    const container: ContainerLike = {
      controller: opts.controller === false ? null : {},
      addEventListener: (t, l) => {
        containerListeners[t] = l;
      },
    };
    const reload = vi.fn();
    const c = new UpdateController(registration, container, reload);
    return {
      c,
      registration,
      regListeners,
      containerListeners,
      postMessage,
      installing,
      stateListeners,
      reload,
    };
  }

  it("shows the prompt when a new worker finishes installing, then reloads after activation", () => {
    const s = setup();
    expect(s.c.getState().updateAvailable).toBe(false);
    s.registration.installing = s.installing;
    s.regListeners.updatefound!();
    s.installing.state = "installed";
    s.stateListeners.forEach((l) => l());
    expect(s.c.getState().updateAvailable).toBe(true);

    s.registration.waiting = { postMessage: s.postMessage };
    s.c.applyUpdate();
    expect(s.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    expect(s.reload).not.toHaveBeenCalled();
    s.containerListeners.controllerchange!();
    expect(s.reload).toHaveBeenCalledTimes(1);
  });

  it("detects an already-waiting worker; no prompt on first install", () => {
    expect(setup({ waiting: true }).c.getState().updateAvailable).toBe(true);
    expect(setup({ waiting: true, controller: false }).c.getState().updateAvailable).toBe(false);
  });
});

function pushDeps(over: Partial<PushDeps> & { permission?: NotificationPermission } = {}) {
  let permission: NotificationPermission = over.permission ?? "default";
  const deps: PushDeps = {
    supported: true,
    getPermission: () => permission,
    requestPermission: async () => permission,
    subscribe: vi.fn(async () => ({ endpoint: "e" })),
    unsubscribe: vi.fn(async () => true),
    saveSubscription: vi.fn(async () => undefined),
    removeSubscription: vi.fn(async () => undefined),
    ...over,
  };
  return { deps, set: (p: NotificationPermission) => (permission = p) };
}

describe("web push permission handling (Req 21.6, 21.7)", () => {
  it("subscribes and registers when permission is granted", async () => {
    const { deps, set } = pushDeps();
    deps.requestPermission = async () => {
      set("granted");
      return "granted";
    };
    expect(await enablePush(deps)).toEqual({ status: "granted" });
    expect(deps.saveSubscription).toHaveBeenCalledWith({ endpoint: "e" });
  });
  it("does not subscribe and removes any subscription when denied", async () => {
    const { deps } = pushDeps({ permission: "denied" });
    expect(await enablePush(deps)).toEqual({ status: "denied" });
    expect(deps.subscribe).not.toHaveBeenCalled();
    expect(deps.removeSubscription).toHaveBeenCalled();
  });
  it("stops web push when permission was revoked", async () => {
    const { deps } = pushDeps({ permission: "denied" });
    expect(await reconcilePush(deps)).toBe("denied");
    expect(deps.unsubscribe).toHaveBeenCalled();
  });
  it("reports unsupported and surfaces failures", async () => {
    expect(await enablePush(pushDeps({ supported: false }).deps)).toEqual({
      status: "unsupported",
    });
    const failing = pushDeps({
      permission: "granted",
      removeSubscription: async () => {
        throw new Error("x");
      },
    }).deps;
    expect((await disablePush(failing)).error).toBe(true);
  });
});

/** Runs public/sw.js in a vm with a minimal in-memory Cache API. */
function loadServiceWorker() {
  const source = readFileSync(
    fileURLToPath(new URL("../../public/sw.js", import.meta.url)),
    "utf8",
  );
  const stores = new Map<string, Map<string, Response>>();
  const open = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const s = stores.get(name)!;
    return {
      // Like the real Cache API, every match yields a fresh, unread Response.
      match: async (r: string | Request) => s.get(typeof r === "string" ? r : r.url)?.clone(),
      put: async (r: string | Request, res: Response) =>
        void s.set(typeof r === "string" ? r : r.url, res),
      delete: async (r: string) => s.delete(r),
      addAll: async (urls: string[]) => {
        for (const u of urls) s.set(u, new Response("x"));
      },
    };
  };
  const caches = {
    open: async (n: string) => open(n),
    match: async (u: string) => {
      for (const s of stores.values()) if (s.has(u)) return s.get(u)!.clone();
      return undefined;
    },
    keys: async () => [...stores.keys()],
    delete: async (n: string) => stores.delete(n),
  };
  const handlers: Record<string, (e: unknown) => void> = {};
  const net = { online: true, calls: 0 };
  const sandbox = {
    self: {
      location: { origin: "https://app.test" },
      addEventListener: (t: string, h: (e: unknown) => void) => {
        handlers[t] = h;
      },
      clients: { claim: async () => undefined },
      skipWaiting: vi.fn(),
    },
    caches,
    fetch: async () => {
      net.calls++;
      if (!net.online) throw new TypeError("offline");
      const res = new Response("<html>raffle</html>", { status: 200 });
      Object.defineProperty(res, "type", { value: "basic" });
      return res;
    },
    Response,
    Headers,
    URL,
    Date, // share the host Date so tests can control the clock
    Notification: { permission: "granted" },
  };
  vm.runInNewContext(source, sandbox);
  async function navigate(path: string) {
    let result: Promise<Response> | undefined;
    const pending: Promise<unknown>[] = [];
    handlers.fetch!({
      request: { method: "GET", mode: "navigate", url: "https://app.test" + path },
      respondWith: (p: Promise<Response>) => (result = p),
      waitUntil: (p: Promise<unknown>) => pending.push(p),
    });
    const res = await result!;
    await Promise.all(pending);
    return res;
  }
  async function install() {
    const pending: Promise<unknown>[] = [];
    handlers.install!({ waitUntil: (p: Promise<unknown>) => pending.push(p) });
    await Promise.all(pending);
  }
  return { navigate, install, net, stores, sandbox, handlers };
}

describe("service worker (Req 21.2, 21.3)", () => {
  it("serves a raffle page loaded within 7 days while offline", async () => {
    const sw = loadServiceWorker();
    await sw.install();
    expect(await (await sw.navigate("/raffles/1")).text()).toContain("raffle");
    sw.net.online = false;
    expect(await (await sw.navigate("/raffles/1")).text()).toContain("raffle");
  });

  it("shows the offline notice for a raffle page never loaded", async () => {
    const sw = loadServiceWorker();
    await sw.install();
    sw.net.online = false;
    const res = await sw.navigate("/raffles/never");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-sw-cached-at")).toBeNull();
    expect(await res.text()).toBe("x"); // the precached offline fallback
  });

  it("does not serve a copy older than 7 days when offline", async () => {
    const sw = loadServiceWorker();
    await sw.install();
    const realNow = Date.now;
    const t0 = realNow();
    Date.now = () => t0;
    try {
      await sw.navigate("/raffles/1");
      sw.net.online = false;
      Date.now = () => t0 + 7 * 24 * 60 * 60 * 1000 - 1000;
      expect(await (await sw.navigate("/raffles/1")).text()).toContain("raffle");
      Date.now = () => t0 + 7 * 24 * 60 * 60 * 1000 + 1000;
      expect(await (await sw.navigate("/raffles/1")).text()).toBe("x");
    } finally {
      Date.now = realNow;
    }
  });

  it("does not skip waiting until the page asks (update prompt)", async () => {
    const sw = loadServiceWorker();
    await sw.install();
    expect(sw.sandbox.self.skipWaiting).not.toHaveBeenCalled();
    sw.handlers.message!({ data: { type: "SKIP_WAITING" } });
    expect(sw.sandbox.self.skipWaiting).toHaveBeenCalledTimes(1);
  });
});
