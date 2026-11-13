-- 0001_initial_schema.sql
-- Core PostgreSQL schema for the raffle platform.
-- Money columns are bigint minor units with a separate currency column.
-- No card data columns exist anywhere (card numbers and CVVs are never stored).
-- Personal data is encrypted at rest by the storage layer; KYC documents are
-- referenced by key only (documents_key_ref), never stored in the database.

CREATE TABLE "user" (
  id                   uuid PRIMARY KEY,
  email                varchar(254) NOT NULL,
  phone_e164           varchar(16)  NOT NULL,
  password_hash        text         NOT NULL,
  email_verified_at    timestamptz,
  roles                text[]       NOT NULL DEFAULT ARRAY['player']::text[],
  mfa_enabled          boolean      NOT NULL DEFAULT false,
  mfa_type             text CHECK (mfa_type IN ('sms', 'totp')),
  locale               text CHECK (locale IN ('en', 'es')),
  dob                  date,
  status               text         NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'suspended')),
  consent_policy_version text,
  consent_accepted_at  timestamptz,
  consent_marketing    boolean      NOT NULL DEFAULT false,
  consent_analytics    boolean      NOT NULL DEFAULT false,
  consent_show_name    boolean      NOT NULL DEFAULT false,
  notification_prefs   jsonb        NOT NULL DEFAULT '{}'::jsonb,
  failed_sign_ins      integer      NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  created_at           timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT user_mfa_type_required CHECK (mfa_enabled = false OR mfa_type IS NOT NULL)
);
CREATE UNIQUE INDEX user_email_lower_uq ON "user" (lower(email));
CREATE UNIQUE INDEX user_phone_uq ON "user" (phone_e164);

CREATE TABLE ruleset_version (
  id              uuid PRIMARY KEY,
  jurisdiction    text        NOT NULL,
  effective_from  timestamptz NOT NULL,
  rules           jsonb       NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (jurisdiction, effective_from)
);

CREATE TABLE raffle (
  id                    uuid PRIMARY KEY,
  owner_id              uuid        NOT NULL REFERENCES "user" (id),
  share_token           text UNIQUE,
  status                text        NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'pending_review', 'published', 'sales_closed',
                                            'awaiting_draw', 'completed', 'cancelled')),
  title_en              text,
  title_es              text,
  description_en        text,
  description_es        text,
  default_locale        text        NOT NULL DEFAULT 'en' CHECK (default_locale IN ('en', 'es')),
  prize_images          text[]      NOT NULL DEFAULT ARRAY[]::text[],
  prize_value_minor     bigint      NOT NULL CHECK (prize_value_minor > 0),
  country               text        NOT NULL CHECK (country IN ('CO', 'US')),
  currency              text        NOT NULL CHECK (currency IN ('COP', 'USD')),
  jurisdiction          text        NOT NULL,
  total_tickets         integer     NOT NULL CHECK (total_tickets BETWEEN 10 AND 100000),
  ticket_price_minor    bigint      NOT NULL CHECK (ticket_price_minor > 0),
  deadline              timestamptz NOT NULL,
  tz_name               text        NOT NULL,
  min_threshold         integer,
  max_per_player        integer,
  number_selection      boolean     NOT NULL DEFAULT false,
  early_closure         boolean     NOT NULL DEFAULT false,
  lottery_id            text        NOT NULL,
  draw_at               timestamptz NOT NULL,
  winning_rule          jsonb       NOT NULL,
  fallback_rule         text        NOT NULL DEFAULT 'redraw'
                          CHECK (fallback_rule IN ('lower', 'higher', 'redraw')),
  ruleset_version_id    uuid        NOT NULL REFERENCES ruleset_version (id),
  customizations        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT raffle_threshold_range CHECK (min_threshold IS NULL OR min_threshold BETWEEN 1 AND total_tickets),
  CONSTRAINT raffle_per_player_range CHECK (max_per_player IS NULL OR max_per_player BETWEEN 1 AND total_tickets),
  CONSTRAINT raffle_draw_after_deadline CHECK (draw_at > deadline)
);
CREATE INDEX raffle_owner_idx ON raffle (owner_id);
CREATE INDEX raffle_status_deadline_idx ON raffle (status, deadline);

CREATE TABLE "order" (
  id            uuid PRIMARY KEY,
  raffle_id     uuid        NOT NULL REFERENCES raffle (id),
  player_id     uuid        NOT NULL REFERENCES "user" (id),
  numbers       integer[]   NOT NULL,
  total_minor   bigint      NOT NULL CHECK (total_minor >= 0),
  currency      text        NOT NULL CHECK (currency IN ('COP', 'USD')),
  fees          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  status        text        NOT NULL DEFAULT 'reserved'
                  CHECK (status IN ('reserved', 'pending', 'paid', 'expired', 'refunded', 'under_review')),
  source        text        NOT NULL DEFAULT 'direct' CHECK (source IN ('direct', 'qr', 'referral')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_raffle_idx ON "order" (raffle_id);
CREATE INDEX order_player_idx ON "order" (player_id);

-- One row per ticket number; (raffle_id, number) is unique so a number can never be sold twice.
CREATE TABLE ticket (
  raffle_id                uuid        NOT NULL REFERENCES raffle (id),
  number                   integer     NOT NULL CHECK (number >= 1),
  status                   text        NOT NULL DEFAULT 'available'
                             CHECK (status IN ('available', 'reserved', 'sold', 'cancelled')),
  order_id                 uuid        REFERENCES "order" (id),
  reservation_expires_at   timestamptz,
  sold_at                  timestamptz,
  CONSTRAINT ticket_raffle_number_uq UNIQUE (raffle_id, number),
  CONSTRAINT ticket_reserved_has_expiry CHECK (status <> 'reserved' OR reservation_expires_at IS NOT NULL),
  CONSTRAINT ticket_sold_has_order CHECK (status <> 'sold' OR (order_id IS NOT NULL AND sold_at IS NOT NULL))
);
CREATE INDEX ticket_order_idx ON ticket (order_id);
CREATE INDEX ticket_reservation_expiry_idx ON ticket (reservation_expires_at) WHERE status = 'reserved';

CREATE TABLE payment (
  id                  uuid PRIMARY KEY,
  order_id            uuid REFERENCES "order" (id),
  raffle_id           uuid        NOT NULL REFERENCES raffle (id),
  amount_minor        bigint      NOT NULL CHECK (amount_minor >= 0),
  currency            text        NOT NULL CHECK (currency IN ('COP', 'USD')),
  provider            text        NOT NULL,
  provider_reference  text        NOT NULL,
  method              text        NOT NULL,
  status              text        NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'succeeded', 'failed', 'expired')),
  idempotency_key     text        NOT NULL,
  refunded_total_minor bigint     NOT NULL DEFAULT 0 CHECK (refunded_total_minor >= 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_provider_reference_uq UNIQUE (provider, provider_reference),
  CONSTRAINT payment_refund_cap CHECK (refunded_total_minor <= amount_minor)
);
CREATE INDEX payment_order_idx ON payment (order_id);
CREATE INDEX payment_raffle_idx ON payment (raffle_id);
CREATE INDEX payment_idempotency_idx ON payment (idempotency_key, created_at);

CREATE TABLE refund (
  id               uuid PRIMARY KEY,
  payment_id       uuid        NOT NULL REFERENCES payment (id),
  amount_minor     bigint      NOT NULL CHECK (amount_minor > 0),
  currency         text        NOT NULL CHECK (currency IN ('COP', 'USD')),
  status           text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  attempts         integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refund_payment_idx ON refund (payment_id);
CREATE INDEX refund_next_attempt_idx ON refund (next_attempt_at) WHERE status = 'pending';

CREATE TABLE draw (
  raffle_id        uuid PRIMARY KEY REFERENCES raffle (id),
  result           jsonb,
  source_ref       text,
  retrieved_at     timestamptz,
  derived_number   integer,
  winner_ticket    integer,
  manual_entered_by uuid REFERENCES "user" (id),
  manual_approved_by uuid REFERENCES "user" (id),
  manual_state     text CHECK (manual_state IN ('pending', 'applied', 'rejected')),
  -- Two-person approval: the approver must differ from the enterer.
  CONSTRAINT draw_two_person CHECK (manual_approved_by IS NULL OR manual_approved_by <> manual_entered_by)
);

CREATE TABLE payout (
  raffle_id             uuid PRIMARY KEY REFERENCES raffle (id),
  currency              text        NOT NULL CHECK (currency IN ('COP', 'USD')),
  sales_minor           bigint      NOT NULL,
  refunds_minor         bigint      NOT NULL DEFAULT 0,
  commission_minor      bigint      NOT NULL DEFAULT 0,
  provider_fees_minor   bigint      NOT NULL DEFAULT 0,
  taxes_withheld_minor  bigint      NOT NULL DEFAULT 0,
  disputed_hold_minor   bigint      NOT NULL DEFAULT 0,
  net_minor             bigint      NOT NULL,
  release_at            timestamptz NOT NULL,
  status                text        NOT NULL DEFAULT 'scheduled'
                          CHECK (status IN ('scheduled', 'released', 'failed', 'cancelled'))
);

CREATE TABLE audit_event (
  seq          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  actor        text        NOT NULL,
  action       text        NOT NULL,
  entity_type  text        NOT NULL,
  entity_id    text        NOT NULL,
  changes      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  prev_hash    text        NOT NULL,
  hash         text        NOT NULL UNIQUE
);
CREATE INDEX audit_event_entity_idx ON audit_event (entity_type, entity_id);
CREATE INDEX audit_event_at_idx ON audit_event (at DESC);

CREATE TABLE notification (
  id            uuid PRIMARY KEY,
  type          text        NOT NULL,
  channel       text        NOT NULL CHECK (channel IN ('email', 'sms', 'push')),
  recipient_id  uuid        NOT NULL REFERENCES "user" (id),
  status        text        NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'sent', 'delivered', 'failed')),
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_recipient_idx ON notification (recipient_id, at DESC);

CREATE TABLE kyc_record (
  id                 uuid PRIMARY KEY,
  subject_id         uuid        NOT NULL REFERENCES "user" (id),
  kind               text        NOT NULL CHECK (kind IN ('owner', 'player_age', 'winner')),
  status             text        NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'approved', 'rejected', 'error')),
  provider_ref       text        NOT NULL,
  documents_key_ref  text        NOT NULL,
  attempts           timestamptz[] NOT NULL DEFAULT ARRAY[]::timestamptz[],
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kyc_record_subject_idx ON kyc_record (subject_id, kind);

CREATE TABLE support_case (
  id            uuid PRIMARY KEY,
  number        text        NOT NULL UNIQUE,
  requester_id  uuid        NOT NULL REFERENCES "user" (id),
  type          text        NOT NULL,
  ref_type      text        NOT NULL CHECK (ref_type IN ('raffle', 'payment', 'draw')),
  ref_id        text        NOT NULL,
  description   text        NOT NULL,
  status        text        NOT NULL DEFAULT 'open',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_case_requester_idx ON support_case (requester_id);

-- Durable job queue. The unique key makes scheduling idempotent (exactly-once per occurrence).
CREATE TABLE job (
  id            uuid PRIMARY KEY,
  job_type      text        NOT NULL,
  entity_id     text        NOT NULL,
  occurrence    text        NOT NULL,
  run_at        timestamptz NOT NULL,
  status        text        NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts      integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error    text,
  payload       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_unique_key UNIQUE (job_type, entity_id, occurrence)
);
CREATE INDEX job_due_idx ON job (run_at) WHERE status = 'queued';
