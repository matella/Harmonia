/** Laying out one to four photos in a rectangle (the picture of a year together). */

export interface GridRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const PHOTO_GAP = 24;

/** The cells for `count` photos inside `area`: one wide, two side by side, or a grid. */
export function photoCells(count: number, area: GridRect): GridRect[] {
  if (count <= 0) return [];
  if (count === 1) return [area];
  const half = (area.w - PHOTO_GAP) / 2;
  if (count === 2) {
    return [0, 1].map((i) => ({ x: area.x + i * (half + PHOTO_GAP), y: area.y, w: half, h: area.h }));
  }
  const row = (area.h - PHOTO_GAP) / 2;
  const bottom = area.y + row + PHOTO_GAP;
  const right = area.x + half + PHOTO_GAP;
  const top = [
    { x: area.x, y: area.y, w: half, h: row },
    { x: right, y: area.y, w: half, h: row },
  ];
  // Three photos: the third spans the bottom row; four fill a grid.
  return count === 3
    ? [...top, { x: area.x, y: bottom, w: area.w, h: row }]
    : [...top, { x: area.x, y: bottom, w: half, h: row }, { x: right, y: bottom, w: half, h: row }];
}
