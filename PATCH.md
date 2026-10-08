# Patch fork of SEO Playground

Fork of [paulmassen/seo-playground](https://github.com/paulmassen/seo-playground), deployed on Railway as the Semrush Map Rank Tracker replacement.

## Changes from upstream

- **Monthly Geo-grid schedules** (`Every month` + day 1-28) alongside daily/weekly. The day of month is stored in the existing `weekday` column, so no schema change.
- **Password protection** (`src/middleware.ts`): HTTP basic auth on every page. Username `SITE_USERNAME` (default `patch`), password `SITE_PASSWORD`. Without `SITE_PASSWORD` the app returns 503.
- **Daily upstream sync** (`.github/workflows/sync-upstream.yml`): merges upstream `main` into this fork; Railway redeploys on the push.

## Railway

- `app` service: builds this repo's Dockerfile, volume at `/data`, vars `DB_PATH=/data/seo-playground.db`, `CRON_SECRET`, `SITE_PASSWORD`, `RAILWAY_RUN_UID=0` (volume is root-owned; the image runs as uid 1001).
- `worker` service: same repo, start command `node scripts/geo-grid-worker.mjs`, vars `CRON_SECRET` (same value), `GEO_GRID_WORKER_URL=http://app.railway.internal:3000`. No volume, no public domain.
- Volume backups are scheduled on the `app` volume.

## Reporting API (read-only)

All requests need `x-api-key: <REPORTING_API_KEY>` (or `Authorization: Bearer <key>`). Covers every project.

- `GET /api/v1/geo-grid/monitors` : all monitors with schedule and latest completed run summary. Filters: `?cid=`, `?q=` (keyword/target text), `?project=`.
- `GET /api/v1/geo-grid/monitors/{monitor_id}/latest` : newest completed run with every grid point.
- `GET /api/v1/geo-grid/monitors/{monitor_id}/runs` : run history (summaries only).
- `GET /api/v1/geo-grid/runs/{run_id}` : one run with every grid point.

Run payload:
- `points[]`: `row`, `col`, `lat`, `lng`, `rank` (null = not in top 20) and `results` (that point's top 20: rank, title, domain, cid, rating, reviews, is_target). `?competitors=false` drops `results`.
- `positions[]`: Semrush MRT heatmap shape, `{ point: { id, coordinates: { lat, lng } }, position?, diff? }`; `position` is omitted when not in the top 20 and `diff` is vs the previous run (negative = improved).
- `top_competitors[]`: business (cid, name, domain, rating, reviews), `average_position`, `share_of_voice`, `found_points`, `is_target`.
- `business`: `{ cid, name, coordinates }` (the pin) and `summary`: `visibility` (0-100 share of voice), `average_rank`, `top3`, `found`, `total`.

Run history adds `metrics: { average_positions, share_of_voices }` keyed by ISO date, like Semrush MRT.
