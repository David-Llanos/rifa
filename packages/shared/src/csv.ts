/**
 * RFC 4180 CSV. Every record ends with CRLF; a field is quoted when it contains a comma, a double
 * quote, CR or LF, and inner quotes are doubled. `parseCsv(toCsv(rows))` returns `rows` unchanged
 * (Property 45).
 */
export type CsvRecord = readonly string[];

export class CsvParseError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(`${message} at offset ${offset}`);
    this.name = "CsvParseError";
  }
}

const NEEDS_QUOTES = /[",\r\n]/;

export function csvField(value: string): string {
  return NEEDS_QUOTES.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(records: readonly CsvRecord[]): string {
  let out = "";
  for (const r of records) out += r.map(csvField).join(",") + "\r\n";
  return out;
}

/** Parses CSV text. Accepts CRLF or LF record endings and a final record without a line ending. */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let i = 0;
  const n = text.length;
  if (n === 0) return records;

  while (i < n) {
    if (text[i] === '"' && field === "") {
      // Quoted field.
      i++;
      for (;;) {
        if (i >= n) throw new CsvParseError("Unterminated quoted field", i);
        const c = text[i];
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        field += c;
        i++;
      }
      const next = text[i];
      if (i < n && next !== "," && next !== "\r" && next !== "\n") {
        throw new CsvParseError("Unexpected character after closing quote", i);
      }
      continue;
    }
    const c = text[i];
    if (c === ",") {
      record.push(field);
      field = "";
      i++;
    } else if (c === "\r" || c === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      i += c === "\r" && text[i + 1] === "\n" ? 2 : 1;
    } else {
      field += c;
      i++;
    }
  }
  // Final record without a trailing line ending.
  const last = text[n - 1];
  if (last !== "\n" && last !== "\r") {
    record.push(field);
    records.push(record);
  }
  return records;
}
