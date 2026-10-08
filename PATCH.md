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
