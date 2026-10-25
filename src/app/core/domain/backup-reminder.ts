import type { IsoInstant, Memory, Milestone } from './models';

/**
 * When Home offers to export a copy. Everything lives only on the phone (no account), so
 * a lost phone would lose it all; the offer is calm and rare:
 *  - never before something is saved, and not for 30 days after "Not now";
 *  - never exported: once the first memory or date is 14 days old;
 *  - exported before: when something changed since and the export is 90 days old, or
 *    when 10 or more memories were added since and it is 14 days old.
 * Pure: a function of the saved items, the clock and two timestamps.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const BACKUP_FIRST_AFTER_DAYS = 14;
export const BACKUP_REPEAT_AFTER_DAYS = 90;
export const BACKUP_MANY_MEMORIES = 10;
export const BACKUP_MANY_AFTER_DAYS = 14;
export const BACKUP_SNOOZE_DAYS = 30;

export interface BackupReminderInput {
  nowMs: number;
  lastBackupAt: IsoInstant | null;
  /** When the user last chose "Not now". */
  dismissedAt: IsoInstant | null;
  milestones: readonly Pick<Milestone, 'createdAt' | 'updatedAt'>[];
  memories: readonly Pick<Memory, 'createdAt' | 'updatedAt'>[];
}

const ms = (instant: IsoInstant): number => Date.parse(instant);

export function backupDue(input: BackupReminderInput): boolean {
  const items = [...input.milestones, ...input.memories];
  if (items.length === 0) return false;
  if (input.dismissedAt && input.nowMs - ms(input.dismissedAt) < BACKUP_SNOOZE_DAYS * DAY_MS) return false;

  if (input.lastBackupAt === null) {
    const first = Math.min(...items.map((i) => ms(i.createdAt)));
    return input.nowMs - first >= BACKUP_FIRST_AFTER_DAYS * DAY_MS;
  }
  const last = ms(input.lastBackupAt);
  const age = input.nowMs - last;
  const changed = items.some((i) => ms(i.updatedAt) > last || ms(i.createdAt) > last);
  if (changed && age >= BACKUP_REPEAT_AFTER_DAYS * DAY_MS) return true;
  const added = input.memories.filter((m) => ms(m.createdAt) > last).length;
  return added >= BACKUP_MANY_MEMORIES && age >= BACKUP_MANY_AFTER_DAYS * DAY_MS;
}
