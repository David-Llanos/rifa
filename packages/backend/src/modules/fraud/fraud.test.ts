import { describe, expect, it, vi } from "vitest";
import { manualClock } from "@raffle/shared";
import {
  BLOCKED_MESSAGE,
  FraudService,
  HighRiskOwnerRegistry,
  InMemoryFraudRecorder,
  InMemoryOrderReviewQueue,
  InMemoryRateLimitStore,
  computeRiskScore,
  decide,
  rateLimit,
  scoreWithTimeout,
  suspendFraudulentRaffle,
  type FraudPorts,
  type PurchaseContext,
} from "./index.js";

const t = { review: 40, block: 70 };

const ctx = (over: Partial<PurchaseContext> = {}): PurchaseContext => ({
  orderId: "o1",
  reservationId: "r1",
  raffleId: "raf1",
  userId: "u1",
  ip: "1.1.1.1",
  deviceId: "d1",
  deviceIsNew: false,
  usersOnDevice: 1,
  ipFlagged: false,
  usersOnIp: 1,
  purchasesLastHour: 0,
  failedPaymentsLast30d: 0,
  chargebacksLast365d: 0,
  accountAgeDays: 100,
  ...over,
});

function setup(score: number | "throw" = 10) {
  const clock = manualClock(new Date("2025-01-01T00:00:00Z"));
  const queue = new InMemoryOrderReviewQueue();
  const recorder = new InMemoryFraudRecorder();
  const ports: FraudPorts = {
    releaseReservation: vi.fn(),
    notifyPlayerUnderReview: vi.fn(),
    notifyAdmins: vi.fn(),
    suspendSales: vi.fn(),
  };
  const scorer = {
    score: () => (score === "throw" ? Promise.reject(new Error("down")) : Promise.resolve(score)),
  };
  const svc = new FraudService(
    scorer,
    new InMemoryRateLimitStore(),
    queue,
    recorder,
    ports,
    clock,
    {
      thresholds: t,
    },
  );
  return { clock, queue, recorder, ports, svc };
}

describe("decide", () => {
  it("applies thresholds at the boundaries", () => {
    expect(decide(39, t)).toBe("allow");
    expect(decide(40, t)).toBe("review");
    expect(decide(69, t)).toBe("review");
    expect(decide(70, t)).toBe("block");
    expect(decide(100, t)).toBe("block");
  });
  it("holds for review on error", () => {
    expect(decide("error", t)).toBe("review");
  });
  it("rejects invalid thresholds", () => {
    expect(() => decide(1, { review: 70, block: 40 })).toThrow();
  });
});

describe("rateLimit", () => {
  const ts = Array.from({ length: 10 }, (_, i) => 1000 + i * 100);
  it("allows up to 10 and rejects the 11th with retry-after", () => {
    expect(rateLimit(ts.slice(0, 9), 2000).allowed).toBe(true);
    const r = rateLimit(ts, 2000);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBe(1000 + 60_000 - 2000);
  });
  it("allows again once the window passes", () => {
    expect(rateLimit(ts, 61_000).allowed).toBe(true);
  });
});

describe("FraudService", () => {
  it("allows low scores", async () => {
    const { svc } = setup(10);
    expect(await svc.evaluatePurchase(ctx())).toEqual({ status: "allowed", score: 10 });
  });
  it("blocks, records, and releases the reservation", async () => {
    const { svc, ports, recorder } = setup(90);
    const r = await svc.evaluatePurchase(ctx());
    expect(r).toMatchObject({ status: "blocked", message: BLOCKED_MESSAGE });
    expect(ports.releaseReservation).toHaveBeenCalledWith("r1");
    expect(recorder.records[0]).toMatchObject({ kind: "purchase_blocked", score: 90 });
  });
  it("queues and notifies on review and on scorer error", async () => {
    const a = setup(50);
    expect((await a.svc.evaluatePurchase(ctx())).status).toBe("under_review");
    expect(a.queue.entries[0]).toMatchObject({ reason: "score_in_review_band", score: 50 });
    expect(a.ports.notifyPlayerUnderReview).toHaveBeenCalled();
    const b = setup("throw");
    expect((await b.svc.evaluatePurchase(ctx())).status).toBe("under_review");
    expect(b.queue.entries[0]).toMatchObject({ reason: "scoring_error", score: null });
  });
  it("rate limits the 11th request per user and reports time remaining", async () => {
    const { svc, clock } = setup(10);
    for (let i = 0; i < 10; i++) {
      expect((await svc.evaluatePurchase(ctx())).status).toBe("allowed");
      clock.advance(100);
    }
    const r = await svc.evaluatePurchase(ctx());
    expect(r.status).toBe("rate_limited");
    if (r.status === "rate_limited") expect(r.retryAfterMs).toBe(59_000);
  });
});

describe("scoring", () => {
  it("times out to error", async () => {
    const slow = { score: () => new Promise<number>(() => undefined) };
    expect(await scoreWithTimeout(slow, ctx(), 20)).toBe("error");
  });
  it("treats out-of-range scores as error", async () => {
    expect(await scoreWithTimeout({ score: () => Promise.resolve(101) }, ctx())).toBe("error");
  });
  it("computes an integer within 0..100", () => {
    expect(computeRiskScore(ctx())).toBe(0);
    const s = computeRiskScore(
      ctx({
        ipFlagged: true,
        chargebacksLast365d: 9,
        failedPaymentsLast30d: 9,
        purchasesLastHour: 99,
      }),
    );
    expect(Number.isInteger(s) && s >= 0 && s <= 100).toBe(true);
  });
});

describe("raffle suspension and owner approval", () => {
  it("suspends sales and notifies admins on fraud signals", async () => {
    const { ports, recorder, clock } = setup();
    const r = await suspendFraudulentRaffle(
      "raf1",
      { prizeVerified: false, duplicateIdentityCount: 2 },
      ports,
      recorder,
      clock,
    );
    expect(r).toMatchObject({ suspended: true, withinDeadline: true });
    expect(r.signals).toEqual(["prize_does_not_exist", "duplicate_identities"]);
    expect(ports.suspendSales).toHaveBeenCalledWith("raf1");
    expect(ports.notifyAdmins).toHaveBeenCalled();
  });
  it("does nothing without signals", async () => {
    const { ports, recorder, clock } = setup();
    const r = await suspendFraudulentRaffle(
      "raf1",
      { prizeVerified: true, duplicateIdentityCount: 1 },
      ports,
      recorder,
      clock,
    );
    expect(r.suspended).toBe(false);
    expect(ports.suspendSales).not.toHaveBeenCalled();
  });
  it("requires admin approval for each raffle of a high-risk owner", () => {
    const clock = manualClock(new Date("2025-01-01T00:00:00Z"));
    const reg = new HighRiskOwnerRegistry(clock, new InMemoryFraudRecorder());
    expect(reg.requestVisibility("o1", "a")).toBe("visible");
    reg.flag("o1");
    expect(reg.requestVisibility("o1", "a")).toBe("pending_admin_approval");
    expect(reg.requestVisibility("o1", "b")).toBe("pending_admin_approval");
    expect(reg.approve("a")).toBe(true);
    expect(reg.requestVisibility("o1", "a")).toBe("visible");
    expect(reg.requestVisibility("o1", "b")).toBe("pending_admin_approval");
    expect(reg.pendingApprovals()).toHaveLength(1);
  });
});
