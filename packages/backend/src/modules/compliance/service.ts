import type { Clock } from "@raffle/shared";
import { evaluateCompliance } from "./rules.js";
import type { RuleSetRegistry } from "./registry.js";
import type { ComplianceReport, ComplianceSubject, Evidence } from "./types.js";

/** Queueing must complete within 5 seconds of the status change (Requirement 12.5). */
export const REVIEW_QUEUE_DEADLINE_MS = 5000;

export interface ReviewQueueEntry {
  raffleId: string;
  queuedAt: Date;
  reasons: ComplianceReport["missingEvidence"];
}

export interface ReviewQueue {
  add(entry: ReviewQueueEntry): void;
}

export class InMemoryReviewQueue implements ReviewQueue {
  readonly entries: ReviewQueueEntry[] = [];
  add(entry: ReviewQueueEntry): void {
    if (!this.entries.some((e) => e.raffleId === entry.raffleId)) this.entries.push(entry);
  }
}

export type PublicationOutcome =
  | { status: "ok"; report: ComplianceReport }
  | { status: "blocked"; report: ComplianceReport }
  | { status: "pending_review"; report: ComplianceReport }
  | { status: "no_rule_set" };

/**
 * Publication-time compliance check. Evaluates against the rule set snapshot stored on the raffle
 * (never the latest rules), blocks on violations, and queues for Admin review when evidence is
 * missing or invalid. A blocked result changes nothing, so the Owner's data and the raffle's
 * current non-published status are retained (Requirement 12.4).
 */
export class ComplianceService {
  constructor(
    private readonly registry: RuleSetRegistry,
    private readonly queue: ReviewQueue,
    private readonly clock: Clock,
  ) {}

  requestPublication(
    raffleId: string,
    ruleSetVersionId: string,
    subject: ComplianceSubject,
    evidence: Evidence,
  ): PublicationOutcome {
    const version = this.registry.getById(ruleSetVersionId);
    if (!version) return { status: "no_rule_set" };
    const report = evaluateCompliance(subject, version, evidence);
    if (report.decision === "pending_review") {
      this.queue.add({
        raffleId,
        queuedAt: this.clock.now(),
        reasons: report.missingEvidence,
      });
    }
    return { status: report.decision, report };
  }
}
