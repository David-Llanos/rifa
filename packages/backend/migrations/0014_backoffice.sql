-- Back_Office: decisions, suspensions, configuration with change records, retry failures, raffle reports
-- (Requirements 15.10, 19.4 to 19.10).

-- Review decisions, suspensions and reinstatements with reason, Admin identity and timestamp.
CREATE TABLE backoffice_action (
  id            uuid PRIMARY KEY,
  kind          text        NOT NULL CHECK (kind IN ('raffle_review', 'suspend', 'reinstate')),
  subject_kind  text        NOT NULL CHECK (subject_kind IN ('raffle', 'owner', 'player')),
  subject_id    text        NOT NULL,
  decision      text        NOT NULL,
  reason        text        NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 1000),
  admin_id      uuid        NOT NULL REFERENCES "user" (id),
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX backoffice_action_subject_idx ON backoffice_action (subject_kind, subject_id, at DESC);

-- Raffle suspension flag (raffles keep their lifecycle status while suspended).
ALTER TABLE raffle ADD COLUMN suspended_at timestamptz;

-- Current platform configuration (fees, commission, lotteries, rule sets, reservation timeout default).
CREATE TABLE platform_config (
  key         text PRIMARY KEY,
  value       jsonb       NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE config_change (
  id          uuid PRIMARY KEY,
  key         text        NOT NULL,
  previous    jsonb,
  new_value   jsonb       NOT NULL,
  admin_id    uuid        NOT NULL REFERENCES "user" (id),
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX config_change_key_idx ON config_change (key, at DESC);

CREATE TABLE backoffice_retry_failure (
  id         uuid PRIMARY KEY,
  item_kind  text        NOT NULL CHECK (item_kind IN ('refund', 'payout')),
  item_id    text        NOT NULL,
  admin_id   uuid        NOT NULL REFERENCES "user" (id),
  at         timestamptz NOT NULL DEFAULT now(),
  message    text        NOT NULL
);

CREATE TABLE raffle_report (
  id            uuid PRIMARY KEY,
  raffle_id     uuid        NOT NULL REFERENCES raffle (id),
  reporter_id   uuid        NOT NULL REFERENCES "user" (id),
  reason        text        NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 1000),
  status        text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'responded')),
  response      text        CHECK (response IS NULL OR char_length(btrim(response)) BETWEEN 1 AND 1000),
  responded_by  uuid        REFERENCES "user" (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  responded_at  timestamptz
);
CREATE INDEX raffle_report_status_idx ON raffle_report (status, created_at);
