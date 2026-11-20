-- Draw_Service: result retrieval and manual result bookkeeping (Requirements 9.11, 9.13, 19.11, 19.12).

-- Set when Admins were alerted that the result could not be retrieved within 2 hours of the draw time.
ALTER TABLE draw ADD COLUMN unavailable_alerted_at timestamptz;

-- Manual result entry and decision details (the approver column already exists in 0001).
ALTER TABLE draw ADD COLUMN manual_entered_at timestamptz;
ALTER TABLE draw ADD COLUMN manual_decided_by uuid REFERENCES "user" (id);
ALTER TABLE draw ADD COLUMN manual_decided_at timestamptz;

-- A decision (approval or rejection) can never be made by the Admin who entered the result.
ALTER TABLE draw ADD CONSTRAINT draw_two_person_decision
  CHECK (manual_decided_by IS NULL OR manual_decided_by <> manual_entered_by);
