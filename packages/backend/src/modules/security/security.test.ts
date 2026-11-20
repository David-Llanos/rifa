import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  assertParameterized,
  checkRequest,
  containsScript,
  contentSecurityPolicy,
  encodeHtml,
  findInputViolation,
  isTransportAllowed,
  issueCsrfToken,
  sql,
  verifyCsrfToken,
  type SecurityRequest,
} from "./index.js";

const cfg = { csrfSecret: "test-secret" };
const base: SecurityRequest = { method: "POST", secure: true, headers: {}, sessionId: "s1" };

describe("TLS", () => {
  it("refuses plaintext and TLS below 1.2", () => {
    expect(isTransportAllowed({ secure: false })).toBe(false);
    expect(isTransportAllowed({ secure: true, tlsVersion: "TLSv1.1" })).toBe(false);
    expect(isTransportAllowed({ secure: true, tlsVersion: "TLSv1" })).toBe(false);
    expect(isTransportAllowed({ secure: true, tlsVersion: "TLSv1.2" })).toBe(true);
    expect(isTransportAllowed({ secure: true, tlsVersion: "TLSv1.3" })).toBe(true);
  });
});

describe("CSRF", () => {
  it("verifies only tokens issued for the same session", () => {
    const t = issueCsrfToken("k", "s1");
    expect(verifyCsrfToken("k", "s1", t)).toBe(true);
    expect(verifyCsrfToken("k", "s2", t)).toBe(false);
    expect(verifyCsrfToken("other", "s1", t)).toBe(false);
    expect(verifyCsrfToken("k", "s1", undefined)).toBe(false);
    expect(verifyCsrfToken("k", "s1", "garbage")).toBe(false);
  });

  it("requires a token on state-changing requests only", () => {
    expect(checkRequest({ ...base, method: "GET" }, cfg).ok).toBe(true);
    const r = checkRequest(base, cfg);
    expect(r).toMatchObject({ ok: false, status: 403, code: "invalid_csrf_token" });
    const token = issueCsrfToken("test-secret", "s1");
    expect(checkRequest({ ...base, headers: { "x-csrf-token": token } }, cfg).ok).toBe(true);
  });

  it("honours exempt paths", () => {
    const r = checkRequest(base, { ...cfg, csrfExemptPaths: ["/hook"], path: "/hook" });
    expect(r.ok).toBe(true);
  });
});

describe("input screening", () => {
  const token = issueCsrfToken("test-secret", "s1");
  const withBody = (body: unknown) =>
    checkRequest({ ...base, headers: { "x-csrf-token": token }, body }, cfg);

  it("rejects script content, including obfuscated forms and nested keys", () => {
    for (const s of [
      "<script>alert(1)</script>",
      "<img src=x onerror=alert(1)>",
      "JaVa\tScRiPt:alert(1)",
      "&lt;script&gt;alert(1)",
      "%3Cscript%3Ealert(1)",
      "&#x6A;avascript:alert(1)",
    ]) {
      expect(containsScript(s), s).toBe(true);
    }
    expect(withBody({ a: [{ b: "<script>" }] })).toMatchObject({ code: "unsafe_input" });
    expect(withBody({ "<script>": "x" })).toMatchObject({ code: "unsafe_input" });
  });

  it("rejects SQL structure changes but accepts ordinary names", () => {
    expect(withBody({ q: "x' OR '1'='1" }).ok).toBe(false);
    expect(withBody({ q: "1; DROP TABLE users" }).ok).toBe(false);
    expect(withBody({ q: "a UNION SELECT password FROM users" }).ok).toBe(false);
    expect(withBody({ name: "Marta O'Brien", note: "Rifa de 100 boletos" }).ok).toBe(true);
  });

  it("never flags plain alphanumeric text (fuzz)", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9 .,]{0,60}$/), (s) => {
        expect(findInputViolation(s)).toBeNull();
      }),
    );
  });

  it("always flags a script tag embedded in arbitrary text (fuzz)", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9 ]{0,20}$/),
        fc.stringMatching(/^[A-Za-z0-9 ]{0,20}$/),
        (a, b) => {
          expect(findInputViolation(`${a}<script>${b}`)).toBe("script");
        },
      ),
    );
  });
});

describe("parameterized queries", () => {
  it("builds placeholders and validates them", () => {
    const q = sql`SELECT * FROM t WHERE a = ${"x' OR 1=1"} AND b = ${2}`;
    expect(q.text).toBe("SELECT * FROM t WHERE a = $1 AND b = $2");
    expect(() => assertParameterized(q.text, q.values)).not.toThrow();
  });

  it("rejects embedded literals, comments and stacked statements", () => {
    expect(() => assertParameterized("SELECT 'x'", [])).toThrow();
    expect(() => assertParameterized("SELECT 1 -- c", [])).toThrow();
    expect(() => assertParameterized("SELECT 1; DROP TABLE t", [])).toThrow();
    expect(() => assertParameterized("SELECT $1, $2", ["a"])).toThrow();
  });
});

describe("output and headers", () => {
  it("encodes HTML metacharacters", () => {
    expect(encodeHtml(`<a href="x">&'</a>`)).not.toMatch(/[<>"']/);
  });

  it("emits CSP and HSTS on success and on rejection", () => {
    const ok = checkRequest({ ...base, method: "GET" }, cfg);
    const bad = checkRequest({ ...base, secure: false }, cfg);
    for (const r of [ok, bad]) {
      expect(r.headers["Content-Security-Policy"]).toContain("object-src 'none'");
      expect(r.headers["Strict-Transport-Security"]).toContain("max-age=");
    }
    expect(bad).toMatchObject({ ok: false, status: 426 });
    expect(contentSecurityPolicy("n")).toContain("'nonce-n'");
  });
});
