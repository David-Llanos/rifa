import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Encryption port for KYC documents at rest (Requirement 13.9). */
export interface EncryptionPort {
  encrypt(plain: Uint8Array): Uint8Array;
  decrypt(sealed: Uint8Array): Uint8Array;
}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** AES-256-GCM. Layout of the sealed value: iv (12) | auth tag (16) | ciphertext. */
export class AesGcmEncryption implements EncryptionPort {
  private readonly key: Buffer;

  constructor(key: Uint8Array) {
    if (key.length !== KEY_BYTES) throw new Error("KYC encryption key must be 32 bytes");
    this.key = Buffer.from(key);
  }

  /** Reads a base64 32-byte key from configuration. Throws when it is missing or malformed. */
  static fromEnv(
    env: Record<string, string | undefined>,
    name = "KYC_ENCRYPTION_KEY",
  ): AesGcmEncryption {
    const raw = env[name];
    if (!raw) throw new Error(`${name} is not configured`);
    return new AesGcmEncryption(Buffer.from(raw, "base64"));
  }

  encrypt(plain: Uint8Array): Uint8Array {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]);
  }

  decrypt(sealed: Uint8Array): Uint8Array {
    if (sealed.length < IV_BYTES + TAG_BYTES) throw new Error("sealed value too short");
    const buf = Buffer.from(sealed);
    const decipher = createDecipheriv("aes-256-gcm", this.key, buf.subarray(0, IV_BYTES));
    decipher.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(buf.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
  }
}
