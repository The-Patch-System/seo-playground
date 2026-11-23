#!/usr/bin/env node
// Patch fork: builds src/lib/data/us-places.json, the lookup the Geo-grid wrong-city check uses to
// place a Local Finder listing's "City, ST" on the map.
//
// Inputs are the US Census 2023 Gazetteer files (public domain):
//   https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_place_national.zip
//   https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_cousubs_national.zip
//   https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_counties_national.zip
// Unzip them and run:
//   node scripts/build-us-places.mjs <place.txt> <cousubs.txt> <counties.txt>
//
// Output: { "normalized name|ST": [lat, lng] | 0 }. 0 means the name is ambiguous in that state
// (several far-apart places share it), so the check treats it as unresolved.
// Tiers, highest first: places, then active county subdivisions (towns/townships, which Google shows
// for much of NJ, PA, New England and MI), then counties, then aliases for consolidated cities.
// A key from a higher tier is never overwritten by a lower one.
//
// normalizePlaceName must stay identical to the one in src/lib/grid-location-check.ts
// (grid-location-check.test.ts checks known keys resolve through it).

import fs from 'fs';
import path from 'path';

/** Same-name entries closer than this are one place for our purposes (the check's threshold is 150 km). */
const SAME_PLACE_KM = 50;

function normalizePlaceName(value) {
  return value
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\bste\.?\s+/g, 'sainte ')
    .replace(/\bst\.?\s+/g, 'saint ')
    .replace(/\bft\.?\s+/g, 'fort ')
    .replace(/\bmt\.?\s+/g, 'mount ')
    .replace(/[.'’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function km(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad;
  const dLng = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

function readGazetteer(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim());
  const header = lines[0].split('\t').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split('\t').map((c) => c.trim());
    return Object.fromEntries(header.map((h, i) => [h, cells[i]]));
  });
}

/** The lowercase descriptors Census appends to names ("Abbeville city", "Glen Allen CDP"). */
const DESCRIPTOR_WORDS = new Set([
  'CDP', 'township', 'city', 'town', 'village', 'borough', 'barrio', 'precinct', 'district', 'comunidad', 'charter',
  'zona', 'urbana', 'barrio-pueblo', 'plantation', 'grant', 'municipality', 'purchase', 'unified', 'government', 'metro',
  'gore', 'location', 'and', 'consolidated', 'metropolitan', 'urban', 'county', 'corporation',
  'subdivisions', 'subdivision', 'not', 'defined', 'census', 'subarea',
]);

/** "Indianapolis city (balance)" -> "Indianapolis"; keeps proper-name words like "d'Alene". */
function stripDescriptor(name) {
  const words = name.replace(/\(.*?\)/g, ' ').trim().split(/\s+/);
  while (words.length > 1 && DESCRIPTOR_WORDS.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

const CONSOLIDATED = /government|urban county|\(balance\)|metro/;

/** Collapses same-name entries: one location if they're all close together, else ambiguous (0). */
function tier(entries) {
  const byKey = new Map();
  for (const entry of entries) {
    const list = byKey.get(entry.key) ?? [];
    list.push(entry);
    byKey.set(entry.key, list);
  }
  const out = new Map();
  for (const [key, list] of byKey) {
    list.sort((a, b) => b.area - a.area);
    const far = list.some((a) => list.some((b) => km(a.coords, b.coords) > SAME_PLACE_KM));
    out.set(key, far ? 0 : list[0].coords);
  }
  return out;
}

function entry(name, state, row) {
  const key = `${normalizePlaceName(name)}|${state}`;
  const coords = [Number(Number(row.INTPTLAT).toFixed(3)), Number(Number(row.INTPTLONG).toFixed(3))];
  return { key, coords, area: Number(row.ALAND) || 0 };
}

function main() {
  const [placeFile, cousubFile, countyFile, outArg] = process.argv.slice(2);
  if (!placeFile || !cousubFile || !countyFile) {
    console.error('Usage: node scripts/build-us-places.mjs <place.txt> <cousubs.txt> <counties.txt> [out.json]');
    process.exit(1);
  }
  const out = outArg ?? path.join(process.cwd(), 'src/lib/data/us-places.json');

  const places = [];
  const aliases = [];
  for (const row of readGazetteer(placeFile)) {
    const base = stripDescriptor(row.NAME);
    places.push(entry(base, row.USPS, row));
    // "Nashville-Davidson metropolitan government (balance)", "Louisville/Jefferson County metro
    // government (balance)", "Lexington-Fayette urban county": Google shows the first part.
    if (CONSOLIDATED.test(row.NAME) && /[-/]/.test(base)) aliases.push(entry(base.split(/[-/]/)[0], row.USPS, row));
  }

  const cousubs = readGazetteer(cousubFile)
    .filter((row) => row.FUNCSTAT === 'A')
    .map((row) => entry(stripDescriptor(row.NAME), row.USPS, row));

  const counties = [];
  for (const row of readGazetteer(countyFile)) {
    const base = row.NAME.replace(/\s+(County|Parish|Borough|Census Area|City and Borough|Municipality|Municipio|city)$/i, '');
    counties.push(entry(base, row.USPS, row));
    // New York City boroughs as Google shows them.
    const borough = { 'Kings County': 'Brooklyn', 'Queens County': 'Queens', 'Bronx County': 'Bronx', 'Richmond County': 'Staten Island', 'New York County': 'Manhattan' }[row.NAME];
    if (row.USPS === 'NY' && borough) {
      aliases.push(entry(borough, 'NY', row));
      if (borough === 'Bronx') aliases.push(entry('The Bronx', 'NY', row));
    }
  }

  const result = new Map();
  for (const level of [tier(places), tier(cousubs), tier(counties), tier(aliases)]) {
    for (const [key, value] of level) if (!result.has(key)) result.set(key, value);
  }
  // NYC borough aliases outrank the same-name places/towns (e.g. "Queens" elsewhere in NY).
  for (const [key, value] of tier(aliases)) if (/^(brooklyn|queens|bronx|the bronx|staten island|manhattan)\|NY$/.test(key)) result.set(key, value);

  const sorted = Object.fromEntries([...result.entries()].sort(([a], [b]) => a.localeCompare(b)));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(sorted));
  const ambiguous = [...result.values()].filter((v) => v === 0).length;
  console.log(`Wrote ${result.size} names (${ambiguous} ambiguous) to ${out} (${(fs.statSync(out).size / 1e6).toFixed(2)} MB)`);
}

main();
