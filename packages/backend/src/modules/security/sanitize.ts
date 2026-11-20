const NAMED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
  colon: ":",
  tab: "\t",
  newline: "\n",
  lpar: "(",
  rpar: ")",
};

function safeCodePoint(n: number): string {
  return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_m, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_m, d: string) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function percentDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Normalise so obfuscated payloads (entities, percent-encoding, control chars) match the patterns. */
function normalize(input: string): string {
  let s = input;
  for (let i = 0; i < 3; i++) {
    const next = percentDecode(decodeEntities(s));
    if (next === s) break;
    s = next;
  }
  // eslint-disable-next-line no-control-regex
  return s.normalize("NFKC").replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, "");
}

const SCRIPT_PATTERNS: readonly RegExp[] = [
  /<\s*\/?\s*(script|iframe|object|embed|applet|meta|link|base|form|style)\b/i,
  /<\s*svg\b/i,
  /\b(javascript|vbscript)\s*:/i,
  /\bdata\s*:\s*text\/html/i,
  /\bon[a-z]{3,}\s*=/i,
  /\bexpression\s*\(/i,
  /<\s*[a-z][^>]*\bsrcdoc\s*=/i,
];

/** True when the text carries script content (Requirement 15.8, XSS). */
export function containsScript(input: string): boolean {
  const n = normalize(input);
  return SCRIPT_PATTERNS.some((p) => p.test(n));
}

const SQL_PATTERNS: readonly RegExp[] = [
  /['"]\s*(or|and)\s+['"\w(]+\s*(=|like|<|>)/i,
  /\bunion\s+(all\s+)?select\b/i,
  /;\s*(drop|delete|insert|update|alter|truncate|create|grant|exec)\b/i,
  /['"]\s*;\s*--/,
  /['"]\s*--/,
  /\/\*[\s\S]*\*\//,
  /\b(sleep|pg_sleep|benchmark|waitfor\s+delay)\s*\(/i,
];

/** True when the text looks like it tries to alter query structure (Requirement 15.8, SQL injection). */
export function containsSqlInjection(input: string): boolean {
  const n = normalize(input);
  return SQL_PATTERNS.some((p) => p.test(n));
}

export type InputViolation = "script" | "sql";

const MAX_DEPTH = 20;

/**
 * Walk any JSON-like value (strings, keys, arrays, objects) and return the first violation found,
 * or null when clean. The request is rejected rather than rewritten.
 */
export function findInputViolation(value: unknown, depth = 0): InputViolation | null {
  if (depth > MAX_DEPTH) return "script";
  if (typeof value === "string") {
    if (containsScript(value)) return "script";
    if (containsSqlInjection(value)) return "sql";
    return null;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const r = findInputViolation(v, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = findInputViolation(k, depth + 1) ?? findInputViolation(v, depth + 1);
      if (r) return r;
    }
  }
  return null;
}
