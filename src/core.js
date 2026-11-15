// Pure logic, no Cloudflare APIs: validation, location rounding, aggregation. Tested in test/core.test.js.

export const CELL_DEG = 0.003; // ~330 m north-south; east-west shrinks with latitude, which is fine
export const KINDS = ["seen", "heard", "both"];
export const SOURCES = ["person", "listener"];
export const MAX_PER_10_MIN = 6; // per reporter (one phone or listener)
export const MAX_PER_ADDR_10_MIN = 60; // per network address: a crowd on one carrier shares an address
export const MAX_PEOPLE_PER_ADDR = 3; // per dot: made-up phone ids from one network can't pose as a crowd
export const KEEP_DAYS = 7;
export const WINDOWS_H = [1, 6, 24, 72];

/** Round a point to its grid cell. The exact point is never stored. */
export function cellOf(lat, lon) {
  const i = Math.floor(lat / CELL_DEG);
  const j = Math.floor(lon / CELL_DEG);
  return { cell: `${i}:${j}`, lat: +((i + 0.5) * CELL_DEG).toFixed(5), lon: +((j + 0.5) * CELL_DEG).toFixed(5) };
}

/** Validate a report body. Returns {ok:true, value} or {ok:false, error}. Unknown fields are ignored. */
export function parseReport(body, nowS) {
  if (!body || typeof body !== "object") return { ok: false, error: "send JSON" };
  const lat = Number(body.lat), lon = Number(body.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    return { ok: false, error: "lat and lon must be numbers on Earth" };
  const kind = body.kind ?? "seen";
  if (!KINDS.includes(kind)) return { ok: false, error: `kind must be one of ${KINDS.join(", ")}` };
  const source = body.source ?? "person";
  if (!SOURCES.includes(source)) return { ok: false, error: `source must be one of ${SOURCES.join(", ")}` };
  let conf = null;
  if (source === "listener") {
    conf = Number(body.confidence);
    if (!Number.isFinite(conf) || conf < 0 || conf > 1) return { ok: false, error: "listener reports need confidence 0..1" };
  }
  // a listener may report an event up to 10 minutes late (it reports when the sound ends); people report now
  let t = nowS;
  if (source === "listener" && body.time !== undefined) {
    const ts = Math.floor(Date.parse(body.time) / 1000);
    if (!Number.isFinite(ts) || ts > nowS + 60 || ts < nowS - 600) return { ok: false, error: "time must be within the last 10 minutes" };
    t = ts;
  }
  t = t - (t % 60);
  // a random id the phone or listener makes for itself, so many people behind one address count separately
  const device = body.device === undefined ? "" : String(body.device);
  if (device && !/^[A-Za-z0-9_-]{8,40}$/.test(device)) return { ok: false, error: "device must be 8–40 letters or digits" };
  return { ok: true, value: { ...cellOf(lat, lon), kind, source, conf, t, device } };
}

/** The part of an address that identifies one subscriber: IPv4 as is, IPv6 by its /64 network. */
export function addrKey(ip) {
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const full = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return full.slice(0, 4).map((x) => (parseInt(x, 16) || 0).toString(16)).join(":");
}

/** Rows -> one feature per cell: how many reports, from how many different reporters, latest time. */
export function aggregate(rows) {
  const by = new Map();
  for (const r of rows) {
    let c = by.get(r.cell);
    if (!c) {
      c = { cell: r.cell, lat: r.lat, lon: r.lon, reports: 0, reporters: new Map(), last: 0, seen: 0, heard: 0, listener: 0 };
      by.set(r.cell, c);
    }
    c.reports++;
    const a = r.addr ?? r.reporter;
    if (!c.reporters.has(a)) c.reporters.set(a, new Set());
    c.reporters.get(a).add(r.reporter);
    c.last = Math.max(c.last, r.t);
    if (r.kind === "seen" || r.kind === "both") c.seen++;
    if (r.kind === "heard" || r.kind === "both") c.heard++;
    if (r.source === "listener") c.listener++;
  }
  return {
    type: "FeatureCollection",
    features: [...by.values()].map((c) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [c.lon, c.lat] },
      properties: {
        cell: c.cell, reports: c.reports,
        reporters: [...c.reporters.values()].reduce((n, set) => n + Math.min(set.size, MAX_PEOPLE_PER_ADDR), 0), last: new Date(c.last * 1000).toISOString(),
        seen: c.seen, heard: c.heard, listener: c.listener,
      },
    })),
  };
}

export function windowHours(q) {
  const h = Number(q);
  return WINDOWS_H.includes(h) ? h : 6;
}
