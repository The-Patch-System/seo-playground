import { describe, expect, it } from 'vitest';
import { latestRunPerSeries } from './grid-latest';

describe('latestRunPerSeries', () => {
  it('keeps the newest run per series from newest-first input', () => {
    const rows = [
      { id: 'a3', series_id: 'a', ts: 300 },
      { id: 'b2', series_id: 'b', ts: 200 },
      { id: 'a1', series_id: 'a', ts: 100 },
    ];
    expect(latestRunPerSeries(rows).map((r) => r.id)).toEqual(['a3', 'b2']);
  });

  it('does not depend on input ordering and returns newest-first', () => {
    const rows = [
      { id: 'a1', series_id: 'a', ts: 100 },
      { id: 'b2', series_id: 'b', ts: 400 },
      { id: 'a3', series_id: 'a', ts: 300 },
    ];
    expect(latestRunPerSeries(rows).map((r) => r.id)).toEqual(['b2', 'a3']);
  });

  it('returns an empty list for no entries', () => {
    expect(latestRunPerSeries([])).toEqual([]);
  });
});
