import { describe, expect, it } from "vitest";
import { manualClock, webCryptoRng } from "@raffle/shared";
import { argon2idHasher } from "./password.js";
import { INITIAL_LOCK_STATE, type LockState } from "./lockout.js";
import { SESSION_COOKIE_NAME, hashToken } from "./session.js";
import { totpCode } from "./totp.js";
import {
  signIn,
  verifyMfa,
  type AuthAccount,
  type MfaChallenge,
  type SessionRecord,
  type SignInDeps,
} from "./signin.js";
import {
  requestPasswordReset,
  resetPassword,
  RESET_LINK_TTL_MS,
  type PasswordResetDeps,
  type ResetTokenRecord,
} from "./password-reset.js";

const hasher = argon2idHasher({ memoryCost: 1024, timeCost: 1, parallelism: 1 });
const PASSWORD = "correct horse battery";
const T0 = new Date("2025-06-15T12:00:00Z");

async function setup(over: Partial<AuthAccount> = {}) {
  const clock = manualClock(T0);
  const account: { current: AuthAccount } = {
    current: {
      id: "u1",
      email: "ana@example.com",
      phoneE164: "+573001234567",
      passwordHash: await hasher.hash(PASSWORD),
      emailVerifiedAt: T0,
      roles: ["player"],
      status: "active",
      mfa: { enabled: false },
      lock: INITIAL_LOCK_STATE,
      ...over,
    },
  };
  const sessions: SessionRecord[] = [];
  const challenges = new Map<string, MfaChallenge>();
  const lockNotices: { email: string; until: Date }[] = [];
  const smsCodes: string[] = [];
  const resetTokens = new Map<string, ResetTokenRecord & { used: boolean }>();
  const resetLinks: { email: string; token: string }[] = [];
  let n = 0;

  const accounts = {
    findByEmail: async (e: string) => (e === account.current.email ? account.current : null),
    findById: async (id: string) => (id === account.current.id ? account.current : null),
    saveLockState: async (_id: string, lock: LockState) => {
      account.current = { ...account.current, lock };
    },
    updatePasswordHash: async (_id: string, passwordHash: string) => {
      account.current = { ...account.current, passwordHash };
    },
  };
  const sessionStore = {
    create: async (s: SessionRecord) => void sessions.push(s),
    revokeAllFor: async (id: string) => {
      for (let i = sessions.length - 1; i >= 0; i--)
        if (sessions[i]!.accountId === id) sessions.splice(i, 1);
    },
  };
  const rng = webCryptoRng();
  const deps: SignInDeps = {
    accounts,
    sessions: sessionStore,
    challenges: {
      create: async (c) => void challenges.set(c.id, c),
      find: async (id) => challenges.get(id) ?? null,
      save: async (c) => void challenges.set(c.id, c),
      delete: async (id) => void challenges.delete(id),
    },
    notifier: {
      sendLockNotice: async (to) => void lockNotices.push(to),
      sendSmsCode: async (to) => void smsCodes.push(to.code),
    },
    hasher,
    rng,
    clock,
    newId: () => `c${++n}`,
  };
  const resetDeps: PasswordResetDeps = {
    accounts,
    sessions: sessionStore,
    hasher,
    rng,
    clock,
    sender: { sendResetLink: async (to) => void resetLinks.push(to) },
    tokens: {
      create: async (r) => void resetTokens.set(r.tokenHash, { ...r, used: false }),
      consume: async (h, now) => {
        const r = resetTokens.get(h);
        if (!r || r.used || now.getTime() >= r.expiresAt.getTime()) return null;
        r.used = true;
        return { accountId: r.accountId };
      },
    },
  };
  return {
    deps,
    resetDeps,
    clock,
    account,
    sessions,
    challenges,
    lockNotices,
    smsCodes,
    resetLinks,
  };
}

describe("signIn", () => {
  it("starts a session with a httpOnly, Secure, SameSite cookie for a verified account", async () => {
    const t = await setup();
    const r = await signIn(t.deps, "ana@example.com", PASSWORD);
    expect(r.ok && r.value.kind === "session").toBe(true);
    if (!r.ok || r.value.kind !== "session") return;
    const cookie = r.value.session.setCookie;
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Lax"]) expect(cookie).toContain(attr);
    expect(t.sessions).toHaveLength(1);
    expect(t.sessions[0]!.tokenHash).toBe(hashToken(r.value.session.token));
    expect(JSON.stringify(t.sessions)).not.toContain(r.value.session.token);
  });

  it("returns the same generic error for unknown email and wrong password", async () => {
    const t = await setup();
    const a = await signIn(t.deps, "nobody@example.com", PASSWORD);
    const b = await signIn(t.deps, "ana@example.com", "wrong password here");
    expect(a).toEqual({ ok: false, error: { kind: "invalid_credentials" } });
    expect(b).toEqual(a);
    expect(t.sessions).toHaveLength(0);
  });

  it("rejects valid credentials on an unverified account without a session", async () => {
    const t = await setup({ emailVerifiedAt: null });
    expect(await signIn(t.deps, "ana@example.com", PASSWORD)).toEqual({
      ok: false,
      error: { kind: "email_unverified" },
    });
    expect(t.sessions).toHaveLength(0);
  });

  it("locks after 5 failures, rejects valid credentials while locked, and emails once", async () => {
    const t = await setup();
    for (let i = 0; i < 5; i++) await signIn(t.deps, "ana@example.com", "bad password 123456");
    expect(t.lockNotices).toHaveLength(1);
    const during = await signIn(t.deps, "ana@example.com", PASSWORD);
    expect(during.ok).toBe(false);
    if (!during.ok) expect(during.error.kind).toBe("locked");
    expect(t.sessions).toHaveLength(0);
    t.clock.advance(15 * 60 * 1000);
    const after = await signIn(t.deps, "ana@example.com", PASSWORD);
    expect(after.ok).toBe(true);
  });
});

describe("MFA", () => {
  it("requires an SMS code for an enabled account and starts the session on the right code", async () => {
    const t = await setup({ mfa: { enabled: true, type: "sms" } });
    const r = await signIn(t.deps, "ana@example.com", PASSWORD);
    expect(r.ok && r.value.kind).toBe("mfa_required");
    expect(t.sessions).toHaveLength(0);
    if (!r.ok || r.value.kind !== "mfa_required") return;
    expect(t.smsCodes[0]).toMatch(/^\d{6}$/);
    const s = await verifyMfa(t.deps, r.value.challengeId, t.smsCodes[0]!);
    expect(s.ok).toBe(true);
    expect(t.sessions).toHaveLength(1);
    // Single use.
    expect((await verifyMfa(t.deps, r.value.challengeId, t.smsCodes[0]!)).ok).toBe(false);
  });

  it("forces MFA for owners and admins even when not enrolled", async () => {
    for (const role of ["owner", "admin"]) {
      const t = await setup({ roles: [role] });
      const r = await signIn(t.deps, "ana@example.com", PASSWORD);
      expect(r.ok && r.value.kind).toBe("mfa_required");
      expect(t.sessions).toHaveLength(0);
    }
  });

  it("allows 5 wrong codes then requires credentials again, even for the right code", async () => {
    const t = await setup({ mfa: { enabled: true, type: "sms" } });
    const r = await signIn(t.deps, "ana@example.com", PASSWORD);
    if (!r.ok || r.value.kind !== "mfa_required") throw new Error("expected challenge");
    const id = r.value.challengeId;
    const wrong = t.smsCodes[0] === "000000" ? "111111" : "000000";
    for (let i = 1; i <= 4; i++) {
      expect(await verifyMfa(t.deps, id, wrong)).toEqual({
        ok: false,
        error: { kind: "mfa_invalid", attemptsRemaining: 5 - i },
      });
    }
    expect(await verifyMfa(t.deps, id, wrong)).toEqual({
      ok: false,
      error: { kind: "mfa_restart" },
    });
    expect((await verifyMfa(t.deps, id, t.smsCodes[0]!)).ok).toBe(false);
    expect(t.sessions).toHaveLength(0);
  });

  it("rejects an expired code", async () => {
    const t = await setup({ mfa: { enabled: true, type: "sms" } });
    const r = await signIn(t.deps, "ana@example.com", PASSWORD);
    if (!r.ok || r.value.kind !== "mfa_required") throw new Error("expected challenge");
    t.clock.advance(5 * 60 * 1000);
    expect(await verifyMfa(t.deps, r.value.challengeId, t.smsCodes[0]!)).toEqual({
      ok: false,
      error: { kind: "mfa_expired" },
    });
    expect(t.sessions).toHaveLength(0);
  });

  it("verifies a TOTP code from an authenticator app", async () => {
    const secret = new TextEncoder().encode("12345678901234567890");
    const t = await setup({ mfa: { enabled: true, type: "totp" }, totpSecret: secret });
    const r = await signIn(t.deps, "ana@example.com", PASSWORD);
    if (!r.ok || r.value.kind !== "mfa_required") throw new Error("expected challenge");
    expect(t.smsCodes).toHaveLength(0);
    const s = await verifyMfa(t.deps, r.value.challengeId, totpCode(secret, T0));
    expect(s.ok).toBe(true);
  });
});

describe("password reset", () => {
  it("sends a link only for registered emails and never signals which", async () => {
    const t = await setup();
    await expect(requestPasswordReset(t.resetDeps, "nobody@example.com")).resolves.toBeUndefined();
    expect(t.resetLinks).toHaveLength(0);
    await expect(requestPasswordReset(t.resetDeps, "ana@example.com")).resolves.toBeUndefined();
    expect(t.resetLinks).toHaveLength(1);
  });

  it("resets once, then rejects reuse and leaves the new password in place", async () => {
    const t = await setup();
    await requestPasswordReset(t.resetDeps, "ana@example.com");
    const token = t.resetLinks[0]!.token;
    const ok1 = await resetPassword(t.resetDeps, token, "a brand new password");
    expect(ok1.ok).toBe(true);
    expect(await hasher.verify(t.account.current.passwordHash, "a brand new password")).toBe(true);
    const again = await resetPassword(t.resetDeps, token, "another password 123");
    expect(again).toEqual({ ok: false, error: { kind: "link_invalid" } });
    expect(await hasher.verify(t.account.current.passwordHash, "a brand new password")).toBe(true);
  });

  it("rejects an expired link and leaves the password unchanged", async () => {
    const t = await setup();
    const before = t.account.current.passwordHash;
    await requestPasswordReset(t.resetDeps, "ana@example.com");
    t.clock.advance(RESET_LINK_TTL_MS);
    const r = await resetPassword(t.resetDeps, t.resetLinks[0]!.token, "a brand new password");
    expect(r).toEqual({ ok: false, error: { kind: "link_invalid" } });
    expect(t.account.current.passwordHash).toBe(before);
  });

  it("rejects a new password outside 12 to 128 characters without spending the link", async () => {
    const t = await setup();
    await requestPasswordReset(t.resetDeps, "ana@example.com");
    const token = t.resetLinks[0]!.token;
    const bad = await resetPassword(t.resetDeps, token, "short");
    expect(!bad.ok && bad.error.kind).toBe("validation");
    expect((await resetPassword(t.resetDeps, token, "a brand new password")).ok).toBe(true);
  });
});
