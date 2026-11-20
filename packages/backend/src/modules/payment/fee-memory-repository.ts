import type { CustomizationOption, FeeItem } from "./fees.js";
import type {
  CustomizationState,
  FeePayment,
  FeeRaffle,
  FeeRepository,
  QueuedRefund,
} from "./fee-service.js";
import type { PaymentStatus } from "./types.js";

interface State {
  raffles: Map<string, FeeRaffle>;
  payments: Map<string, FeePayment>;
  refunds: QueuedRefund[];
}

export interface MemoryFeeTx {
  readonly memory: true;
}

/** In-memory `FeeRepository`: serialized transactions; a throw restores the previous state. */
export class MemoryFeeRepository implements FeeRepository<MemoryFeeTx> {
  private state: State = { raffles: new Map(), payments: new Map(), refunds: [] };
  private tail: Promise<unknown> = Promise.resolve();
  private readonly tx: MemoryFeeTx = { memory: true };

  addRaffle(raffle: FeeRaffle): void {
    this.state.raffles.set(raffle.id, raffle);
  }

  raffle(id: string): FeeRaffle | undefined {
    return this.state.raffles.get(id);
  }

  payments(): FeePayment[] {
    return [...this.state.payments.values()];
  }

  refunds(): QueuedRefund[] {
    return [...this.state.refunds];
  }

  transaction<T>(fn: (tx: MemoryFeeTx) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const snapshot = structuredClone(this.state);
      try {
        return await fn(this.tx);
      } catch (e) {
        this.state = snapshot;
        throw e;
      }
    };
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => undefined);
    return result;
  }

  lockRaffle(_tx: MemoryFeeTx, raffleId: string): Promise<FeeRaffle | null> {
    return Promise.resolve(this.state.raffles.get(raffleId) ?? null);
  }

  setSelection(
    _tx: MemoryFeeTx,
    raffleId: string,
    options: readonly CustomizationOption[],
  ): Promise<void> {
    const r = this.state.raffles.get(raffleId);
    if (r) {
      const enabled = r.customizations.filter((c) => c.enabled);
      const added: CustomizationState[] = options
        .filter((o) => !enabled.some((c) => c.option === o))
        .map((option) => ({ option, enabled: false }));
      this.state.raffles.set(raffleId, { ...r, customizations: [...enabled, ...added] });
    }
    return Promise.resolve();
  }

  findByIdempotencyKey(_tx: MemoryFeeTx, key: string, since: Date): Promise<FeePayment | null> {
    const found = [...this.state.payments.values()].find(
      (p) => p.idempotencyKey === key && p.createdAt.getTime() >= since.getTime(),
    );
    return Promise.resolve(found ?? null);
  }

  lockPayment(_tx: MemoryFeeTx, paymentId: string): Promise<FeePayment | null> {
    return Promise.resolve(this.state.payments.get(paymentId) ?? null);
  }

  findSucceeded(_tx: MemoryFeeTx, raffleId: string, item: FeeItem): Promise<FeePayment | null> {
    const found = [...this.state.payments.values()].find(
      (p) => p.raffleId === raffleId && p.item === item && p.status === "succeeded",
    );
    return Promise.resolve(found ?? null);
  }

  insertPayment(_tx: MemoryFeeTx, payment: FeePayment): Promise<void> {
    this.state.payments.set(payment.id, payment);
    return Promise.resolve();
  }

  updatePayment(
    _tx: MemoryFeeTx,
    paymentId: string,
    patch: { status: PaymentStatus; providerRef?: string },
  ): Promise<void> {
    const p = this.state.payments.get(paymentId);
    if (p) this.state.payments.set(paymentId, { ...p, ...patch });
    return Promise.resolve();
  }

  markCreationFeePaid(_tx: MemoryFeeTx, raffleId: string): Promise<void> {
    const r = this.state.raffles.get(raffleId);
    if (r) this.state.raffles.set(raffleId, { ...r, creationFeePaid: true });
    return Promise.resolve();
  }

  enableCustomization(
    _tx: MemoryFeeTx,
    raffleId: string,
    option: CustomizationOption,
  ): Promise<void> {
    const r = this.state.raffles.get(raffleId);
    if (r) {
      this.state.raffles.set(raffleId, {
        ...r,
        customizations: r.customizations.map((c) =>
          c.option === option ? { option, enabled: true } : c,
        ),
      });
    }
    return Promise.resolve();
  }

  enqueueRefund(_tx: MemoryFeeTx, refund: QueuedRefund): Promise<void> {
    this.state.refunds.push(refund);
    return Promise.resolve();
  }

  hasRefund(_tx: MemoryFeeTx, paymentId: string): Promise<boolean> {
    return Promise.resolve(this.state.refunds.some((r) => r.paymentId === paymentId));
  }
}
