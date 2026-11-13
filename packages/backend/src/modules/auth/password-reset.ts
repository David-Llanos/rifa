import {
  err,
  ok,
  fieldError,
  type Clock,
  type CryptoRng,
  type FieldErrors,
  type Result,
} from "@raffle/shared";
import type { PasswordHasher } from "./register.js";
import { isValidPasswordLength, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./registration.js";
import { hashToken, newToken } from "./session.js";
import type { AuthAccountRepository, SessionStore } from "./signin.js";

/** Reset links expire 60 minutes after they are sent (Requirement 1.10). */
export const RESET_LINK_TTL_MS = 60 * 60 * 1000;

export interface ResetTokenRecord {
  readonly tokenHash: string;
  readonly accountId: string;
  readonly expiresAt: Date;
}

export interface ResetTokenStore {
  create(record: ResetTokenRecord): Promise<void>;
  /**
   * Atomically marks the token used and returns its account, or null when the token is unknown,
   * expired at `now`, or already used. The atomic update is what makes the link single use.
   */
  consume(tokenHash: string, now: Date): Promise<{ accountId: string } | null>;
}

export interface ResetLinkSender {
  sendResetLink(to: { email: string; token: string; expiresAt: Date }): Promise<void>;
}

export interface PasswordResetDeps {
  readonly accounts: AuthAccountRepository;
  readonly tokens: ResetTokenStore;
  readonly sessions: SessionStore;
  readonly sender: ResetLinkSender;
  readonly hasher: PasswordHasher;
  readonly rng: CryptoRng;
  readonly clock: Clock;
}

export type ResetError =
  /** Expired, already used or unknown link; the password is unchanged (Requirement 1.11). */
  { readonly kind: "link_invalid" } | { readonly kind: "validation"; readonly errors: FieldErrors };

/**
 * Sends a single-use reset link when the email belongs to an account. Always resolves the same
 * way so the response never reveals whether the email is registered.
 */
export async function requestPasswordReset(deps: PasswordResetDeps, email: string): Promise<void> {
  try {
    const account = await deps.accounts.findByEmail(email);
    if (!account) return;
    const now = deps.clock.now();
    const token = newToken(deps.rng);
    const expiresAt = new Date(now.getTime() + RESET_LINK_TTL_MS);
    await deps.tokens.create({ tokenHash: hashToken(token), accountId: account.id, expiresAt });
    await deps.sender.sendResetLink({ email: account.email, token, expiresAt });
  } catch {
    // Failures are not surfaced: the caller always shows the generic confirmation.
  }
}

/** Sets a new password from a reset link and signs the account out everywhere. */
export async function resetPassword(
  deps: PasswordResetDeps,
  token: string,
  newPassword: string,
): Promise<Result<void, ResetError>> {
  if (!isValidPasswordLength(newPassword)) {
    return err({
      kind: "validation",
      errors: [
        fieldError("password", "length", { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH }),
      ],
    });
  }
  // Consume first: the link is spent even if a later step fails, never usable twice.
  const used = await deps.tokens.consume(hashToken(token), deps.clock.now());
  if (!used) return err({ kind: "link_invalid" });

  await deps.accounts.updatePasswordHash(used.accountId, await deps.hasher.hash(newPassword));
  await deps.sessions.revokeAllFor(used.accountId);
  return ok(undefined);
}
