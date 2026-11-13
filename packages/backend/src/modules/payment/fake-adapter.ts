import type { Country, Money } from "@raffle/shared";
import { methodsFor } from "./core.js";
import type {
  ChargeRequest,
  ChargeResult,
  HeaderBag,
  PaymentMethod,
  PaymentProviderAdapter,
  PayoutAccount,
  PayoutResult,
  RefundResult,
  WebhookEvent,
} from "./types.js";

/**
 * In-memory sandbox adapter for tests only. It holds no credentials, calls no network, and
 * never sees card data. Charges for the same idempotency key return the same reference.
 */
export class FakePaymentAdapter implements PaymentProviderAdapter {
  readonly name: string;
  readonly country: Country;
  readonly methods: readonly PaymentMethod[];
  readonly charges: ChargeRequest[] = [];
  private readonly refs = new Map<string, ChargeResult>();
  private declineNext = false;

  constructor(country: Country, name = `fake-${country.toLowerCase()}`) {
    this.country = country;
    this.name = name;
    this.methods = methodsFor(country);
  }

  failNextCharge(): void {
    this.declineNext = true;
  }

  createCharge(req: ChargeRequest): Promise<ChargeResult> {
    const cached = this.refs.get(req.idempotencyKey);
    if (cached) return Promise.resolve(cached);
    this.charges.push(req);
    const providerRef = `fake_${this.name}_${this.charges.length}`;
    let result: ChargeResult;
    if (this.declineNext) {
      this.declineNext = false;
      result = { kind: "declined", providerRef, reason: "declined" };
    } else if (req.method === "card") {
      result = {
        kind: "hosted_fields",
        providerRef,
        status: "pending",
        clientToken: `tok_${providerRef}`,
      };
    } else {
      result = {
        kind: "redirect",
        providerRef,
        status: "pending",
        redirectUrl: `https://sandbox.invalid/pay/${providerRef}`,
      };
    }
    this.refs.set(req.idempotencyKey, result);
    return Promise.resolve(result);
  }

  refund(ref: string, _amount: Money, idemKey: string): Promise<RefundResult> {
    return Promise.resolve({ providerRef: `refund_${ref}_${idemKey}`, status: "completed" });
  }

  payout(_account: PayoutAccount, _amount: Money, idemKey: string): Promise<PayoutResult> {
    return Promise.resolve({ providerRef: `payout_${idemKey}`, status: "completed" });
  }

  /** Test format: JSON body {eventId, providerRef, type, occurredAt}; x-fake-signature "valid". */
  verifyWebhook(headers: HeaderBag, body: Uint8Array): WebhookEvent {
    if (headers["x-fake-signature"] !== "valid") throw new Error("invalid webhook signature");
    const raw = JSON.parse(new TextDecoder().decode(body)) as Omit<WebhookEvent, "occurredAt"> & {
      occurredAt: string;
    };
    return { ...raw, occurredAt: new Date(raw.occurredAt) };
  }
}
