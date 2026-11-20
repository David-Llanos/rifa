import type { ConnectivityMonitor } from "./connectivity";

export interface TicketCounts {
  available: number;
  reserved: number;
  sold: number;
  cancelled: number;
}

export interface CountsUpdate {
  raffleId: string;
  counts: TicketCounts;
  /** ISO time the server read the counts. */
  at: string;
}

/** The subset of the browser EventSource API used here (injectable for tests). */
export interface EventSourceLike {
  addEventListener(type: string, listener: (e: { data: string }) => void): void;
  onerror: (() => void) | null;
  close(): void;
}

export interface CountsStreamOptions {
  url: string;
  monitor: ConnectivityMonitor;
  onCounts(update: CountsUpdate): void;
  createEventSource?: (url: string) => EventSourceLike;
}

export const countsStreamUrl = (raffleId: string): string =>
  `/api/raffles/${encodeURIComponent(raffleId)}/counts/stream`;

function parseUpdate(data: string): CountsUpdate | null {
  try {
    const v = JSON.parse(data) as Partial<CountsUpdate>;
    const c = v.counts;
    if (
      typeof v.raffleId !== "string" ||
      typeof v.at !== "string" ||
      !c ||
      ![c.available, c.reserved, c.sold, c.cancelled].every((n) => Number.isInteger(n))
    ) {
      return null;
    }
    return { raffleId: v.raffleId, counts: c, at: v.at };
  } catch {
    return null;
  }
}

/**
 * Subscribes to live ticket counts (Req 4.3). Every message or heartbeat feeds the connectivity
 * watchdog, so counts are flagged as possibly outdated within 10 s of losing the stream (Req 4.8).
 * Updates older than the last one shown are dropped. Returns a function that closes the stream.
 */
export function connectCounts(opts: CountsStreamOptions): () => void {
  const create =
    opts.createEventSource ?? ((url: string) => new EventSource(url) as unknown as EventSourceLike);
  const source = create(opts.url);
  let latest = "";

  source.addEventListener("counts", (e) => {
    opts.monitor.activity();
    const update = parseUpdate(e.data);
    if (!update || update.at < latest) return;
    latest = update.at;
    opts.onCounts(update);
  });
  source.addEventListener("ping", () => opts.monitor.activity());
  // EventSource reconnects by itself; the monitor stays stale until the next message arrives.
  source.onerror = () => opts.monitor.realtimeLost();
  opts.monitor.startWatching();

  return () => {
    opts.monitor.stopWatching();
    source.close();
  };
}
