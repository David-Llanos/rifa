import { randomUUID } from "node:crypto";
import type { SqlClient } from "../../db/migrations.js";
import type { JobKey, JobRecord, JobStatus, JobStore, ScheduleInput } from "./scheduler.js";

const COLUMNS =
  "id, job_type, entity_id, occurrence, run_at, status, attempts, last_error, payload";

function toRecord(r: Record<string, unknown>): JobRecord {
  return {
    id: String(r["id"]),
    jobType: String(r["job_type"]),
    entityId: String(r["entity_id"]),
    occurrence: String(r["occurrence"]),
    runAt: new Date(r["run_at"] as string | Date),
    status: r["status"] as JobStatus,
    attempts: Number(r["attempts"]),
    lastError: (r["last_error"] as string | null) ?? null,
    payload: (r["payload"] as Record<string, unknown>) ?? {},
  };
}

/** PostgreSQL JobStore over the `job` table. Jobs survive restarts; the unique key dedupes schedules. */
export class PgJobStore implements JobStore {
  constructor(private readonly db: SqlClient) {}

  async schedule(input: ScheduleInput): Promise<boolean> {
    const res = await this.db.query(
      `INSERT INTO job (id, job_type, entity_id, occurrence, run_at, payload)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (job_type, entity_id, occurrence) DO NOTHING
       RETURNING id`,
      [
        randomUUID(),
        input.jobType,
        input.entityId,
        input.occurrence,
        input.runAt,
        JSON.stringify(input.payload ?? {}),
      ],
    );
    return res.rows.length > 0;
  }

  async claimDue(now: Date, limit: number): Promise<JobRecord[]> {
    const res = await this.db.query(
      `UPDATE job SET status = 'running', attempts = attempts + 1
       WHERE id IN (
         SELECT id FROM job
         WHERE status = 'queued' AND run_at <= $1
         ORDER BY run_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       RETURNING ${COLUMNS}`,
      [now, limit],
    );
    return res.rows.map(toRecord).sort((a, b) => a.runAt.getTime() - b.runAt.getTime());
  }

  async markDone(id: string): Promise<void> {
    await this.db.query("UPDATE job SET status = 'done' WHERE id = $1", [id]);
  }

  async requeue(id: string, runAt: Date, error: string): Promise<void> {
    await this.db.query(
      "UPDATE job SET status = 'queued', run_at = $2, last_error = $3 WHERE id = $1",
      [id, runAt, error],
    );
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.db.query("UPDATE job SET status = 'failed', last_error = $2 WHERE id = $1", [
      id,
      error,
    ]);
  }

  async recoverRunning(): Promise<number> {
    const res = await this.db.query(
      "UPDATE job SET status = 'queued' WHERE status = 'running' RETURNING id",
    );
    return res.rows.length;
  }

  async get(key: JobKey): Promise<JobRecord | null> {
    const res = await this.db.query(
      `SELECT ${COLUMNS} FROM job WHERE job_type = $1 AND entity_id = $2 AND occurrence = $3`,
      [key.jobType, key.entityId, key.occurrence],
    );
    const row = res.rows[0];
    return row ? toRecord(row) : null;
  }
}
