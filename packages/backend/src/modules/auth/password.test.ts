import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { argon2idHasher } from "./password.js";
import { totpCode, verifyTotp } from "./totp.js";

// Low cost keeps the property test fast; production uses DEFAULT_ARGON2_PARAMS.
const hasher = argon2idHasher({ memoryCost: 1024, timeCost: 1, parallelism: 1 });

describe("argon2idHasher", () => {
  it("produces salted Argon2id hashes", async () => {
    const a = await hasher.hash("correct horse battery");
    const b = await hasher.hash("correct horse battery");
    expect(a.startsWith("$argon2id$")).toBe(true);
    expect(a).not.toBe(b);
  });

  it("verify returns false for a malformed hash instead of throwing", async () => {
    expect(await hasher.verify("not-a-hash", "whatever password")).toBe(false);
  });

  // Feature: raffle-platform, Property 3: Password hashing round trip
  // **Validates: Requirements 1.12**
  it("property: round trip succeeds, other passwords fail, plaintext not stored", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 12, maxLength: 128 }),
        fc.string({ minLength: 12, maxLength: 128 }),
        async (pw, other) => {
          const h = await hasher.hash(pw);
          expect(await hasher.verify(h, pw)).toBe(true);
          if (other !== pw) expect(await hasher.verify(h, other)).toBe(false);
          expect(h.includes(pw)).toBe(false);
        },
      ),
      { numRuns: 25 },
    );
  });
});

describe("totp", () => {
  const secret = new TextEncoder().encode("12345678901234567890");
  it("matches the RFC 6238 SHA-1 test vector", () => {
    expect(totpCode(secret, new Date(59_000))).toBe("287082");
    expect(totpCode(secret, new Date(1111111109_000))).toBe("081804");
  });
  it("accepts one step of drift and rejects others", () => {
    const now = new Date(1111111109_000);
    expect(verifyTotp(secret, totpCode(secret, now, -1), now)).toBe(true);
    expect(verifyTotp(secret, totpCode(secret, now, 2), now)).toBe(false);
    expect(verifyTotp(secret, "12345", now)).toBe(false);
  });
});
