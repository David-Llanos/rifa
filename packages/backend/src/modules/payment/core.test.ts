import { describe, expect, it } from "vitest";
import { money } from "@raffle/shared";
import {
  InMemoryIdemStore,
  canRefund,
  createPaymentRecord,
  methodsFor,
  orderTotal,
  resolveIdempotent,
  runIdempotent,
  selectProvider,
  validateIdempotencyKey,
} from "./core.js";
import { FakePaymentAdapter } from "./fake-adapter.js";

const usd = (n: bigint) => money(n, "USD");

describe("methodsFor", () => {
  it("lists Colombia and US methods", () => {
    expect(methodsFor("CO")).toEqual(["pse", "nequi", "card", "cash_network"]);
    expect(methodsFor("US")).toEqual(["card", "apple_pay", "google_pay", "ach"]);
  });
});

describe("orderTotal", () => {
  it("is price x qty plus fees", () => {
    expect(orderTotal(usd(250n), 4, [usd(30n), usd(20n)])).toEqual(usd(1050n));
    expect(orderTotal(usd(250n), 0, [])).toEqual(usd(0n));
  });
  it("rejects bad qty, negative fees and currency mismatch", () => {
    expect(() => orderTotal(usd(1n), 1.5, [])).toThrow(RangeError);
    expect(() => orderTotal(usd(1n), -1, [])).toThrow(RangeError);
    expect(() => orderTotal(usd(1n), 1, [usd(-1n)])).toThrow(RangeError);
    expect(() => orderTotal(usd(1n), 1, [money(1n, "COP")])).toThrow(RangeError);
  });
});

describe("selectProvider", () => {
  it("returns no_provider_available when none matches", () => {
    const r = selectProvider([new FakePaymentAdapter("US")], "CO");
    expect(r).toEqual({ ok: false, error: { code: "no_provider_available", country: "CO" } });
  });
  it("finds a provider by country and method", () => {
    const co = new FakePaymentAdapter("CO");
    const found = selectProvider([new FakePaymentAdapter("US"), co], "CO", "pse");
    expect(found).toEqual({ ok: true, value: co });
    expect(selectProvider([co], "CO", "ach").ok).toBe(false);
  });
});

describe("payment record", () => {
  const base = {
    id: "p1",
    raffleId: "r1",
    amount: usd(1000n),
    provider: "fake",
    providerRef: "ref",
    method: "card" as const,
    idempotencyKey: "k",
    createdAt: new Date(0),
  };
  it("defaults to pending with zero refunds", () => {
    const p = createPaymentRecord(base);
    expect(p.status).toBe("pending");
    expect(p.refundedTotal).toEqual(usd(0n));
  });
  it("caps cumulative refunds at the amount paid", () => {
    const p = {
      ...createPaymentRecord(base),
      status: "succeeded" as const,
      refundedTotal: usd(400n),
    };
    expect(canRefund(p, usd(600n))).toBe(true);
    expect(canRefund(p, usd(601n))).toBe(false);
    expect(canRefund(p, usd(0n))).toBe(false);
    expect(canRefund({ ...p, status: "pending" }, usd(1n))).toBe(false);
  });
});

describe("idempotency", () => {
  const t0 = new Date("2025-01-01T00:00:00Z");
  const hours = (h: number) => new Date(t0.getTime() + h * 3_600_000);

  it("requires a key", () => {
    expect(validateIdempotencyKey("")).toEqual({
      ok: false,
      error: { code: "idempotency_key_required" },
    });
    expect(validateIdempotencyKey(undefined).ok).toBe(false);
    expect(validateIdempotencyKey("  ").ok).toBe(false);
    expect(validateIdempotencyKey("abc").ok).toBe(true);
  });

  it("replays within 24 hours and expires after", async () => {
    const store = new InMemoryIdemStore<string>();
    let charges = 0;
    const charge = () => Promise.resolve(`charge-${++charges}`);
    const first = await runIdempotent(store, "k", t0, charge);
    const again = await runIdempotent(store, "k", hours(24), charge);
    expect(first).toEqual({ ok: true, value: { replayed: false, result: "charge-1" } });
    expect(again).toEqual({ ok: true, value: { replayed: true, result: "charge-1" } });
    expect(charges).toBe(1);
    expect(resolveIdempotent(store, "k", new Date(hours(24).getTime() + 1))).toBeNull();
    const later = await runIdempotent(store, "k", hours(25), charge);
    expect(later).toEqual({ ok: true, value: { replayed: false, result: "charge-2" } });
  });

  it("does not charge without a key", async () => {
    let charges = 0;
    const store = new InMemoryIdemStore<number>();
    const r = await runIdempotent(store, undefined, t0, () => Promise.resolve(++charges));
    expect(r.ok).toBe(false);
    expect(charges).toBe(0);
  });
});

describe("FakePaymentAdapter", () => {
  it("uses hosted fields for cards, redirects otherwise, and declines on demand", async () => {
    const a = new FakePaymentAdapter("CO");
    const base = { amount: money(1000n, "COP"), country: "CO" as const, reference: "o1" };
    const card = await a.createCharge({ ...base, method: "card", idempotencyKey: "a" });
    const pse = await a.createCharge({ ...base, method: "pse", idempotencyKey: "b" });
    expect(card.kind).toBe("hosted_fields");
    expect(pse.kind).toBe("redirect");
    a.failNextCharge();
    const d = await a.createCharge({ ...base, method: "card", idempotencyKey: "c" });
    expect(d.kind).toBe("declined");
    expect(await a.createCharge({ ...base, method: "card", idempotencyKey: "a" })).toBe(card);
    expect(a.charges).toHaveLength(3);
  });
});
