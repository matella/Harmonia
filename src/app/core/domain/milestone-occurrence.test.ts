import { describe, expect, it } from 'vitest';

import { loadDateVectors, makeMilestone } from '../../../testing/fixtures';
import { toPlainDate } from './local-date';
import {
  annualDateInYear,
  nextOccurrence,
  sortedPast,
  sortedUpcoming,
  upcomingOccurrences,
} from './milestone-occurrence';

const vectors = loadDateVectors();

describe('nextOccurrence (shared vectors)', () => {
  for (const v of vectors.annualOccurrence) {
    it(v.name, () => {
      const milestone = makeMilestone({ eventDate: v.eventDate, recurrence: 'yearly' });
      const occurrence = nextOccurrence(milestone, toPlainDate(v.today), v.policy);
      expect(occurrence?.date.toString()).toBe(v.next);
      expect(occurrence?.daysFromToday).toBe(v.daysUntil);
      expect(occurrence?.occurrenceNumber).toBe(v.occurrenceNumber);
      expect(occurrence?.status).toBe(v.daysUntil === 0 ? 'today' : 'upcoming');
    });
  }
});

describe('nextOccurrence', () => {
  it('returns the date of a future one-off milestone', () => {
    const m = makeMilestone({ eventDate: '2026-12-24' });
    expect(nextOccurrence(m, toPlainDate('2026-10-18'), 'feb28')?.daysFromToday).toBe(67);
  });

  it('returns null for a past one-off milestone', () => {
    const m = makeMilestone({ eventDate: '2025-01-01' });
    expect(nextOccurrence(m, toPlainDate('2026-10-18'), 'feb28')).toBeNull();
  });

  it('lets a milestone-level leap policy override the app policy', () => {
    const m = makeMilestone({ eventDate: '2024-02-29', recurrence: 'yearly', leapDayPolicy: 'mar1' });
    expect(nextOccurrence(m, toPlainDate('2026-01-01'), 'feb28')?.date.toString()).toBe('2026-03-01');
  });
});

describe('annualDateInYear', () => {
  it('keeps Feb 29 in leap years and applies the policy otherwise', () => {
    const feb29 = toPlainDate('2024-02-29');
    expect(annualDateInYear(feb29, 2028, 'feb28').toString()).toBe('2028-02-29');
    expect(annualDateInYear(feb29, 2027, 'feb28').toString()).toBe('2027-02-28');
    expect(annualDateInYear(feb29, 2027, 'mar1').toString()).toBe('2027-03-01');
    expect(annualDateInYear(feb29, 2100, 'feb28').toString()).toBe('2100-02-28'); // 2100 is not leap
  });
});

describe('upcomingOccurrences', () => {
  it('lists consecutive yearly occurrences', () => {
    const m = makeMilestone({ eventDate: '2024-02-29', recurrence: 'yearly' });
    const dates = upcomingOccurrences(m, toPlainDate('2026-10-18'), 'feb28', 3).map((o) => o.date.toString());
    expect(dates).toEqual(['2027-02-28', '2028-02-29', '2029-02-28']);
  });

  it('yields a single occurrence for one-off events', () => {
    const m = makeMilestone({ eventDate: '2027-01-01' });
    expect(upcomingOccurrences(m, toPlainDate('2026-10-18'), 'feb28', 3)).toHaveLength(1);
  });
});

describe('ordering', () => {
  it('orders milestones on the same date deterministically', () => {
    const base = { eventDate: '2026-11-01', createdAt: '2026-01-01T00:00:00Z' };
    const timed = makeMilestone({ ...base, title: 'Zeta', eventTime: '08:00' });
    const alpha = makeMilestone({ ...base, title: 'alpha' });
    const beta = makeMilestone({ ...base, title: 'Beta' });
    const sameTitleLater = makeMilestone({ ...base, title: 'Beta', createdAt: '2026-02-01T00:00:00Z' });
    const today = toPlainDate('2026-10-18');
    const shuffled = [sameTitleLater, timed, beta, alpha];
    const order = sortedUpcoming(shuffled, today, 'feb28').map((o) => o.milestone.id);
    expect(order).toEqual([alpha.id, beta.id, sameTitleLater.id, timed.id]);
    expect(sortedUpcoming([...shuffled].reverse(), today, 'feb28').map((o) => o.milestone.id)).toEqual(order);
  });

  it('separates past one-off dates, most recent first, and keeps yearly ones upcoming', () => {
    const today = toPlainDate('2026-10-18');
    const old = makeMilestone({ eventDate: '2020-01-01' });
    const recent = makeMilestone({ eventDate: '2026-01-01' });
    const yearly = makeMilestone({ eventDate: '2020-05-05', recurrence: 'yearly' });
    expect(sortedPast([old, recent, yearly], today).map((o) => o.milestone.id)).toEqual([recent.id, old.id]);
    expect(sortedUpcoming([old, recent, yearly], today, 'feb28').map((o) => o.milestone.id)).toEqual([yearly.id]);
  });
});
