// Patch fork: detects "wrong-city" Local Finder results.
//
// On Nov 15 2026 DataForSEO/Google intermittently answered correct, local requests with national
// result pages (clinics in Tulsa, Albuquerque, Henderson...). The request was right (check_url
// encoded the point), so the only reliable defense is to inspect each result and re-post bad ones.
//
// Rule: a point is wrong-city when any of its top 5 organic listings is more than 150 km from the
// grid point. A listing's location is the "City, ST" at the start of its description, placed with a
// bundled Census gazetteer (scripts/build-us-places.mjs). A name that is ambiguous in its state, or
// not in the gazetteer, falls back to the state's center with a 900 km threshold.
// Evidence (Nov 15 archive): clean points' top-5 listings max out at 62 km, wrong-city listings
// start at 162 km, and there are none between 75 and 150 km.
import placesData from './data/us-places.json';

export const WRONG_CITY_KM = 150;
export const STATE_FALLBACK_KM = 900;
export const CHECKED_TOP_N = 5;

const PLACES = placesData as unknown as Record<string, [number, number] | 0>;

/** Approximate state centers, from the investigation's classify.py. */
const STATE_CENTERS: Record<string, [number, number]> = {
  AL: [32.8, -86.8], AK: [64, -150], AZ: [34.3, -111.7], AR: [34.9, -92.4], CA: [37.2, -119.5], CO: [39, -105.5],
  CT: [41.6, -72.7], DE: [39, -75.5], DC: [38.9, -77], FL: [28.6, -82.4], GA: [32.7, -83.4], HI: [20.8, -156.3],
  ID: [44.4, -114.6], IL: [40, -89.2], IN: [39.9, -86.3], IA: [42.1, -93.5], KS: [38.5, -98.4], KY: [37.5, -85.3],
  LA: [31, -92], ME: [45.4, -69.2], MD: [39, -76.8], MA: [42.3, -71.8], MI: [44.3, -85.4], MN: [46.3, -94.3],
  MS: [32.7, -89.7], MO: [38.4, -92.5], MT: [47, -109.6], NE: [41.5, -99.8], NV: [39.3, -116.6], NH: [43.7, -71.6],
  NJ: [40.2, -74.7], NM: [34.4, -106.1], NY: [42.9, -75.5], NC: [35.6, -79.4], ND: [47.5, -100.5], OH: [40.3, -82.8],
  OK: [35.6, -97.5], OR: [43.9, -120.6], PA: [40.9, -77.8], RI: [41.7, -71.5], SC: [33.9, -80.9], SD: [44.4, -100.2],
  TN: [35.9, -86.4], TX: [31.5, -99.3], UT: [39.3, -111.7], VT: [44, -72.7], VA: [37.5, -78.8], WA: [47.4, -120.5],
  WV: [38.6, -80.6], WI: [44.6, -89.9], WY: [43, -107.5],
};

export function distanceKm(a: [number, number], b: [number, number]): number {
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad;
  const dLng = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/** Must match normalizePlaceName in scripts/build-us-places.mjs. */
export function normalizePlaceName(value: string): string {
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

export interface ListingPlace { city: string; state: string }

/**
 * "Tulsa, OK · (918) 555-0100 …" -> { city: 'Tulsa', state: 'OK' }. The place can also follow another
 * segment ("10+ years in business · San Diego, CA · …"), so every "·" segment of the first line is
 * tried. Street-only descriptions return null.
 */
export function parseListingPlace(description: string | null | undefined): ListingPlace | null {
  const firstLine = (description ?? '').split('\n')[0];
  for (const segment of firstLine.split('·')) {
    const match = segment.match(/^\s*([^,\d][^,]*?),\s*([A-Z]{2})\s*$/);
    if (match) return { city: match[1].trim(), state: match[2] };
  }
  return null;
}

export type PlaceLookup = { coords: [number, number] } | 'unresolved' | null;

/** Gazetteer coordinates for a listing's city; 'unresolved' when the name is ambiguous in that state. */
export function lookupPlace(city: string, state: string): PlaceLookup {
  const value = PLACES[`${normalizePlaceName(city)}|${state.toUpperCase()}`];
  if (value === undefined) return null;
  if (value === 0) return 'unresolved';
  return { coords: value };
}

export interface FarListing {
  rank: number;
  title?: string;
  place: string;
  km: number;
  method: 'place' | 'state';
}

export interface LocationCheck {
  /** wrong_city: at least one top-5 listing is far away. unresolved: no top-5 listing could be placed. */
  status: 'clean' | 'wrong_city' | 'unresolved';
  wrongCity: boolean;
  /** Top-5 listings placed by their city (the strong signal). */
  coverage: number;
  /** Top-5 listings only checked against their state's center. */
  stateChecked: number;
  far: FarListing[];
}

export interface CheckableListing {
  rank: number;
  title?: string;
  description?: string | null;
}

/** Applies the wrong-city rule to a point's organic listings (already in organic rank order). */
export function checkPointLocation(listings: CheckableListing[], lat: number, lng: number): LocationCheck {
  const point: [number, number] = [lat, lng];
  const far: FarListing[] = [];
  let coverage = 0;
  let stateChecked = 0;
  const top = listings.slice(0, CHECKED_TOP_N);
  for (const listing of top) {
    const place = parseListingPlace(listing.description);
    if (!place) continue;
    const label = `${place.city}, ${place.state}`;
    const found = lookupPlace(place.city, place.state);
    if (found && found !== 'unresolved') {
      coverage += 1;
      const km = distanceKm(point, found.coords);
      if (km > WRONG_CITY_KM) far.push({ rank: listing.rank, title: listing.title, place: label, km: Math.round(km), method: 'place' });
      continue;
    }
    const center = STATE_CENTERS[place.state];
    if (!center) continue;
    stateChecked += 1;
    const km = distanceKm(point, center);
    if (km > STATE_FALLBACK_KM) far.push({ rank: listing.rank, title: listing.title, place: label, km: Math.round(km), method: 'state' });
  }
  const wrongCity = far.length > 0;
  const status = wrongCity ? 'wrong_city' : top.length > 0 && coverage === 0 ? 'unresolved' : 'clean';
  return { status, wrongCity, coverage, stateChecked, far };
}
