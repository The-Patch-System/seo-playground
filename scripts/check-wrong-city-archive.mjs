#!/usr/bin/env node
// Patch fork: runs the shipped wrong-city check (src/lib/grid-point-builder.ts + grid-location-check.ts)
// over the archived Nov 15 2026 DataForSEO responses and prints how it performs, so reviewers can check
// the claims in the PR (match rate, flagged/clean counts, the distance gap, agreement with the earlier
// labels). The archive itself is not committed (434 MB, client data).
//
// Usage:
//   npx jiti scripts/check-wrong-city-archive.mjs <investigation dir>
// where <investigation dir> holds dfs-nov15/nov15-task-results/*.json, dfs-nov15/kg_tasks.json,
// monitors.json and bad_points.json (the original 22-CID blacklist counts per monitor).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createJiti } from 'jiti';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jiti = createJiti(import.meta.url, { alias: { '@': path.join(root, 'src') } });
const { buildGridPoint } = await jiti.import(path.join(root, 'src/lib/grid-point-builder.ts'));
const { parseListingPlace, lookupPlace, distanceKm } = await jiti.import(path.join(root, 'src/lib/grid-location-check.ts'));

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: npx jiti scripts/check-wrong-city-archive.mjs <investigation dir>');
  process.exit(1);
}
const resultsDir = path.join(dir, 'dfs-nov15/nov15-task-results');

// Map keyword + coordinate -> monitor, using the same grid geometry as generateGridCoords.
const monitors = JSON.parse(fs.readFileSync(path.join(dir, 'monitors.json'), 'utf8')).monitors;
const monitorByPoint = new Map();
for (const m of monitors) {
  const latDeg = m.spacing_km / 111.32;
  const lngDeg = m.spacing_km / (111.32 * Math.cos(m.center.lat * Math.PI / 180));
  const half = Math.floor(m.grid_size / 2);
  for (let row = 0; row < m.grid_size; row++) {
    for (let col = 0; col < m.grid_size; col++) {
      const lat = m.center.lat + (half - row) * latDeg;
      const lng = m.center.lng + (col - half) * lngDeg;
      monitorByPoint.set(`${m.keyword}|${lat.toFixed(6)},${lng.toFixed(6)}`, m);
    }
  }
}
const blacklist = new Map(JSON.parse(fs.readFileSync(path.join(dir, 'bad_points.json'), 'utf8')).map((r) => [r.monitor_id, r.bad]));
const kgLabels = new Map();
for (const p of JSON.parse(fs.readFileSync(path.join(dir, 'dfs-nov15/kg_tasks.json'), 'utf8'))) {
  for (const t of p.tasks) kgLabels.set(t.id, p.bad);
}

const STATE_RULE_CENTERS_KM = 900;
const listingStats = { cityState: 0, place: 0, ambiguous: 0, unmatched: 0, noPlace: 0 };
const points = { total: 0, wrong_city: 0, clean: 0, unresolved: 0, byState: 0 };
const hist = { '0-25': 0, '25-50': 0, '50-75': 0, '75-100': 0, '100-150': 0, '150-200': 0, '200-500': 0, '500+': 0 };
let maxCleanKm = 0;
let minFarKm = Infinity;
const perMonitor = new Map();
const kg = { tp: 0, fp: 0, fn: 0, tn: 0 };
const ads = { pointsWithAds: 0, targetMovedUp: 0, targetWasOwnAd: 0, truncated: 0, rankUnresolved: 0 };
const oldRule = { flagged: 0, flaggedNotNew: 0 };
let unmapped = 0;

const files = fs.readdirSync(resultsDir).filter((f) => f.endsWith('.json'));
for (const file of files) {
  const task = JSON.parse(fs.readFileSync(path.join(resultsDir, file), 'utf8')).tasks?.[0];
  if (!task || task.status_code !== 20000 || !task.result?.[0]) continue;
  const [lat, lng] = task.data.location_coordinate.split(',').map(Number);
  const monitor = monitorByPoint.get(`${task.data.keyword}|${task.data.location_coordinate}`);
  if (!monitor) unmapped += 1;
  const raw = task.result[0].items ?? [];
  const { point, location } = buildGridPoint({ row: 0, col: 0, lat, lng }, raw, monitor?.target ?? '', { depth: task.data.depth });
  points.total += 1;
  points[location.status] += 1;
  if (location.far.some((f) => f.method === 'state')) points.byState += 1;

  const organic = raw.filter((i) => i.type === 'local_pack' && !i.is_paid).slice(0, 5);
  for (const item of organic) {
    const place = parseListingPlace(item.description);
    if (!place) { listingStats.noPlace += 1; continue; }
    listingStats.cityState += 1;
    const found = lookupPlace(place.city, place.state);
    if (found === null) { listingStats.unmatched += 1; continue; }
    if (found === 'unresolved') { listingStats.ambiguous += 1; continue; }
    listingStats.place += 1;
    const km = distanceKm([lat, lng], found.coords);
    const bin = km < 25 ? '0-25' : km < 50 ? '25-50' : km < 75 ? '50-75' : km < 100 ? '75-100' : km < 150 ? '100-150' : km < 200 ? '150-200' : km < 500 ? '200-500' : '500+';
    hist[bin] += 1;
    if (location.status === 'wrong_city') minFarKm = Math.min(minFarKm, km > 150 ? km : Infinity);
    else maxCleanKm = Math.max(maxCleanKm, km);
  }

  // The investigation's earlier rule: 3+ of the raw top 5 in states whose center is 900+ km away.
  const rawTop = raw.filter((i) => i.type === 'local_pack').slice(0, 5);
  const C = { AL: [32.8, -86.8], AK: [64, -150], AZ: [34.3, -111.7], AR: [34.9, -92.4], CA: [37.2, -119.5], CO: [39, -105.5], CT: [41.6, -72.7], DE: [39, -75.5], DC: [38.9, -77], FL: [28.6, -82.4], GA: [32.7, -83.4], HI: [20.8, -156.3], ID: [44.4, -114.6], IL: [40, -89.2], IN: [39.9, -86.3], IA: [42.1, -93.5], KS: [38.5, -98.4], KY: [37.5, -85.3], LA: [31, -92], ME: [45.4, -69.2], MD: [39, -76.8], MA: [42.3, -71.8], MI: [44.3, -85.4], MN: [46.3, -94.3], MS: [32.7, -89.7], MO: [38.4, -92.5], MT: [47, -109.6], NE: [41.5, -99.8], NV: [39.3, -116.6], NH: [43.7, -71.6], NJ: [40.2, -74.7], NM: [34.4, -106.1], NY: [42.9, -75.5], NC: [35.6, -79.4], ND: [47.5, -100.5], OH: [40.3, -82.8], OK: [35.6, -97.5], OR: [43.9, -120.6], PA: [40.9, -77.8], RI: [41.7, -71.5], SC: [33.9, -80.9], SD: [44.4, -100.2], TN: [35.9, -86.4], TX: [31.5, -99.3], UT: [39.3, -111.7], VT: [44, -72.7], VA: [37.5, -78.8], WA: [47.4, -120.5], WV: [38.6, -80.6], WI: [44.6, -89.9], WY: [43, -107.5] };
  const oldFar = rawTop.filter((i) => { const m = (i.description ?? '').match(/,\s([A-Z]{2})\s·/); return m && C[m[1]] && distanceKm([lat, lng], C[m[1]]) > STATE_RULE_CENTERS_KM; }).length;
  if (oldFar >= 3) {
    oldRule.flagged += 1;
    if (location.status !== 'wrong_city') oldRule.flaggedNotNew += 1;
  }

  if (kgLabels.has(task.id)) {
    const bad = kgLabels.get(task.id);
    const flagged = location.status === 'wrong_city';
    kg[bad ? (flagged ? 'tp' : 'fn') : (flagged ? 'fp' : 'tn')] += 1;
  }

  if (monitor) {
    const row = perMonitor.get(monitor.monitor_id) ?? { name: monitor.project.name, keyword: monitor.keyword, newRule: 0, points: 0 };
    row.points += 1;
    if (location.status === 'wrong_city') row.newRule += 1;
    perMonitor.set(monitor.monitor_id, row);

    if (raw.some((i) => i.is_paid)) {
      ads.pointsWithAds += 1;
      const oldMatch = raw.filter((i) => i.type === 'local_pack').find((i) => point.items.some((s) => s.is_target && s.cid === i.cid) || (i.is_paid && i.cid && monitor.target.includes(i.cid)));
      if (oldMatch?.is_paid) ads.targetWasOwnAd += 1;
      else if (oldMatch && point.rank !== null && point.rank < oldMatch.rank_group) ads.targetMovedUp += 1;
    }
    if (point.truncated) ads.truncated += 1;
    if (point.rank_unresolved) ads.rankUnresolved += 1;
  }
}

const pct = (n, d) => `${d ? ((n / d) * 100).toFixed(1) : '0.0'}%`;
console.log(`Tasks with results: ${points.total} (${files.length} files; ${unmapped} not mapped to a monitor)`);
console.log('\nTop-5 organic listings');
console.log(`  showing "City, ST": ${listingStats.cityState}; street-only/other: ${listingStats.noPlace}`);
console.log(`  placed by city: ${listingStats.place} (${pct(listingStats.place, listingStats.cityState)})`);
console.log(`  ambiguous name -> state fallback: ${listingStats.ambiguous} (${pct(listingStats.ambiguous, listingStats.cityState)})`);
console.log(`  not in gazetteer -> state fallback: ${listingStats.unmatched} (${pct(listingStats.unmatched, listingStats.cityState)})`);
console.log('\nPoints');
console.log(`  wrong_city: ${points.wrong_city} (${points.byState} with a state-fallback far listing)`);
console.log(`  clean: ${points.clean}`);
console.log(`  unresolved (no top-5 listing placed; published as clean): ${points.unresolved}`);
console.log('\nDistance of city-placed top-5 listings from their grid point');
for (const [bin, n] of Object.entries(hist)) console.log(`  ${bin.padEnd(8)} km  ${String(n).padStart(7)}`);
console.log(`  max on clean/unresolved points: ${maxCleanKm.toFixed(0)} km; min far listing on wrong-city points: ${minFarKm.toFixed(0)} km`);
console.log('\nKing George hand-checked labels (47 bad / 34 good)');
console.log(`  flagged & bad ${kg.tp}, missed bad ${kg.fn}, flagged but good ${kg.fp}, clean & good ${kg.tn}`);
console.log('\nEarlier state-center rule (3+ of raw top 5 > 900 km)');
console.log(`  flagged ${oldRule.flagged}; flagged by it but not by the new rule: ${oldRule.flaggedNotNew}`);
let blTotal = 0;
let newTotal = 0;
const diffs = [];
for (const [id, row] of perMonitor) {
  const bl = blacklist.get(id) ?? 0;
  blTotal += bl;
  newTotal += row.newRule;
  if (bl !== row.newRule) diffs.push({ id, ...row, blacklist: bl });
}
console.log('\n22-CID blacklist (per monitor) vs new rule');
console.log(`  blacklist total ${blTotal}, new rule total ${newTotal}, monitors that differ: ${diffs.length} of ${perMonitor.size}`);
for (const d of diffs.sort((a, b) => Math.abs(b.newRule - b.blacklist) - Math.abs(a.newRule - a.blacklist)).slice(0, 15)) {
  console.log(`  ${d.id} ${d.name} / ${d.keyword}: blacklist ${d.blacklist}, new ${d.newRule} (${d.points} pts)`);
}
console.log('\nAds (organic-only ranks)');
console.log(`  points with ads: ${ads.pointsWithAds}; target moved up once ads were removed: ${ads.targetMovedUp}; target matched on its own ad: ${ads.targetWasOwnAd}`);
console.log(`  truncated points (ads used up depth 20): ${ads.truncated}; of those target not found -> rank_unresolved: ${ads.rankUnresolved}`);
