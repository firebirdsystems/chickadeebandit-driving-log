CREATE TABLE IF NOT EXISTS app_potluck__events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  location TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_by_id TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS app_potluck__slots (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  name TEXT NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 1 CHECK (capacity > 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES app_potluck__events(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS app_potluck__claims (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  slot_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  member_name TEXT NOT NULL,
  note TEXT DEFAULT '',
  claimed_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES app_potluck__events(id) ON DELETE CASCADE,
  FOREIGN KEY (slot_id) REFERENCES app_potluck__slots(id) ON DELETE CASCADE,
  UNIQUE (slot_id, member_id)
);

CREATE INDEX IF NOT EXISTS app_potluck__events_date_idx
  ON app_potluck__events(date, archived);

CREATE INDEX IF NOT EXISTS app_potluck__slots_event_idx
  ON app_potluck__slots(event_id, sort_order);

CREATE INDEX IF NOT EXISTS app_potluck__claims_slot_idx
  ON app_potluck__claims(slot_id, claimed_at);
