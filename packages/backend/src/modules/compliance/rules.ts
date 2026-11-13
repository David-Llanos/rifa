import { err, fieldError, ok } from "@raffle/shared";
import type { FieldError, Result } from "@raffle/shared";
import {
  EVIDENCE_MAX_BYTES,
  EVIDENCE_MIME_TYPES,
  MAX_PRIZE_LIMIT_MINOR,
  type ComplianceDecision,
  type ComplianceReport,
  type ComplianceSubject,
  type DisclosureItem,
  type Evidence,
  type EvidenceFile,
  type GeoResult,
  type Jurisdiction,
  type MissingEvidence,
  type NotAvailableHere,
  type RuleSetRules,
  type RuleSetVersion,
  type Violation,
} from "./types.js";

const fmtMoney = (m: { amountMinor: bigint; currency: string }): string =>
  `${m.amountMinor.toString()} ${m.currency} (minor units)`;

/**
 * Evaluate a raffle against a rule set. Returns one violation per unmet rule, naming the rule
 * and the configured value; an empty array means compliant (Requirements 12.1, 12.4).
 */
export function evaluateRules(subject: ComplianceSubject, rules: RuleSetRules): Violation[] {
  const out: Violation[] = [];
  if (!rules.permittedTypes.includes(subject.raffleType)) {
    out.push({
      rule: "permittedTypes",
      configured: [...rules.permittedTypes],
      actual: subject.raffleType,
    });
  }
  if (
    subject.prizeValue.currency !== rules.maxPrize.currency ||
    subject.prizeValue.amountMinor > rules.maxPrize.amountMinor
  ) {
    out.push({
      rule: "maxPrize",
      configured: fmtMoney(rules.maxPrize),
      actual: fmtMoney(subject.prizeValue),
    });
  }
  if (rules.prohibitedOwnerTypes.includes(subject.ownerType)) {
    out.push({
      rule: "prohibitedOwnerTypes",
      configured: [...rules.prohibitedOwnerTypes],
      actual: subject.ownerType,
    });
  }
  return out;
}

/** Evidence file check: at most 10 MB, PDF, JPG or PNG (Requirements 12.2, 12.3). */
export function validateEvidenceFile(f: EvidenceFile): FieldError | null {
  if (!Number.isFinite(f.size) || f.size <= 0) return fieldError("file", "required");
  if (f.size > EVIDENCE_MAX_BYTES) {
    return fieldError("file", "size", { maxBytes: EVIDENCE_MAX_BYTES });
  }
  if (!(EVIDENCE_MIME_TYPES as readonly string[]).includes(f.mime.toLowerCase())) {
    return fieldError("file", "format", { allowed: "PDF, JPG, PNG" });
  }
  return null;
}

/** Validate that a rule set's configuration is well formed (Requirement 12.1). */
export function validateRuleSet(rules: RuleSetRules): FieldError[] {
  const e: FieldError[] = [];
  const max = rules.maxPrize.amountMinor;
  if (max <= 0n || max > MAX_PRIZE_LIMIT_MINOR) {
    e.push(fieldError("maxPrize", "range", { max: MAX_PRIZE_LIMIT_MINOR.toString() }));
  }
  if (rules.permittedTypes.length === 0) e.push(fieldError("permittedTypes", "required"));
  if (rules.tax.withholdingBps < 0 || rules.tax.withholdingBps > 10_000) {
    e.push(fieldError("tax.withholdingBps", "range", { min: 0, max: 10_000 }));
  }
  if (!Number.isInteger(rules.tax.reportingPeriodDays) || rules.tax.reportingPeriodDays < 1) {
    e.push(fieldError("tax.reportingPeriodDays", "positive"));
  }
  return e;
}

/** Whole years of age on a given date (Requirement 13.4). */
export function ageOn(dob: Date, on: Date): number {
  let age = on.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday =
    on.getUTCMonth() < dob.getUTCMonth() ||
    (on.getUTCMonth() === dob.getUTCMonth() && on.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

export const isColombia = (j: Jurisdiction): boolean => j === "CO";

/**
 * Required evidence that is missing, and supplied evidence that is invalid.
 * Colombia (12.2): authorization number plus one document. US state (12.3): eligibility
 * declaration plus a document for each license in the rule set.
 */
export function assessEvidence(
  jurisdiction: Jurisdiction,
  rules: RuleSetRules,
  evidence: Evidence,
): { missing: MissingEvidence[]; invalid: { license: string; constraint: string }[] } {
  const missing: MissingEvidence[] = [];
  const invalid: { license: string; constraint: string }[] = [];
  const docFor = (license: string) => evidence.documents.find((d) => d.license === license);

  const check = (license: string, kind: MissingEvidence["kind"]): void => {
    const doc = docFor(license);
    if (!doc) {
      missing.push({ kind, license });
      return;
    }
    const bad = validateEvidenceFile(doc.file);
    if (bad) invalid.push({ license, constraint: bad.constraint });
  };

  if (isColombia(jurisdiction)) {
    if (!evidence.authorizationNumber || evidence.authorizationNumber.trim() === "") {
      missing.push({ kind: "authorizationNumber" });
    }
    check("authorization", "authorizationDocument");
  } else {
    if (evidence.eligibilityDeclared !== true) missing.push({ kind: "eligibilityDeclaration" });
    for (const license of rules.requiredLicenses) check(license, "licenseDocument");
  }
  return { missing, invalid };
}

/**
 * Evaluate a publication request. Violations block publication (12.4); otherwise missing or
 * invalid evidence queues the raffle as pending_review (12.5); else compliance is OK.
 */
export function evaluateCompliance(
  subject: ComplianceSubject,
  rule: RuleSetVersion,
  evidence: Evidence,
): ComplianceReport {
  const violations = evaluateRules(subject, rule.rules);
  const { missing, invalid } = assessEvidence(subject.jurisdiction, rule.rules, evidence);
  let decision: ComplianceDecision = "ok";
  if (violations.length > 0) decision = "blocked";
  else if (missing.length > 0 || invalid.length > 0) decision = "pending_review";
  return {
    decision,
    ruleSetVersionId: rule.id,
    violations,
    missingEvidence: missing,
    invalidEvidence: invalid,
  };
}

/**
 * Purchase location gating (Requirement 12.7). Rejects when the resolved location is not one of
 * the jurisdictions enabled for the raffle, or cannot be resolved.
 */
export function checkPurchaseLocation(
  enabledForRaffle: readonly Jurisdiction[],
  location: GeoResult,
): Result<void, NotAvailableHere> {
  const j = location.jurisdiction;
  if (j !== null && enabledForRaffle.includes(j)) return ok(undefined);
  return err({ code: "not_available_here", jurisdiction: j });
}

/**
 * Disclosures for the Share_Page (Requirement 12.6): the minimum set plus the rule set's own.
 */
export function requiredDisclosures(
  rules: RuleSetRules,
  facts: {
    ownerIdentity: string;
    licenseNumber: string;
    prizeDescription: string;
    drawMethod: string;
  },
): DisclosureItem[] {
  const base: DisclosureItem[] = [
    { key: "ownerIdentity", value: facts.ownerIdentity },
    { key: "licenseNumber", value: facts.licenseNumber },
    { key: "prizeDescription", value: facts.prizeDescription },
    { key: "drawMethod", value: facts.drawMethod },
  ];
  const seen = new Set(base.map((b) => b.key));
  for (const d of rules.disclosures) {
    if (!seen.has(d)) base.push({ key: d, value: "" });
  }
  return base;
}
