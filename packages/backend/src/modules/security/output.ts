import { randomBytes } from "node:crypto";
import { HSTS_HEADER } from "./tls.js";

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
  "/": "&#47;",
};

/** HTML output encoding for text placed in element content or quoted attribute values. */
export function encodeHtml(text: string): string {
  return text.replace(/[&<>"'`/]/g, (c) => HTML_ESCAPES[c] ?? c);
}

/** Fresh per-response CSP nonce. */
export function newCspNonce(): string {
  return randomBytes(16).toString("base64");
}

/** Content-Security-Policy: same-origin only, scripts limited to the nonce, no framing or plugins. */
export function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

/** Response headers every reply must carry. */
export function securityHeaders(nonce: string): Record<string, string> {
  return {
    "Content-Security-Policy": contentSecurityPolicy(nonce),
    "Strict-Transport-Security": HSTS_HEADER,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY",
  };
}
