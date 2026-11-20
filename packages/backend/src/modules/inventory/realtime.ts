import type { TicketCounts } from "./types.js";

/**
 * Realtime ticket counts (Req 4.3, 4.8): services publish counts to Redis pub/sub after a ticket status
 * change, and every API instance relays them to its server-sent-events clients. A heartbeat every 5 s lets
 * the client flag counts as possibly outdated within 10 s of losing the stream.
 */
export const COUNTS_HEARTBEAT_MS = 5_000;
/** Reconnect delay sent to EventSource clients. */
export const SSE_RETRY_MS = 3_000;

export const countsChannel = (raffleId: string): string => `raffle:${raffleId}:counts`;

export type Unsubscribe = () => Promise<void>;

export interface PubSub {
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, listener: (message: string) => void): Promise<Unsubscribe>;
}

/** Single-process pub/sub, for tests and local development. */
export class InMemoryPubSub implements PubSub {
  private readonly channels = new Map<string, Set<(m: string) => void>>();

  publish(channel: string, message: string): Promise<void> {
    for (const l of [...(this.channels.get(channel) ?? [])]) l(message);
    return Promise.resolve();
  }

  subscribe(channel: string, listener: (message: string) => void): Promise<Unsubscribe> {
    let set = this.channels.get(channel);
    if (!set) {
      set = new Set();
      this.channels.set(channel, set);
    }
    set.add(listener);
    return Promise.resolve(() => {
      set.delete(listener);
      if (set.size === 0) this.channels.delete(channel);
      return Promise.resolve();
    });
  }

  listenerCount(channel: string): number {
    return this.channels.get(channel)?.size ?? 0;
  }
}

/** The subset of the node-redis v4 client API used here. */
export interface RedisPublisher {
  publish(channel: string, message: string): Promise<number>;
}
export interface RedisSubscriber {
  subscribe(channel: string, listener: (message: string, channel: string) => void): Promise<void>;
  unsubscribe(channel: string, listener: (message: string, channel: string) => void): Promise<void>;
}

/**
 * Redis-backed pub/sub. A subscribing Redis connection cannot run other commands, so the publisher and
 * subscriber must be separate clients (e.g. `client.duplicate()`).
 */
export function redisPubSub(publisher: RedisPublisher, subscriber: RedisSubscriber): PubSub {
  return {
    async publish(channel, message) {
      await publisher.publish(channel, message);
    },
    async subscribe(channel, listener) {
      const wrapped = (message: string): void => listener(message);
      await subscriber.subscribe(channel, wrapped);
      return () => subscriber.unsubscribe(channel, wrapped);
    },
  };
}

export interface CountsMessage {
  raffleId: string;
  counts: TicketCounts;
  at: string;
}

export interface CountsPublisherDeps {
  pubsub: PubSub;
  /** Reads the committed counts, e.g. `inventory.counts`. */
  readCounts(raffleId: string): Promise<TicketCounts>;
  now?: () => Date;
  onError?: (raffleId: string, error: unknown) => void;
}

export interface CountsPublisher {
  /** Call after a ticket status change commits. Never throws; bursts per raffle are coalesced. */
  changed(raffleId: string): void;
  /** Resolves when no publish is in flight (for tests and graceful shutdown). */
  idle(): Promise<void>;
}

export function createCountsPublisher(deps: CountsPublisherDeps): CountsPublisher {
  const now = deps.now ?? (() => new Date());
  const running = new Map<string, Promise<void>>();
  const dirty = new Set<string>();

  async function loop(raffleId: string): Promise<void> {
    do {
      dirty.delete(raffleId);
      try {
        const counts = await deps.readCounts(raffleId);
        const msg: CountsMessage = { raffleId, counts, at: now().toISOString() };
        await deps.pubsub.publish(countsChannel(raffleId), JSON.stringify(msg));
      } catch (e) {
        // A missed update is tolerable: the next change republishes, and clients flag stale counts.
        deps.onError?.(raffleId, e);
      }
    } while (dirty.has(raffleId));
  }

  return {
    changed(raffleId) {
      if (running.has(raffleId)) {
        // Read again after the in-flight publish so the last change is never lost.
        dirty.add(raffleId);
        return;
      }
      const p = loop(raffleId).finally(() => running.delete(raffleId));
      running.set(raffleId, p);
    },
    async idle() {
      while (running.size > 0) await Promise.all([...running.values()]);
    },
  };
}

/** Formats one server-sent event. Multi-line data is split into several `data:` lines. */
export function formatSseEvent(event: string, data: string, id?: string): string {
  let out = `event: ${event}\n`;
  if (id !== undefined) out += `id: ${id}\n`;
  for (const line of data.split(/\r\n|\r|\n/)) out += `data: ${line}\n`;
  return out + "\n";
}

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  // Stop reverse proxies (nginx) from buffering the stream.
  "X-Accel-Buffering": "no",
} as const;

export interface StreamTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const defaultTimers: StreamTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export interface CountsStreamOptions {
  raffleId: string;
  pubsub: PubSub;
  readCounts(raffleId: string): Promise<TicketCounts>;
  /** Writes a chunk to the HTTP response. */
  write(chunk: string): void;
  heartbeatMs?: number;
  timers?: StreamTimers;
  now?: () => Date;
}

export interface CountsStream {
  close(): Promise<void>;
}

/**
 * Starts an SSE counts stream for one client: subscribes first, then sends the current counts, so no
 * change between the read and the subscription is missed. Call `close()` when the request ends.
 */
export async function openCountsStream(opts: CountsStreamOptions): Promise<CountsStream> {
  const timers = opts.timers ?? defaultTimers;
  const now = opts.now ?? (() => new Date());
  let closed = false;
  const send = (chunk: string): void => {
    if (!closed) opts.write(chunk);
  };

  send(`retry: ${SSE_RETRY_MS}\n\n`);
  const unsubscribe = await opts.pubsub.subscribe(countsChannel(opts.raffleId), (message) =>
    send(formatSseEvent("counts", message)),
  );
  const heartbeat = timers.setInterval(
    () => send(formatSseEvent("ping", JSON.stringify({ at: now().toISOString() }))),
    opts.heartbeatMs ?? COUNTS_HEARTBEAT_MS,
  );

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    timers.clearInterval(heartbeat);
    await unsubscribe();
  };

  try {
    const counts = await opts.readCounts(opts.raffleId);
    const msg: CountsMessage = { raffleId: opts.raffleId, counts, at: now().toISOString() };
    send(formatSseEvent("counts", JSON.stringify(msg)));
  } catch (e) {
    await close();
    throw e;
  }
  return { close };
}
