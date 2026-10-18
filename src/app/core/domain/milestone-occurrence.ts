import { daysBetween, isLeapYear, toPlainDate } from './local-date';
import type { LeapDayPolicy, Milestone } from './models';
import { Temporal } from './temporal';

export type OccurrenceStatus = 'past' | 'today' | 'upcoming';

export interface Occurrence {
  milestone: Milestone;
  date: Temporal.PlainDate;
  /** Negative for past dates. */
  daysFromToday: number;
  status: OccurrenceStatus;
  /** For yearly milestones: 0 for the original date, 1 for the first anniversary, … */
  occurrenceNumber: number;
}

/** The date a yearly event falls on in `year`, applying the leap-day policy to Feb 29. */
export function annualDateInYear(
  original: Temporal.PlainDate,
  year: number,
  policy: LeapDayPolicy,
): Temporal.PlainDate {
  if (original.month === 2 && original.day === 29 && !isLeapYear(year)) {
    return policy === 'mar1'
      ? Temporal.PlainDate.from({ year, month: 3, day: 1 })
      : Temporal.PlainDate.from({ year, month: 2, day: 28 });
  }
  return Temporal.PlainDate.from({ year, month: original.month, day: original.day });
}

export function effectiveLeapPolicy(milestone: Milestone, appPolicy: LeapDayPolicy): LeapDayPolicy {
  return milestone.leapDayPolicy ?? appPolicy;
}

function statusOf(days: number): OccurrenceStatus {
  return days === 0 ? 'today' : days > 0 ? 'upcoming' : 'past';
}

/**
 * The first occurrence on or after `today`, or null when a one-off date has passed.
 * Yearly events never occur before their original date.
 */
export function nextOccurrence(
  milestone: Milestone,
  today: Temporal.PlainDate,
  appPolicy: LeapDayPolicy,
): Occurrence | null {
  const original = toPlainDate(milestone.eventDate);
  if (Temporal.PlainDate.compare(original, today) >= 0) {
    const days = daysBetween(today, original);
    return { milestone, date: original, daysFromToday: days, status: statusOf(days), occurrenceNumber: 0 };
  }
  if (milestone.recurrence !== 'yearly') return null;
  const policy = effectiveLeapPolicy(milestone, appPolicy);
  let year = today.year;
  let candidate = annualDateInYear(original, year, policy);
  if (Temporal.PlainDate.compare(candidate, today) < 0) {
    year += 1;
    candidate = annualDateInYear(original, year, policy);
  }
  const days = daysBetween(today, candidate);
  return {
    milestone,
    date: candidate,
    daysFromToday: days,
    status: statusOf(days),
    occurrenceNumber: year - original.year,
  };
}

/** The original date of a milestone, positioned relative to today (for timelines). */
export function originalOccurrence(milestone: Milestone, today: Temporal.PlainDate): Occurrence {
  const date = toPlainDate(milestone.eventDate);
  const days = daysBetween(today, date);
  return { milestone, date, daysFromToday: days, status: statusOf(days), occurrenceNumber: 0 };
}

/**
 * Up to `count` consecutive occurrences starting at the next one (yearly events yield
 * several, one-off events at most one). Used for reminders and widget snapshots.
 */
export function upcomingOccurrences(
  milestone: Milestone,
  today: Temporal.PlainDate,
  appPolicy: LeapDayPolicy,
  count: number,
): Occurrence[] {
  const first = nextOccurrence(milestone, today, appPolicy);
  if (!first) return [];
  const result = [first];
  if (milestone.recurrence !== 'yearly') return result;
  const original = toPlainDate(milestone.eventDate);
  const policy = effectiveLeapPolicy(milestone, appPolicy);
  for (let i = 1; i < count; i++) {
    const n = first.occurrenceNumber + i;
    const date = annualDateInYear(original, original.year + n, policy);
    const days = daysBetween(today, date);
    result.push({ milestone, date, daysFromToday: days, status: statusOf(days), occurrenceNumber: n });
  }
  return result;
}

/**
 * Deterministic ordering for occurrences: date, then time (untimed first), then
 * title (locale-aware, case-insensitive), then creation time, then id.
 */
export function compareOccurrences(a: Occurrence, b: Occurrence): number {
  return (
    Temporal.PlainDate.compare(a.date, b.date) ||
    compareMilestonesSameDay(a.milestone, b.milestone)
  );
}

export function compareMilestonesSameDay(a: Milestone, b: Milestone): number {
  const timeA = a.eventTime ?? '';
  const timeB = b.eventTime ?? '';
  if (timeA !== timeB) return timeA < timeB ? -1 : 1;
  const title = a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
  if (title !== 0) return title;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Next occurrences of all milestones, soonest first, with deterministic tie-breaking. */
export function sortedUpcoming(
  milestones: readonly Milestone[],
  today: Temporal.PlainDate,
  appPolicy: LeapDayPolicy,
): Occurrence[] {
  return milestones
    .map((m) => nextOccurrence(m, today, appPolicy))
    .filter((o): o is Occurrence => o !== null)
    .sort(compareOccurrences);
}

/** One-off milestones whose date has passed, most recent first. */
export function sortedPast(milestones: readonly Milestone[], today: Temporal.PlainDate): Occurrence[] {
  return milestones
    .filter((m) => m.recurrence === 'none')
    .map((m) => originalOccurrence(m, today))
    .filter((o) => o.status === 'past')
    .sort((a, b) => -compareOccurrences(a, b));
}
