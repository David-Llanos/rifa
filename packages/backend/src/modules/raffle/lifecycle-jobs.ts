import type { JobRecord } from "../scheduler/scheduler.js";
import {
  JOB_CLOSE_SALES,
  JOB_EVALUATE_THRESHOLD,
  JOB_REMINDER_24H,
  type OwnerNotifier,
  type RaffleLifecycleService,
} from "./lifecycle-service.js";

/** Requirement 7.12: up to 3 retries at 30-second intervals. */
export const LIFECYCLE_RETRY = { retries: 3, intervalMs: 30_000 } as const;

export interface RetryOptions {
  retries: number;
  intervalMs: number;
  sleep: (ms: number) => Promise<void>;
}

/** Runs `fn`, retrying after throws. Returns the last error when every attempt failed. */
export async function runWithRetries(
  fn: () => Promise<void>,
  opts: RetryOptions,
): Promise<{ ok: true; attempts: number } | { ok: false; attempts: number; error: string }> {
  let lastError = "";
  for (let attempt = 1; attempt <= opts.retries + 1; attempt++) {
    try {
      await fn();
      return { ok: true, attempts: attempt };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (attempt <= opts.retries) await opts.sleep(opts.intervalMs);
    }
  }
  return { ok: false, attempts: opts.retries + 1, error: lastError };
}

/** Structurally satisfied by the scheduler module's `Scheduler`. */
export interface JobRegistry {
  register(jobType: string, handler: (job: JobRecord) => Promise<void>): void;
}

export interface LifecycleJobDeps {
  service: RaffleLifecycleService;
  notifier: OwnerNotifier;
  ownerOf: (raffleId: string) => Promise<string | null>;
  sleep?: (ms: number) => Promise<void>;
  retry?: Pick<RetryOptions, "retries" | "intervalMs">;
}

function isFailedResult(r: unknown): r is { ok: false; error: unknown } {
  return typeof r === "object" && r !== null && (r as { ok?: unknown }).ok === false;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Registers the deadline closure, threshold evaluation and 24-hour reminder handlers.
 * A failed step is retried 3 times at 30-second intervals. Each attempt runs in its own
 * transaction, so a failure leaves the raffle in its previous state with sold tickets intact.
 * When every retry fails the owner is notified (Requirement 7.12).
 */
export function registerLifecycleJobs(registry: JobRegistry, deps: LifecycleJobDeps): void {
  const opts: RetryOptions = {
    ...(deps.retry ?? LIFECYCLE_RETRY),
    sleep: deps.sleep ?? realSleep,
  };

  const guarded =
    (step: (raffleId: string) => Promise<unknown>) =>
    async (job: JobRecord): Promise<void> => {
      const raffleId = job.entityId;
      const outcome = await runWithRetries(async () => {
        const r = await step(raffleId);
        // Result-typed failures (e.g. repository errors surfaced as err) count as failures too.
        if (isFailedResult(r)) throw new Error(JSON.stringify(r.error));
      }, opts);
      if (outcome.ok) return;
      const owner = await deps.ownerOf(raffleId);
      if (owner) {
        await deps.notifier.notifyOwner(owner, raffleId, "closure_failed", {
          error: outcome.error,
        });
      }
    };

  registry.register(
    JOB_CLOSE_SALES,
    guarded((id) => deps.service.closeSales(id)),
  );
  registry.register(
    JOB_EVALUATE_THRESHOLD,
    guarded((id) => deps.service.evaluateThreshold(id)),
  );
  registry.register(
    JOB_REMINDER_24H,
    guarded((id) => deps.service.sendDeadlineReminder(id)),
  );
}
