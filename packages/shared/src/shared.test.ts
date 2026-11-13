import { describe, expect, it } from "vitest";
import {
  COUNTRY_CURRENCY,
  currencyForCountry,
  err,
  fieldError,
  isCountry,
  isCurrency,
  isErr,
  isLocale,
  isOk,
  isPositive,
  manualClock,
  money,
  ok,
  seededRng,
  webCryptoRng,
  zero,
} from "./index.js";

describe("Result", () => {
  it("narrows ok and err values", () => {
    const a = ok(42);
    const b = err("bad");
    expect(isOk(a) && a.value).toBe(42);
    expect(isErr(b) && b.error).toBe("bad");
  });

  it("builds field errors with optional params", () => {
    expect(fieldError("title", "required")).toEqual({ field: "title", constraint: "required" });
    expect(fieldError("totalTickets", "range", { min: 10, max: 100000 })).toEqual({
      field: "totalTickets",
      constraint: "range",
      params: { min: 10, max: 100000 },
    });
  });
});

describe("Locale and Country", () => {
  it("accepts only supported values", () => {
    expect(isLocale("en")).toBe(true);
    expect(isLocale("es")).toBe(true);
    expect(isLocale("fr")).toBe(false);
    expect(isCountry("CO")).toBe(true);
    expect(isCountry("US")).toBe(true);
    expect(isCountry("MX")).toBe(false);
  });
});

describe("Money", () => {
  it("maps Colombia to COP and the United States to USD (Req 2.5)", () => {
    expect(currencyForCountry("CO")).toBe("COP");
    expect(currencyForCountry("US")).toBe("USD");
    expect(Object.keys(COUNTRY_CURRENCY).sort()).toEqual(["CO", "US"]);
  });

  it("stores amounts as bigint minor units", () => {
    const m = money(1999n, "USD");
    expect(m.amountMinor).toBe(1999n);
    expect(typeof m.amountMinor).toBe("bigint");
    expect(isPositive(m)).toBe(true);
    expect(isPositive(zero("COP"))).toBe(false);
  });

  it("rejects non-bigint amounts and unsupported currencies", () => {
    expect(() => money(10 as unknown as bigint, "USD")).toThrow(TypeError);
    expect(() => money(10n, "EUR" as never)).toThrow(TypeError);
    expect(isCurrency("EUR")).toBe(false);
  });
});

describe("Clock", () => {
  it("manual clock sets and advances time", () => {
    const c = manualClock(new Date("2025-01-01T00:00:00Z"));
    c.advance(60_000);
    expect(c.now().toISOString()).toBe("2025-01-01T00:01:00.000Z");
    c.set(new Date("2025-06-01T12:00:00Z"));
    expect(c.now().toISOString()).toBe("2025-06-01T12:00:00.000Z");
  });
});

describe("Rng", () => {
  it("seeded RNG is deterministic and within bounds", () => {
    const a = seededRng(7);
    const b = seededRng(7);
    const xs = Array.from({ length: 200 }, () => a.nextInt(10));
    const ys = Array.from({ length: 200 }, () => b.nextInt(10));
    expect(xs).toEqual(ys);
    expect(xs.every((x) => Number.isInteger(x) && x >= 0 && x < 10)).toBe(true);
  });

  it("rejects invalid bounds", () => {
    expect(() => seededRng(1).nextInt(0)).toThrow(RangeError);
    expect(() => webCryptoRng().nextInt(1.5)).toThrow(RangeError);
  });

  it("web crypto RNG returns bytes and bounded integers", () => {
    const r = webCryptoRng();
    expect(r.bytes(16)).toHaveLength(16);
    for (let i = 0; i < 100; i++) {
      const v = r.nextInt(3);
      expect(v >= 0 && v < 3).toBe(true);
    }
  });
});
