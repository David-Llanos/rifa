import type { KycDocument, KycKind, GovernmentIdType } from "./types.js";

/** The provider must answer within 30 seconds (Requirement 13.3). */
export const KYC_PROVIDER_TIMEOUT_MS = 30_000;

export interface KycProviderRequest {
  subjectId: string;
  kind: KycKind;
  legalName: string;
  idType: GovernmentIdType;
  idNumber: string;
  documents: KycDocument[];
}

export type KycProviderResult =
  | { status: "approved"; providerRef: string }
  | { status: "rejected"; providerRef: string; reason: string };

/** Provider adapter port. Real provider SDKs live behind this interface. */
export interface KycProvider {
  verify(req: KycProviderRequest): Promise<KycProviderResult>;
}

export type KycCallOutcome =
  | { status: "approved"; providerRef: string }
  | { status: "rejected"; providerRef: string; reason: string }
  | { status: "timeout" }
  | { status: "unavailable" };

/**
 * Calls the provider with a timeout. A timeout or any provider failure maps to a non-approved
 * outcome so callers block publication and allow a retry (Requirement 13.3).
 */
export async function callProvider(
  provider: KycProvider,
  req: KycProviderRequest,
  timeoutMs: number = KYC_PROVIDER_TIMEOUT_MS,
): Promise<KycCallOutcome> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<KycCallOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
  });
  const call = provider.verify(req).then(
    (r): KycCallOutcome => r,
    (): KycCallOutcome => ({ status: "unavailable" }),
  );
  try {
    return await Promise.race([call, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type FakeKycBehavior =
  | { type: "approve" }
  | { type: "reject"; reason: string }
  | { type: "fail" }
  | { type: "hang" };

/** Scripted fake provider for tests. Behaviors are consumed in order; the last one repeats. */
export class FakeKycProvider implements KycProvider {
  readonly requests: KycProviderRequest[] = [];
  private n = 0;

  constructor(private readonly script: FakeKycBehavior[] = [{ type: "approve" }]) {}

  verify(req: KycProviderRequest): Promise<KycProviderResult> {
    this.requests.push(req);
    const b = this.script[Math.min(this.n, this.script.length - 1)] ?? { type: "approve" };
    this.n += 1;
    const providerRef = `fake-${this.n}`;
    switch (b.type) {
      case "approve":
        return Promise.resolve({ status: "approved", providerRef });
      case "reject":
        return Promise.resolve({ status: "rejected", providerRef, reason: b.reason });
      case "fail":
        return Promise.reject(new Error("provider unavailable"));
      case "hang":
        return new Promise<KycProviderResult>(() => undefined);
    }
  }
}
