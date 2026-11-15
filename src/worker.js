// overhead: a crowdsourced map of drone sightings. Cloudflare Worker + D1; the map page is static.
import { addrKey, aggregate, teleported, KEEP_DAYS, MAX_PER_10_MIN, MAX_PER_ADDR_10_MIN, parseReport, windowHours } from "./core.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const OPEN = { "access-control-allow-origin": "*" }; // reading the open data from anywhere is fine; writing isn't
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });
const MAX_BODY = 2048;

/** Read at most MAX_BODY bytes, however the body is sent (a Content-Length can lie or be missing). */
async function readCapped(req) {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MAX_BODY) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const buf = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
  return new TextDecoder().decode(buf);
}

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

/** Cloudflare Turnstile: is this a person in a browser? Off until TURNSTILE_SECRET is set. */
async function humanCheck(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return true;
  if (typeof token !== "string" || !token || token.length > 4096) return false;
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  form.append("remoteip", ip);
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    return (await r.json()).success === true;
  } catch {
    return false;
  }
}

async function postReport(req, env) {
  // only this site's own page (or a script with no browser Origin, like the relay) may write: another site
  // can't make its visitors' browsers file reports from their addresses
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) return json({ error: "reports must come from this site" }, 403);
  if (!(req.headers.get("content-type") || "").startsWith("application/json")) return json({ error: "send JSON" }, 415);
  const text = await readCapped(req);
  if (text === null) return json({ error: "too big" }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return json({ error: "send JSON" }, 400); }
  const now = Math.floor(Date.now() / 1000);
  const p = parseReport(body, now);
  if (!p.ok) return json({ error: p.error }, 400);
  const r = p.value;
  // listening devices need a key the site's operator gave them; without one, nobody can pose as a device
  if (r.source === "listener") {
    const keys = (env.LISTENER_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
    const key = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!key || !keys.includes(key)) return json({ error: "listener reports need a key from this site's operator" }, 401);
  }
  const day = new Date(now * 1000).toISOString().slice(0, 10);
  const ip = req.headers.get("cf-connecting-ip") || "unknown";
  if (r.source === "person" && !(await humanCheck(env, body.turnstile, ip)))
    return json({ error: "the bot check didn't pass; reload the page and try again" }, 403);
  const s = await salt(env.DB, day);
  const addr = await sha256(`${s}|${addrKey(ip)}`);
  const reporter = await sha256(`${s}|${ip}|${r.device}`);
  const counts = await env.DB.prepare(
    "SELECT SUM(reporter = ?) AS mine, COUNT(*) AS all_ FROM reports WHERE addr = ? AND received > ?")
    .bind(reporter, addr, now - 600).first();
  if ((counts?.mine || 0) >= MAX_PER_10_MIN || (counts?.all_ || 0) >= MAX_PER_ADDR_10_MIN)
    return json({ error: "too many reports from you just now; try again in a few minutes" }, 429);
  const prev = await env.DB.prepare("SELECT lat, lon, t FROM reports WHERE reporter = ? AND received > ? ORDER BY received DESC LIMIT 1")
    .bind(reporter, now - 86400).first();
  // impossibly far from this reporter's last report: treat it as a correction (a misplaced pin), and drop their
  // recent reports, so one reporter can never have reports in two places at once
  let moved = false;
  if (teleported(prev, r)) {
    await env.DB.prepare("DELETE FROM reports WHERE reporter = ? AND received > ?").bind(reporter, now - 3600).run();
    moved = true;
  }
  await env.DB.prepare("INSERT INTO reports (t, received, cell, lat, lon, kind, source, reporter, addr, conf) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(r.t, now, r.cell, r.lat, r.lon, r.kind, r.source, reporter, addr, r.conf).run();
  return json({ ok: true, moved, stored: { lat: r.lat, lon: r.lon, time: new Date(r.t * 1000).toISOString(), kind: r.kind } }, 201);
}

async function getReports(req, env, ctx, url) {
  const hours = windowHours(url.searchParams.get("hours"));
  // edge cache for 30 s: a flood of map views hits the cache, not the database
  const cache = caches.default;
  const key = new Request(`${url.origin}/api/reports?hours=${hours}`);
  const hit = await cache.match(key);
  if (hit) return hit;
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  const { results } = await env.DB.prepare("SELECT t, cell, lat, lon, kind, source, reporter, addr FROM reports WHERE t > ?").bind(since).all();
  const fc = aggregate(results);
  fc.hours = hours;
  fc.generated = new Date().toISOString();
  const res = json(fc, 200, { ...OPEN, "cache-control": "public, max-age=30" });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/api/report" && req.method === "POST") return postReport(req, env);
    if (url.pathname === "/api/config" && req.method === "GET")
      return json({ turnstileSiteKey: env.TURNSTILE_SITEKEY || null }, 200, { "cache-control": "public, max-age=300" });
    if ((url.pathname === "/api/reports" || url.pathname === "/api/reports.geojson") && req.method === "GET") return getReports(req, env, ctx, url);
    return env.ASSETS.fetch(req);
  },
  async scheduled(_ev, env) {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("DELETE FROM reports WHERE t < ?").bind(now - KEEP_DAYS * 86400).run();
    await env.DB.prepare("DELETE FROM salts WHERE day < ?").bind(new Date(now * 1000).toISOString().slice(0, 10)).run();
  },
};
