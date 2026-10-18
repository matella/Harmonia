import { resolveLocalDateTime, toPlainTime, type IsoDate, type LocalTime } from './local-date';
import { upcomingOccurrences } from './milestone-occurrence';
import type { AppSettings, Milestone, ReminderRule } from './models';
import { Temporal } from './temporal';
import {
  MAX_TOGETHER_DAYS,
  MAX_TOGETHER_MONTHS,
  upcomingTogetherMarks,
  type TogetherMark,
  type TogetherMarkKind,
  type TogetherOptions,
} from './together-milestones';

/**
 * iOS keeps at most 64 pending local notifications per app; stay safely below it and
 * schedule only the soonest reminders. Later ones are planned on the next launch/resume.
 */
export const MAX_PENDING_NOTIFICATIONS = 60;

/** How many future occurrences of a yearly event are examined to find a future fire time. */
const OCCURRENCE_LOOKAHEAD = 3;

/**
 * Together-milestone reminders have no stored rule, so their IDs are derived from
 * (kind, count, offset) inside a reserved range above every sequence-issued ID (the
 * repository refuses to issue IDs from this base on). Max: 2,058,560,365 < 2^31.
 */
export const TOGETHER_NOTIFICATION_ID_BASE = 2_000_000_000;

export function togetherNotificationId(kind: TogetherMarkKind, count: number, offsetDays: number): number {
  const limit = kind === 'months' ? MAX_TOGETHER_MONTHS : MAX_TOGETHER_DAYS;
  if (!Number.isInteger(count) || count < 1 || count > limit || offsetDays < 0 || offsetDays > 365) {
    throw new RangeError('together reminder out of range');
  }
  return TOGETHER_NOTIFICATION_ID_BASE + ((kind === 'months' ? 0 : 100_000) + count) * 366 + offsetDays;
}

export interface PlannedNotification {
  notificationId: number;
  /** Stored rule ID, or `together:<kind>:<count>:<offset>` for derived reminders. */
  ruleId: string;
  /** Null for together-milestone reminders. */
  milestoneId: string | null;
  fireAt: Temporal.Instant;
  occurrenceDate: IsoDate;
  offsetDays: number;
  title: string;
  body: string;
  /** In-app route opened when the notification is tapped. */
  route: string;
}

export interface ReminderCopy {
  title(): string;
  /** milestoneTitle is null when the notification must stay discreet. */
  body(offsetDays: number, milestoneTitle: string | null): string;
  /** mark is null when the notification must stay discreet. */
  togetherBody(offsetDays: number, mark: TogetherMark | null): string;
}

/** Reminders for derived together milestones (1, 3, 6 months…), off unless enabled. */
export interface TogetherReminderInput {
  startDate: IsoDate;
  options: TogetherOptions;
  offsets: readonly number[];
  localTime: LocalTime;
  revealTitle: boolean;
}

export interface ReminderPlanInput {
  milestones: readonly Milestone[];
  rules: readonly ReminderRule[];
  settings: Pick<AppSettings, 'remindersEnabled' | 'leapDayPolicy'>;
  now: Temporal.Instant;
  /** Reminders fire at local wall-clock time in the device's current zone. */
  deviceTimeZoneId: string;
  copy: ReminderCopy;
  /** Null when together reminders are off or there is no profile. */
  together?: TogetherReminderInput | null;
}

/**
 * Computes the exact set of notifications that should be pending right now. The plan is
 * a pure function of persisted data and the clock, so reconciling it against the OS is
 * idempotent: identical inputs always produce identical notification IDs and times.
 */
export function planReminders(input: ReminderPlanInput): PlannedNotification[] {
  if (!input.settings.remindersEnabled) return [];
  const byId = new Map(input.milestones.map((m) => [m.id, m]));
  const today = input.now.toZonedDateTimeISO(input.deviceTimeZoneId).toPlainDate();
  const planned: PlannedNotification[] = [];

  for (const rule of input.rules) {
    if (!rule.isEnabled) continue;
    const milestone = byId.get(rule.milestoneId);
    if (!milestone) continue;
    const time = toPlainTime(rule.localTime);
    // An occurrence before today can never have a future fire time, so the search can
    // start at the next occurrence; later ones cover offsets that already passed.
    const occurrences = upcomingOccurrences(milestone, today, input.settings.leapDayPolicy, OCCURRENCE_LOOKAHEAD);
    for (const occurrence of occurrences) {
      const fireDate = occurrence.date.subtract({ days: rule.offsetDays });
      const fireAt = resolveLocalDateTime(fireDate, time, input.deviceTimeZoneId).toInstant();
      if (Temporal.Instant.compare(fireAt, input.now) <= 0) continue;
      planned.push({
        notificationId: rule.notificationId,
        ruleId: rule.id,
        milestoneId: milestone.id,
        fireAt,
        occurrenceDate: occurrence.date.toString(),
        offsetDays: rule.offsetDays,
        title: input.copy.title(),
        body: input.copy.body(rule.offsetDays, rule.includeEventTitle ? milestone.title : null),
        route: `/milestone/${milestone.id}`,
      });
      break;
    }
  }

  if (input.together) planned.push(...planTogether(input.together, input, today));

  planned.sort(
    (a, b) => Temporal.Instant.compare(a.fireAt, b.fireAt) || a.notificationId - b.notificationId,
  );
  return planned.slice(0, MAX_PENDING_NOTIFICATIONS);
}

function planTogether(
  together: TogetherReminderInput,
  input: ReminderPlanInput,
  today: Temporal.PlainDate,
): PlannedNotification[] {
  const time = toPlainTime(together.localTime);
  const marks = upcomingTogetherMarks(together.startDate, today, together.options, 8);
  const planned: PlannedNotification[] = [];
  for (const kind of ['months', 'days'] as const) {
    const ofKind = marks.filter((m) => m.kind === kind);
    for (const offsetDays of new Set(together.offsets)) {
      // Only the next mark per kind and offset; later ones are planned on later launches.
      for (const mark of ofKind) {
        const fireAt = resolveLocalDateTime(mark.date.subtract({ days: offsetDays }), time, input.deviceTimeZoneId).toInstant();
        if (Temporal.Instant.compare(fireAt, input.now) <= 0) continue;
        planned.push({
          notificationId: togetherNotificationId(kind, mark.count, offsetDays),
          ruleId: `together:${kind}:${mark.count}:${offsetDays}`,
          milestoneId: null,
          fireAt,
          occurrenceDate: mark.date.toString(),
          offsetDays,
          title: input.copy.title(),
          body: input.copy.togetherBody(offsetDays, together.revealTitle ? mark : null),
          route: '/counter',
        });
        break;
      }
    }
  }
  return planned;
}
