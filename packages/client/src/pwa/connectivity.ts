/** Counts are flagged as possibly outdated within this time of losing the connection (Req 4.8). */
export const STALE_COUNTS_AFTER_MS = 10_000;

export interface ConnectivityState {
  online: boolean;
  /** True when live counts may be outdated (offline, or realtime silent for too long). */
  countsStale: boolean;
}

export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultScheduler: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Tracks network and realtime-connection health.
 * Going offline marks counts stale immediately (well inside the 10 s limit). When online,
 * a watchdog marks counts stale if no realtime activity is seen for `staleAfterMs`.
 */
export class ConnectivityMonitor {
  private state: ConnectivityState;
  private readonly listeners = new Set<() => void>();
  private timer: unknown = null;
  private watching = false;

  constructor(
    initialOnline = true,
    private readonly staleAfterMs = STALE_COUNTS_AFTER_MS,
    private readonly scheduler: Scheduler = defaultScheduler,
  ) {
    this.state = { online: initialOnline, countsStale: !initialOnline };
  }

  getState = (): ConnectivityState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setOnline(online: boolean): void {
    if (online === this.state.online) return;
    if (!online) {
      this.clearTimer();
      this.set({ online: false, countsStale: true });
      return;
    }
    // Back online: counts stay stale until the realtime channel reports activity.
    this.set({ online: true, countsStale: this.state.countsStale });
    if (this.watching) this.armWatchdog();
  }

  /** Begin expecting realtime activity; call `activity()` on every message or heartbeat. */
  startWatching(): void {
    this.watching = true;
    if (this.state.online) this.armWatchdog();
  }

  stopWatching(): void {
    this.watching = false;
    this.clearTimer();
  }

  /** Record realtime activity (a message or heartbeat). */
  activity(): void {
    if (!this.state.online) return;
    this.set({ online: true, countsStale: false });
    if (this.watching) this.armWatchdog();
  }

  /** Realtime channel reported a disconnect. */
  realtimeLost(): void {
    this.clearTimer();
    if (!this.state.countsStale) this.set({ ...this.state, countsStale: true });
  }

  private armWatchdog(): void {
    this.clearTimer();
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = null;
      if (!this.state.countsStale) this.set({ ...this.state, countsStale: true });
    }, this.staleAfterMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) this.scheduler.clearTimeout(this.timer);
    this.timer = null;
  }

  private set(next: ConnectivityState): void {
    if (next.online === this.state.online && next.countsStale === this.state.countsStale) return;
    this.state = next;
    for (const l of this.listeners) l();
  }
}
