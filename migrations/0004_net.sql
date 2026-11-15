-- hash of the provider network (ASN) + IPv4 /24 or IPv6 /48, same daily salt: a dot is "confirmed" only
-- when people on two different ones report it
ALTER TABLE reports ADD COLUMN net TEXT NOT NULL DEFAULT '';
