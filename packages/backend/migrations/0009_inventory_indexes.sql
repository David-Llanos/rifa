-- 0009_inventory_indexes.sql
-- Supports the inventory service: listing available numbers for random assignment, per-status counts,
-- and per-player held-ticket counts.

CREATE INDEX IF NOT EXISTS ticket_raffle_status_idx ON ticket (raffle_id, status);
CREATE INDEX IF NOT EXISTS order_raffle_player_idx ON "order" (raffle_id, player_id);
