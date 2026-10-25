import { toPlainDate } from './local-date';
import { annualDateInYear } from './milestone-occurrence';
import type { LeapDayPolicy, Memory } from './models';
import type { Temporal } from './temporal';

/**
 * "On this day": memories whose date falls on today's day and month in an earlier year,
 * and the few days ahead on which one reminder is worth sending. Pure functions of the
 * memories and a date; a memory from February 29 follows the same leap-day policy as
 * yearly dates (docs/DATE_AND_TIME_RULES.md).
 */

export interface MemoryAnniversary {
  memory: Memory;
  /** Whole years since the memory's date (at least 1). */
  yearsAgo: number;
}

/** The oldest first, so the longest-kept memory leads. */
export function memoriesOnThisDay(
  memories: readonly Memory[],
  date: Temporal.PlainDate,
  policy: LeapDayPolicy,
): MemoryAnniversary[] {
  const found: MemoryAnniversary[] = [];
  for (const memory of memories) {
    const original = toPlainDate(memory.memoryDate);
    const yearsAgo = date.year - original.year;
    if (yearsAgo < 1) continue;
    if (annualDateInYear(original, date.year, policy).equals(date)) found.push({ memory, yearsAgo });
  }
  return found.sort(
    (a, b) => b.yearsAgo - a.yearsAgo || a.memory.createdAt.localeCompare(b.memory.createdAt) || a.memory.id.localeCompare(b.memory.id),
  );
}

export interface MemoryReminderDay {
  date: Temporal.PlainDate;
  /** The memory the reminder is about. */
  lead: MemoryAnniversary;
}

export interface MemoryReminderOptions {
  /** How far ahead to look. */
  horizonDays?: number;
  /** At least this many days between two reminders, so it never becomes noise. */
  minGapDays?: number;
  max?: number;
}

/** The days from `from` (included) on which a memory reminder should fire. */
export function memoryReminderDays(
  memories: readonly Memory[],
  from: Temporal.PlainDate,
  policy: LeapDayPolicy,
  options: MemoryReminderOptions = {},
): MemoryReminderDay[] {
  const { horizonDays = 90, minGapDays = 7, max = 3 } = options;
  const days: MemoryReminderDay[] = [];
  let next = from;
  for (let offset = 0; offset <= horizonDays && days.length < max; offset++) {
    const date = from.add({ days: offset });
    if (date.until(next, { largestUnit: 'days' }).days > 0) continue; // still within the gap
    const lead = memoriesOnThisDay(memories, date, policy)[0];
    if (!lead) continue;
    days.push({ date, lead });
    next = date.add({ days: minGapDays });
  }
  return days;
}
