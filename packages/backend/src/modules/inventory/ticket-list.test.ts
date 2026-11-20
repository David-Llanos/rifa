import { describe, expect, it } from "vitest";
import { parseCsv, seededRng } from "@raffle/shared";
import { createConfirmationService } from "./confirmation.js";
import { createTicketExportService, neutralizeFormula, TICKET_CSV_HEADER } from "./export.js";
import { MemoryInventoryRepository } from "./memory-repository.js";
import type { MemoryTx } from "./memory-repository.js";
import {
  COUNTS_HEARTBEAT_MS,
  InMemoryPubSub,
  countsChannel,
  createCountsPublisher,
  formatSseEvent,
  openCountsStream,
} from "./realtime.js";
import type { StreamTimers } from "./realtime.js";
import { createInventoryService } from "./service.js";
import type { InventoryRaffle, TicketCounts } from "./types.js";

const T0 = new Date("2030-01-01T00:00:00Z");
const RAFFLE: InventoryRaffle = {
  status: "published",
  totalTickets: 5,
  ticketPriceMinor: 500n,
  currency: "USD",
  maxPerPlayer: null,
  deadline: new Date("2031-01-01T00:00:00Z"),
};

async function setup(countsChanged?: (raffleId: string) => void) {
  const repo = new MemoryInventoryRepository();
  repo.addRaffle("r1", RAFFLE);
  let id = 0;
  const clock = { now: () => T0 };
  const inventory = createInventoryService({
    repo,
    rng: seededRng(1),
    newId: () => `o${++id}`,
    clock,
    countsChanged,
  });
  await inventory.createTickets("r1", RAFFLE.totalTickets);
  const confirmation = createConfirmationService({
    repo,
    refunds: { refundInFull: () => Promise.resolve() },
    clock,
    countsChanged,
  });
  return { repo, inventory, confirmation, clock };
}

/** Sells `numbers` to `playerId` through the normal reserve + confirm path. */
async function sell(s: Awaited<ReturnType<typeof setup>>, playerId: string, numbers: number[]) {
  const r = await s.inventory.reserve("r1", playerId, numbers);
  if (!r.ok) throw new Error(r.error.kind);
  await s.confirmation.confirmPayment({
    paymentId: `pay-${r.value.orderId}`,
    orderId: r.value.orderId,
  });
  return r.value.orderId;
}

describe("ticket list (Req 4.5)", () => {
  it("lists every ticket by number with buyer name and purchase time only for sold tickets", async () => {
    const s = await setup();
    s.repo.setDisplayName("p1", "Ana Pérez");
    s.repo.setDisplayName("p2", "Luis");
    await sell(s, "p1", [2]);
    await s.inventory.reserve("r1", "p2", [4]);
    const svc = createTicketExportService({ repo: s.repo });
    const list = await svc.ticketList("r1");
    expect(list.ok && list.value).toEqual([
      { number: 1, status: "available", buyerName: null, purchasedAt: null },
      { number: 2, status: "sold", buyerName: "Ana Pérez", purchasedAt: T0 },
      { number: 3, status: "available", buyerName: null, purchasedAt: null },
      { number: 4, status: "reserved", buyerName: null, purchasedAt: null },
      { number: 5, status: "available", buyerName: null, purchasedAt: null },
    ]);
  });

  it("returns not_found for an unknown raffle", async () => {
    const s = await setup();
    const r = await createTicketExportService({ repo: s.repo }).ticketList("nope");
    expect(r).toEqual({ ok: false, error: { kind: "not_found" } });
  });
});

describe("CSV export (Req 4.6, 4.7)", () => {
  it("contains the ticket list fields for every ticket and parses back to the same values", async () => {
    const s = await setup();
    s.repo.setDisplayName("p1", 'Pérez, "Ana"\nSegunda línea');
    await sell(s, "p1", [1, 3]);
    const r = await createTicketExportService({ repo: s.repo }).exportCsv("r1");
    if (!r.ok) throw new Error(r.error.kind);
    expect(r.value.contentType).toBe("text/csv; charset=utf-8");
    expect(r.value.filename).toBe("raffle-r1-tickets.csv");
    const rows = parseCsv(r.value.body);
    expect(rows[0]).toEqual([...TICKET_CSV_HEADER]);
    expect(rows.slice(1)).toEqual([
      ["1", "sold", 'Pérez, "Ana"\nSegunda línea', T0.toISOString()],
      ["2", "available", "", ""],
      ["3", "sold", 'Pérez, "Ana"\nSegunda línea', T0.toISOString()],
      ["4", "available", "", ""],
      ["5", "available", "", ""],
    ]);
  });

  it("neutralizes buyer names that a spreadsheet would run as formulas", async () => {
    expect(neutralizeFormula("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(neutralizeFormula("+1")).toBe("'+1");
    expect(neutralizeFormula("@x")).toBe("'@x");
    expect(neutralizeFormula("Ana")).toBe("Ana");
    const s = await setup();
    s.repo.setDisplayName("p1", "=cmd()");
    await sell(s, "p1", [1]);
    const r = await createTicketExportService({ repo: s.repo }).exportCsv("r1");
    expect(r.ok && parseCsv(r.value.body)[1]?.[2]).toBe("'=cmd()");
  });

  it("fails with a timeout when the export exceeds the limit and leaves tickets unchanged", async () => {
    const s = await setup();
    await sell(s, "p1", [1]);
    const before = s.repo.ticketStatuses("r1");
    // A listTickets that never resolves stands in for a slow query.
    const slow = Object.create(s.repo) as MemoryInventoryRepository;
    slow.listTickets = () => new Promise(() => undefined);
    const r = await createTicketExportService<MemoryTx>({ repo: slow, timeoutMs: 20 }).exportCsv(
      "r1",
    );
    expect(r).toEqual({ ok: false, error: { kind: "export_failed", reason: "timeout" } });
    expect(s.repo.ticketStatuses("r1")).toEqual(before);
  });

  it("fails when serialization pushes the total past the limit", async () => {
    const s = await setup();
    let t = 0;
    // Each read advances 40 s, so the post-serialization check sees more than 30 s elapsed.
    const clock = { now: () => new Date((t += 40_000)) };
    const r = await createTicketExportService({ repo: s.repo, clock }).exportCsv("r1");
    expect(r).toEqual({ ok: false, error: { kind: "export_failed", reason: "timeout" } });
  });

  it("fails cleanly when the read throws", async () => {
    const s = await setup();
    const broken = Object.create(s.repo) as MemoryInventoryRepository;
    broken.listTickets = () => Promise.reject(new Error("db down"));
    const r = await createTicketExportService<MemoryTx>({ repo: broken }).exportCsv("r1");
    expect(r).toEqual({ ok: false, error: { kind: "export_failed", reason: "error" } });
  });
});

describe("counts change hooks (Req 4.3)", () => {
  it("fire after committed reservations, sales, cancellation and expiry, not after rejections", async () => {
    const calls: string[] = [];
    const s = await setup((id) => calls.push(id));
    expect(calls).toEqual(["r1"]); // createTickets
    calls.length = 0;

    const r = await s.inventory.reserve("r1", "p1", [1]);
    expect(calls).toEqual(["r1"]);
    await s.inventory.reserve("r1", "p2", [1]); // unavailable: rolled back
    expect(calls).toEqual(["r1"]);

    if (!r.ok) throw new Error("reserve failed");
    await s.confirmation.confirmPayment({ paymentId: "pay1", orderId: r.value.orderId });
    expect(calls).toEqual(["r1", "r1"]);

    await s.inventory.reserve("r1", "p3", [2]);
    await s.confirmation.releaseExpired(new Date(T0.getTime() + 11 * 60_000));
    expect(calls).toEqual(["r1", "r1", "r1", "r1"]);

    await s.inventory.cancelRaffleTickets("r1");
    expect(calls).toHaveLength(5);
  });

  it("a throwing listener does not fail the committed operation", async () => {
    const s = await setup(() => {
      throw new Error("redis down");
    });
    const r = await s.inventory.reserve("r1", "p1", [1]);
    expect(r.ok).toBe(true);
    expect(s.repo.ticketStatuses("r1").get(1)).toBe("reserved");
  });
});

const COUNTS: TicketCounts = { available: 4, reserved: 1, sold: 0, cancelled: 0 };

describe("counts publisher", () => {
  it("publishes the current counts on the raffle channel", async () => {
    const pubsub = new InMemoryPubSub();
    const got: string[] = [];
    await pubsub.subscribe(countsChannel("r1"), (m) => got.push(m));
    const pub = createCountsPublisher({
      pubsub,
      readCounts: () => Promise.resolve(COUNTS),
      now: () => T0,
    });
    pub.changed("r1");
    await pub.idle();
    expect(got.map((m) => JSON.parse(m) as unknown)).toEqual([
      { raffleId: "r1", counts: COUNTS, at: T0.toISOString() },
    ]);
  });

  it("coalesces a burst into the in-flight publish plus one follow-up", async () => {
    const pubsub = new InMemoryPubSub();
    let reads = 0;
    let n = 0;
    const pub = createCountsPublisher({
      pubsub,
      readCounts: async () => {
        reads++;
        await Promise.resolve();
        return { ...COUNTS, sold: ++n };
      },
    });
    const got: number[] = [];
    await pubsub.subscribe(countsChannel("r1"), (m) => {
      got.push((JSON.parse(m) as { counts: TicketCounts }).counts.sold);
    });
    for (let i = 0; i < 10; i++) pub.changed("r1");
    await pub.idle();
    expect(reads).toBe(2);
    expect(got).toEqual([1, 2]);
  });

  it("reports failures without throwing", async () => {
    const errors: unknown[] = [];
    const pub = createCountsPublisher({
      pubsub: new InMemoryPubSub(),
      readCounts: () => Promise.reject(new Error("x")),
      onError: (_id, e) => errors.push(e),
    });
    pub.changed("r1");
    await pub.idle();
    expect(errors).toHaveLength(1);
  });
});

function fakeTimers() {
  const intervals = new Map<number, () => void>();
  let next = 0;
  const timers: StreamTimers = {
    setInterval: (fn) => {
      intervals.set(++next, fn);
      return next;
    },
    clearInterval: (h) => intervals.delete(h as number),
  };
  return { timers, tick: () => [...intervals.values()].forEach((f) => f()), intervals };
}

describe("SSE counts stream", () => {
  it("formats events with one data line per input line", () => {
    expect(formatSseEvent("counts", "a\nb", "7")).toBe(
      "event: counts\nid: 7\ndata: a\ndata: b\n\n",
    );
  });

  it("sends retry, initial counts, relayed updates and heartbeats, and unsubscribes on close", async () => {
    const pubsub = new InMemoryPubSub();
    const out: string[] = [];
    const ft = fakeTimers();
    const stream = await openCountsStream({
      raffleId: "r1",
      pubsub,
      readCounts: () => Promise.resolve(COUNTS),
      write: (c) => out.push(c),
      timers: ft.timers,
      now: () => T0,
    });
    expect(out[0]).toBe("retry: 3000\n\n");
    expect(out[1]).toBe(
      formatSseEvent(
        "counts",
        JSON.stringify({ raffleId: "r1", counts: COUNTS, at: T0.toISOString() }),
      ),
    );
    await pubsub.publish(countsChannel("r1"), '{"x":1}');
    expect(out[2]).toBe('event: counts\ndata: {"x":1}\n\n');
    ft.tick();
    expect(out[3]).toBe(formatSseEvent("ping", JSON.stringify({ at: T0.toISOString() })));
    expect(COUNTS_HEARTBEAT_MS).toBeLessThan(10_000);

    await stream.close();
    expect(pubsub.listenerCount(countsChannel("r1"))).toBe(0);
    expect(ft.intervals.size).toBe(0);
    await pubsub.publish(countsChannel("r1"), "late");
    expect(out).toHaveLength(4);
  });

  it("cleans up if the initial read fails", async () => {
    const pubsub = new InMemoryPubSub();
    const ft = fakeTimers();
    await expect(
      openCountsStream({
        raffleId: "r1",
        pubsub,
        readCounts: () => Promise.reject(new Error("db")),
        write: () => undefined,
        timers: ft.timers,
      }),
    ).rejects.toThrow("db");
    expect(pubsub.listenerCount(countsChannel("r1"))).toBe(0);
    expect(ft.intervals.size).toBe(0);
  });
});
