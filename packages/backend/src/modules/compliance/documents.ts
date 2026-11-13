import type { Clock } from "@raffle/shared";

export const DOC_MAX_RETRIES = 3;
export const DOC_RETRY_INTERVAL_MS = 5 * 60 * 1000;
/** Documents must be available for download within 60 seconds (Requirement 12.9). */
export const DOC_GENERATION_DEADLINE_MS = 60 * 1000;

export type DocumentKind = "payout_summary" | "tax_report";
export type DocumentStatus = "pending" | "generated" | "failed";

export interface ComplianceDocument {
  id: string;
  kind: DocumentKind;
  raffleId: string;
  requestedAt: Date;
  status: DocumentStatus;
  /** Generation attempts made so far (the first attempt is not a retry). */
  attempts: number;
  nextRetryAt: Date | null;
  generatedAt: Date | null;
  lastError: string | null;
}

export type DocumentGenerator = (doc: ComplianceDocument) => Promise<void>;
export type AdminNotifier = (doc: ComplianceDocument, error: string) => void;

/**
 * Tax and reporting document generation (Requirements 12.9, 12.10). A failed generation marks the
 * document failed, notifies an Admin, and retries up to 3 times at 5-minute intervals.
 */
export class DocumentService {
  private readonly docs = new Map<string, ComplianceDocument>();

  constructor(
    private readonly clock: Clock,
    private readonly generate: DocumentGenerator,
    private readonly notifyAdmin: AdminNotifier,
  ) {}

  get(id: string): ComplianceDocument | undefined {
    return this.docs.get(id);
  }

  /** Request a document and run the first generation attempt. */
  async request(id: string, kind: DocumentKind, raffleId: string): Promise<ComplianceDocument> {
    const doc: ComplianceDocument = {
      id,
      kind,
      raffleId,
      requestedAt: this.clock.now(),
      status: "pending",
      attempts: 0,
      nextRetryAt: null,
      generatedAt: null,
      lastError: null,
    };
    this.docs.set(id, doc);
    await this.attempt(doc);
    return doc;
  }

  /** Run every retry whose time has come. Returns the ids attempted. */
  async runDueRetries(): Promise<string[]> {
    const now = this.clock.now().getTime();
    const due = [...this.docs.values()].filter(
      (d) => d.status === "failed" && d.nextRetryAt !== null && d.nextRetryAt.getTime() <= now,
    );
    for (const d of due) await this.attempt(d);
    return due.map((d) => d.id);
  }

  private async attempt(doc: ComplianceDocument): Promise<void> {
    doc.attempts += 1;
    doc.nextRetryAt = null;
    try {
      await this.generate(doc);
      doc.status = "generated";
      doc.generatedAt = this.clock.now();
      doc.lastError = null;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      doc.status = "failed";
      doc.lastError = message;
      // attempts includes the first try, so retries used = attempts - 1.
      if (doc.attempts - 1 < DOC_MAX_RETRIES) {
        doc.nextRetryAt = new Date(this.clock.now().getTime() + DOC_RETRY_INTERVAL_MS);
      }
      this.notifyAdmin(doc, message);
    }
  }
}
