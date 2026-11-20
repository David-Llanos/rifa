import type { Scheduler } from "../scheduler/scheduler.js";
import { DEADLINE_PAYMENT_GRACE_MS } from "./confirmation-core.js";
import type { ConfirmationService } from "./confirmation.js";

export const RESERVATION_SWEEP_JOB = "reservation.sweep";
export const DEADLINE_RELEASE_JOB = "reservation.deadline_release";

/** Sweep cadence; well under the 10 second release requirement (Req 5.6, 6.6). */
export const DEFAULT_SWEEP_INTERVAL_MS = 5_000;

const bucketOf = (t: Date, intervalMs: number): number => Math.floor(t.getTime() / intervalMs);

export interface ExpiryJobOptions {
  now: () => Date;
  sweepIntervalMs?: number;
  graceMs?: number;
}

/**
 * Registers the expiry handlers and schedules the first sweep. Each sweep schedules the next time bucket
 * (unique per bucket), so restarts and several workers converge on one chain and none run twice.
 */
export async function registerExpiryJobs(
  scheduler: Scheduler,
  service: ConfirmationService,
  opts: ExpiryJobOptions,
): Promise<void> {
  const interval = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const graceMs = opts.graceMs ?? DEADLINE_PAYMENT_GRACE_MS;
  const scheduleNext = (): Promise<boolean> => {
    const next = bucketOf(opts.now(), interval) + 1;
    return scheduler.schedule({
      jobType: RESERVATION_SWEEP_JOB,
      entityId: "global",
      occurrence: String(next),
      runAt: new Date(next * interval),
    });
  };

  scheduler.register(RESERVATION_SWEEP_JOB, async () => {
    try {
      await service.releaseExpired(opts.now());
    } finally {
      // Keep the chain alive even when a sweep fails; the scheduler retries the failed one separately.
      await scheduleNext();
    }
  });

  scheduler.register(DEADLINE_RELEASE_JOB, async (job) => {
    const out = await service.releaseAtDeadline(job.entityId, opts.now());
    const deadline = new Date(String(job.payload["deadline"]));
    if (out.heldOrders > 0 && job.occurrence === "deadline") {
      await scheduler.schedule({
        jobType: DEADLINE_RELEASE_JOB,
        entityId: job.entityId,
        occurrence: "grace",
        runAt: new Date(deadline.getTime() + graceMs),
        payload: { deadline: deadline.toISOString() },
      });
    }
  });

  await scheduleNext();
}

/** Schedules the deadline-time release for a raffle (idempotent). */
export function scheduleDeadlineRelease(
  scheduler: Scheduler,
  raffleId: string,
  deadline: Date,
): Promise<boolean> {
  return scheduler.schedule({
    jobType: DEADLINE_RELEASE_JOB,
    entityId: raffleId,
    occurrence: "deadline",
    runAt: deadline,
    payload: { deadline: deadline.toISOString() },
  });
}
