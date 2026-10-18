import { LocalNotifications, type PermissionStatus } from '@capacitor/local-notifications';

import type { PlannedNotification } from '../domain/reminder-planner';
import type { NotificationPermission, NotificationPort } from './notification-port';

export const REMINDER_CHANNEL_ID = 'reminders';

function mapPermission(status: PermissionStatus): NotificationPermission {
  switch (status.display) {
    case 'granted':
      return 'granted';
    case 'denied':
      return 'denied';
    default:
      return 'prompt';
  }
}

/**
 * Local notifications through @capacitor/local-notifications. Android uses inexact
 * alarms: the plugin's SCHEDULE_EXACT_ALARM permission is removed from the merged
 * manifest and every request sets isExactNotification:false, so delivery may shift by
 * a few minutes in Doze — acceptable for date reminders. The plugin restores scheduled
 * notifications after reboot; the app also reconciles on every launch/resume.
 */
export class CapacitorNotificationPort implements NotificationPort {
  private channelReady: Promise<void> | null = null;

  constructor(private readonly channelName: string, private readonly channelDescription: string) {}

  async checkPermission(): Promise<NotificationPermission> {
    return mapPermission(await LocalNotifications.checkPermissions());
  }

  async requestPermission(): Promise<NotificationPermission> {
    return mapPermission(await LocalNotifications.requestPermissions());
  }

  async pendingIds(): Promise<number[]> {
    const { notifications } = await LocalNotifications.getPending();
    return notifications.map((n) => n.id);
  }

  async schedule(notifications: readonly PlannedNotification[]): Promise<void> {
    await this.ensureChannel();
    await LocalNotifications.schedule({
      notifications: notifications.map((n) => ({
        id: n.notificationId,
        title: n.title,
        body: n.body,
        channelId: REMINDER_CHANNEL_ID,
        schedule: { at: new Date(n.fireAt.epochMilliseconds), allowWhileIdle: true },
        // Inexact on purpose: never send the user to the "Alarms & reminders" settings.
        isExactNotification: false,
        extra: { route: n.route },
        autoCancel: true,
      })),
    });
  }

  async cancel(ids: readonly number[]): Promise<void> {
    await LocalNotifications.cancel({ notifications: ids.map((id) => ({ id })) });
  }

  private ensureChannel(): Promise<void> {
    // Channels only exist on Android 8+; the call is a no-op elsewhere.
    this.channelReady ??= LocalNotifications.createChannel({
      id: REMINDER_CHANNEL_ID,
      name: this.channelName,
      description: this.channelDescription,
      importance: 3,
      visibility: 0, // private: content hidden on a secure lock screen
    }).catch(() => undefined);
    return this.channelReady;
  }
}

/** Web preview: browsers cannot schedule future local notifications reliably. */
export class UnavailableNotificationPort implements NotificationPort {
  async checkPermission(): Promise<NotificationPermission> {
    return 'unavailable';
  }
  async requestPermission(): Promise<NotificationPermission> {
    return 'unavailable';
  }
  async pendingIds(): Promise<number[]> {
    return [];
  }
  async schedule(): Promise<void> {
    // Nothing can be scheduled in a browser preview.
  }
  async cancel(): Promise<void> {
    // Nothing is ever pending.
  }
}
