import { err, ok, type Clock, type CryptoRng, type Result } from "@raffle/shared";
import { isLocked, nextLockState, type LockState } from "./lockout.js";
import type { PasswordVerifier } from "./password.js";
import type { PasswordHasher } from "./register.js";
import { digestsEqual, hashToken, newToken, sessionCookie, SESSION_TTL_MS } from "./session.js";
import { verifyTotp } from "./totp.js";

export type MfaType = "sms" | "totp";

/** Maximum one-time code attempts per challenge (Requirement 1.8). */
export const MFA_MAX_ATTEMPTS = 5;
/** Lifetime of an MFA challenge and its code. */
export const MFA_CODE_TTL_MS = 5 * 60 * 1000;

export interface AuthAccount {
  readonly id: string;
  readonly email: string;
  readonly phoneE164: string;
  readonly passwordHash: string;
  readonly emailVerifiedAt: Date | null;
  readonly roles: readonly string[];
  readonly status: "active" | "suspended";
  readonly mfa: { readonly enabled: boolean; readonly type?: MfaType | undefined };
  /** Raw TOTP secret, present once an authenticator app is enrolled. */
  readonly totpSecret?: Uint8Array | null | undefined;
  readonly lock: LockState;
}

export interface AuthAccountRepository {
  findByEmail(email: string): Promise<AuthAccount | null>;
  findById(id: string): Promise<AuthAccount | null>;
  saveLockState(id: string, lock: LockState): Promise<void>;
  updatePasswordHash(id: string, passwordHash: string): Promise<void>;
}

export interface SessionRecord {
  readonly tokenHash: string;
  readonly accountId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface SessionStore {
  create(session: SessionRecord): Promise<void>;
  revokeAllFor(accountId: string): Promise<void>;
}

export interface MfaChallenge {
  readonly id: string;
  readonly accountId: string;
  readonly type: MfaType;
  /** SHA-256 of the SMS code; null for TOTP, which is checked against the account secret. */
  readonly codeHash: string | null;
  readonly expiresAt: Date;
  readonly attempts: number;
}

export interface MfaChallengeStore {
  create(challenge: MfaChallenge): Promise<void>;
  find(id: string): Promise<MfaChallenge | null>;
  save(challenge: MfaChallenge): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface AuthNotifier {
  /** Tells the account holder that the account is locked until `until` (Requirement 1.6). */
  sendLockNotice(to: { email: string; until: Date }): Promise<void>;
  sendSmsCode(to: { phoneE164: string; code: string }): Promise<void>;
}

export interface SignInDeps {
  readonly accounts: AuthAccountRepository;
  readonly sessions: SessionStore;
  readonly challenges: MfaChallengeStore;
  readonly notifier: AuthNotifier;
  readonly hasher: PasswordHasher & PasswordVerifier;
  readonly rng: CryptoRng;
  readonly clock: Clock;
  readonly newId: () => string;
}

export type AuthError =
  /** Same error for an unknown email, a wrong password and a suspended account (Req 1.5). */
  | { readonly kind: "invalid_credentials" }
  | { readonly kind: "locked"; readonly until: Date }
  | { readonly kind: "email_unverified" }
  | { readonly kind: "mfa_invalid"; readonly attemptsRemaining: number }
  | { readonly kind: "mfa_expired" }
  /** Too many wrong codes, or an unknown challenge: credentials must be entered again. */
  | { readonly kind: "mfa_restart" };

export interface IssuedSession {
  readonly accountId: string;
  /** Opaque bearer token; only its hash is stored. */
  readonly token: string;
  readonly expiresAt: Date;
  /** Ready-to-send Set-Cookie header value. */
  readonly setCookie: string;
}

export type SignInOutcome =
  | { readonly kind: "session"; readonly session: IssuedSession }
  | { readonly kind: "mfa_required"; readonly challengeId: string; readonly type: MfaType };

/** Owners and Admins complete MFA at every sign-in (Requirement 1.9). Players are the only exempt role. */
export function isPrivileged(roles: readonly string[]): boolean {
  return roles.some((r) => r !== "player");
}

/** Whether a sign-in with valid credentials must pass an MFA challenge, and with which factor. */
export function requiredMfa(a: AuthAccount): MfaType | null {
  if (a.mfa.enabled) return a.mfa.type ?? "sms";
  // Privileged accounts without an enrolled factor fall back to SMS on the registered phone.
  return isPrivileged(a.roles) ? "sms" : null;
}

let dummyHash: Promise<string> | undefined;

async function issueSession(deps: SignInDeps, accountId: string): Promise<IssuedSession> {
  const now = deps.clock.now();
  const token = newToken(deps.rng);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await deps.sessions.create({ tokenHash: hashToken(token), accountId, createdAt: now, expiresAt });
  return { accountId, token, expiresAt, setCookie: sessionCookie(token, expiresAt, now) };
}

function randomSixDigits(rng: CryptoRng): string {
  // Rejection sampling over 32 bits keeps the code uniform.
  const limit = Math.floor(2 ** 32 / 1_000_000) * 1_000_000;
  for (;;) {
    const b = rng.bytes(4);
    const v = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
    if (v < limit) return String(v % 1_000_000).padStart(6, "0");
  }
}

/**
 * Checks credentials. Rejections never start a session. Failures and the lock are recorded
 * per account; unknown emails take the same path and the same error as a wrong password.
 */
export async function signIn(
  deps: SignInDeps,
  email: string,
  password: string,
): Promise<Result<SignInOutcome, AuthError>> {
  const now = deps.clock.now();
  const account = await deps.accounts.findByEmail(email);

  if (!account) {
    // Burn comparable time so response latency does not reveal whether the email exists.
    dummyHash ??= deps.hasher.hash("dummy-password-for-timing");
    await deps.hasher.verify(await dummyHash, password);
    return err({ kind: "invalid_credentials" });
  }

  // While locked every attempt is rejected, including one with valid credentials (Req 1.6).
  if (isLocked(account.lock, now) && account.lock.lockedUntil) {
    return err({ kind: "locked", until: account.lock.lockedUntil });
  }

  const valid = await deps.hasher.verify(account.passwordHash, password);
  const before = account.lock;
  const after = nextLockState(before, { at: now, ok: valid });
  const clean = before.failures.length === 0 && before.lockedUntil === null;
  if (!(valid && clean)) await deps.accounts.saveLockState(account.id, after);

  if (!valid) {
    if (after.lockedUntil) {
      try {
        await deps.notifier.sendLockNotice({ email: account.email, until: after.lockedUntil });
      } catch {
        // The lock stands even when the notice cannot be sent.
      }
    }
    return err({ kind: "invalid_credentials" });
  }

  if (account.status !== "active") return err({ kind: "invalid_credentials" });
  if (account.emailVerifiedAt === null) return err({ kind: "email_unverified" });

  const type = requiredMfa(account);
  if (type === null) return ok({ kind: "session", session: await issueSession(deps, account.id) });

  let codeHash: string | null = null;
  if (type === "sms") {
    const code = randomSixDigits(deps.rng);
    codeHash = hashToken(code);
    await deps.notifier.sendSmsCode({ phoneE164: account.phoneE164, code });
  }
  const challengeId = deps.newId();
  await deps.challenges.create({
    id: challengeId,
    accountId: account.id,
    type,
    codeHash,
    expiresAt: new Date(now.getTime() + MFA_CODE_TTL_MS),
    attempts: 0,
  });
  return ok({ kind: "mfa_required", challengeId, type });
}

/**
 * Completes an MFA challenge. A wrong code uses one of 5 attempts; the fifth wrong code or an
 * unknown challenge requires the credentials again. A correct code is single use.
 */
export async function verifyMfa(
  deps: SignInDeps,
  challengeId: string,
  code: string,
): Promise<Result<IssuedSession, AuthError>> {
  const now = deps.clock.now();
  const challenge = await deps.challenges.find(challengeId);
  if (!challenge) return err({ kind: "mfa_restart" });

  if (now.getTime() >= challenge.expiresAt.getTime()) {
    await deps.challenges.delete(challenge.id);
    return err({ kind: "mfa_expired" });
  }

  const attempts = challenge.attempts + 1;
  let correct = false;
  if (/^\d{6}$/.test(code)) {
    if (challenge.type === "sms") {
      correct = challenge.codeHash !== null && digestsEqual(challenge.codeHash, hashToken(code));
    } else {
      const account = await deps.accounts.findById(challenge.accountId);
      correct = !!account?.totpSecret && verifyTotp(account.totpSecret, code, now);
    }
  }

  if (correct) {
    await deps.challenges.delete(challenge.id);
    return ok(await issueSession(deps, challenge.accountId));
  }
  if (attempts >= MFA_MAX_ATTEMPTS) {
    await deps.challenges.delete(challenge.id);
    return err({ kind: "mfa_restart" });
  }
  await deps.challenges.save({ ...challenge, attempts });
  return err({ kind: "mfa_invalid", attemptsRemaining: MFA_MAX_ATTEMPTS - attempts });
}
