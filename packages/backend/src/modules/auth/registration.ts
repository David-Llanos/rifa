import { fieldError, type FieldError, type FieldErrors } from "@raffle/shared";

/** Minimum age to register or buy tickets (Requirements 13.4, 13.5). */
export const MINIMUM_AGE = 18;
export const EMAIL_MAX_LENGTH = 254;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export interface RegistrationInput {
  readonly email: string;
  readonly phone: string;
  readonly password: string;
  /** Date of birth as a calendar date (the UTC year, month and day are used). */
  readonly dob: Date;
  /** True when the visitor accepted the privacy policy and terms of service. */
  readonly policyAccepted: boolean;
  /** Version identifier of the policy and terms document presented to the visitor. */
  readonly policyVersion: string;
}

const E164 = /^\+[1-9]\d{1,14}$/;
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function isValidEmail(email: string): boolean {
  if (email.length === 0 || email.length > EMAIL_MAX_LENGTH) return false;
  const at = email.lastIndexOf("@");
  if (at < 1 || at > 64) return false;
  if (email.includes("..") || email.startsWith(".") || email.slice(0, at).endsWith(".")) {
    return false;
  }
  return EMAIL.test(email);
}

export function isValidE164(phone: string): boolean {
  return E164.test(phone);
}

/** Password length counted in Unicode code points, so one emoji counts as one character. */
export function isValidPasswordLength(password: string): boolean {
  const n = Array.from(password).length;
  return n >= PASSWORD_MIN_LENGTH && n <= PASSWORD_MAX_LENGTH;
}

/**
 * Age in whole years on a given date, using UTC calendar dates. A person born on Feb 29
 * has their birthday on Mar 1 in non-leap years. Returns a negative number for a future dob.
 */
export function ageOn(dob: Date, on: Date): number {
  const by = dob.getUTCFullYear();
  const bm = dob.getUTCMonth();
  const bd = dob.getUTCDate();
  const oy = on.getUTCFullYear();
  const om = on.getUTCMonth();
  const od = on.getUTCDate();
  let age = oy - by;
  // Feb 29 birthdays fall on Mar 1 in non-leap years, which this comparison yields naturally
  // because (month 1, day 29) never precedes (month 2, day 1) in a non-leap year.
  if (om < bm || (om === bm && od < bd)) age -= 1;
  return age;
}

/** True when the date of birth shows an age of at least 18 on the given date. */
export function isOfAge(dob: Date, on: Date): boolean {
  return ageOn(dob, on) >= MINIMUM_AGE;
}

/**
 * Validates a registration. Returns null when valid, otherwise the exact set of invalid fields.
 * A taken email or phone is reported with the same `invalid` constraint as a malformed one, so
 * the response never reveals whether the address or number is already registered (Req 1.2).
 */
export function validateRegistration(
  i: RegistrationInput,
  now: Date,
  emailTaken: boolean,
  phoneTaken = false,
): FieldErrors | null {
  const errors: FieldError[] = [];

  if (!isValidEmail(i.email) || emailTaken) errors.push(fieldError("email", "invalid"));
  if (!isValidE164(i.phone) || phoneTaken) errors.push(fieldError("phone", "invalid"));
  if (!isValidPasswordLength(i.password)) {
    errors.push(
      fieldError("password", "length", { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH }),
    );
  }

  if (!(i.dob instanceof Date) || Number.isNaN(i.dob.getTime())) {
    errors.push(fieldError("dob", "required"));
  } else {
    const age = ageOn(i.dob, now);
    if (age < 0) errors.push(fieldError("dob", "invalid"));
    else if (age < MINIMUM_AGE) errors.push(fieldError("dob", "minAge", { min: MINIMUM_AGE }));
  }

  if (!i.policyAccepted || i.policyVersion.trim() === "") {
    errors.push(fieldError("consent", "required"));
  }

  return errors.length === 0 ? null : errors;
}
