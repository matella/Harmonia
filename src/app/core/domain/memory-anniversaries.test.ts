import { describe, expect, it } from 'vitest';

import { memoryReminderDays, memoriesOnThisDay } from './memory-anniversaries';
import type { Memory } from './models';
import { Temporal } from './temporal';

const memory = (id: string, memoryDate: string, createdAt = '2025-01-01T10:00:00Z'): Memory => ({
  id,
  milestoneId: null,
  title: id,
  body: null,
  memoryDate,
  media: [],
  createdAt,
  updatedAt: createdAt,
});
const day = (iso: string) => Temporal.PlainDate.from(iso);

describe('memoriesOnThisDay', () => {
  const memories = [
    memory('lisbon', '2024-05-01'),
    memory('ghent', '2023-05-01'),
    memory('today-last-year', '2025-10-25'),
    memory('this-year', '2026-05-01'), // not an earlier year
    memory('other-day', '2024-05-02'),
  ];

  it('finds the same day and month in earlier years, the oldest first', () => {
    const found = memoriesOnThisDay(memories, day('2026-05-01'), 'feb28');
    expect(found.map((f) => [f.memory.id, f.yearsAgo])).toEqual([
      ['ghent', 3],
      ['lisbon', 2],
    ]);
  });

  it('never returns a memory from the same year or the future', () => {
    expect(memoriesOnThisDay(memories, day('2026-10-25'), 'feb28').map((f) => f.memory.id)).toEqual([
      'today-last-year',
    ]);
    expect(memoriesOnThisDay([memory('later', '2027-05-01')], day('2026-05-01'), 'feb28')).toEqual([]);
  });

  it('follows the leap-day policy for a memory from February 29', () => {
    const leap = [memory('leap', '2024-02-29')];
    expect(memoriesOnThisDay(leap, day('2026-02-28'), 'feb28')).toHaveLength(1);
    expect(memoriesOnThisDay(leap, day('2026-03-01'), 'feb28')).toHaveLength(0);
    expect(memoriesOnThisDay(leap, day('2026-03-01'), 'mar1')).toHaveLength(1);
    expect(memoriesOnThisDay(leap, day('2028-02-29'), 'feb28')).toHaveLength(1);
  });

  it('breaks ties between equally old memories by when they were saved', () => {
    const tie = [memory('b', '2024-05-01', '2025-02-01T00:00:00Z'), memory('a', '2024-05-01', '2025-01-01T00:00:00Z')];
    expect(memoriesOnThisDay(tie, day('2026-05-01'), 'feb28').map((f) => f.memory.id)).toEqual(['a', 'b']);
  });
});

describe('memoryReminderDays', () => {
  it('leaves at least a week between reminders and stops at the limit', () => {
    const memories = [
      memory('a', '2024-11-01'),
      memory('b', '2024-11-03'), // within a week of the first: skipped
      memory('c', '2024-11-12'),
      memory('d', '2024-12-20'),
      memory('e', '2024-12-25'),
    ];
    const days = memoryReminderDays(memories, day('2026-10-25'), 'feb28', { max: 3 });
    expect(days.map((d) => [d.date.toString(), d.lead.memory.id])).toEqual([
      ['2026-11-01', 'a'],
      ['2026-11-12', 'c'],
      ['2026-12-20', 'd'],
    ]);
  });

  it('includes today, looks only as far as the horizon, and returns nothing without memories', () => {
    expect(memoryReminderDays([memory('t', '2025-10-25')], day('2026-10-25'), 'feb28')[0].date.toString()).toBe(
      '2026-10-25',
    );
    expect(memoryReminderDays([memory('far', '2024-06-01')], day('2026-10-25'), 'feb28')).toEqual([]);
    expect(memoryReminderDays([], day('2026-10-25'), 'feb28')).toEqual([]);
  });
});
