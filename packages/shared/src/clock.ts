/** Injectable time source so domain logic and jobs are deterministic under test. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Clock fixed at a given instant, with manual advance for tests and simulations. */
export interface ManualClock extends Clock {
  set(at: Date): void;
  advance(ms: number): void;
}

export function manualClock(start: Date): ManualClock {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    set: (at) => {
      t = at.getTime();
    },
    advance: (ms) => {
      t += ms;
    },
  };
}
