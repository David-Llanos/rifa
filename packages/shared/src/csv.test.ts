import { describe, expect, it } from "vitest";
import { CsvParseError, parseCsv, toCsv } from "./csv.js";

describe("CSV", () => {
  it("quotes only fields that need it and ends every record with CRLF", () => {
    expect(toCsv([["a", "b,c", 'say "hi"', "x\ny", ""]])).toBe('a,"b,c","say ""hi""","x\ny",\r\n');
  });

  it("round-trips commas, quotes, CR/LF, empty fields and accents", () => {
    const rows = [
      ["number", "buyer"],
      ["1", 'Pérez, "Ana"'],
      ["2", "line1\r\nline2\rline3\nend"],
      ["", ""],
      [""],
      ["ñandú 🎟️", '"'],
    ];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });

  it("handles no records and a final record without a line ending", () => {
    expect(toCsv([])).toBe("");
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("a,b\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(parseCsv('a,"b"')).toEqual([["a", "b"]]);
  });

  it("rejects malformed quoting", () => {
    expect(() => parseCsv('"abc')).toThrow(CsvParseError);
    expect(() => parseCsv('"ab"c\r\n')).toThrow(CsvParseError);
  });
});
