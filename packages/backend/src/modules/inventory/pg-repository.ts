import type { SqlClient } from "../../db/migrations.js";
import type { RaffleStatus } from "../raffle/types.js";
import type { InventoryRepository, NewOrder } from "./repository.js";
import type { InventoryRaffle, TicketCounts } from "./types.js";

/** A pooled connection that can be released after the transaction. */
export interface PooledClient extends SqlClient {
  release(): void;
}

export interface PgPool {
  connect(): Promise<PooledClient>;
}

/**
 * PostgreSQL implementation. Reservation is one conditional UPDATE (`status = 'available'`); the unique
 * `(raffle_id, number)` key and the row locks taken by the UPDATE guarantee a single winner under
 * concurrency (Req 4.4, 25.3, 25.7). All values are bound parameters.
 */
export class PgInventoryRepository implements InventoryRepository<SqlClient> {
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

  async getRaffleShared(tx: SqlClient, raffleId: string): Promise<InventoryRaffle | null> {
    const r = (
      await tx.query(
        `SELECT status, total_tickets, ticket_price_minor, currency, max_per_player, deadline
         FROM raffle WHERE id = $1 FOR SHARE`,
        [raffleId],
      )
    ).rows[0];
    if (!r) return null;
    return {
      status: r["status"] as RaffleStatus,
      totalTickets: Number(r["total_tickets"]),
      ticketPriceMinor: BigInt(String(r["ticket_price_minor"])),
      currency: String(r["currency"]),
      maxPerPlayer: r["max_per_player"] == null ? null : Number(r["max_per_player"]),
      deadline: new Date(r["deadline"] as string | Date),
    };
  }

  async lockPlayer(tx: SqlClient, raffleId: string, playerId: string): Promise<void> {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `inv:${raffleId}:${playerId}`,
    ]);
  }

  async heldCount(tx: SqlClient, raffleId: string, playerId: string): Promise<number> {
    const r = (
      await tx.query(
        `SELECT count(*) AS n FROM ticket t JOIN "order" o ON o.id = t.order_id
         WHERE t.raffle_id = $1 AND o.player_id = $2 AND t.status IN ('reserved', 'sold')`,
        [raffleId, playerId],
      )
    ).rows[0];
    return Number(r?.["n"] ?? 0);
  }

  async createOrder(tx: SqlClient, o: NewOrder): Promise<void> {
    await tx.query(
      `INSERT INTO "order" (id, raffle_id, player_id, numbers, total_minor, currency, status)
       VALUES ($1, $2, $3, $4::integer[], $5, $6, 'reserved')`,
      [o.id, o.raffleId, o.playerId, o.numbers, o.totalMinor.toString(), o.currency],
    );
  }

  async reserveNumbers(
    tx: SqlClient,
    raffleId: string,
    orderId: string,
    numbers: number[],
    expiresAt: Date,
  ): Promise<number[]> {
    const res = await tx.query(
      `UPDATE ticket SET status = 'reserved', order_id = $3, reservation_expires_at = $4
       WHERE raffle_id = $1 AND number = ANY($2::integer[]) AND status = 'available'
       RETURNING number`,
      [raffleId, numbers, orderId, expiresAt.toISOString()],
    );
    return res.rows.map((r) => Number(r["number"]));
  }

  async abandonOrder(tx: SqlClient, orderId: string): Promise<void> {
    await tx.query(
      `UPDATE ticket SET status = 'available', order_id = NULL, reservation_expires_at = NULL
       WHERE order_id = $1 AND status = 'reserved'`,
      [orderId],
    );
    await tx.query(`DELETE FROM "order" WHERE id = $1`, [orderId]);
  }

  async listAvailable(tx: SqlClient, raffleId: string): Promise<number[]> {
    const res = await tx.query(
      "SELECT number FROM ticket WHERE raffle_id = $1 AND status = 'available' ORDER BY number",
      [raffleId],
    );
    return res.rows.map((r) => Number(r["number"]));
  }

  async releaseExpired(tx: SqlClient, now: Date): Promise<number> {
    const res = await tx.query(
      `WITH released AS (
         UPDATE ticket SET status = 'available', order_id = NULL, reservation_expires_at = NULL
         WHERE status = 'reserved' AND reservation_expires_at <= $1
         RETURNING number, order_id
       )
       SELECT count(*) AS n FROM released`,
      [now.toISOString()],
    );
    // Orders that no longer hold any ticket and were never paid are marked expired.
    await tx.query(
      `UPDATE "order" o SET status = 'expired'
       WHERE o.status = 'reserved'
         AND NOT EXISTS (SELECT 1 FROM ticket t WHERE t.order_id = o.id)`,
    );
    return Number(res.rows[0]?.["n"] ?? 0);
  }

  async cancelAll(tx: SqlClient, raffleId: string): Promise<number> {
    const res = await tx.query(
      `UPDATE ticket SET status = 'cancelled', reservation_expires_at = NULL
       WHERE raffle_id = $1 AND status <> 'cancelled' RETURNING number`,
      [raffleId],
    );
    return res.rows.length;
  }

  async counts(tx: SqlClient, raffleId: string): Promise<TicketCounts> {
    const res = await tx.query(
      "SELECT status, count(*) AS n FROM ticket WHERE raffle_id = $1 GROUP BY status",
      [raffleId],
    );
    const out: TicketCounts = { available: 0, reserved: 0, sold: 0, cancelled: 0 };
    for (const r of res.rows) {
      const s = String(r["status"]) as keyof TicketCounts;
      if (s in out) out[s] = Number(r["n"]);
    }
    return out;
  }

  async seedTickets(tx: SqlClient, raffleId: string, total: number): Promise<number> {
    const res = await tx.query(
      `INSERT INTO ticket (raffle_id, number)
       SELECT $1, g FROM generate_series(1, $2::integer) AS g
       ON CONFLICT (raffle_id, number) DO NOTHING RETURNING number`,
      [raffleId, total],
    );
    return res.rows.length;
  }
}
