import { describe, expect, it } from 'vitest';

import { makeMilestone } from '../../../testing/fixtures';
import type { Memory, MemoryMedia } from './models';
import { Temporal } from './temporal';
import { buildYearRecap, recapHasContent, recapSeason, recapYears } from './year-recap';

const day = (iso: string) => Temporal.PlainDate.from(iso);
const photo = (n: number, memoryId: string): MemoryMedia => ({
  id: `${memoryId}-p${n}`,
  memoryId,
  filePath: `media/${memoryId}-${n}.jpg`,
  thumbnailPath: `media/thumbs/${memoryId}-${n}.jpg`,
  sortOrder: n,
  createdAt: '2026-01-01T00:00:00Z',
});
const memory = (id: string, memoryDate: string, photos = 0): Memory => ({
  id,
  milestoneId: null,
  title: id,
  body: null,
  memoryDate,
  media: Array.from({ length: photos }, (_, i) => photo(i, id)),
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

describe('buildYearRecap', () => {
  const memories = [
    memory('a', '2026-03-01', 1),
    memory('b', '2026-05-01', 3),
    memory('c', '2026-06-01', 0),
    memory('d', '2026-07-01', 2),
    memory('e', '2026-08-01', 1),
    memory('f', '2026-09-01', 5),
    memory('old', '2025-05-01', 4),
  ];
  const dates = [
    makeMilestone({ eventDate: '2024-06-14', recurrence: 'yearly' }), // every year
    makeMilestone({ eventDate: '2026-02-02', recurrence: 'none' }),
    makeMilestone({ eventDate: '2026-12-24', recurrence: 'none' }), // not reached yet
    makeMilestone({ eventDate: '2025-04-04', recurrence: 'none' }), // another year
  ];

  it('counts the year’s days, dates, memories and photos', () => {
    const recap = buildYearRecap('2024-06-14', dates, memories, 2026, day('2026-10-25'), 'feb28')!;
    expect(recap).toMatchObject({ year: 2026, dates: 2, memories: 6, photos: 12 });
    // From the start date to today in the current year.
    expect(recap.daysTogether).toBe(863); // the same as the counter on Home that day
  });

  it('uses the whole year once it is over, and picks the photo-rich memories as highlights', () => {
    const recap = buildYearRecap('2024-06-14', dates, memories, 2025, day('2026-10-25'), 'feb28')!;
    expect(recap.daysTogether).toBe(Temporal.PlainDate.from('2024-06-14').until('2025-12-31', { largestUnit: 'days' }).days);
    expect(recap).toMatchObject({ dates: 2, memories: 1, photos: 4 }); // yearly date + the April one
    const current = buildYearRecap('2024-06-14', dates, memories, 2026, day('2026-10-25'), 'feb28')!;
    expect(current.highlights.map((h) => h.memoryId)).toEqual(['f', 'b', 'd', 'a']); // 5, 3, 2 and the earlier of two singles
    expect(current.highlights[0].path).toBe('media/thumbs/f-0.jpg');
  });

  it('is empty before the start and for a year that has not begun', () => {
    expect(buildYearRecap('2024-06-14', dates, memories, 2023, day('2026-10-25'), 'feb28')).toBeNull();
    expect(buildYearRecap('2024-06-14', dates, memories, 2027, day('2026-10-25'), 'feb28')).toBeNull();
  });

  it('follows the leap-day policy for a yearly February 29', () => {
    const leap = [makeMilestone({ eventDate: '2024-02-29', recurrence: 'yearly', leapDayPolicy: null })];
    // 2026 isn't a leap year: the policy puts it on Feb 28 or Mar 1, both before this today.
    expect(buildYearRecap('2024-01-01', leap, [], 2026, day('2026-03-01'), 'feb28')!.dates).toBe(1);
    expect(buildYearRecap('2024-01-01', leap, [], 2026, day('2026-02-28'), 'mar1')!.dates).toBe(0);
  });

  it('says whether there is more than the day count to show', () => {
    expect(recapHasContent(buildYearRecap('2024-06-14', [], [], 2026, day('2026-10-25'), 'feb28')!)).toBe(false);
    expect(recapHasContent(buildYearRecap('2024-06-14', [], [memory('x', '2026-01-02')], 2026, day('2026-10-25'), 'feb28')!)).toBe(true);
  });
});

describe('recapYears and recapSeason', () => {
  it('lists years from the start year to this one, the newest first', () => {
    expect(recapYears('2024-06-14', day('2026-10-25'))).toEqual([2026, 2025, 2024]);
    expect(recapYears('2026-02-01', day('2026-10-25'))).toEqual([2026]);
  });

  it('points to the year in December and to the year that just ended in January', () => {
    expect(recapSeason(day('2026-11-30'))).toBeNull();
    expect(recapSeason(day('2026-12-01'))).toBe(2026);
    expect(recapSeason(day('2027-01-31'))).toBe(2026);
    expect(recapSeason(day('2027-02-01'))).toBeNull();
  });
});
