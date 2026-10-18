import { describe, expect, it } from 'vitest';

import { loadDateVectors, makeProfile } from '../../../testing/fixtures';
import { fixedClock } from './clock';
import { toPlainDate } from './local-date';
import {
  calendarDurationBetween,
  computeRelationshipCounter,
  startInstantOf,
} from './relationship-duration';
import { Temporal } from './temporal';

const vectors = loadDateVectors();

describe('calendarDurationBetween (shared vectors)', () => {
  for (const v of vectors.calendarDuration) {
    it(v.name, () => {
      const result = calendarDurationBetween(toPlainDate(v.start), toPlainDate(v.end));
      expect(result).toEqual({ years: v.years, months: v.months, days: v.days });
      expect(toPlainDate(v.start).until(toPlainDate(v.end)).days).toBe(v.totalDays);
    });
  }

  it('rejects an end before the start', () => {
    expect(() => calendarDurationBetween(toPlainDate('2024-01-02'), toPlainDate('2024-01-01'))).toThrow(RangeError);
  });

  it('never reports 12 months', () => {
    const start = toPlainDate('2024-02-29');
    for (let d = start; Temporal.PlainDate.compare(d, toPlainDate('2032-03-31')) <= 0; d = d.add({ days: 1 })) {
      const result = calendarDurationBetween(start, d);
      expect(result.months).toBeLessThan(12);
      expect(result.days).toBeLessThan(31);
    }
  });

  it('is monotonic: the duration never goes backwards from one day to the next', () => {
    const start = toPlainDate('2023-01-31');
    let previous = -1;
    for (let d = start; Temporal.PlainDate.compare(d, toPlainDate('2027-12-31')) <= 0; d = d.add({ days: 1 })) {
      const { years, months, days } = calendarDurationBetween(start, d);
      const ordinal = (years * 12 + months) * 100 + days;
      expect(ordinal).toBeGreaterThan(previous);
      previous = ordinal;
    }
  });
});

describe('computeRelationshipCounter', () => {
  it('starts at day 0 on the start date', () => {
    const counter = computeRelationshipCounter(
      makeProfile({ startDate: '2024-06-14' }),
      fixedClock('2024-06-14T10:00:00Z', 'Europe/Brussels'),
    );
    expect(counter.state).toBe('counting');
    if (counter.state !== 'counting') return;
    expect(counter.totalDays).toBe(0);
    expect(counter.calendar).toEqual({ years: 0, months: 0, days: 0 });
  });

  it('derives values purely from the stored date and the clock (no drift)', () => {
    const profile = makeProfile({ startDate: '2024-06-14' });
    const a = computeRelationshipCounter(profile, fixedClock('2026-10-18T12:00:00Z', 'Europe/Brussels'));
    const b = computeRelationshipCounter(profile, fixedClock('2026-10-18T12:00:00Z', 'Europe/Brussels'));
    expect(a).toEqual(b);
    if (a.state !== 'counting') throw new Error('expected counting');
    expect(a.totalDays).toBe(856);
    expect(a.calendar).toEqual({ years: 2, months: 4, days: 4 });
    expect(a.weeks).toBe(122);
    expect(a.weekRemainderDays).toBe(2);
  });

  it('evaluates the calendar day in calendarTimeZoneId, not the device zone', () => {
    const profile = makeProfile({ startDate: '2024-06-14', calendarTimeZoneId: 'Europe/Brussels' });
    // 23:30 UTC is already 01:30 the next day in Brussels (CEST), while a device in
    // New York is still on the 14th.
    const counter = computeRelationshipCounter(profile, fixedClock('2024-06-14T23:30:00Z', 'America/New_York'));
    expect(counter.state === 'counting' && counter.totalDays).toBe(1);
  });

  it('does not invent an exact time for a date-only profile', () => {
    const counter = computeRelationshipCounter(makeProfile(), fixedClock('2026-01-01T00:00:00Z', 'UTC'));
    expect(counter.state === 'counting' && counter.precise).toBeNull();
  });

  it('computes an exact elapsed duration when a start time exists', () => {
    const profile = makeProfile({
      startDate: '2024-06-14',
      startTime: '20:00',
      startTimeZoneId: 'Europe/Brussels',
    });
    const counter = computeRelationshipCounter(profile, fixedClock('2024-06-16T21:30:15Z', 'Europe/Brussels'));
    if (counter.state !== 'counting') throw new Error('expected counting');
    // Start instant = 18:00Z on the 14th; 2 days, 3 h 30 min 15 s later.
    expect(counter.precise).toMatchObject({ days: 2, hours: 3, minutes: 30, seconds: 15 });
  });

  it('keeps the historical start instant when the device changes time zone', () => {
    const profile = makeProfile({
      startDate: '2024-06-14',
      startTime: '20:00',
      startTimeZoneId: 'Europe/Brussels',
    });
    const instant = '2025-01-01T12:00:00Z';
    const inBrussels = computeRelationshipCounter(profile, fixedClock(instant, 'Europe/Brussels'));
    const inTokyo = computeRelationshipCounter(profile, fixedClock(instant, 'Asia/Tokyo'));
    expect(startInstantOf(profile)?.toString()).toBe('2024-06-14T18:00:00Z');
    expect(inTokyo).toEqual(inBrussels);
  });

  it('measures exact elapsed time across a DST spring-forward night', () => {
    const profile = makeProfile({
      startDate: '2024-03-09',
      startTime: '23:00',
      startTimeZoneId: 'America/New_York',
      calendarTimeZoneId: 'America/New_York',
    });
    // Clocks jumped from 02:00 to 03:00 on 10 March 2024: 23:00 → 23:00 is only 23 hours.
    const counter = computeRelationshipCounter(profile, fixedClock('2024-03-11T03:00:00Z', 'America/New_York'));
    if (counter.state !== 'counting') throw new Error('expected counting');
    expect(counter.totalDays).toBe(1);
    expect(counter.precise).toMatchObject({ days: 0, hours: 23, minutes: 0 });
  });

  it('measures exact elapsed time across a DST fall-back night', () => {
    const profile = makeProfile({
      startDate: '2024-11-02',
      startTime: '23:00',
      startTimeZoneId: 'America/New_York',
      calendarTimeZoneId: 'America/New_York',
    });
    // 3 November 2024 had 25 hours in New York.
    const counter = computeRelationshipCounter(profile, fixedClock('2024-11-04T04:00:00Z', 'America/New_York'));
    if (counter.state !== 'counting') throw new Error('expected counting');
    expect(counter.totalDays).toBe(1);
    expect(counter.precise).toMatchObject({ days: 1, hours: 1 });
  });

  it('reports a future start date explicitly instead of a negative duration', () => {
    const counter = computeRelationshipCounter(
      makeProfile({ startDate: '2026-12-01' }),
      fixedClock('2026-11-29T12:00:00Z', 'Europe/Brussels'),
    );
    expect(counter).toMatchObject({ state: 'not-started', daysUntilStart: 2 });
  });

  it('resolves a start time inside a DST gap forward by the gap length', () => {
    const profile = makeProfile({
      startDate: '2026-03-29',
      startTime: '02:30',
      startTimeZoneId: 'Europe/Brussels',
    });
    expect(startInstantOf(profile)?.toString()).toBe('2026-03-29T01:30:00Z'); // 03:30 CEST
  });
});
