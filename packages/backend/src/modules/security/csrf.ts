import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const CSRF_HEADER_NAME = "x-csrf-token";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** True for methods that change state and therefore need an anti-forgery token (Requirement 15.8). */
export function isStateChanging(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

function sign(secret: string, sessionId: string, nonce: string): string {
  return createHmac("sha256", secret).update(`${sessionId}.${nonce}`).digest("base64url");
}

/** Issue a token bound to the session: `<nonce>.<hmac(secret, sessionId.nonce)>`. */
export function issueCsrfToken(secret: string, sessionId: string): string {
  const nonce = randomBytes(18).toString("base64url");
  return `${nonce}.${sign(secret, sessionId, nonce)}`;
}

/** Constant-time verification that the token was issued for this session. */
export function verifyCsrfToken(
  secret: string,
  sessionId: string | undefined,
  token: string | undefined,
): boolean {
  if (!sessionId || !token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const expected = Buffer.from(sign(secret, sessionId, token.slice(0, dot)));
  const given = Buffer.from(token.slice(dot + 1));
  return expected.length === given.length && timingSafeEqual(expected, given);
}
