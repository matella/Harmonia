import type { Clock } from './clock';
import { daysBetween, resolveLocalDateTime, toPlainDate, toPlainTime, todayIn } from './local-date';
import type { RelationshipProfile } from './models';
import { Temporal } from './temporal';

export interface CalendarDuration {
  years: number;
  months: number;
  days: number;
}

export interface PreciseDuration {
  /** Whole 24-hour periods since the start instant. */
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  totalMilliseconds: number;
}

export type RelationshipCounter =
  | {
      state: 'counting';
      calendar: CalendarDuration;
      totalDays: number;
      weeks: number;
      weekRemainderDays: number;
      /** Present only when the user entered an exact start time. */
      precise: PreciseDuration | null;
      today: Temporal.PlainDate;
    }
  | {
      /** Start date lies in the future (should be prevented by validation). */
      state: 'not-started';
      daysUntilStart: number;
      today: Temporal.PlainDate;
    };

/**
 * Calendar duration between two dates (end >= start), computed as:
 *   1. the number of complete months M such that start + M months <= end, where
 *      adding months clamps to the last day of a shorter month (Temporal "constrain",
 *      same as java.time plusMonths and Foundation Calendar);
 *   2. years = floor(M / 12), months = M mod 12;
 *   3. days = end - (start + M months).
 * Months are always measured from the original start date, so a Jan 31 start has
 * monthiversaries on the last day of shorter months, and a Feb 29 start celebrates
 * on Feb 28 in common years. This never yields "12 months". See DATE_AND_TIME_RULES.md.
 */
export function calendarDurationBetween(
  start: Temporal.PlainDate,
  end: Temporal.PlainDate,
): CalendarDuration {
  if (Temporal.PlainDate.compare(end, start) < 0) {
    throw new RangeError('end must not be before start');
  }
  let totalMonths = (end.year - start.year) * 12 + (end.month - start.month);
  let anchor = start.add({ months: totalMonths }, { overflow: 'constrain' });
  if (Temporal.PlainDate.compare(anchor, end) > 0) {
    totalMonths -= 1;
    anchor = start.add({ months: totalMonths }, { overflow: 'constrain' });
  }
  return {
    years: Math.floor(totalMonths / 12),
    months: totalMonths % 12,
    days: daysBetween(anchor, end),
  };
}

/** The exact start instant, or null for a date-only profile. */
export function startInstantOf(
  profile: Pick<RelationshipProfile, 'startDate' | 'startTime' | 'startTimeZoneId'>,
): Temporal.Instant | null {
  if (!profile.startTime || !profile.startTimeZoneId) return null;
  return resolveLocalDateTime(
    toPlainDate(profile.startDate),
    toPlainTime(profile.startTime),
    profile.startTimeZoneId,
  ).toInstant();
}

export function preciseDurationSince(start: Temporal.Instant, now: Temporal.Instant): PreciseDuration {
  const totalMilliseconds = Math.max(0, now.epochMilliseconds - start.epochMilliseconds);
  const totalSeconds = Math.floor(totalMilliseconds / 1000);
  return {
    days: Math.floor(totalSeconds / 86_400),
    hours: Math.floor((totalSeconds % 86_400) / 3_600),
    minutes: Math.floor((totalSeconds % 3_600) / 60),
    seconds: totalSeconds % 60,
    totalMilliseconds,
  };
}

/**
 * Derives every counter value from the persisted profile and the clock. Nothing here is
 * stored or incremented, so the counter cannot drift while the app is closed.
 */
export function computeRelationshipCounter(
  profile: Pick<
    RelationshipProfile,
    'startDate' | 'startTime' | 'startTimeZoneId' | 'calendarTimeZoneId'
  >,
  clock: Clock,
): RelationshipCounter {
  const start = toPlainDate(profile.startDate);
  const today = todayIn(clock, profile.calendarTimeZoneId);
  if (Temporal.PlainDate.compare(start, today) > 0) {
    return { state: 'not-started', daysUntilStart: daysBetween(today, start), today };
  }
  const totalDays = daysBetween(start, today);
  const startInstant = startInstantOf(profile);
  const now = clock.now();
  const precise =
    startInstant && Temporal.Instant.compare(now, startInstant) >= 0
      ? preciseDurationSince(startInstant, now)
      : null;
  return {
    state: 'counting',
    calendar: calendarDurationBetween(start, today),
    totalDays,
    weeks: Math.floor(totalDays / 7),
    weekRemainderDays: totalDays % 7,
    precise,
    today,
  };
}
