import type { NotificationPort, NotificationPermission } from '../platform/notification-port';
import type { PlannedNotification } from './reminder-planner';

export interface ReconcileReport {
  permission: NotificationPermission;
  /** Number of notifications the plan expects to be pending. */
  planned: number;
  scheduled: number;
  cancelled: number;
  /** Pending IDs before reconciling that were not part of the plan (stale/duplicates). */
  stale: number;
  /** Planned IDs that were missing before reconciling. */
  missing: number;
}

/**
 * Makes the OS pending-notification set equal to the plan:
 *  - cancels every pending ID that is not planned (deleted milestones, disabled or
 *    edited rules, obsolete occurrences);
 *  - (re)schedules every planned notification — scheduling an existing ID replaces it,
 *    so time or wording changes never create duplicates.
 * When permission is not granted nothing can be shown, so pending requests are
 * cleared and the report says why.
 */
export async function reconcileReminders(
  port: NotificationPort,
  plan: readonly PlannedNotification[],
): Promise<ReconcileReport> {
  const permission = await port.checkPermission();
  const pending = await port.pendingIds();
  const plannedIds = new Set(plan.map((n) => n.notificationId));
  const pendingIds = new Set(pending);

  if (permission !== 'granted') {
    if (pending.length > 0) await port.cancel(pending);
    return {
      permission,
      planned: plan.length,
      scheduled: 0,
      cancelled: pending.length,
      stale: pending.length,
      missing: plan.length,
    };
  }

  const toCancel = pending.filter((id) => !plannedIds.has(id));
  if (toCancel.length > 0) await port.cancel(toCancel);
  if (plan.length > 0) await port.schedule(plan);

  return {
    permission,
    planned: plan.length,
    scheduled: plan.length,
    cancelled: toCancel.length,
    stale: toCancel.length,
    missing: plan.filter((n) => !pendingIds.has(n.notificationId)).length,
  };
}
