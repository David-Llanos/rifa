import { describe, expect, it, vi } from "vitest";
import { money } from "@raffle/shared";
import {
  LocalePreferenceController,
  MESSAGES,
  createTranslator,
  detectLocale,
  formatMoney,
  keyParityDiff,
  parseAcceptLanguage,
  pickContent,
} from "./index";

describe("resource files", () => {
  it("English and Spanish have identical key sets (CI parity check)", () => {
    expect(keyParityDiff()).toEqual({ missingInEs: [], missingInEn: [] });
  });
  it("no resource value is empty", () => {
    for (const locale of ["en", "es"] as const) {
      for (const [k, v] of Object.entries(MESSAGES[locale])) expect(v.trim(), k).not.toBe("");
    }
  });
});

describe("detectLocale", () => {
  it.each([
    [["es-CO"], "es"],
    [["es"], "es"],
    [["en-US"], "en"],
    [["fr-FR", "es"], "en"],
    [["est"], "en"],
    [[], "en"],
  ])("%j -> %s", (tags, expected) => {
    expect(detectLocale(tags)).toBe(expected);
  });
  it("parses Accept-Language by quality", () => {
    expect(parseAcceptLanguage("en;q=0.5, es-CO, fr;q=0.1")).toEqual(["es-CO", "en", "fr"]);
    expect(detectLocale(parseAcceptLanguage("en;q=0.5, es-CO"))).toBe("es");
  });
});

describe("createTranslator", () => {
  it("falls back to English and logs a missing key once per key and locale", () => {
    const logMissing = vi.fn();
    const messages = { en: { a: "Hello {name}" }, es: {} };
    const t = createTranslator("es", { messages, logMissing });
    expect(t("a", { name: "Ana" })).toBe("Hello Ana");
    t("a");
    t("zzz");
    expect(logMissing).toHaveBeenCalledTimes(2);
    expect(logMissing).toHaveBeenCalledWith({ key: "a", locale: "es" });
  });
  it("interpolates Spanish strings", () => {
    const t = createTranslator("es");
    expect(t("validation.required", { field: "Email" })).toBe("Email es obligatorio.");
  });
});

describe("pickContent", () => {
  it("prefers visitor locale, else the other language", () => {
    expect(pickContent({ en: "Car", es: "Carro" }, "es")).toBe("Carro");
    expect(pickContent({ en: "Car" }, "es")).toBe("Car");
    expect(pickContent({ es: "Carro", en: " " }, "en")).toBe("Carro");
    expect(pickContent({}, "en")).toBeUndefined();
  });
});

describe("formatMoney", () => {
  it("keeps the raffle currency in both locales", () => {
    const usd = money(123450n, "USD");
    expect(formatMoney(usd, "en")).toContain("USD");
    expect(formatMoney(usd, "es")).toContain("USD");
    expect(formatMoney(money(1500000n, "COP"), "es")).toContain("COP");
  });
  it("uses locale separators exactly", () => {
    expect(formatMoney(money(123450n, "USD"), "en").replace(/\s/g, " ")).toBe("USD 1,234.50");
    expect(formatMoney(money(123450n, "USD"), "es").replace(/\s/g, " ")).toBe("USD 1.234,50");
    expect(formatMoney(money(-5n, "USD"), "en").replace(/\s/g, " ")).toMatch(/-USD 0\.05|USD -0\.05/);
  });
  it("is exact beyond double precision", () => {
    const big = money(900719925474099312n, "USD");
    expect(formatMoney(big, "en")).toContain("9,007,199,254,740,993.12");
  });
});

describe("LocalePreferenceController", () => {
  it("applies the locale immediately and keeps it when saving fails, then retries", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue(undefined);
    const c = new LocalePreferenceController("en", save);
    const p = c.select("es");
    expect(c.getState().locale).toBe("es");
    expect(await p).toBe(false);
    expect(c.getState()).toEqual({ locale: "es", saveStatus: "failed" });
    expect(await c.retry()).toBe(true);
    expect(c.getState()).toEqual({ locale: "es", saveStatus: "saved" });
  });
});
