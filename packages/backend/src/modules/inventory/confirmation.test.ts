import { describe, expect, it } from "vitest";
import { seededRng } from "@raffle/shared";
import { reservationExpiry } from "./confirmation-core.js";
import { createConfirmationService } from "./confirmation.js";
import type { LatePaymentRefundRequest } from "./confirmation.js";
import type { ReleasedOrder } from "./confirmation-repository.js";
import { registerExpiryJobs, scheduleDeadlineRelease } from "./expiry-jobs.js";
import { MemoryInventoryRepository } from "./memory-repository.js";
import { createInventoryService } from "./service.js";
import { Scheduler } from "../scheduler/scheduler.js";
import { InMemoryJobStore } from "../scheduler/memory-store.js";

const T0 = new Date("2030-01-01T00:00:00Z");
const DEADLINE = new Date("2030-01-01T01:00:00Z");

async function setup() {
  const repo = new MemoryInventoryRepository();
  repo.addRaffle("r1", {
    status: "published",
    totalTickets: 10,
    ticketPriceMinor: 500n,
    currency: "USD",
    maxPerPlayer: null,
    deadline: DEADLINE,
  });
  let now = T0;
  let id = 0;
  const clock = { now: () => now };
  const inv = createInventoryService({
    repo,
    rng: seededRng(1),
    newId: () => `o${++id}`,
    clock,
    reservationTimeoutMs: 600_000,
  });
  await inv.createTickets("r1", 10);
  const refunds: LatePaymentRefundRequest[] = [];
  const notices: ReleasedOrder[] = [];
  const svc = createConfirmationService({
    repo,
    clock,
    refunds: {
      refundInFull: (r) => {
        refunds.push(r);
        return Promise.resolve();
      },
    },
    notifier: {
      purchaseNotCompleted: (o) => {
        notices.push(o);
        return Promise.resolve();
      },
    },
  });
  return {
    repo,
    inv,
    svc,
    refunds,
    notices,
    set: (d: Date) => (now = d),
  };
}

describe("reservationExpiry", () => {
  it("uses the default timeout for synchronous methods", () => {
    expect(reservationExpiry("card", T0, 10).toISOString()).toBe("2030-01-01T00:10:00.000Z");
  });
  it("caps asynchronous methods at 72 hours", () => {
    const far = new Date(T0.getTime() + 200 * 3_600_000);
    expect(reservationExpiry("ach", T0, 10, far).toISOString()).toBe("2030-01-04T00:00:00.000Z");
    const near = new Date(T0.getTime() + 3_600_000);
    expect(reservationExpiry("cash_network", T0, 10, near)).toEqual(near);
  });
});

describe("confirmPayment", () => {
  it("converts held tickets to sold exactly once under repeated delivery", async () => {
    const { inv, svc, repo, refunds } = await setup();
    const r = await inv.reserve("r1", "p1", [1, 2]);
    const orderId = r.ok ? r.value.orderId : "";
    const first = await svc.confirmPayment({ paymentId: "pay1", orderId });
    const again = await Promise.all(
      [1, 2, 3].map(() => svc.confirmPayment({ paymentId: "pay1", orderId })),
    );
    expect(first.effect).toBe("sold");
    expect(again.map((a) => a.effect)).toEqual(["noop", "noop", "noop"]);
    expect(await inv.counts("r1")).toEqual({ available: 8, reserved: 0, sold: 2, cancelled: 0 });
    expect(repo.orderStatus(orderId)).toBe("paid");
    expect(refunds).toHaveLength(0);
  });

  it("sells an expired reservation whose tickets are still available", async () => {
    const { inv, svc, set } = await setup();
    const r = await inv.reserve("r1", "p1", [3]);
    const orderId = r.ok ? r.value.orderId : "";
    set(new Date(T0.getTime() + 700_000));
    await svc.releaseExpired();
    expect((await svc.confirmPayment({ paymentId: "p", orderId })).effect).toBe("sold");
    expect(await inv.counts("r1")).toMatchObject({ sold: 1, available: 9 });
  });

  it("refunds in full and leaves tickets unchanged when a ticket was taken", async () => {
    const { inv, svc, repo, refunds, set } = await setup();
    const a = await inv.reserve("r1", "p1", [4, 5]);
    const orderA = a.ok ? a.value.orderId : "";
    set(new Date(T0.getTime() + 700_000));
    await svc.releaseExpired();
    await inv.reserve("r1", "p2", [5]);
    const out = await svc.confirmPayment({ paymentId: "payA", orderId: orderA });
    expect(out.effect).toBe("refund");
    expect(refunds).toEqual([
      { paymentId: "payA", orderId: orderA, raffleId: "r1", playerId: "p1" },
    ]);
    const s = repo.ticketStatuses("r1");
    expect([s.get(4), s.get(5)]).toEqual(["available", "reserved"]);
    expect((await svc.confirmPayment({ paymentId: "payA", orderId: orderA })).effect).toBe("noop");
    expect(repo.orderStatus(orderA)).toBe("refunded");
  });

  it("reports an unknown order", async () => {
    const { svc } = await setup();
    expect((await svc.confirmPayment({ paymentId: "x", orderId: "nope" })).effect).toBe(
      "not_found",
    );
  });
});

describe("expiry", () => {
  it("expires a pending asynchronous payment and notifies once", async () => {
    const { inv, svc, repo, notices, set } = await setup();
    const r = await inv.reserve("r1", "p1", [6]);
    const orderId = r.ok ? r.value.orderId : "";
    repo.setPayment(orderId, "pending");
    set(new Date(T0.getTime() + 600_000));
    const out = await svc.releaseExpired();
    expect(out.tickets).toBe(1);
    expect(repo.paymentStatus(orderId)).toBe("expired");
    expect(repo.orderStatus(orderId)).toBe("expired");
    expect(notices.map((n) => n.orderId)).toEqual([orderId]);
    expect((await svc.releaseExpired()).tickets).toBe(0);
    expect(notices).toHaveLength(1);
  });

  it("holds in-progress payments at the deadline for up to 15 minutes", async () => {
    const { inv, svc, repo, set } = await setup();
    const a = await inv.reserve("r1", "p1", [1]);
    const b = await inv.reserve("r1", "p2", [2]);
    if (!a.ok || !b.ok) throw new Error("reserve failed");
    repo.setPayment(a.value.orderId, "pending");
    set(DEADLINE);
    const first = await svc.releaseAtDeadline("r1");
    expect(first.tickets).toBe(1);
    expect(first.heldOrders).toBe(1);
    expect(repo.ticketStatuses("r1").get(1)).toBe("reserved");
    set(new Date(DEADLINE.getTime() + 15 * 60_000));
    const second = await svc.releaseAtDeadline("r1");
    expect(second.tickets).toBe(1);
    expect(second.heldOrders).toBe(0);
    expect(repo.ticketStatuses("r1").get(1)).toBe("available");
  });

  it("runs the sweep and deadline jobs through the scheduler", async () => {
    const { inv, svc, set } = await setup();
    await inv.reserve("r1", "p1", [7]);
    const store = new InMemoryJobStore();
    let now = T0;
    const scheduler = new Scheduler({ store, now: () => now, alertAdmins: () => undefined });
    await registerExpiryJobs(scheduler, svc, { now: () => now });
    await scheduleDeadlineRelease(scheduler, "r1", DEADLINE);
    now = new Date(T0.getTime() + 605_000);
    set(now);
    const tick = await scheduler.tick();
    expect(tick.failed).toBe(0);
    expect((await inv.counts("r1")).reserved).toBe(0);
    expect(
      await store.get({
        jobType: "reservation.sweep",
        entityId: "global",
        occurrence: String(Math.floor(now.getTime() / 5000) + 1),
      }),
    ).not.toBeNull();
  });
});
