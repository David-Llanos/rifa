import { createHash, timingSafeEqual } from "node:crypto";
import type { CryptoRng } from "@raffle/shared";

export const SESSION_COOKIE_NAME = "__Host-session";
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** 256-bit random token, URL-safe. Only its hash is ever stored. */
export function newToken(rng: CryptoRng): string {
  return Buffer.from(rng.bytes(32)).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time equality of two hex or text digests. */
export function digestsEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Set-Cookie value for a session: httpOnly, secure and SameSite (Requirement 1.3, design
 * Auth_Service). The `__Host-` prefix forces Secure, Path=/ and no Domain attribute.
 */
export function sessionCookie(token: string, expiresAt: Date, now: Date): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    `Expires=${expiresAt.toUTCString()}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

/** Set-Cookie value that clears the session cookie (sign-out). */
export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
