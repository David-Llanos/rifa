import { isCurrency, money } from "@raffle/shared";
import type { Country, Currency } from "@raffle/shared";
import type { SqlClient } from "../../db/migrations.js";
import type { PgPool } from "../inventory/pg-repository.js";
import type { RaffleStatus } from "../raffle/types.js";
import { isCustomizationOption } from "./fees.js";
import type { CustomizationOption, FeeItem } from "./fees.js";
import type {
  CustomizationState,
  FeePayment,
  FeeRaffle,
  FeeRepository,
  QueuedRefund,
} from "./fee-service.js";
import type { PaymentMethod, PaymentStatus } from "./types.js";

type Row = Record<string, unknown>;

interface StoredCustomization {
  option: CustomizationOption;
  enabled: boolean;
  paymentId?: string;
}

/** Tolerates malformed JSON by dropping unknown entries. */
function readCustomizations(value: unknown): StoredCustomization[] {
  if (!Array.isArray(value)) return [];
  const out: StoredCustomization[] = [];
  for (const v of value as unknown[]) {
    if (v === null || typeof v !== "object") continue;
    const c = v as Record<string, unknown>;
    if (!isCustomizationOption(c["option"])) continue;
    out.push({
      option: c["option"],
      enabled: c["enabled"] === true,
      ...(typeof c["paymentId"] === "string" ? { paymentId: c["paymentId"] } : {}),
    });
  }
  return out;
}

const PAYMENT_COLUMNS = `p.id, p.raffle_id, r.owner_id, p.purpose, p.customization_option,
  p.amount_minor, p.currency, p.provider, p.provider_reference, p.method, p.status,
  p.idempotency_key, p.created_at`;

function toPayment(r: Row): FeePayment {
  const currency = String(r["currency"]);
  if (!isCurrency(currency)) throw new Error(`unexpected currency ${currency}`);
  const item: FeeItem =
    r["purpose"] === "creation_fee"
      ? "creation_fee"
      : (String(r["customization_option"]) as CustomizationOption);
  return {
    id: String(r["id"]),
    raffleId: String(r["raffle_id"]),
    ownerId: String(r["owner_id"]),
    item,
    amount: money(BigInt(String(r["amount_minor"])), currency),
    provider: String(r["provider"]),
    providerRef: String(r["provider_reference"]),
    method: String(r["method"]) as PaymentMethod,
    status: String(r["status"]) as PaymentStatus,
    idempotencyKey: String(r["idempotency_key"]),
    createdAt: new Date(r["created_at"] as string | Date),
  };
}

const itemFilter = (item: FeeItem): [string, string | null] =>
  item === "creation_fee" ? ["creation_fee", null] : ["customization", item];

/** PostgreSQL `FeeRepository`. All values are bound parameters. */
export class PgFeeRepository implements FeeRepository<SqlClient> {
  constructor(private readonly pool: PgPool) {}

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      try {
        const out = await fn(client);
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    } finally {
      client.release();
    }
  }

  async lockRaffle(tx: SqlClient, raffleId: string): Promise<FeeRaffle | null> {
    const r = (
      await tx.query(
        `SELECT id, owner_id, status, country, currency, creation_fee_payment_id, customizations
         FROM raffle WHERE id = $1 FOR UPDATE`,
        [raffleId],
      )
    ).rows[0];
    if (!r) return null;
    return {
      id: String(r["id"]),
      ownerId: String(r["owner_id"]),
      status: String(r["status"]) as RaffleStatus,
      country: String(r["country"]) as Country,
      currency: String(r["currency"]) as Currency,
      creationFeePaid: r["creation_fee_payment_id"] != null,
      customizations: readCustomizations(r["customizations"]).map(
        (c): CustomizationState => ({ option: c.option, enabled: c.enabled }),
      ),
    };
  }

  private async writeCustomizations(
    tx: SqlClient,
    raffleId: string,
    update: (current: StoredCustomization[]) => StoredCustomization[],
  ): Promise<void> {
    const r = (
      await tx.query(`SELECT customizations FROM raffle WHERE id = $1 FOR UPDATE`, [raffleId])
    ).rows[0];
    if (!r) return;
    const next = update(readCustomizations(r["customizations"]));
    await tx.query(
      `UPDATE raffle SET customizations = $2::jsonb, updated_at = now() WHERE id = $1`,
      [raffleId, JSON.stringify(next)],
    );
  }

  setSelection(
    tx: SqlClient,
    raffleId: string,
    options: readonly CustomizationOption[],
  ): Promise<void> {
    return this.writeCustomizations(tx, raffleId, (current) => {
      const enabled = current.filter((c) => c.enabled);
      const added = options
        .filter((o) => !enabled.some((c) => c.option === o))
        .map((option) => ({ option, enabled: false }));
      return [...enabled, ...added];
    });
  }

  enableCustomization(
    tx: SqlClient,
    raffleId: string,
    option: CustomizationOption,
    paymentId: string,
  ): Promise<void> {
    return this.writeCustomizations(tx, raffleId, (current) =>
      current.map((c) => (c.option === option ? { option, enabled: true, paymentId } : c)),
    );
  }

  async markCreationFeePaid(tx: SqlClient, raffleId: string, paymentId: string): Promise<void> {
    await tx.query(
      `UPDATE raffle SET creation_fee_payment_id = $2, updated_at = now() WHERE id = $1`,
      [raffleId, paymentId],
    );
  }

  async findByIdempotencyKey(tx: SqlClient, key: string, since: Date): Promise<FeePayment | null> {
    const r = (
      await tx.query(
        `SELECT ${PAYMENT_COLUMNS} FROM payment p JOIN raffle r ON r.id = p.raffle_id
         WHERE p.idempotency_key = $1 AND p.created_at >= $2 AND p.purpose <> 'ticket'
         ORDER BY p.created_at DESC LIMIT 1`,
        [key, since.toISOString()],
      )
    ).rows[0];
    return r ? toPayment(r) : null;
  }

  async lockPayment(tx: SqlClient, paymentId: string): Promise<FeePayment | null> {
    const r = (
      await tx.query(
        `SELECT ${PAYMENT_COLUMNS} FROM payment p JOIN raffle r ON r.id = p.raffle_id
         WHERE p.id = $1 AND p.purpose <> 'ticket' FOR UPDATE OF p`,
        [paymentId],
      )
    ).rows[0];
    return r ? toPayment(r) : null;
  }

  async findSucceeded(tx: SqlClient, raffleId: string, item: FeeItem): Promise<FeePayment | null> {
    const [purpose, option] = itemFilter(item);
    const r = (
      await tx.query(
        `SELECT ${PAYMENT_COLUMNS} FROM payment p JOIN raffle r ON r.id = p.raffle_id
         WHERE p.raffle_id = $1 AND p.purpose = $2
           AND p.customization_option IS NOT DISTINCT FROM $3::text AND p.status = 'succeeded'
         ORDER BY p.created_at LIMIT 1`,
        [raffleId, purpose, option],
      )
    ).rows[0];
    return r ? toPayment(r) : null;
  }

  async insertPayment(tx: SqlClient, p: FeePayment): Promise<void> {
    const [purpose, option] = itemFilter(p.item);
    await tx.query(
      `INSERT INTO payment (id, raffle_id, amount_minor, currency, provider, provider_reference,
         method, status, idempotency_key, created_at, purpose, customization_option)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::text)`,
      [
        p.id,
        p.raffleId,
        p.amount.amountMinor.toString(),
        p.amount.currency,
        p.provider,
        p.providerRef,
        p.method,
        p.status,
        p.idempotencyKey,
        p.createdAt.toISOString(),
        purpose,
        option,
      ],
    );
  }

  async updatePayment(
    tx: SqlClient,
    paymentId: string,
    patch: { status: PaymentStatus; providerRef?: string },
  ): Promise<void> {
    await tx.query(
      `UPDATE payment SET status = $2, provider_reference = COALESCE($3::text, provider_reference)
       WHERE id = $1`,
      [paymentId, patch.status, patch.providerRef ?? null],
    );
  }

  async enqueueRefund(tx: SqlClient, refund: QueuedRefund): Promise<void> {
    await tx.query(
      `INSERT INTO refund (id, payment_id, amount_minor, currency, status, attempts, next_attempt_at)
       VALUES ($1, $2, $3, $4, 'pending', 0, $5)`,
      [
        refund.id,
        refund.paymentId,
        refund.amount.amountMinor.toString(),
        refund.amount.currency,
        refund.nextAttemptAt.toISOString(),
      ],
    );
  }

  async hasRefund(tx: SqlClient, paymentId: string): Promise<boolean> {
    const r = (
      await tx.query(`SELECT 1 FROM refund WHERE payment_id = $1 LIMIT 1`, [paymentId])
    ).rows[0];
    return r !== undefined;
  }
}
