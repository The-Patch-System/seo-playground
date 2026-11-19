import { describe, expect, it } from 'vitest';
import { formatRadiusMiles, gridRadiusMiles, labsLocationLabel, spacingKmForRadius } from './geo-options';

describe('labsLocationLabel', () => {
  it('resolves LLM Mentions location codes to country names', () => {
    expect(labsLocationLabel(2124)).toBe('Canada');
    expect(labsLocationLabel('2840')).toBe('United States');
  });

  it('keeps unknown values visible instead of hiding them', () => {
    expect(labsLocationLabel(9999)).toBe('9999');
    expect(labsLocationLabel('custom location')).toBe('custom location');
  });
});

describe('grid radius helpers', () => {
  it('converts grid size and spacing to a radius in miles', () => {
    expect(gridRadiusMiles(9, 2)).toBeCloseTo(4.97, 2);
    expect(gridRadiusMiles(9, 1)).toBeCloseTo(2.49, 2);
  });

  it('derives spacing from a radius and round-trips', () => {
    expect(spacingKmForRadius(9, 5)).toBeCloseTo(2.01, 2);
    expect(gridRadiusMiles(7, spacingKmForRadius(7, 3))).toBeCloseTo(3, 10);
    expect(spacingKmForRadius(1, 5)).toBe(0);
  });

  it('formats radius for display', () => {
    expect(formatRadiusMiles(gridRadiusMiles(9, 2))).toBe('5 mi');
    expect(formatRadiusMiles(gridRadiusMiles(9, 1))).toBe('2.5 mi');
  });
});
