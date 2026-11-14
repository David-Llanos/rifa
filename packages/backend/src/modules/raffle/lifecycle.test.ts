import { describe, expect, it } from "vitest";
import { manualClock } from "@raffle/shared";
import {
  applyEvent,
  closureDecision,
  createRaffleLifecycleService,
  deadlineDisplay,
  deadlineFromJurisdictionLocal,
  isIllegal,
  registerLifecycleJobs,
  reminderRunAt,
  runWithRetries,
  transition,
  type CancellationRequest,
  type JobRegistry,
  type LifecycleRepository,
  type OwnerNoticeKind,
  type Raffle,
  type RaffleInput,
} from "./index.js";

const NOW = new Date("2025-01-01T00:00:00Z");
const H = 3600_000;

function baseInput(over: Partial<RaffleInput> = {}): RaffleInput {
  return {
    title: { en: "Car" },
    description: { en: "A car" },
    defaultLocale: "en",
    prizeImages: ["a.png"],
    prizeValueMinor: 1000n,
    country: "US",
    currency: "USD",
    totalTickets: 100,
    ticketPriceMinor: 500n,
    deadline: new Date(NOW.getTime() + 48 * H),
    tzName: "America/New_York",
    numberSelection: false,
    earlyClosure: false,
    lotteryId: "us-ny-numbers-evening",
    drawAt: new Date(NOW.getTime() + 72 * H),
    winningRule: { id: "LAST_N_DIGITS_OF_FIRST_PRIZE" },
    fallbackRule: "redraw",
    ...over,
  };
}

describe("transition", () => {
  it("allows the lifecycle edges and rejects others", () => {
    expect(transition("draft", "submit")).toBe("pending_review");
    expect(transition("pending_review", "publication_approved")).toBe("published");
    expect(transition("pending_review", "publication_rejected")).toBe("draft");
    expect(transition("published", "close_sales")).toBe("sales_closed");
    expect(transition("sales_closed", "threshold_met")).toBe("awaiting_draw");
    expect(transition("sales_closed", "threshold_not_met")).toBe("cancelled");
    expect(transition("awaiting_draw", "winner_recorded")).toBe("completed");
    expect(isIllegal(transition("completed", "cancel"))).toBe(true);
    expect(isIllegal(transition("sales_closed", "cancel"))).toBe(true);
    expect(isIllegal(transition("draft", "close_sales"))).toBe(true);
    expect(applyEvent("completed", "cancel")).toBe("completed");
  });
});

describe("closureDecision", () => {
  const s = {
    status: "published" as const,
    now: NOW,
    deadline: new Date(NOW.getTime() + H),
    soldCount: 5,
    totalTickets: 10,
    minThreshold: 3,
    earlyClosure: false,
  };
  it("keeps sales open before the deadline", () => {
    expect(closureDecision(s)).toBe("none");
  });
  it("closes at the deadline", () => {
    expect(closureDecision({ ...s, now: s.deadline })).toBe("sales_closed");
  });
  it("closes on sell-out only with early closure", () => {
    expect(closureDecision({ ...s, soldCount: 10 })).toBe("none");
    expect(closureDecision({ ...s, soldCount: 10, earlyClosure: true })).toBe("sales_closed");
  });
  it("routes by threshold after closure", () => {
    expect(closureDecision({ ...s, status: "sales_closed", soldCount: 3 })).toBe("awaiting_draw");
    expect(closureDecision({ ...s, status: "sales_closed", soldCount: 2 })).toBe("cancel_refund");
  });
  it("does nothing for other statuses", () => {
    expect(closureDecision({ ...s, status: "draft", now: s.deadline })).toBe("none");
  });
});

describe("time zones and reminders", () => {
  it("converts jurisdiction-local deadlines and displays offsets", () => {
    const utc = deadlineFromJurisdictionLocal(
      { year: 2025, month: 3, day: 1, hour: 12, minute: 0, second: 0 },
      "America/Bogota",
    );
    expect(utc.toISOString()).toBe("2025-03-01T17:00:00.000Z");
    expect(deadlineDisplay(utc, "America/Bogota")).toContain("UTC-05:00");
  });
  it("schedules the reminder 24h before the deadline, never in the past", () => {
    const deadline = new Date(NOW.getTime() + 48 * H);
    expect(reminderRunAt(deadline, NOW).getTime()).toBe(NOW.getTime() + 24 * H);
    expect(reminderRunAt(new Date(NOW.getTime() + 2 * H), NOW)).toEqual(NOW);
  });
});

interface Harness {
  raffles: Map<string, Raffle>;
  requests: CancellationRequest[];
  sold: { n: number };
  notices: { kind: OwnerNoticeKind; ownerId: string }[];
  jobs: { jobType: string; occurrence: string; runAt: Date }[];
  effects: string[];
  service: ReturnType<typeof createRaffleLifecycleService<null>>;
}

function harness(input: RaffleInput, status: Raffle["status"]): Harness {
  const raffle: Raffle = {
    ...input,
    id: "r1",
    ownerId: "owner",
    status,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const h = {
    raffles: new Map([["r1", raffle]]),
    requests: [] as CancellationRequest[],
    sold: { n: 0 },
    notices: [] as Harness["notices"],
    jobs: [] as Harness["jobs"],
    effects: [] as string[],
  };
  const repo: LifecycleRepository<null> = {
    transaction: (fn) => fn(null),
    insert: async (_t, r) => void h.raffles.set(r.id, r),
    findForUpdate: async (_t, id) => h.raffles.get(id) ?? null,
    update: async (_t, r) => void h.raffles.set(r.id, r),
    soldCount: async () => h.sold.n,
    insertCancellationRequest: async (_t, r) => void h.requests.push(r),
    findPendingCancellation: async () => h.requests.find((r) => r.status === "pending") ?? null,
    updateCancellationRequest: async (_t, r) => {
      const i = h.requests.findIndex((x) => x.id === r.id);
      h.requests[i] = r;
    },
  };
  const service = createRaffleLifecycleService<null>({
    repo,
    audit: { append: async () => undefined },
    inventory: {
      releaseUnpaidReservations: async () => void h.effects.push("release"),
      cancelTickets: async () => void h.effects.push("cancel_tickets"),
    },
    refunds: { startRefunds: async () => void h.effects.push("refunds") },
    notifier: {
      notifyOwner: async (ownerId, _r, kind) => void h.notices.push({ kind, ownerId }),
    },
    jobs: {
      schedule: async (j) => {
        h.jobs.push(j);
        return true;
      },
    },
    newId: () => "req1",
    clock: manualClock(NOW),
  });
  return { ...h, service };
}

describe("publication", () => {
  it("moves draft to pending_review to published and schedules jobs", async () => {
    const h = harness(baseInput(), "draft");
    const sub = await h.service.submitForPublication("owner", "r1");
    expect(sub.ok && sub.value.status).toBe("pending_review");
    const pub = await h.service.resolvePublication("r1", { ok: true, via: "admin_approval" });
    expect(pub.ok && pub.value.status).toBe("published");
    expect(h.jobs.map((j) => j.jobType).sort()).toEqual([
      "raffle.close_sales",
      "raffle.reminder_24h",
    ]);
  });
  it("rejects submit with a deadline under 24 hours and by non-owners", async () => {
    const soon = harness(baseInput({ deadline: new Date(NOW.getTime() + H) }), "draft");
    const r = await soon.service.submitForPublication("owner", "r1");
    expect(!r.ok && r.error.kind).toBe("invalid");
    const other = harness(baseInput(), "draft");
    const o = await other.service.submitForPublication("someone", "r1");
    expect(!o.ok && o.error.kind).toBe("forbidden");
  });
  it("returns to draft and notifies the owner on failure, keeping data", async () => {
    const h = harness(baseInput(), "pending_review");
    const r = await h.service.resolvePublication("r1", { ok: false, reason: "compliance" });
    expect(r.ok && r.value.status).toBe("draft");
    expect(r.ok && r.value.title).toEqual({ en: "Car" });
    expect(h.notices).toEqual([{ kind: "publication_failed", ownerId: "owner" }]);
  });
});

describe("cancellation", () => {
  it("cancels directly when no tickets are sold", async () => {
    const h = harness(baseInput(), "published");
    const r = await h.service.cancel("r1", { id: "owner", role: "owner" }, "changed my mind");
    expect(r.ok && r.value).toBe("cancelled");
    expect(h.raffles.get("r1")?.status).toBe("cancelled");
    expect(h.effects).toEqual(["cancel_tickets", "refunds"]);
  });
  it("keeps the raffle active until an Admin approves when tickets are sold", async () => {
    const h = harness(baseInput(), "published");
    h.sold.n = 4;
    const r = await h.service.cancel("r1", { id: "owner", role: "owner" }, "prize lost");
    expect(r.ok && r.value).toBe("pending_admin_approval");
    expect(h.raffles.get("r1")?.status).toBe("published");
    const denied = await h.service.approveCancellation("r1", { id: "owner", role: "owner" });
    expect(!denied.ok && denied.error.kind).toBe("forbidden");
    const ok = await h.service.approveCancellation("r1", { id: "admin", role: "admin" });
    expect(ok.ok).toBe(true);
    expect(h.raffles.get("r1")?.status).toBe("cancelled");
    expect(h.effects).toEqual(["cancel_tickets", "refunds"]);
    expect(h.requests[0]?.status).toBe("approved");
  });
  it("rejects empty and over-long reasons and illegal states", async () => {
    const h = harness(baseInput(), "published");
    const actor = { id: "owner", role: "owner" } as const;
    expect((await h.service.cancel("r1", actor, "   ")).ok).toBe(false);
    expect((await h.service.cancel("r1", actor, "x".repeat(501))).ok).toBe(false);
    expect((await h.service.cancel("r1", actor, "x".repeat(500))).ok).toBe(true);
    const done = harness(baseInput(), "completed");
    const r = await done.service.cancel("r1", { id: "admin", role: "admin" }, "late");
    expect(!r.ok && r.error.kind).toBe("illegal_transition");
  });
  it("lets an Admin reject a pending request", async () => {
    const h = harness(baseInput(), "published");
    h.sold.n = 1;
    await h.service.cancel("r1", { id: "owner", role: "owner" }, "reason");
    const r = await h.service.rejectCancellation("r1", { id: "admin", role: "admin" });
    expect(r.ok).toBe(true);
    expect(h.raffles.get("r1")?.status).toBe("published");
    expect(h.notices.at(-1)?.kind).toBe("cancellation_rejected");
  });
});

describe("closure flow", () => {
  it("does not close before the deadline", async () => {
    const h = harness(baseInput(), "published");
    const r = await h.service.closeSales("r1");
    expect(r.ok && r.value).toBe("none");
  });
  it("closes at the deadline then routes to awaiting_draw or cancellation", async () => {
    const input = baseInput({ deadline: new Date(NOW.getTime() - 1), minThreshold: 5 });
    const met = harness(input, "published");
    met.sold.n = 5;
    const closed = await met.service.closeSales("r1");
    expect(closed.ok && closed.value).toBe("sales_closed");
    expect(met.effects).toEqual(["release"]);
    expect(met.jobs.map((j) => j.jobType)).toEqual(["raffle.evaluate_threshold"]);
    const e = await met.service.evaluateThreshold("r1");
    expect(e.ok && e.value).toBe("awaiting_draw");

    const miss = harness(input, "published");
    miss.sold.n = 4;
    await miss.service.closeSales("r1");
    const c = await miss.service.evaluateThreshold("r1");
    expect(c.ok && c.value).toBe("cancelled");
    expect(miss.effects).toEqual(["release", "cancel_tickets", "refunds"]);
    expect(miss.notices.at(-1)?.kind).toBe("raffle_cancelled");
  });
  it("sends the reminder only while published", async () => {
    const pub = harness(baseInput(), "published");
    expect(await pub.service.sendDeadlineReminder("r1")).toBe(true);
    const closed = harness(baseInput(), "sales_closed");
    expect(await closed.service.sendDeadlineReminder("r1")).toBe(false);
  });
});

describe("retry and owner notification", () => {
  it("retries 3 times at 30s intervals then reports failure", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const out = await runWithRetries(
      async () => {
        calls++;
        throw new Error("boom");
      },
      { retries: 3, intervalMs: 30_000, sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(calls).toBe(4);
    expect(sleeps).toEqual([30_000, 30_000, 30_000]);
    expect(out).toEqual({ ok: false, attempts: 4, error: "boom" });
  });
  it("notifies the owner when every retry fails and leaves the raffle unchanged", async () => {
    const h = harness(baseInput({ deadline: new Date(NOW.getTime() - 1) }), "published");
    const handlers = new Map<string, (j: never) => Promise<void>>();
    const registry: JobRegistry = { register: (t, fn) => void handlers.set(t, fn as never) };
    const failing = { ...h.service, closeSales: () => Promise.reject(new Error("db down")) };
    registerLifecycleJobs(registry, {
      service: failing,
      notifier: {
        notifyOwner: async (ownerId, _r, kind) => void h.notices.push({ kind, ownerId }),
      },
      ownerOf: async () => "owner",
      sleep: async () => undefined,
    });
    await handlers.get("raffle.close_sales")?.({ entityId: "r1" } as never);
    expect(h.notices).toEqual([{ kind: "closure_failed", ownerId: "owner" }]);
    expect(h.raffles.get("r1")?.status).toBe("published");
  });
  it("succeeds after a transient failure without notifying", async () => {
    const h = harness(baseInput({ deadline: new Date(NOW.getTime() - 1) }), "published");
    const handlers = new Map<string, (j: never) => Promise<void>>();
    const registry: JobRegistry = { register: (t, fn) => void handlers.set(t, fn as never) };
    let n = 0;
    const flaky = {
      ...h.service,
      closeSales: async () => {
        if (n++ < 2) throw new Error("transient");
        return h.service.closeSales("r1");
      },
    };
    registerLifecycleJobs(registry, {
      service: flaky,
      notifier: {
        notifyOwner: async (ownerId, _r, kind) => void h.notices.push({ kind, ownerId }),
      },
      ownerOf: async () => "owner",
      sleep: async () => undefined,
    });
    await handlers.get("raffle.close_sales")?.({ entityId: "r1" } as never);
    expect(h.notices).toEqual([]);
    expect(h.raffles.get("r1")?.status).toBe("sales_closed");
  });
});
