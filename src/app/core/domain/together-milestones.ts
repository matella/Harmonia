import { daysBetween, toPlainDate, type IsoDate } from './local-date';
import type { OccurrenceStatus } from './milestone-occurrence';
import type { AppSettings, Milestone, TogetherMonthsMode } from './models';
import { Temporal } from './temporal';

/**
 * "Together" milestones are derived from the relationship start date — 1, 3, 6 months
 * together, 100 days together, … They are never stored: like the counter, they are
 * recomputed from the profile and the clock. Their dates use exactly the counter's month
 * arithmetic (`start + N months`, clamped to the end of shorter months), so on the day
 * of "N months together" the counter reads N months and 0 days.
 */
export type TogetherMarkKind = 'months' | 'days';

export interface TogetherMark {
  kind: TogetherMarkKind;
  /** Months or days since the start date. */
  count: number;
  date: Temporal.PlainDate;
  /** Negative for past marks. */
  daysFromToday: number;
  status: OccurrenceStatus;
}

export interface TogetherOptions {
  months: TogetherMonthsMode;
  days: boolean;
  /**
   * Leave out whole years (12, 24, … months) because a yearly milestone on the start
   * date already celebrates them, e.g. the anniversary added during onboarding.
   */
  skipWholeYears: boolean;
}

/** Upper bounds keep every search finite and notification IDs within their range. */
export const MAX_TOGETHER_MONTHS = 1_800;
export const MAX_TOGETHER_DAYS = 60_000;

/** Key month counts: 1, 3, 6, 9 months, then every half year (1 year, 1 year 6 months, …). */
export function isKeyMonthCount(count: number): boolean {
  return count === 1 || count === 3 || count === 6 || count === 9 || (count >= 12 && count % 6 === 0);
}

/** Day counts worth celebrating: 100, 200, 300, then every 500 (500, 1,000, 1,500, …). */
export function isDayMarkCount(count: number): boolean {
  return count === 100 || count === 200 || count === 300 || (count >= 500 && count % 500 === 0);
}

/** The date of "N months together": the counter's anchor rule, never chained month by month. */
export function monthMarkDate(start: Temporal.PlainDate, count: number): Temporal.PlainDate {
  return start.add({ months: count }, { overflow: 'constrain' });
}

export function togetherOptionsFrom(
  settings: Pick<AppSettings, 'togetherMonths' | 'togetherDays'>,
  milestones: readonly Milestone[],
  startDate: IsoDate,
): TogetherOptions {
  return {
    months: settings.togetherMonths,
    days: settings.togetherDays,
    skipWholeYears: milestones.some((m) => m.recurrence === 'yearly' && m.eventDate === startDate),
  };
}

function includesMonth(count: number, options: TogetherOptions): boolean {
  if (options.months === 'off') return false;
  if (options.skipWholeYears && count % 12 === 0) return false;
  return options.months === 'every' || isKeyMonthCount(count);
}

function mark(kind: TogetherMarkKind, count: number, date: Temporal.PlainDate, today: Temporal.PlainDate): TogetherMark {
  const days = daysBetween(today, date);
  return { kind, count, date, daysFromToday: days, status: days === 0 ? 'today' : days > 0 ? 'upcoming' : 'past' };
}

/** Same date: month marks first (they also cover the day-count wording), then by count. */
export function compareTogetherMarks(a: TogetherMark, b: TogetherMark): number {
  return (
    Temporal.PlainDate.compare(a.date, b.date) ||
    (a.kind === b.kind ? a.count - b.count : a.kind === 'months' ? -1 : 1)
  );
}

/**
 * The next `limit` marks on or after `today`, soonest first. Marks before the start
 * date's first month/hundred days are never produced, and day 0 is not a mark.
 */
export function upcomingTogetherMarks(
  startDate: IsoDate,
  today: Temporal.PlainDate,
  options: TogetherOptions,
  limit: number,
): TogetherMark[] {
  if (limit <= 0) return [];
  const start = toPlainDate(startDate);
  const elapsedDays = Math.max(0, daysBetween(start, today));
  const marks: TogetherMark[] = [];

  if (options.months !== 'off') {
    // First month count whose date is today or later.
    let count = Math.max(1, (today.year - start.year) * 12 + (today.month - start.month) - 1);
    while (count <= MAX_TOGETHER_MONTHS && Temporal.PlainDate.compare(monthMarkDate(start, count), today) < 0) count++;
    let found = 0;
    for (; count <= MAX_TOGETHER_MONTHS && found < limit; count++) {
      if (!includesMonth(count, options)) continue;
      marks.push(mark('months', count, monthMarkDate(start, count), today));
      found++;
    }
  }

  if (options.days) {
    let found = 0;
    for (let count = Math.max(100, elapsedDays); count <= MAX_TOGETHER_DAYS && found < limit; count++) {
      if (!isDayMarkCount(count)) {
        // Jump straight to the next multiple of 100 instead of testing every day.
        count = Math.ceil((count + 1) / 100) * 100 - 1;
        continue;
      }
      marks.push(mark('days', count, start.add({ days: count }), today));
      found++;
    }
  }

  return marks.sort(compareTogetherMarks).slice(0, limit);
}

/** True when the mark comes strictly before `date`: on the same day, the user's own date wins. */
export function togetherMarkComesFirst(mark: TogetherMark, date: Temporal.PlainDate | null): boolean {
  return date === null || Temporal.PlainDate.compare(mark.date, date) < 0;
}

export function nextTogetherMark(
  startDate: IsoDate,
  today: Temporal.PlainDate,
  options: TogetherOptions,
): TogetherMark | null {
  return upcomingTogetherMarks(startDate, today, options, 1)[0] ?? null;
}
