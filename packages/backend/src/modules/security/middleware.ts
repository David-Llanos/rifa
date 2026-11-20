import { CSRF_HEADER_NAME, isStateChanging, verifyCsrfToken } from "./csrf.js";
import { newCspNonce, securityHeaders } from "./output.js";
import { findInputViolation } from "./sanitize.js";
import { isTransportAllowed } from "./tls.js";

/** Minimal request shape so the middleware works with any HTTP framework. */
export interface SecurityRequest {
  method: string;
  secure: boolean;
  tlsVersion?: string | undefined;
  /** Lower-cased header names. */
  headers: Readonly<Record<string, string | undefined>>;
  /** Session cookie value the CSRF token is bound to; undefined when unauthenticated. */
  sessionId?: string | undefined;
  query?: unknown;
  params?: unknown;
  body?: unknown;
}

export type SecurityRejection = "insecure_transport" | "invalid_csrf_token" | "unsafe_input";

export type SecurityResult =
  | { ok: true; headers: Record<string, string>; nonce: string }
  | { ok: false; status: number; code: SecurityRejection; headers: Record<string, string> };

export interface SecurityConfig {
  csrfSecret: string;
  /** Paths exempt from CSRF (e.g. signed provider webhooks, which authenticate by signature). */
  csrfExemptPaths?: readonly string[];
  path?: string;
}

/**
 * Per-request security gate (Requirements 15.7, 15.8): TLS 1.2+, CSRF token on state-changing
 * methods, then script and SQL-injection screening of query, params and body. Rejections never
 * echo the offending input.
 */
export function checkRequest(req: SecurityRequest, cfg: SecurityConfig): SecurityResult {
  const nonce = newCspNonce();
  const headers = securityHeaders(nonce);
  const reject = (status: number, code: SecurityRejection): SecurityResult => ({
    ok: false,
    status,
    code,
    headers,
  });

  if (!isTransportAllowed({ secure: req.secure, tlsVersion: req.tlsVersion })) {
    return reject(426, "insecure_transport");
  }

  const exempt = cfg.path !== undefined && (cfg.csrfExemptPaths ?? []).includes(cfg.path);
  if (
    isStateChanging(req.method) &&
    !exempt &&
    !verifyCsrfToken(cfg.csrfSecret, req.sessionId, req.headers[CSRF_HEADER_NAME])
  ) {
    return reject(403, "invalid_csrf_token");
  }

  if (findInputViolation([req.query, req.params, req.body])) {
    return reject(400, "unsafe_input");
  }

  return { ok: true, headers, nonce };
}
