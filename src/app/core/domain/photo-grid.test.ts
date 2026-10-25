import { describe, expect, it } from 'vitest';

import { photoCells, PHOTO_GAP } from './photo-grid';

const area = { x: 80, y: 850, w: 920, h: 420 };

describe('photoCells', () => {
  it('gives nothing for no photos and the whole area for one', () => {
    expect(photoCells(0, area)).toEqual([]);
    expect(photoCells(1, area)).toEqual([area]);
  });

  it('keeps every cell inside the area, apart by the gap, for two to four photos', () => {
    for (const count of [2, 3, 4]) {
      const cells = photoCells(count, area);
      expect(cells).toHaveLength(count);
      for (const c of cells) {
        expect(c.x).toBeGreaterThanOrEqual(area.x);
        expect(c.y).toBeGreaterThanOrEqual(area.y);
        expect(c.x + c.w).toBeLessThanOrEqual(area.x + area.w + 1e-9);
        expect(c.y + c.h).toBeLessThanOrEqual(area.y + area.h + 1e-9);
      }
      // No two cells overlap.
      cells.forEach((a, i) =>
        cells.slice(i + 1).forEach((b) => {
          const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
          expect(apart).toBe(true);
        }),
      );
    }
    const [first, second] = photoCells(2, area);
    expect(second.x - (first.x + first.w)).toBe(PHOTO_GAP);
  });

  it('spans the bottom row with the third photo', () => {
    const [, , third] = photoCells(3, area);
    expect(third.w).toBe(area.w);
  });
});
