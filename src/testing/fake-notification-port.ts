import type { PlannedNotification } from '../app/core/domain/reminder-planner';
import type { NotificationPermission, NotificationPort } from '../app/core/platform/notification-port';

/** In-memory OS notification centre: scheduling an existing ID replaces it. */
export class FakeNotificationPort implements NotificationPort {
  readonly pending = new Map<number, PlannedNotification>();
  permission: NotificationPermission = 'granted';
  requestResult: NotificationPermission = 'granted';
  requestCount = 0;

  async checkPermission(): Promise<NotificationPermission> {
    return this.permission;
  }

  async requestPermission(): Promise<NotificationPermission> {
    this.requestCount += 1;
    this.permission = this.requestResult;
    return this.permission;
  }

  async pendingIds(): Promise<number[]> {
    return [...this.pending.keys()];
  }

  async schedule(notifications: readonly PlannedNotification[]): Promise<void> {
    if (this.permission !== 'granted') throw new Error('permission not granted');
    for (const n of notifications) this.pending.set(n.notificationId, n);
  }

  async cancel(ids: readonly number[]): Promise<void> {
    for (const id of ids) this.pending.delete(id);
  }
}
