import { Temporal } from './temporal';

/** How long deleted dates and memories stay restorable in "Recently deleted". */
export const TRASH_RETENTION_DAYS = 30;

/** Whole days left before an item deleted at `deletedAt` is purged (0 on the last day). */
export function trashDaysLeft(deletedAt: string, now: Temporal.Instant): number {
  const expires = Temporal.Instant.from(deletedAt).add({ hours: 24 * TRASH_RETENTION_DAYS });
  const hours = now.until(expires, { largestUnit: 'hours' }).hours;
  return Math.max(0, Math.ceil(hours / 24));
}
