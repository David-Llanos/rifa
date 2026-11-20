import { describe, expect, it } from "vitest";
import { manualClock } from "@raffle/shared";
import { InMemoryJobStore } from "../scheduler/memory-store.js";
import { Scheduler } from "../scheduler/scheduler.js";
import { decideManualResult } from "./manual.js";
import {
  createDrawService,
  JOB_RETRIEVE_RESULT,
  registerDrawJobs,
  type DrawAuditEvent,
  type DrawRaffle,
  type DrawRecord,
  type DrawRepository,
} from "./service.js";
import { FakeLotteryResultSource } from "./source.js";
import type { LotteryResult } from "./core.js";

const DRAW_AT = new Date("2025-03-01T22:30:00Z");
const H = 3_600_000;
const MIN = 60_000;

const result = (firstPrize: string): LotteryResult => ({
  lotteryId: "co-bogota",
  drawAt: DRAW_AT,
  firstPrize,
});

function setup(opts: { sold?: number[]; fallback?: DrawRaffle["fallbackRule"] } = {}) {
  const clock = manualClock(new Date(DRAW_AT.getTime() + 1 * MIN));
  const raffle: DrawRaffle = {
    id: "r1",
    ownerId: "owner",
    status: "awaiting_draw",
    totalTickets: 100,
    lotteryId: "co-bogota",
    drawAt: DRAW_AT,
    winningRule: { id: "LAST_N_DIGITS_OF_FIRST_PRIZE" },
    fallbackRule: opts.fallback ?? "lower",
  };
  const sold = new Set(opts.sold ?? [7, 42]);
  let draw: DrawRecord | null = null;
  const audit: DrawAuditEvent[] = [];
  const notices: string[] = [];
  const alerts: string[] = [];
  const store = new InMemoryJobStore();
  const scheduler = new Scheduler({ store, now: () => clock.now(), alertAdmins: () => undefined });
  const source = new FakeLotteryResultSource();

  const repo: DrawRepository<null> = {
    transaction: (fn) => fn(null),
    findRaffleForUpdate: async () => ({ ...raffle }),
    soldTicketNumbers: async () => sold,
    findDraw: async () => (draw ? { ...draw } : null),
    saveDraw: async (_t, d) => {
      draw = { ...d };
    },
    setDrawAt: async (_t, _id, at) => {
      raffle.drawAt = at;
    },
  };
  const svc = createDrawService<null>({
    repo,
    audit: { append: async (_t, e) => void audit.push(e) },
    completion: {
      recordWinner: async (_t, id, ticket) => {
        raffle.status = "completed";
        notices.push(`winner:${id}:${ticket}`);
      },
    },
    source,
    sourceKeyOf: (id) => `lottery:${id}`,
    nextDrawAfter: (_id, after) => new Date(after.getTime() + 7 * 24 * H),
    notifier: {
      notifyOwner: async (_o, _r, kind) => void notices.push(`owner:${kind}`),
      notifyPlayers: async (_r, kind) => void notices.push(`players:${kind}`),
    },
    alerts: { alertAdmins: async (kind) => void alerts.push(kind) },
    jobs: scheduler,
    clock,
  });
  registerDrawJobs(scheduler, svc);
  return {
    svc,
    clock,
    raffle,
    audit,
    notices,
    alerts,
    store,
    source,
    scheduler,
    getDraw: () => draw,
  };
}

describe("retrieveResult", () => {
  it("records the winner, completes the raffle and audits result, source, time, rule and number", async () => {
    const t = setup();
    t.source.script("co-bogota", { kind: "result", result: result("98742"), sourceRef: "ref-1" });
    expect(await t.svc.retrieveResult("r1")).toBe("winner");
    expect(t.raffle.status).toBe("completed");
    expect(t.getDraw()?.winnerTicket).toBe(42);
    const rec = t.audit.find((e) => e.action === "draw.result_recorded");
    const fields = Object.fromEntries((rec?.changes ?? []).map((c) => [c.field, c.after]));
    expect(fields["sourceRef"]).toBe("ref-1");
    expect(fields["derivedNumber"]).toBe("42");
    expect(fields["winningRule"]).toBe("LAST_N_DIGITS_OF_FIRST_PRIZE");
    expect(fields["retrievedAt"]).toBe(t.clock.now().toISOString());
    expect(fields["result"]).toContain("98742");
    // A repeated run is a no-op.
    expect(await t.svc.retrieveResult("r1")).toBe("skipped");
  });

  it("applies the fallback and, with no sold ticket in direction, keeps status, alerts and notifies owner", async () => {
    const t = setup({ sold: [50], fallback: "lower" });
    t.source.script("co-bogota", { kind: "result", result: result("00010"), sourceRef: "r" });
    expect(await t.svc.retrieveResult("r1")).toBe("no_winner");
    expect(t.raffle.status).toBe("awaiting_draw");
    expect(t.notices).toContain("owner:no_winner");
    expect(t.alerts).toContain("no_winner");
  });

  it("redraw fallback moves to the next draw and schedules retrieval", async () => {
    const t = setup({ fallback: "redraw" });
    t.source.script("co-bogota", { kind: "result", result: result("00010"), sourceRef: "r" });
    expect(await t.svc.retrieveResult("r1")).toBe("redraw");
    expect(t.raffle.status).toBe("awaiting_draw");
    expect(t.raffle.drawAt.getTime()).toBe(DRAW_AT.getTime() + 7 * 24 * H);
    expect(t.notices).toContain("players:redraw_scheduled");
  });

  it("polls every 5 minutes, alerts Admins once after 2 hours, and keeps the raffle unchanged", async () => {
    const t = setup();
    expect(await t.svc.retrieveResult("r1")).toBe("waiting");
    const next = new Date(t.clock.now().getTime() + 5 * MIN);
    expect(
      await t.store.get({
        jobType: JOB_RETRIEVE_RESULT,
        entityId: "r1",
        occurrence: `poll:${next.toISOString()}`,
      }),
    ).not.toBeNull();
    t.clock.set(new Date(DRAW_AT.getTime() + 2 * H));
    expect(await t.svc.retrieveResult("r1")).toBe("alerted");
    expect(await t.svc.retrieveResult("r1")).toBe("alerted");
    expect(t.alerts).toEqual(["result_unavailable"]);
    expect(t.raffle.status).toBe("awaiting_draw");
  });

  it("notifies owner and players of a postponement and reschedules; status unchanged", async () => {
    const t = setup();
    const newDrawAt = new Date(DRAW_AT.getTime() + 24 * H);
    t.source.script("co-bogota", { kind: "postponed", newDrawAt });
    expect(await t.svc.retrieveResult("r1")).toBe("postponed");
    expect(t.raffle.drawAt).toEqual(newDrawAt);
    expect(t.notices).toEqual(
      expect.arrayContaining(["owner:draw_postponed", "players:draw_postponed"]),
    );
    expect(t.raffle.status).toBe("awaiting_draw");
    expect(
      await t.store.get({
        jobType: JOB_RETRIEVE_RESULT,
        entityId: "r1",
        occurrence: `draw:${newDrawAt.toISOString()}`,
      }),
    ).not.toBeNull();
  });

  it("notifies of a cancellation and leaves the status unchanged", async () => {
    const t = setup();
    t.source.script("co-bogota", { kind: "cancelled" });
    expect(await t.svc.retrieveResult("r1")).toBe("cancelled");
    expect(t.notices).toEqual(
      expect.arrayContaining(["owner:draw_cancelled", "players:draw_cancelled"]),
    );
    expect(t.raffle.status).toBe("awaiting_draw");
  });

  it("lets provider outages propagate so the scheduler retries, then succeeds", async () => {
    const t = setup();
    t.source.script("co-bogota", new Error("provider down"), {
      kind: "result",
      result: result("98742"),
      sourceRef: "ref",
    });
    await t.scheduler.schedule({
      jobType: JOB_RETRIEVE_RESULT,
      entityId: "r1",
      occurrence: "d",
      runAt: DRAW_AT,
    });
    expect((await t.scheduler.tick()).retried).toBe(1);
    t.clock.advance(31_000);
    expect((await t.scheduler.tick()).succeeded).toBe(1);
    expect(t.raffle.status).toBe("completed");
  });
});

describe("manual results", () => {
  const a1 = { id: "a1", role: "admin" };
  const a2 = { id: "a2", role: "admin" };

  it("rejects entry before 2 hours, without source reference, or by non-admins", async () => {
    const t = setup();
    expect((await t.svc.enterManualResult(a1, "r1", result("98742"), "ref")).ok).toBe(false);
    t.clock.set(new Date(DRAW_AT.getTime() + 2 * H));
    expect(await t.svc.enterManualResult(a1, "r1", result("98742"), "  ")).toEqual({
      ok: false,
      error: "invalid_source_ref",
    });
    expect(
      await t.svc.enterManualResult({ id: "u", role: "player" }, "r1", result("98742"), "x"),
    ).toEqual({ ok: false, error: "forbidden" });
  });

  it("applies only after a different Admin approves", async () => {
    const t = setup();
    t.clock.set(new Date(DRAW_AT.getTime() + 2 * H));
    const entered = await t.svc.enterManualResult(
      a1,
      "r1",
      result("98742"),
      "official bulletin 12",
    );
    expect(entered.ok).toBe(true);
    expect(t.raffle.status).toBe("awaiting_draw");

    expect(await t.svc.approveManualResult(a1, "r1")).toEqual({
      ok: false,
      error: "self_approval",
    });
    expect(t.raffle.status).toBe("awaiting_draw");
    expect(t.getDraw()?.manual?.state).toBe("pending");
    expect(
      t.audit.some((e) => e.action === "draw.manual_approval_denied" && e.actor === "a1"),
    ).toBe(true);

    expect(await t.svc.approveManualResult(a2, "r1")).toEqual({ ok: true, value: "winner" });
    expect(t.raffle.status).toBe("completed");
    expect(t.getDraw()?.manual).toMatchObject({ state: "applied", approvedBy: "a2" });
    const rec = t.audit.find((e) => e.action === "draw.result_recorded");
    expect(rec?.changes.find((c) => c.field === "sourceRef")?.after).toBe("official bulletin 12");
  });

  it("a rejection by another Admin leaves the draw unapplied and is audited", async () => {
    const t = setup();
    t.clock.set(new Date(DRAW_AT.getTime() + 2 * H));
    await t.svc.enterManualResult(a1, "r1", result("98742"), "ref");
    expect(await t.svc.rejectManualResult(a1, "r1")).toEqual({
      ok: false,
      error: "self_rejection",
    });
    expect(await t.svc.rejectManualResult(a2, "r1")).toEqual({ ok: true, value: undefined });
    expect(t.raffle.status).toBe("awaiting_draw");
    expect(t.getDraw()?.winnerTicket).toBeUndefined();
    expect(t.getDraw()?.manual?.state).toBe("rejected");
    expect(t.audit.some((e) => e.action === "draw.manual_rejected" && e.actor === "a2")).toBe(true);
    // A new entry is allowed after rejection.
    expect((await t.svc.enterManualResult(a1, "r1", result("98742"), "ref2")).ok).toBe(true);
  });
});

describe("decideManualResult", () => {
  it("applies only on approval by a different Admin", () => {
    expect(decideManualResult("a", "b", "approve")).toBe("apply");
    expect(decideManualResult("a", "b", "reject")).toBe("rejected");
    expect(decideManualResult("a", "a", "approve")).toBe("denied_self");
    expect(decideManualResult("a", "a", "reject")).toBe("denied_self");
  });
});
