import { describe, expect, it } from "vitest";
import { manualClock, webCryptoRng, type CryptoRng } from "@raffle/shared";
import type { RuleSetRules } from "../compliance/types.js";
import type { Raffle, RaffleStatus } from "../raffle/types.js";
import {
  NOT_FOUND_RESPONSE,
  OG_DESCRIPTION_MAX,
  OG_TITLE_MAX,
  checkoutPath,
  createShareService,
  generateShareToken,
  ogMeta,
  parseCheckoutReturn,
  pngDimensions,
  qrDecode,
  qrEncode,
  shareUrl,
  signInRedirect,
  type ShareContext,
  type ShareRecord,
  type ShareRepository,
} from "./index.js";

const NOW = new Date("2025-01-01T00:00:00Z");

function raffle(status: RaffleStatus = "published", over: Partial<Raffle> = {}): Raffle {
  return {
    id: "r1",
    ownerId: "o1",
    status,
    createdAt: NOW,
    updatedAt: NOW,
    title: { en: "Car raffle", es: "Rifa de carro" },
    description: { en: "Win a car" },
    defaultLocale: "en",
    prizeImages: ["https://img.test/a.jpg"],
    prizeValueMinor: 100000n,
    country: "US",
    currency: "USD",
    totalTickets: 100,
    ticketPriceMinor: 500n,
    deadline: new Date("2025-01-02T00:00:00Z"),
    tzName: "America/New_York",
    numberSelection: true,
    earlyClosure: false,
    lotteryId: "co-bogota",
    drawAt: new Date("2025-01-03T00:00:00Z"),
    winningRule: { id: "last_digits" },
    fallbackRule: "lower",
    ...over,
  } as Raffle;
}

function memoryRepo(records: ShareRecord[], collisions = 0): ShareRepository {
  let left = collisions;
  return {
    findByToken: async (t) => records.find((r) => r.shareToken === t) ?? null,
    findById: async (id) => records.find((r) => r.raffle.id === id) ?? null,
    assignToken: async (id, token) => {
      const rec = records.find((r) => r.raffle.id === id);
      if (!rec) return "collision";
      if (rec.shareToken) return "already_set";
      if (left > 0) {
        left--;
        return "collision";
      }
      rec.shareToken = token;
      return "assigned";
    },
  };
}

const rules = { disclosures: ["odds"] } as unknown as RuleSetRules;
const ctx: ShareContext = {
  availableTickets: 42,
  ownerName: "Ana",
  rules,
  disclosureFacts: {
    ownerIdentity: "Ana",
    licenseNumber: "L1",
    prizeDescription: "Car",
    drawMethod: "Lottery",
  },
  winner: null,
};

function svc(records: ShareRecord[], collisions = 0, rng: CryptoRng = webCryptoRng()) {
  return createShareService({
    repo: memoryRepo(records, collisions),
    context: { load: async () => ctx },
    rng,
    baseUrl: "https://raffle.test/",
    clock: manualClock(NOW),
  });
}

describe("share token", () => {
  it("is 128 bits, base64url, unique and independent of the raffle", () => {
    const rng = webCryptoRng();
    const tokens = new Set(Array.from({ length: 500 }, () => generateShareToken(rng)));
    expect(tokens.size).toBe(500);
    for (const t of tokens) {
      expect(t).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(Buffer.from(t, "base64url")).toHaveLength(16);
    }
  });
});

describe("QR code", () => {
  const url = shareUrl("https://raffle.test", generateShareToken(webCryptoRng()));
  it("PNG is at least 1024x1024 and decodes to the URL", () => {
    const png = qrEncode(url, "png");
    const { width, height } = pngDimensions(png);
    expect(width).toBeGreaterThanOrEqual(1024);
    expect(height).toBeGreaterThanOrEqual(1024);
    expect(qrDecode(png)).toBe(url);
  });
  it("SVG decodes to the URL", () => {
    const svg = qrEncode(url, "svg");
    expect(svg.toString("utf8")).toContain("<svg");
    expect(qrDecode(svg)).toBe(url);
  });
});

describe("Open Graph metadata", () => {
  it("limits title to 70 and description to 200 characters", () => {
    const m = ogMeta(
      { title: { en: "T".repeat(300) }, description: { en: "D".repeat(900) } },
      "en",
    );
    expect(Array.from(m.title).length).toBeLessThanOrEqual(OG_TITLE_MAX);
    expect(Array.from(m.description).length).toBeLessThanOrEqual(OG_DESCRIPTION_MAX);
  });
  it("falls back to the default locale when the translation is missing", () => {
    expect(ogMeta({ title: { en: "Hi" }, description: { en: "d" } }, "es").title).toBe("Hi");
  });
});

describe("share service", () => {
  it("assigns a token once, retrying on collision, and is idempotent", async () => {
    const rec: ShareRecord = { raffle: raffle(), shareToken: null, branding: null };
    const s = svc([rec], 2);
    const a = await s.ensureShareToken("r1");
    const b = await s.ensureShareToken("r1");
    expect(a.ok && b.ok && a.token === b.token).toBe(true);
    expect(await svc([{ ...rec, shareToken: null }], 9).ensureShareToken("r1")).toEqual({
      ok: false,
      reason: "token_exhausted",
    });
  });

  it("does not issue tokens for unpublished raffles", async () => {
    const s = svc([{ raffle: raffle("draft"), shareToken: null, branding: null }]);
    expect(await s.ensureShareToken("r1")).toEqual({ ok: false, reason: "not_published" });
  });

  it("serves the full page without sign-in, with disclosures and countdown", async () => {
    const token = generateShareToken(webCryptoRng());
    const branding = {
      logoUrl: "https://l.test/x.png",
      primaryColor: "#112233",
      secondaryColor: "#445566",
    };
    const res = await svc([{ raffle: raffle(), shareToken: token, branding }]).getSharePage(
      token,
      "es",
    );
    expect(res.status).toBe(200);
    const page = res.body as import("./index.js").SharePage;
    expect(page.requiresSignIn).toBe(false);
    expect(page.tickets).toEqual({ total: 100, available: 42 });
    expect(page.deadline.msRemaining).toBe(86_400_000);
    expect(page.disclosures.map((d) => d.key)).toContain("odds");
    expect(page.branding).toEqual(branding);
    expect(page.title).toBe("Rifa de carro");
    expect(page.og.image).toMatchObject({ width: 1200, height: 630 });
    expect(page.refresh.countdownMs).toBeLessThanOrEqual(1000);
    expect(page.refresh.availabilityMs).toBeLessThanOrEqual(5000);
  });

  it("answers missing, malformed and unpublished raffles identically", async () => {
    const t1 = generateShareToken(webCryptoRng());
    const s = svc([{ raffle: raffle("pending_review"), shareToken: t1, branding: null }]);
    const missing = await s.getSharePage(generateShareToken(webCryptoRng()), "en");
    const unpublished = await s.getSharePage(t1, "en");
    const malformed = await s.getSharePage("nope", "en");
    expect(missing).toEqual(NOT_FOUND_RESPONSE);
    expect(unpublished).toEqual(missing);
    expect(malformed).toEqual(missing);
  });

  it("lets only the owner download a QR code", async () => {
    const token = generateShareToken(webCryptoRng());
    const s = svc([{ raffle: raffle(), shareToken: token, branding: null }]);
    const bad = await s.downloadQr("other", "r1", "png");
    expect(bad).toEqual({ ok: false, reason: "forbidden" });
    const good = await s.downloadQr("o1", "r1", "svg");
    expect(good.ok && qrDecode(good.body)).toBe(shareUrl("https://raffle.test", token));
  });
});

describe("checkout redirect", () => {
  it("round-trips the selected tickets and rejects foreign targets", () => {
    const token = generateShareToken(webCryptoRng());
    const redirect = signInRedirect(token, [3, 7, 12]);
    const returnTo = decodeURIComponent(redirect.split("returnTo=")[1] ?? "");
    expect(returnTo).toBe(checkoutPath(token, [3, 7, 12]));
    expect(parseCheckoutReturn(returnTo)).toEqual({ token, tickets: [3, 7, 12] });
    expect(parseCheckoutReturn("https://evil.test/r/x/checkout")).toBeNull();
    expect(parseCheckoutReturn("//evil.test")).toBeNull();
  });
});
