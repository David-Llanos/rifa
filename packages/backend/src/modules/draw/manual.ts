/** Two-person rule for manual draw results (Requirements 19.11, 19.12). */

export type ManualDecision = "approve" | "reject";

export type ManualDecisionOutcome =
  /** A different Admin approved: the result is applied. */
  | "apply"
  /** A different Admin rejected: the result is not applied. */
  | "rejected"
  /** The entering Admin tried to decide their own result: nothing changes. */
  | "denied_self";

/** The result is applied only when an Admin other than the enterer approves. */
export function decideManualResult(
  enteredBy: string,
  decidedBy: string,
  decision: ManualDecision,
): ManualDecisionOutcome {
  if (enteredBy === decidedBy) return "denied_self";
  return decision === "approve" ? "apply" : "rejected";
}
