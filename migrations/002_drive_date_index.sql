-- drive_log orders by date DESC under LIMIT 300. `date` is declared in
-- db_plaintext_columns, so it sorts meaningfully at rest and can be indexed.
-- The existing (driver_id, date) index cannot serve an unfiltered ordering.
-- Practice drives accumulate for the life of the permit, so this table grows.
CREATE INDEX IF NOT EXISTS app_driving_log__drives_date_idx
  ON app_driving_log__drives(date);
