#!/usr/bin/env python3
"""Send earshot's detections to an overhead map.

earshot never touches the network; this separate script reads the log earshot writes and posts each
new event (time, confidence) with this listener's location, rounded by the server to ~300 m.
Only events at or above --min-confidence are sent. Standard library only.

    earshot listen --node roof --log events.jsonl &
    python3 overhead_relay.py events.jsonl --lat 37.77 --lon -122.42 --url https://overhead.example.workers.dev
"""
import argparse
import hashlib
import json
import sys
import time
import urllib.error
import urllib.request


def post(url: str, body: dict) -> tuple[int, str]:
    req = urllib.request.Request(url.rstrip("/") + "/api/report", data=json.dumps(body).encode(),
                                 headers={"content-type": "application/json", "user-agent": "overhead-relay/1"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    except (urllib.error.URLError, TimeoutError) as e:
        return 0, str(e)


def follow(path: str, from_start: bool):
    """Yield lines appended to path (like tail -f). Waits for the file to exist."""
    while True:
        try:
            f = open(path, encoding="utf-8")
            break
        except FileNotFoundError:
            time.sleep(1)
    if not from_start:
        f.seek(0, 2)
    buf = ""
    while True:
        chunk = f.readline()
        if not chunk:
            time.sleep(1)
            continue
        buf += chunk
        if buf.endswith("\n"):
            yield buf.strip()
            buf = ""


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("log", help="earshot's --log file (JSON lines)")
    ap.add_argument("--url", required=True, help="the overhead site, e.g. https://overhead.example.workers.dev")
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--lon", type=float, required=True)
    ap.add_argument("--min-confidence", type=float, default=0.6)
    ap.add_argument("--from-start", action="store_true", help="also send events already in the log (only those under 10 minutes old are accepted)")
    a = ap.parse_args(argv)
    device = "listener-" + hashlib.sha256(f"{a.log}|{a.lat}|{a.lon}".encode()).hexdigest()[:16]
    print(f"relaying {a.log} -> {a.url} (confidence ≥ {a.min_confidence})", file=sys.stderr)
    for line in follow(a.log, a.from_start):
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        conf = float(e.get("confidence", 0))
        if conf < a.min_confidence:
            continue
        body = {"lat": a.lat, "lon": a.lon, "kind": "heard", "source": "listener", "confidence": round(conf, 3),
                "time": e.get("end") or e.get("start"), "device": device}
        code, text = post(a.url, body)
        print(f"{e.get('start')} conf {conf:.2f} -> {code} {text[:120]}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
