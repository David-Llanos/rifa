import { describe, expect, it } from "vitest";
import { err, manualClock, ok } from "@raffle/shared";
import {
  authorize,
  can,
  createBackOfficeService,
  validateReason,
  validateRoleAssignment,
  type ActionRecord,
  type AdminSession,
  type BackOfficeAudit,
  type BackOfficeStore,
  type ConfigChange,
  type ConfigKey,
  type FinanceGateway,
  type PublicationDecision,
  type RaffleReport,
  type RetryFailure,
  type SubjectKind,
  type SubjectStatus,
} from "./index.js";

const NOW = new Date("2025-01-01T00:00:00Z");

function session(roles: string[], mfaCompleted = true): AdminSession {
  return { userId: "admin-1", roles, mfaCompleted };
}

function setup(opts: { auditFails?: boolean; retryOk?: boolean } = {}) {
  const actions: ActionRecord[] = [];
  const changes: ConfigChange[] = [];
  const failures: RetryFailure[] = [];
  const reports = new Map<string, RaffleReport>();
  const config = new Map<ConfigKey, unknown>();
  const subjects = new Map<string, SubjectStatus>([["raffle:r1", "active"]]);
  const auditLog: string[] = [];
  const resolutions: { raffleId: string; outcome: PublicationDecision }[] = [];
  let pendingReview = true;

  const store: BackOfficeStore<object> = {
    // Snapshot-and-restore gives rollback semantics like a real transaction.
    async transaction(fn) {
      const snap = {
        a: [...actions],
        c: [...changes],
        f: [...failures],
        r: new Map(reports),
        cfg: new Map(config),
        s: new Map(subjects),
        l: [...auditLog],
      };
      try {
        return await fn({});
      } catch (e) {
        actions.splice(0, actions.length, ...snap.a);
        changes.splice(0, changes.length, ...snap.c);
        failures.splice(0, failures.length, ...snap.f);
        reports.clear();
        snap.r.forEach((v, k) => reports.set(k, v));
        config.clear();
        snap.cfg.forEach((v, k) => config.set(k, v));
        subjects.clear();
        snap.s.forEach((v, k) => subjects.set(k, v));
        auditLog.splice(0, auditLog.length, ...snap.l);
        throw e;
      }
    },
    async recordAction(_tx, rec) {
      actions.push(rec);
    },
    async getSubjectStatus(_tx, kind: SubjectKind, id) {
      return subjects.get(`${kind}:${id}`) ?? null;
    },
    async setSubjectStatus(_tx, kind, id, status) {
      subjects.set(`${kind}:${id}`, status);
    },
    async getConfig(_tx, key) {
      return config.get(key);
    },
    async setConfig(_tx, key, value) {
      config.set(key, value);
    },
    async insertConfigChange(_tx, c) {
      changes.push(c);
    },
    async recordRetryFailure(_tx, f) {
      failures.push(f);
    },
    async insertReport(_tx, r) {
      reports.set(r.id, r);
    },
    async listReports() {
      return [...reports.values()];
    },
    async findReportForUpdate(_tx, id) {
      return reports.get(id) ?? null;
    },
    async updateReport(_tx, r) {
      reports.set(r.id, r);
    },
    async raffleExists(id) {
      return id === "r1";
    },
  };

  const audit: BackOfficeAudit<object> = {
    async append(_tx, e) {
      if (opts.auditFails) {
        throw Object.assign(new Error("audit down"), { code: "AUDIT_WRITE_FAILED" });
      }
      auditLog.push(e.action);
    },
  };

  const finance: FinanceGateway = {
    async list() {
      return [];
    },
    async retry() {
      return opts.retryOk ? { ok: true } : { ok: false, message: "provider down" };
    },
  };

  let n = 0;
  const svc = createBackOfficeService({
    store,
    audit,
    reviewQueue: { pending: () => [{ raffleId: "r1", queuedAt: NOW }] },
    publication: {
      async resolvePublication(raffleId, outcome) {
        if (!pendingReview) return err({ kind: "illegal_transition" });
        resolutions.push({ raffleId, outcome });
        pendingReview = false;
        return ok(undefined);
      },
    },
    finance,
    newId: () => `id-${++n}`,
    clock: manualClock(NOW),
  });
  return { svc, actions, changes, failures, reports, config, subjects, auditLog, resolutions };
}

describe("roles and gate", () => {
  it("grants actions by role and denies others", () => {
    expect(can(["finance"], "retry_refund")).toBe(true);
    expect(can(["finance"], "review_raffle")).toBe(false);
    expect(can(["compliance"], "review_raffle")).toBe(true);
    expect(can(["support"], "configure")).toBe(false);
    expect(can(["super_admin"], "configure")).toBe(true);
    expect(can(["player"], "view_reports")).toBe(false);
  });

  it("combines permissions from multiple roles", () => {
    expect(can(["support", "finance"], "retry_payout")).toBe(true);
  });

  it("denies access without MFA, session or admin role", () => {
    expect(authorize(null, "view_reports")).toEqual({ kind: "access_denied" });
    expect(authorize(session(["support"], false), "view_reports")).toEqual({
      kind: "access_denied",
    });
    expect(authorize(session(["player"]), "view_reports")).toEqual({ kind: "access_denied" });
    expect(authorize(session(["support"]), "configure")).toEqual({
      kind: "insufficient_permissions",
    });
    expect(authorize(session(["support"]), "view_reports")).toBeNull();
  });

  it("requires at least one valid role per Admin", () => {
    expect(validateRoleAssignment([])).not.toBeNull();
    expect(validateRoleAssignment(["finance"])).toBeNull();
  });

  it("validates reasons of 1 to 1000 characters", () => {
    expect(validateReason("", 1000)).not.toBeNull();
    expect(validateReason("   ", 1000)).not.toBeNull();
    expect(validateReason("x".repeat(1000), 1000)).toBeNull();
    expect(validateReason("x".repeat(1001), 1000)).not.toBeNull();
  });
});

describe("raffle review", () => {
  it("approves with a reason, records the decision and audits it", async () => {
    const t = setup();
    const r = await t.svc.decideRaffleReview(session(["compliance"]), "r1", "approve", " ok ");
    expect(r.ok).toBe(true);
    expect(t.resolutions[0]?.outcome).toEqual({ ok: true, via: "admin_approval" });
    expect(t.actions[0]).toMatchObject({
      decision: "approve",
      reason: "ok",
      adminId: "admin-1",
      at: NOW,
    });
    expect(t.auditLog).toEqual(["backoffice.raffle_review_approve"]);
  });

  it("rejects with the reason passed to the lifecycle", async () => {
    const t = setup();
    await t.svc.decideRaffleReview(session(["compliance"]), "r1", "reject", "missing license");
    expect(t.resolutions[0]?.outcome).toEqual({ ok: false, reason: "missing license" });
  });

  it("rejects empty or over-long reasons and leaves the raffle pending", async () => {
    const t = setup();
    for (const reason of ["", "x".repeat(1001)]) {
      const r = await t.svc.decideRaffleReview(session(["compliance"]), "r1", "approve", reason);
      expect(r.ok).toBe(false);
    }
    expect(t.resolutions).toHaveLength(0);
    expect(t.actions).toHaveLength(0);
  });

  it("denies Finance and unauthenticated callers without side effects", async () => {
    const t = setup();
    const a = await t.svc.decideRaffleReview(session(["finance"]), "r1", "approve", "ok");
    const b = await t.svc.decideRaffleReview(session(["compliance"], false), "r1", "approve", "ok");
    expect(a).toEqual(err({ kind: "insufficient_permissions" }));
    expect(b).toEqual(err({ kind: "access_denied" }));
    expect(t.resolutions).toHaveLength(0);
  });

  it("lists the review queue only for permitted roles", async () => {
    const t = setup();
    expect((await t.svc.reviewQueue(session(["compliance"]))).ok).toBe(true);
    expect((await t.svc.reviewQueue(session(["support"]))).ok).toBe(false);
  });
});

describe("suspension and reinstatement", () => {
  it("suspends and reinstates with recorded reason", async () => {
    const t = setup();
    expect((await t.svc.suspend(session(["compliance"]), "raffle", "r1", "fraud")).ok).toBe(true);
    expect(t.subjects.get("raffle:r1")).toBe("suspended");
    expect((await t.svc.suspend(session(["compliance"]), "raffle", "r1", "again")).ok).toBe(false);
    expect((await t.svc.reinstate(session(["super_admin"]), "raffle", "r1", "cleared")).ok).toBe(
      true,
    );
    expect(t.subjects.get("raffle:r1")).toBe("active");
    expect(t.actions.map((a) => a.kind)).toEqual(["suspend", "reinstate"]);
  });

  it("requires a valid reason and an existing subject", async () => {
    const t = setup();
    expect((await t.svc.suspend(session(["compliance"]), "raffle", "r1", "")).ok).toBe(false);
    expect(await t.svc.suspend(session(["compliance"]), "player", "nobody", "x")).toEqual(
      err({ kind: "not_found" }),
    );
    expect(t.subjects.get("raffle:r1")).toBe("active");
  });

  it("fails closed when the audit write fails", async () => {
    const t = setup({ auditFails: true });
    const r = await t.svc.suspend(session(["compliance"]), "raffle", "r1", "fraud");
    expect(r).toEqual(err({ kind: "audit_failed" }));
    expect(t.subjects.get("raffle:r1")).toBe("active");
    expect(t.actions).toHaveLength(0);
  });
});

describe("finance retries", () => {
  it("records a failed retry with its timestamp and returns an error", async () => {
    const t = setup();
    const r = await t.svc.retryFinanceItem(session(["finance"]), "refund", "ref-1");
    expect(r).toEqual(err({ kind: "retry_failed", message: "provider down", at: NOW }));
    expect(t.failures[0]).toMatchObject({ itemKind: "refund", itemId: "ref-1", at: NOW });
  });

  it("succeeds when the gateway succeeds and denies non-Finance roles", async () => {
    const t = setup({ retryOk: true });
    expect((await t.svc.retryFinanceItem(session(["finance"]), "payout", "p1")).ok).toBe(true);
    expect((await t.svc.retryFinanceItem(session(["support"]), "payout", "p1")).ok).toBe(false);
    expect(t.failures).toHaveLength(0);
  });
});

describe("configuration", () => {
  it("records previous and new values with Admin identity and timestamp", async () => {
    const t = setup();
    const s = session(["super_admin"]);
    await t.svc.configure(s, "platform_commission_bps", 500);
    await t.svc.configure(s, "platform_commission_bps", 700);
    expect(t.config.get("platform_commission_bps")).toBe(700);
    expect(t.changes[1]).toMatchObject({
      previous: 500,
      next: 700,
      adminId: "admin-1",
      at: NOW,
    });
  });

  it("is Super Admin only and validates values", async () => {
    const t = setup();
    expect((await t.svc.configure(session(["finance"]), "fee.creation_minor", 100)).ok).toBe(false);
    expect((await t.svc.configure(session(["super_admin"]), "fee.creation_minor", -1)).ok).toBe(
      false,
    );
    expect(t.changes).toHaveLength(0);
  });
});

describe("raffle reports", () => {
  it("accepts a valid report, queues it and lets Support respond", async () => {
    const t = setup();
    const r = await t.svc.submitReport("player-1", "r1", "looks fake");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.receivedAt).toEqual(NOW);
    const q = await t.svc.reportQueue(session(["support"]), "open");
    expect(q.ok && q.value).toHaveLength(1);
    const resp = await t.svc.respondToReport(session(["support"]), r.value.reportId, "reviewed");
    expect(resp.ok).toBe(true);
    expect(t.reports.get(r.value.reportId)?.status).toBe("responded");
  });

  it("rejects empty and over-long reasons and returns the entered text", async () => {
    const t = setup();
    const long = "x".repeat(1001);
    const r = await t.svc.submitReport("player-1", "r1", long);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === "invalid") expect(r.error.retainedText).toBe(long);
    expect((await t.svc.submitReport("player-1", "r1", "")).ok).toBe(false);
    expect(t.reports.size).toBe(0);
  });

  it("returns not_found for an unknown raffle", async () => {
    const t = setup();
    expect(await t.svc.submitReport("p", "nope", "x")).toEqual(err({ kind: "not_found" }));
  });
});
