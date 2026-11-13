/** Failed attempts that trigger a lock (Requirement 1.6). */
export const LOCK_THRESHOLD = 5;
/** Window in which the failures must fall, and how long the lock lasts (Requirement 1.6). */
export const LOCK_WINDOW_MS = 15 * 60 * 1000;
export const LOCK_DURATION_MS = 15 * 60 * 1000;

export interface LockState {
  /** Timestamps of the current run of consecutive failures (at most LOCK_THRESHOLD - 1). */
  readonly failures: readonly Date[];
  /** Set while the account is locked. */
  readonly lockedUntil: Date | null;
}

export const INITIAL_LOCK_STATE: LockState = { failures: [], lockedUntil: null };

export function isLocked(s: LockState, now: Date): boolean {
  return s.lockedUntil !== null && now.getTime() < s.lockedUntil.getTime();
}

/**
 * Pure lockout transition. Five consecutive failures within 15 minutes lock the account for
 * 15 minutes. While locked every attempt, including one with valid credentials, leaves the
 * state unchanged and must be rejected by the caller (check `isLocked`). A success while not
 * locked ends the run of failures. A lock that has expired starts from a clean state.
 */
export function nextLockState(s: LockState, attempt: { at: Date; ok: boolean }): LockState {
  if (isLocked(s, attempt.at)) return s;
  const base: LockState = s.lockedUntil === null ? s : INITIAL_LOCK_STATE;
  if (attempt.ok) return INITIAL_LOCK_STATE;

  const t = attempt.at.getTime();
  const recent = base.failures.filter((f) => t - f.getTime() <= LOCK_WINDOW_MS);
  const failures = [...recent, attempt.at];
  if (failures.length >= LOCK_THRESHOLD) {
    return { failures: [], lockedUntil: new Date(t + LOCK_DURATION_MS) };
  }
  return { failures, lockedUntil: null };
}
