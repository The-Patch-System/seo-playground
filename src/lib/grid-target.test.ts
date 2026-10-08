import { describe, expect, it } from 'vitest';
import { matchesGridTarget, reconcileGridPoints } from './grid-target';

describe('matchesGridTarget', () => {
  it('matches a domain target against a listing that only has a title', () => {
    expect(matchesGridTarget('saint-esteve.com', { title: "Chateau Saint Esteve d'Uchaux" })).toBe(true);
    expect(matchesGridTarget('https://www.saint-esteve.com/vins', { title: "Château Saint-Estève d'Uchaux" })).toBe(true);
  });
  it('keeps plain substring matching and avoids unrelated listings', () => {
    expect(matchesGridTarget("Chateau Saint Esteve d'Uchaux", { title: "Chateau Saint Esteve d'Uchaux" })).toBe(true);
    expect(matchesGridTarget('saint-esteve.com', { title: 'Vin Chez Moi' })).toBe(false);
    expect(matchesGridTarget('a.fr', { title: 'Cave a vin' })).toBe(false);
  });
});

describe('reconcileGridPoints', () => {
  it('recomputes rank from stored items', () => {
    const [point] = reconcileGridPoints([{
      rank: null,
      items: [
        { rank_group: 1, title: 'Ovins', is_target: false },
        { rank_group: 3, title: "Chateau Saint Esteve d'Uchaux", is_target: false },
      ],
    }], 'saint-esteve.com');
    expect(point.rank).toBe(3);
    expect(point.items?.[1].is_target).toBe(true);
  });
});
