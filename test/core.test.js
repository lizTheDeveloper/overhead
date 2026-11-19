import { test } from "node:test";
import assert from "node:assert/strict";
import { addrKey, netKey, aggregate, cellOf, kmBetween, teleported, parseReport, windowHours, CELL_DEG } from "../src/core.js";

const NOW = 1_800_000_000;

test("a point is stored only as its cell centre, within one cell of where it was", () => {
  const c = cellOf(37.77493, -122.41942);
  assert.ok(Math.abs(c.lat - 37.77493) <= CELL_DEG / 2 + 1e-9);
  assert.ok(Math.abs(c.lon - -122.41942) <= CELL_DEG / 2 + 1e-9);
  assert.notEqual(c.lat, 37.77493);
  assert.deepEqual(cellOf(37.77493, -122.41942), cellOf(37.7750, -122.4195)); // neighbours collapse
});

test("a person's report gets the current minute and no confidence", () => {
  const r = parseReport({ lat: 37.7, lon: -122.4, kind: "heard" }, NOW + 37);
  assert.equal(r.ok, true);
  assert.equal(r.value.t % 60, 0);
  assert.ok(r.value.t <= NOW + 37 && r.value.t > NOW + 37 - 60);
  assert.equal(r.value.conf, null);
  assert.equal(r.value.source, "person");
});

test("bad reports are refused with a reason", () => {
  for (const b of [null, "x", { lat: 100, lon: 0 }, { lat: 0, lon: "a" }, { lat: 0, lon: 0, kind: "ufo" },
    { lat: 0, lon: 0, source: "satellite" }, { lat: 0, lon: 0, source: "listener" },
    { lat: 0, lon: 0, source: "listener", confidence: 2 }]) {
    const r = parseReport(b, NOW);
    assert.equal(r.ok, false, JSON.stringify(b));
    assert.ok(r.error);
  }
});

test("a listener can report up to 10 minutes late, not from the future or long ago", () => {
  const iso = (s) => new Date(s * 1000).toISOString();
  assert.equal(parseReport({ lat: 1, lon: 1, source: "listener", confidence: 0.8, time: iso(NOW - 300) }, NOW).ok, true);
  assert.equal(parseReport({ lat: 1, lon: 1, source: "listener", confidence: 0.8, time: iso(NOW - 3600) }, NOW).ok, false);
  assert.equal(parseReport({ lat: 1, lon: 1, source: "listener", confidence: 0.8, time: iso(NOW + 3600) }, NOW).ok, false);
});

test("aggregation counts different reporters, not repeat taps", () => {
  const a = cellOf(37.7, -122.4);
  const rows = [
    { ...a, kind: "seen", source: "person", reporter: "x", t: NOW },
    { ...a, kind: "seen", source: "person", reporter: "x", t: NOW + 60 },
    { ...a, kind: "heard", source: "listener", reporter: "y", t: NOW + 120 },
  ];
  const fc = aggregate(rows);
  assert.equal(fc.features.length, 1);
  const p = fc.features[0].properties;
  assert.deepEqual([p.reports, p.reporters, p.seen, p.heard, p.listener], [3, 2, 2, 1, 1]);
  assert.equal(p.last, new Date((NOW + 120) * 1000).toISOString());
  assert.equal("reporter" in p, false);
});

test("only the offered time windows are accepted", () => {
  assert.equal(windowHours("24"), 24);
  assert.equal(windowHours("99999"), 6);
  assert.equal(windowHours(undefined), 6);
});

test("a device id is optional but must look like a random id", () => {
  assert.equal(parseReport({ lat: 1, lon: 1 }, NOW).value.device, "");
  assert.equal(parseReport({ lat: 1, lon: 1, device: "a1b2c3d4e5f6" }, NOW).value.device, "a1b2c3d4e5f6");
  assert.equal(parseReport({ lat: 1, lon: 1, device: "<script>" }, NOW).ok, false);
});

test("one network address can't add more than 3 'people' to a dot by making up phone ids", () => {
  const a = cellOf(37.7, -122.4);
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push({ ...a, kind: "seen", source: "person", reporter: `fake${i}`, addr: "one", t: NOW });
  rows.push({ ...a, kind: "seen", source: "person", reporter: "real", addr: "two", t: NOW });
  assert.equal(aggregate(rows).features[0].properties.reporters, 4);
});

test("IPv6 addresses count per /64, IPv4 as is", () => {
  assert.equal(addrKey("2001:db8:1:2:aaaa::1"), addrKey("2001:db8:1:2:bbbb::9"));
  assert.notEqual(addrKey("2001:db8:1:2::1"), addrKey("2001:db8:1:3::1"));
  assert.equal(addrKey("2001:db8::1"), "2001:db8:0:0");
  assert.equal(addrKey("203.0.113.7"), "203.0.113.7");
});

test("only listeners may give a time; a person's report is always 'now'", () => {
  const iso = new Date((NOW - 300) * 1000).toISOString();
  const r = parseReport({ lat: 1, lon: 1, time: iso }, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.value.t, NOW - (NOW % 60));
});

test("distance between cells is roughly right", () => {
  const sf = cellOf(37.7749, -122.4194), la = cellOf(34.0522, -118.2437);
  const d = kmBetween(sf, la);
  assert.ok(d > 540 && d < 580, `${d}`);
  assert.equal(kmBetween(sf, sf), 0);
});

test("a reporter can't be in two far-apart places minutes apart", () => {
  const sf = cellOf(37.7749, -122.4194), oak = cellOf(37.8044, -122.2712), la = cellOf(34.0522, -118.2437);
  assert.equal(teleported({ ...sf, t: NOW - 300 }, { ...oak, t: NOW }), false); // 13 km in 5 min: a car
  assert.equal(teleported({ ...sf, t: NOW - 300 }, { ...la, t: NOW }), true);   // 560 km in 5 min
  assert.equal(teleported({ ...sf, t: NOW - 6 * 3600 }, { ...la, t: NOW }), false); // a flight
  assert.equal(teleported(null, { ...la, t: NOW }), false);
});

test("a dot reported by one person is marked unconfirmed; two networks confirm it", () => {
  const a = cellOf(37.7, -122.4);
  const one = aggregate([{ ...a, kind: "seen", source: "person", reporter: "x", addr: "n1", t: NOW }]);
  assert.equal(one.features[0].properties.confirmed, false);
  const two = aggregate([
    { ...a, kind: "seen", source: "person", reporter: "x", addr: "n1", t: NOW },
    { ...a, kind: "seen", source: "person", reporter: "y", addr: "n1", t: NOW },
  ]);
  assert.equal(two.features[0].properties.confirmed, false); // same network: could be one person
  const three = aggregate([
    { ...a, kind: "seen", source: "person", reporter: "x", addr: "n1", t: NOW },
    { ...a, kind: "seen", source: "person", reporter: "y", addr: "n2", t: NOW },
  ]);
  assert.equal(three.features[0].properties.confirmed, true);
});

test("confirming a dot needs reports from two different provider networks, and people, not listeners", () => {
  const a = cellOf(37.7, -122.4);
  const row = (reporter, addr, net, source = "person") => ({ ...a, kind: "seen", source, reporter, addr, net, t: NOW });
  // one person hopping between /64s inside their own block: same net
  assert.equal(aggregate([row("x", "a1", "n1"), row("y", "a2", "n1")]).features[0].properties.confirmed, false);
  // a listener doesn't confirm
  assert.equal(aggregate([row("x", "a1", "n1"), row("l", "a2", "n2", "listener")]).features[0].properties.confirmed, false);
  assert.equal(aggregate([row("x", "a1", "n1"), row("y", "a2", "n2")]).features[0].properties.confirmed, true);
});

test("without a known provider, network groups are IPv4 /24 and IPv6 /48", () => {
  assert.equal(netKey("203.0.113.7"), netKey("203.0.113.200"));
  assert.notEqual(netKey("203.0.113.7"), netKey("203.0.114.7"));
  assert.equal(netKey("2001:db8:1:2::1"), netKey("2001:db8:1:ffff::1"));
  assert.notEqual(netKey("2001:db8:1::1"), netKey("2001:db8:2::1"));
});

test("with a known provider, the provider is the network: IPv4 and IPv6 from one provider are one network", () => {
  assert.equal(netKey("203.0.113.7", 7922), netKey("2001:db8:1::1", 7922));
  assert.equal(netKey("203.0.113.7", 7922), netKey("198.51.100.9", 7922));
  assert.notEqual(netKey("203.0.113.7", 7922), netKey("203.0.113.7", 21928));
});

test("old rows with an empty network fall back to their address, and confirming needs two reporters", () => {
  const a = cellOf(37.7, -122.4);
  const row = (reporter, addr, net) => ({ ...a, kind: "seen", source: "person", reporter, addr, net, t: NOW });
  assert.equal(aggregate([row("x", "a1", ""), row("y", "a2", "")]).features[0].properties.confirmed, true);
  assert.equal(aggregate([row("x", "a1", "n1"), row("x", "a1", "n2")]).features[0].properties.confirmed, false);
});

test("the browser resampler turns 48 kHz into 16 kHz and keeps a tone's pitch", async () => {
  const { resampler } = await import("../public/detector.js");
  const rs = resampler(48000), f = 330;
  const parts = [];
  for (let c = 0; c < 10; c++) parts.push(rs(Float32Array.from({ length: 4800 }, (_, i) => Math.sin(2 * Math.PI * f * (c * 4800 + i) / 48000))));
  const y = Float32Array.from(parts.flatMap((p) => [...p]));
  assert.ok(Math.abs(y.length - 16000) < 10, `${y.length}`);
  let cross = 0; for (let i = 1; i < y.length; i++) if (y[i - 1] < 0 && y[i] >= 0) cross++;
  assert.ok(Math.abs(cross - f) <= 2, `${cross}`);
});

test("the browser detector finds a synthetic jittery drone and ignores a steady fan", async () => {
  const { Detector, SR } = await import("../public/detector.js");
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const n = SR * 14, noise = Float32Array.from({ length: n }, () => (rnd() - 0.5) * 0.02);
  const make = (jitter) => {
    const x = Float32Array.from(noise); let ph = 0, f = 180;
    for (let i = 0; i < n; i++) {
      if (i % 4000 === 0 && jitter) f = 180 * (1 + 0.04 * (rnd() - 0.5)); // real drones: ~0.4 % pitch change per 0.25 s
      ph += 2 * Math.PI * f / SR;
      for (let k = 1; k <= 12; k++) x[i] += 0.01 / k ** 0.6 * Math.sin(k * ph);
    }
    return x;
  };
  const run = (x) => { const d = new Detector(); return [...d.feed(x), ...d.flush()]; };
  const drone = run(make(true));
  assert.equal(drone.length, 1);
  assert.ok(Math.abs(drone[0].f0 - 180) / 180 < 0.06);
  assert.equal(run(make(false)).length, 0);
});

test("a drone that's still overhead is reported while it's still there", async () => {
  const { Detector, SR } = await import("../public/detector.js");
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const n = SR * 12, x = Float32Array.from({ length: n }, () => (rnd() - 0.5) * 0.02); let ph = 0, f = 180;
  for (let i = 0; i < n; i++) { if (i % 4000 === 0) f = 180 * (1 + 0.04 * (rnd() - 0.5)); ph += 2 * Math.PI * f / SR; for (let k = 1; k <= 12; k++) x[i] += 0.01 / k ** 0.6 * Math.sin(k * ph); }
  const d = new Detector();
  assert.deepEqual(d.feed(x), []); // it hasn't stopped, so nothing has finished
  const e = d.ongoing();
  assert.ok(e && e.confidence >= 0.5); // its pitch can come out at a related comb (e.g. 2/3), as in earshot itself
  assert.equal(new Detector().ongoing(), null);
});
