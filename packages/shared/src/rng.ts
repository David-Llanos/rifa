/**
 * Injectable random number source for non-security uses (for example random ticket assignment).
 * `nextInt(maxExclusive)` returns an integer in [0, maxExclusive).
 */
export interface Rng {
  nextInt(maxExclusive: number): number;
}

/** Cryptographically secure random bytes, used for tokens (share tokens, reset links). */
export interface CryptoRng {
  bytes(length: number): Uint8Array;
}

function assertBound(maxExclusive: number): void {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) {
    throw new RangeError("maxExclusive must be a positive safe integer");
  }
}

/** Deterministic seeded RNG (mulberry32) for tests and reproducible simulations. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  const next32 = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  return {
    nextInt(maxExclusive) {
      assertBound(maxExclusive);
      // 53-bit float from two draws avoids modulo bias for bounds up to 2^53.
      const x = (next32() * 2 ** 21 + (next32() >>> 11)) / 2 ** 53;
      return Math.floor(x * maxExclusive);
    },
  };
}

/** Web Crypto backed RNG (available in Node.js 20+ and browsers). */
export function webCryptoRng(): Rng & CryptoRng {
  const c = globalThis.crypto;
  if (!c?.getRandomValues) {
    throw new Error("Web Crypto API is not available");
  }
  const bytes = (length: number): Uint8Array => {
    const out = new Uint8Array(length);
    c.getRandomValues(out);
    return out;
  };
  return {
    bytes,
    nextInt(maxExclusive) {
      assertBound(maxExclusive);
      if (maxExclusive > 2 ** 32) {
        throw new RangeError("maxExclusive must be at most 2^32");
      }
      // Rejection sampling for an unbiased result.
      const limit = Math.floor(2 ** 32 / maxExclusive) * maxExclusive;
      const buf = new Uint32Array(1);
      for (;;) {
        c.getRandomValues(buf);
        const v = buf[0]!;
        if (v < limit) return v % maxExclusive;
      }
    },
  };
}
