/**
 * Durable job scheduler and retry policy (Req 7.11, 7.12, 25.5, 25.6).
 *
 * - Jobs are unique per `(jobType, entityId, occurrence)`; scheduling the same key twice is a no-op.
 * - A job is claimed atomically (queued -> running), so repeated ticks or concurrent workers never
 *   run an occurrence twice. Jobs left `running` by a crashed process are recovered on `resume`.
 * - Failures are retried with exponential backoff; the queue entry is preserved between attempts and
 *   an Admin alert is raised after the third failed attempt.
 */

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface JobRecord {
  id: string;
  jobType: string;
  entityId: string;
  occurrence: string;
  runAt: Date;
  status: JobStatus;
  attempts: number;
  lastError: string | null;
  payload: Record<string, unknown>;
}

export interface JobKey {
  jobType: string;
  entityId: string;
  occurrence: string;
}

export interface ScheduleInput extends JobKey {
  runAt: Date;
  payload?: Record<string, unknown>;
}

/** Storage port. Implementations must make `schedule` and `claimDue` atomic. */
export interface JobStore {
  /** Inserts the job unless the key exists. Returns true when a new entry was created. */
  schedule(input: ScheduleInput): Promise<boolean>;
  /** Atomically moves up to `limit` due queued jobs to running, incrementing attempts. */
  claimDue(now: Date, limit: number): Promise<JobRecord[]>;
  markDone(id: string): Promise<void>;
  /** Returns the job to the queue (preserved entry) to run again at `runAt`. */
  requeue(id: string, runAt: Date, error: string): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
  /** Moves jobs stuck in running (process crashed) back to queued. Returns the count. */
  recoverRunning(): Promise<number>;
  get(key: JobKey): Promise<JobRecord | null>;
}

export type JobHandler = (job: JobRecord) => Promise<void>;

export interface RetryPolicy {
  /** Total attempts including the first run. */
  maxAttempts: number;
  /** Delay before the first retry in ms; doubles for each following retry. */
  baseDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 30_000 };

/** Delay before the retry that follows failed attempt number `failedAttempt` (1-based). */
export function backoffDelayMs(
  failedAttempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): number {
  return policy.baseDelayMs * 2 ** Math.max(0, failedAttempt - 1);
}

export type RetryDecision = { action: "retry"; delayMs: number } | { action: "fail" };

/** Decides what to do after attempt number `failedAttempt` (1-based) failed. */
export function retryDecision(
  failedAttempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): RetryDecision {
  return failedAttempt >= policy.maxAttempts
    ? { action: "fail" }
    : { action: "retry", delayMs: backoffDelayMs(failedAttempt, policy) };
}

export interface AdminAlert {
  job: JobRecord;
  error: string;
}

export interface SchedulerOptions {
  store: JobStore;
  now: () => Date;
  /** Raised after the final failed attempt (Req 25.5). */
  alertAdmins: (alert: AdminAlert) => Promise<void> | void;
  retry?: RetryPolicy;
  batchSize?: number;
}

export interface TickResult {
  ran: number;
  succeeded: number;
  retried: number;
  failed: number;
}

export class Scheduler {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly store: JobStore;
  private readonly now: () => Date;
  private readonly alertAdmins: SchedulerOptions["alertAdmins"];
  private readonly retry: RetryPolicy;
  private readonly batchSize: number;

  constructor(opts: SchedulerOptions) {
    this.store = opts.store;
    this.now = opts.now;
    this.alertAdmins = opts.alertAdmins;
    this.retry = opts.retry ?? DEFAULT_RETRY_POLICY;
    this.batchSize = opts.batchSize ?? 50;
  }

  register(jobType: string, handler: JobHandler): void {
    this.handlers.set(jobType, handler);
  }

  /** Idempotent: returns false when the occurrence was already scheduled. */
  schedule(input: ScheduleInput): Promise<boolean> {
    return this.store.schedule(input);
  }

  /** Call once on startup: recovers jobs interrupted by a restart so none are skipped. */
  resume(): Promise<number> {
    return this.store.recoverRunning();
  }

  /** Runs every due job once. Safe to call repeatedly and from several workers. */
  async tick(): Promise<TickResult> {
    const result: TickResult = { ran: 0, succeeded: 0, retried: 0, failed: 0 };
    for (;;) {
      const jobs = await this.store.claimDue(this.now(), this.batchSize);
      if (jobs.length === 0) return result;
      for (const job of jobs) {
        result.ran++;
        const outcome = await this.execute(job);
        result[outcome]++;
      }
    }
  }

  private async execute(job: JobRecord): Promise<"succeeded" | "retried" | "failed"> {
    try {
      const handler = this.handlers.get(job.jobType);
      if (!handler) throw new Error(`no handler registered for job type ${job.jobType}`);
      await handler(job);
      await this.store.markDone(job.id);
      return "succeeded";
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      const decision = retryDecision(job.attempts, this.retry);
      if (decision.action === "retry") {
        await this.store.requeue(job.id, new Date(this.now().getTime() + decision.delayMs), error);
        return "retried";
      }
      await this.store.markFailed(job.id, error);
      await this.alertAdmins({ job: { ...job, status: "failed", lastError: error }, error });
      return "failed";
    }
  }
}
