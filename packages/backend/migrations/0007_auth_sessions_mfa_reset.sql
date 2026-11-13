-- 0007_auth_sessions_mfa_reset.sql
-- Sign-in lockout detail, TOTP enrolment, sessions, MFA challenges and password reset links.
-- Only SHA-256 hashes of session tokens, SMS codes and reset tokens are stored.

ALTER TABLE "user"
  ADD COLUMN sign_in_failure_times timestamptz[] NOT NULL DEFAULT ARRAY[]::timestamptz[],
  ADD COLUMN totp_secret bytea;

CREATE TABLE auth_session (
  token_hash  text        PRIMARY KEY,
  user_id     uuid        NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL
);
CREATE INDEX auth_session_user_idx ON auth_session (user_id);

CREATE TABLE auth_mfa_challenge (
  id          uuid        PRIMARY KEY,
  user_id     uuid        NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  type        text        NOT NULL CHECK (type IN ('sms', 'totp')),
  code_hash   text,
  expires_at  timestamptz NOT NULL,
  attempts    integer     NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5)
);

CREATE TABLE auth_password_reset (
  token_hash  text        PRIMARY KEY,
  user_id     uuid        NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
CREATE INDEX auth_password_reset_user_idx ON auth_password_reset (user_id);
