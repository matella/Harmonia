import { describe, expect, it } from 'vitest';

import { makeMilestone } from '../../../testing/fixtures';
import { toPlainDate } from './local-date';
import { calendarDurationBetween } from './relationship-duration';
import {
  isDayMarkCount,
  isKeyMonthCount,
  monthMarkDate,
  nextTogetherMark,
  togetherMarkComesFirst,
  togetherOptionsFrom,
  upcomingTogetherMarks,
  type TogetherOptions,
} from './together-milestones';

const KEY: TogetherOptions = { months: 'key', days: false, skipWholeYears: false };
const EVERY: TogetherOptions = { months: 'every', days: false, skipWholeYears: false };
const DAYS: TogetherOptions = { months: 'off', days: true, skipWholeYears: false };

const summary = (start: string, today: string, options: TogetherOptions, limit: number) =>
  upcomingTogetherMarks(start, toPlainDate(today), options, limit).map((m) => `${m.kind}:${m.count}@${m.date.toString()}`);

describe('together milestone sequences', () => {
  it('key months are 1, 3, 6, 9, then every half year', () => {
    const counts = Array.from({ length: 40 }, (_, i) => i + 1).filter(isKeyMonthCount);
    expect(counts).toEqual([1, 3, 6, 9, 12, 18, 24, 30, 36]);
  });

  it('day marks are 100, 200, 300, then every 500', () => {
    const counts = Array.from({ length: 3000 }, (_, i) => i + 1).filter(isDayMarkCount);
    expect(counts).toEqual([100, 200, 300, 500, 1000, 1500, 2000, 2500, 3000]);
  });
});

describe('upcomingTogetherMarks', () => {
  it('lists key months from the start', () => {
    expect(summary('2024-06-14', '2024-06-14', KEY, 5)).toEqual([
      'months:1@2024-07-14',
      'months:3@2024-09-14',
      'months:6@2024-12-14',
      'months:9@2025-03-14',
      'months:12@2025-06-14',
    ]);
  });

  it('includes a mark that falls today, then continues', () => {
    expect(summary('2024-06-14', '2024-12-14', KEY, 2)).toEqual(['months:6@2024-12-14', 'months:9@2025-03-14']);
    expect(upcomingTogetherMarks('2024-06-14', toPlainDate('2024-12-14'), KEY, 1)[0].status).toBe('today');
  });

  it('continues with half years after the first year', () => {
    expect(summary('2024-06-14', '2026-10-18', KEY, 3)).toEqual([
      'months:30@2026-12-14',
      'months:36@2027-06-14',
      'months:42@2027-12-14',
    ]);
  });

  it('every month skips nothing but whole years when an anniversary covers them', () => {
    expect(summary('2024-06-14', '2025-04-20', EVERY, 3)).toEqual([
      'months:11@2025-05-14',
      'months:12@2025-06-14',
      'months:13@2025-07-14',
    ]);
    expect(summary('2024-06-14', '2025-04-20', { ...EVERY, skipWholeYears: true }, 2)).toEqual([
      'months:11@2025-05-14',
      'months:13@2025-07-14',
    ]);
  });

  it('clamps month marks to the end of shorter months, measured from the start', () => {
    expect(summary('2023-01-31', '2023-01-31', EVERY, 4)).toEqual([
      'months:1@2023-02-28',
      'months:2@2023-03-31',
      'months:3@2023-04-30',
      'months:4@2023-05-31',
    ]);
    expect(monthMarkDate(toPlainDate('2024-02-29'), 12).toString()).toBe('2025-02-28');
  });

  it('lists day marks and merges them with months by date', () => {
    expect(summary('2024-06-14', '2024-06-14', DAYS, 4)).toEqual([
      'days:100@2024-09-22',
      'days:200@2024-12-31',
      'days:300@2025-04-10',
      'days:500@2025-10-27',
    ]);
    expect(summary('2024-06-14', '2026-10-18', { ...KEY, days: true }, 3)).toEqual([
      'months:30@2026-12-14',
      'days:1000@2027-03-11',
      'months:36@2027-06-14',
    ]);
  });

  it('returns nothing when both kinds are off', () => {
    expect(nextTogetherMark('2024-06-14', toPlainDate('2025-01-01'), { months: 'off', days: false, skipWholeYears: false })).toBeNull();
  });
});

describe('together marks agree with the counter', () => {
  const starts = ['2024-06-14', '2023-01-31', '2024-01-30', '2024-02-29', '2023-03-31', '2024-12-31'];
  for (const start of starts) {
    it(`month marks from ${start} read exactly N months on the day, N-1 the day before`, () => {
      const s = toPlainDate(start);
      for (const mark of upcomingTogetherMarks(start, s, EVERY, 120)) {
        const onDay = calendarDurationBetween(s, mark.date);
        expect(onDay.years * 12 + onDay.months).toBe(mark.count);
        expect(onDay.days).toBe(0);
        const before = calendarDurationBetween(s, mark.date.subtract({ days: 1 }));
        expect(before.years * 12 + before.months).toBe(mark.count - 1);
      }
    });

    it(`day marks from ${start} equal the total days`, () => {
      const s = toPlainDate(start);
      for (const mark of upcomingTogetherMarks(start, s, DAYS, 12)) {
        expect(s.until(mark.date).days).toBe(mark.count);
      }
    });
  }
});

describe('togetherOptionsFrom', () => {
  it('skips whole years only when a yearly milestone sits on the start date', () => {
    const settings = { togetherMonths: 'key', togetherDays: true } as const;
    const anniversary = makeMilestone({ eventDate: '2024-06-14', recurrence: 'yearly' });
    const oneOff = makeMilestone({ eventDate: '2024-06-14', recurrence: 'none' });
    expect(togetherOptionsFrom(settings, [anniversary], '2024-06-14').skipWholeYears).toBe(true);
    expect(togetherOptionsFrom(settings, [oneOff], '2024-06-14').skipWholeYears).toBe(false);
    expect(togetherOptionsFrom(settings, [anniversary], '2024-06-15').skipWholeYears).toBe(false);
  });
});

describe('togetherMarkComesFirst', () => {
  const mark = upcomingTogetherMarks('2024-06-14', toPlainDate('2024-06-14'), KEY, 1)[0]; // 2024-07-14

  it('puts the mark first only when it is strictly earlier', () => {
    expect(togetherMarkComesFirst(mark, null)).toBe(true);
    expect(togetherMarkComesFirst(mark, toPlainDate('2024-07-15'))).toBe(true);
    expect(togetherMarkComesFirst(mark, toPlainDate('2024-07-14'))).toBe(false);
    expect(togetherMarkComesFirst(mark, toPlainDate('2024-07-13'))).toBe(false);
  });
});
