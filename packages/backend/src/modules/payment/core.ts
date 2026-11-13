import {
  add,
  compare,
  err,
  multiply,
  ok,
  sum,
  zero,
  type Country,
  type Money,
  type Result,
} from "@raffle/shared";
import type {
  PaymentMethod,
  PaymentProviderAdapter,
  PaymentRecord,
  PaymentStatus,
} from "./types.js";

const METHODS_BY_COUNTRY: Readonly<Record<Country, readonly PaymentMethod[]>> = {
  CO: ["pse", "nequi", "card", "cash_network"],
  US: ["card", "apple_pay", "google_pay", "ach"],
};

/** Methods offered for a raffle country (Requirements 6.1, 6.2). */
export function methodsFor(country: Country): PaymentMethod[] {
  return [...METHODS_BY_COUNTRY[country]];
}

/**
 * Total charged to the player: price x qty plus displayed fees, in the raffle currency
 * (Requirement 6.4). The result is also the displayed total.
 */
export function orderTotal(price: Money, qty: number, fees: readonly Money[]): Money {
  if (!Number.isInteger(qty) || qty < 0) {
    throw new RangeError("qty must be a non-negative integer");
  }
  if (price.amountMinor < 0n) throw new RangeError("price must not be negative");
  for (const fee of fees) {
    if (fee.amountMinor < 0n) throw new RangeError("fees must not be negative");
  }
  return add(multiply(price, qty), sum(fees, price.currency));
}

// ---------------------------------------------------------------------------
// Provider selection (Requirement 3.4: no-provider handling)
// ---------------------------------------------------------------------------

export type ProviderSelectionError = {
  readonly code: "no_provider_available";
  readonly country: Country;
};

/** Pick an adapter for the country (and method, if given); never charges when none exists. */
export function selectProvider(
  adapters: readonly PaymentProviderAdapter[],
  country: Country,
  method?: PaymentMethod,
): Result<PaymentProviderAdapter, ProviderSelectionError> {
  const found = adapters.find(
    (a) => a.country === country && (method === undefined || a.methods.includes(method)),
  );
  return found ? ok(found) : err({ code: "no_provider_available", country });
}

// ---------------------------------------------------------------------------
// Payment record (Requirement 6.9)
// ---------------------------------------------------------------------------

export interface NewPaymentInput {
  readonly id: string;
  readonly orderId?: string;
  readonly raffleId: string;
  readonly amount: Money;
  readonly provider: string;
  readonly providerRef: string;
  readonly method: PaymentMethod;
  readonly status?: PaymentStatus;
  readonly idempotencyKey: string;
  readonly createdAt: Date;
}

export function createPaymentRecord(input: NewPaymentInput): PaymentRecord {
  if (input.amount.amountMinor <= 0n) throw new RangeError("amount must be positive");
  const { status = "pending", orderId, ...rest } = input;
  return {
    ...rest,
    ...(orderId === undefined ? {} : { orderId }),
    status,
    refundedTotal: zero(input.amount.currency),
  };
}

/** Cumulative refunds must never exceed the amount paid. */
export function canRefund(payment: PaymentRecord, requested: Money): boolean {
  if (requested.currency !== payment.amount.currency) return false;
  if (requested.amountMinor <= 0n) return false;
  if (payment.status !== "succeeded") return false;
  return compare(add(payment.refundedTotal, requested), payment.amount) <= 0;
}

// ---------------------------------------------------------------------------
// Idempotency (Requirement 6.7)
// ---------------------------------------------------------------------------

export const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ExistingResult<T = unknown> {
  readonly key: string;
  readonly recordedAt: Date;
  readonly result: T;
}

export interface IdemStore<T = unknown> {
  get(key: string): ExistingResult<T> | undefined;
  set(entry: ExistingResult<T>): void;
}

export class InMemoryIdemStore<T = unknown> implements IdemStore<T> {
  private readonly entries = new Map<string, ExistingResult<T>>();
  get(key: string): ExistingResult<T> | undefined {
    return this.entries.get(key);
  }
  set(entry: ExistingResult<T>): void {
    this.entries.set(entry.key, entry);
  }
}

export type IdempotencyError = { readonly code: "idempotency_key_required" };

/** A key is required: non-empty after trimming. */
export function validateIdempotencyKey(
  key: string | null | undefined,
): Result<string, IdempotencyError> {
  if (typeof key !== "string" || key.trim().length === 0) {
    return err({ code: "idempotency_key_required" });
  }
  return ok(key);
}

/** Original result if the key was recorded within the previous 24 hours, else null. */
export function resolveIdempotent<T>(
  store: IdemStore<T>,
  key: string,
  now: Date,
): ExistingResult<T> | null {
  const existing = store.get(key);
  if (!existing) return null;
  const age = now.getTime() - existing.recordedAt.getTime();
  return age <= IDEMPOTENCY_WINDOW_MS ? existing : null;
}

export type IdempotentOutcome<T> = { readonly replayed: boolean; readonly result: T };

/**
 * Run `charge` at most once per key within the 24 hour window. A missing key is rejected
 * before `charge` runs; a repeated key returns the original result without a new charge.
 */
export async function runIdempotent<T>(
  store: IdemStore<T>,
  key: string | null | undefined,
  now: Date,
  charge: () => Promise<T>,
): Promise<Result<IdempotentOutcome<T>, IdempotencyError>> {
  const valid = validateIdempotencyKey(key);
  if (!valid.ok) return valid;
  const existing = resolveIdempotent(store, valid.value, now);
  if (existing) return ok({ replayed: true, result: existing.result });
  const result = await charge();
  store.set({ key: valid.value, recordedAt: now, result });
  return ok({ replayed: false, result });
}
