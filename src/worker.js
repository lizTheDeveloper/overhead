// overhead: a crowdsourced map of drone sightings. Cloudflare Worker + D1; the map page is static.
import { aggregate, KEEP_DAYS, MAX_PER_10_MIN, MAX_PER_ADDR_10_MIN, parseReport, windowHours } from "./core.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" };
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });

async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/** Today's salt (made on first use). Yesterday's is deleted by the cron, so old hashes can't be re-linked. */
async function salt(db, day) {
  const fresh = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await db.prepare("INSERT OR IGNORE INTO salts (day, salt) VALUES (?, ?)").bind(day, fresh).run();
  return (await db.prepare("SELECT salt FROM salts WHERE day = ?").bind(day).first("salt"));
}

async function postReport(req, env) {
  if ((req.headers.get("content-length") | 0) > 2048) return json({ error: "too big" }, 413);
  let body;
  try { body = await req.json(); } catch { return json({ error: "send JSON" }, 400); }
  const now = Math.floor(Date.now() / 1000);
  const p = parseReport(body, now);
  if (!p.ok) return json({ error: p.error }, 400);
  const r = p.value;
  const day = new Date(now * 1000).toISOString().slice(0, 10);
  const ip = req.headers.get("cf-connecting-ip") || "unknown";
  const s = await salt(env.DB, day);
  const addr = await sha256(`${s}|${ip}`);
  const reporter = await sha256(`${s}|${ip}|${r.device}`);
  const counts = await env.DB.prepare(
    "SELECT SUM(reporter = ?) AS mine, COUNT(*) AS all_ FROM reports WHERE addr = ? AND t > ?")
    .bind(reporter, addr, now - 600).first();
  if ((counts?.mine || 0) >= MAX_PER_10_MIN || (counts?.all_ || 0) >= MAX_PER_ADDR_10_MIN)
    return json({ error: "too many reports from you just now; try again in a few minutes" }, 429);
  await env.DB.prepare("INSERT INTO reports (t, cell, lat, lon, kind, source, reporter, addr, conf) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(r.t, r.cell, r.lat, r.lon, r.kind, r.source, reporter, addr, r.conf).run();
  return json({ ok: true, stored: { lat: r.lat, lon: r.lon, time: new Date(r.t * 1000).toISOString(), kind: r.kind } }, 201);
}

async function getReports(req, env, ctx, url) {
  const hours = windowHours(url.searchParams.get("hours"));
  // edge cache for 30 s: a flood of map views hits the cache, not the database
  const cache = caches.default;
  const key = new Request(`${url.origin}/api/reports?hours=${hours}`);
  const hit = await cache.match(key);
  if (hit) return hit;
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  const { results } = await env.DB.prepare("SELECT t, cell, lat, lon, kind, source, reporter FROM reports WHERE t > ?").bind(since).all();
  const fc = aggregate(results);
  fc.hours = hours;
  fc.generated = new Date().toISOString();
  const res = json(fc, 200, { "cache-control": "public, max-age=30" });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: { ...JSON_HEADERS, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type" } });
    if (url.pathname === "/api/report" && req.method === "POST") return postReport(req, env);
    if ((url.pathname === "/api/reports" || url.pathname === "/api/reports.geojson") && req.method === "GET") return getReports(req, env, ctx, url);
    return env.ASSETS.fetch(req);
  },
  async scheduled(_ev, env) {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("DELETE FROM reports WHERE t < ?").bind(now - KEEP_DAYS * 86400).run();
    await env.DB.prepare("DELETE FROM salts WHERE day < ?").bind(new Date(now * 1000).toISOString().slice(0, 10)).run();
  },
};
