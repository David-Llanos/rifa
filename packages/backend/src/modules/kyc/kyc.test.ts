import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { manualClock, money } from "@raffle/shared";
import {
  AesGcmEncryption,
  FakeKycProvider,
  InMemoryBlobStore,
  InMemoryKycRepository,
  KycAccessDenied,
  KycDocumentStore,
  KycService,
  kycAttemptAllowed,
  winnerDeliveryDecision,
  winnerVerificationRequired,
  type FakeKycBehavior,
  type KycSubmission,
} from "./index.js";

const T0 = new Date("2025-01-01T00:00:00Z");
const H = 3600_000;

const sub = (subjectId = "u1"): KycSubmission => ({
  subjectId,
  kind: "owner",
  legalName: "Ana Perez",
  idType: "cedula_ciudadania",
  idNumber: "123",
  documents: [{ name: "id.png", mime: "image/png", bytes: new Uint8Array([1, 2, 3]) }],
});

function setup(script: FakeKycBehavior[], timeoutMs = 20) {
  const clock = manualClock(T0);
  const blobs = new InMemoryBlobStore();
  const store = new KycDocumentStore(blobs, new AesGcmEncryption(randomBytes(32)));
  const notices: unknown[] = [];
  const svc = new KycService(
    new InMemoryKycRepository(),
    store,
    new FakeKycProvider(script),
    clock,
    { providerTimeoutMs: timeoutMs, notifyWinnerOutstanding: (n) => notices.push(n) },
  );
  return { clock, svc, store, blobs, notices };
}

describe("kycAttemptAllowed", () => {
  it("allows only while fewer than 3 attempts in the previous 24h", () => {
    const now = new Date(T0.getTime() + 30 * H);
    const a = (h: number) => new Date(T0.getTime() + h * H);
    expect(kycAttemptAllowed([], now)).toBe(true);
    expect(kycAttemptAllowed([a(7), a(8)], now)).toBe(true);
    expect(kycAttemptAllowed([a(7), a(8), a(9)], now)).toBe(false);
    // attempt at exactly 24h ago has aged out
    expect(kycAttemptAllowed([a(6), a(8), a(9)], now)).toBe(true);
  });
});

describe("KycService owner flow", () => {
  it("approves and permits publication", async () => {
    const { svc } = setup([{ type: "approve" }]);
    expect(svc.ownerMayPublish("u1")).toBe(false);
    expect((await svc.submitOwnerKyc(sub())).status).toBe("approved");
    expect(svc.ownerMayPublish("u1")).toBe(true);
  });

  it("rejection blocks publication, gives reason, and limits to 3 attempts in 24h", async () => {
    const { svc, clock } = setup([{ type: "reject", reason: "blurry" }]);
    const r1 = await svc.submitOwnerKyc(sub());
    expect(r1).toMatchObject({ status: "rejected", reason: "blurry", retriesRemaining: 2 });
    await svc.submitOwnerKyc(sub());
    await svc.submitOwnerKyc(sub());
    expect((await svc.submitOwnerKyc(sub())).status).toBe("rate_limited");
    expect(svc.ownerMayPublish("u1")).toBe(false);
    clock.advance(25 * H);
    expect((await svc.submitOwnerKyc(sub())).status).toBe("rejected");
  });

  it("times out when the provider hangs and allows retry", async () => {
    const { svc } = setup([{ type: "hang" }, { type: "approve" }]);
    expect(await svc.submitOwnerKyc(sub())).toMatchObject({ status: "error", reason: "timeout" });
    expect(svc.ownerMayPublish("u1")).toBe(false);
    expect((await svc.submitOwnerKyc(sub())).status).toBe("approved");
  });

  it("treats provider failure as unavailable", async () => {
    const { svc } = setup([{ type: "fail" }]);
    expect(await svc.submitOwnerKyc(sub())).toMatchObject({
      status: "error",
      reason: "unavailable",
    });
  });
});

describe("age verification and winners", () => {
  it("blocks first purchase until document age check approved when required", async () => {
    const { svc } = setup([{ type: "approve" }]);
    expect(svc.playerMayPurchase("p1", false)).toBe(true);
    expect(svc.playerMayPurchase("p1", true)).toBe(false);
    await svc.submitAgeVerification(sub("p1"));
    expect(svc.playerMayPurchase("p1", true)).toBe(true);
  });

  it("requires winner KYC only above the threshold", () => {
    const th = money(100_000n, "USD");
    expect(winnerVerificationRequired(money(100_001n, "USD"), th)).toBe(true);
    expect(winnerVerificationRequired(money(100_000n, "USD"), th)).toBe(false);
  });

  it("withholds delivery when rejected or after 30 days, and notifies", async () => {
    const { svc, clock, notices } = setup([{ type: "reject", reason: "mismatch" }]);
    expect(svc.winnerDelivery("w1", T0).action).toBe("wait");
    await svc.submitWinnerKyc(sub("w1"));
    expect(svc.winnerDelivery("w1", T0)).toEqual({ action: "withhold", reason: "rejected" });
    clock.advance(31 * 24 * H);
    expect(svc.winnerDelivery("w2", T0)).toEqual({ action: "withhold", reason: "overdue" });
    expect(notices).toHaveLength(2);
  });

  it("releases delivery when approved", async () => {
    const { svc } = setup([{ type: "approve" }]);
    await svc.submitWinnerKyc(sub("w1"));
    expect(svc.winnerDelivery("w1", T0)).toEqual({ action: "release" });
    expect(winnerDeliveryDecision("none", T0, T0).action).toBe("wait");
  });
});

describe("encrypted document storage", () => {
  it("stores ciphertext, decrypts only for admins and the provider", async () => {
    const { svc, store, blobs } = setup([{ type: "approve" }]);
    const keyRef = store.put("u1", {
      name: "a",
      mime: "image/png",
      bytes: new Uint8Array([9, 9, 9]),
    });
    expect([...(blobs.get(keyRef) ?? [])].slice(-3)).not.toEqual([9, 9, 9]);
    expect([...store.get(keyRef, { role: "admin" })]).toEqual([9, 9, 9]);
    expect([...store.get(keyRef, { role: "kyc_provider" })]).toEqual([9, 9, 9]);
    expect(() => store.get(keyRef, { role: "owner" })).toThrow(KycAccessDenied);
    await svc.submitOwnerKyc(sub());
  });

  it("detects tampering and requires a 32-byte key from configuration", () => {
    const enc = new AesGcmEncryption(randomBytes(32));
    const sealed = enc.encrypt(new Uint8Array([1, 2, 3])) as Uint8Array;
    sealed[sealed.length - 1] = (sealed[sealed.length - 1] ?? 0) ^ 1;
    expect(() => enc.decrypt(sealed)).toThrow();
    expect(() => new AesGcmEncryption(new Uint8Array(16))).toThrow();
    expect(() => AesGcmEncryption.fromEnv({})).toThrow(/not configured/);
    const key = randomBytes(32).toString("base64");
    const fromEnv = AesGcmEncryption.fromEnv({ KYC_ENCRYPTION_KEY: key });
    expect(fromEnv).toBeInstanceOf(AesGcmEncryption);
  });
});
