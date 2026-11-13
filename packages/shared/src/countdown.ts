/**
 * Countdown formatting (Requirements 5.5, 7.1).
 * - "reservation": MM:SS (minutes may exceed 59), e.g. "10:00"
 * - "deadline": days/hours/minutes/seconds, e.g. "2d 3h 4m 5s"
 * Durations are whole seconds; sub-second remainders are floored.
 */
export type CountdownStyle = "reservation" | "deadline";

const pad2 = (n: number): string => String(n).padStart(2, "0");

function toWholeSeconds(ms: number): number {
  if (!Number.isFinite(ms)) throw new RangeError("duration must be finite");
  return Math.max(0, Math.floor(ms / 1000));
}

export function formatCountdown(ms: number, style: CountdownStyle = "reservation"): string {
  const total = toWholeSeconds(ms);
  if (style === "reservation") {
    return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
  }
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${d}d ${h}h ${m}m ${s}s`;
}

const RESERVATION_RE = /^(\d+):([0-5]\d)$/;
const DEADLINE_RE = /^(\d+)d (\d+)h (\d+)m (\d+)s$/;

/** Parse either countdown format back to milliseconds. Throws SyntaxError on bad input. */
export function parseCountdown(s: string): number {
  const text = s.trim();
  let m = RESERVATION_RE.exec(text);
  if (m) return (Number(m[1]) * 60 + Number(m[2])) * 1000;
  m = DEADLINE_RE.exec(text);
  if (m) {
    return (((Number(m[1]) * 24 + Number(m[2])) * 60 + Number(m[3])) * 60 + Number(m[4])) * 1000;
  }
  throw new SyntaxError(`invalid countdown: ${s}`);
}
