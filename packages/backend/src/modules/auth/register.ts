import { err, ok, fieldError, type Clock, type FieldErrors, type Result } from "@raffle/shared";
import { validateRegistration, type RegistrationInput } from "./registration.js";

/** Consent record stored with the account: version, user and UTC timestamp to the second. */
export interface ConsentRecord {
  readonly policyVersion: string;
  readonly userId: string;
  readonly acceptedAt: Date;
}

export interface NewAccount {
  readonly id: string;
  readonly email: string;
  readonly phoneE164: string;
  readonly passwordHash: string;
  readonly dob: Date;
  readonly status: "active";
  /** Accounts start unverified: `emailVerifiedAt` is unset until the link is used. */
  readonly emailVerifiedAt: null;
  readonly consent: ConsentRecord;
}

export interface AccountRepository {
  isEmailTaken(email: string): Promise<boolean>;
  isPhoneTaken(phone: string): Promise<boolean>;
  /** Inserts the account. Returns "duplicate" when a unique index rejects it (concurrent signup). */
  create(account: NewAccount): Promise<"created" | "duplicate">;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
}

export interface VerificationSender {
  /** Sends the email verification message. Called immediately so it lands within 60 seconds. */
  sendVerification(account: { id: string; email: string }): Promise<void>;
}

export interface RegisterDeps {
  readonly accounts: AccountRepository;
  readonly hasher: PasswordHasher;
  readonly verification: VerificationSender;
  readonly clock: Clock;
  readonly newId: () => string;
}

export interface Registered {
  readonly accountId: string;
  /** False when the send failed; the caller can offer the resend option. */
  readonly verificationSent: boolean;
}

/** UTC timestamp truncated to the second. */
function toSecond(d: Date): Date {
  return new Date(Math.floor(d.getTime() / 1000) * 1000);
}

/**
 * Registers an account. Rejects, and creates nothing, when validation fails or the policy and
 * terms were not accepted. Never stores the plain password.
 */
export async function register(
  deps: RegisterDeps,
  input: RegistrationInput,
): Promise<Result<Registered, FieldErrors>> {
  const now = deps.clock.now();
  const [emailTaken, phoneTaken] = await Promise.all([
    deps.accounts.isEmailTaken(input.email),
    deps.accounts.isPhoneTaken(input.phone),
  ]);
  const errors = validateRegistration(input, now, emailTaken, phoneTaken);
  if (errors) return err(errors);

  const id = deps.newId();
  const created = await deps.accounts.create({
    id,
    email: input.email,
    phoneE164: input.phone,
    passwordHash: await deps.hasher.hash(input.password),
    dob: input.dob,
    status: "active",
    emailVerifiedAt: null,
    consent: { policyVersion: input.policyVersion, userId: id, acceptedAt: toSecond(now) },
  });
  if (created === "duplicate") {
    // Same generic error as a pre-checked duplicate; which field collided is not revealed.
    return err([fieldError("email", "invalid"), fieldError("phone", "invalid")]);
  }

  let verificationSent = true;
  try {
    await deps.verification.sendVerification({ id, email: input.email });
  } catch {
    verificationSent = false;
  }
  return ok({ accountId: id, verificationSent });
}
