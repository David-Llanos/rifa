/** Node `tls.createServer` / `https.createServer` options that refuse anything below TLS 1.2 (Requirement 15.7). */
export const TLS_SERVER_OPTIONS = { minVersion: "TLSv1.2" } as const;

/** Strict-Transport-Security value: one year, subdomains. */
export const HSTS_HEADER = "max-age=31536000; includeSubDomains";

const ACCEPTED_VERSIONS = new Set(["TLSv1.2", "TLSv1.3"]);

export interface TransportInfo {
  /** True when the connection is HTTPS (after trusted-proxy resolution by the host framework). */
  secure: boolean;
  /** Negotiated protocol, e.g. "TLSv1.2" (socket.getProtocol()). Unknown when terminated upstream. */
  tlsVersion?: string | undefined;
}

/**
 * Accept only encrypted connections negotiated at TLS 1.2 or later. When the version is unknown
 * (TLS terminated at the gateway, which enforces the minimum) a secure connection is accepted.
 */
export function isTransportAllowed(t: TransportInfo): boolean {
  if (!t.secure) return false;
  if (t.tlsVersion === undefined) return true;
  return ACCEPTED_VERSIONS.has(t.tlsVersion);
}
