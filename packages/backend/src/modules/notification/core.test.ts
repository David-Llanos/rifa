import { describe, expect, it } from "vitest";
import {
  channelsFor,
  deliveryPlan,
  isStopKeyword,
  parseTemplate,
  renderTemplate,
  resolveLocale,
  smsSegments,
  winnerMessage,
} from "./core.js";

const raffle = {
  title: { en: "Car", es: "Carro" },
  defaultLocale: "en" as const,
  shareUrl: "https://x.test/r/abc",
};
const winner = { ticket: 42, name: "Ana Perez", email: "ana@x.test", phone: "+573001234567" };

describe("resolveLocale", () => {
  it("prefers profile, then raffle default, then English", () => {
    expect(resolveLocale("es", "en")).toBe("es");
    expect(resolveLocale(undefined, "es")).toBe("es");
    expect(resolveLocale(undefined, undefined)).toBe("en");
  });
});

describe("channelsFor", () => {
  const contact = { email: "a@x.test", phone: "+15551234567" };
  it("optional types use only enabled channels with contact", () => {
    expect(channelsFor("sales_milestone", { sales_milestone: { sms: true } }, contact)).toEqual([
      "sms",
    ]);
    expect(channelsFor("sales_milestone", {}, contact)).toEqual([]);
    expect(
      channelsFor(
        "sales_milestone",
        { sales_milestone: { sms: true } },
        { ...contact, smsOptedOut: true },
      ),
    ).toEqual([]);
  });
  it("mandatory types ignore opt-outs but need a valid contact", () => {
    expect(channelsFor("refund", { refund: { email: false, sms: false } }, contact)).toEqual([
      "email",
    ]);
    expect(channelsFor("refund", {}, { phone: "+15551234567", smsOptedOut: true })).toEqual([
      "sms",
    ]);
    expect(channelsFor("refund", {}, {})).toEqual([]);
  });
});

describe("templates", () => {
  it("parses allowed placeholders and reports unknown ones", () => {
    const ok = parseTemplate("Hi {{player_name}}, {{ ticket_numbers }} {{player_name}}");
    expect("placeholders" in ok && [...ok.placeholders].sort()).toEqual([
      "player_name",
      "ticket_numbers",
    ]);
    expect(parseTemplate("{{foo}} {{deadline}} {{bar}} {{foo}}")).toEqual({
      unknown: ["foo", "bar"],
    });
  });
  it("renders in a single pass", () => {
    expect(
      renderTemplate("Hi {{player_name}}", { player_name: "{{deadline}}", deadline: "x" }),
    ).toBe("Hi {{deadline}}");
    expect(renderTemplate("{{raffle_title}}!", {})).toBe("!");
  });
});

describe("smsSegments", () => {
  it("counts GSM-7 segments", () => {
    expect(smsSegments("")).toBe(0);
    expect(smsSegments("a".repeat(160))).toBe(1);
    expect(smsSegments("a".repeat(161))).toBe(2);
    expect(smsSegments("a".repeat(459))).toBe(3);
    expect(smsSegments("a".repeat(460))).toBe(4);
    expect(smsSegments("€".repeat(80))).toBe(1);
    expect(smsSegments("€".repeat(81))).toBe(2);
  });
  it("counts UCS-2 segments", () => {
    expect(smsSegments("é".repeat(70) + "😀")).toBe(2);
    expect(smsSegments("😀".repeat(35))).toBe(1);
    expect(smsSegments("😀".repeat(36))).toBe(2);
    expect(smsSegments("ç".repeat(10) + "中".repeat(60))).toBe(1);
  });
});

describe("isStopKeyword", () => {
  it("matches STOP and PARAR ignoring case and whitespace", () => {
    expect(isStopKeyword("  stop\n")).toBe(true);
    expect(isStopKeyword("Parar")).toBe(true);
    expect(isStopKeyword("please stop")).toBe(false);
  });
});

describe("deliveryPlan", () => {
  it("retries 3 times, then alternate once, then undelivered", () => {
    expect(deliveryPlan({ primaryFailures: 3, alternateAttempts: 0 }, "sms")).toBe("retry");
    expect(deliveryPlan({ primaryFailures: 4, alternateAttempts: 0 }, "sms")).toBe("alternate");
    expect(deliveryPlan({ primaryFailures: 4, alternateAttempts: 1 }, "sms")).toBe("undelivered");
    expect(deliveryPlan({ primaryFailures: 4, alternateAttempts: 0 }, null)).toBe("undelivered");
  });
});

describe("winnerMessage", () => {
  it("owner gets name and contact", () => {
    const m = winnerMessage("owner", raffle, winner, "en");
    expect(m.body).toContain("42");
    expect(m.body).toContain("Ana Perez");
    expect(m.body).toContain("ana@x.test");
  });
  it("winner gets ticket and won statement", () => {
    expect(winnerMessage("winner", raffle, winner, "en").body).toMatch(/won.*42/);
    expect(winnerMessage("winner", raffle, winner, "es").body).toContain("Ganaste");
  });
  it("others get ticket and link, never identity", () => {
    const m = winnerMessage("other", raffle, winner, "es");
    expect(m.body).toContain("42");
    expect(m.body).toContain(raffle.shareUrl);
    expect(m.body).not.toContain("Ana");
    expect(m.body).not.toContain("ana@x.test");
    expect(m.body).not.toContain("+57300");
    expect(m.locale).toBe("es");
  });
});
