import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { seededRng } from "@raffle/shared";
import { pickRandomAvailable, totalCount } from "./core.js";
import { MemoryInventoryRepository } from "./memory-repository.js";
import { createInventoryService } from "./service.js";
import type { InventoryRaffle } from "./types.js";

const T0 = new Date("2030-01-01T00:00:00Z");
const raffle = (over: Partial<InventoryRaffle> = {}): InventoryRaffle => ({
  status: "published",
  totalTickets: 20,
  ticketPriceMinor: 500n,
  currency: "USD",
  maxPerPlayer: null,
  deadline: new Date("2031-01-01T00:00:00Z"),
  ...over,
});

async function setup(over: Partial<InventoryRaffle> = {}, seed = 1) {
  const repo = new MemoryInventoryRepository();
  repo.addRaffle("r1", raffle(over));
  let id = 0;
  let now = T0;
  const svc = createInventoryService({
    repo,
    rng: seededRng(seed),
    newId: () => `o${++id}`,
    clock: { now: () => now },
    reservationTimeoutMs: 600_000,
  });
  await svc.createTickets("r1", raffle(over).totalTickets);
  return { repo, svc, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

describe("reserve", () => {
  it("reserves all requested tickets with an expiry of now plus the timeout", async () => {
    const { svc } = await setup();
    const r = await svc.reserve("r1", "p1", [1, 2, 3]);
    expect(r.ok && r.value.expiresAt.toISOString()).toBe("2030-01-01T00:10:00.000Z");
    expect(await svc.counts("r1")).toEqual({ available: 17, reserved: 3, sold: 0, cancelled: 0 });
  });

  it("is all-or-nothing and names the unavailable tickets", async () => {
    const { svc, repo } = await setup();
    await svc.reserve("r1", "p1", [2]);
    const r = await svc.reserve("r1", "p2", [1, 2, 3]);
    expect(r).toEqual({ ok: false, error: { kind: "unavailable", numbers: [2] } });
    expect(repo.ticketStatuses("r1").get(1)).toBe("available");
    expect(repo.ticketStatuses("r1").get(3)).toBe("available");
    expect(repo.orderCount()).toBe(1);
  });

  it("grants exactly one of many concurrent requests for the same ticket", async () => {
    const { svc } = await setup();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => svc.reserve("r1", `p${i}`, [5])),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await svc.counts("r1")).reserved).toBe(1);
  });

  it("rejects when sales are closed or the raffle is cancelled", async () => {
    const closed = await setup({ status: "sales_closed" });
    expect(await closed.svc.reserve("r1", "p", [1])).toEqual({
      ok: false,
      error: { kind: "sales_closed" },
    });
    const cancelled = await setup({ status: "cancelled" });
    expect(await cancelled.svc.reserve("r1", "p", [1])).toEqual({
      ok: false,
      error: { kind: "cancelled" },
    });
    const late = await setup({ deadline: T0 });
    expect(await late.svc.assignRandom("r1", "p", 1)).toEqual({
      ok: false,
      error: { kind: "sales_closed" },
    });
  });

  it("enforces the per-player limit across reservations", async () => {
    const { svc } = await setup({ maxPerPlayer: 3 });
    expect((await svc.reserve("r1", "p", [1, 2])).ok).toBe(true);
    const r = await svc.reserve("r1", "p", [3, 4]);
    expect(r).toEqual({
      ok: false,
      error: { kind: "limit_exceeded", max: 3, held: 2, requested: 2 },
    });
    expect((await svc.reserve("r1", "other", [3, 4, 5])).ok).toBe(true);
  });

  it("rejects invalid selections and more than 100 tickets", async () => {
    const { svc } = await setup({ totalTickets: 500 });
    for (const sel of [[], [0], [501], [1, 1], [1.5]]) {
      expect(await svc.reserve("r1", "p", sel)).toEqual({
        ok: false,
        error: { kind: "invalid_selection" },
      });
    }
    const many = Array.from({ length: 101 }, (_, i) => i + 1);
    expect((await svc.reserve("r1", "p", many)).ok).toBe(false);
    expect((await svc.reserve("r1", "p", many.slice(0, 100))).ok).toBe(true);
  });

  it("reports an unknown raffle", async () => {
    const { svc } = await setup();
    expect(await svc.reserve("nope", "p", [1])).toEqual({
      ok: false,
      error: { kind: "not_found" },
    });
  });
});

describe("assignRandom", () => {
  it("reserves the requested count of distinct available numbers", async () => {
    const { svc } = await setup();
    await svc.reserve("r1", "p1", [1, 2, 3, 4, 5]);
    const r = await svc.assignRandom("r1", "p2", 10);
    if (!r.ok) throw new Error("expected ok");
    expect(new Set(r.value.numbers).size).toBe(10);
    expect(r.value.numbers.every((n) => n >= 6 && n <= 20)).toBe(true);
    expect(await svc.counts("r1")).toEqual({ available: 5, reserved: 15, sold: 0, cancelled: 0 });
  });

  it("fails without changes when too few tickets are available", async () => {
    const { svc } = await setup();
    await svc.reserve(
      "r1",
      "p1",
      Array.from({ length: 18 }, (_, i) => i + 1),
    );
    const r = await svc.assignRandom("r1", "p2", 3);
    expect(r).toEqual({ ok: false, error: { kind: "unavailable", numbers: [] } });
    expect((await svc.counts("r1")).available).toBe(2);
  });
});

describe("releaseExpired, cancellation and counts", () => {
  it("releases only expired reservations", async () => {
    const { svc, advance } = await setup();
    await svc.reserve("r1", "p1", [1, 2]);
    advance(300_000);
    await svc.reserve("r1", "p2", [3]);
    advance(300_000);
    expect(await svc.releaseExpired()).toBe(2);
    expect(await svc.counts("r1")).toEqual({ available: 19, reserved: 1, sold: 0, cancelled: 0 });
  });

  it("cancels all tickets and then rejects reservations", async () => {
    const { svc, repo } = await setup();
    await svc.reserve("r1", "p1", [1]);
    repo.markSold("r1", [2]);
    expect(await svc.cancelRaffleTickets("r1")).toBe(20);
    expect(await svc.counts("r1")).toEqual({ available: 0, reserved: 0, sold: 0, cancelled: 20 });
    repo.setRaffleStatus("r1", "cancelled");
    expect(await svc.reserve("r1", "p", [3])).toEqual({ ok: false, error: { kind: "cancelled" } });
  });
});

describe("properties", () => {
  it("Property 11: random picks are distinct, available and of the requested size", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 1000 }), { maxLength: 60 }),
        fc.integer({ min: 0, max: 70 }),
        fc.integer(),
        (available, qty, seed) => {
          const picked = pickRandomAvailable(available, qty, seededRng(seed));
          if (qty < 1 || qty > available.length) return picked === null;
          return (
            picked !== null &&
            picked.length === qty &&
            new Set(picked).size === qty &&
            picked.every((n) => available.includes(n))
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Property 8: counts always sum to the total across random operation sequences", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.tuple(
            fc.constantFrom("reserve", "random", "release"),
            fc.integer({ min: 1, max: 20 }),
          ),
          {
            maxLength: 15,
          },
        ),
        async (ops) => {
          const { svc, advance } = await setup({}, 7);
          for (const [op, n] of ops) {
            if (op === "reserve") await svc.reserve("r1", `p${n % 3}`, [n, (n % 20) + 1]);
            else if (op === "random") await svc.assignRandom("r1", `p${n % 3}`, (n % 4) + 1);
            else {
              advance(700_000);
              await svc.releaseExpired();
            }
            if (totalCount(await svc.counts("r1")) !== 20) return false;
          }
          await svc.cancelRaffleTickets("r1");
          const c = await svc.counts("r1");
          return c.cancelled === 20 && totalCount(c) === 20;
        },
      ),
      { numRuns: 100 },
    );
  });
});
