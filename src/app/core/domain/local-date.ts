import type { Clock } from './clock';
import { Temporal } from './temporal';

/** ISO local calendar date, `YYYY-MM-DD`. Never an instant; never shifted by time zones. */
export type IsoDate = string;
/** Local wall-clock time, `HH:mm` (24h). */
export type LocalTime = string;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Earliest/latest calendar years accepted from user input. */
export const MIN_YEAR = 1900;
export const MAX_YEAR = 2200;

export function isValidIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string') return false;
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  if (year < MIN_YEAR || year > MAX_YEAR) return false;
  try {
    Temporal.PlainDate.from(value, { overflow: 'reject' });
    return true;
  } catch {
    return false;
  }
}

export function isValidLocalTime(value: unknown): value is LocalTime {
  return typeof value === 'string' && LOCAL_TIME.test(value);
}

export function isValidTimeZoneId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(value);
    return true;
  } catch {
    return false;
  }
}

export function toPlainDate(value: IsoDate): Temporal.PlainDate {
  return Temporal.PlainDate.from(value, { overflow: 'reject' });
}

export function toPlainTime(value: LocalTime): Temporal.PlainTime {
  return Temporal.PlainTime.from(value, { overflow: 'reject' });
}

export function toIsoDate(date: Temporal.PlainDate): IsoDate {
  return date.toString();
}

/** The current calendar date in the given zone. */
export function todayIn(clock: Clock, timeZoneId: string): Temporal.PlainDate {
  return clock.now().toZonedDateTimeISO(timeZoneId).toPlainDate();
}

export function compareIsoDates(a: IsoDate, b: IsoDate): number {
  // ISO dates with 4-digit years sort lexicographically.
  return a < b ? -1 : a > b ? 1 : 0;
}

export function daysBetween(from: Temporal.PlainDate, to: Temporal.PlainDate): number {
  return from.until(to, { largestUnit: 'days' }).days;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Resolves a local wall-clock date-time in a zone to an instant using the documented
 * DST policy ("compatible"): a time inside a spring-forward gap moves forward by the
 * length of the gap (02:30 → 03:30); an ambiguous fall-back time resolves to the
 * earlier of the two instants. This matches java.time and Foundation behaviour.
 */
export function resolveLocalDateTime(
  date: Temporal.PlainDate,
  time: Temporal.PlainTime,
  timeZoneId: string,
): Temporal.ZonedDateTime {
  return date.toPlainDateTime(time).toZonedDateTime(timeZoneId, { disambiguation: 'compatible' });
}
