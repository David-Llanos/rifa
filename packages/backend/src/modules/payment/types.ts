import type { Country, Money } from "@raffle/shared";

/** Payment methods offered per country (Requirements 6.1, 6.2). */
export const PAYMENT_METHODS = [
  "pse",
  "nequi",
  "card",
  "cash_network",
  "apple_pay",
  "google_pay",
  "ach",
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Payment statuses (Requirement 6.9). */
export const PAYMENT_STATUSES = ["pending", "succeeded", "failed", "expired"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export interface PaymentRecord {
  readonly id: string;
  readonly orderId?: string;
  readonly raffleId: string;
  readonly amount: Money;
  readonly provider: string;
  readonly providerRef: string;
  readonly method: PaymentMethod;
  readonly status: PaymentStatus;
  readonly idempotencyKey: string;
  readonly createdAt: Date;
  readonly refundedTotal: Money;
}

/**
 * Charge request. The platform never handles card numbers or security codes: the client
 * completes entry in provider hosted fields or a provider redirect and only opaque tokens
 * or return URLs cross this boundary (Requirement 6.3).
 */
export interface ChargeRequest {
  readonly amount: Money;
  readonly method: PaymentMethod;
  readonly country: Country;
  readonly reference: string;
  readonly idempotencyKey: string;
  readonly returnUrl?: string;
}

export type ChargeResult =
  | {
      readonly kind: "hosted_fields";
      readonly providerRef: string;
      readonly status: PaymentStatus;
      readonly clientToken: string;
    }
  | {
      readonly kind: "redirect";
      readonly providerRef: string;
      readonly status: PaymentStatus;
      readonly redirectUrl: string;
    }
  | { readonly kind: "declined"; readonly providerRef: string; readonly reason: string };

export interface RefundResult {
  readonly providerRef: string;
  readonly status: "completed" | "pending" | "failed";
}

export interface PayoutAccount {
  readonly country: Country;
  readonly holderName: string;
  /** Opaque provider-side identifier; never raw bank credentials. */
  readonly accountRef: string;
}

export interface PayoutResult {
  readonly providerRef: string;
  readonly status: "completed" | "pending" | "failed";
}

export interface WebhookEvent {
  readonly eventId: string;
  readonly providerRef: string;
  readonly type: "payment.succeeded" | "payment.failed" | "payment.expired" | "chargeback";
  readonly occurredAt: Date;
}

/** Minimal header bag so adapters stay decoupled from the HTTP framework. */
export type HeaderBag = Readonly<Record<string, string | undefined>>;

export interface PaymentProviderAdapter {
  readonly name: string;
  readonly country: Country;
  readonly methods: readonly PaymentMethod[];
  /** Hosted fields or redirect only; no raw card data in the request. */
  createCharge(req: ChargeRequest): Promise<ChargeResult>;
  refund(ref: string, amount: Money, idemKey: string): Promise<RefundResult>;
  payout(account: PayoutAccount, amount: Money, idemKey: string): Promise<PayoutResult>;
  verifyWebhook(headers: HeaderBag, body: Uint8Array): WebhookEvent;
}
