import { randomUUID } from "node:crypto";
import type { Clock, Money } from "@raffle/shared";
import { callProvider, KYC_PROVIDER_TIMEOUT_MS, type KycProvider } from "./adapter.js";
import {
  KYC_ATTEMPT_WINDOW_MS,
  KYC_MAX_ATTEMPTS,
  kycAttemptAllowed,
  winnerDeliveryDecision,
  winnerVerificationRequired,
  type DeliveryDecision,
} from "./rules.js";
import type { KycDocumentStore } from "./storage.js";
import type { KycKind, KycRecord, KycRepository, KycStatus, KycSubmission } from "./types.js";

/** Timeouts and provider failures are stored as `error` (Requirement 13.3). */
function recordStatus(outcome: "approved" | "rejected" | "timeout" | "unavailable"): KycStatus {
  if (outcome === "approved" || outcome === "rejected") return outcome;
  return "error";
}

export type KycAttemptResult =
  | { status: "approved"; recordId: string }
  | { status: "rejected"; recordId: string; reason: string; retriesRemaining: number }
  /** Provider did not answer within 30 s or is unavailable; the subject may retry (Req 13.3). */
  | {
      status: "error";
      recordId: string;
      reason: "timeout" | "unavailable";
      retriesRemaining: number;
    }
  | { status: "rate_limited"; retriesRemaining: 0 };

export interface WinnerOutstandingNotice {
  playerId: string;
  reason: "rejected" | "overdue";
}

export interface KycServiceOptions {
  providerTimeoutMs?: number;
  /** Notifies the Player and an Admin that winner verification is outstanding (Req 13.8). */
  notifyWinnerOutstanding?: (notice: WinnerOutstandingNotice) => void;
}

export class KycService {
  constructor(
    private readonly repo: KycRepository,
    private readonly store: KycDocumentStore,
    private readonly provider: KycProvider,
    private readonly clock: Clock,
    private readonly options: KycServiceOptions = {},
  ) {}

  /** Owner KYC attempt (Requirements 13.1 to 13.3). */
  submitOwnerKyc(submission: KycSubmission): Promise<KycAttemptResult> {
    return this.attempt({ ...submission, kind: "owner" });
  }

  /** Document-based age verification for Players where a Jurisdiction rule requires it (Req 13.6). */
  submitAgeVerification(submission: KycSubmission): Promise<KycAttemptResult> {
    return this.attempt({ ...submission, kind: "player_age" });
  }

  /** Winner identity verification attempt (Req 13.7). */
  submitWinnerKyc(submission: KycSubmission): Promise<KycAttemptResult> {
    return this.attempt({ ...submission, kind: "winner" });
  }

  /** Raffle publication requires an approved Owner KYC (Req 13.1 to 13.3). */
  ownerMayPublish(ownerId: string): boolean {
    return this.latest(ownerId, "owner")?.status === "approved";
  }

  /** The first Ticket purchase is blocked until approval where document-based age check applies. */
  playerMayPurchase(playerId: string, documentAgeRequired: boolean): boolean {
    if (!documentAgeRequired) return true;
    return this.latest(playerId, "player_age")?.status === "approved";
  }

  winnerVerificationRequired(prize: Money, threshold: Money): boolean {
    return winnerVerificationRequired(prize, threshold);
  }

  /**
   * Whether the Owner may be told to deliver the prize. Withholds when verification was rejected
   * or not completed within 30 days of the draw, and notifies the Player and an Admin (Req 13.7, 13.8).
   */
  winnerDelivery(playerId: string, drawAt: Date): DeliveryDecision {
    const status = this.latest(playerId, "winner")?.status ?? "none";
    const decision = winnerDeliveryDecision(status, drawAt, this.clock.now());
    if (decision.action === "withhold") {
      this.options.notifyWinnerOutstanding?.({ playerId, reason: decision.reason });
    }
    return decision;
  }

  private latest(subjectId: string, kind: KycKind): KycRecord | undefined {
    const all = this.repo.list(subjectId, kind);
    return all[all.length - 1];
  }

  private async attempt(sub: KycSubmission): Promise<KycAttemptResult> {
    const now = this.clock.now();
    const prior = this.repo.list(sub.subjectId, sub.kind);
    const attempts = prior.flatMap((r) => r.attempts);
    if (!kycAttemptAllowed(attempts, now)) return { status: "rate_limited", retriesRemaining: 0 };

    const keys = sub.documents.map((d) => this.store.put(sub.subjectId, d));
    const outcome = await callProvider(
      this.provider,
      {
        subjectId: sub.subjectId,
        kind: sub.kind,
        legalName: sub.legalName,
        idType: sub.idType,
        idNumber: sub.idNumber,
        documents: sub.documents,
      },
      this.options.providerTimeoutMs ?? KYC_PROVIDER_TIMEOUT_MS,
    );

    const windowStart = now.getTime() - KYC_ATTEMPT_WINDOW_MS;
    const inWindow = [...attempts, now].filter((a) => a.getTime() > windowStart).length;
    const retriesRemaining = Math.max(0, KYC_MAX_ATTEMPTS - inWindow);
    const record: KycRecord = {
      id: randomUUID(),
      subjectId: sub.subjectId,
      kind: sub.kind,
      status: recordStatus(outcome.status),
      providerRef: "providerRef" in outcome ? outcome.providerRef : "",
      documentsKeyRef: keys.join(","),
      attempts: [...attempts, now],
      createdAt: now,
    };
    this.repo.save(record);

    switch (outcome.status) {
      case "approved":
        return { status: "approved", recordId: record.id };
      case "rejected":
        return {
          status: "rejected",
          recordId: record.id,
          reason: outcome.reason,
          retriesRemaining,
        };
      default:
        return {
          status: "error",
          recordId: record.id,
          reason: outcome.status,
          retriesRemaining,
        };
    }
  }
}
