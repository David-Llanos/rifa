import { describe, expect, it } from "vitest";
import { manualClock } from "@raffle/shared";
import {
  createRaffleDraftService,
  validateDrawTime,
  validateEdit,
  validateRaffle,
  type Raffle,
  type RaffleAuditEvent,
  type RaffleInput,
  type RaffleRepository,
} from "./index.js";

const NOW = new Date("2025-01-01T00:00:00Z");
const H = 3600_000;

function valid(over: Partial<RaffleInput> = {}): RaffleInput {
  return {
    title: { en: "Car", es: "Carro" },
    description: { en: "A car" },
    defaultLocale: "en",
    prizeImages: ["a.png"],
    prizeValueMinor: 1000n,
    country: "US",
    currency: "USD",
    totalTickets: 100,
    ticketPriceMinor: 500n,
    deadline: new Date(NOW.getTime() + 24 * H),
    tzName: "America/New_York",
    numberSelection: false,
    earlyClosure: false,
    lotteryId: "lot-1",
    drawAt: new Date(NOW.getTime() + 48 * H),
    winningRule: { id: "LAST_N_DIGITS_OF_FIRST_PRIZE" },
    fallbackRule: "redraw",
    ...over,
  };
}
const fields = (i: RaffleInput) => validateRaffle(i, NOW).map((e) => e.field);

describe("validateRaffle", () => {
  it("accepts a valid raffle, including the 24h boundary and ticket bounds", () => {
    expect(validateRaffle(valid(), NOW)).toEqual([]);
    expect(validateRaffle(valid({ totalTickets: 10 }), NOW)).toEqual([]);
    expect(validateRaffle(valid({ totalTickets: 100000 }), NOW)).toEqual([]);
  });

  it("rejects ticket counts outside 10..100000 or non-integer with the range", () => {
    for (const n of [9, 100001, 10.5, Number.NaN]) {
      const e = validateRaffle(valid({ totalTickets: n }), NOW).find((x) => x.field === "totalTickets");
      expect(e?.params).toEqual({ min: 10, max: 100000 });
    }
  });

  it("enforces currency per country and positive price", () => {
    expect(fields(valid({ currency: "COP" }))).toContain("currency");
    expect(fields(valid({ country: "CO", currency: "COP" }))).toEqual([]);
    expect(fields(valid({ ticketPriceMinor: 0n }))).toContain("ticketPriceMinor");
  });

  it("rejects deadline earlier than submission + 24h", () => {
    const e = validateRaffle(valid({ deadline: new Date(NOW.getTime() + 24 * H - 1) }), NOW);
    expect(e.find((x) => x.field === "deadline")?.params?.min).toBe("2025-01-02T00:00:00.000Z");
  });

  it("bounds threshold and per-player limit by total tickets", () => {
    expect(fields(valid({ minThreshold: 100, maxPerPlayer: 100 }))).toEqual([]);
    expect(fields(valid({ minThreshold: 0 }))).toContain("minThreshold");
    expect(fields(valid({ minThreshold: 101 }))).toContain("minThreshold");
    expect(fields(valid({ maxPerPlayer: 101 }))).toContain("maxPerPlayer");
  });

  it("validates bilingual title and description lengths", () => {
    expect(fields(valid({ title: {} }))).toContain("title");
    expect(fields(valid({ title: { es: "x".repeat(101) } }))).toContain("title.es");
    expect(fields(valid({ title: { es: "x".repeat(100) } }))).toEqual([]);
    expect(fields(valid({ description: { en: "x".repeat(5001) } }))).toContain("description.en");
  });

  it("validates image count and prize value", () => {
    expect(fields(valid({ prizeImages: [] }))).toContain("prizeImages");
    expect(fields(valid({ prizeImages: Array(11).fill("a") }))).toContain("prizeImages");
    expect(fields(valid({ prizeValueMinor: 0n }))).toContain("prizeValueMinor");
  });

  it("reports each invalid field and requires draw after deadline", () => {
    const d = valid().deadline;
    expect(validateDrawTime(d, d)?.constraint).toBe("after_deadline");
    expect(validateDrawTime(d, new Date(d.getTime() + 1))).toBeNull();
    expect(fields(valid({ drawAt: d, totalTickets: 1 }))).toEqual(expect.arrayContaining(["drawAt", "totalTickets"]));
  });
});

describe("validateEdit", () => {
  const existing: Raffle = { ...valid(), id: "r1", ownerId: "o1", status: "draft", createdAt: NOW, updatedAt: NOW };

  it("allows anything when nothing is sold", () => {
    expect(validateEdit(existing, { ticketPriceMinor: 1n }, 0)).toEqual([]);
  });

  it("locks price, count, deadline, lottery and rule after first sale; unchanged values pass", () => {
    const errs = validateEdit(
      existing,
      {
        ticketPriceMinor: 1n,
        totalTickets: 50,
        deadline: new Date(existing.deadline.getTime() + 1),
        lotteryId: "x",
        winningRule: { id: "Y" },
        title: { en: "New" },
      },
      1,
    );
    expect(errs.map((e) => e.field).sort()).toEqual(
      ["deadline", "lotteryId", "ticketPriceMinor", "totalTickets", "winningRule"].sort(),
    );
    expect(validateEdit(existing, { ticketPriceMinor: 500n, deadline: new Date(existing.deadline) }, 3)).toEqual([]);
  });
});

describe("draft service", () => {
  function setup(auditFails = false) {
    const store = new Map<string, Raffle>();
    const events: RaffleAuditEvent[] = [];
    let sold = 0;
    const repo: RaffleRepository<Map<string, Raffle>> = {
      async transaction(fn) {
        const tx = new Map(store);
        const before = events.length;
        try {
          const r = await fn(tx);
          store.clear();
          tx.forEach((v, k) => store.set(k, v));
          return r;
        } catch (e) {
          events.length = before;
          throw e;
        }
      },
      async insert(tx, r) {
        tx.set(r.id, r);
      },
      async findForUpdate(tx, id) {
        return tx.get(id) ?? null;
      },
      async update(tx, r) {
        tx.set(r.id, r);
      },
      async soldCount() {
        return sold;
      },
    };
    const svc = createRaffleDraftService({
      repo,
      audit: {
        async append(_tx, e) {
          if (auditFails) throw new Error("audit down");
          events.push(e);
        },
      },
      newId: () => "r1",
      clock: manualClock(NOW),
    });
    return { svc, store, events, setSold: (n: number) => (sold = n) };
  }

  it("saves a valid draft with an audit event", async () => {
    const { svc, store, events } = setup();
    const r = await svc.saveDraft("o1", valid());
    expect(r.ok && r.value.status).toBe("draft");
    expect(store.size).toBe(1);
    expect(events[0]?.action).toBe("raffle.draft_created");
  });

  it("saves nothing and audits nothing on invalid input", async () => {
    const { svc, store, events } = setup();
    const r = await svc.saveDraft("o1", valid({ totalTickets: 5 }));
    expect(r.ok).toBe(false);
    expect(store.size).toBe(0);
    expect(events).toHaveLength(0);
  });

  it("fails closed when the audit append fails", async () => {
    const { svc, store } = setup(true);
    await expect(svc.saveDraft("o1", valid())).rejects.toThrow("audit down");
    expect(store.size).toBe(0);
  });

  it("updates drafts, enforces ownership and locks after sale", async () => {
    const { svc, setSold, events } = setup();
    await svc.saveDraft("o1", valid());
    const up = await svc.updateDraft("o1", "r1", { totalTickets: 200 });
    expect(up.ok && up.value.totalTickets).toBe(200);
    expect(events.at(-1)?.changes.map((c) => c.field)).toEqual(["totalTickets"]);
    const other = await svc.updateDraft("o2", "r1", { totalTickets: 300 });
    expect(!other.ok && other.error[0]?.constraint).toBe("forbidden");
    setSold(1);
    const locked = await svc.updateDraft("o1", "r1", { totalTickets: 300 });
    expect(!locked.ok && locked.error[0]?.constraint).toBe("locked_after_sale");
  });
});
