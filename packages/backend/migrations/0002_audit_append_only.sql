-- Audit trail hardening (Req 18.3, 18.4, 18.7, 18.8).
-- audit_event is append-only: UPDATE/DELETE/TRUNCATE are revoked and rejected by triggers.

ALTER TABLE audit_event ADD COLUMN raffle_id text;
CREATE INDEX audit_event_raffle_idx ON audit_event (raffle_id, at DESC);

ALTER TABLE audit_event
  ADD CONSTRAINT audit_event_hash_format CHECK (hash ~ '^[0-9a-f]{64}$' AND prev_hash ~ '^[0-9a-f]{64}$');

-- Rejected tampering attempts land here through the privileged trigger path (written even though the
-- attempted change is skipped). The audit service drains them into the hash chain as new audit events.
CREATE TABLE audit_rejected_attempt (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  db_user      text        NOT NULL DEFAULT session_user,
  operation    text        NOT NULL CHECK (operation IN ('UPDATE', 'DELETE')),
  target_seq   bigint,
  recorded_at  timestamptz
);
CREATE INDEX audit_rejected_attempt_pending_idx ON audit_rejected_attempt (id) WHERE recorded_at IS NULL;

-- Storage retention policy: audit events are kept at least 7 years from their timestamp (Req 18.7).
-- Deletion is impossible through the trigger below, so this value documents and bounds any archival job.
CREATE TABLE audit_retention_policy (
  id                  boolean PRIMARY KEY DEFAULT true CHECK (id),
  min_retention_years integer NOT NULL DEFAULT 7 CHECK (min_retention_years >= 7)
);
INSERT INTO audit_retention_policy DEFAULT VALUES;

COMMENT ON TABLE audit_event IS 'Append-only, hash-chained audit trail. Retain at least 7 years (see audit_retention_policy).';

CREATE FUNCTION audit_event_reject_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  -- Privileged path: runs as the function owner and records the attempt, then skips the row change.
  INSERT INTO audit_rejected_attempt (operation, target_seq) VALUES (TG_OP, OLD.seq);
  RAISE WARNING 'audit_event is append-only: % rejected for seq %', TG_OP, OLD.seq;
  RETURN NULL;
END
$fn$;

CREATE TRIGGER audit_event_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_reject_change();

CREATE FUNCTION audit_event_reject_truncate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  -- A statement-level trigger can only block by raising, which also rolls back any record of the attempt.
  RAISE EXCEPTION 'audit_event is append-only: TRUNCATE rejected';
END
$fn$;

CREATE TRIGGER audit_event_no_truncate
  BEFORE TRUNCATE ON audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit_event_reject_truncate();

REVOKE UPDATE, DELETE, TRUNCATE ON audit_event FROM PUBLIC;
REVOKE DELETE, TRUNCATE ON audit_rejected_attempt FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_retention_policy FROM PUBLIC;
