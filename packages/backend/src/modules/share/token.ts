import type { CryptoRng } from "@raffle/shared";

/** 16 random bytes = 128 bits of entropy (Requirement 16.1). */
export const SHARE_TOKEN_BYTES = 16;

const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

/**
 * Random share token, base64url without padding (22 characters).
 * Uses only the injected CSPRNG: never derived from the raffle id, title or owner.
 */
export function generateShareToken(rng: CryptoRng): string {
  const bytes = rng.bytes(SHARE_TOKEN_BYTES);
  if (bytes.length !== SHARE_TOKEN_BYTES) {
    throw new RangeError("rng returned the wrong number of bytes");
  }
  return Buffer.from(bytes).toString("base64url");
}

/** Cheap shape check so malformed tokens never reach the database. */
export function isWellFormedShareToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN_RE.test(token);
}

export function shareUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/r/${token}`;
}
