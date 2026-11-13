import { describe, expect, it } from "vitest";
import { manualClock } from "@raffle/shared";
import { ageOn, isOfAge, validateRegistration, type RegistrationInput } from "./registration.js";
import { register, type NewAccount, type RegisterDeps } from "./register.js";

const NOW = new Date("2025-06-15T12:00:00Z");
const valid: RegistrationInput = {
  email: "ana@example.com",
  phone: "+573001234567",
  password: "correct horse battery",
  dob: new Date("1990-01-01T00:00:00Z"),
  policyAccepted: true,
  policyVersion: "2025-01",
};

describe("ageOn", () => {
  it("counts whole years around the birthday", () => {
    const dob = new Date("2007-06-15T00:00:00Z");
    expect(ageOn(dob, new Date("2025-06-14T23:59:59Z"))).toBe(17);
    expect(ageOn(dob, new Date("2025-06-15T00:00:00Z"))).toBe(18);
  });
  it("treats Feb 29 birthdays as Mar 1 in non-leap years", () => {
    const dob = new Date("2004-02-29T00:00:00Z");
    expect(ageOn(dob, new Date("2022-02-28T00:00:00Z"))).toBe(17);
    expect(ageOn(dob, new Date("2022-03-01T00:00:00Z"))).toBe(18);
    expect(ageOn(dob, new Date("2024-02-29T00:00:00Z"))).toBe(20);
    expect(isOfAge(dob, new Date("2022-02-28T00:00:00Z"))).toBe(false);
  });
});

describe("validateRegistration", () => {
  it("accepts a valid input", () => {
    expect(validateRegistration(valid, NOW, false)).toBeNull();
  });
  it("names exactly the invalid fields", () => {
    const errs = validateRegistration(
      { ...valid, email: "bad", phone: "3001234567", password: "short" },
      NOW,
      false,
    );
    expect(errs?.map((e) => e.field)).toEqual(["email", "phone", "password"]);
  });
  it("enforces email length 254 and password bounds 12..128", () => {
    const local = "a".repeat(64);
    const longEmail = `${local}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.com`;
    expect(longEmail.length).toBeGreaterThan(254);
    expect(validateRegistration({ ...valid, email: longEmail }, NOW, false)).not.toBeNull();
    const okEmail = `${local}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
    expect(okEmail.length).toBe(254);
    expect(validateRegistration({ ...valid, email: okEmail }, NOW, false)).toBeNull();
    expect(validateRegistration({ ...valid, password: "a".repeat(11) }, NOW, false)).not.toBeNull();
    expect(validateRegistration({ ...valid, password: "a".repeat(12) }, NOW, false)).toBeNull();
    expect(validateRegistration({ ...valid, password: "a".repeat(128) }, NOW, false)).toBeNull();
    expect(
      validateRegistration({ ...valid, password: "a".repeat(129) }, NOW, false),
    ).not.toBeNull();
  });
  it("reports a taken email exactly like a malformed one", () => {
    const taken = validateRegistration(valid, NOW, true);
    const malformed = validateRegistration({ ...valid, email: "bad" }, NOW, false);
    expect(taken).toEqual(malformed);
  });
  it("rejects under-18 and missing consent", () => {
    const young = validateRegistration(
      { ...valid, dob: new Date("2007-06-16T00:00:00Z") },
      NOW,
      false,
    );
    expect(young).toEqual([{ field: "dob", constraint: "minAge", params: { min: 18 } }]);
    const noConsent = validateRegistration({ ...valid, policyAccepted: false }, NOW, false);
    expect(noConsent?.map((e) => e.field)).toEqual(["consent"]);
  });
});

function makeDeps(opts: { takenEmail?: boolean; sendFails?: boolean } = {}) {
  const created: NewAccount[] = [];
  const sent: string[] = [];
  const deps: RegisterDeps = {
    accounts: {
      isEmailTaken: async () => opts.takenEmail ?? false,
      isPhoneTaken: async () => false,
      create: async (a) => {
        created.push(a);
        return "created";
      },
    },
    hasher: { hash: async (p) => `hash:${p.length}` },
    verification: {
      sendVerification: async (a) => {
        if (opts.sendFails) throw new Error("smtp down");
        sent.push(a.email);
      },
    },
    clock: manualClock(new Date("2025-06-15T12:00:00.789Z")),
    newId: () => "u-1",
  };
  return { deps, created, sent };
}

describe("register", () => {
  it("creates an unverified account, records consent, sends verification", async () => {
    const { deps, created, sent } = makeDeps();
    const r = await register(deps, valid);
    expect(r).toEqual({ ok: true, value: { accountId: "u-1", verificationSent: true } });
    expect(created[0]?.emailVerifiedAt).toBeNull();
    expect(created[0]?.passwordHash).not.toContain(valid.password);
    expect(created[0]?.consent).toEqual({
      policyVersion: "2025-01",
      userId: "u-1",
      acceptedAt: new Date("2025-06-15T12:00:00.000Z"),
    });
    expect(sent).toEqual([valid.email]);
  });
  it("creates no account without acceptance or when under age", async () => {
    const a = makeDeps();
    expect((await register(a.deps, { ...valid, policyAccepted: false })).ok).toBe(false);
    expect((await register(a.deps, { ...valid, dob: new Date("2015-01-01T00:00:00Z") })).ok).toBe(
      false,
    );
    expect(a.created).toHaveLength(0);
  });
  it("creates no account for a taken email", async () => {
    const a = makeDeps({ takenEmail: true });
    const r = await register(a.deps, valid);
    expect(r.ok).toBe(false);
    expect(a.created).toHaveLength(0);
  });
  it("still succeeds when the verification send fails", async () => {
    const a = makeDeps({ sendFails: true });
    const r = await register(a.deps, valid);
    expect(r).toEqual({ ok: true, value: { accountId: "u-1", verificationSent: false } });
  });
});
