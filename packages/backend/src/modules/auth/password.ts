import { hash, verify } from "@node-rs/argon2";
import type { PasswordHasher } from "./register.js";

export interface PasswordVerifier {
  /** True when the password matches the stored hash. Never throws on malformed hashes. */
  verify(storedHash: string, password: string): Promise<boolean>;
}

export interface Argon2Params {
  /** Memory in KiB. */
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

/** OWASP recommended Argon2id minimum: 19 MiB, 2 iterations, 1 lane. */
export const DEFAULT_ARGON2_PARAMS: Argon2Params = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

/**
 * Argon2id hasher (Requirement 1.12). Every hash carries a fresh random salt and the cost
 * parameters in its PHC string, so verification keeps working after the parameters are raised.
 * `@node-rs/argon2` defaults to the Argon2id variant.
 */
export function argon2idHasher(
  params: Argon2Params = DEFAULT_ARGON2_PARAMS,
): PasswordHasher & PasswordVerifier {
  return {
    hash: (password) => hash(password, { ...params }),
    async verify(storedHash, password) {
      try {
        return await verify(storedHash, password);
      } catch {
        return false;
      }
    },
  };
}
