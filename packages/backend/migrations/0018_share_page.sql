-- Share_Page support (Requirements 16.1, 16.9, 16.10).
-- raffle.share_token already carries a UNIQUE constraint (0001); add a format guard so only
-- 128-bit base64url tokens (22 characters) can be stored.
ALTER TABLE raffle
  ADD CONSTRAINT raffle_share_token_format
  CHECK (share_token IS NULL OR share_token ~ '^[A-Za-z0-9_-]{22}$');

-- Custom branding purchased by the Owner (logo and theme colors).
CREATE TABLE raffle_branding (
  raffle_id       uuid PRIMARY KEY REFERENCES raffle (id),
  logo_url        text        NOT NULL,
  primary_color   text        NOT NULL CHECK (primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  secondary_color text        NOT NULL CHECK (secondary_color ~ '^#[0-9A-Fa-f]{6}$'),
  created_at      timestamptz NOT NULL DEFAULT now()
);
