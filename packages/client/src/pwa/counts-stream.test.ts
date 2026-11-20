import { describe, expect, it } from "vitest";
import { ConnectivityMonitor } from "./connectivity";
import type { Scheduler } from "./connectivity";
import { connectCounts, countsStreamUrl } from "./counts-stream";
import type { CountsUpdate, EventSourceLike } from "./counts-stream";

class FakeEventSource implements EventSourceLike {
  readonly listeners = new Map<string, (e: { data: string }) => void>();
  onerror: (() => void) | null = null;
  closed = false;
  addEventListener(type: string, l: (e: { data: string }) => void): void {
    this.listeners.set(type, l);
  }
  emit(type: string, data: string): void {
    this.listeners.get(type)?.({ data });
  }
  close(): void {
    this.closed = true;
  }
}

function fakeScheduler() {
  const timers = new Map<number, { fn: () => void; at: number }>();
  let now = 0;
  let id = 0;
  const scheduler: Scheduler = {
    setTimeout: (fn, ms) => {
      timers.set(++id, { fn, at: now + ms });
      return id;
    },
    clearTimeout: (h) => timers.delete(h as number),
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [k, t] of [...timers]) {
      if (t.at <= now) {
        timers.delete(k);
        t.fn();
      }
    }
  };
  return { scheduler, advance };
}

const update = (sold: number, at: string): string =>
  JSON.stringify({ raffleId: "r1", counts: { available: 1, reserved: 0, sold, cancelled: 0 }, at });

function setup() {
  const fs = fakeScheduler();
  const monitor = new ConnectivityMonitor(true, 10_000, fs.scheduler);
  const source = new FakeEventSource();
  const got: CountsUpdate[] = [];
  let url = "";
  const close = connectCounts({
    url: countsStreamUrl("r 1"),
    monitor,
    onCounts: (u) => got.push(u),
    createEventSource: (u) => {
      url = u;
      return source;
    },
  });
  return { monitor, source, got, close, advance: fs.advance, url: () => url };
}

describe("connectCounts (Req 4.3, 4.8)", () => {
  it("delivers counts and drops updates older than the last one shown", () => {
    const s = setup();
    expect(s.url()).toBe("/api/raffles/r%201/counts/stream");
    s.source.emit("counts", update(1, "2030-01-01T00:00:02.000Z"));
    s.source.emit("counts", update(0, "2030-01-01T00:00:01.000Z"));
    s.source.emit("counts", "not json");
    s.source.emit("counts", update(2, "2030-01-01T00:00:03.000Z"));
    expect(s.got.map((u) => u.counts.sold)).toEqual([1, 2]);
  });

  it("flags counts stale within 10 s of silence and clears on the next heartbeat", () => {
    const s = setup();
    s.source.emit("ping", "{}");
    expect(s.monitor.getState().countsStale).toBe(false);
    s.advance(9_999);
    expect(s.monitor.getState().countsStale).toBe(false);
    s.advance(1);
    expect(s.monitor.getState().countsStale).toBe(true);
    s.source.emit("ping", "{}");
    expect(s.monitor.getState().countsStale).toBe(false);
  });

  it("flags counts stale immediately on a stream error and closes the source", () => {
    const s = setup();
    s.source.emit("ping", "{}");
    s.source.onerror?.();
    expect(s.monitor.getState().countsStale).toBe(true);
    s.close();
    expect(s.source.closed).toBe(true);
  });
});
