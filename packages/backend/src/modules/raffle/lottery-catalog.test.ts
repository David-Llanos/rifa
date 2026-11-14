import { describe, expect, it } from "vitest";
import { COUNTRIES } from "@raffle/shared";
import { WINNING_RULES } from "../draw/core.js";
import {
  LOTTERY_CATALOG,
  availableWinningRules,
  getLottery,
  listLotteries,
  shareLotteryInfo,
  ticketNumberDigits,
  validateLotterySelection,
  type LotterySelection,
} from "./lottery-catalog.js";

const sel = (over: Partial<LotterySelection> = {}): LotterySelection => ({
  country: "CO",
  lotteryId: "co-bogota",
  totalTickets: 100,
  winningRule: { id: "LAST_N_DIGITS_OF_FIRST_PRIZE" },
  fallbackRule: "lower",
  ...over,
});
const fields = (s: LotterySelection) => validateLotterySelection(s).map((e) => e.field);

describe("catalog", () => {
  it("has entries per country with schedule and result format, flagged for verification", () => {
    for (const c of COUNTRIES) expect(listLotteries(c).length).toBeGreaterThan(0);
    for (const l of LOTTERY_CATALOG) {
      expect(l.drawSchedule.days.length).toBeGreaterThan(0);
      expect(l.resultFormat.firstPrizeDigits).toBeGreaterThan(0);
      expect(l.needsVerification).toBe(true);
      expect(l.sourceKey).not.toMatch(/^https?:/);
    }
    expect(new Set(LOTTERY_CATALOG.map((l) => l.id)).size).toBe(LOTTERY_CATALOG.length);
  });

  it("computes ticket number digits", () => {
    expect(ticketNumberDigits(10)).toBe(1);
    expect(ticketNumberDigits(11)).toBe(2);
    expect(ticketNumberDigits(100)).toBe(2);
    expect(ticketNumberDigits(101)).toBe(3);
    expect(ticketNumberDigits(100_000)).toBe(5);
  });

  it("offers only rules the result format supports, within the closed set", () => {
    const co = getLottery("co-bogota")!;
    expect(availableWinningRules(co, 100).map((r) => r.id)).toEqual([...WINNING_RULES]);
    expect(availableWinningRules(co, 100)[0]?.digits).toBe(2);
    const us = getLottery("us-ny-numbers-evening")!;
    expect(availableWinningRules(us, 100).map((r) => r.id)).not.toContain(
      "LAST_N_DIGITS_OF_SECOND_PRIZE",
    );
    expect(availableWinningRules(us, 100_000)).toEqual([]);
  });
});

describe("validateLotterySelection", () => {
  it("accepts a valid selection", () => {
    expect(validateLotterySelection(sel())).toEqual([]);
    expect(
      validateLotterySelection(
        sel({ winningRule: { id: "LAST_N_DIGITS_OF_FIRST_PRIZE", params: { digits: 2 } } }),
      ),
    ).toEqual([]);
  });

  it("rejects unknown or wrong-country lottery and unknown rule", () => {
    expect(fields(sel({ lotteryId: "lot-1" }))).toEqual(["lotteryId"]);
    expect(fields(sel({ lotteryId: "us-ny-win4-evening" }))).toEqual(["lotteryId"]);
    expect(fields(sel({ lotteryId: "" }))).toEqual(["lotteryId"]);
    expect(fields(sel({ winningRule: { id: "X" } }))).toEqual(["winningRule"]);
    expect(fields(sel({ winningRule: { id: "" } }))).toEqual(["winningRule"]);
  });

  it("rejects rules the lottery cannot satisfy and mismatched digits", () => {
    expect(fields(sel({ totalTickets: 100_000 }))).toEqual(["winningRule"]);
    expect(
      fields(
        sel({
          country: "US",
          lotteryId: "us-ny-numbers-evening",
          winningRule: { id: "LAST_N_DIGITS_OF_SECOND_PRIZE" },
        }),
      ),
    ).toEqual(["winningRule"]);
    expect(
      fields(sel({ winningRule: { id: "LAST_N_DIGITS_OF_FIRST_PRIZE", params: { digits: 3 } } })),
    ).toEqual(["winningRule"]);
  });

  it("rejects an invalid fallback", () => {
    expect(fields(sel({ fallbackRule: "nearest" }))).toEqual(["fallbackRule"]);
  });
});

describe("shareLotteryInfo", () => {
  it("exposes rule, fallback and draw time", () => {
    const drawAt = new Date("2025-02-01T03:30:00Z");
    expect(
      shareLotteryInfo({
        lotteryId: "co-bogota",
        totalTickets: 1000,
        winningRule: { id: "LAST_N_DIGITS_OF_FIRST_PRIZE" },
        fallbackRule: "higher",
        drawAt,
      }),
    ).toEqual({
      lotteryId: "co-bogota",
      lotteryName: "Lotería de Bogotá",
      winningRule: "LAST_N_DIGITS_OF_FIRST_PRIZE",
      winningRuleDigits: 3,
      fallbackRule: "higher",
      drawAt: drawAt.toISOString(),
    });
  });
});
