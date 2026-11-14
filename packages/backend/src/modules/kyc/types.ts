export type KycKind = "owner" | "player_age" | "winner";
export type KycStatus = "pending" | "approved" | "rejected" | "error";

export type GovernmentIdType =
  | "cedula_ciudadania"
  | "cedula_extranjeria"
  | "nit"
  | "us_government_id"
  | "ein";

export interface KycDocument {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

/** Input to a KYC attempt. Documents are encrypted before storage and never persisted in the record. */
export interface KycSubmission {
  subjectId: string;
  kind: KycKind;
  legalName: string;
  idType: GovernmentIdType;
  idNumber: string;
  documents: KycDocument[];
}

/** Mirrors the `kyc_record` table: documents are referenced by key only (Requirement 13.9). */
export interface KycRecord {
  id: string;
  subjectId: string;
  kind: KycKind;
  status: KycStatus;
  providerRef: string;
  documentsKeyRef: string;
  attempts: Date[];
  createdAt: Date;
}

export interface KycRepository {
  /** Records for a subject and kind, oldest first. */
  list(subjectId: string, kind: KycKind): KycRecord[];
  save(record: KycRecord): void;
}

export class InMemoryKycRepository implements KycRepository {
  private readonly records = new Map<string, KycRecord>();

  list(subjectId: string, kind: KycKind): KycRecord[] {
    return [...this.records.values()]
      .filter((r) => r.subjectId === subjectId && r.kind === kind)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  save(record: KycRecord): void {
    this.records.set(record.id, record);
  }
}
