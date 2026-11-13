import { describe, expect, it } from "vitest";
import { InMemoryJobStore } from "./memory-store.js";
import {
  backoffDelayMs,
  retryDecision,
  Scheduler,
  type AdminAlert,
  type JobRecord,
} from "./scheduler.js";

const T0 = new Date("2030-01-01T00:00:00Z");
const key = { jobType: "close", entityId: "r1", occurrence: "2030-01-01" };

function setup(store = new InMemoryJobStore()) {
  const clock = { t: T0.getTime() };
  const alerts: AdminAlert[] = [];
  const scheduler = new Scheduler({
    store,
    now: () => new Date(clock.t),
    alertAdmins: (a) => void alerts.push(a),
  });
  return { store, clock, alerts, scheduler };
}

describe("backoff", () => {
  it("doubles the delay and gives up after the third attempt", () => {
    expect(backoffDelayMs(1)).toBe(30_000);
    expect(backoffDelayMs(2)).toBe(60_000);
    expect(retryDecision(2)).toEqual({ action: "retry", delayMs: 60_000 });
    expect(retryDecision(3)).toEqual({ action: "fail" });
  });
});

describe("Scheduler", () => {
  it("schedules each key once and runs it exactly once across ticks and restarts", async () => {
    const { store, scheduler } = setup();
    let runs = 0;
    scheduler.register("close", async () => void runs++);
    expect(await scheduler.schedule({ ...key, runAt: T0 })).toBe(true);
    expect(await scheduler.schedule({ ...key, runAt: T0 })).toBe(false);
    await scheduler.tick();
    await scheduler.tick();
    const restarted = setup(store).scheduler;
    restarted.register("close", async () => void runs++);
    await restarted.resume();
    await restarted.tick();
    expect(runs).toBe(1);
    expect((await store.get(key))?.status).toBe("done");
  });

  it("does not run jobs before they are due", async () => {
    const { clock, scheduler } = setup();
    let runs = 0;
    scheduler.register("close", async () => void runs++);
    await scheduler.schedule({ ...key, runAt: new Date(T0.getTime() + 1000) });
    await scheduler.tick();
    expect(runs).toBe(0);
    clock.t += 1000;
    await scheduler.tick();
    expect(runs).toBe(1);
  });

  it("resumes a job interrupted by a crash", async () => {
    const { store, scheduler } = setup();
    await scheduler.schedule({ ...key, runAt: T0 });
    await store.claimDue(T0, 10); // crashed mid-run
    let runs = 0;
    scheduler.register("close", async () => void runs++);
    await scheduler.tick();
    expect(runs).toBe(0);
    expect(await scheduler.resume()).toBe(1);
    await scheduler.tick();
    expect(runs).toBe(1);
  });

  it("retries with exponential backoff, keeps the entry, and alerts after the third failure", async () => {
    const { store, clock, alerts, scheduler } = setup();
    const times: number[] = [];
    scheduler.register("close", async (_j: JobRecord) => {
      times.push(clock.t - T0.getTime());
      throw new Error("provider down");
    });
    await scheduler.schedule({ ...key, runAt: T0 });
    for (let i = 0; i < 10; i++) {
      await scheduler.tick();
      if (i === 0) {
        expect((await store.get(key))?.status).toBe("queued");
        expect(alerts).toHaveLength(0);
      }
      clock.t += 30_000;
    }
    expect(times).toEqual([0, 30_000, 90_000]);
    const job = await store.get(key);
    expect(job?.status).toBe("failed");
    expect(job?.attempts).toBe(3);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.error).toBe("provider down");
  });

  it("succeeds on a later attempt without alerting", async () => {
    const { clock, alerts, scheduler, store } = setup();
    let n = 0;
    scheduler.register("close", async () => {
      if (++n < 2) throw new Error("flaky");
    });
    await scheduler.schedule({ ...key, runAt: T0 });
    await scheduler.tick();
    clock.t += 30_000;
    await scheduler.tick();
    expect((await store.get(key))?.status).toBe("done");
    expect(alerts).toHaveLength(0);
  });
});
