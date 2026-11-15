-- hash of the network address alone (same daily salt), for a looser per-address limit;
-- `reporter` now also includes the device's own random id, so people sharing an address count separately
ALTER TABLE reports ADD COLUMN addr TEXT NOT NULL DEFAULT '';
CREATE INDEX reports_addr_t ON reports (addr, t);
