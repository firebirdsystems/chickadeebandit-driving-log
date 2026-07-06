-- Immutable supervised-drive entries. Written ONLY through the hub's
-- append-only-records endpoint (endpoint_only row policy), so a logged drive can
-- never be silently edited or deleted — the append-only property is what makes the
-- log tamper-evident and DMV-credible. Mistakes are handled by an adult appending a
-- 'void' note, never by mutating history.
CREATE TABLE IF NOT EXISTS app_driving_log__drives (
  id            TEXT PRIMARY KEY,
  driver_id     TEXT NOT NULL,
  supervisor_id TEXT NOT NULL,
  date          TEXT NOT NULL,
  minutes       INTEGER NOT NULL DEFAULT 0,
  night_minutes INTEGER NOT NULL DEFAULT 0,
  weather       TEXT NOT NULL DEFAULT 'clear',
  road          TEXT NOT NULL DEFAULT 'residential',
  notes         TEXT NOT NULL DEFAULT '',
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

-- Two-party countersignature state (driver attests the entry is accurate; the
-- supervising parent countersigns). Written ONLY by the hub's api/agree endpoint
-- (endpoint_only) so neither party can forge the other's signature via raw SQL.
-- A drive is "certified" iff its certification row is 'locked'.
CREATE TABLE IF NOT EXISTS app_driving_log__certifications (
  id                TEXT PRIMARY KEY,   -- same id as the drive it certifies
  driver_id         TEXT NOT NULL,
  supervisor_id     TEXT NOT NULL,
  driver_attested   INTEGER NOT NULL DEFAULT 0,
  supervisor_signed INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'pending',   -- pending | locked
  locked_at         TEXT,
  updated_at        TEXT NOT NULL
);

-- Immutable adult-only annotations on a drive: supervisor observations
-- (kind='note') or a correction that voids a mistaken entry (kind='void'). A
-- voided drive is excluded from certified totals but never erased.
CREATE TABLE IF NOT EXISTS app_driving_log__notes (
  id         TEXT PRIMARY KEY,
  drive_id   TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'note',   -- note | void
  body       TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Per-driver state requirement goal (hours). Each teen owns their own row;
-- adults may set it on their behalf (adults_bypass).
CREATE TABLE IF NOT EXISTS app_driving_log__goals (
  member_id        TEXT PRIMARY KEY,
  total_minutes    INTEGER NOT NULL DEFAULT 3000,   -- 50h default
  night_minutes    INTEGER NOT NULL DEFAULT 600,    -- 10h default
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS app_driving_log__drives_driver_idx ON app_driving_log__drives(driver_id, date);
CREATE INDEX IF NOT EXISTS app_driving_log__notes_drive_idx ON app_driving_log__notes(drive_id);
