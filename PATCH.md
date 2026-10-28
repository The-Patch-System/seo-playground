# Patch fork of SEO Playground

Fork of [paulmassen/seo-playground](https://github.com/paulmassen/seo-playground), deployed on Railway as the Semrush Map Rank Tracker replacement.

## Changes from upstream

- **Monthly Geo-grid schedules** (`Every month` + day 1-28) alongside daily/weekly. The day of month is stored in the existing `weekday` column, so no schema change.
- **Password protection** (`src/middleware.ts`): HTTP basic auth on every page. Username `SITE_USERNAME` (default `patch`), password `SITE_PASSWORD`. Without `SITE_PASSWORD` the app returns 503.
- **Daily upstream sync** (`.github/workflows/sync-upstream.yml`): merges upstream `main` into this fork; Railway redeploys on the push.
- **Semrush MRT parity for maps**:
  - Radius in miles (`Radius (miles)`, 5 mi default, 10 mi for rural), stored as km between points. New monitors default to 9x9, Standard queue.
  - Scheduled scans run in the **clinic's** time zone (looked up from the map center), defaulting to the 15th at 12:00. "Scan monthly" is ticked on the setup form, so a new monitor is scheduled when it's created.
  - A point outside the top 20 shows as a red **20+** (like Semrush). A grey **—** / "No data" means DataForSEO failed at that point: failed tasks are re-posted up to 3 times before a point is marked `failed`.
  - The monitor list shows every monitor (upstream capped it at the newest 100 runs).
  - At most `GEO_GRID_MAX_CLAIMS_PER_PASS` (default 20) scheduled monitors start per worker pass (one pass a minute), so hundreds of monitors on the 15th start in waves; task polling is capped at 10 requests in flight per run.
  - **Retention is OFF by default** (changed Oct 28 2026): no map scans are deleted, so the imported Semrush history and every new client's history are kept. Code is in `pruneGridHistoryForProject` (`src/lib/db.ts`), called from `src/app/api/cron/geo-grid/route.ts`. Set `GRID_RETENTION_ENABLED=true` on the `app` service to turn it on; no code change needed. When on, it runs once a day and on the first worker pass after every app restart (the timer is in memory), and each monitor keeps its starting-point run (the `pinned` run, else its oldest finished run) plus the last ~6 months; older finished runs are deleted. Pending and failed runs are never touched. Before enabling, make sure each monitor's intended baseline scan is pinned (see `PATCH /runs/{run_id}` below), or the oldest finished scan becomes the protected start. Intended long-term plan was starting-point scan + last 6 months, so enable it if storage ever becomes a concern.

## Railway

- `app` service: builds this repo's Dockerfile, volume at `/data`, vars `DB_PATH=/data/seo-playground.db`, `CRON_SECRET`, `SITE_PASSWORD`, `RAILWAY_RUN_UID=0` (volume is root-owned; the image runs as uid 1001). Optional: `GRID_RETENTION_ENABLED=true` (see Retention above).
- `worker` service: same repo, start command `node scripts/geo-grid-worker.mjs`, vars `CRON_SECRET` (same value), `GEO_GRID_WORKER_URL=http://app.railway.internal:3000`. No volume, no public domain.
- Volume backups are scheduled on the `app` volume.
- Storage: the volume (`seo-playground-data`) is 50 GB. It sat near 0 until the Semrush history import (Oct 2026), then jumped to roughly 6 GB. Check Railway → project → volume card → Metrics. SQLite does not shrink its file after deletes, so turning retention on later will stop growth rather than free space. Volumes can be enlarged in Railway if needed.

## Reporting API

All requests need `x-api-key: <REPORTING_API_KEY>` (or `Authorization: Bearer <key>`). Covers every project.

- `POST /api/v1/geo-grid/monitors` : creates a monitor **without running a scan** (no DataForSEO cost). Body:
  `{ keyword, business: { name, cid }, center: { lat, lng }, grid_size?: 9, radius_mi?: 5 | spacing_km?, language?: "English", project?: "<project id>" | { name, domain }, schedule?: { day_of_month?: 15, time_of_day?: "12:00" } | false, runs?: [{ run_at, pinned?, points: [{ row, col, lat?, lng?, rank }] }] }`.
  A `project` object files the monitor under that client's project, matched by website domain and created on first use (one project per clinic website, so multi-location clinics share one).
  `runs[]` imports past scans (e.g. from Semrush MRT); ranks above 20 are stored as "20+". `pinned: true` marks the starting-point scan. Repeating the call for the same location and scan dates does not create duplicates.

- `GET /api/v1/geo-grid/monitors` : all monitors (including scheduled ones with no runs yet) with schedule and latest completed run summary. Filters: `?cid=`, `?q=` (keyword/target text), `?project=`.
- `DELETE /api/v1/geo-grid/monitors/{monitor_id}` : removes a monitor (all snapshots and its schedule) from every project, or only `?project=`.
- `PATCH /api/v1/geo-grid/runs/{run_id}` with `{ "pinned": true }` : makes that run the monitor's one starting-point map (other pins in the monitor are cleared); `{ "pinned": false }` unpins it. The starting-point map should be the scan closest to the client's SEO start date, and it must match what the reporting agent has pinned. Find run IDs with `GET .../monitors/{monitor_id}/runs`.
- `GET /api/v1/geo-grid/monitors/{monitor_id}/latest` : newest completed run with every grid point.
- `GET /api/v1/geo-grid/monitors/{monitor_id}/runs` : run history (summaries only).
- `GET /api/v1/geo-grid/runs/{run_id}` : one run with every grid point.

Run payload:
- Each run has `pinned` (starting-point scan).
- `points[]`: `row`, `col`, `lat`, `lng`, `rank` (null = not in top 20) and `results` (that point's top 20: rank, title, domain, cid, rating, reviews, is_target). `?competitors=false` drops `results`.
- `positions[]`: Semrush MRT heatmap shape, `{ point: { id, coordinates: { lat, lng } }, position?, diff? }`; `position` is omitted when not in the top 20 and `diff` is vs the previous run (negative = improved).
- `top_competitors[]`: business (cid, name, domain, rating, reviews), `average_position`, `share_of_voice`, `found_points`, `is_target`.
- `business`: `{ cid, name, coordinates }` (the pin) and `summary`: `visibility` (0-100 share of voice), `average_rank`, `top3`, `found`, `total`.

Run history adds `metrics: { average_positions, share_of_voices }` keyed by ISO date, like Semrush MRT.
