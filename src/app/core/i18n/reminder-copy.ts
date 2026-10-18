import type { ReminderCopy } from '../domain/reminder-planner';
import { formatTogetherDuration, type AppTranslator } from './duration-format';

/** Notification wording. Discreet unless the user allowed the milestone title. */
export function createReminderCopy(t: AppTranslator): ReminderCopy {
  return {
    title: () => t.t('notification.title'),
    body: (offsetDays, milestoneTitle) => {
      if (milestoneTitle === null) {
        if (offsetDays === 0) return t.t('notification.discreet.today');
        if (offsetDays === 1) return t.t('notification.discreet.tomorrow');
        return t.plural('notification.discreet.inDays', offsetDays);
      }
      if (offsetDays === 0) return t.t('notification.named.today', { title: milestoneTitle });
      if (offsetDays === 1) return t.t('notification.named.tomorrow', { title: milestoneTitle });
      return t.plural('notification.named.inDays', offsetDays, { title: milestoneTitle });
    },
    togetherBody: (offsetDays, mark) => {
      if (mark === null) {
        if (offsetDays === 0) return t.t('notification.discreet.today');
        if (offsetDays === 1) return t.t('notification.discreet.tomorrow');
        return t.plural('notification.discreet.inDays', offsetDays);
      }
      const duration = formatTogetherDuration(t, mark);
      if (offsetDays === 0) return t.t('notification.together.today', { duration });
      if (offsetDays === 1) return t.t('notification.together.tomorrow', { duration });
      return t.plural('notification.together.inDays', offsetDays, { duration });
    },
  };
}
