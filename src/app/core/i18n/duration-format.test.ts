import { describe, expect, it } from 'vitest';

import { translator as t } from '../../../testing/fixtures';
import { toPlainDate } from '../domain/local-date';
import {
  calendarParts,
  formatCalendarDuration,
  formatPreciseDuration,
  formatRelativeDays,
  formatShortCalendarDuration,
  formatWeeksAndDays,
} from './duration-format';

describe('duration formatting (en)', () => {
  it('pluralizes and omits zero parts', () => {
    expect(formatCalendarDuration(t, { years: 2, months: 4, days: 3 })).toBe('2 years, 4 months, 3 days');
    expect(formatCalendarDuration(t, { years: 1, months: 0, days: 1 })).toBe('1 year, 1 day');
    expect(formatCalendarDuration(t, { years: 0, months: 1, days: 0 })).toBe('1 month');
    expect(formatCalendarDuration(t, { years: 0, months: 0, days: 0 })).toBe('');
  });

  it('builds a short headline for widgets', () => {
    expect(formatShortCalendarDuration(t, { years: 2, months: 4, days: 3 })).toBe('2 years, 4 months');
    expect(formatShortCalendarDuration(t, { years: 0, months: 0, days: 12 })).toBe('12 days');
  });

  it('exposes numeral/unit parts for the hero counter', () => {
    expect(calendarParts(t, { years: 1, months: 0, days: 5 })).toEqual([
      { value: 1, unit: 'year' },
      { value: 5, unit: 'days' },
    ]);
  });

  it('formats weeks, precise durations and counts with grouping', () => {
    expect(formatWeeksAndDays(t, 122, 2)).toBe('122 weeks, 2 days');
    expect(formatWeeksAndDays(t, 0, 0)).toBe('0 days');
    expect(formatPreciseDuration(t, { days: 1, hours: 1, minutes: 0, seconds: 5, totalMilliseconds: 0 }, true)).toBe(
      '1 day, 1 hour, 0 minutes, 5 seconds',
    );
    expect(t.plural('counter.daysTogether', 1234)).toBe('1,234 days together');
    expect(t.plural('counter.daysTogether', 1)).toBe('1 day together');
  });

  it('describes relative days', () => {
    expect(formatRelativeDays(t, 0)).toBe('Today');
    expect(formatRelativeDays(t, 1)).toBe('Tomorrow');
    expect(formatRelativeDays(t, 12)).toBe('in 12 days');
    expect(formatRelativeDays(t, -3)).toBe('3 days ago');
  });

  it('formats calendar dates without time-zone shifts', () => {
    expect(t.formatDate(toPlainDate('2024-06-14'), 'long')).toBe('June 14, 2024');
    expect(t.formatDate(toPlainDate('2024-01-01'), 'full')).toBe('Monday, January 1, 2024');
    expect(t.formatTime('09:00')).toBe('9:00 AM');
  });
});
