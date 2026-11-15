import { test } from "node:test";
import assert from "node:assert/strict";
import { addrKey, aggregate, cellOf, parseReport, windowHours, CELL_DEG } from "../src/core.js";

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
