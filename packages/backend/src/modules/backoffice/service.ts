import { err, fieldError, ok, systemClock } from "@raffle/shared";
import type { Clock, FieldError, Result } from "@raffle/shared";
import { authorize, validateReason, REASON_MAX } from "./permissions.js";
import type { AccessError, AdminSession, BackOfficeAction } from "./permissions.js";
import { isCurrencyAmountsConfig, isCustomizationFeesConfig } from "../payment/fees.js";

export type SubjectKind = "raffle" | "owner" | "player";
export type SubjectStatus = "active" | "suspended";

/** Raffle reports must be submitted and delivered to the Back_Office within 5 seconds (Req 15.10). */
export const REPORT_DELIVERY_DEADLINE_MS = 5000;

/** Audit input, structurally compatible with the audit module's `append`. */
export interface BackOfficeAuditEvent {
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  raffleId?: string | null;
  changes?: { field: string; old: unknown; new: unknown }[];
}

/** Implemented by the audit module; appends inside the caller's transaction and fails closed. */
export interface BackOfficeAudit<Tx> {
  append(tx: Tx, event: BackOfficeAuditEvent): Promise<unknown>;
}

/** Decision, reason, Admin identity and timestamp of a Back_Office action (Requirements 19.4, 19.8). */
export interface ActionRecord {
  id: string;
  kind: "raffle_review" | "suspend" | "reinstate";
  subjectKind: SubjectKind;
  subjectId: string;
  decision: string;
  reason: string;
  adminId: string;
  at: Date;
}

export interface ConfigChange {
  id: string;
  key: ConfigKey;
  previous: unknown;
  next: unknown;
  adminId: string;
  at: Date;
}

export interface RetryFailure {
  id: string;
  itemKind: "refund" | "payout";
  itemId: string;
  adminId: string;
  at: Date;
  message: string;
}

export type ReportStatus = "open" | "responded";

export interface RaffleReport {
  id: string;
  raffleId: string;
  reporterId: string;
  reason: string;
  status: ReportStatus;
  response: string | null;
  respondedBy: string | null;
  createdAt: Date;
  respondedAt: Date | null;
}

export interface ReviewQueueItem {
  raffleId: string;
  queuedAt: Date;
}

/** Read-only view of the compliance review queue (Requirement 12.5). */
export interface ReviewQueueSource {
  pending(): readonly ReviewQueueItem[] | Promise<readonly ReviewQueueItem[]>;
  /** Called after a review decision so the raffle leaves the queue. */
  resolved?(raffleId: string): void | Promise<void>;
}

export type PublicationDecision =
  | { ok: true; via: "payment_and_compliance" | "admin_approval" }
  | { ok: false; reason: string };

/** Structurally satisfied by the raffle module's lifecycle service. */
export interface PublicationResolver {
  resolvePublication(
    raffleId: string,
    outcome: PublicationDecision,
  ): Promise<Result<unknown, { kind: string }>>;
}

/** Structurally satisfied by the raffle module's lifecycle service. */
export interface CancellationResolver {
  approveCancellation(
    raffleId: string,
    admin: { id: string; role: "admin" },
  ): Promise<Result<void, { kind: string }>>;
  rejectCancellation(
    raffleId: string,
    admin: { id: string; role: "admin" },
  ): Promise<Result<void, { kind: string }>>;
}

export type FinanceItemKind = "payment" | "refund" | "payout" | "failed_transfer";

export interface FinanceItem {
  id: string;
  kind: FinanceItemKind;
  status: string;
  amountMinor: bigint;
  currency: string;
}

/** Implemented by the payment module; the Back_Office only views and retries. */
export interface FinanceGateway {
  list(kind: FinanceItemKind): Promise<readonly FinanceItem[]>;
  /** A failed retry must leave the item in `failed` status. */
  retry(
    kind: "refund" | "payout",
    id: string,
  ): Promise<{ ok: true } | { ok: false; message: string }>;
}

export const CONFIG_KEYS = [
  "fee.creation_minor",
  "fee.customization_minor",
  "platform_commission_bps",
  "supported_lotteries",
  "jurisdiction_rule_sets",
  "reservation_timeout_seconds",
] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

export function validateConfigValue(key: ConfigKey, value: unknown): FieldError | null {
  const bad = fieldError("value", "invalid", { key });
  switch (key) {
    // Per-currency amounts in minor units; customization fees are priced per option (Req 3.1, 3.5).
    case "fee.creation_minor":
      return isCurrencyAmountsConfig(value) ? null : bad;
    case "fee.customization_minor":
      return isCustomizationFeesConfig(value) ? null : bad;
    case "platform_commission_bps":
      return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 10_000
        ? null
        : bad;
    case "reservation_timeout_seconds":
      return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 86_400
        ? null
        : bad;
    case "supported_lotteries":
      return Array.isArray(value) && value.every((v) => typeof v === "string" && v.length > 0)
        ? null
        : bad;
    case "jurisdiction_rule_sets":
      return value !== null && typeof value === "object" && !Array.isArray(value) ? null : bad;
  }
}

export interface BackOfficeStore<Tx> {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  recordAction(tx: Tx, rec: ActionRecord): Promise<void>;
  /** Null when the subject does not exist. */
  getSubjectStatus(tx: Tx, kind: SubjectKind, id: string): Promise<SubjectStatus | null>;
  setSubjectStatus(tx: Tx, kind: SubjectKind, id: string, status: SubjectStatus): Promise<void>;
  getConfig(tx: Tx, key: ConfigKey): Promise<unknown>;
  /** Applies only to payments initiated after the save (Requirement 3.8 is honored by readers of config). */
  setConfig(tx: Tx, key: ConfigKey, value: unknown): Promise<void>;
  insertConfigChange(tx: Tx, change: ConfigChange): Promise<void>;
  recordRetryFailure(tx: Tx, failure: RetryFailure): Promise<void>;
  insertReport(tx: Tx, report: RaffleReport): Promise<void>;
  listReports(status?: ReportStatus): Promise<readonly RaffleReport[]>;
  findReportForUpdate(tx: Tx, id: string): Promise<RaffleReport | null>;
  updateReport(tx: Tx, report: RaffleReport): Promise<void>;
  raffleExists(raffleId: string): Promise<boolean>;
}

export type BackOfficeError =
  | AccessError
  | { kind: "invalid"; errors: FieldError[]; retainedText?: string }
  | { kind: "not_found" }
  | { kind: "conflict"; current: string }
  | { kind: "retry_failed"; message: string; at: Date }
  | { kind: "lifecycle"; detail: string }
  | { kind: "audit_failed" };

export interface BackOfficeDeps<Tx> {
  store: BackOfficeStore<Tx>;
  audit: BackOfficeAudit<Tx>;
  reviewQueue: ReviewQueueSource;
  publication: PublicationResolver;
  cancellations?: CancellationResolver;
  finance: FinanceGateway;
  newId: () => string;
  clock?: Clock;
}

export interface RaffleReportReceipt {
  reportId: string;
  receivedAt: Date;
}

export interface BackOfficeService {
  reviewQueue(
    session: AdminSession | null,
  ): Promise<Result<readonly ReviewQueueItem[], BackOfficeError>>;
  decideRaffleReview(
    session: AdminSession | null,
    raffleId: string,
    decision: "approve" | "reject",
    reason: string,
  ): Promise<Result<void, BackOfficeError>>;
  suspend(
    session: AdminSession | null,
    kind: SubjectKind,
    id: string,
    reason: string,
  ): Promise<Result<void, BackOfficeError>>;
  reinstate(
    session: AdminSession | null,
    kind: SubjectKind,
    id: string,
    reason: string,
  ): Promise<Result<void, BackOfficeError>>;
  viewFinance(
    session: AdminSession | null,
    kind: FinanceItemKind,
  ): Promise<Result<readonly FinanceItem[], BackOfficeError>>;
  retryFinanceItem(
    session: AdminSession | null,
    kind: "refund" | "payout",
    id: string,
  ): Promise<Result<void, BackOfficeError>>;
  configure(
    session: AdminSession | null,
    key: ConfigKey,
    value: unknown,
  ): Promise<Result<ConfigChange, BackOfficeError>>;
  /** Player-facing: sends a "report this raffle" submission to the Back_Office (Requirements 15.10, 15.11). */
  submitReport(
    reporterId: string,
    raffleId: string,
    reason: string,
  ): Promise<Result<RaffleReportReceipt, BackOfficeError>>;
  reportQueue(
    session: AdminSession | null,
    status?: ReportStatus,
  ): Promise<Result<readonly RaffleReport[], BackOfficeError>>;
  respondToReport(
    session: AdminSession | null,
    reportId: string,
    response: string,
  ): Promise<Result<void, BackOfficeError>>;
  approveCancellation(
    session: AdminSession | null,
    raffleId: string,
  ): Promise<Result<void, BackOfficeError>>;
  rejectCancellation(
    session: AdminSession | null,
    raffleId: string,
  ): Promise<Result<void, BackOfficeError>>;
}

function isAuditFailure(e: unknown): boolean {
  return (
    typeof e === "object" && e !== null && (e as { code?: unknown }).code === "AUDIT_WRITE_FAILED"
  );
}

export function createBackOfficeService<Tx>(deps: BackOfficeDeps<Tx>): BackOfficeService {
  const clock = deps.clock ?? systemClock;
  const { store, audit } = deps;

  /** Runs `fn` in a transaction, mapping an audit write failure to a fail-closed error. */
  async function audited<T>(
    fn: (tx: Tx) => Promise<Result<T, BackOfficeError>>,
  ): Promise<Result<T, BackOfficeError>> {
    try {
      return await store.transaction(fn);
    } catch (e) {
      if (isAuditFailure(e)) return err({ kind: "audit_failed" });
      throw e;
    }
  }

  function gate(session: AdminSession | null, action: BackOfficeAction): BackOfficeError | null {
    return authorize(session, action);
  }

  function reasonError(reason: string, max: 1000 | 500 = REASON_MAX): BackOfficeError | null {
    const e = validateReason(reason, max);
    return e ? { kind: "invalid", errors: [e] } : null;
  }

  async function setSuspension(
    session: AdminSession | null,
    action: "suspend" | "reinstate",
    kind: SubjectKind,
    id: string,
    reason: string,
  ): Promise<Result<void, BackOfficeError>> {
    const denied = gate(session, action);
    if (denied) return err(denied);
    const bad = reasonError(reason);
    if (bad) return err(bad);
    const admin = (session as AdminSession).userId;
    const target: SubjectStatus = action === "suspend" ? "suspended" : "active";
    const now = clock.now();
    return audited(async (tx) => {
      const current = await store.getSubjectStatus(tx, kind, id);
      if (current === null) return err({ kind: "not_found" });
      if (current === target) return err({ kind: "conflict", current });
      await store.setSubjectStatus(tx, kind, id, target);
      await store.recordAction(tx, {
        id: deps.newId(),
        kind: action,
        subjectKind: kind,
        subjectId: id,
        decision: target,
        reason: reason.trim(),
        adminId: admin,
        at: now,
      });
      await audit.append(tx, {
        actor: admin,
        action: `backoffice.${action}`,
        entityType: kind,
        entityId: id,
        raffleId: kind === "raffle" ? id : null,
        changes: [
          { field: "status", old: current, new: target },
          { field: "reason", old: null, new: reason.trim() },
        ],
      });
      return ok(undefined);
    });
  }

  return {
    async reviewQueue(session) {
      const denied = gate(session, "view_review_queue");
      if (denied) return err(denied);
      return ok(await deps.reviewQueue.pending());
    },

    async decideRaffleReview(session, raffleId, decision, reason) {
      const denied = gate(session, "review_raffle");
      if (denied) return err(denied);
      // An invalid reason leaves the raffle in pending_review (Requirement 19.5).
      const bad = reasonError(reason);
      if (bad) return err(bad);
      const admin = (session as AdminSession).userId;
      const text = reason.trim();
      const outcome: PublicationDecision =
        decision === "approve" ? { ok: true, via: "admin_approval" } : { ok: false, reason: text };
      const resolved = await deps.publication.resolvePublication(raffleId, outcome);
      if (!resolved.ok) {
        return err(
          resolved.error.kind === "not_found"
            ? { kind: "not_found" }
            : { kind: "lifecycle", detail: resolved.error.kind },
        );
      }
      const now = clock.now();
      const recorded = await audited(async (tx) => {
        await store.recordAction(tx, {
          id: deps.newId(),
          kind: "raffle_review",
          subjectKind: "raffle",
          subjectId: raffleId,
          decision,
          reason: text,
          adminId: admin,
          at: now,
        });
        await audit.append(tx, {
          actor: admin,
          action: `backoffice.raffle_review_${decision}`,
          entityType: "raffle",
          entityId: raffleId,
          raffleId,
          changes: [
            { field: "decision", old: "pending_review", new: decision },
            { field: "reason", old: null, new: text },
          ],
        });
        return ok(undefined);
      });
      if (recorded.ok) await deps.reviewQueue.resolved?.(raffleId);
      return recorded;
    },

    suspend: (s, kind, id, reason) => setSuspension(s, "suspend", kind, id, reason),
    reinstate: (s, kind, id, reason) => setSuspension(s, "reinstate", kind, id, reason),

    async viewFinance(session, kind) {
      const denied = gate(session, "view_finance");
      if (denied) return err(denied);
      return ok(await deps.finance.list(kind));
    },

    async retryFinanceItem(session, kind, id) {
      const denied = gate(session, kind === "refund" ? "retry_refund" : "retry_payout");
      if (denied) return err(denied);
      const admin = (session as AdminSession).userId;
      const result = await deps.finance.retry(kind, id);
      const at = clock.now();
      return audited(async (tx) => {
        await audit.append(tx, {
          actor: admin,
          action: `backoffice.retry_${kind}`,
          entityType: kind,
          entityId: id,
          changes: [{ field: "retry", old: null, new: result.ok ? "succeeded" : "failed" }],
        });
        if (result.ok) return ok(undefined);
        // The item stays failed; the failure and its timestamp are recorded (Requirement 19.7).
        await store.recordRetryFailure(tx, {
          id: deps.newId(),
          itemKind: kind,
          itemId: id,
          adminId: admin,
          at,
          message: result.message,
        });
        return err({ kind: "retry_failed", message: result.message, at });
      });
    },

    async configure(session, key, value) {
      const denied = gate(session, "configure");
      if (denied) return err(denied);
      const invalid = validateConfigValue(key, value);
      if (invalid) return err({ kind: "invalid", errors: [invalid] });
      const admin = (session as AdminSession).userId;
      const at = clock.now();
      return audited(async (tx) => {
        const previous = await store.getConfig(tx, key);
        const change: ConfigChange = {
          id: deps.newId(),
          key,
          previous: previous ?? null,
          next: value,
          adminId: admin,
          at,
        };
        await store.setConfig(tx, key, value);
        await store.insertConfigChange(tx, change);
        await audit.append(tx, {
          actor: admin,
          action: "backoffice.configure",
          entityType: "config",
          entityId: key,
          changes: [{ field: key, old: previous ?? null, new: value }],
        });
        return ok(change);
      });
    },

    async submitReport(reporterId, raffleId, reason) {
      const bad = reasonError(reason);
      // The entered text is returned so the caller can retain it (Requirement 15.11).
      if (bad && bad.kind === "invalid") return err({ ...bad, retainedText: reason });
      if (!(await store.raffleExists(raffleId))) return err({ kind: "not_found" });
      const receivedAt = clock.now();
      const reportId = deps.newId();
      return audited(async (tx) => {
        await store.insertReport(tx, {
          id: reportId,
          raffleId,
          reporterId,
          reason: reason.trim(),
          status: "open",
          response: null,
          respondedBy: null,
          createdAt: receivedAt,
          respondedAt: null,
        });
        await audit.append(tx, {
          actor: reporterId,
          action: "raffle.reported",
          entityType: "raffle_report",
          entityId: reportId,
          raffleId,
          changes: [{ field: "reason", old: null, new: reason.trim() }],
        });
        return ok({ reportId, receivedAt });
      });
    },

    async reportQueue(session, status) {
      const denied = gate(session, "view_reports");
      if (denied) return err(denied);
      return ok(await store.listReports(status));
    },

    async respondToReport(session, reportId, response) {
      const denied = gate(session, "respond_report");
      if (denied) return err(denied);
      const bad = reasonError(response);
      if (bad) return err(bad);
      const admin = (session as AdminSession).userId;
      const at = clock.now();
      return audited(async (tx) => {
        const report = await store.findReportForUpdate(tx, reportId);
        if (!report) return err({ kind: "not_found" });
        await store.updateReport(tx, {
          ...report,
          status: "responded",
          response: response.trim(),
          respondedBy: admin,
          respondedAt: at,
        });
        await audit.append(tx, {
          actor: admin,
          action: "backoffice.report_response",
          entityType: "raffle_report",
          entityId: reportId,
          raffleId: report.raffleId,
          changes: [{ field: "status", old: report.status, new: "responded" }],
        });
        return ok(undefined);
      });
    },

    async approveCancellation(session, raffleId) {
      const denied = gate(session, "review_raffle");
      if (denied) return err(denied);
      if (!deps.cancellations) return err({ kind: "lifecycle", detail: "unavailable" });
      const r = await deps.cancellations.approveCancellation(raffleId, {
        id: (session as AdminSession).userId,
        role: "admin",
      });
      return r.ok ? ok(undefined) : err({ kind: "lifecycle", detail: r.error.kind });
    },

    async rejectCancellation(session, raffleId) {
      const denied = gate(session, "review_raffle");
      if (denied) return err(denied);
      if (!deps.cancellations) return err({ kind: "lifecycle", detail: "unavailable" });
      const r = await deps.cancellations.rejectCancellation(raffleId, {
        id: (session as AdminSession).userId,
        role: "admin",
      });
      return r.ok ? ok(undefined) : err({ kind: "lifecycle", detail: r.error.kind });
    },
  };
}
