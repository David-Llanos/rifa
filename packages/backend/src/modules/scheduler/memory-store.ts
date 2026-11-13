import { randomUUID } from "node:crypto";
import type { JobKey, JobRecord, JobStore, ScheduleInput } from "./scheduler.js";

const keyOf = (k: JobKey): string => JSON.stringify([k.jobType, k.entityId, k.occurrence]);

/** In-memory JobStore used for tests and the concurrency model. "Restart" = new Scheduler, same store. */
export class InMemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, JobRecord>();

  async schedule(input: ScheduleInput): Promise<boolean> {
    const k = keyOf(input);
    if (this.jobs.has(k)) return false;
    this.jobs.set(k, {
      id: randomUUID(),
      jobType: input.jobType,
      entityId: input.entityId,
      occurrence: input.occurrence,
      runAt: input.runAt,
      status: "queued",
      attempts: 0,
      lastError: null,
      payload: input.payload ?? {},
    });
    return true;
  }

  async claimDue(now: Date, limit: number): Promise<JobRecord[]> {
    const due = [...this.jobs.values()]
      .filter((j) => j.status === "queued" && j.runAt.getTime() <= now.getTime())
      .sort((a, b) => a.runAt.getTime() - b.runAt.getTime())
      .slice(0, limit);
    for (const j of due) {
      j.status = "running";
      j.attempts += 1;
    }
    return due.map((j) => ({ ...j }));
  }

  private byId(id: string): JobRecord {
    for (const j of this.jobs.values()) if (j.id === id) return j;
    throw new Error(`job ${id} not found`);
  }

  async markDone(id: string): Promise<void> {
    this.byId(id).status = "done";
  }

  async requeue(id: string, runAt: Date, error: string): Promise<void> {
    const j = this.byId(id);
    j.status = "queued";
    j.runAt = runAt;
    j.lastError = error;
  }

  async markFailed(id: string, error: string): Promise<void> {
    const j = this.byId(id);
    j.status = "failed";
    j.lastError = error;
  }

  async recoverRunning(): Promise<number> {
    let n = 0;
    for (const j of this.jobs.values()) {
      if (j.status === "running") {
        j.status = "queued";
        n++;
      }
    }
    return n;
  }

  async get(key: JobKey): Promise<JobRecord | null> {
    const j = this.jobs.get(keyOf(key));
    return j ? { ...j } : null;
  }
}
