import type { CalendarDuration, PreciseDuration } from '../domain/relationship-duration';
import type { TogetherMark } from '../domain/together-milestones';
import type { EnCatalog } from './messages.en';
import type { Translator } from './translator';

export type AppTranslator = Translator<EnCatalog>;

export interface DurationPart {
  value: number;
  unit: string;
}

const listFormats = new Map<string, Intl.ListFormat>();

function joinUnits(locale: string, parts: string[]): string {
  let format = listFormats.get(locale);
  if (!format) {
    format = new Intl.ListFormat(locale, { style: 'long', type: 'unit' });
    listFormats.set(locale, format);
  }
  return format.format(parts);
}

/** Non-zero calendar parts with localized unit labels, for large-numeral layouts. */
export function calendarParts(t: AppTranslator, duration: CalendarDuration): DurationPart[] {
  const parts: DurationPart[] = [];
  if (duration.years > 0) parts.push({ value: duration.years, unit: t.plural('unit.year', duration.years) });
  if (duration.months > 0) parts.push({ value: duration.months, unit: t.plural('unit.month', duration.months) });
  if (duration.days > 0) parts.push({ value: duration.days, unit: t.plural('unit.day', duration.days) });
  return parts;
}

/** "2 years, 4 months, 3 days" — zero parts are omitted. Empty string for day 0. */
export function formatCalendarDuration(t: AppTranslator, duration: CalendarDuration): string {
  const phrases: string[] = [];
  if (duration.years > 0) phrases.push(t.plural('phrase.years', duration.years));
  if (duration.months > 0) phrases.push(t.plural('phrase.months', duration.months));
  if (duration.days > 0) phrases.push(t.plural('phrase.days', duration.days));
  return joinUnits(t.locale, phrases);
}

/** Short form for widgets/headlines: years and months only, falling back to days. */
export function formatShortCalendarDuration(t: AppTranslator, duration: CalendarDuration): string {
  const phrases: string[] = [];
  if (duration.years > 0) phrases.push(t.plural('phrase.years', duration.years));
  if (duration.months > 0) phrases.push(t.plural('phrase.months', duration.months));
  if (phrases.length === 0) phrases.push(t.plural('phrase.days', duration.days));
  return joinUnits(t.locale, phrases);
}

export function formatWeeksAndDays(t: AppTranslator, weeks: number, days: number): string {
  const phrases: string[] = [];
  if (weeks > 0) phrases.push(t.plural('phrase.weeks', weeks));
  if (days > 0 || weeks === 0) phrases.push(t.plural('phrase.days', days));
  return joinUnits(t.locale, phrases);
}

export function formatPreciseDuration(t: AppTranslator, precise: PreciseDuration, withSeconds: boolean): string {
  const phrases = [
    t.plural('phrase.days', precise.days),
    t.plural('phrase.hours', precise.hours),
    t.plural('phrase.minutes', precise.minutes),
  ];
  if (withSeconds) phrases.push(t.plural('phrase.seconds', precise.seconds));
  return joinUnits(t.locale, phrases);
}

/** "Today", "Tomorrow", "in 12 days", "Yesterday", "3 days ago". */
export function formatRelativeDays(t: AppTranslator, daysFromToday: number): string {
  if (daysFromToday === 0) return t.t('relative.today');
  if (daysFromToday === 1) return t.t('relative.tomorrow');
  if (daysFromToday === -1) return t.t('relative.yesterday');
  return daysFromToday > 0
    ? t.plural('relative.inDays', daysFromToday)
    : t.plural('relative.daysAgo', -daysFromToday);
}

/** "6 months", "1 year and 6 months", "1,000 days" — the length of a together milestone. */
export function formatTogetherDuration(t: AppTranslator, mark: TogetherMark): string {
  if (mark.kind === 'days') return t.plural('phrase.days', mark.count);
  return formatCalendarDuration(t, { years: Math.floor(mark.count / 12), months: mark.count % 12, days: 0 });
}

/** "6 months together". */
export function formatTogetherTitle(t: AppTranslator, mark: TogetherMark): string {
  return t.t('together.title', { duration: formatTogetherDuration(t, mark) });
}
