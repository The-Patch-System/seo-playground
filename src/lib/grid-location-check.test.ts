// Patch fork: the wrong-city rule, checked against hand-built edges and real Nov 15 2026 responses.
import { describe, it, expect } from 'vitest';
import {
  checkPointLocation, distanceKm, lookupPlace, normalizePlaceName, parseListingPlace,
  STATE_FALLBACK_KM, WRONG_CITY_KM, type CheckableListing,
} from './grid-location-check';
import { buildGridPoint } from './grid-point-builder';
import { loadDfsFixture, type FixtureName } from './__fixtures__/dfs/load';

/** A point `km` due north of `from` (pure latitude offset, so the haversine distance is exact). */
const northOf = (from: [number, number], km: number): [number, number] => [from[0] + (km / 6371) * (180 / Math.PI), from[1]];
const listing = (rank: number, description: string | null): CheckableListing => ({ rank, title: `L${rank}`, description });
const coordsOf = (city: string, state: string): [number, number] => {
  const found = lookupPlace(city, state);
  if (!found || found === 'unresolved') throw new Error(`${city}, ${state} not in gazetteer`);
  return found.coords;
};

describe('parseListingPlace', () => {
  it('reads "City, ST" at the start of the first line', () => {
    expect(parseListingPlace('Tulsa, OK · (918) 494-3000 \nClosed · Opens 7 AM Mon')).toEqual({ city: 'Tulsa', state: 'OK' });
    expect(parseListingPlace('Alhambra, CA \n')).toEqual({ city: 'Alhambra', state: 'CA' });
    expect(parseListingPlace("Coeur d'Alene, ID · (208) 555-0100")).toEqual({ city: "Coeur d'Alene", state: 'ID' });
    expect(parseListingPlace('St. Louis, MO · 1')).toEqual({ city: 'St. Louis', state: 'MO' });
  });

  it('reads "City, ST" after another segment on the first line', () => {
    expect(parseListingPlace('10+ years in business · San Diego, CA · (619) 555-0100')).toEqual({ city: 'San Diego', state: 'CA' });
    expect(parseListingPlace('Open 24 hours · Bend, OR')).toEqual({ city: 'Bend', state: 'OR' });
    // A street address with a comma is not a place.
    expect(parseListingPlace('123 Main St, Suite 4 · (555) 555-0100')).toBeNull();
  });

  it('returns null for street-only, sponsored and empty descriptions', () => {
    expect(parseListingPlace('2060 Huntington Drive · (424) 254-9273 ')).toBeNull();
    expect(parseListingPlace('525 N Garfield Ave · (626) 573-2222 \nOpen 24 hours')).toBeNull();
    expect(parseListingPlace('Sponsored \n2060 Huntington Drive · (424) 254-9273 ')).toBeNull();
    expect(parseListingPlace('')).toBeNull();
    expect(parseListingPlace(null)).toBeNull();
    expect(parseListingPlace(undefined)).toBeNull();
    // Only the first line counts: a city on line 2 is ignored.
    expect(parseListingPlace('123 Main St\nTulsa, OK · 1')).toBeNull();
  });
});

describe('normalizePlaceName', () => {
  it('expands St./Ste./Ft./Mt., drops punctuation, accents and "(balance)"', () => {
    expect(normalizePlaceName('St. Louis')).toBe('saint louis');
    expect(normalizePlaceName('St Petersburg')).toBe('saint petersburg');
    expect(normalizePlaceName('Saint Louis')).toBe('saint louis');
    expect(normalizePlaceName('Ste. Genevieve')).toBe('sainte genevieve');
    expect(normalizePlaceName('Ft. Worth')).toBe('fort worth');
    expect(normalizePlaceName('Mt. Pleasant')).toBe('mount pleasant');
    expect(normalizePlaceName("Coeur d'Alene")).toBe('coeur dalene');
    expect(normalizePlaceName('Winston-Salem')).toBe('winston salem');
    expect(normalizePlaceName('Cañon City')).toBe('canon city');
    expect(normalizePlaceName('Louisville/Jefferson County metro government (balance)')).toBe('louisville jefferson county metro government');
  });
});

describe('lookupPlace', () => {
  it.each([
    ['St. Louis', 'MO'], ['Nashville', 'TN'], ['Louisville', 'KY'], ['Brooklyn', 'NY'], ['Glen Allen', 'VA'],
    ["Coeur d'Alene", 'ID'], ['Howell', 'NJ'], ['Ft. Worth', 'TX'], ['Mt. Pleasant', 'SC'], ['Washington', 'DC'],
  ])('places %s, %s', (city, state) => {
    const found = lookupPlace(city, state);
    expect(found).toMatchObject({ coords: [expect.any(Number), expect.any(Number)] });
  });

  it('places aliases at the same coordinates', () => {
    expect(lookupPlace('St. Louis', 'MO')).toEqual(lookupPlace('Saint Louis', 'MO'));
    expect(lookupPlace('Ft. Worth', 'TX')).toEqual(lookupPlace('Fort Worth', 'TX'));
    expect(lookupPlace('Mt. Pleasant', 'SC')).toEqual(lookupPlace('Mount Pleasant', 'SC'));
    expect(lookupPlace('nashville', 'tn')).toEqual(lookupPlace('Nashville', 'TN'));
  });

  it('puts the coordinates in the right place', () => {
    expect(distanceKm(coordsOf('St. Louis', 'MO'), [38.627, -90.199])).toBeLessThan(10);
    expect(distanceKm(coordsOf('Tulsa', 'OK'), [36.154, -95.993])).toBeLessThan(15);
  });

  it("returns 'unresolved' for a name used by several places in a state, null when unknown", () => {
    expect(lookupPlace('Springfield', 'PA')).toBe('unresolved');
    expect(lookupPlace('Notarealtown', 'TX')).toBeNull();
    expect(lookupPlace('Tulsa', 'TX')).toBeNull();
  });
});

describe('checkPointLocation thresholds', () => {
  const nashville = coordsOf('Nashville', 'TN');

  it(`flags a city-placed listing just over ${WRONG_CITY_KM} km, not one just under`, () => {
    const near = northOf(nashville, WRONG_CITY_KM - 1);
    const far = northOf(nashville, WRONG_CITY_KM + 1);
    const top = [listing(1, 'Nashville, TN · (615) 555-0100')];
    expect(checkPointLocation(top, near[0], near[1])).toMatchObject({ status: 'clean', wrongCity: false, coverage: 1, far: [] });
    const flagged = checkPointLocation(top, far[0], far[1]);
    expect(flagged).toMatchObject({ status: 'wrong_city', wrongCity: true, coverage: 1 });
    expect(flagged.far).toEqual([{ rank: 1, title: 'L1', place: 'Nashville, TN', km: WRONG_CITY_KM + 1, method: 'place' }]);
  });

  it(`falls back to the state center with ${STATE_FALLBACK_KM} km for unknown and ambiguous names`, () => {
    const texas: [number, number] = [31.5, -99.3];
    const under = northOf(texas, STATE_FALLBACK_KM - 1);
    const over = northOf(texas, STATE_FALLBACK_KM + 1);
    const unknown = [listing(1, 'Notarealtown, TX · 1')];
    expect(checkPointLocation(unknown, under[0], under[1])).toMatchObject({ status: 'unresolved', coverage: 0, stateChecked: 1, far: [] });
    expect(checkPointLocation(unknown, over[0], over[1])).toMatchObject({
      status: 'wrong_city', stateChecked: 1, far: [{ rank: 1, place: 'Notarealtown, TX', km: STATE_FALLBACK_KM + 1, method: 'state' }],
    });

    const pennsylvania: [number, number] = [40.9, -77.8];
    const ambiguous = [listing(1, 'Springfield, PA · 1')];
    const paUnder = northOf(pennsylvania, STATE_FALLBACK_KM - 1);
    const paOver = northOf(pennsylvania, STATE_FALLBACK_KM + 1);
    expect(checkPointLocation(ambiguous, paUnder[0], paUnder[1]).status).toBe('unresolved');
    expect(checkPointLocation(ambiguous, paOver[0], paOver[1])).toMatchObject({ status: 'wrong_city', far: [{ method: 'state' }] });
  });

  it('a state-checked listing that passes does not count as coverage, a city-placed one does', () => {
    const [lat, lng] = northOf(nashville, 10);
    const mixed = [listing(1, 'Notarealtown, TN · 1'), listing(2, 'Nashville, TN · 1')];
    expect(checkPointLocation(mixed, lat, lng)).toMatchObject({ status: 'clean', coverage: 1, stateChecked: 1 });
  });

  it("is 'unresolved' when no top-5 listing has a city, and 'clean' for an empty list", () => {
    const [lat, lng] = nashville;
    const streets = [1, 2, 3, 4, 5].map((n) => listing(n, `${n}00 Main St · (615) 555-0100`));
    expect(checkPointLocation(streets, lat, lng)).toMatchObject({ status: 'unresolved', wrongCity: false, coverage: 0, stateChecked: 0 });
    expect(checkPointLocation([], lat, lng)).toMatchObject({ status: 'clean', wrongCity: false, coverage: 0, far: [] });
  });

  it('only looks at the top 5 listings', () => {
    const [lat, lng] = nashville;
    const sixth = [...[1, 2, 3, 4, 5].map((n) => listing(n, 'Nashville, TN · 1')), listing(6, 'Tulsa, OK · 1')];
    expect(checkPointLocation(sixth, lat, lng)).toMatchObject({ status: 'clean', far: [] });
    const fifth = [...[1, 2, 3, 4].map((n) => listing(n, 'Nashville, TN · 1')), listing(5, 'Tulsa, OK · 1')];
    expect(checkPointLocation(fifth, lat, lng)).toMatchObject({ status: 'wrong_city', far: [{ rank: 5, place: 'Tulsa, OK' }] });
  });

  it('ignores listings in an unknown state code', () => {
    const [lat, lng] = nashville;
    expect(checkPointLocation([listing(1, 'Toronto, ON · 1')], lat, lng)).toMatchObject({ status: 'unresolved', stateChecked: 0 });
  });
});

describe('real Nov 15 2026 responses', () => {
  const check = (name: FixtureName) => {
    const fixture = loadDfsFixture(name);
    return buildGridPoint({ row: 0, col: 0, lat: fixture.lat, lng: fixture.lng }, fixture.items, '', { depth: 20 }).location;
  };

  it('flags the King George point that came back with Tulsa/Pueblo/Albuquerque clinics', () => {
    const result = check('kg-bad');
    expect(result.status).toBe('wrong_city');
    expect(result.far.map((f) => f.place)).toEqual(['Tulsa, OK', 'Pueblo, CO', 'Albuquerque, NM', 'Henderson, NV', 'Tulsa, OK']);
    expect(Math.min(...result.far.map((f) => f.km))).toBeGreaterThan(1000);
  });

  it('keeps the neighboring good King George point (with a La Plata, MD listing) clean', () => {
    const result = check('kg-good');
    expect(result).toMatchObject({ status: 'clean', wrongCity: false, coverage: 5, far: [] });
  });

  it('flags a Fort Worth point whose top 5 include Tulsa, 367 km away', () => {
    const result = check('fort-worth-tulsa');
    expect(result.status).toBe('wrong_city');
    expect(result.far).toContainEqual(expect.objectContaining({ place: 'Tulsa, OK', km: 367, method: 'place' }));
    // Tulsa alone (other listings local) is enough.
    const fixture = loadDfsFixture('fort-worth-tulsa');
    const onlyTulsa = [1, 2, 3, 4].map((n) => listing(n, 'Fort Worth, TX · 1')).concat(listing(5, 'Tulsa, OK · (918) 555-0100'));
    expect(checkPointLocation(onlyTulsa, fixture.lat, fixture.lng)).toMatchObject({ status: 'wrong_city', far: [{ rank: 5, km: 367 }] });
  });

  it.each([
    ['border-dc-md-va', ['MD', 'VA']],
    ['border-cincinnati', ['KY', 'OH']],
    ['border-philadelphia', ['NJ', 'PA']],
    ['border-louisville', ['IN', 'KY']],
  ] as const)('keeps the cross-state metro point %s clean', (name, states) => {
    const fixture = loadDfsFixture(name);
    const built = buildGridPoint({ row: 0, col: 0, lat: fixture.lat, lng: fixture.lng }, fixture.items, '', { depth: 20 });
    expect(built.location.status).toBe('clean');
    expect(built.location.far).toEqual([]);
    const topStates = new Set(built.point.items!.slice(0, 5).map((i) => i.place?.split(', ')[1]).filter(Boolean));
    for (const state of states) expect(topStates.has(state)).toBe(true);
  });

  it('flags the Mobility Project center point in the Nevada desert (Reno/Sparks/Fallon, 186-271 km)', () => {
    const result = check('mobility-desert');
    expect(result.status).toBe('wrong_city');
    expect(result.far.map((f) => f.place)).toEqual(['Reno, NV', 'Reno, NV', 'Sparks, NV', 'Fallon, NV']);
    expect(Math.min(...result.far.map((f) => f.km))).toBeGreaterThan(WRONG_CITY_KM);
  });

  it('does not flag a niche keyword whose only far listings sit at organic ranks 19-20', () => {
    const fixture = loadDfsFixture('deep-far-columbus');
    const built = buildGridPoint({ row: 0, col: 0, lat: fixture.lat, lng: fixture.lng }, fixture.items, '', { depth: 20 });
    expect(built.location).toMatchObject({ status: 'clean', far: [] });
    const deep = built.point.items!.filter((i) => i.place === 'Woodstock, GA').map((i) => i.rank_group);
    expect(deep).toEqual([19, 20]);
    expect(distanceKm([fixture.lat, fixture.lng], coordsOf('Woodstock', 'GA'))).toBeGreaterThan(WRONG_CITY_KM);
  });
});
