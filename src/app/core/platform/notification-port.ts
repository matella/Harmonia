import type { PlannedNotification } from '../domain/reminder-planner';

export type NotificationPermission = 'granted' | 'denied' | 'prompt' | 'unavailable';

/**
 * Platform boundary for local notifications. Implemented with
 * @capacitor/local-notifications on devices, an in-memory fake in tests, and a no-op on
 * the web preview.
 */
export interface NotificationPort {
  checkPermission(): Promise<NotificationPermission>;
  requestPermission(): Promise<NotificationPermission>;
  /** IDs of notifications currently pending with the OS. */
  pendingIds(): Promise<number[]>;
  /** Schedules (or replaces, by ID) the given notifications. */
  schedule(notifications: readonly PlannedNotification[]): Promise<void>;
  cancel(ids: readonly number[]): Promise<void>;
}
