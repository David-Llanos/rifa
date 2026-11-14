import { randomUUID } from "node:crypto";
import type { EncryptionPort } from "./encryption.js";
import type { KycDocument } from "./types.js";

/** Only authorized Admins and the KYC provider may read documents (Requirement 13.9). */
export type KycActor = { role: "admin" } | { role: "kyc_provider" } | { role: string };

export class KycAccessDenied extends Error {
  constructor() {
    super("access to KYC documents denied");
    this.name = "KycAccessDenied";
  }
}

/** Raw object storage port; implementations only ever see ciphertext. */
export interface BlobStore {
  put(key: string, sealed: Uint8Array): void;
  get(key: string): Uint8Array | undefined;
}

export class InMemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();
  put(key: string, sealed: Uint8Array): void {
    this.blobs.set(key, sealed);
  }
  get(key: string): Uint8Array | undefined {
    return this.blobs.get(key);
  }
}

/** Encrypted document storage. Each object gets its own key reference. */
export class KycDocumentStore {
  constructor(
    private readonly blobs: BlobStore,
    private readonly crypto: EncryptionPort,
  ) {}

  /** Encrypts and stores a document, returning the key reference kept in `kyc_record`. */
  put(subjectId: string, doc: KycDocument): string {
    const keyRef = `kyc/${subjectId}/${randomUUID()}`;
    this.blobs.put(keyRef, this.crypto.encrypt(doc.bytes));
    return keyRef;
  }

  get(keyRef: string, actor: KycActor): Uint8Array {
    if (actor.role !== "admin" && actor.role !== "kyc_provider") throw new KycAccessDenied();
    const sealed = this.blobs.get(keyRef);
    if (!sealed) throw new Error("document not found");
    return this.crypto.decrypt(sealed);
  }
}
