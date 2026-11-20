-- Ticket list and CSV export (Requirements 4.5, 4.6).
-- The Owner's ticket list shows the buyer name of each Sold Ticket; "user" had no name column.
ALTER TABLE "user"
  ADD COLUMN display_name varchar(100)
  CHECK (display_name IS NULL OR length(btrim(display_name)) > 0);
