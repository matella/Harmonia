import { daysBetween, toPlainDate } from './local-date';
import { annualDateInYear } from './milestone-occurrence';
import type { LeapDayPolicy, Memory, Milestone } from './models';
import { Temporal } from './temporal';

/**
 * "Your year together": a summary of one calendar year from what is saved on the phone.
 * Numbers and photos only, no names or dates, so the picture made from it can be shared
 * without giving anything away. Pure: a function of the data, a year and today.
 */

export interface RecapPhoto {
  /** The memory the photo belongs to. */
  memoryId: string;
  /** App-private path of the photo (its thumbnail when there is one). */
  path: string;
}

export interface YearRecap {
  year: number;
  /** Days from the start date to the end of the year (or to today, in the current year). */
  daysTogether: number;
  /** Dates (not counting the derived together milestones) that fell in the year and have come. */
  dates: number;
  /** Memories whose date is in the year. */
  memories: number;
  /** Photos of those memories. */
  photos: number;
  /** Up to four, one from each of the memories with the most photos. */
  highlights: RecapPhoto[];
}

export const MAX_HIGHLIGHTS = 4;

/** The years that can be recapped: from the year of the start date up to today's. */
export function recapYears(startDate: string, today: Temporal.PlainDate): number[] {
  const first = toPlainDate(startDate).year;
  const years: number[] = [];
  for (let year = today.year; year >= first; year--) years.push(year);
  return years;
}

/** Null before the relationship started, or for a year that hasn't begun. */
export function buildYearRecap(
  startDate: string,
  milestones: readonly Milestone[],
  memories: readonly Memory[],
  year: number,
  today: Temporal.PlainDate,
  appPolicy: LeapDayPolicy,
): YearRecap | null {
  const start = toPlainDate(startDate);
  if (year < start.year || year > today.year) return null;
  const endOfYear = Temporal.PlainDate.from({ year, month: 12, day: 31 });
  const until = Temporal.PlainDate.compare(endOfYear, today) < 0 ? endOfYear : today;
  const daysTogether = Math.max(0, daysBetween(start, until));

  let dates = 0;
  for (const m of milestones) {
    const original = toPlainDate(m.eventDate);
    const date =
      m.recurrence === 'yearly'
        ? year >= original.year
          ? annualDateInYear(original, year, m.leapDayPolicy ?? appPolicy)
          : null
        : original.year === year
          ? original
          : null;
    if (date && Temporal.PlainDate.compare(date, today) <= 0) dates++;
  }

  const ofYear = memories.filter((m) => toPlainDate(m.memoryDate).year === year);
  const withPhotos = ofYear
    .filter((m) => m.media.length > 0)
    .sort((a, b) => b.media.length - a.media.length || a.memoryDate.localeCompare(b.memoryDate) || a.id.localeCompare(b.id));
  const highlights = withPhotos.slice(0, MAX_HIGHLIGHTS).map((m) => {
    const cover = [...m.media].sort((a, b) => a.sortOrder - b.sortOrder)[0];
    return { memoryId: m.id, path: cover.thumbnailPath ?? cover.filePath };
  });

  return {
    year,
    daysTogether,
    dates,
    memories: ofYear.length,
    photos: ofYear.reduce((sum, m) => sum + m.media.length, 0),
    highlights,
  };
}

/** Whether a recap has anything beyond the day count to show. */
export function recapHasContent(recap: YearRecap): boolean {
  return recap.dates > 0 || recap.memories > 0;
}

/**
 * The year Home points to: this year in December, the year that just ended in January;
 * null the rest of the time.
 */
export function recapSeason(today: Temporal.PlainDate): number | null {
  if (today.month === 12) return today.year;
  if (today.month === 1) return today.year - 1;
  return null;
}
