/**
 * Lottery result source adapter port (Requirements 9.6, 9.11, 9.12).
 *
 * Real adapters are configured per lottery through the catalog `sourceKey`; none is defined here and
 * no endpoint is assumed. Tests use `FakeLotteryResultSource`.
 */
import type { LotteryResult } from "./core.js";

export interface SourceRequest {
  readonly lotteryId: string;
  /** Catalog key (`lottery:<id>`) the adapter resolves through configuration. */
  readonly sourceKey: string;
  readonly drawAt: Date;
}

export type SourceOutcome =
  /** `sourceRef` identifies where the official result came from (for the Audit_Trail). */
  | { kind: "result"; result: LotteryResult; sourceRef: string }
  | { kind: "not_yet_published" }
  | { kind: "postponed"; newDrawAt: Date }
  | { kind: "cancelled" };

export interface LotteryResultSource {
  /** Throws on provider outage; the scheduler retries the job with backoff. */
  fetch(req: SourceRequest): Promise<SourceOutcome>;
}

/** Scripted source: queue outcomes per lottery; the last queued outcome repeats. */
export class FakeLotteryResultSource implements LotteryResultSource {
  readonly requests: SourceRequest[] = [];
  private readonly scripts = new Map<string, (SourceOutcome | Error)[]>();

  script(lotteryId: string, ...outcomes: (SourceOutcome | Error)[]): void {
    this.scripts.set(lotteryId, [...outcomes]);
  }

  async fetch(req: SourceRequest): Promise<SourceOutcome> {
    this.requests.push(req);
    const queue = this.scripts.get(req.lotteryId);
    if (!queue || queue.length === 0) return { kind: "not_yet_published" };
    const next = queue.length > 1 ? (queue.shift() as SourceOutcome | Error) : queue[0]!;
    if (next instanceof Error) throw next;
    return next;
  }
}
