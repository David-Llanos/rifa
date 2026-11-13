import type { Money } from "@raffle/shared";

/** Jurisdiction code: "CO" or "US-<state>" (for example "US-CA"). */
export type Jurisdiction = string;

export interface TaxRule {
  /** Tax withholding in basis points applied to the prize (0 to 10000). */
  withholdingBps: number;
  /** Reporting period length in days; a report is generated when a period ends. */
  reportingPeriodDays: number;
  /** Reporting form name used for the tax authority data. */
  reportingForm: string;
}

/** Rule content of one jurisdiction rule set (Requirement 12.1). */
export interface RuleSetRules {
  permittedTypes: string[];
  maxPrize: Money;
  requiredLicenses: string[];
  disclosures: string[];
  tax: TaxRule;
  prohibitedOwnerTypes: string[];
}

/** Immutable, versioned rule set (matches the ruleset_version table). */
export interface RuleSetVersion {
  id: string;
  jurisdiction: Jurisdiction;
  effectiveFrom: Date;
  rules: RuleSetRules;
}

/** Maximum prize value allowed in a rule set: 999,999,999.99 in minor units. */
export const MAX_PRIZE_LIMIT_MINOR = 99_999_999_999n;

/** Facts about a raffle that the rule engine evaluates. */
export interface ComplianceSubject {
  jurisdiction: Jurisdiction;
  raffleType: string;
  prizeValue: Money;
  ownerType: string;
}

export type RuleName = "permittedTypes" | "maxPrize" | "prohibitedOwnerTypes";

/** One unmet rule: its name and the configured value that was violated (Requirement 12.4). */
export interface Violation {
  rule: RuleName;
  configured: string | string[];
  actual: string;
}

export const EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;
export const EVIDENCE_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;

export interface EvidenceFile {
  size: number;
  mime: string;
}

/** Evidence the Owner supplied for a publication request. */
export interface Evidence {
  /** Colombia: Coljuegos or territorial authorization number. */
  authorizationNumber?: string;
  /** US: owner declared eligibility under the state's raffle law. */
  eligibilityDeclared?: boolean;
  /** Uploaded documents, keyed by the license they cover (Colombia uses "authorization"). */
  documents: { license: string; file: EvidenceFile }[];
}

export type MissingEvidenceKind =
  | "authorizationNumber"
  | "authorizationDocument"
  | "eligibilityDeclaration"
  | "licenseDocument";

export interface MissingEvidence {
  kind: MissingEvidenceKind;
  license?: string;
}

/** Outcome of evaluating a publication request. */
export type ComplianceDecision = "ok" | "blocked" | "pending_review";

export interface ComplianceReport {
  decision: ComplianceDecision;
  ruleSetVersionId: string;
  violations: Violation[];
  missingEvidence: MissingEvidence[];
  invalidEvidence: { license: string; constraint: string }[];
}

export interface GeoResult {
  /** Resolved jurisdiction from declared location or IP geolocation; null if unresolved. */
  jurisdiction: Jurisdiction | null;
}

export type NotAvailableHere = { code: "not_available_here"; jurisdiction: Jurisdiction | null };

export interface DisclosureItem {
  key: string;
  value: string;
}
