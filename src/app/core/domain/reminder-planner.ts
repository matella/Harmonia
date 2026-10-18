import { resolveLocalDateTime, toPlainTime, type IsoDate } from './local-date';
import { upcomingOccurrences } from './milestone-occurrence';
import type { AppSettings, Milestone, ReminderRule } from './models';
import { Temporal } from './temporal';

/**
 * iOS keeps at most 64 pending local notifications per app; stay safely below it and
 * schedule only the soonest reminders. Later ones are planned on the next launch/resume.
 */
export const MAX_PENDING_NOTIFICATIONS = 60;

/** How many future occurrences of a yearly event are examined to find a future fire time. */
const OCCURRENCE_LOOKAHEAD = 3;

export interface PlannedNotification {
  notificationId: number;
  ruleId: string;
  milestoneId: string;
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
}

export interface ReminderPlanInput {
  milestones: readonly Milestone[];
  rules: readonly ReminderRule[];
  settings: Pick<AppSettings, 'remindersEnabled' | 'leapDayPolicy'>;
  now: Temporal.Instant;
  /** Reminders fire at local wall-clock time in the device's current zone. */
  deviceTimeZoneId: string;
  copy: ReminderCopy;
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

  planned.sort(
    (a, b) => Temporal.Instant.compare(a.fireAt, b.fireAt) || a.notificationId - b.notificationId,
  );
  return planned.slice(0, MAX_PENDING_NOTIFICATIONS);
}
