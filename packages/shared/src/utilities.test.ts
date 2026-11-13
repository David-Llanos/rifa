import { describe, expect, it } from "vitest";
import {
  add,
  divRoundHalfUp,
  formatCountdown,
  formatInZone,
  money,
  mulDecimal,
  parseCountdown,
  parseMoney,
  percentOf,
  roundDecimal2,
  subtract,
  toDecimalString,
  utcToZoned,
  zonedToUtc,
  deadlineForViewer,
} from "./index.js";

describe("money math", () => {
  it("adds and subtracts exactly, rejects currency mismatch", () => {
    expect(add(money(10n, "USD"), money(5n, "USD")).amountMinor).toBe(15n);
    expect(subtract(money(10n, "USD"), money(15n, "USD")).amountMinor).toBe(-5n);
    expect(() => add(money(1n, "USD"), money(1n, "COP"))).toThrow(RangeError);
  });
  it("rounds half away from zero", () => {
    expect(divRoundHalfUp(5n, 2n)).toBe(3n);
    expect(divRoundHalfUp(-5n, 2n)).toBe(-3n);
    expect(divRoundHalfUp(4n, 3n)).toBe(1n);
  });
  it("computes rates and percents without floating point", () => {
    expect(percentOf(money(1999n, "USD"), "2.9").amountMinor).toBe(58n); // 57.971
    expect(mulDecimal(money(10000n, "USD"), "0.0295").amountMinor).toBe(295n);
  });
  it("parses and prints decimals", () => {
    expect(parseMoney("10.005", "USD").amountMinor).toBe(1001n);
    expect(parseMoney("12", "USD").amountMinor).toBe(1200n);
    expect(toDecimalString(money(1050n, "USD"))).toBe("10.50");
    expect(toDecimalString(money(-5n, "USD"))).toBe("-0.05");
    expect(roundDecimal2("0.125")).toBe("0.13");
  });
});

describe("countdown", () => {
  it("formats reservation and deadline styles", () => {
    expect(formatCountdown(600_000)).toBe("10:00");
    expect(formatCountdown(93_784_000, "deadline")).toBe("1d 2h 3m 4s");
  });
  it("parses both formats", () => {
    expect(parseCountdown("10:00")).toBe(600_000);
    expect(parseCountdown("1d 2h 3m 4s")).toBe(93_784_000);
    expect(() => parseCountdown("abc")).toThrow(SyntaxError);
  });
});

describe("time zones", () => {
  it("converts Bogota local to UTC and back", () => {
    const local = { year: 2025, month: 3, day: 1, hour: 14, minute: 30, second: 0 };
    const utc = zonedToUtc(local, "America/Bogota");
    expect(utc.toISOString()).toBe("2025-03-01T19:30:00.000Z");
    expect(utcToZoned(utc, "America/Bogota")).toEqual(local);
  });
  it("handles DST in New York", () => {
    const summer = zonedToUtc({ year: 2025, month: 7, day: 1, hour: 12, minute: 0, second: 0 }, "America/New_York");
    expect(summer.toISOString()).toBe("2025-07-01T16:00:00.000Z");
  });
  it("display includes zone name and offset", () => {
    const { display } = deadlineForViewer(
      { year: 2025, month: 3, day: 1, hour: 14, minute: 30, second: 0 },
      "America/Bogota",
      "America/New_York",
    );
    expect(display).toContain("America/New_York");
    expect(display).toContain("UTC-05:00");
    expect(formatInZone(new Date(0), "UTC")).toContain("UTC+00:00");
  });
});
