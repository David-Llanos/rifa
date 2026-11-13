-- Owner cancellation requests for raffles with sold tickets; the raffle stays active until an
-- Admin approves, and a documented reason of 1 to 500 characters is required (Requirement 8.8).
CREATE TABLE raffle_cancellation_request (
  id            uuid PRIMARY KEY,
  raffle_id     uuid        NOT NULL REFERENCES raffle (id),
  requested_by  uuid        NOT NULL REFERENCES "user" (id),
  reason        text        NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500),
  status        text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by    uuid        REFERENCES "user" (id),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz
);
-- At most one open request per raffle.
CREATE UNIQUE INDEX raffle_cancellation_pending_idx ON raffle_cancellation_request (raffle_id)
  WHERE status = 'pending';
