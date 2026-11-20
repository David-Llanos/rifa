import { describe, expect, it } from "vitest";
import { money } from "@raffle/shared";
import type { Country, Money } from "@raffle/shared";
import { validateConfigValue } from "../backoffice/service.js";
import { methodsFor } from "./core.js";
import { MemoryFeeRepository } from "./fee-memory-repository.js";
import { createFeeService } from "./fee-service.js";
import type { FeeRaffle, Timers } from "./fee-service.js";
import { isCustomizationFeesConfig, parseFeeSchedule, quoteFees } from "./fees.js";
import type {
  ChargeRequest,
  ChargeResult,
  PaymentMethod,
  PaymentProviderAdapter,
} from "./types.js";

const NOW = new Date("2030-01-01T00:00:00Z");

const CREATION = { COP: 2_000_000, USD: 999 };
const CUSTOM = {
  branding: { COP: 500_000, USD: 299 },
  share_theme: { COP: 300_000, USD: 199 },
  extra_prize_images: { COP: 200_000, USD: 99 },
  notification_templates: { COP: 300_000, USD: 199 },
};

type Behavior = "succeed" | "pending" | "decline" | "throw" | "hang";

/** Adapter whose next charges follow a scripted behavior. */
class ScriptedAdapter implements PaymentProviderAdapter {
  readonly name: string;
  readonly methods: readonly PaymentMethod[];
  readonly charges: ChargeRequest[] = [];
  behavior: Behavior = "succeed";
  constructor(readonly country: Country) {
    this.name = `scripted-${country}`;
    this.methods = methodsFor(country);
  }
  createCharge(req: ChargeRequest): Promise<ChargeResult> {
    this.charges.push(req);
    const providerRef = `ref_${this.charges.length}`;
    switch (this.behavior) {
      case "succeed":
        return Promise.resolve({ kind: "hosted_fields", providerRef, status: "succeeded", clientToken: "t" });
      case "pending":
        return Promise.resolve({ kind: "redirect", providerRef, status: "pending", redirectUrl: "https://p.invalid/x" });
      case "decline":
        return Promise.resolve({ kind: "declined", providerRef, reason: "insufficient_funds" });
      case "throw":
        return Promise.reject(new Error("network"));
      case "hang":
        return new Promise(() => undefined);
    }
  }
  refund(): never {
    throw new Error("not used");
  }
  payout(): never {
    throw new Error("not used");
  }
  verifyWebhook(): never {
    throw new Error("not used");
  }
}

/** Timers that fire immediately when `fire()` is called. */
function manualTimers() {
  const pending = new Map<number, () => void>();
  let id = 0;
  const timers: Timers = {
    setTimeout: (fn) => {
      pending.set(++id, fn);
      return id;
    },
    clearTimeout: (h) => pending.delete(h as number),
  };
  return { timers, fire: () => [...pending.values()].forEach((f) => f()) };
}

const raffle = (over: Partial<FeeRaffle> = {}): FeeRaffle => ({
  id: "r1",
  ownerId: "owner-1",
  status: "draft",
  country: "US",
  currency: "USD",
  creationFeePaid: false,
  customizations: [],
  ...over,
});

function setup(over: Partial<FeeRaffle> = {}, opts: { country?: Country; noAdapter?: boolean } = {}) {
  const repo = new MemoryFeeRepository();
  repo.addRaffle(raffle(over));
  const adapter = new ScriptedAdapter(opts.country ?? "US");
  const config = { creation: CREATION as unknown, customization: CUSTOM as unknown };
  const receipts: unknown[] = [];
  let failReceipt = false;
  let id = 0;
  const mt = manualTimers();
  const svc = createFeeService({
    repo,
    fees: { read: () => Promise.resolve({ ...config }) },
    adapters: opts.noAdapter ? [] : [adapter],
    receipts: {
      sendReceipt: (r) => {
        if (failReceipt) return Promise.reject(new Error("smtp"));
        receipts.push(r);
        return Promise.resolve();
      },
    },
    newId: () => `id${++id}`,
    clock: { now: () => NOW },
    timers: mt.timers,
  });
  return {
    repo,
    adapter,
    config,
    receipts,
    svc,
    fire: mt.fire,
    failReceipts: () => (failReceipt = true),
  };
}

const usd = (n: number): Money => money(BigInt(n), "USD");
const pay = { method: "card" as const, idempotencyKey: "k1" };

describe("fee configuration", () => {
  it("accepts per-currency creation fees and per-option customization fees", () => {
    expect(validateConfigValue("fee.creation_minor", CREATION)).toBeNull();
    expect(validateConfigValue("fee.customization_minor", CUSTOM)).toBeNull();
  });

  it("rejects plain numbers, missing currencies or options, negatives and extra keys", () => {
    expect(validateConfigValue("fee.creation_minor", 100)).not.toBeNull();
    expect(validateConfigValue("fee.creation_minor", { USD: 1 })).not.toBeNull();
    expect(validateConfigValue("fee.creation_minor", { COP: 1, USD: -1 })).not.toBeNull();
    expect(validateConfigValue("fee.creation_minor", { COP: 1, USD: 1.5 })).not.toBeNull();
    expect(validateConfigValue("fee.creation_minor", { COP: 1, USD: 1, EUR: 1 })).not.toBeNull();
    const missing = {
      share_theme: CUSTOM.share_theme,
      extra_prize_images: CUSTOM.extra_prize_images,
      notification_templates: CUSTOM.notification_templates,
    };
    expect(isCustomizationFeesConfig(missing)).toBe(false);
    expect(isCustomizationFeesConfig({ ...CUSTOM, confetti: { COP: 1, USD: 1 } })).toBe(false);
  });

  it("quotes each fee in the raffle currency and totals the lines (Req 3.1)", () => {
    const s = parseFeeSchedule(CREATION, CUSTOM);
    if (!s.ok) throw new Error("bad schedule");
    const q = quoteFees(s.value, "COP", ["share_theme", "creation_fee", "branding"]);
    expect(q.lines.map((l) => [l.item, l.amount.amountMinor])).toEqual([
      ["creation_fee", 2_000_000n],
      ["branding", 500_000n],
      ["share_theme", 300_000n],
    ]);
    expect(q.total).toEqual(money(2_800_000n, "COP"));
  });
});

describe("confirmation view (Req 3.1, 3.4)", () => {
  it("lists the unpaid Creation_Fee and selected options with the total", async () => {
    const t = setup();
    await t.svc.selectCustomizations("owner-1", "r1", ["branding", "extra_prize_images"]);
    const v = await t.svc.confirmationView("owner-1", "r1");
    if (!v.ok) throw new Error(v.error.code);
    expect(v.value.lines.map((l) => l.item)).toEqual(["creation_fee", "branding", "extra_prize_images"]);
    expect(v.value.total).toEqual(usd(999 + 299 + 99));
    expect(v.value.providerAvailable).toBe(true);
  });

  it("reports no available provider for the raffle country", async () => {
    const t = setup({}, { noAdapter: true });
    const v = await t.svc.confirmationView("owner-1", "r1");
    expect(v.ok && v.value.providerAvailable).toBe(false);
  });

  it("is only for the owner", async () => {
    const t = setup();
    expect(await t.svc.confirmationView("someone-else", "r1")).toEqual({
      ok: false,
      error: { code: "forbidden" },
    });
  });
});

describe("Creation_Fee payment (Req 3.2, 3.3, 3.4, 3.7)", () => {
  it("charges the displayed amount, marks it paid and sends a receipt", async () => {
    const t = setup();
    const r = await t.svc.payFee("owner-1", "r1", "creation_fee", pay);
    expect(r.ok && r.value).toMatchObject({ status: "succeeded", amount: usd(999), receiptSent: true });
    expect(t.adapter.charges[0]?.amount).toEqual(usd(999));
    expect(t.repo.raffle("r1")?.creationFeePaid).toBe(true);
    expect(t.receipts).toEqual([
      expect.objectContaining({ item: "creation_fee", amount: usd(999), paidAt: NOW, ownerId: "owner-1" }),
    ]);
  });

  it("on decline keeps the raffle in draft, unpaid, and allows a retry", async () => {
    const t = setup();
    t.adapter.behavior = "decline";
    const r = await t.svc.payFee("owner-1", "r1", "creation_fee", pay);
    expect(r.ok && r.value).toMatchObject({ status: "failed", reason: "insufficient_funds" });
    expect(t.repo.raffle("r1")).toMatchObject({ status: "draft", creationFeePaid: false });
    t.adapter.behavior = "succeed";
    const retry = await t.svc.payFee("owner-1", "r1", "creation_fee", { ...pay, idempotencyKey: "k2" });
    expect(retry.ok && retry.value.status).toBe("succeeded");
  });

  it("returns a timeout failure when the provider does not answer within 30 seconds", async () => {
    const t = setup();
    t.adapter.behavior = "hang";
    const pending = t.svc.payFee("owner-1", "r1", "creation_fee", pay);
    await new Promise((r) => setTimeout(r, 0));
    t.fire();
    const r = await pending;
    expect(r.ok && r.value).toMatchObject({ status: "failed", reason: "timeout" });
    expect(t.repo.raffle("r1")?.creationFeePaid).toBe(false);
    expect(t.repo.payments()[0]?.status).toBe("expired");
  });

  it("treats a provider error as a failure", async () => {
    const t = setup();
    t.adapter.behavior = "throw";
    const r = await t.svc.payFee("owner-1", "r1", "creation_fee", pay);
    expect(r.ok && r.value).toMatchObject({ status: "failed", reason: "provider_error" });
  });

  it("does not charge when no provider serves the raffle country", async () => {
    const t = setup({}, { noAdapter: true });
    const r = await t.svc.payFee("owner-1", "r1", "creation_fee", pay);
    expect(r).toEqual({ ok: false, error: { code: "no_provider_available", country: "US" } });
    expect(t.repo.payments()).toHaveLength(0);
  });

  it("replays a repeated idempotency key without a second charge", async () => {
    const t = setup();
    await t.svc.payFee("owner-1", "r1", "creation_fee", pay);
    const again = await t.svc.payFee("owner-1", "r1", "creation_fee", pay);
    expect(again.ok && again.value).toMatchObject({ status: "succeeded", replayed: true });
    expect(t.adapter.charges).toHaveLength(1);
  });

  it("rejects a missing key, a paid fee and a non-draft raffle", async () => {
    const t = setup();
    expect(await t.svc.payFee("owner-1", "r1", "creation_fee", { ...pay, idempotencyKey: " " })).toEqual({
      ok: false,
      error: { code: "idempotency_key_required" },
    });
    await t.svc.payFee("owner-1", "r1", "creation_fee", pay);
    const paid = await t.svc.payFee("owner-1", "r1", "creation_fee", { ...pay, idempotencyKey: "k9" });
    expect(paid).toEqual({ ok: false, error: { code: "already_paid", item: "creation_fee" } });
    const pub = setup({ status: "published" });
    const r = await pub.svc.payFee("owner-1", "r1", "creation_fee", pay);
    expect(r).toEqual({ ok: false, error: { code: "not_allowed_in_status", status: "published" } });
  });

  it("keeps the payment when the receipt cannot be queued", async () => {
    const t = setup();
    t.failReceipts();
    const r = await t.svc.payFee("owner-1", "r1", "creation_fee", pay);
    expect(r.ok && r.value).toMatchObject({ status: "succeeded", receiptSent: false });
    expect(t.repo.raffle("r1")?.creationFeePaid).toBe(true);
  });
});

describe("pending payments and completion", () => {
  it("returns the next step, then completes from the provider outcome once", async () => {
    const t = setup();
    t.adapter.behavior = "pending";
    const r = await t.svc.payFee("owner-1", "r1", "creation_fee", pay);
    if (!r.ok || r.value.status !== "action_required") throw new Error("expected action_required");
    expect(r.value.next).toEqual({ kind: "redirect", redirectUrl: "https://p.invalid/x" });
    expect(t.repo.raffle("r1")?.creationFeePaid).toBe(false);

    const done = await t.svc.completeFeePayment(r.value.paymentId, { status: "succeeded" });
    expect(done).toMatchObject({ status: "succeeded", replayed: false });
    const again = await t.svc.completeFeePayment(r.value.paymentId, { status: "succeeded" });
    expect(again).toMatchObject({ status: "succeeded", replayed: true });
    expect(t.receipts).toHaveLength(1);
  });

  it("refunds a second success for an already-paid fee", async () => {
    const t = setup();
    t.adapter.behavior = "pending";
    const first = await t.svc.payFee("owner-1", "r1", "creation_fee", pay);
    const second = await t.svc.payFee("owner-1", "r1", "creation_fee", { ...pay, idempotencyKey: "k2" });
    if (!first.ok || !second.ok) throw new Error("payFee failed");
    await t.svc.completeFeePayment(first.value.paymentId, { status: "succeeded" });
    const dup = await t.svc.completeFeePayment(second.value.paymentId, { status: "succeeded" });
    expect(dup).toMatchObject({ status: "failed", reason: "duplicate_refunded" });
    expect(t.repo.refunds()).toEqual([
      expect.objectContaining({ paymentId: second.value.paymentId, amount: usd(999) }),
    ]);
  });
});

describe("fee changes (Req 3.8)", () => {
  it("apply only to payments initiated after the change", async () => {
    const t = setup();
    t.adapter.behavior = "pending";
    const before = await t.svc.payFee("owner-1", "r1", "creation_fee", pay);
    t.config.creation = { COP: 1, USD: 5000 };
    await t.svc.completeFeePayment(before.ok ? before.value.paymentId : "", { status: "succeeded" });
    expect(t.repo.payments()[0]?.amount).toEqual(usd(999));

    await t.svc.selectCustomizations("owner-1", "r1", ["branding"]);
    t.config.customization = { ...CUSTOM, branding: { COP: 1, USD: 777 } };
    t.adapter.behavior = "succeed";
    const after = await t.svc.payFee("owner-1", "r1", "branding", { ...pay, idempotencyKey: "k3" });
    expect(after.ok && after.value.amount).toEqual(usd(777));
  });

  it("refuses to charge with an invalid fee configuration", async () => {
    const t = setup();
    t.config.creation = 999;
    const r = await t.svc.payFee("owner-1", "r1", "creation_fee", pay);
    expect(r).toEqual({ ok: false, error: { code: "fee_config_invalid" } });
    expect(t.adapter.charges).toHaveLength(0);
  });
});

describe("Customization_Fee payments (Req 3.5, 3.6)", () => {
  it("charges once per selected option and enables only paid options", async () => {
    const t = setup({ country: "CO", currency: "COP" }, { country: "CO" });
    await t.svc.selectCustomizations("owner-1", "r1", ["branding", "share_theme"]);
    const ok1 = await t.svc.payFee("owner-1", "r1", "branding", { method: "pse", idempotencyKey: "a" });
    t.adapter.behavior = "decline";
    const bad = await t.svc.payFee("owner-1", "r1", "share_theme", { method: "pse", idempotencyKey: "b" });
    expect(ok1.ok && ok1.value.amount).toEqual(money(500_000n, "COP"));
    expect(bad.ok && bad.value.status).toBe("failed");
    // The failed option stays selected but disabled.
    expect(t.repo.raffle("r1")?.customizations).toEqual([
      { option: "branding", enabled: true },
      { option: "share_theme", enabled: false },
    ]);
    const twice = await t.svc.payFee("owner-1", "r1", "branding", { method: "pse", idempotencyKey: "c" });
    expect(twice).toEqual({ ok: false, error: { code: "already_paid", item: "branding" } });
  });

  it("rejects unselected and unknown options", async () => {
    const t = setup();
    expect(await t.svc.payFee("owner-1", "r1", "branding", pay)).toEqual({
      ok: false,
      error: { code: "not_selected", item: "branding" },
    });
    expect(await t.svc.selectCustomizations("owner-1", "r1", ["confetti"])).toEqual({
      ok: false,
      error: { code: "invalid_option", option: "confetti" },
    });
  });

  it("keeps enabled options when the selection changes", async () => {
    const t = setup();
    await t.svc.selectCustomizations("owner-1", "r1", ["branding"]);
    await t.svc.payFee("owner-1", "r1", "branding", pay);
    await t.svc.selectCustomizations("owner-1", "r1", ["share_theme"]);
    expect(t.repo.raffle("r1")?.customizations).toEqual([
      { option: "branding", enabled: true },
      { option: "share_theme", enabled: false },
    ]);
  });
});

describe("Creation_Fee refund on cancellation (Req 3.9)", () => {
  it("queues a full refund when cancelled from draft, once", async () => {
    const t = setup();
    await t.svc.payFee("owner-1", "r1", "creation_fee", pay);
    const paymentId = t.repo.payments()[0]!.id;
    const queued = await t.repo.transaction((tx) =>
      t.svc.refundCreationFeeOnCancel(tx, "r1", NOW, "draft"),
    );
    const again = await t.repo.transaction((tx) =>
      t.svc.refundCreationFeeOnCancel(tx, "r1", NOW, "draft"),
    );
    expect([queued, again]).toEqual([true, false]);
    expect(t.repo.refunds()).toEqual([
      expect.objectContaining({ paymentId, amount: usd(999), nextAttemptAt: NOW }),
    ]);
  });

  it("does nothing after publication or without a paid fee", async () => {
    const t = setup();
    expect(await t.repo.transaction((tx) => t.svc.refundCreationFeeOnCancel(tx, "r1", NOW, "draft"))).toBe(
      false,
    );
    await t.svc.payFee("owner-1", "r1", "creation_fee", pay);
    expect(
      await t.repo.transaction((tx) => t.svc.refundCreationFeeOnCancel(tx, "r1", NOW, "published")),
    ).toBe(false);
    expect(t.repo.refunds()).toHaveLength(0);
  });
});
