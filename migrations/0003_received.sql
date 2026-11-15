-- when the server got the report: rate limits count this, since a listener's own time can be up to 10 minutes back
ALTER TABLE reports ADD COLUMN received INTEGER NOT NULL DEFAULT 0;
CREATE INDEX reports_addr_received ON reports (addr, received);
