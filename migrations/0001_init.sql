-- One row per report. Locations are already rounded to a ~300 m grid cell before they get here,
-- and `reporter` is a hash of the sender's address with a salt that changes every day and is then
-- deleted, so it can count independent reporters for a day but can't be traced back afterwards.
CREATE TABLE reports (
  id INTEGER PRIMARY KEY,
  t INTEGER NOT NULL,          -- unix seconds, rounded to the minute
  cell TEXT NOT NULL,          -- grid cell id, "lat_index:lon_index"
  lat REAL NOT NULL,           -- cell centre
  lon REAL NOT NULL,
  kind TEXT NOT NULL,          -- seen | heard | both
  source TEXT NOT NULL,        -- person | listener
  reporter TEXT NOT NULL,
  conf REAL                    -- listener confidence 0..1, null for people
);
CREATE INDEX reports_t ON reports (t);
CREATE INDEX reports_reporter_t ON reports (reporter, t);

CREATE TABLE salts (
  day TEXT PRIMARY KEY,        -- YYYY-MM-DD (UTC)
  salt TEXT NOT NULL
);
