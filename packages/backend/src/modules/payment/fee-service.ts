import { err, ok, systemClock } from "@raffle/shared";
import type { Clock, Country, Currency, Money, Result } from "@raffle/shared";
import type { RaffleStatus } from "../raffle/types.js";
import {
  IDEMPOTENCY_WINDOW_MS,
  methodsFor,
  selectProvider,
  validateIdempotencyKey,
} from "./core.js";
import { feeFor, isCustomizationOption, parseFeeSchedule, quoteFees } from "./fees.js";
import type { CustomizationOption, FeeItem, FeeQuote } from "./fees.js";
import type {
  ChargeResult,
  PaymentMethod,
  PaymentProviderAdapter,
  PaymentStatus,
} from "./types.js";

/** The Owner gets a success or failure result within 30 seconds (Requirement 3.2). */
export const FEE_CHARGE_TIMEOUT_MS = 30_000;

export interface CustomizationState {
  readonly option: CustomizationOption;
  /** Enabled only after its fee payment succeeded (Requirement 3.5). */
  readonly enabled: boolean;
}

/** The raffle fields the fee service needs, loaded under a row lock. */
export interface FeeRaffle {
  readonly id: string;
  readonly ownerId: string;
  readonly status: RaffleStatus;
  readonly country: Country;
  readonly currency: Currency;
  readonly creationFeePaid: boolean;
  readonly customizations: readonly CustomizationState[];
}

export interface FeePayment {
  readonly id: string;
  readonly raffleId: string;
  readonly ownerId: string;
  readonly item: FeeItem;
  /** Fixed when the payment is initiated; later fee changes never alter it (Requirement 3.8). */
  readonly amount: Money;
  readonly provider: string;
  readonly providerRef: string;
  readonly method: PaymentMethod;
  readonly status: PaymentStatus;
  readonly idempotencyKey: string;
  readonly createdAt: Date;
}

export interface QueuedRefund {
  readonly id: string;
  readonly paymentId: string;
  readonly amount: Money;
  readonly nextAttemptAt: Date;
}

/** Persistence port. Every method except `transaction` runs inside the caller's transaction. */
export interface FeeRepository<Tx> {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Loads the raffle with a row lock, so fee state changes for one raffle are serialized. */
  lockRaffle(tx: Tx, raffleId: string): Promise<FeeRaffle | null>;
  /** Replaces the Owner's selected options; enabled options stay enabled. */
  setSelection(tx: Tx, raffleId: string, options: readonly CustomizationOption[]): Promise<void>;
  findByIdempotencyKey(tx: Tx, key: string, since: Date): Promise<FeePayment | null>;
  /** Loads the payment with a row lock. */
  lockPayment(tx: Tx, paymentId: string): Promise<FeePayment | null>;
  findSucceeded(tx: Tx, raffleId: string, item: FeeItem): Promise<FeePayment | null>;
  insertPayment(tx: Tx, payment: FeePayment): Promise<void>;
  updatePayment(
    tx: Tx,
    paymentId: string,
    patch: { status: PaymentStatus; providerRef?: string },
  ): Promise<void>;
  markCreationFeePaid(tx: Tx, raffleId: string, paymentId: string): Promise<void>;
  enableCustomization(
    tx: Tx,
    raffleId: string,
    option: CustomizationOption,
    paymentId: string,
  ): Promise<void>;
  /** Queues a full refund; the refund job (task 7.6) executes, retries and notifies the Owner. */
  enqueueRefund(tx: Tx, refund: QueuedRefund): Promise<void>;
  hasRefund(tx: Tx, paymentId: string): Promise<boolean>;
}

/** Reads the current fee configuration (`fee.creation_minor`, `fee.customization_minor`). */
export interface FeeScheduleSource {
  read(): Promise<{ creation: unknown; customization: unknown }>;
}

export interface FeeReceipt {
  readonly ownerId: string;
  readonly raffleId: string;
  readonly paymentId: string;
  readonly item: FeeItem;
  readonly amount: Money;
  readonly paidAt: Date;
}

/** Emails the receipt; the notification module delivers it within 1 minute (Requirement 3.7). */
export interface FeeReceiptSender {
  sendReceipt(receipt: FeeReceipt): Promise<void>;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface FeeServiceDeps<Tx> {
  repo: FeeRepository<Tx>;
  fees: FeeScheduleSource;
  adapters: readonly PaymentProviderAdapter[];
  receipts: FeeReceiptSender;
  newId: () => string;
  clock?: Clock;
  timers?: Timers;
  chargeTimeoutMs?: number;
}

export type FeeError =
  | { code: "not_found" }
  | { code: "forbidden" }
  | { code: "not_allowed_in_status"; status: RaffleStatus }
  | { code: "already_paid"; item: FeeItem }
  | { code: "not_selected"; item: FeeItem }
  | { code: "invalid_option"; option: string }
  | { code: "fee_config_invalid" }
  | { code: "no_provider_available"; country: Country }
  | { code: "idempotency_key_required" }
  | { code: "idempotency_key_conflict" };

export interface ConfirmationView extends FeeQuote {
  /** False when no provider serves the raffle country; the client shows Requirement 3.4's message. */
  readonly providerAvailable: boolean;
  readonly methods: readonly PaymentMethod[];
}

export type FeePaymentOutcome =
  | {
      readonly status: "succeeded";
      readonly paymentId: string;
      readonly amount: Money;
      /** False when the receipt could not be queued; the payment itself stands. */
      readonly receiptSent: boolean;
      readonly replayed: boolean;
    }
  | {
      readonly status: "action_required";
      readonly paymentId: string;
      readonly amount: Money;
      readonly next:
        | { readonly kind: "hosted_fields"; readonly clientToken: string }
        | { readonly kind: "redirect"; readonly redirectUrl: string };
      readonly replayed: boolean;
    }
  | {
      readonly status: "pending";
      readonly paymentId: string;
      readonly amount: Money;
      readonly replayed: boolean;
    }
  | {
      readonly status: "failed";
      readonly paymentId: string;
      readonly amount: Money;
      /** Provider decline reason, `timeout`, `provider_error` or `duplicate_refunded`. */
      readonly reason: string;
      readonly replayed: boolean;
    };

export interface PayFeeInput {
  readonly method: PaymentMethod;
  readonly idempotencyKey: string;
  readonly returnUrl?: string;
}

export interface FeeService<Tx> {
  /** Stores the Owner's customization selection; it is kept when a payment fails (Requirement 3.6). */
  selectCustomizations(
    ownerId: string,
    raffleId: string,
    options: readonly string[],
  ): Promise<Result<void, FeeError>>;
  /** Fees due, each in the raffle currency, and their total (Requirement 3.1). */
  confirmationView(ownerId: string, raffleId: string): Promise<Result<ConfirmationView, FeeError>>;
  /** Charges one fee item at the amount in force now (Requirements 3.2 to 3.6, 3.8). */
  payFee(
    ownerId: string,
    raffleId: string,
    item: FeeItem,
    input: PayFeeInput,
  ): Promise<Result<FeePaymentOutcome, FeeError>>;
  /** Final provider outcome for a pending or timed-out payment (webhook or return path). Idempotent. */
  completeFeePayment(
    paymentId: string,
    outcome: { status: "succeeded" } | { status: "failed"; reason: string },
  ): Promise<FeePaymentOutcome | null>;
  /** Paid Creation_Fee check for submission (draft to pending_review). */
  isCreationFeePaid(tx: Tx, raffleId: string): Promise<boolean>;
  /**
   * Called inside the cancellation transaction. Queues a full Creation_Fee refund when the raffle was
   * cancelled before publication, i.e. from draft, which cannot have Sold Tickets (Requirement 3.9).
   */
  refundCreationFeeOnCancel(
    tx: Tx,
    raffleId: string,
    cancelledAt: Date,
    previousStatus: RaffleStatus,
  ): Promise<boolean>;
}

const CUSTOMIZABLE_STATUSES: readonly RaffleStatus[] = ["draft", "pending_review", "published"];

class FeeRejection extends Error {
  constructor(readonly error: FeeError) {
    super(error.code);
    this.name = "FeeRejection";
  }
}

function outcomeOf(p: FeePayment, replayed: boolean): FeePaymentOutcome {
  const base = { paymentId: p.id, amount: p.amount, replayed };
  switch (p.status) {
    case "succeeded":
      return { status: "succeeded", ...base, receiptSent: true };
    case "pending":
      return { status: "pending", ...base };
    case "expired":
      return { status: "failed", ...base, reason: "timeout" };
    case "failed":
      return { status: "failed", ...base, reason: "declined" };
  }
}

export function createFeeService<Tx>(deps: FeeServiceDeps<Tx>): FeeService<Tx> {
  const { repo, receipts, newId } = deps;
  const clock = deps.clock ?? systemClock;
  const timers = deps.timers ?? defaultTimers;
  const timeoutMs = deps.chargeTimeoutMs ?? FEE_CHARGE_TIMEOUT_MS;

  async function run<T>(fn: (tx: Tx) => Promise<T>): Promise<Result<T, FeeError>> {
    try {
      return ok(await repo.transaction(fn));
    } catch (e) {
      if (e instanceof FeeRejection) return err(e.error);
      throw e;
    }
  }

  async function ownedRaffle(tx: Tx, ownerId: string, raffleId: string): Promise<FeeRaffle> {
    const raffle = await repo.lockRaffle(tx, raffleId);
    if (!raffle) throw new FeeRejection({ code: "not_found" });
    if (raffle.ownerId !== ownerId) throw new FeeRejection({ code: "forbidden" });
    return raffle;
  }

  function itemsDue(raffle: FeeRaffle): FeeItem[] {
    const due: FeeItem[] = [];
    if (raffle.status === "draft" && !raffle.creationFeePaid) due.push("creation_fee");
    if (CUSTOMIZABLE_STATUSES.includes(raffle.status)) {
      for (const c of raffle.customizations) if (!c.enabled) due.push(c.option);
    }
    return due;
  }

  /** Throws a rejection unless `item` can be paid for this raffle now. */
  function assertPayable(raffle: FeeRaffle, item: FeeItem): void {
    if (item === "creation_fee") {
      if (raffle.creationFeePaid) throw new FeeRejection({ code: "already_paid", item });
      if (raffle.status !== "draft") {
        throw new FeeRejection({ code: "not_allowed_in_status", status: raffle.status });
      }
      return;
    }
    if (!CUSTOMIZABLE_STATUSES.includes(raffle.status)) {
      throw new FeeRejection({ code: "not_allowed_in_status", status: raffle.status });
    }
    const state = raffle.customizations.find((c) => c.option === item);
    if (!state) throw new FeeRejection({ code: "not_selected", item });
    if (state.enabled) throw new FeeRejection({ code: "already_paid", item });
  }

  async function currentSchedule() {
    const raw = await deps.fees.read();
    const parsed = parseFeeSchedule(raw.creation, raw.customization);
    if (!parsed.ok) throw new FeeRejection({ code: "fee_config_invalid" });
    return parsed.value;
  }

  async function charge(
    adapter: PaymentProviderAdapter,
    payment: FeePayment,
    country: Country,
    returnUrl: string | undefined,
  ): Promise<ChargeResult | "timeout" | "error"> {
    let handle: unknown = null;
    const timeout = new Promise<"timeout">((resolve) => {
      handle = timers.setTimeout(() => resolve("timeout"), timeoutMs);
    });
    try {
      return await Promise.race([
        adapter.createCharge({
          amount: payment.amount,
          method: payment.method,
          country,
          reference: payment.id,
          idempotencyKey: payment.idempotencyKey,
          ...(returnUrl === undefined ? {} : { returnUrl }),
        }),
        timeout,
      ]);
    } catch {
      return "error";
    } finally {
      timers.clearTimeout(handle);
    }
  }

  /** Records a success; a second success for an already-paid item is refunded in full. */
  async function settleSuccess(paymentId: string): Promise<FeePaymentOutcome | null> {
    const now = clock.now();
    const settled = await repo.transaction(async (tx) => {
      const payment = await repo.lockPayment(tx, paymentId);
      if (!payment) return null;
      if (payment.status === "succeeded") return { payment, fresh: false, duplicate: false };
      const raffle = await repo.lockRaffle(tx, payment.raffleId);
      const paidAlready =
        payment.item === "creation_fee"
          ? raffle?.creationFeePaid === true
          : raffle?.customizations.some((c) => c.option === payment.item && c.enabled) === true;
      await repo.updatePayment(tx, paymentId, { status: "succeeded" });
      const done: FeePayment = { ...payment, status: "succeeded" };
      if (paidAlready || !raffle) {
        if (!(await repo.hasRefund(tx, paymentId))) {
          await repo.enqueueRefund(tx, {
            id: newId(),
            paymentId,
            amount: payment.amount,
            nextAttemptAt: now,
          });
        }
        return { payment: done, fresh: false, duplicate: true };
      }
      if (payment.item === "creation_fee") {
        await repo.markCreationFeePaid(tx, raffle.id, paymentId);
      } else {
        await repo.enableCustomization(tx, raffle.id, payment.item, paymentId);
      }
      return { payment: done, fresh: true, duplicate: false };
    });
    if (!settled) return null;
    const { payment, fresh, duplicate } = settled;
    if (duplicate) {
      return {
        status: "failed",
        paymentId,
        amount: payment.amount,
        reason: "duplicate_refunded",
        replayed: false,
      };
    }
    let receiptSent = true;
    if (fresh) {
      try {
        await receipts.sendReceipt({
          ownerId: payment.ownerId,
          raffleId: payment.raffleId,
          paymentId,
          item: payment.item,
          amount: payment.amount,
          paidAt: now,
        });
      } catch {
        receiptSent = false;
      }
    }
    return {
      status: "succeeded",
      paymentId,
      amount: payment.amount,
      receiptSent,
      replayed: !fresh,
    };
  }

  /** Records a failure or timeout. Never touches the raffle, so it stays in draft (Requirement 3.3). */
  async function settleFailure(
    paymentId: string,
    status: "failed" | "expired",
    reason: string,
    providerRef?: string,
  ): Promise<FeePaymentOutcome | null> {
    return repo.transaction(async (tx) => {
      const payment = await repo.lockPayment(tx, paymentId);
      if (!payment) return null;
      if (payment.status === "succeeded") return outcomeOf(payment, true);
      await repo.updatePayment(tx, paymentId, {
        status,
        ...(providerRef === undefined ? {} : { providerRef }),
      });
      return { status: "failed", paymentId, amount: payment.amount, reason, replayed: false };
    });
  }

  return {
    async selectCustomizations(ownerId, raffleId, options) {
      const bad = options.find((o) => !isCustomizationOption(o));
      if (bad !== undefined) return err({ code: "invalid_option", option: bad });
      return run(async (tx) => {
        const raffle = await ownedRaffle(tx, ownerId, raffleId);
        if (!CUSTOMIZABLE_STATUSES.includes(raffle.status)) {
          throw new FeeRejection({ code: "not_allowed_in_status", status: raffle.status });
        }
        await repo.setSelection(tx, raffleId, [...new Set(options as CustomizationOption[])]);
      });
    },

    async confirmationView(ownerId, raffleId) {
      return run(async (tx) => {
        const raffle = await ownedRaffle(tx, ownerId, raffleId);
        const quote = quoteFees(await currentSchedule(), raffle.currency, itemsDue(raffle));
        const methods = methodsFor(raffle.country).filter(
          (m) => selectProvider(deps.adapters, raffle.country, m).ok,
        );
        return { ...quote, providerAvailable: methods.length > 0, methods };
      });
    },

    async payFee(ownerId, raffleId, item, input) {
      const key = validateIdempotencyKey(input.idempotencyKey);
      if (!key.ok) return err({ code: "idempotency_key_required" });
      const now = clock.now();

      type Started =
        | { kind: "replay"; outcome: FeePaymentOutcome }
        | {
            kind: "charge";
            payment: FeePayment;
            adapter: PaymentProviderAdapter;
            country: Country;
          };
      const started = await run(async (tx): Promise<Started> => {
        // Lock first: concurrent requests for this raffle (including same-key retries) serialize here.
        const raffle = await ownedRaffle(tx, ownerId, raffleId);
        // A repeated key within 24 hours returns the original result without a new charge.
        const prior = await repo.findByIdempotencyKey(
          tx,
          key.value,
          new Date(now.getTime() - IDEMPOTENCY_WINDOW_MS),
        );
        if (prior) {
          if (prior.raffleId !== raffleId || prior.item !== item || prior.ownerId !== ownerId) {
            throw new FeeRejection({ code: "idempotency_key_conflict" });
          }
          return { kind: "replay", outcome: outcomeOf(prior, true) };
        }
        assertPayable(raffle, item);
        // No provider: nothing is charged and the raffle stays as it is (Requirement 3.4).
        const provider = selectProvider(deps.adapters, raffle.country, input.method);
        if (!provider.ok) {
          throw new FeeRejection({ code: "no_provider_available", country: raffle.country });
        }
        const id = newId();
        const payment: FeePayment = {
          id,
          raffleId,
          ownerId,
          item,
          amount: feeFor(await currentSchedule(), item, raffle.currency),
          provider: provider.value.name,
          providerRef: `pending:${id}`,
          method: input.method,
          status: "pending",
          idempotencyKey: key.value,
          createdAt: now,
        };
        await repo.insertPayment(tx, payment);
        return { kind: "charge", payment, adapter: provider.value, country: raffle.country };
      });
      if (!started.ok) return started;
      if (started.value.kind === "replay") return ok(started.value.outcome);

      const { payment, adapter, country } = started.value;
      const result = await charge(adapter, payment, country, input.returnUrl);
      const fail = async (status: "failed" | "expired", reason: string, ref?: string) => {
        const out = await settleFailure(payment.id, status, reason, ref);
        return ok(
          out ?? {
            status: "failed" as const,
            paymentId: payment.id,
            amount: payment.amount,
            reason,
            replayed: false,
          },
        );
      };
      if (result === "timeout") return fail("expired", "timeout");
      if (result === "error") return fail("failed", "provider_error");
      if (result.kind === "declined") return fail("failed", result.reason, result.providerRef);

      await repo.transaction((tx) =>
        repo.updatePayment(tx, payment.id, { status: "pending", providerRef: result.providerRef }),
      );
      if (result.status === "succeeded") {
        const out = await settleSuccess(payment.id);
        if (out) return ok(out);
      }
      if (result.status === "failed" || result.status === "expired") {
        return fail(result.status, "declined");
      }
      const next =
        result.kind === "hosted_fields"
          ? ({ kind: "hosted_fields", clientToken: result.clientToken } as const)
          : ({ kind: "redirect", redirectUrl: result.redirectUrl } as const);
      return ok({
        status: "action_required",
        paymentId: payment.id,
        amount: payment.amount,
        next,
        replayed: false,
      });
    },

    completeFeePayment(paymentId, outcome) {
      return outcome.status === "succeeded"
        ? settleSuccess(paymentId)
        : settleFailure(paymentId, "failed", outcome.reason);
    },

    async isCreationFeePaid(tx, raffleId) {
      return (await repo.lockRaffle(tx, raffleId))?.creationFeePaid === true;
    },

    async refundCreationFeeOnCancel(tx, raffleId, cancelledAt, previousStatus) {
      if (previousStatus !== "draft") return false;
      const paid = await repo.findSucceeded(tx, raffleId, "creation_fee");
      if (!paid || (await repo.hasRefund(tx, paid.id))) return false;
      await repo.enqueueRefund(tx, {
        id: newId(),
        paymentId: paid.id,
        amount: paid.amount,
        nextAttemptAt: cancelledAt,
      });
      return true;
    },
  };
}
