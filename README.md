# overhead

A crowdsourced, anonymous map of drone sightings. Anyone can tap **I see a drone** or **I hear a drone**
on their phone, and listening devices running [earshot](https://github.com/lizTheDeveloper/earshot) can
report what they hear. Nobody has to say who they are.

Live: https://overhead.lizthedeveloper.workers.dev

## What it promises

- **No accounts, no exact locations.** A report is rounded to a grid cell about 300 m across before it's
  saved. The exact spot never reaches the database.
- **No IP addresses stored.** The server keeps a hash of the sender's address (and of a random id the phone
  makes for itself), salted with a secret that changes every day and is then deleted. That's enough to count
  separate people and limit spam for a day, and not enough to trace anyone afterwards.
- **Reports are deleted after 7 days.**
- **Open data.** `GET /api/reports.geojson?hours=1|6|24|72` returns the map's data (one point per cell:
  reports, separate reporters, latest time, seen/heard, how many came from listening devices).

## What it can't tell you

- **Every dot is unverified.** It means people reported something, not that it was a drone, or whose it was.
- **Someone determined can fake reports.** Limits: 6 reports per phone and 60 per network address every
  10 minutes, counted by when the server got them. One network address adds at most 3 "people" to a dot,
  however many phone ids it makes up, but someone with many addresses can still fake a crowd. Only this
  site's own page can submit from a browser. Treat a dot as a lead.
- **Listening devices are only as good as earshot,** which hasn't been validated on many real drones yet.

## Run your own

Every city can run its own copy, and the open data lets copies mirror each other. Each copy runs on
Cloudflare's network, which absorbs traffic floods.

```sh
npm test                                   # core logic tests (node ≥ 20)
wrangler d1 create overhead                # put the id it prints in wrangler.toml
wrangler d1 migrations apply overhead --remote
wrangler deploy
```

## Connect a listener

```sh
earshot listen --node roof --log events.jsonl &
python3 relay/overhead_relay.py events.jsonl --lat 37.77 --lon -122.42 --url https://overhead.lizthedeveloper.workers.dev
```

earshot itself never uses the network; the relay is a separate script that reads its log and sends
events at or above `--min-confidence` (default 0.6). Listener reports need a key from the site's operator,
so nobody can pose as a listening device: `wrangler secret put LISTENER_KEYS` (comma-separated). The live
site has no keys yet, so it takes people's reports only until earshot is validated on real drones.

## API

`POST /api/report` with JSON `{lat, lon, kind: "seen"|"heard"|"both", device?, source?: "person"|"listener",
confidence? (listeners, 0–1), time? (listeners, ISO, within the last 10 minutes)}`.

MIT licensed.
