import { describe, expect, it } from "vitest";
import { deriveWinningNumber, resolveWinner, type LotteryResult } from "./core.js";

const res = (firstPrize: string, secondPrize?: string): LotteryResult => ({
  lotteryId: "l",
  drawAt: new Date(0),
  firstPrize,
  ...(secondPrize ? { secondPrize } : {}),
});

describe("deriveWinningNumber", () => {
  it("takes last N digits", () => {
    expect(deriveWinningNumber(res("98765"), "LAST_N_DIGITS_OF_FIRST_PRIZE", 3)).toBe(765);
    expect(deriveWinningNumber(res("98005"), "LAST_N_DIGITS_OF_FIRST_PRIZE", 3)).toBe(5);
  });
  it("pads short results and takes first N / second prize", () => {
    expect(deriveWinningNumber(res("42"), "LAST_N_DIGITS_OF_FIRST_PRIZE", 4)).toBe(42);
    expect(deriveWinningNumber(res("98765"), "FIRST_N_DIGITS_OF_FIRST_PRIZE", 2)).toBe(98);
    expect(deriveWinningNumber(res("1", "5551"), "LAST_N_DIGITS_OF_SECOND_PRIZE", 2)).toBe(51);
  });
  it("is deterministic and rejects bad input", () => {
    const r = res("1234567");
    expect(deriveWinningNumber(r, "LAST_N_DIGITS_OF_FIRST_PRIZE", 4)).toBe(
      deriveWinningNumber(r, "LAST_N_DIGITS_OF_FIRST_PRIZE", 4),
    );
    expect(() => deriveWinningNumber(r, "LAST_N_DIGITS_OF_FIRST_PRIZE", 0)).toThrow();
    expect(() => deriveWinningNumber(res("1"), "LAST_N_DIGITS_OF_SECOND_PRIZE", 2)).toThrow();
  });
});

describe("resolveWinner", () => {
  const sold = new Set([10, 20, 30]);
  it("exact match wins regardless of fallback", () => {
    expect(resolveWinner(20, sold, "redraw")).toEqual({ kind: "winner", ticket: 20 });
  });
  it("lower and higher fallbacks pick nearest sold", () => {
    expect(resolveWinner(25, sold, "lower")).toEqual({ kind: "winner", ticket: 20 });
    expect(resolveWinner(25, sold, "higher")).toEqual({ kind: "winner", ticket: 30 });
  });
  it("returns none when no sold ticket in direction or none sold", () => {
    expect(resolveWinner(5, sold, "lower")).toEqual({ kind: "none" });
    expect(resolveWinner(35, sold, "higher")).toEqual({ kind: "none" });
    expect(resolveWinner(5, new Set(), "higher")).toEqual({ kind: "none" });
  });
  it("redraw on unsold", () => {
    expect(resolveWinner(25, sold, "redraw")).toEqual({ kind: "redraw" });
  });
});
