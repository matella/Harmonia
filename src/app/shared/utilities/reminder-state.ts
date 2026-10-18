import type { AppSettings, ReminderRule } from '../../core/domain/models';
import type { NotificationPermission } from '../../core/platform/notification-port';

/** Reminder status for a date row: none, on, or on-but-undeliverable. */
export function reminderStateFor(
  milestoneId: string,
  rulesByMilestone: ReadonlyMap<string, ReminderRule[]>,
  settings: Pick<AppSettings, 'remindersEnabled'>,
  permission: NotificationPermission,
): 'none' | 'on' | 'blocked' {
  const rules = rulesByMilestone.get(milestoneId) ?? [];
  if (!rules.some((r) => r.isEnabled)) return 'none';
  return settings.remindersEnabled && (permission === 'granted' || permission === 'prompt') ? 'on' : 'blocked';
}
