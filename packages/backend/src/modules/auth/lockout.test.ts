import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  INITIAL_LOCK_STATE,
  LOCK_DURATION_MS,
  LOCK_WINDOW_MS,
  isLocked,
  nextLockState,
  type LockState,
} from "./lockout.js";

const T0 = Date.UTC(2025, 5, 1, 12, 0, 0);
const at = (ms: number): Date => new Date(T0 + ms);

function run(times: readonly number[], ok = false): LockState {
  return times.reduce<LockState>((s, t) => nextLockState(s, { at: at(t), ok }), INITIAL_LOCK_STATE);
}

describe("nextLockState", () => {
  it("locks on the 5th failure within 15 minutes, not the 4th", () => {
    expect(run([0, 1000, 2000, 3000]).lockedUntil).toBeNull();
    const locked = run([0, 1000, 2000, 3000, LOCK_WINDOW_MS]);
    expect(locked.lockedUntil).toEqual(at(LOCK_WINDOW_MS + LOCK_DURATION_MS));
  });

  it("does not lock when the failures spread over more than 15 minutes", () => {
    expect(run([0, 1000, 2000, 3000, LOCK_WINDOW_MS + 1]).lockedUntil).toBeNull();
  });

  it("a success resets the run of failures", () => {
    let s = run([0, 1000, 2000, 3000]);
    s = nextLockState(s, { at: at(4000), ok: true });
    s = nextLockState(s, { at: at(5000), ok: false });
    expect(s.lockedUntil).toBeNull();
  });

  it("rejects attempts while locked, including a valid one, and unlocks after 15 minutes", () => {
    const locked = run([0, 1, 2, 3, 4]);
    const during = nextLockState(locked, { at: at(60_000), ok: true });
    expect(during).toBe(locked);
    expect(isLocked(locked, at(60_000))).toBe(true);
    expect(isLocked(locked, at(4 + LOCK_DURATION_MS))).toBe(false);
    const after = nextLockState(locked, { at: at(5 + LOCK_DURATION_MS), ok: false });
    expect(after.lockedUntil).toBeNull();
    expect(after.failures).toHaveLength(1);
  });

  // Feature: raffle-platform, Property 2: Lockout after repeated failures
  // **Validates: Requirements 1.6**
  it("property: 5 failures within 15 minutes lock for 15 minutes", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: LOCK_WINDOW_MS / 4 }), { minLength: 4, maxLength: 4 }),
        (gaps) => {
          const times = [0];
          for (const g of gaps) times.push(times[times.length - 1]! + g);
          const s = run(times);
          const last = times[4]!;
          expect(s.lockedUntil).toEqual(at(last + LOCK_DURATION_MS));
          expect(isLocked(s, at(last + LOCK_DURATION_MS - 1))).toBe(true);
          expect(isLocked(s, at(last + LOCK_DURATION_MS))).toBe(false);
        },
      ),
    );
  });

  // **Validates: Requirements 1.6**
  it("property: failures spaced so no 5 fall in 15 minutes never lock", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 225_001, max: 2 * LOCK_WINDOW_MS }), {
          minLength: 1,
          maxLength: 30,
        }),
        (gaps) => {
          let t = 0;
          let s = INITIAL_LOCK_STATE;
          for (const g of gaps) {
            t += g;
            s = nextLockState(s, { at: at(t), ok: false });
            expect(s.lockedUntil).toBeNull();
          }
        },
      ),
    );
  });

  // **Validates: Requirements 1.6**
  it("property: while locked every attempt leaves the state unchanged", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: LOCK_DURATION_MS - 1 }), fc.boolean(), (dt, ok) => {
        const locked = run([0, 1, 2, 3, 4]);
        expect(nextLockState(locked, { at: at(4 + dt), ok })).toBe(locked);
      }),
    );
  });
});
