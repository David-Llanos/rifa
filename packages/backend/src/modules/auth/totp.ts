import { createHmac, timingSafeEqual } from "node:crypto";

const STEP_SECONDS = 30;
const DIGITS = 6;

/** RFC 6238 TOTP (HMAC-SHA1, 30 s step, 6 digits) code for a raw secret at an instant. */
export function totpCode(secret: Uint8Array, at: Date, stepOffset = 0): string {
  const counter = Math.floor(at.getTime() / 1000 / STEP_SECONDS) + stepOffset;
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.max(counter, 0)));
  const h = createHmac("sha1", secret).update(msg).digest();
  const o = h[h.length - 1]! & 0x0f;
  const bin = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(bin % 10 ** DIGITS).padStart(DIGITS, "0");
}

/** Accepts the current code and one step either side to tolerate clock drift. */
export function verifyTotp(secret: Uint8Array, code: string, at: Date): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const given = Buffer.from(code);
  let match = false;
  for (const off of [-1, 0, 1]) {
    const expected = Buffer.from(totpCode(secret, at, off));
    if (timingSafeEqual(expected, given)) match = true;
  }
  return match;
}
